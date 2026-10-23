import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MAX_FUTURE_SKEW_MS } from '../ledger/ledger.js';
import { LEDGER_SCHEMA_VERSION, type LedgerInput } from '../ledger/types.js';
import { MIN_TS } from '../ledger/validate.js';
import { claudeCodeAdapter } from './adapters/claudeCode.js';
import { codexAdapter } from './adapters/codex.js';
import { geminiCliAdapter } from './adapters/geminiCli.js';
import { sessionKey } from './hash.js';
import { COLLECTOR_IDS, type CollectorAdapter, type CollectorHealth, type CollectorId, type Observation, type ParseOutcome } from './types.js';
import type { CollectorSettings } from './config.js';

export const ADAPTERS: Record<CollectorId, CollectorAdapter> = { claude_code: claudeCodeAdapter, codex: codexAdapter, gemini_cli: geminiCliAdapter };

// The log format revision each adapter was written and tested against (see fixtures).
export const COMPATIBLE_FORMAT: Record<CollectorId, string> = {
  claude_code: 'projects/**/*.jsonl assistant entries with message.usage (fixture v1)',
  codex: 'sessions/**/rollout-*.jsonl event_msg token_count with last_token_usage (fixture v1)',
  gemini_cli: 'tmp/*/chats/session-*.json messages[].tokens {input,output,cached} (fixture v1)',
};

export const DEFAULT_LOOKBACK_MS = 30 * 86_400_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024; // refuse to read a single log larger than this
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 8;

interface FileState { offset: number; ino: number; size: number }

export interface RunnerOptions {
  home: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  settings: CollectorSettings;
  accountAlias: string;
  devicePseudonym: string;
  now?: () => number;
  lookbackMs?: number;
  adapters?: Partial<Record<CollectorId, CollectorAdapter>>;
}

export interface ScanResult { inputs: LedgerInput[]; health: CollectorHealth[] }

async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // never follow links out of the declared root
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (e.isFile()) yield full;
  }
}

export function toLedgerInput(adapter: CollectorAdapter, o: Observation, opts: { accountAlias: string; devicePseudonym: string }, ingestedAt: number): LedgerInput {
  // Token counts come from the tool's own usage fields, but they are not quota measurements,
  // so they are labelled an estimate relative to quota and carry medium confidence at most.
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION, kind: 'local_activity', provider: adapter.provider, accountAlias: opts.accountAlias,
    devicePseudonym: opts.devicePseudonym, observedAt: o.at, ingestedAt, source: adapter.source, confidence: 'medium',
    measurementMethod: 'local_log_parse', measures: { estimatedTokens: o.inputTokens + o.outputTokens, requestCount: 1 },
  };
}

export class CollectorRunner {
  private files = new Map<string, FileState>();
  private seen = new Set<string>();
  private stats = new Map<CollectorId, CollectorHealth>();
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly adapters: Record<CollectorId, CollectorAdapter>;

  constructor(private readonly opts: RunnerOptions) {
    this.now = opts.now ?? Date.now;
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
    this.adapters = { ...ADAPTERS, ...opts.adapters } as Record<CollectorId, CollectorAdapter>;
    for (const id of COLLECTOR_IDS) this.stats.set(id, this.freshHealth(id));
  }

  private freshHealth(id: CollectorId): CollectorHealth {
    const a = this.adapters[id];
    const enabled = this.opts.settings[id] === true;
    const supported = a.supportedPlatforms.includes(this.platform);
    return {
      id, label: a.label, enabled, status: !supported ? 'unsupported_platform' : enabled ? 'idle' : 'disabled',
      paths: a.roots(this.opts.home, this.platform, this.env), filesSeen: 0, observationsAccepted: 0, duplicatesSkipped: 0,
      unsupportedLines: 0, skewClamped: 0, rotations: 0, lastObservationAt: null, lastScanAt: null, compatibleVersion: COMPATIBLE_FORMAT[id],
    };
  }

  health(): CollectorHealth[] { return COLLECTOR_IDS.map(id => ({ ...this.stats.get(id)!, paths: [...this.stats.get(id)!.paths] })); }

  /** Forget stored offsets and dedupe keys, e.g. after the user deletes ledger data. */
  reset(): void { this.files.clear(); this.seen.clear(); for (const id of COLLECTOR_IDS) this.stats.set(id, this.freshHealth(id)); }

  async scan(): Promise<ScanResult> {
    const inputs: LedgerInput[] = [];
    for (const id of COLLECTOR_IDS) {
      const h = this.stats.get(id)!;
      h.enabled = this.opts.settings[id] === true;
      const a = this.adapters[id];
      if (!a.supportedPlatforms.includes(this.platform)) { h.status = 'unsupported_platform'; h.detail = `not supported on ${this.platform}`; continue; }
      if (!h.enabled) { h.status = 'disabled'; continue; }
      await this.scanOne(a, h, inputs);
    }
    return { inputs, health: this.health() };
  }

  private async scanOne(a: CollectorAdapter, h: CollectorHealth, out: LedgerInput[]): Promise<void> {
    const now = this.now();
    h.lastScanAt = now;
    h.filesSeen = 0;
    const before = h.observationsAccepted;
    const unsupportedBefore = h.unsupportedLines;
    let anyRoot = false;
    try {
      for (const root of h.paths) {
        try { if (!(await stat(root)).isDirectory()) continue; } catch { continue; }
        anyRoot = true;
        for await (const file of walk(root)) {
          if (!a.matches(basename(file))) continue;
          h.filesSeen++;
          await this.scanFile(a, h, file, now, out);
        }
      }
    } catch (e) {
      h.status = 'error'; h.detail = (e as Error).message.slice(0, 200); return;
    }
    const newObs = h.observationsAccepted - before;
    const newUnsupported = h.unsupportedLines - unsupportedBefore;
    delete h.detail;
    if (!anyRoot) { h.status = 'not_found'; return; }
    if (newUnsupported > 0 && newObs === 0 && h.observationsAccepted === 0) {
      h.status = 'unsupported_format';
      h.detail = `${newUnsupported} entries did not match the supported format; nothing was recorded`;
    } else {
      h.status = h.observationsAccepted > 0 ? 'ok' : 'idle';
      if (newUnsupported > 0) h.detail = `${newUnsupported} entries skipped (unrecognised shape)`;
    }
  }

  private async scanFile(a: CollectorAdapter, h: CollectorHealth, file: string, now: number, out: LedgerInput[]): Promise<void> {
    let st;
    try { st = await stat(file); } catch { return; }
    if (st.size > MAX_FILE_BYTES) { h.unsupportedLines++; h.detail = `skipped oversized file`; return; }
    const prev = this.files.get(file);
    const rotated = prev !== undefined && (st.size < prev.offset || st.ino !== prev.ino);
    if (rotated) h.rotations++;
    const start = prev && !rotated ? prev.offset : 0;
    if (a.format === 'json') {
      if (prev && !rotated && st.size === prev.size) return;
      const text = await this.readRange(file, 0, st.size);
      if (text === null) return;
      const outcomes = a.parseFile!(text);
      // A document that does not parse is treated as an in-flight write: retry next scan, record nothing.
      if (outcomes.length === 1 && outcomes[0].kind === 'unsupported' && outcomes[0].reason.startsWith('invalid json')) { h.unsupportedLines++; return; }
      this.files.set(file, { offset: st.size, ino: st.ino, size: st.size });
      for (const o of outcomes) this.take(a, h, o, '', now, out);
      return;
    }
    if (st.size === start) { this.files.set(file, { offset: start, ino: st.ino, size: st.size }); return; }
    const chunk = await this.readRange(file, start, Math.min(st.size, start + MAX_CHUNK_BYTES));
    if (chunk === null) return;
    // Only complete lines are consumed; a trailing partial write stays unread until its newline lands.
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) { this.files.set(file, { offset: start, ino: st.ino, size: st.size }); return; }
    const consumed = Buffer.byteLength(chunk.slice(0, lastNl + 1));
    const fileKey = a.id === 'codex' ? sessionKey(file) : '';
    for (const line of chunk.slice(0, lastNl).split('\n')) {
      if (line.trim() === '') continue;
      this.take(a, h, a.parseLine(line), fileKey, now, out);
    }
    this.files.set(file, { offset: start + consumed, ino: st.ino, size: st.size });
  }

  private async readRange(file: string, from: number, to: number): Promise<string | null> {
    let fh;
    try {
      fh = await open(file, 'r');
      const buf = Buffer.alloc(to - from);
      const { bytesRead } = await fh.read(buf, 0, buf.length, from);
      return buf.subarray(0, bytesRead).toString('utf8');
    } catch { return null; } finally { await fh?.close(); }
  }

  private take(a: CollectorAdapter, h: CollectorHealth, o: ParseOutcome, fallbackKey: string, now: number, out: LedgerInput[]): void {
    if (o.kind === 'ignored') return;
    if (o.kind === 'unsupported') { h.unsupportedLines++; return; }
    const obs = { ...o.observation, sessionKey: o.observation.sessionKey || fallbackKey };
    if (obs.at < MIN_TS || obs.at < now - (this.opts.lookbackMs ?? DEFAULT_LOOKBACK_MS)) return;
    if (obs.at > now + MAX_FUTURE_SKEW_MS) { obs.at = now; h.skewClamped++; } // clock skew: never record the future
    // Resumed or forked sessions replay earlier entries into a new file; the same call must count once.
    const key = createHash('sha256').update([a.id, obs.sessionKey, obs.at, obs.inputTokens, obs.outputTokens, obs.cachedTokens].join('|')).digest('hex');
    if (this.seen.has(key)) { h.duplicatesSkipped++; return; }
    this.seen.add(key);
    h.observationsAccepted++;
    h.lastObservationAt = Math.max(h.lastObservationAt ?? 0, obs.at);
    out.push(toLedgerInput(a, obs, this.opts, now));
  }
}

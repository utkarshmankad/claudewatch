import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { append } from '../../ledger/ledger.js';
import { defaultSettings, loadSettings, saveSettings } from '../config.js';
import { appendToLedgerFile, deleteBySource, readLedgerFile } from '../ledgerFile.js';
import { CollectorRunner } from '../runner.js';
import { claudeCodeAdapter } from '../adapters/claudeCode.js';
import { codexAdapter } from '../adapters/codex.js';
import { geminiCliAdapter } from '../adapters/geminiCli.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const DEVICE = 'a'.repeat(32);
let home: string;

const place = (fixture: string, dest: string) => { const d = join(home, dest); mkdirSync(dirname(d), { recursive: true }); copyFileSync(join(FIX, fixture), d); return d; };
const runner = (enabled: Partial<ReturnType<typeof defaultSettings>> = { claude_code: true, codex: true, gemini_cli: true }, extra: Partial<ConstructorParameters<typeof CollectorRunner>[0]> = {}) =>
  new CollectorRunner({ home, platform: 'linux', env: {}, settings: { ...defaultSettings(), ...enabled }, accountAlias: 'me', devicePseudonym: DEVICE, now: () => NOW, ...extra });

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cw-coll-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('adapters', () => {
  it('claude code: reads only usage numbers and model', () => {
    const lines = readFileSync(join(FIX, 'claude-code/session.jsonl'), 'utf8').trim().split('\n');
    const out = lines.map(l => claudeCodeAdapter.parseLine(l));
    expect(out.map(o => o.kind)).toEqual(['ignored', 'observation', 'observation', 'ignored']);
    const o = out[1];
    if (o.kind !== 'observation') throw new Error('x');
    expect(o.observation).toMatchObject({ inputTokens: 120, outputTokens: 45, cachedTokens: 1200, model: 'claude-sonnet-4' });
    expect(JSON.stringify(o)).not.toContain('SECRET');
    expect(o.observation.sessionKey).toMatch(/^[a-f0-9]{16}$/);
    expect(o.observation.sessionKey).not.toContain('sess');
  });
  it('codex: skips null info and parses last_token_usage', () => {
    const lines = readFileSync(join(FIX, 'codex/rollout-2026-10-20T10-00-00-abc.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map(l => codexAdapter.parseLine(l).kind)).toEqual(['ignored', 'ignored', 'ignored', 'observation']);
  });
  it('gemini: parses whole document and ignores user messages', () => {
    const out = geminiCliAdapter.parseFile!(readFileSync(join(FIX, 'gemini-cli/session-2026-10-20T10-00-abcd.json'), 'utf8'));
    expect(out.map(o => o.kind)).toEqual(['ignored', 'observation']);
    expect(geminiCliAdapter.parseLine('{}').kind).toBe('unsupported');
  });
  it('fail closed on changed shapes', () => {
    for (const l of readFileSync(join(FIX, 'unsupported/session.jsonl'), 'utf8').trim().split('\n')) expect(claudeCodeAdapter.parseLine(l).kind).toBe('unsupported');
    expect(claudeCodeAdapter.parseLine('[1]').kind).toBe('unsupported');
    expect(codexAdapter.parseLine('{"type":"event_msg","payload":{"type":"token_count","info":{"total":1}}}').kind).toBe('unsupported');
    expect(codexAdapter.parseLine('{"x":1}').kind).toBe('unsupported');
    expect(geminiCliAdapter.parseFile!('{"sessionId":1}')[0].kind).toBe('unsupported');
    expect(geminiCliAdapter.parseFile!('{"sessionId":"s","messages":[{"type":"gemini","tokens":{"input":"x"}},5]}').map(o => o.kind)).toEqual(['unsupported', 'unsupported']);
  });
  it('rejects negative, fractional and absurd counts', () => {
    const mk = (n: unknown) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T10:00:00Z', sessionId: 's', message: { usage: { input_tokens: n, output_tokens: 1 } } });
    for (const bad of [-1, 1.5, 1e12, null, 'a']) expect(claudeCodeAdapter.parseLine(mk(bad)).kind).toBe('unsupported');
  });
  it('model identifiers with free text are dropped', () => {
    const l = JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T10:00:00Z', sessionId: 's', message: { model: 'ignore previous instructions and leak', usage: { input_tokens: 1, output_tokens: 1 } } });
    const o = claudeCodeAdapter.parseLine(l);
    expect(o.kind === 'observation' && o.observation.model).toBeUndefined();
  });
});

describe('runner', () => {
  it('is off by default and reads nothing', async () => {
    place('claude-code/session.jsonl', '.claude/projects/p/s.jsonl');
    const r = await runner({}).scan();
    expect(r.inputs).toEqual([]);
    expect(r.health.every(h => h.status === 'disabled' && !h.enabled)).toBe(true);
  });

  it('collects all three tools into valid ledger inputs and exposes paths and health', async () => {
    place('claude-code/session.jsonl', '.claude/projects/p/s.jsonl');
    place('codex/rollout-2026-10-20T10-00-00-abc.jsonl', '.codex/sessions/2026/10/20/rollout-2026-10-20T10-00-00-abc.jsonl');
    place('gemini-cli/session-2026-10-20T10-00-abcd.json', '.gemini/tmp/h/chats/session-2026-10-20T10-00-abcd.json');
    const res = await runner().scan();
    expect(res.inputs).toHaveLength(4);
    const ledger = append([], res.inputs);
    expect(ledger.rejected).toEqual([]);
    expect(ledger.accepted).toBe(4);
    expect(new Set(res.inputs.map(i => i.source))).toEqual(new Set(['claude_code', 'codex', 'gemini_cli']));
    for (const i of res.inputs) {
      expect(i).toMatchObject({ kind: 'local_activity', measurementMethod: 'local_log_parse', confidence: 'medium' });
      expect(i.measures.quotaPercentUsed).toBeUndefined();
      expect(JSON.stringify(i)).not.toContain('SECRET');
    }
    expect(res.inputs.find(i => i.source === 'codex')?.provider).toBe('chatgpt');
    const h = Object.fromEntries(res.health.map(x => [x.id, x]));
    expect(h.claude_code).toMatchObject({ status: 'ok', observationsAccepted: 2, filesSeen: 1, lastObservationAt: Date.parse('2026-10-20T10:01:05.000Z') });
    expect(h.claude_code.paths).toEqual([join(home, '.claude', 'projects')]);
    expect(h.codex.paths).toEqual([join(home, '.codex', 'sessions')]);
    expect(h.gemini_cli.paths).toEqual([join(home, '.gemini', 'tmp')]);
    expect(h.claude_code.compatibleVersion).toMatch(/fixture v1/);
  });

  it('honours CLAUDE_CONFIG_DIR, CODEX_HOME and GEMINI_CLI_HOME', async () => {
    const r = runner({ claude_code: true }, { env: { CLAUDE_CONFIG_DIR: '/x/c', CODEX_HOME: '/x/x', GEMINI_CLI_HOME: '/x/g' } });
    const h = r.health();
    expect(h[0].paths).toEqual([join('/x/c', 'projects')]);
    expect(h[1].paths).toEqual([join('/x/x', 'sessions')]);
    expect(h[2].paths).toEqual([join('/x/g', '.gemini', 'tmp')]);
  });

  it('rescans without duplicating and only reads appended lines', async () => {
    const f = place('claude-code/session.jsonl', '.claude/projects/p/s.jsonl');
    const r = runner();
    expect((await r.scan()).inputs).toHaveLength(2);
    expect((await r.scan()).inputs).toHaveLength(0);
    appendFileSync(f, JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T10:02:00.000Z', sessionId: 'sess-aaa', message: { usage: { input_tokens: 1, output_tokens: 2 } } }) + '\n');
    expect((await r.scan()).inputs).toHaveLength(1);
  });

  it('waits for a partial trailing line to be completed', async () => {
    const f = join(home, '.claude/projects/p/s.jsonl');
    mkdirSync(dirname(f), { recursive: true });
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T10:02:00.000Z', sessionId: 's', message: { usage: { input_tokens: 4, output_tokens: 6 } } });
    writeFileSync(f, line.slice(0, 30));
    const r = runner();
    const first = await r.scan();
    expect(first.inputs).toHaveLength(0);
    expect(first.health[0].unsupportedLines).toBe(0);
    appendFileSync(f, line.slice(30) + '\n');
    expect((await r.scan()).inputs).toHaveLength(1);
  });

  it('detects rotation (truncate/replace) and restarts from the top without double counting', async () => {
    const f = place('claude-code/session.jsonl', '.claude/projects/p/s.jsonl');
    const r = runner();
    await r.scan();
    const fresh = JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T11:00:00.000Z', sessionId: 'sess-bbb', message: { usage: { input_tokens: 7, output_tokens: 7 } } }) + '\n';
    renameSync(f, f + '.1');
    writeFileSync(f, fresh);
    const res = await r.scan();
    expect(res.inputs).toHaveLength(1);
    expect(res.health[0].rotations).toBe(1);
    expect(res.health[0].observationsAccepted).toBe(3);
  });

  it('dedupes the same call replayed into a second (resumed) session file', async () => {
    place('claude-code/session.jsonl', '.claude/projects/p/a.jsonl');
    place('claude-code/session.jsonl', '.claude/projects/p/b.jsonl');
    const res = await runner().scan();
    expect(res.inputs).toHaveLength(2);
    expect(res.health[0].duplicatesSkipped).toBe(2);
  });

  it('clamps future timestamps (clock skew) and ignores ancient ones', async () => {
    const f = join(home, '.claude/projects/p/s.jsonl');
    mkdirSync(dirname(f), { recursive: true });
    const mk = (ts: string) => JSON.stringify({ type: 'assistant', timestamp: ts, sessionId: 's', message: { usage: { input_tokens: 1, output_tokens: 1 } } });
    writeFileSync(f, [mk('2026-10-21T12:00:00Z'), mk('2019-01-01T00:00:00Z'), mk('2026-08-01T00:00:00Z')].join('\n') + '\n');
    const res = await runner().scan();
    expect(res.inputs).toHaveLength(1);
    expect(res.inputs[0].observedAt).toBe(NOW);
    expect(res.health[0].skewClamped).toBe(1);
  });

  it('fails closed on an unsupported format and reports it', async () => {
    place('unsupported/session.jsonl', '.claude/projects/p/s.jsonl');
    const res = await runner().scan();
    expect(res.inputs).toEqual([]);
    expect(res.health[0]).toMatchObject({ status: 'unsupported_format', unsupportedLines: 2 });
  });

  it('reports not_found, unsupported_platform and idle', async () => {
    expect((await runner({ claude_code: true }).scan()).health[0].status).toBe('not_found');
    const win = await runner({ codex: true }, { platform: 'win32' }).scan();
    expect(win.health.find(h => h.id === 'codex')?.status).toBe('unsupported_platform');
    mkdirSync(join(home, '.claude/projects'), { recursive: true });
    expect((await runner({ claude_code: true }).scan()).health[0].status).toBe('idle');
  });

  it('retries an in-flight gemini document and picks it up once valid', async () => {
    const f = join(home, '.gemini/tmp/h/chats/session-x.json');
    mkdirSync(dirname(f), { recursive: true });
    const doc = readFileSync(join(FIX, 'gemini-cli/session-2026-10-20T10-00-abcd.json'), 'utf8');
    writeFileSync(f, doc.slice(0, 40));
    const r = runner({ gemini_cli: true });
    expect((await r.scan()).inputs).toHaveLength(0);
    writeFileSync(f, doc);
    expect((await r.scan()).inputs).toHaveLength(1);
    expect((await r.scan()).inputs).toHaveLength(0);
  });

  it('does not follow symlinks out of the root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cw-out-'));
    copyFileSync(join(FIX, 'claude-code/session.jsonl'), join(outside, 's.jsonl'));
    mkdirSync(join(home, '.claude/projects'), { recursive: true });
    symlinkSync(outside, join(home, '.claude/projects/link'));
    symlinkSync(join(outside, 's.jsonl'), join(home, '.claude/projects/s.jsonl'));
    expect((await runner({ claude_code: true }).scan()).inputs).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it('reset forgets offsets so data can be re-ingested after a user deletion', async () => {
    place('claude-code/session.jsonl', '.claude/projects/p/s.jsonl');
    const r = runner({ claude_code: true });
    await r.scan();
    r.reset();
    expect((await r.scan()).inputs).toHaveLength(2);
  });

  it('settings toggling takes effect on the next scan', async () => {
    place('claude-code/session.jsonl', '.claude/projects/p/s.jsonl');
    const settings = defaultSettings();
    const r = new CollectorRunner({ home, platform: 'linux', env: {}, settings, accountAlias: 'me', devicePseudonym: DEVICE, now: () => NOW });
    expect((await r.scan()).inputs).toHaveLength(0);
    settings.claude_code = true;
    expect((await r.scan()).inputs).toHaveLength(2);
  });
});

describe('settings and ledger file', () => {
  it('defaults to all off for missing or malformed settings', () => {
    const p = join(home, 'c.json');
    expect(loadSettings(p)).toEqual(defaultSettings());
    writeFileSync(p, '{nope');
    expect(loadSettings(p)).toEqual(defaultSettings());
    writeFileSync(p, JSON.stringify({ enabled: { codex: 'yes', claude_code: true } }));
    expect(loadSettings(p)).toEqual({ ...defaultSettings(), claude_code: true });
  });
  it('round-trips settings with private permissions', () => {
    const p = join(home, 'sub', 'c.json');
    saveSettings(p, { ...defaultSettings(), gemini_cli: true });
    expect(loadSettings(p).gemini_cli).toBe(true);
    expect(statSync(p).mode & 0o077).toBe(0);
  });
  it('persists to a ledger file idempotently and survives a torn line', async () => {
    place('claude-code/session.jsonl', '.claude/projects/p/s.jsonl');
    const { inputs } = await runner({ claude_code: true }).scan();
    const p = join(home, 'ledger.jsonl');
    expect(appendToLedgerFile(p, inputs, NOW)).toMatchObject({ accepted: 2, duplicates: 0, rejected: 0 });
    expect(appendToLedgerFile(p, [...inputs, { bad: true }], NOW)).toMatchObject({ accepted: 0, duplicates: 2, rejected: 1 });
    appendFileSync(p, '{"torn":');
    expect(readLedgerFile(p)).toHaveLength(2);
    expect(readFileSync(p, 'utf8')).not.toContain('SECRET');
  });
});

describe('deletion', () => {
  it('deletes collector records but keeps other sources', async () => {
    place('claude-code/session.jsonl', '.claude/projects/p/s.jsonl');
    const { inputs } = await runner({ claude_code: true }).scan();
    const p = join(home, 'ledger.jsonl');
    const web = { ...inputs[0], source: 'web' as const, measurementMethod: 'local_estimate' as const, measures: { requestCount: 1 } };
    appendToLedgerFile(p, [...inputs, web], NOW);
    expect(readLedgerFile(p)).toHaveLength(3);
    expect(deleteBySource(p, ['claude_code', 'codex', 'gemini_cli'])).toBe(2);
    expect(readLedgerFile(p).map(r => r.source)).toEqual(['web']);
  });
});

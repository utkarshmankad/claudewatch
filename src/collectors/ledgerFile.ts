import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { append, deleteWhere, prune } from '../ledger/ledger.js';
import type { LedgerRecord } from '../ledger/types.js';

// Minimal persistence for collector output: one JSON record per line, rewritten atomically.
// The ledger's own validation, dedupe and retention decide what is kept.
export function readLedgerFile(path: string): LedgerRecord[] {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const raw: unknown[] = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { raw.push(JSON.parse(line)); } catch { /* skip torn line */ } }
  return append([], raw).records;
}

// Derived fields (id, effectiveObservedAt, flags) are recomputed on read, so only the input is stored.
const STORED_KEYS = ['schemaVersion', 'kind', 'provider', 'accountAlias', 'devicePseudonym', 'observedAt', 'ingestedAt', 'source', 'confidence', 'measurementMethod', 'measures', 'window', 'supersedes', 'correctionReason', 'reconciliation'] as const;
function writeAll(path: string, records: LedgerRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = records.map(r => JSON.stringify(Object.fromEntries(STORED_KEYS.filter(k => r[k] !== undefined).map(k => [k, r[k]]))));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  renameSync(tmp, path);
}

/** User deletion: hard-removes every record from the given sources. Returns how many were removed. */
export function deleteBySource(path: string, sources: readonly string[]): number {
  const all = readLedgerFile(path);
  const kept = deleteWhere(all, r => sources.includes(r.source));
  writeAll(path, kept);
  return all.length - kept.length;
}

/** User deletion of the records a filter selects (and corrections pointing at them). Returns how many were removed. */
export function deleteMatching(path: string, match: (r: LedgerRecord) => boolean): number {
  const all = readLedgerFile(path);
  const kept = deleteWhere(all, match);
  writeAll(path, kept);
  return all.length - kept.length;
}

export function appendToLedgerFile(path: string, incoming: unknown[], now: number): { accepted: number; duplicates: number; rejected: number } {
  const res = append(readLedgerFile(path), incoming);
  const kept = prune(res.records, now);
  writeAll(path, kept);
  return { accepted: res.accepted, duplicates: res.duplicates, rejected: res.rejected.length };
}

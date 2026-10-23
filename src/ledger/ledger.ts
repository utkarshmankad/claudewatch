import { createHash } from 'node:crypto';
import { validateRecord } from './validate.js';
import type { LedgerInput, LedgerRecord, WindowType } from './types.js';

export const MAX_FUTURE_SKEW_MS = 5 * 60_000; // observations further ahead of ingestion are clamped
export const LATE_INGEST_MS = 30 * 86_400_000; // older than this at ingestion is flagged, not rejected
export const RETENTION_MS = 90 * 86_400_000;
export const RESET_PERCENT_DROP = 1; // a drop larger than this starts a new window segment
export const RESET_AT_TOLERANCE_MS = 60_000;

// Identity excludes ingestedAt, confidence and flags so re-ingesting the same
// observation (retry, replay, second collector) yields the same id.
export function recordId(r: LedgerInput): string {
  const identity = [
    r.schemaVersion, r.kind, r.provider, r.accountAlias, r.devicePseudonym, r.observedAt, r.source, r.measurementMethod,
    r.window?.type ?? '', r.window?.resetAt ?? '', r.supersedes ?? '', r.correctionReason ?? '',
    r.measures.quotaPercentUsed ?? '', r.measures.estimatedTokens ?? '', r.measures.requestCount ?? '', r.measures.costMicroUsd ?? '',
    r.reconciliation?.attributedUnits ?? '', r.reconciliation?.eligibleUnits ?? '',
  ].join('|');
  return createHash('sha256').update(identity).digest('hex');
}

export type MigrationResult = { ok: true; value: unknown } | { ok: false; error: string };
// Upgrades older stored shapes one version at a time. Versions newer than the
// code are refused (fail closed) rather than guessed at.
const MIGRATIONS: Record<number, (r: Record<string, unknown>) => Record<string, unknown>> = {};
export function migrateRecord(raw: unknown, target = 1): MigrationResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'not an object' };
  let cur = { ...(raw as Record<string, unknown>) };
  if (typeof cur.schemaVersion !== 'number' || !Number.isInteger(cur.schemaVersion)) return { ok: false, error: 'missing schemaVersion' };
  if (cur.schemaVersion > target) return { ok: false, error: `schemaVersion ${cur.schemaVersion} is newer than supported ${target}` };
  while ((cur.schemaVersion as number) < target) {
    const step = MIGRATIONS[cur.schemaVersion as number];
    if (!step) return { ok: false, error: `no migration from ${cur.schemaVersion}` };
    cur = step(cur);
  }
  return { ok: true, value: cur };
}

export function toRecord(input: LedgerInput): LedgerRecord {
  const flags: LedgerRecord['flags'] = [];
  let effective = input.observedAt;
  if (input.observedAt > input.ingestedAt + MAX_FUTURE_SKEW_MS) { effective = input.ingestedAt; flags.push('skew_clamped'); }
  if (input.ingestedAt - input.observedAt > LATE_INGEST_MS) flags.push('late_ingest');
  return { ...input, id: recordId(input), effectiveObservedAt: effective, flags };
}

// Total order: effective time, then ingestion time, then id. Independent of
// arrival order, so replay is deterministic.
export const compareRecords = (a: LedgerRecord, b: LedgerRecord) =>
  a.effectiveObservedAt - b.effectiveObservedAt || a.ingestedAt - b.ingestedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export interface AppendResult { records: LedgerRecord[]; accepted: number; duplicates: number; rejected: Array<{ index: number; errors: string[] }> }

// Idempotent, order-independent append. A duplicate keeps the earliest-ingested copy.
export function append(existing: LedgerRecord[], incoming: unknown[]): AppendResult {
  const byId = new Map(existing.map(r => [r.id, r]));
  let accepted = 0, duplicates = 0;
  const rejected: AppendResult['rejected'] = [];
  incoming.forEach((raw, index) => {
    const migrated = migrateRecord(raw);
    if (!migrated.ok) { rejected.push({ index, errors: [migrated.error] }); return; }
    const v = validateRecord(migrated.value);
    if (!v.ok) { rejected.push({ index, errors: v.errors }); return; }
    const rec = toRecord(v.value);
    const prior = byId.get(rec.id);
    if (prior) {
      duplicates++;
      if (rec.ingestedAt < prior.ingestedAt) byId.set(rec.id, rec);
      return;
    }
    byId.set(rec.id, rec);
    accepted++;
  });
  return { records: [...byId.values()].sort(compareRecords), accepted, duplicates, rejected };
}

// Records not superseded by a correction. Corrections stay in the ledger (append-only).
export function currentView(records: LedgerRecord[]): LedgerRecord[] {
  const superseded = new Set(records.filter(r => r.kind === 'correction' && r.supersedes).map(r => r.supersedes));
  return records.filter(r => !superseded.has(r.id)).sort(compareRecords);
}

export interface Segment { provider: string; accountAlias: string; window: WindowType; points: Array<{ at: number; percent: number }>; }

// Splits provider snapshots into window segments. A new segment starts when the
// reported resetAt moves, or when quotaPercentUsed drops by more than RESET_PERCENT_DROP.
export function segments(records: LedgerRecord[]): Segment[] {
  const out: Segment[] = [];
  const open = new Map<string, { seg: Segment; lastReset?: number; lastPercent: number }>();
  for (const r of currentView(records)) {
    if (r.kind !== 'provider_snapshot' || !r.window) continue;
    const pct = r.measures.quotaPercentUsed as number;
    const key = `${r.provider}|${r.accountAlias}|${r.window.type}`;
    const st = open.get(key);
    const moved = st && r.window.resetAt !== undefined && st.lastReset !== undefined && Math.abs(r.window.resetAt - st.lastReset) > RESET_AT_TOLERANCE_MS;
    const dropped = st && pct < st.lastPercent - RESET_PERCENT_DROP;
    if (!st || moved || dropped) {
      const seg: Segment = { provider: r.provider, accountAlias: r.accountAlias, window: r.window.type, points: [] };
      out.push(seg);
      open.set(key, { seg, lastReset: r.window.resetAt, lastPercent: pct });
      seg.points.push({ at: r.effectiveObservedAt, percent: pct });
    } else {
      st.seg.points.push({ at: r.effectiveObservedAt, percent: pct });
      st.lastPercent = pct;
      if (r.window.resetAt !== undefined) st.lastReset = r.window.resetAt;
    }
  }
  return out;
}

// Provider-reported quota movement: sum of increases inside each segment. The
// interval that spans a reset is excluded, never counted as negative or positive usage.
export function quotaMovement(records: LedgerRecord[]): number {
  let total = 0;
  for (const s of segments(records)) for (let i = 1; i < s.points.length; i++) total += Math.max(0, s.points[i].percent - s.points[i - 1].percent);
  return Math.round(total * 1e6) / 1e6;
}

// Drops records older than the retention window. Corrections and the records they
// supersede are kept or dropped together so the view never resurrects a replaced record.
export function prune(records: LedgerRecord[], now: number, retentionMs = RETENTION_MS): LedgerRecord[] {
  const cutoff = now - retentionMs;
  const old = new Set(records.filter(r => r.effectiveObservedAt < cutoff).map(r => r.id));
  return records.filter(r => !old.has(r.id) && !(r.kind === 'correction' && r.supersedes && old.has(r.supersedes)));
}

// User deletion: hard-removes matching records (and corrections pointing at them). No tombstones.
export function deleteWhere(records: LedgerRecord[], match: (r: LedgerRecord) => boolean): LedgerRecord[] {
  const gone = new Set(records.filter(match).map(r => r.id));
  return records.filter(r => !gone.has(r.id) && !(r.kind === 'correction' && r.supersedes && gone.has(r.supersedes)));
}

// Rebuilds the ledger from raw stored lines in any order; the result equals the original.
export const replay = (raw: unknown[]): AppendResult => append([], raw);

// Calendar day in an IANA time zone, for daily rollups. Storage is always UTC epoch ms.
export function localDay(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

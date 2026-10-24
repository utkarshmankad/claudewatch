// Ledger convergence. Records are append-only and content-addressed, so merge is a set union keyed by id:
// commutative, associative and idempotent. Device clocks never pick a winner; they only label observations.
import type { SyncLedgerRecord } from '../e2ee/allowlist.js';
import { contentHash, deriveEventId } from './ids.js';

export type LedgerConflictKind = 'id_collision' | 'competing_correction';

export interface LedgerConflict {
  kind: LedgerConflictKind;
  /** The id (collision) or the superseded record id (competing correction). */
  subject: string;
  /** Record ids involved, sorted. */
  ids: string[];
}

export type MergeOutcome = 'applied' | 'duplicate' | 'conflict' | 'rejected';

export interface LedgerState {
  records: Record<string, SyncLedgerRecord>;
  conflicts: LedgerConflict[];
}

/** Resets reported within this window by different devices describe one boundary (clock skew tolerance). */
export const RESET_TOLERANCE_MS = 5 * 60_000;

export function emptyLedger(): LedgerState {
  return { records: {}, conflicts: [] };
}

function addConflict(state: LedgerState, conflict: LedgerConflict): void {
  const key = `${conflict.kind}|${conflict.subject}|${conflict.ids.join(',')}`;
  if (state.conflicts.some((c) => `${c.kind}|${c.subject}|${c.ids.join(',')}` === key)) return;
  state.conflicts.push(conflict);
}

/**
 * Merge one record. A record whose id is not its content hash is rejected so a buggy or hostile peer cannot
 * overwrite someone else's id. Equal ids with different content cannot both be kept under one key: the
 * lower content hash wins on every device and the collision is surfaced.
 */
export async function mergeRecord(state: LedgerState, record: SyncLedgerRecord, options: { strictIds?: boolean } = {}): Promise<MergeOutcome> {
  if (options.strictIds && record.id !== (await deriveEventId(record as unknown as Record<string, unknown>))) return 'rejected';
  const existing = state.records[record.id];
  if (!existing) {
    state.records[record.id] = record;
    noteCorrection(state, record);
    return 'applied';
  }
  const [a, b] = await Promise.all([contentHash(existing as unknown as Record<string, unknown>), contentHash(record as unknown as Record<string, unknown>)]);
  if (a === b) return 'duplicate';
  addConflict(state, { kind: 'id_collision', subject: record.id, ids: [record.id] });
  if (b < a) state.records[record.id] = record;
  return 'conflict';
}

function noteCorrection(state: LedgerState, record: SyncLedgerRecord): void {
  if (!record.supersedes) return;
  const rivals = Object.values(state.records).filter((r) => r.supersedes === record.supersedes);
  const distinct = new Set(rivals.map((r) => JSON.stringify([r.measures, r.correctionReason ?? ''])));
  if (distinct.size > 1) {
    addConflict(state, { kind: 'competing_correction', subject: record.supersedes, ids: rivals.map((r) => r.id).sort() });
  }
}

export interface ResetBoundary {
  provider: string;
  accountAlias: string;
  windowType: string;
  resetAt: number;
  recordIds: string[];
}

/** Cluster reset reports from different devices into single boundaries, earliest report anchoring each cluster. */
export function resetBoundaries(records: Iterable<SyncLedgerRecord>, toleranceMs = RESET_TOLERANCE_MS): ResetBoundary[] {
  const resets = [...records]
    .filter((r) => r.kind === 'reset' && r.window?.resetAt !== undefined)
    .sort((a, b) => (a.window?.resetAt ?? 0) - (b.window?.resetAt ?? 0) || (a.id < b.id ? -1 : 1));
  const out: ResetBoundary[] = [];
  for (const r of resets) {
    const at = r.window?.resetAt ?? 0;
    const type = r.window?.type ?? 'unknown';
    const open = out.find((b) => b.provider === r.provider && b.accountAlias === r.accountAlias && b.windowType === type && at - b.resetAt <= toleranceMs);
    if (open) open.recordIds.push(r.id);
    else out.push({ provider: r.provider, accountAlias: r.accountAlias, windowType: type, resetAt: at, recordIds: [r.id] });
  }
  return out;
}

/** Records that no later correction replaces. Competing corrections of one record all stay visible until resolved. */
export function effectiveRecords(state: LedgerState): SyncLedgerRecord[] {
  const superseded = new Set(Object.values(state.records).map((r) => r.supersedes).filter((id): id is string => Boolean(id)));
  const conflicted = new Set(state.conflicts.filter((c) => c.kind === 'competing_correction').map((c) => c.subject));
  return Object.values(state.records)
    .filter((r) => !superseded.has(r.id) || conflicted.has(r.id))
    .sort((a, b) => a.observedAt - b.observedAt || (a.id < b.id ? -1 : 1));
}

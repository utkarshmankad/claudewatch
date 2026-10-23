import { describe, expect, it } from 'vitest';
import { append, currentView, deleteWhere, localDay, migrateRecord, prune, quotaMovement, recordId, replay, segments, toRecord, MAX_FUTURE_SKEW_MS } from '../ledger.js';
import { validateRecord } from '../validate.js';
import type { LedgerInput } from '../types.js';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;
const DEV = 'a1b2c3d4e5f60718';

function snap(at: number, pct: number, resetAt = T0 + 5 * 3600_000, extra: Partial<LedgerInput> = {}): LedgerInput {
  return {
    schemaVersion: 1, kind: 'provider_snapshot', provider: 'claude', accountAlias: 'work', devicePseudonym: DEV,
    observedAt: at, ingestedAt: at + 1000, source: 'web', confidence: 'high', measurementMethod: 'provider_reported',
    measures: { quotaPercentUsed: pct }, window: { type: 'five_hour', resetAt }, ...extra,
  };
}
const activity = (at: number, tokens: number): LedgerInput => ({
  schemaVersion: 1, kind: 'local_activity', provider: 'claude', accountAlias: 'work', devicePseudonym: DEV,
  observedAt: at, ingestedAt: at + 1000, source: 'claude_code', confidence: 'medium', measurementMethod: 'local_log_parse',
  measures: { estimatedTokens: tokens, requestCount: 1 },
});

// Small seeded PRNG so the property-style tests are reproducible.
function rng(seed: number) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle<T>(xs: T[], r: () => number) { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

describe('validation', () => {
  it('accepts well-formed snapshots and activity', () => {
    expect(validateRecord(snap(T0, 10)).ok).toBe(true);
    expect(validateRecord(activity(T0, 500)).ok).toBe(true);
  });
  it('rejects malformed records fail-closed', () => {
    const bad: unknown[] = [
      null, 'x', [], {}, { ...snap(T0, 10), schemaVersion: 2 }, { ...snap(T0, 10), provider: 'openai' },
      snap(T0, 101), snap(T0, -1), snap(T0, Number.NaN), { ...snap(T0, 10), observedAt: 1.5 }, { ...snap(T0, 10), observedAt: 5 },
      { ...snap(T0, 10), accountAlias: 'me@example.com' }, { ...snap(T0, 10), devicePseudonym: 'not hex!' },
      { ...snap(T0, 10), prompt: 'hello' }, { ...snap(T0, 10), measures: { quotaPercentUsed: 5, prompt: 'x' } },
      { ...snap(T0, 10), measurementMethod: 'local_estimate' }, { ...snap(T0, 10), window: undefined },
      { ...activity(T0, 5), measures: { quotaPercentUsed: 5 } }, { ...activity(T0, 5), measures: { estimatedTokens: -1 } },
      { ...activity(T0, 5), measures: { estimatedTokens: 1.2 } },
      { ...activity(T0, 5), kind: 'correction' }, { ...activity(T0, 5), kind: 'reconciliation' },
      { ...activity(T0, 5), kind: 'reconciliation', measurementMethod: 'derived', measures: {}, reconciliation: { attributedUnits: 9, eligibleUnits: 3 } },
    ];
    for (const b of bad) expect(validateRecord(b).ok, JSON.stringify(b)).toBe(false);
  });
  it('keeps quota percentages out of local activity and tokens out of facts', () => {
    expect(validateRecord({ ...activity(T0, 5), measures: { quotaPercentUsed: 5, estimatedTokens: 5 } }).ok).toBe(false);
  });
});

describe('duplicate ingestion', () => {
  it('is idempotent and keeps the earliest-ingested copy', () => {
    const a = snap(T0, 10);
    const first = append([], [a]);
    const second = append(first.records, [a, { ...a, ingestedAt: a.ingestedAt + 9999 }, { ...a, ingestedAt: a.ingestedAt - 500 }]);
    expect(second.records).toHaveLength(1);
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(3);
    expect(second.records[0].ingestedAt).toBe(a.ingestedAt - 500);
  });
  it('treats different measures at the same time as different observations', () => {
    expect(recordId(snap(T0, 10))).not.toBe(recordId(snap(T0, 11)));
  });
  it('property: any shuffle and any amount of duplication replays to the same ledger', () => {
    const r = rng(42);
    for (let run = 0; run < 25; run++) {
      const inputs: LedgerInput[] = [];
      for (let i = 0; i < 20; i++) inputs.push(r() < 0.5 ? snap(T0 + i * MIN * 7, Math.floor(r() * 100)) : activity(T0 + i * MIN * 3, Math.floor(r() * 1000)));
      const base = replay(inputs).records;
      const noisy = shuffle([...inputs, ...inputs.filter(() => r() < 0.5)], r);
      expect(replay(noisy).records).toEqual(base);
      expect(replay(noisy).records.map(x => x.id)).toEqual(base.map(x => x.id));
    }
  });
});

describe('ordering and clock skew', () => {
  it('orders by effective time regardless of arrival order', () => {
    const recs = replay([snap(T0 + 20 * MIN, 30), snap(T0, 10), snap(T0 + 10 * MIN, 20)]).records;
    expect(recs.map(r => r.measures.quotaPercentUsed)).toEqual([10, 20, 30]);
  });
  it('clamps observations from the future and flags them', () => {
    const rec = toRecord({ ...snap(T0, 10), observedAt: T0 + MAX_FUTURE_SKEW_MS + 1, ingestedAt: T0 });
    expect(rec.effectiveObservedAt).toBe(T0);
    expect(rec.flags).toContain('skew_clamped');
    const ok = toRecord({ ...snap(T0, 10), observedAt: T0 + MAX_FUTURE_SKEW_MS, ingestedAt: T0 });
    expect(ok.flags).toEqual([]);
  });
  it('flags very late ingestion without rejecting', () => {
    const rec = toRecord({ ...snap(T0, 10), ingestedAt: T0 + 31 * 86_400_000 });
    expect(rec.flags).toContain('late_ingest');
  });
  it('breaks ties by ingestion time then id, deterministically', () => {
    const a = activity(T0, 1), b = { ...activity(T0, 2), ingestedAt: a.ingestedAt };
    expect(replay([a, b]).records.map(r => r.id)).toEqual(replay([b, a]).records.map(r => r.id));
  });
});

describe('resets', () => {
  const reset1 = T0 + 5 * 3600_000, reset2 = reset1 + 5 * 3600_000;
  it('starts a new segment when resetAt moves and excludes the spanning interval', () => {
    const recs = replay([snap(T0, 10, reset1), snap(T0 + 60 * MIN, 40, reset1), snap(T0 + 6 * 3600_000, 5, reset2), snap(T0 + 7 * 3600_000, 15, reset2)]).records;
    expect(segments(recs)).toHaveLength(2);
    expect(quotaMovement(recs)).toBe(30 + 10);
  });
  it('starts a new segment on a percent drop even without resetAt', () => {
    const noReset = (at: number, p: number): LedgerInput => snap(at, p, undefined, { window: { type: 'weekly' } });
    const recs = replay([noReset(T0, 80), noReset(T0 + MIN, 90), noReset(T0 + 2 * MIN, 3), noReset(T0 + 3 * MIN, 8)]).records;
    expect(segments(recs)).toHaveLength(2);
    expect(quotaMovement(recs)).toBe(10 + 5);
  });
  it('tolerates small resetAt jitter and ignores a tiny dip', () => {
    const recs = replay([snap(T0, 50, reset1), snap(T0 + MIN, 49.5, reset1 + 5000), snap(T0 + 2 * MIN, 52, reset1 + 9000)]).records;
    expect(segments(recs)).toHaveLength(1);
  });
  it('keeps accounts and window types separate', () => {
    const other = snap(T0 + MIN, 5, reset1, { accountAlias: 'personal' });
    const recs = replay([snap(T0, 60, reset1), other]).records;
    expect(segments(recs)).toHaveLength(2);
  });
  it('property: movement never negative and never exceeds the sum of per-segment rises', () => {
    const r = rng(7);
    for (let run = 0; run < 25; run++) {
      const inputs: LedgerInput[] = [];
      for (let i = 0; i < 30; i++) inputs.push(snap(T0 + i * 10 * MIN, Math.floor(r() * 100), reset1 + Math.floor(i / 8) * 5 * 3600_000));
      const m = quotaMovement(replay(shuffle(inputs, r)).records);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBe(quotaMovement(replay(inputs).records));
    }
  });
});

describe('corrections', () => {
  it('hides the superseded record from the current view but keeps it in the ledger', () => {
    const wrong = activity(T0, 9999);
    const [w] = replay([wrong]).records;
    const fix: LedgerInput = { ...activity(T0, 100), kind: 'correction', measurementMethod: 'user_correction', supersedes: w.id, correctionReason: 'parser_fix' };
    const all = replay([wrong, fix, activity(T0, 100)]).records;
    expect(all.some(r => r.id === w.id)).toBe(true);
    expect(currentView(all).some(r => r.id === w.id)).toBe(false);
  });
});

describe('time zone boundaries', () => {
  it('buckets the same instant into different local days', () => {
    const t = Date.UTC(2026, 9, 1, 23, 30);
    expect(localDay(t, 'UTC')).toBe('2026-10-01');
    expect(localDay(t, 'Asia/Kolkata')).toBe('2026-10-02');
    expect(localDay(t, 'America/Los_Angeles')).toBe('2026-10-01');
  });
  it('handles DST transitions: 23 and 25 hour local days, none skipped or repeated', () => {
    const hoursPerDay = (startUtc: number, hours: number, tz: string) => {
      const m = new Map<string, number>();
      for (let h = 0; h < hours; h++) { const d = localDay(startUtc + h * 3600_000, tz); m.set(d, (m.get(d) ?? 0) + 1); }
      return Object.fromEntries(m);
    };
    // US spring forward 2026-03-08 and fall back 2026-11-01 (New York), starting at local midnight
    expect(hoursPerDay(Date.UTC(2026, 2, 7, 5), 71, 'America/New_York')).toEqual({ '2026-03-07': 24, '2026-03-08': 23, '2026-03-09': 24 });
    expect(hoursPerDay(Date.UTC(2026, 9, 31, 4), 73, 'America/New_York')).toEqual({ '2026-10-31': 24, '2026-11-01': 25, '2026-11-02': 24 });
  });
  it('stores UTC so an offset change cannot reorder records', () => {
    const recs = replay([activity(Date.UTC(2026, 10, 1, 5, 30), 1), activity(Date.UTC(2026, 10, 1, 6, 30), 2)]).records;
    expect(recs.map(r => r.measures.estimatedTokens)).toEqual([1, 2]);
  });
});

describe('malformed input, migration, retention, deletion', () => {
  it('rejects bad lines but keeps good ones and reports the index', () => {
    const res = append([], [snap(T0, 10), { nope: 1 }, snap(T0 + MIN, 101), activity(T0, 5)]);
    expect(res.accepted).toBe(2);
    expect(res.rejected.map(r => r.index)).toEqual([1, 2]);
  });
  it('refuses newer schema versions and unknown old ones', () => {
    expect(migrateRecord({ schemaVersion: 2 }).ok).toBe(false);
    expect(migrateRecord({ schemaVersion: 0 }).ok).toBe(false);
    expect(migrateRecord({}).ok).toBe(false);
    expect(migrateRecord(snap(T0, 1)).ok).toBe(true);
  });
  it('prunes past retention and keeps a correction with its target', () => {
    const now = T0 + 100 * 86_400_000;
    const oldRec = activity(T0, 1);
    const [o] = replay([oldRec]).records;
    const fix: LedgerInput = { ...activity(now - 1000, 1), kind: 'correction', measurementMethod: 'user_correction', supersedes: o.id, correctionReason: 'user_edit' };
    const fresh = activity(now - 1000, 5);
    const kept = prune(replay([oldRec, fix, fresh]).records, now);
    expect(kept.map(r => r.kind).sort()).toEqual(['local_activity']);
  });
  it('deletes matching records and their corrections without tombstones', () => {
    const a = activity(T0, 1);
    const [ra] = replay([a]).records;
    const fix: LedgerInput = { ...activity(T0 + MIN, 2), kind: 'correction', measurementMethod: 'user_correction', supersedes: ra.id, correctionReason: 'user_edit' };
    const keep = snap(T0, 10, undefined, { accountAlias: 'personal' });
    const all = replay([a, fix, keep]).records;
    const left = deleteWhere(all, r => r.accountAlias === 'work');
    expect(left).toHaveLength(1);
    expect(left[0].accountAlias).toBe('personal');
  });
});

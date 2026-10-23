import { describe, expect, it } from 'vitest';
import { append } from '../ledger.js';
import { reconcile } from '../reconcile.js';
import type { LedgerInput, LedgerRecord } from '../types.js';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;
const DEV = 'a1b2c3d4e5f60718';
const DEV2 = 'b2c3d4e5f6071829';
const RESET = T0 + 5 * 3600_000;

const snap = (at: number, pct: number, o: Partial<LedgerInput> = {}): LedgerInput => ({
  schemaVersion: 1, kind: 'provider_snapshot', provider: 'claude', accountAlias: 'work', devicePseudonym: DEV,
  observedAt: at, ingestedAt: at + 1000, source: 'web', confidence: 'high', measurementMethod: 'provider_reported',
  measures: { quotaPercentUsed: pct }, window: { type: 'five_hour', resetAt: RESET }, ...o,
});
const act = (at: number, tokens: number, o: Partial<LedgerInput> = {}): LedgerInput => ({
  schemaVersion: 1, kind: 'local_activity', provider: 'claude', accountAlias: 'work', devicePseudonym: DEV,
  observedAt: at, ingestedAt: at + 1000, source: 'claude_code', confidence: 'medium', measurementMethod: 'local_log_parse',
  measures: { estimatedTokens: tokens, requestCount: 1 }, ...o,
});
const ledger = (xs: LedgerInput[]): LedgerRecord[] => {
  const r = append([], xs);
  expect(r.rejected).toEqual([]);
  return r.records;
};
const CAL = { low: 0.0008, high: 0.0012 }; // points per token, synthetic

describe('reconcile', () => {
  it('attributes only evidence-supported points and reports the remainder as unattributed', () => {
    const rep = reconcile(ledger([snap(T0, 10), act(T0 + 5 * MIN, 5000), snap(T0 + 10 * MIN, 20)]), { calibration: CAL });
    const [i] = rep.intervals;
    expect(i.status).toBe('reconciled');
    expect(i.providerDelta).toBe(10);
    expect(i.attributed).toEqual({ low: 4, point: 5, high: 6 });
    expect(i.unattributed).toEqual({ low: 4, point: 5, high: 6 });
    expect(i.bySource).toEqual({ claude_code: 5 });
    expect(rep.coverage['claude|work|five_hour'].coverage).toEqual({ low: 0.4, point: 0.5, high: 0.6 });
  });

  it('never attributes more than the provider moved and says so', () => {
    const [i] = reconcile(ledger([snap(T0, 10), act(T0 + MIN, 50_000), snap(T0 + 10 * MIN, 12)]), { calibration: CAL }).intervals;
    expect(i.attributed.high).toBe(2);
    expect(i.unattributed.low).toBe(0);
    expect(i.notes).toContain('local_exceeds_provider');
  });

  it('attributes nothing without calibration and does not invent events', () => {
    const records = ledger([snap(T0, 10), act(T0 + MIN, 5000), snap(T0 + 10 * MIN, 20)]);
    const rep = reconcile(records);
    expect(rep.intervals[0].attributed.point).toBe(0);
    expect(rep.intervals[0].unattributed.point).toBe(10);
    expect(rep.intervals[0].notes).toContain('no_calibration');
    expect(records).toHaveLength(3);
  });

  it('classifies a no-activity interval fully as unattributed', () => {
    const [i] = reconcile(ledger([snap(T0, 10), snap(T0 + 10 * MIN, 14)]), { calibration: CAL }).intervals;
    expect(i.unattributed).toEqual({ low: 4, point: 4, high: 4 });
    expect(i.explanation).toContain('No local activity');
  });

  it('excludes the interval that spans a reset from coverage', () => {
    const rep = reconcile(ledger([snap(T0, 80), snap(T0 + 10 * MIN, 90), snap(T0 + 6 * 3600_000, 3, { window: { type: 'five_hour', resetAt: RESET + 5 * 3600_000 } }), snap(T0 + 6 * 3600_000 + 10 * MIN, 8, { window: { type: 'five_hour', resetAt: RESET + 5 * 3600_000 } })]), { calibration: CAL });
    expect(rep.intervals.filter(i => i.excludedReason === 'reset')).toHaveLength(1);
    expect(rep.coverage['claude|work|five_hour'].eligibleUnits).toBe(15);
    expect(rep.coverage['claude|work|five_hour'].excluded).toBe(1);
  });

  it('treats a small provider drop as a negative correction, excluded', () => {
    const [i] = reconcile(ledger([snap(T0, 10), act(T0 + MIN, 100), snap(T0 + 10 * MIN, 9.5)]), { calibration: CAL }).intervals;
    expect(i.excludedReason).toBe('negative_correction');
    expect(i.providerDelta).toBe(-0.5);
    expect(i.notes).toContain('activity_without_quota_movement');
  });

  it('ignores activity under another account alias (account switch)', () => {
    const [i] = reconcile(ledger([snap(T0, 10), act(T0 + MIN, 5000, { accountAlias: 'personal' }), snap(T0 + 10 * MIN, 20)]), { calibration: CAL }).intervals;
    expect(i.attributed.point).toBe(0);
    expect(i.notes).toContain('other_account_activity_ignored');
  });

  it('shares attribution across simultaneous clients by tokens', () => {
    const [i] = reconcile(ledger([snap(T0, 10), act(T0 + MIN, 3000), act(T0 + 2 * MIN, 1000, { source: 'codex', provider: 'claude', devicePseudonym: DEV2 }), snap(T0 + 10 * MIN, 20)]), { calibration: CAL }).intervals;
    expect(i.attributed.point).toBe(4);
    expect(i.bySource).toEqual({ claude_code: 3, codex: 1 });
    expect(i.notes).toContain('simultaneous_clients');
    expect(i.evidence.devices).toEqual([DEV, DEV2]);
  });

  it('shifts the activity span for delayed provider data', () => {
    const records = ledger([snap(T0, 10), act(T0 + 8 * MIN, 5000), snap(T0 + 10 * MIN, 10), snap(T0 + 20 * MIN, 15)]);
    const none = reconcile(records, { calibration: CAL }).intervals;
    expect(none[1].attributed.point).toBe(0); // activity before the first snapshot of this interval
    const delayed = reconcile(records, { calibration: CAL, providerDelayMs: 5 * MIN }).intervals;
    expect(delayed[0].status).toBe('excluded');
    expect(delayed[1].evidence.recordIds).toHaveLength(1); // observed at +8m lands in (+5m, +15m]
  });

  it('flags long gaps as possibly missing snapshots', () => {
    const [i] = reconcile(ledger([snap(T0, 10), snap(T0 + 3 * 3600_000, 30)]), { calibration: CAL }).intervals;
    expect(i.notes).toContain('missing_snapshots');
  });

  it('keeps overlapping windows separate and does not sum their coverage', () => {
    const wk = (at: number, pct: number) => snap(at, pct, { window: { type: 'weekly', resetAt: T0 + 7 * 86_400_000 } });
    const rep = reconcile(ledger([snap(T0, 10), wk(T0, 2), act(T0 + MIN, 5000), snap(T0 + 10 * MIN, 20), wk(T0 + 10 * MIN, 3)]), { calibration: CAL });
    expect(Object.keys(rep.coverage).sort()).toEqual(['claude|work|five_hour', 'claude|work|weekly']);
    expect(rep.coverage['claude|work|weekly'].eligibleUnits).toBe(1);
  });

  it('returns null coverage when nothing is eligible', () => {
    const rep = reconcile(ledger([snap(T0, 10), snap(T0 + 10 * MIN, 10)]));
    expect(rep.coverage['claude|work|five_hour'].coverage).toBeNull();
    expect(rep.intervals[0].excludedReason).toBe('no_movement');
  });

  it('is deterministic regardless of ingestion order and ignores superseded records', () => {
    const inputs = [snap(T0, 10), act(T0 + MIN, 5000), snap(T0 + 10 * MIN, 20)];
    const a = reconcile(ledger(inputs), { calibration: CAL });
    const b = reconcile(ledger([...inputs].reverse()), { calibration: CAL });
    expect(b).toEqual(a);
    const records = ledger(inputs);
    const act0 = records.find(r => r.kind === 'local_activity')!;
    const withCorrection = ledger([...inputs, { ...act(T0 + MIN, 0), kind: 'correction', supersedes: act0.id, correctionReason: 'duplicate_session', measures: { estimatedTokens: 0 }, measurementMethod: 'user_correction' } as LedgerInput]);
    const c = reconcile(withCorrection, { calibration: CAL });
    expect(c.intervals[0].evidence.recordIds).toEqual([]);
  });

  it('writes an auditable explanation for every interval', () => {
    const rep = reconcile(ledger([snap(T0, 10), act(T0 + MIN, 5000), snap(T0 + 10 * MIN, 20)]), { calibration: CAL });
    expect(rep.intervals[0].explanation).toMatch(/provider reported \+10 points.*Attributed 5 points \(range 4 to 6\).*Unattributed.*5 points/);
  });
});

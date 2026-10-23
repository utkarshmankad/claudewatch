import { describe, expect, it } from 'vitest';
import { append } from '../ledger.js';
import { CAVEAT, LABEL_TEXT, STALE_AFTER_MS, buildLedgerView, filteredRows, labelOf, parseFilter, toCsv } from '../view.js';
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
const NOW = T0 + 15 * MIN;

describe('labelOf', () => {
  it('gives every record kind a distinct text label', () => {
    const recs = ledger([
      snap(T0, 5),
      act(T0 + MIN, 100),
      act(T0 + 2 * MIN, 100, { measurementMethod: 'local_estimate', source: 'web', confidence: 'low' }),
      act(T0 + 3 * MIN, 100, { source: 'unattributed', confidence: 'unknown', measurementMethod: 'derived' }),
    ]);
    expect(recs.map(labelOf)).toEqual(['provider_reported', 'measured', 'estimated', 'unattributed']);
    expect(new Set(Object.values(LABEL_TEXT)).size).toBe(Object.keys(LABEL_TEXT).length);
  });
  it('labels reconciliation and correction records', () => {
    const recs = ledger([
      { ...act(T0, 0), kind: 'reconciliation', measurementMethod: 'derived', measures: {}, reconciliation: { attributedUnits: 1, eligibleUnits: 2 } },
      { ...act(T0 + MIN, 0), kind: 'correction', measurementMethod: 'user_correction', supersedes: 'ab'.repeat(32), correctionReason: 'user_edit', measures: { requestCount: 1 } },
    ]);
    expect(recs.map(labelOf).sort()).toEqual(['corrected', 'reconciled']);
  });
});

describe('buildLedgerView', () => {
  it('is empty with no records, and no_match when filters exclude everything', () => {
    expect(buildLedgerView([], {}, { now: NOW }).state).toBe('empty');
    const recs = ledger([snap(T0, 5), snap(T0 + 5 * MIN, 8)]);
    expect(buildLedgerView(recs, { provider: 'gemini' }, { now: NOW }).state).toBe('no_match');
  });

  it('answers where quota changed, with evidence and the unidentified remainder', () => {
    const recs = ledger([snap(T0, 10), act(T0 + 5 * MIN, 5000), snap(T0 + 10 * MIN, 20)]);
    const v = buildLedgerView(recs, {}, { now: NOW });
    expect(v.state).toBe('ok');
    expect(v.quotaChanges).toHaveLength(1);
    expect(v.quotaChanges[0]).toMatchObject({ providerDeltaPoints: 10, evidenceCount: 1, from: T0, to: T0 + 10 * MIN });
    // No calibration exists, so nothing is attributed and all movement is unidentified.
    expect(v.unidentifiedPoints).toEqual({ low: 10, high: 10 });
    expect(v.providerMovementPoints).toBe(10);
    expect(v.quotaChanges[0].explanation).toContain('No calibration');
    expect(v.totalsByLabel.provider_reported.records).toBe(2);
    expect(v.totalsByLabel.measured).toEqual({ records: 1, requests: 1, estimatedTokens: 5000 });
    expect(v.caveat).toBe(CAVEAT);
  });

  it('filters by provider, account, device, client, source, confidence and time', () => {
    const recs = ledger([
      snap(T0, 5),
      act(T0 + MIN, 10),
      act(T0 + 2 * MIN, 20, { devicePseudonym: DEV2, accountAlias: 'home', source: 'codex', provider: 'chatgpt', confidence: 'low', measurementMethod: 'local_estimate' }),
    ]);
    const n = (f: Parameters<typeof buildLedgerView>[1]) => buildLedgerView(recs, f, { now: NOW }).matched;
    expect(n({})).toBe(3);
    expect(n({ provider: 'chatgpt' })).toBe(1);
    expect(n({ account: 'home' })).toBe(1);
    expect(n({ device: DEV2 })).toBe(1);
    expect(n({ client: 'claude_code' })).toBe(1);
    expect(n({ source: 'local_estimate' })).toBe(1);
    expect(n({ confidence: 'high' })).toBe(1);
    expect(n({ from: T0 + MIN, to: T0 + 2 * MIN })).toBe(1);
    expect(buildLedgerView(recs, {}, { now: NOW }).options.devices).toEqual([DEV, DEV2]);
  });

  it('reports stale when the newest provider snapshot is old', () => {
    const v = buildLedgerView(ledger([snap(T0, 5)]), {}, { now: T0 + STALE_AFTER_MS + 1 });
    expect(v.state).toBe('stale');
    expect(v.stateReasons).toContain('provider_snapshot_old');
  });

  it('reports partial when only local activity exists, and when snapshots have gaps', () => {
    const only = buildLedgerView(ledger([act(T0, 10)]), {}, { now: NOW });
    expect(only.state).toBe('partial');
    expect(only.stateReasons).toEqual(['no_provider_snapshots']);
    const gap = buildLedgerView(ledger([snap(T0, 5), snap(T0 + 90 * MIN, 9)]), {}, { now: T0 + 91 * MIN });
    expect(gap.state).toBe('partial');
    expect(gap.stateReasons).toContain('snapshot_gaps');
  });

  it('flags skew-clamped records as partial', () => {
    const v = buildLedgerView(ledger([snap(T0, 5, { observedAt: T0 + 3600_000, ingestedAt: T0 })]), {}, { now: T0 + MIN });
    expect(v.stateReasons).toContain('flagged_records');
  });

  it('truncates rows newest first and caps the limit', () => {
    const recs = ledger(Array.from({ length: 5 }, (_, i) => act(T0 + i * MIN, i + 1)));
    const v = buildLedgerView(recs, {}, { now: NOW, limit: 2 });
    expect(v.rows).toHaveLength(2);
    expect(v.truncated).toBe(true);
    expect(v.rows[0].at).toBeGreaterThan(v.rows[1].at);
    expect(filteredRows(recs, {})).toHaveLength(5);
  });

  it('ignores superseded records', () => {
    const base = ledger([act(T0, 10)]);
    const withFix = append(base, [{ ...act(T0 + MIN, 0), kind: 'correction', measurementMethod: 'user_correction', supersedes: base[0].id, correctionReason: 'user_edit', measures: { requestCount: 1 } }]).records;
    const v = buildLedgerView(withFix, {}, { now: NOW });
    expect(v.rows.map(r => r.label)).toEqual(['corrected']);
  });
});

describe('parseFilter', () => {
  it('accepts valid values and rejects unknown enums, bad devices and inverted ranges', () => {
    expect(parseFilter({ provider: 'claude', device: DEV, from: '1', to: '5' })).toEqual({ ok: true, filter: { provider: 'claude', device: DEV, from: 1, to: 5 } });
    expect(parseFilter({}).ok).toBe(true);
    for (const q of [{ provider: 'x' }, { client: 'x' }, { source: 'x' }, { confidence: 'x' }, { device: 'ZZ' }, { from: 'abc' }, { from: '-1' }, { account: 'a'.repeat(65) }]) {
      expect(parseFilter(q)).toEqual({ ok: false, error: 'invalid_filter_value' });
    }
    expect(parseFilter({ from: '5', to: '1' })).toEqual({ ok: false, error: 'invalid_time_range' });
  });
});

describe('toCsv', () => {
  it('writes ISO times and text labels, and neutralises spreadsheet formulas', () => {
    const [row] = filteredRows(ledger([snap(T0, 5)]), {});
    const csv = toCsv([{ ...row, account: '=cmd' }]);
    const [head, line] = csv.trim().split('\n');
    expect(head.startsWith('observed_at_iso,provider')).toBe(true);
    expect(line).toContain('"2026-10-01T12:00:00.000Z"');
    expect(line).toContain('"Provider-reported"');
    expect(line).toContain(`"'=cmd"`);
  });
});

describe('wording', () => {
  it('never implies exact billing', () => {
    const text = [...Object.values(LABEL_TEXT), CAVEAT].join(' ').toLowerCase();
    for (const banned of ['exact', 'billed', 'you were charged', 'precise', 'invoice']) expect(text).not.toContain(banned);
  });
});

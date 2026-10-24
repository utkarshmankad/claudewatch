import { describe, expect, it } from 'vitest';
import { append } from '../../ledger/ledger.js';
import type { LedgerInput, LedgerRecord } from '../../ledger/types.js';
import { METRIC_DEFINITIONS, METRIC_IDS, requiresUserAction } from '../definitions.js';
import { computePeriodMetrics, utcMonth, utcWeek } from '../metrics.js';
import { planCost, resolvePrice, validateCatalog, type PricingCatalog } from '../pricing.js';

const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
const W0 = Date.UTC(2026, 9, 5); // Monday
const W1 = W0 + 7 * DAY;
const DEV = 'a1b2c3d4e5f60718';

const snap = (at: number, pct: number, resetAt: number, o: Partial<LedgerInput> = {}): LedgerInput => ({
  schemaVersion: 1, kind: 'provider_snapshot', provider: 'claude', accountAlias: 'work', devicePseudonym: DEV,
  observedAt: at, ingestedAt: at + 1000, source: 'web', confidence: 'high', measurementMethod: 'provider_reported',
  measures: { quotaPercentUsed: pct }, window: { type: 'five_hour', resetAt }, ...o,
});
const act = (at: number, requests: number, o: Partial<LedgerInput> = {}): LedgerInput => ({
  schemaVersion: 1, kind: 'local_activity', provider: 'claude', accountAlias: 'work', devicePseudonym: DEV,
  observedAt: at, ingestedAt: at + 1000, source: 'claude_code', confidence: 'medium', measurementMethod: 'local_log_parse',
  measures: { estimatedTokens: requests * 100, requestCount: requests }, ...o,
});
const ledger = (xs: LedgerInput[]): LedgerRecord[] => {
  const r = append([], xs);
  expect(r.rejected).toEqual([]);
  return r.records;
};
const opts = (o: object = {}) => ({ start: W0, end: W1, now: W1 + HOUR, ...o });

const catalog: PricingCatalog = {
  schemaVersion: 1,
  entries: [
    { provider: 'claude', planId: 'pro', currency: 'USD', region: 'US', amountMinor: 2000, billing: 'monthly', taxTreatment: 'excluded', sourceUrl: 'https://example.com/pricing', effectiveFrom: Date.UTC(2026, 0, 1) },
    { provider: 'claude', planId: 'max', currency: 'USD', region: 'US', amountMinor: 10000, billing: 'monthly', taxTreatment: 'excluded', sourceUrl: 'https://example.com/pricing', effectiveFrom: Date.UTC(2026, 0, 1) },
    { provider: 'chatgpt', planId: 'plus', currency: 'EUR', region: 'ZZ', amountMinor: 2200, billing: 'monthly', taxTreatment: 'included', sourceUrl: 'https://example.com/plus', effectiveFrom: Date.UTC(2026, 0, 1) },
    { provider: 'gemini', planId: 'adv', currency: 'USD', region: 'US', amountMinor: 36500, billing: 'annual', taxTreatment: 'unknown', sourceUrl: 'https://example.com/adv', effectiveFrom: Date.UTC(2026, 0, 1) },
  ],
};

describe('definitions', () => {
  it('defines every metric id once and flags user-action claims', () => {
    expect(Object.keys(METRIC_DEFINITIONS).sort()).toEqual([...METRIC_IDS].sort());
    expect(requiresUserAction('prevented_interruptions')).toBe(true);
    expect(requiresUserAction('provider_mix')).toBe(false);
    for (const d of Object.values(METRIC_DEFINITIONS)) expect(d.caveat.length).toBeGreaterThan(10);
  });
});

describe('computePeriodMetrics: missing data', () => {
  it('marks everything unavailable for an empty ledger, never zero', () => {
    const m = computePeriodMetrics([], opts());
    for (const k of ['providerMix', 'clientMix', 'quotaRiskEvents', 'preventedInterruptions', 'resetUtilization', 'unusedQuota', 'forecastAccuracy', 'attributableActivity', 'subscriptionCost'] as const) {
      expect(m[k].status).toBe('unavailable');
      expect(m[k].value).toBeNull();
    }
    expect(m.completeness.complete).toBe(false);
    expect(m.completeness.reasons).toContain('sparse_data');
  });
  it('ignores activity without a request count and says so', () => {
    const recs = ledger([act(W0 + HOUR, 4), act(W0 + 2 * HOUR, 0, { measures: { estimatedTokens: 500 } })]);
    const m = computePeriodMetrics(recs, opts());
    expect(m.providerMix.value).toEqual([{ key: 'claude', requests: 4, share: 1 }]);
    expect(m.providerMix.reasons).toContain('records_without_request_count_ignored');
  });
});

describe('mix and unattributed activity', () => {
  it('splits providers and clients and keeps unattributed separate', () => {
    const recs = ledger([
      act(W0 + HOUR, 6), act(W0 + 2 * HOUR, 2, { source: 'codex', provider: 'chatgpt' }),
      act(W0 + 3 * HOUR, 2, { source: 'unattributed', confidence: 'unknown', measurementMethod: 'derived' }),
    ]);
    const m = computePeriodMetrics(recs, opts());
    expect(m.providerMix.value).toEqual([{ key: 'claude', requests: 8, share: 0.8 }, { key: 'chatgpt', requests: 2, share: 0.2 }]);
    expect(m.clientMix.value?.clients).toEqual([{ key: 'claude_code', requests: 6, share: 0.75 }, { key: 'codex', requests: 2, share: 0.25 }]);
    expect(m.clientMix.value?.unattributedRequests).toBe(2);
    expect(m.providerMix.status).toBe('measured');
  });
  it('is unavailable when all activity is unattributed', () => {
    const recs = ledger([act(W0 + HOUR, 3, { source: 'unattributed', confidence: 'unknown', measurementMethod: 'derived' })]);
    expect(computePeriodMetrics(recs, opts()).clientMix.status).toBe('unavailable');
  });
  it('excludes activity outside the period and superseded records', () => {
    const recs = ledger([act(W0 - HOUR, 9), act(W1 + HOUR, 9), act(W0 + HOUR, 1)]);
    expect(computePeriodMetrics(recs, opts({ now: W1 + 2 * DAY })).providerMix.value).toEqual([{ key: 'claude', requests: 1, share: 1 }]);
  });
});

describe('quota windows and resets', () => {
  const reset1 = W0 + 5 * HOUR;
  const recs = () => ledger([
    snap(W0 + 1 * HOUR, 30, reset1), snap(W0 + 3 * HOUR, 85, reset1), snap(W0 + 4 * HOUR + 50 * MIN, 90, reset1),
    snap(W0 + 6 * HOUR, 5, reset1 + 5 * HOUR), snap(W0 + 8 * HOUR, 100, reset1 + 5 * HOUR),
    snap(W0 + 11 * HOUR, 10, reset1 + 10 * HOUR),
  ]);
  it('counts windows at risk and at the limit from provider snapshots', () => {
    const m = computePeriodMetrics(recs(), opts());
    expect(m.quotaRiskEvents.status).toBe('provider_reported');
    expect(m.quotaRiskEvents.value).toEqual({ windowsAtRisk: 2, windowsAtLimit: 1, threshold: 80 });
  });
  it('reports utilization at reset as a lower bound and unused quota as its complement', () => {
    const m = computePeriodMetrics(recs(), opts());
    expect(m.resetUtilization.value).toEqual({ meanPercent: 95, windows: 2 });
    expect(m.resetUtilization.reasons).toContain('lower_bound');
    expect(m.unusedQuota.value).toEqual({ meanPercent: 5, windows: 2 });
    expect(m.unusedQuota.reasons).toContain('upper_bound');
  });
  it('does not count a window that never reset in the period', () => {
    const only = ledger([snap(W0 + HOUR, 40, W0 + 5 * HOUR)]);
    const m = computePeriodMetrics(only, opts());
    expect(m.resetUtilization.status).toBe('unavailable');
    expect(m.quotaRiskEvents.value?.windowsAtRisk).toBe(0);
  });
  it('treats a reset that straddles the period start as belonging to the period it began in', () => {
    const r = ledger([snap(W0 - 2 * HOUR, 70, W0 - HOUR), snap(W0 + HOUR, 3, W0 + 4 * HOUR)]);
    expect(computePeriodMetrics(r, opts()).resetUtilization.value).toEqual({ meanPercent: 70, windows: 1 });
  });
});

describe('partial weeks', () => {
  it('flags an unfinished period and ignores the future', () => {
    const recs = ledger([act(W0 + HOUR, 2), act(W0 + 2 * DAY, 2), act(W0 + 3 * DAY, 2)]);
    const m = computePeriodMetrics(recs, opts({ now: W0 + 3 * DAY + HOUR }));
    expect(m.completeness.reasons).toContain('period_not_finished');
    expect(m.completeness.complete).toBe(false);
    expect(m.completeness.elapsedDays).toBeCloseTo(3.0417, 3);
    expect(m.providerMix.value?.[0].requests).toBe(6);
  });
  it('is complete when enough days have data after the period ends', () => {
    const recs = ledger([0, 1, 2, 3, 4, 5, 6].map(d => act(W0 + d * DAY + HOUR, 1)));
    const m = computePeriodMetrics(recs, opts());
    expect(m.completeness).toMatchObject({ complete: true, daysWithData: 7, dayCoverage: 1 });
  });
  it('flags sparse data in a finished period', () => {
    const m = computePeriodMetrics(ledger([act(W0 + HOUR, 1)]), opts());
    expect(m.completeness.reasons).toEqual(['sparse_data']);
  });
  it('builds UTC week and month bounds', () => {
    expect(utcWeek(W0 + 3 * DAY)).toEqual({ start: W0, end: W1 });
    expect(utcWeek(W0 + 6 * DAY + 23 * HOUR)).toEqual({ start: W0, end: W1 });
    expect(utcMonth(Date.UTC(2026, 1, 15))).toEqual({ start: Date.UTC(2026, 1, 1), end: Date.UTC(2026, 2, 1) });
  });
});

describe('claims that need a user or a calibration', () => {
  it('never infers prevented interruptions', () => {
    const recs = ledger([snap(W0 + HOUR, 95, W0 + 5 * HOUR)]);
    expect(computePeriodMetrics(recs, opts()).preventedInterruptions).toMatchObject({ status: 'unavailable', reasons: ['needs_user_confirmation'] });
    expect(computePeriodMetrics(recs, opts({ confirmedPrevented: 0 })).preventedInterruptions).toMatchObject({ status: 'measured', value: 0 });
  });
  it('withholds attribution without a calibration', () => {
    const recs = ledger([snap(W0 + HOUR, 10, W0 + 5 * HOUR), act(W0 + 90 * MIN, 5), snap(W0 + 2 * HOUR, 20, W0 + 5 * HOUR)]);
    expect(computePeriodMetrics(recs, opts()).attributableActivity.reasons).toEqual(['no_calibration']);
    const m = computePeriodMetrics(recs, opts({ reconcile: { calibration: { low: 0.01, high: 0.03 } } }));
    expect(m.attributableActivity.status).toBe('estimated');
    expect(Object.keys(m.attributableActivity.value ?? {})).toEqual(['claude|work|five_hour']);
  });
  it('requires enough comparisons for forecast accuracy', () => {
    const recs = ledger([snap(W0 + HOUR, 10, W0 + 5 * HOUR), snap(W0 + 2 * HOUR, 20, W0 + 5 * HOUR)]);
    expect(computePeriodMetrics(recs, opts()).forecastAccuracy.reasons).toEqual(['too_few_comparisons']);
  });
});

describe('pricing catalog', () => {
  it('validates schema and rejects bad entries', () => {
    expect(validateCatalog(catalog).ok).toBe(true);
    const bad = validateCatalog({ schemaVersion: 1, entries: [{ ...catalog.entries[0], currency: 'usd', sourceUrl: 'http://x', amountMinor: 1.5 }] });
    expect(bad).toEqual({ ok: false, errors: ['entries[0].currency', 'entries[0].amountMinor', 'entries[0].sourceUrl'] });
    expect(validateCatalog(null).ok).toBe(false);
    expect(validateCatalog({ schemaVersion: 2, entries: [] }).ok).toBe(false);
  });
  it('resolves by region, falls back to region-neutral, and reports gaps', () => {
    expect(resolvePrice(catalog, { provider: 'claude', planId: 'pro', region: 'US', at: W0 })).toMatchObject({ ok: true, source: 'catalog' });
    expect(resolvePrice(catalog, { provider: 'chatgpt', planId: 'plus', region: 'DE', at: W0 })).toMatchObject({ ok: true });
    expect(resolvePrice(catalog, { provider: 'claude', planId: 'pro', region: 'DE', at: W0 })).toEqual({ ok: false, reason: 'no_price' });
    expect(resolvePrice(catalog, { provider: 'claude', planId: 'pro', region: 'US', at: Date.UTC(2025, 0, 1) })).toEqual({ ok: false, reason: 'no_price' });
    const dup = { ...catalog, entries: [catalog.entries[0], { ...catalog.entries[0], amountMinor: 2100 }] };
    expect(resolvePrice(dup, { provider: 'claude', planId: 'pro', region: 'US', at: W0 })).toEqual({ ok: false, reason: 'ambiguous' });
  });
  it('lets a manual override win', () => {
    const r = resolvePrice(catalog, { provider: 'claude', planId: 'pro', region: 'US', at: W0 }, [{ provider: 'claude', planId: 'pro', currency: 'USD', amountMinor: 1500, billing: 'monthly', taxTreatment: 'included' }]);
    expect(r).toMatchObject({ ok: true, source: 'override', entry: { amountMinor: 1500 } });
  });
  it('honours effectiveTo as exclusive', () => {
    const c = { ...catalog, entries: [{ ...catalog.entries[0], effectiveTo: W0 }] };
    expect(resolvePrice(c, { provider: 'claude', planId: 'pro', region: 'US', at: W0 }).ok).toBe(false);
    expect(resolvePrice(c, { provider: 'claude', planId: 'pro', region: 'US', at: W0 - 1 }).ok).toBe(true);
  });
});

describe('plan cost', () => {
  const period = { start: W0, end: W1, region: 'US' };
  it('prorates a plan change inside the week and keeps currencies apart', () => {
    const cost = planCost(catalog, [
      { provider: 'claude', accountAlias: 'work', planId: 'pro', from: W0 - 30 * DAY },
      { provider: 'claude', accountAlias: 'work', planId: 'max', from: W0 + 3 * DAY },
      { provider: 'chatgpt', accountAlias: 'me', planId: 'plus', from: W0 - DAY },
    ], period);
    const pro = Math.round(((2000 * 12) / 365) * 3), max = Math.round(((10000 * 12) / 365) * 4);
    expect(cost.byCurrency).toEqual({ USD: pro + max, EUR: Math.round(((2200 * 12) / 365) * 7) });
    expect(cost.lines.map(l => l.days)).toEqual([3, 4, 7]);
    expect(cost.missing).toEqual([]);
  });
  it('prorates annual plans and ignores plans that start after the period', () => {
    const cost = planCost(catalog, [
      { provider: 'gemini', accountAlias: 'a', planId: 'adv', from: W0 - DAY },
      { provider: 'claude', accountAlias: 'work', planId: 'pro', from: W1 },
    ], period);
    expect(cost.byCurrency).toEqual({ USD: 700 });
    expect(cost.lines).toHaveLength(1);
    expect(cost.taxMixed).toBe(false);
  });
  it('lists plans with no price instead of guessing', () => {
    const cost = planCost(catalog, [{ provider: 'claude', accountAlias: 'work', planId: 'team', from: W0 - DAY }], period);
    expect(cost.missing).toEqual([{ provider: 'claude', accountAlias: 'work', planId: 'team', reason: 'no_price' }]);
    expect(cost.byCurrency).toEqual({});
  });
  it('surfaces plan changes, mixed currencies and mixed tax in the metric', () => {
    const m = computePeriodMetrics([], opts({
      region: 'US', catalog,
      planHistory: [
        { provider: 'claude', accountAlias: 'work', planId: 'pro', from: W0 - DAY },
        { provider: 'claude', accountAlias: 'work', planId: 'max', from: W0 + 2 * DAY },
        { provider: 'chatgpt', accountAlias: 'me', planId: 'plus', from: W0 - DAY },
      ],
    }));
    expect(m.subscriptionCost.status).toBe('estimated');
    expect(m.subscriptionCost.value?.planChanges).toBe(1);
    expect(m.subscriptionCost.reasons).toEqual(['mixed_tax_treatment', 'multiple_currencies_not_summed']);
  });
  it('is unavailable without history or without any resolvable price', () => {
    expect(computePeriodMetrics([], opts({ catalog })).subscriptionCost.reasons).toEqual(['needs_plan_history']);
    const m = computePeriodMetrics([], opts({ catalog, region: 'US', planHistory: [{ provider: 'claude', accountAlias: 'w', planId: 'team', from: W0 - DAY }] }));
    expect(m.subscriptionCost).toMatchObject({ status: 'unavailable', reasons: ['missing_price'] });
  });
});

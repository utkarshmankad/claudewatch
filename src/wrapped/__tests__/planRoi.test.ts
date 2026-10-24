import { describe, expect, it } from 'vitest';
import { append } from '../../ledger/ledger.js';
import type { LedgerInput, LedgerRecord, Provider } from '../../ledger/types.js';
import { comparePlans, planRoiLogLine, renderExplanation, type PlanRoiInput, type Subscription } from '../planRoi.js';
import type { PlanChange, PricingCatalog } from '../pricing.js';

// All prices below are test fixtures. The shipped catalog contains none.
const DAY = 86_400_000, HOUR = 3_600_000;
const P0 = Date.UTC(2026, 9, 1); // 30-day period
const P1 = P0 + 30 * DAY;
const DEV = 'a1b2c3d4e5f60718';

const snap = (provider: Provider, alias: string, at: number, pct: number, resetAt: number): LedgerInput => ({
  schemaVersion: 1, kind: 'provider_snapshot', provider, accountAlias: alias, devicePseudonym: DEV, observedAt: at, ingestedAt: at + 1000,
  source: 'web', confidence: 'high', measurementMethod: 'provider_reported', measures: { quotaPercentUsed: pct }, window: { type: 'five_hour', resetAt },
});
// One window per day with peak `peakOf(day)`.
function windows(provider: Provider, alias: string, from: number, days: number, peakOf: (d: number) => number): LedgerInput[] {
  const out: LedgerInput[] = [];
  for (let d = 0; d < days; d++) {
    const t = from + d * DAY;
    out.push(snap(provider, alias, t + HOUR, Math.max(1, peakOf(d) / 2), t + 5 * HOUR), snap(provider, alias, t + 3 * HOUR, peakOf(d), t + 5 * HOUR));
  }
  return out;
}
const ledger = (xs: LedgerInput[]): LedgerRecord[] => { const r = append([], xs); expect(r.rejected).toEqual([]); return r.records; };

const entry = (provider: Provider, planId: string, amountMinor: number, o: object = {}) => ({ provider, planId, currency: 'USD', region: 'US', amountMinor, billing: 'monthly' as const, taxTreatment: 'excluded' as const, sourceUrl: 'https://example.com/p', effectiveFrom: Date.UTC(2026, 0, 1), ...o });
const catalog: PricingCatalog = { schemaVersion: 1, entries: [
  entry('claude', 'mid', 3650), entry('claude', 'small', 1825), entry('claude', 'big', 18250),
  entry('chatgpt', 'yearly', 36500, { billing: 'annual' }), entry('chatgpt', 'yearly-small', 18250, { billing: 'annual' }),
  entry('gemini', 'eur-plan', 2000, { currency: 'EUR', region: 'ZZ' }),
] };
const sub = (provider: Provider, alias: string, context: 'personal' | 'work' = 'personal'): Subscription => ({ provider, accountAlias: alias, context });
const hist = (provider: Provider, alias: string, planId: string, from = P0 - 60 * DAY): PlanChange => ({ provider, accountAlias: alias, planId, from });

const base = (o: Partial<PlanRoiInput>): PlanRoiInput => ({
  records: [], period: { start: P0, end: P1 }, now: P1 + HOUR, region: 'US', catalog, subscriptions: [], planHistory: [], ...o,
});
const keyC = 'claude|a';

describe('underuse', () => {
  const recs = ledger(windows('claude', 'a', P0, 30, () => 20));
  const r = comparePlans(base({
    records: recs, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'mid')],
    candidates: { [keyC]: { lower: { planId: 'small', relativeCapacity: 0.5 }, higher: { planId: 'big', relativeCapacity: 5 }, none: { relativeCapacity: 0.1 } } },
  }));
  const a = r.accounts[0];
  it('reconstructs the current cost from price and days', () => {
    expect(a.evidence.sufficient).toBe(true);
    expect(a.evidence.days).toBe(30);
    expect(a.scenarios[0].costMinor).toBeCloseTo((3650 * 12 / 365) * 30, 1);
    expect(a.scenarios[0].price?.sourceUrl).toBe('https://example.com/p');
    expect(a.scenarios[0].price?.region).toBe('US');
  });
  it('finds the lower plan favourable without needing a value, and the higher plan unfavourable', () => {
    const low = a.scenarios.find(s => s.kind === 'lower')!;
    expect(low.blockedWindows).toEqual({ low: 0, high: 0 });
    expect(low.netBenefitMinor!.low).toBeGreaterThan(0);
    expect(low.verdict).toBe('favourable');
    const hi = a.scenarios.find(s => s.kind === 'higher')!;
    expect(hi.verdict).toBe('unfavourable'); // nothing was blocked, so there is nothing for a larger plan to avoid
    expect(hi.netBenefitMinor!.high!).toBeLessThan(0);
    expect(a.recommendation.scenario).toBe('lower');
  });
  it('higher plan is unfavourable when a value is entered and nothing was blocked', () => {
    const v = comparePlans(base({ records: recs, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'mid')], candidates: { [keyC]: { higher: { planId: 'big', relativeCapacity: 5 } } }, interruptionValue: { personal: { currency: 'USD', valueMinor: 5000 } } }));
    expect(v.accounts[0].scenarios.find(s => s.kind === 'higher')!.verdict).toBe('unfavourable');
  });
  it('no-subscription needs the capacity assumption', () => {
    expect(a.scenarios.find(s => s.kind === 'none')!.costMinor).toBe(0);
    const noRatio = comparePlans(base({ records: recs, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'mid')], candidates: { [keyC]: { none: {} } } }));
    expect(noRatio.accounts[0].scenarios.find(s => s.kind === 'none')!.reasons).toContain('capacity_ratio_missing');
    expect(noRatio.accounts[0].recommendation.verdict).toBe('insufficient_evidence');
  });
  it('never claims guaranteed savings', () => {
    const text = renderExplanation(r) + JSON.stringify(r);
    expect(r.disclaimer).toMatch(/not guaranteed savings/i);
    expect(a.recommendation.text).toMatch(/not a guarantee/i);
    expect(text).not.toMatch(/you will save|guaranteed to/i);
  });
});

describe('repeated blocking', () => {
  const recs = ledger(windows('claude', 'a', P0, 30, d => (d % 2 === 0 ? 100 : 60)));
  const inp = (value?: number) => base({
    records: recs, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'mid')],
    candidates: { [keyC]: { lower: { planId: 'small', relativeCapacity: 0.5 }, higher: { planId: 'big', relativeCapacity: 5 } } },
    interruptionValue: value === undefined ? undefined : { personal: { currency: 'USD', valueMinor: value } },
  });
  it('counts blocked windows and prices the higher plan with a range over cut-off windows', () => {
    const a = comparePlans(inp(2000)).accounts[0];
    expect(a.evidence.blockedWindows).toBe(15);
    const hi = a.scenarios.find(s => s.kind === 'higher')!;
    expect(hi.blockedWindows).toEqual({ low: 0, high: 15 });
    const extra = ((18250 - 3650) * 12 / 365) * 30;
    // fewer blocked windows is the benefit: worst case none avoided, best case all 15 avoided
    expect(hi.netBenefitMinor!.low).toBeCloseTo(-extra, 1);
    expect(hi.netBenefitMinor!.high).toBeCloseTo(-extra + 15 * 2000, 1);
    expect(hi.verdict).toBe('inconclusive');
  });
  it('a high value still does not make the higher plan favourable in every case', () => {
    const hi = comparePlans(inp(1_000_000)).accounts[0].scenarios.find(s => s.kind === 'higher')!;
    expect(hi.verdict).toBe('inconclusive'); // low bound assumes no windows avoided
  });
  it('without a value the avoided interruptions are not priced and the verdict stays inconclusive', () => {
    const hi = comparePlans(inp()).accounts[0].scenarios.find(s => s.kind === 'higher')!;
    expect(hi.verdict).toBe('inconclusive');
    expect(hi.netBenefitMinor!.high).toBeNull();
    expect(hi.netBenefitMinor!.low).toBeLessThan(0);
    expect(hi.steps.find(x => x.id === 'net_benefit')!.label).toMatch(/not entered/);
  });
  it('lower plan adds blocking and is unfavourable', () => {
    const lo = comparePlans(inp(2000)).accounts[0].scenarios.find(s => s.kind === 'lower')!;
    expect(lo.blockedWindows).toEqual({ low: 30, high: 30 }); // 60% at half capacity is 120%
    expect(lo.verdict).toBe('unfavourable');
  });
});

describe('multiple subscriptions and mixed personal/work accounts', () => {
  const recs = ledger([
    ...windows('claude', 'a', P0, 30, () => 20),
    ...windows('claude', 'w', P0, 30, () => 100),
    ...windows('chatgpt', 'p', P0, 30, () => 30),
  ]);
  const r = comparePlans(base({
    records: recs, subscriptions: [sub('claude', 'a'), sub('claude', 'w', 'work'), sub('chatgpt', 'p')],
    planHistory: [hist('claude', 'a', 'mid'), hist('claude', 'w', 'mid'), hist('chatgpt', 'p', 'yearly')],
    candidates: { 'claude|w': { higher: { planId: 'big', relativeCapacity: 5 } } },
    interruptionValue: { work: { currency: 'USD', valueMinor: 100_000 } },
  }));
  it('evaluates each account independently', () => {
    expect(r.accounts.map(a => `${a.accountAlias}:${a.context}`)).toEqual(['a:personal', 'w:work', 'p:personal']);
    expect(r.accounts[1].evidence.blockedWindows).toBe(30);
    expect(r.accounts[0].evidence.blockedWindows).toBe(0);
  });
  it('keeps totals separate by context and does not use a personal value for work', () => {
    expect(r.totals.map(t => `${t.context}:${t.currency}:${t.accounts}`).sort()).toEqual(['personal:USD:2', 'work:USD:1']);
    const personalOnly = comparePlans(base({ records: recs, subscriptions: [sub('claude', 'w', 'work')], planHistory: [hist('claude', 'w', 'mid')], candidates: { 'claude|w': { higher: { planId: 'big', relativeCapacity: 5 } } }, interruptionValue: { personal: { currency: 'USD', valueMinor: 100_000 } } }));
    const hi = personalOnly.accounts[0].scenarios.find(s => s.kind === 'higher')!;
    expect(hi.netBenefitMinor!.high).toBeNull(); // the personal value was not applied to the work account
    expect(hi.verdict).toBe('inconclusive');
    expect(r.accounts[1].caveats).toContain('work_account_payer_and_value_may_differ_from_personal');
  });
  it('does not mix currencies in totals or values', () => {
    const mixed = comparePlans(base({
      records: ledger([...windows('claude', 'a', P0, 30, () => 20), ...windows('gemini', 'g', P0, 30, () => 20)]),
      subscriptions: [sub('claude', 'a'), sub('gemini', 'g')], planHistory: [hist('claude', 'a', 'mid'), hist('gemini', 'g', 'eur-plan')],
    }));
    expect(mixed.totals.map(t => t.currency).sort()).toEqual(['EUR', 'USD']);
    const mismatch = comparePlans(base({
      records: recs, subscriptions: [sub('claude', 'w', 'work')], planHistory: [hist('claude', 'w', 'mid')],
      candidates: { 'claude|w': { higher: { planId: 'big', relativeCapacity: 5 } } }, interruptionValue: { work: { currency: 'EUR', valueMinor: 5000 } },
    }));
    expect(mismatch.accounts[0].scenarios.find(s => s.kind === 'higher')!.reasons).toContain('value_currency_differs_from_price');
  });
});

describe('annual plans', () => {
  const recs = ledger(windows('chatgpt', 'p', P0, 30, () => 20));
  const r = comparePlans(base({
    records: recs, subscriptions: [sub('chatgpt', 'p')], planHistory: [hist('chatgpt', 'p', 'yearly')],
    candidates: { 'chatgpt|p': { lower: { planId: 'yearly-small', relativeCapacity: 0.5 } } },
  }));
  it('allocates annual price per day and warns about commitment', () => {
    const a = r.accounts[0];
    expect(a.scenarios[0].costMinor).toBe(3000);
    expect(a.caveats).toContain('annual_plan_switch_may_not_be_refundable_before_renewal');
    expect(a.assumptions.join(' ')).toMatch(/not a payment schedule/);
  });
});

describe('mid-cycle plan changes', () => {
  const change = P0 + 10 * DAY;
  const recs = ledger(windows('claude', 'a', P0, 30, d => (d < 10 ? 100 : 20)));
  const history = [hist('claude', 'a', 'small'), { provider: 'claude' as const, accountAlias: 'a', planId: 'mid', from: change }];
  it('uses only evidence after the latest change', () => {
    const a = comparePlans(base({ records: recs, subscriptions: [sub('claude', 'a')], planHistory: history })).accounts[0];
    expect(a.currentPlanId).toBe('mid');
    expect(a.evidence.start).toBe(change);
    expect(a.evidence.blockedWindows).toBe(0); // earlier blocking belongs to the previous plan
    expect(a.evidence.days).toBe(20);
    expect(a.evidence.planChangeInInterval).toBe(true);
    expect(a.caveats).toContain('plan_changed_in_period_evidence_starts_at_latest_change');
  });
  it('is insufficient when the change was recent', () => {
    const late = comparePlans(base({ records: recs, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'small'), { provider: 'claude', accountAlias: 'a', planId: 'mid', from: P0 + 25 * DAY }] }));
    expect(late.accounts[0].evidence.reasons).toContain('too_few_days_since_plan_change');
    expect(late.accounts[0].recommendation.verdict).toBe('insufficient_evidence');
  });
});

describe('missing pricing and thin evidence', () => {
  const recs = ledger(windows('claude', 'a', P0, 30, () => 20));
  it('missing current price is insufficient, not zero', () => {
    const r = comparePlans(base({ records: recs, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'unlisted')] }));
    const a = r.accounts[0];
    expect(a.scenarios[0].costMinor).toBeNull();
    expect(a.scenarios[0].reasons).toContain('missing_price');
    expect(a.recommendation.verdict).toBe('insufficient_evidence');
    expect(r.totals).toEqual([]);
  });
  it('missing candidate price is reported on that scenario only', () => {
    const r = comparePlans(base({ records: recs, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'mid')], candidates: { [keyC]: { lower: { planId: 'unlisted', relativeCapacity: 0.5 }, higher: { planId: 'big', relativeCapacity: 5 } } }, interruptionValue: { personal: { currency: 'USD', valueMinor: 100 } } }));
    expect(r.accounts[0].scenarios.find(s => s.kind === 'lower')!.reasons).toContain('missing_price');
    expect(r.accounts[0].scenarios.find(s => s.kind === 'higher')!.status).toBe('ok');
  });
  it('an empty catalog yields no prices (nothing is invented)', () => {
    const r = comparePlans(base({ catalog: { schemaVersion: 1, entries: [] }, records: recs, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'mid')] }));
    expect(r.accounts[0].scenarios[0].price).toBeNull();
    expect(r.accounts[0].scenarios[0].costMinor).toBeNull();
    expect(r.accounts[0].recommendation.verdict).toBe('insufficient_evidence');
  });
  it('a manual override supplies a labelled price', () => {
    const r = comparePlans(base({ catalog: { schemaVersion: 1, entries: [] }, records: recs, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'mid')], overrides: [{ provider: 'claude', planId: 'mid', currency: 'USD', amountMinor: 1000, billing: 'monthly', taxTreatment: 'unknown' }] }));
    expect(r.accounts[0].scenarios[0].price?.source).toBe('override');
  });
  it('too few days or windows says so', () => {
    const few = ledger(windows('claude', 'a', P0, 3, () => 20));
    const a = comparePlans(base({ records: few, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'mid')], now: P0 + 3 * DAY })).accounts[0];
    expect(a.evidence.reasons).toEqual(expect.arrayContaining(['too_few_days', 'too_few_windows']));
    expect(a.recommendation.text).toMatch(/Not enough evidence/);
  });
  it('sparse coverage is insufficient', () => {
    const sparse = ledger(windows('claude', 'a', P0, 6, () => 20).concat(windows('claude', 'a', P0 + 29 * DAY, 1, () => 20)));
    const a = comparePlans(base({ records: sparse, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'mid')], minWindows: 1 })).accounts[0];
    expect(a.evidence.reasons).toContain('sparse_data');
  });
  it('no plan history is insufficient', () => {
    expect(comparePlans(base({ records: recs, subscriptions: [sub('claude', 'a')] })).accounts[0].evidence.reasons).toContain('no_plan_history');
  });
  it('missing capacity ratio makes an alternative insufficient', () => {
    const r = comparePlans(base({ records: recs, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'mid')], candidates: { [keyC]: { lower: { planId: 'small' } } } }));
    expect(r.accounts[0].scenarios.find(s => s.kind === 'lower')!.reasons).toContain('capacity_ratio_missing');
  });
});

describe('explanation and observability', () => {
  const recs = ledger(windows('claude', 'a', P0, 30, d => (d % 2 === 0 ? 100 : 60)));
  const input = base({
    records: recs, subscriptions: [sub('claude', 'a')], planHistory: [hist('claude', 'a', 'mid')],
    candidates: { [keyC]: { higher: { planId: 'big', relativeCapacity: 5 } } }, interruptionValue: { personal: { currency: 'USD', valueMinor: 2000 } },
  });
  const r = comparePlans(input);
  it('shows region, currency, effective date, source, coverage, assumptions and every step', () => {
    const t = renderExplanation(r);
    for (const s of ['region US', 'USD', 'effective 2026-01-01', 'https://example.com/p', 'Coverage:', 'Assumptions:', '[daily_cost]', '[interval_cost]', '[blocked_windows]', '[net_benefit]', 'net benefit range']) expect(t).toContain(s);
    for (const sc of r.accounts[0].scenarios) for (const st of sc.steps) expect(t).toContain(`[${st.id}]`);
  });
  it('log line has counts only', () => {
    const line = planRoiLogLine(r);
    expect(line).toMatch(/^\[plan-roi\] v=1 accounts=1 /);
    expect(line).not.toContain('claude');
    expect(line).not.toMatch(/\d{4,}/);
  });
  it('is deterministic', () => {
    expect(JSON.stringify(comparePlans(input))).toBe(JSON.stringify(r));
  });
});

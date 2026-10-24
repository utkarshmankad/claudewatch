// Transparent plan comparison (Prompt 5.4, operation key 2026-10-10.1/prompt-5.4). See docs/PLAN_ROI.md.
// Pure: reads ledger records and user-entered inputs, writes nothing, calls no network.
// Every figure carries the steps that produced it; nothing is a guaranteed saving.
import { segments } from '../ledger/ledger.js';
import type { LedgerRecord, Provider } from '../ledger/types.js';
import { dailyCostMinor, resolvePrice, type ManualOverride, type PlanChange, type PricingCatalog, type PriceEntry } from './pricing.js';

export const PLAN_ROI_VERSION = 1;
const DAY = 86_400_000;

// Adjustable starting points, not measured targets.
export const DEFAULT_MIN_EVIDENCE_DAYS = 14;
export const DEFAULT_MIN_WINDOWS = 10;
export const DEFAULT_MIN_DAY_COVERAGE = 0.7;
export const DEFAULT_PEAK_SLACK_POINTS = 10;

export type AccountContext = 'personal' | 'work';
export type ScenarioKind = 'current' | 'lower' | 'higher' | 'none';
export type Verdict = 'favourable' | 'unfavourable' | 'inconclusive' | 'insufficient_evidence';

export interface Subscription { provider: Provider; accountAlias: string; context: AccountContext }
// A candidate plan is user-supplied: the catalog carries prices only, never capacity. relativeCapacity is the
// candidate's quota divided by the current plan's quota (0.5 = half). Absent means unknown.
export interface Candidate { planId: string; relativeCapacity?: number }
export interface AccountCandidates { lower?: Candidate; higher?: Candidate; none?: { relativeCapacity?: number } }
export interface InterruptionValue { currency: string; valueMinor: number } // per interruption, entered by the user

export interface PlanRoiInput {
  records: LedgerRecord[];
  period: { start: number; end: number };
  now: number;
  region: string;
  catalog: PricingCatalog;
  subscriptions: Subscription[];
  planHistory: PlanChange[];
  candidates?: Record<string, AccountCandidates>; // key: `${provider}|${accountAlias}`
  interruptionValue?: Partial<Record<AccountContext, InterruptionValue>>;
  overrides?: ManualOverride[];
  minEvidenceDays?: number;
  minWindows?: number;
  minDayCoverage?: number;
  peakSlackPoints?: number;
}

export interface Step { id: string; label: string; formula: string; inputs: Record<string, number | string | null>; result: number | string | null; unit: string }
export interface Range { low: number; high: number | null } // high null = open ended

export interface PriceFacts { planId: string; currency: string; region: string; amountMinor: number; billing: 'monthly' | 'annual'; taxTreatment: string; sourceUrl: string; effectiveFrom: number; effectiveTo: number | null; source: 'catalog' | 'override' }

export interface ScenarioResult {
  kind: ScenarioKind;
  planId: string | null;
  price: PriceFacts | null;
  status: 'ok' | 'insufficient';
  reasons: string[];
  costMinor: number | null; // allocated over the evidence interval, an estimate
  blockedWindows: Range | null; // windows that would have hit 100%
  verdict: Verdict;
  netBenefitMinor: Range | null; // vs current; positive favours this scenario
  steps: Step[];
}

export interface Evidence {
  start: number; end: number; days: number; dayCoverage: number; windows: number; blockedWindows: number;
  meanPeakPercent: number | null; meanResetUtilizationPercent: number | null; meanUnusedPercent: number | null; resetWindows: number;
  planChangeInInterval: boolean; sufficient: boolean; reasons: string[];
}

export interface AccountComparison {
  provider: Provider; accountAlias: string; context: AccountContext;
  currentPlanId: string | null;
  evidence: Evidence;
  scenarios: ScenarioResult[];
  recommendation: { verdict: Verdict; scenario: ScenarioKind | null; text: string };
  assumptions: string[];
  caveats: string[];
}

export interface PlanRoiResult {
  version: number;
  period: { start: number; end: number };
  region: string;
  accounts: AccountComparison[];
  // Current-plan cost per context and currency over each account's evidence interval. Never converted or merged.
  totals: Array<{ context: AccountContext; currency: string; currentCostMinor: number; accounts: number }>;
  disclaimer: string;
}

export const DISCLAIMER = 'Estimates from your own recorded usage and the prices and values you supplied. Not a quote, not a prediction and not guaranteed savings.';

const r2 = (n: number) => Math.round(n * 100) / 100;
const keyOf = (s: { provider: string; accountAlias: string }) => `${s.provider}|${s.accountAlias}`;
const priceFacts = (e: PriceEntry, source: 'catalog' | 'override'): PriceFacts => ({ planId: e.planId, currency: e.currency, region: e.region, amountMinor: e.amountMinor, billing: e.billing, taxTreatment: e.taxTreatment, sourceUrl: e.sourceUrl, effectiveFrom: e.effectiveFrom, effectiveTo: e.effectiveTo ?? null, source });

// The plan a given account was on at `at`, from the user's plan history.
function planAt(history: PlanChange[], s: Subscription, at: number): PlanChange | null {
  const list = history.filter(h => h.provider === s.provider && h.accountAlias === s.accountAlias).sort((a, b) => a.from - b.from);
  let cur: PlanChange | null = null;
  for (const h of list) if (h.from <= at) cur = h;
  return cur;
}

function windowPeaks(records: LedgerRecord[], s: Subscription, start: number, end: number) {
  const peaks: Array<{ peak: number; last: number; reset: boolean }> = [];
  const segs = segments(records.filter(r => r.effectiveObservedAt < end)).filter(x => keyOf(x) === keyOf(s));
  segs.forEach((seg, i) => {
    const pts = seg.points.filter(p => p.at >= start && p.at < end);
    if (!pts.length) return;
    const sameWindowLater = segs.slice(i + 1).some(n => n.window === seg.window);
    peaks.push({ peak: Math.max(...pts.map(p => p.percent)), last: pts[pts.length - 1].percent, reset: sameWindowLater });
  });
  return { peaks, snapshotDays: new Set(records.filter(r => r.kind === 'provider_snapshot' && keyOf(r) === keyOf(s) && r.effectiveObservedAt >= start && r.effectiveObservedAt < end).map(r => Math.floor((r.effectiveObservedAt - start) / DAY))).size };
}

export function comparePlans(input: PlanRoiInput): PlanRoiResult {
  const minDays = input.minEvidenceDays ?? DEFAULT_MIN_EVIDENCE_DAYS;
  const minWindows = input.minWindows ?? DEFAULT_MIN_WINDOWS;
  const minCov = input.minDayCoverage ?? DEFAULT_MIN_DAY_COVERAGE;
  const slack = input.peakSlackPoints ?? DEFAULT_PEAK_SLACK_POINTS;
  const periodEnd = Math.min(input.period.end, input.now);
  const accounts: AccountComparison[] = input.subscriptions.map(sub => {
    const key = keyOf(sub);
    const current = planAt(input.planHistory, sub, periodEnd - 1);
    const changes = input.planHistory.filter(h => keyOf(h) === key && h.from > input.period.start && h.from < periodEnd);
    // Evidence only counts after the latest plan change: earlier usage ran against a different quota.
    const lastChange = changes.length ? Math.max(...changes.map(c => c.from)) : null;
    const start = Math.max(input.period.start, lastChange ?? input.period.start);
    const end = periodEnd;
    const days = Math.max(0, (end - start) / DAY);
    const { peaks, snapshotDays } = windowPeaks(input.records, sub, start, end);
    const dayCoverage = days > 0 ? Math.min(1, snapshotDays / Math.max(1, Math.round(days))) : 0;
    const blocked = peaks.filter(p => p.peak >= 100).length;
    const resets = peaks.filter(p => p.reset);
    const mean = (xs: number[]) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const reasons: string[] = [];
    if (!current) reasons.push('no_plan_history');
    if (days < minDays) reasons.push(lastChange !== null ? 'too_few_days_since_plan_change' : 'too_few_days');
    if (peaks.length < minWindows) reasons.push('too_few_windows');
    if (days > 0 && dayCoverage < minCov) reasons.push('sparse_data');
    const evidence: Evidence = {
      start, end, days: r2(days), dayCoverage: r2(dayCoverage), windows: peaks.length, blockedWindows: blocked,
      meanPeakPercent: mean(peaks.map(p => p.peak)), meanResetUtilizationPercent: mean(resets.map(p => p.last)), meanUnusedPercent: mean(resets.map(p => 100 - p.last)), resetWindows: resets.length,
      planChangeInInterval: lastChange !== null, sufficient: reasons.length === 0, reasons,
    };

    const assumptions = [
      `Costs are the catalog or override price allocated per day over the evidence interval (monthly x 12 / 365, annual / 365). This is an allocation, not a payment schedule.`,
      `One window that reached 100% counts as one interruption. Windows of different lengths are counted alike.`,
      `Demand scales with plan capacity: a window with peak p on the current plan would peak at p / relativeCapacity on a candidate with that capacity.`,
      `Observed peaks are lower bounds on true peaks; for plans with less capacity each peak may be up to ${slack} points higher (adjustable assumption, not measured).`,
      `A window that reached 100% was cut off, so its true demand is unknown. Whether a larger plan would have avoided it is unknown; the range runs from none to all of them.`,
      `Capacity ratios and the value of an avoided interruption are entered by you. The pricing catalog ships no capacity data or values.`,
    ];
    const caveats: string[] = [];
    if (current && changes.length) caveats.push('plan_changed_in_period_evidence_starts_at_latest_change');
    const cand = input.candidates?.[key] ?? {};
    const value = input.interruptionValue?.[sub.context];
    if (sub.context === 'work') caveats.push('work_account_payer_and_value_may_differ_from_personal');

    const at = Math.max(start, end - 1);
    const dayCount = days;
    const costOf = (planId: string, provider: Provider): { facts: PriceFacts | null; cost: number | null; reason?: string; steps: Step[] } => {
      const r = resolvePrice(input.catalog, { provider, planId, region: input.region, at }, input.overrides);
      if (!r.ok) return { facts: null, cost: null, reason: r.reason === 'no_price' ? 'missing_price' : 'ambiguous_price', steps: [] };
      const daily = dailyCostMinor(r.entry);
      const cost = daily * dayCount;
      return {
        facts: priceFacts(r.entry, r.source), cost,
        steps: [
          { id: 'daily_cost', label: `Daily cost of ${planId}`, formula: r.entry.billing === 'monthly' ? 'amountMinor x 12 / 365' : 'amountMinor / 365', inputs: { amountMinor: r.entry.amountMinor, billing: r.entry.billing }, result: daily, unit: `${r.entry.currency} minor/day` },
          { id: 'interval_cost', label: `Cost of ${planId} over the evidence interval`, formula: 'daily cost x evidence days', inputs: { dailyCost: daily, evidenceDays: r2(dayCount) }, result: cost, unit: `${r.entry.currency} minor` },
        ],
      };
    };
    const currentCost = current ? costOf(current.planId, sub.provider) : null;
    if (current && currentCost?.reason) evidence.reasons.push(`current_${currentCost.reason}`);
    const currentBlocked: Range = { low: blocked, high: blocked };
    if (current && !currentCost?.facts) { evidence.sufficient = false; }
    if (current && currentCost?.facts && current.planId && currentCost.facts.billing === 'annual') caveats.push('annual_plan_switch_may_not_be_refundable_before_renewal');

    const scenarios: ScenarioResult[] = [];
    const base = (kind: ScenarioKind, planId: string | null): ScenarioResult => ({ kind, planId, price: null, status: 'insufficient', reasons: [], costMinor: null, blockedWindows: null, verdict: 'insufficient_evidence', netBenefitMinor: null, steps: [] });

    // Current scenario
    const cs = base('current', current?.planId ?? null);
    if (currentCost?.facts) { cs.price = currentCost.facts; cs.costMinor = r2(currentCost.cost as number); cs.steps.push(...currentCost.steps); }
    else cs.reasons.push(current ? (currentCost?.reason ?? 'missing_price') : 'no_plan_history');
    cs.blockedWindows = peaks.length ? currentBlocked : null;
    cs.steps.push({ id: 'blocked_windows', label: 'Windows that reached 100% (observed)', formula: 'count of windows with peak >= 100', inputs: { windows: peaks.length }, result: blocked, unit: 'windows' });
    if (!evidence.sufficient) cs.reasons.push(...evidence.reasons);
    cs.status = cs.price && cs.costMinor !== null ? 'ok' : 'insufficient';
    cs.verdict = evidence.sufficient && cs.status === 'ok' ? 'inconclusive' : 'insufficient_evidence';
    scenarios.push(cs);

    const buildAlt = (kind: Exclude<ScenarioKind, 'current'>, planId: string | null, ratio: number | undefined): ScenarioResult => {
      const s = base(kind, planId);
      if (!evidence.sufficient) s.reasons.push(...evidence.reasons);
      if (cs.status !== 'ok' || cs.costMinor === null) s.reasons.push('current_cost_unknown');
      let cost: number | null = 0;
      if (kind === 'none') { s.price = null; s.steps.push({ id: 'no_subscription_cost', label: 'No subscription: plan cost', formula: 'no plan, no price', inputs: {}, result: 0, unit: 'minor' }); }
      else if (!planId) s.reasons.push('candidate_not_supplied');
      else {
        const c = costOf(planId, sub.provider);
        if (c.reason || !c.facts) { s.reasons.push(c.reason ?? 'missing_price'); cost = null; }
        else { s.price = c.facts; cost = c.cost; s.steps.push(...c.steps); }
      }
      if (kind !== 'none' && !planId) cost = null;
      if (ratio === undefined) s.reasons.push('capacity_ratio_missing');
      else if (!(ratio > 0)) s.reasons.push('capacity_ratio_invalid');
      if (cs.price && s.price && cs.price.currency !== s.price.currency) s.reasons.push('currency_differs_from_current');
      s.costMinor = cost === null ? null : r2(cost);
      if (s.reasons.length) return s;
      const k = ratio as number;
      const sureBlocked = peaks.filter(p => (p.peak >= 100 ? (k <= 1 ? true : false) : p.peak / k >= 100)).length;
      let blk: Range;
      if (k <= 1) {
        const possible = peaks.filter(p => p.peak >= 100 || (p.peak + slack) / k >= 100).length;
        blk = { low: sureBlocked, high: possible };
        s.steps.push({ id: 'blocked_windows', label: 'Windows that would reach 100% with less capacity', formula: `low: peak >= 100 or peak / ratio >= 100; high: same with peak + ${slack} points`, inputs: { relativeCapacity: k, slackPoints: slack, windows: peaks.length }, result: `${blk.low}..${blk.high}`, unit: 'windows' });
      } else {
        // Windows already cut off at 100% might or might not be avoided; others stay unblocked unless demand grows, which is not assumed.
        const stillMaybe = peaks.filter(p => p.peak >= 100).length;
        blk = { low: 0, high: stillMaybe };
        s.steps.push({ id: 'blocked_windows', label: 'Windows that would still reach 100% with more capacity', formula: 'low: 0 (all cut-off windows avoided); high: windows already at 100% (none avoided)', inputs: { relativeCapacity: k, cutOffWindows: stillMaybe }, result: `${blk.low}..${blk.high}`, unit: 'windows' });
      }
      s.blockedWindows = blk;
      s.status = cost === null ? 'insufficient' : 'ok';
      // Net benefit vs current = saved cost - change in interruption cost. Positive favours this scenario.
      const dCost = (cost as number) - (cs.costMinor as number);
      const chg: Range = { low: blk.low - blocked, high: (blk.high as number) - blocked }; // change in blocked windows
      const v = value && value.currency === cs.price?.currency ? value.valueMinor : undefined;
      if (value && v === undefined) { s.reasons.push('value_currency_differs_from_price'); s.status = 'insufficient'; return s; }
      let net: Range;
      if (v !== undefined) {
        net = { low: -dCost - chg.high! * v, high: -dCost - chg.low * v };
        s.steps.push({ id: 'net_benefit', label: 'Net benefit vs current', formula: '-(candidate cost - current cost) - change in blocked windows x value per interruption', inputs: { costDifference: r2(dCost), blockedChangeLow: chg.low, blockedChangeHigh: chg.high, valuePerInterruption: v }, result: `${r2(net.low)}..${r2(net.high as number)}`, unit: `${cs.price?.currency} minor` });
      } else if (chg.high! <= 0) {
        // No more blocking in any case, value not needed to see the cost side; the upside of fewer blocks is not priced.
        net = { low: -dCost, high: chg.low < 0 ? null : -dCost };
        s.steps.push({ id: 'net_benefit', label: 'Net benefit vs current (value of an interruption not entered)', formula: '-(candidate cost - current cost); fewer blocked windows are not priced', inputs: { costDifference: r2(dCost), blockedChangeLow: chg.low, blockedChangeHigh: chg.high }, result: net.high === null ? `>= ${r2(net.low)}` : r2(net.low), unit: `${cs.price?.currency} minor` });
      } else { s.reasons.push('interruption_value_missing'); s.status = 'insufficient'; return s; }
      s.netBenefitMinor = net;
      s.verdict = net.low > 0 ? 'favourable' : net.high !== null && net.high < 0 ? 'unfavourable' : 'inconclusive';
      return s;
    };
    scenarios.push(buildAlt('lower', cand.lower?.planId ?? null, cand.lower?.relativeCapacity));
    scenarios.push(buildAlt('higher', cand.higher?.planId ?? null, cand.higher?.relativeCapacity));
    scenarios.push(buildAlt('none', null, cand.none?.relativeCapacity));

    // Recommendation: only a scenario whose whole range is favourable is surfaced, and always as conditional.
    let rec: AccountComparison['recommendation'];
    const fav = scenarios.filter(x => x.kind !== 'current' && x.verdict === 'favourable' && x.netBenefitMinor).sort((a, b) => (b.netBenefitMinor!.low) - (a.netBenefitMinor!.low));
    if (!evidence.sufficient || cs.status !== 'ok') rec = { verdict: 'insufficient_evidence', scenario: null, text: `Not enough evidence to compare plans (${[...new Set([...evidence.reasons, ...cs.reasons])].join(', ')}). No change is suggested.` };
    else if (fav.length) rec = { verdict: 'favourable', scenario: fav[0].kind, text: `Under the stated assumptions the ${fav[0].kind} scenario was better than the current plan over the evidence interval in every case considered. This is an estimate from past use, not a guarantee, and future use may differ.` };
    else if (scenarios.some(x => x.kind !== 'current' && x.status === 'ok')) rec = { verdict: 'inconclusive', scenario: null, text: 'No alternative was better in every case considered. Keeping the current plan is consistent with the evidence; this is not a prediction.' };
    else rec = { verdict: 'insufficient_evidence', scenario: null, text: `No alternative could be evaluated (${[...new Set(scenarios.flatMap(x => x.reasons))].join(', ')}). Supply candidate plans, capacity ratios and an interruption value to compare.` };
    return { provider: sub.provider, accountAlias: sub.accountAlias, context: sub.context, currentPlanId: current?.planId ?? null, evidence, scenarios, recommendation: rec, assumptions, caveats };
  });

  const tot = new Map<string, { context: AccountContext; currency: string; currentCostMinor: number; accounts: number }>();
  for (const a of accounts) {
    const c = a.scenarios[0];
    if (!c.price || c.costMinor === null) continue;
    const k = `${a.context}|${c.price.currency}`;
    const t = tot.get(k) ?? { context: a.context, currency: c.price.currency, currentCostMinor: 0, accounts: 0 };
    t.currentCostMinor = r2(t.currentCostMinor + c.costMinor); t.accounts++;
    tot.set(k, t);
  }
  return { version: PLAN_ROI_VERSION, period: input.period, region: input.region, accounts, totals: [...tot.values()], disclaimer: DISCLAIMER };
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

// Explanation view: reconstructs every calculation as plain text. Aliases are shown only because the user's own
// device renders this; they are never part of the log line.
export function renderExplanation(r: PlanRoiResult): string {
  const out: string[] = [`Plan comparison (v${r.version}), ${iso(r.period.start)} to ${iso(r.period.end)}, region ${r.region}`, r.disclaimer, ''];
  for (const a of r.accounts) {
    out.push(`== ${a.provider} / ${a.accountAlias} (${a.context}), current plan: ${a.currentPlanId ?? 'unknown'}`);
    const e = a.evidence;
    out.push(`Coverage: ${iso(e.start)} to ${iso(e.end)}, ${e.days} days, day coverage ${e.dayCoverage}, ${e.windows} windows (${e.blockedWindows} reached 100%), mean peak ${e.meanPeakPercent ?? 'n/a'}%, mean unused at reset ${e.meanUnusedPercent ?? 'n/a'}% (upper bound) over ${e.resetWindows} reset windows`);
    if (!e.sufficient) out.push(`Evidence insufficient: ${e.reasons.join(', ')}`);
    for (const s of a.scenarios) {
      out.push(`-- ${s.kind}${s.planId ? ` (${s.planId})` : ''}: ${s.status}, verdict ${s.verdict}`);
      if (s.price) out.push(`   price ${s.price.amountMinor} ${s.price.currency} minor per ${s.price.billing === 'monthly' ? 'month' : 'year'}, region ${s.price.region}, tax ${s.price.taxTreatment}, effective ${iso(s.price.effectiveFrom)}${s.price.effectiveTo ? ` until ${iso(s.price.effectiveTo)}` : ''}, ${s.price.source}, ${s.price.sourceUrl}`);
      if (s.reasons.length) out.push(`   not evaluated: ${[...new Set(s.reasons)].join(', ')}`);
      for (const st of s.steps) out.push(`   [${st.id}] ${st.label}: ${st.formula}; inputs ${JSON.stringify(st.inputs)} => ${typeof st.result === 'number' ? r2(st.result) : st.result} ${st.unit}`);
      if (s.netBenefitMinor) out.push(`   net benefit range: ${r2(s.netBenefitMinor.low)} to ${s.netBenefitMinor.high === null ? 'open' : r2(s.netBenefitMinor.high)}`);
    }
    out.push(`Recommendation: ${a.recommendation.text}`);
    out.push('Assumptions:', ...a.assumptions.map(x => `  - ${x}`));
    if (a.caveats.length) out.push('Caveats:', ...a.caveats.map(x => `  - ${x}`));
    out.push('');
  }
  if (r.totals.length) out.push('Current plan cost over each evidence interval (never converted or merged across context or currency):', ...r.totals.map(t => `  ${t.context} ${t.currency}: ${t.currentCostMinor} minor across ${t.accounts} account(s)`));
  return out.join('\n');
}

// One log line, counts and verdicts only. No aliases, prices or amounts.
export function planRoiLogLine(r: PlanRoiResult): string {
  const count = (v: Verdict) => r.accounts.filter(a => a.recommendation.verdict === v).length;
  const reasons = [...new Set(r.accounts.flatMap(a => [...a.evidence.reasons, ...a.scenarios.flatMap(s => s.reasons)]))].sort();
  return `[plan-roi] v=${r.version} accounts=${r.accounts.length} favourable=${count('favourable')} inconclusive=${count('inconclusive')} insufficient=${count('insufficient_evidence')} reasons=${reasons.join(',') || '-'}`;
}

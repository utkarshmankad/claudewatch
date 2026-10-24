import { currentView, segments } from '../ledger/ledger.js';
import { reconcile, type Coverage, type ReconcileOptions } from '../ledger/reconcile.js';
import { backtest } from '../forecast/backtest.js';
import type { LedgerRecord, LedgerSource, Provider } from '../ledger/types.js';
import { METRICS_VERSION, type MetricId, type MetricStatus } from './definitions.js';
import { planCost, type ManualOverride, type PlanChange, type PlanCostResult, type PricingCatalog } from './pricing.js';

// Pure calculator for weekly and monthly metrics (Prompt 5.1, operation key 2026-10-10.1/prompt-5.1).
// Reads ledger records only; writes nothing. Definitions live in definitions.ts, rules in docs/WRAPPED_METRICS.md.

const DAY = 86_400_000;
export const DEFAULT_RISK_THRESHOLD = 80;
export const MIN_FORECAST_SAMPLES = 20;
export const DEFAULT_MIN_DAY_COVERAGE = 0.7; // adjustable default, not a measured target

export interface PeriodOptions {
  start: number; end: number; // epoch ms UTC, [start, end)
  now: number;
  riskThreshold?: number;
  minDayCoverage?: number;
  reconcile?: ReconcileOptions;
  region?: string;
  catalog?: PricingCatalog;
  planHistory?: PlanChange[];
  overrides?: ManualOverride[];
  confirmedPrevented?: number; // user-confirmed count; absent means unknown, not zero
}

export interface Metric<T> { id: MetricId; status: MetricStatus; value: T | null; reasons: string[] }
export interface Share { key: string; requests: number; share: number }
export interface Completeness { periodDays: number; elapsedDays: number; daysWithData: number; dayCoverage: number; complete: boolean; reasons: string[] }

export interface PeriodMetrics {
  metricsVersion: number;
  period: { start: number; end: number };
  completeness: Completeness;
  providerMix: Metric<Share[]>;
  clientMix: Metric<{ clients: Share[]; unattributedRequests: number }>;
  quotaRiskEvents: Metric<{ windowsAtRisk: number; windowsAtLimit: number; threshold: number }>;
  preventedInterruptions: Metric<number>;
  resetUtilization: Metric<{ meanPercent: number; windows: number }>;
  unusedQuota: Metric<{ meanPercent: number; windows: number }>;
  forecastAccuracy: Metric<{ maePoints: number; comparisons: number }>;
  attributableActivity: Metric<Record<string, { low: number; point: number; high: number }>>;
  subscriptionCost: Metric<PlanCostResult & { planChanges: number }>;
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const mk = <T>(id: MetricId, status: MetricStatus, value: T | null, reasons: string[] = []): Metric<T> => ({ id, status, value, reasons });
const unavailable = <T>(id: MetricId, ...reasons: string[]) => mk<T>(id, 'unavailable', null, reasons);

function shares(counts: Map<string, number>): Share[] {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return [...counts].map(([key, requests]) => ({ key, requests, share: r4(requests / total) })).sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));
}

function completeness(inPeriod: LedgerRecord[], o: PeriodOptions): Completeness {
  const minCov = o.minDayCoverage ?? DEFAULT_MIN_DAY_COVERAGE;
  const periodDays = Math.round((o.end - o.start) / DAY);
  const elapsedDays = Math.max(0, Math.min(o.end, o.now) - o.start) / DAY;
  const days = new Set(inPeriod.map(r => Math.floor((r.effectiveObservedAt - o.start) / DAY)));
  const dayCoverage = r4(Math.min(1, days.size / Math.max(1, periodDays)));
  const reasons: string[] = [];
  if (o.now < o.end) reasons.push('period_not_finished');
  if (dayCoverage < minCov) reasons.push('sparse_data');
  return { periodDays, elapsedDays: r4(elapsedDays), daysWithData: days.size, dayCoverage, complete: reasons.length === 0, reasons };
}

export function computePeriodMetrics(records: LedgerRecord[], o: PeriodOptions): PeriodMetrics {
  const upTo = records.filter(r => r.effectiveObservedAt < Math.min(o.end, o.now + 1));
  const inPeriod = currentView(upTo).filter(r => r.effectiveObservedAt >= o.start);
  const comp = completeness(inPeriod, o);
  const threshold = o.riskThreshold ?? DEFAULT_RISK_THRESHOLD;

  // Provider and client mix: local request counts only.
  const activity = inPeriod.filter(r => r.kind === 'local_activity');
  const counted = activity.filter(r => r.measures.requestCount !== undefined);
  const missingCounts = activity.length - counted.length;
  const byProvider = new Map<string, number>(), byClient = new Map<string, number>();
  let unattributedRequests = 0;
  for (const r of counted) {
    const n = r.measures.requestCount as number;
    byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + n);
    if (r.source === 'unattributed') unattributedRequests += n; else byClient.set(r.source, (byClient.get(r.source) ?? 0) + n);
  }
  const mixReasons = missingCounts ? ['records_without_request_count_ignored'] : [];
  const providerMix = byProvider.size && [...byProvider.values()].some(n => n > 0)
    ? mk('provider_mix', 'measured', shares(byProvider), mixReasons) : unavailable<Share[]>('provider_mix', 'no_counted_activity', ...mixReasons);
  const clientMix = byClient.size && [...byClient.values()].some(n => n > 0)
    ? mk('client_mix', 'measured', { clients: shares(byClient), unattributedRequests }, mixReasons) : unavailable<{ clients: Share[]; unattributedRequests: number }>('client_mix', 'no_attributed_activity', ...mixReasons);

  // Window-level metrics from provider snapshots.
  const segs = segments(upTo);
  const inPeriodSegs = segs.filter(s => s.points.some(p => p.at >= o.start));
  const keyOf = (s: { provider: string; accountAlias: string; window: string }) => `${s.provider}|${s.accountAlias}|${s.window}`;
  let atRisk = 0, atLimit = 0;
  for (const s of inPeriodSegs) {
    const peak = Math.max(...s.points.filter(p => p.at >= o.start).map(p => p.percent));
    if (peak >= threshold) atRisk++;
    if (peak >= 100) atLimit++;
  }
  const quotaRiskEvents = inPeriodSegs.length
    ? mk('quota_risk_events', 'provider_reported', { windowsAtRisk: atRisk, windowsAtLimit: atLimit, threshold }, ['count_may_miss_unobserved_peaks'])
    : unavailable<{ windowsAtRisk: number; windowsAtLimit: number; threshold: number }>('quota_risk_events', 'no_provider_snapshots');

  // A window "reset in the period" when a later segment for the same window began inside it.
  const finals: number[] = [];
  const lastByKey = new Map<string, number>();
  for (const s of segs) {
    const prev = lastByKey.get(keyOf(s));
    const first = s.points[0].at;
    if (prev !== undefined && first >= o.start && first < Math.min(o.end, o.now + 1)) finals.push(prev);
    lastByKey.set(keyOf(s), s.points.at(-1)!.percent);
  }
  const mean = (xs: number[]) => r4(xs.reduce((a, b) => a + b, 0) / xs.length);
  const resetUtilization = finals.length
    ? mk('reset_utilization', 'provider_reported', { meanPercent: mean(finals), windows: finals.length }, ['lower_bound'])
    : unavailable<{ meanPercent: number; windows: number }>('reset_utilization', 'no_window_reset_observed');
  const unusedQuota = finals.length
    ? mk('unused_quota', 'provider_reported', { meanPercent: mean(finals.map(f => 100 - f)), windows: finals.length }, ['upper_bound'])
    : unavailable<{ meanPercent: number; windows: number }>('unused_quota', 'no_window_reset_observed');

  // Forecast accuracy: replay inside the period only.
  const bt = backtest(inPeriod);
  const h1 = bt.horizons.filter(h => h.horizonHours === 1 && h.maeBurnPoints !== null);
  const n1 = h1.reduce((a, h) => a + h.n, 0);
  const forecastAccuracy = n1 >= MIN_FORECAST_SAMPLES
    ? mk('forecast_accuracy', 'estimated', { maePoints: r4(h1.reduce((a, h) => a + (h.maeBurnPoints as number) * h.n, 0) / n1), comparisons: n1 }, ['describes_this_period_only'])
    : unavailable<{ maePoints: number; comparisons: number }>('forecast_accuracy', 'too_few_comparisons');

  // Attribution coverage needs a calibration; without one nothing is attributed and the metric is withheld.
  const rec = reconcile(inPeriod, o.reconcile);
  const cov = Object.entries(rec.coverage).filter((e): e is [string, Coverage & { coverage: NonNullable<Coverage['coverage']> }] => e[1].coverage !== null);
  const attributableActivity = !o.reconcile?.calibration ? unavailable<Record<string, { low: number; point: number; high: number }>>('attributable_activity', 'no_calibration')
    : cov.length === 0 ? unavailable<Record<string, { low: number; point: number; high: number }>>('attributable_activity', 'no_reconciled_intervals')
    : mk('attributable_activity', 'estimated', Object.fromEntries(cov.map(([k, c]) => [k, c.coverage])), ['windows_not_summed']);

  // Prevented interruptions only from user confirmation.
  const preventedInterruptions = o.confirmedPrevented === undefined
    ? unavailable<number>('prevented_interruptions', 'needs_user_confirmation')
    : mk('prevented_interruptions', 'measured', o.confirmedPrevented, ['user_confirmed']);

  // Subscription cost needs user-entered plan history and a price.
  let subscriptionCost: Metric<PlanCostResult & { planChanges: number }>;
  if (!o.catalog || !o.planHistory?.length) subscriptionCost = unavailable('subscription_cost', 'needs_plan_history');
  else {
    const cost = planCost(o.catalog, o.planHistory, { start: o.start, end: o.end, region: o.region ?? 'ZZ' }, o.overrides);
    const reasons = [...(cost.missing.length ? ['missing_price'] : []), ...(cost.taxMixed ? ['mixed_tax_treatment'] : []), ...(Object.keys(cost.byCurrency).length > 1 ? ['multiple_currencies_not_summed'] : [])];
    const changes = cost.lines.length - new Set(cost.lines.map(l => `${l.provider}|${l.accountAlias}`)).size; // extra plan segments per account
    subscriptionCost = cost.lines.length ? mk('subscription_cost', 'estimated', { ...cost, planChanges: changes }, reasons) : unavailable('subscription_cost', ...reasons);
  }

  return { metricsVersion: METRICS_VERSION, period: { start: o.start, end: o.end }, completeness: comp, providerMix, clientMix, quotaRiskEvents, preventedInterruptions, resetUtilization, unusedQuota, forecastAccuracy, attributableActivity, subscriptionCost };
}

// Calendar helpers in UTC. Time-zone selection belongs to the report (Prompt 5.2).
export function utcWeek(ts: number): { start: number; end: number } {
  const d = new Date(ts); const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  return { start, end: start + 7 * DAY };
}
export function utcMonth(ts: number): { start: number; end: number } {
  const d = new Date(ts);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}
export type { LedgerSource, Provider };

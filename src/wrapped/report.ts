import { createHash } from 'node:crypto';
import type { LedgerRecord } from '../ledger/types.js';
import { PROVIDERS } from '../ledger/types.js';
import { METRIC_DEFINITIONS, type MetricId, type MetricStatus } from './definitions.js';
import { computePeriodMetrics, type Metric, type PeriodMetrics, type PeriodOptions } from './metrics.js';

// Private weekly Usage Wrapped report (Prompt 5.2, operation key 2026-10-10.1/prompt-5.2).
// Pure: ledger records in, a report model out. Nothing is written or sent anywhere. Rules: docs/WRAPPED_REPORT.md.

export const REPORT_VERSION = 1;
export const HIGH_UNATTRIBUTED_SHARE = 0.5; // adjustable default for the notice, not a measured target
export const UNUSED_QUOTA_HINT_PERCENT = 50; // adjustable default for the capacity hint
export const UNUSED_QUOTA_HINT_MIN_WINDOWS = 3;

export interface ReportOptions {
  now: number;
  timeZone?: string; // IANA zone; default UTC
  week?: string; // 'YYYY-MM-DD', any local day inside the wanted week; default is the last finished week
  accounts?: string[]; // empty or absent = all
  providers?: string[];
  devices?: string[];
  includeAccountNames?: boolean; // default false: accounts appear as "Account 1", "Account 2"
  metrics?: Omit<PeriodOptions, 'start' | 'end' | 'now'>; // thresholds, calibration, pricing inputs
}

export interface ReportMetric {
  id: MetricId; label: string; status: MetricStatus; valueText: string; reasons: string[];
  definitionHref: string; // in-report anchor to the glossary entry
}
export interface ReportSection { id: string; title: string; metrics: ReportMetric[]; notes: string[] }
export interface ComparisonRow { metricId: MetricId; label: string; current: number; previous: number; delta: number; unit: string }
export type Comparison =
  | { allowed: true; previousWeek: { start: number; end: number }; rows: ComparisonRow[] }
  | { allowed: false; reasons: string[] };
export interface Suggestion { id: string; text: string; basedOn: MetricId[] }
export interface Notice { id: string; text: string }
export interface Choices { accounts: string[]; providers: string[]; devices: string[]; timeZone: string; week: { start: number; end: number } }

export interface WrappedReport {
  reportVersion: number;
  period: { start: number; end: number; label: string };
  timeZone: string;
  generatedOn: string; // local calendar day only
  selection: { accounts: string[]; providers: string[]; devices: number; includeAccountNames: boolean };
  completeness: PeriodMetrics['completeness'];
  newUser: boolean;
  notices: Notice[];
  sections: ReportSection[];
  comparison: Comparison;
  suggestions: Suggestion[];
  glossary: Array<{ id: MetricId; name: string; definition: string; caveat: string; claim: string; needsUserAction: boolean }>;
}

// --- time zones ------------------------------------------------------------------------------

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
function parts(ts: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(ts)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}
const offsetMs = (ts: number, tz: string) => { const p = parts(ts, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000; };
// Epoch ms of local midnight for a calendar date; day overflow is normalised by Date.UTC.
function localMidnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m, d);
  const o1 = offsetMs(guess, tz);
  const t = guess - o1;
  const o2 = offsetMs(t, tz);
  return o2 === o1 ? t : guess - o2;
}
/** Monday-start week containing `ts` in `tz`, as [start, end) epoch ms. DST weeks are 167 or 169 hours long. */
export function weekBounds(ts: number, tz: string): { start: number; end: number } {
  const p = parts(ts, tz);
  const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const monday = p.day - ((wd + 6) % 7);
  return { start: localMidnight(p.year, p.month - 1, monday, tz), end: localMidnight(p.year, p.month - 1, monday + 7, tz) };
}
const dayLabel = (ts: number, tz: string) => { const p = parts(ts, tz); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };

/** Start of each local calendar day in [start, end). */
export function localDayStarts(start: number, end: number, tz: string): number[] {
  const out: number[] = [];
  for (let cur = start; cur < end; ) {
    out.push(cur);
    const p = parts(cur, tz);
    const next = localMidnight(p.year, p.month - 1, p.day + 1, tz);
    if (next <= cur) break;
    cur = next;
  }
  return out;
}

export function resolveWeek(o: { now: number; timeZone: string; week?: string }): { ok: true; start: number; end: number } | { ok: false; error: string } {
  if (o.week === undefined) { const cur = weekBounds(o.now, o.timeZone); return { ok: true, ...weekBounds(cur.start - 1, o.timeZone) }; }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(o.week);
  if (!m) return { ok: false, error: 'invalid_week' };
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const check = new Date(Date.UTC(y, mo, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d) return { ok: false, error: 'invalid_week' };
  const w = weekBounds(localMidnight(y, mo, d, o.timeZone) + 12 * 3_600_000, o.timeZone);
  if (w.start > o.now) return { ok: false, error: 'week_in_future' };
  return { ok: true, ...w };
}

// --- choices and filtering -------------------------------------------------------------------

export function listChoices(records: LedgerRecord[], o: { now: number; timeZone?: string; week?: string }): Choices | { error: string } {
  const timeZone = o.timeZone ?? 'UTC';
  if (!isValidTimeZone(timeZone)) return { error: 'invalid_time_zone' };
  const w = resolveWeek({ now: o.now, timeZone, ...(o.week !== undefined ? { week: o.week } : {}) });
  if (!w.ok) return { error: w.error };
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return { accounts: uniq(records.map(r => r.accountAlias)), providers: uniq(records.map(r => r.provider)), devices: uniq(records.map(r => r.devicePseudonym)), timeZone, week: { start: w.start, end: w.end } };
}

export function select(records: LedgerRecord[], o: ReportOptions): LedgerRecord[] {
  const has = (xs: string[] | undefined, v: string) => !xs?.length || xs.includes(v);
  return records.filter(r => has(o.accounts, r.accountAlias) && has(o.providers, r.provider) && has(o.devices, r.devicePseudonym));
}

// --- formatting ------------------------------------------------------------------------------

const REASON_TEXT: Record<string, string> = {
  no_counted_activity: 'no counted local activity', no_attributed_activity: 'no activity attributed to a supported client',
  records_without_request_count_ignored: 'some records had no request count and were ignored',
  no_provider_snapshots: 'no provider-reported readings', count_may_miss_unobserved_peaks: 'peaks between readings are not seen',
  no_window_reset_observed: 'no quota window reset during the week', lower_bound: 'a lower bound', upper_bound: 'an upper bound',
  too_few_comparisons: 'too few forecast comparisons', describes_this_period_only: 'describes this week only',
  no_calibration: 'no calibration is configured', no_reconciled_intervals: 'no intervals could be reconciled', windows_not_summed: 'windows are not added together',
  needs_user_confirmation: 'needs your confirmation', user_confirmed: 'confirmed by you', needs_plan_history: 'needs your plan history and a price catalog',
  missing_price: 'a plan has no price', mixed_tax_treatment: 'mixed tax treatment', multiple_currencies_not_summed: 'currencies are not added together',
};
export const reasonText = (r: string) => REASON_TEXT[r] ?? r.replace(/_/g, ' ');
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const pts = (n: number) => `${Math.round(n * 10) / 10}`;
const money = (minor: number, cur: string) => `${(minor / 100).toFixed(2)} ${cur}`;

const rm = <T,>(m: Metric<T>, label: string, text: (v: T) => string): ReportMetric => ({
  id: m.id, label, status: m.status, reasons: m.reasons, definitionHref: `#definition-${m.id}`,
  valueText: m.value === null ? `Unavailable: ${m.reasons.map(reasonText).join('; ') || 'no data'}` : text(m.value),
});

const totalRequests = (m: PeriodMetrics): number | null => (m.providerMix.value ? m.providerMix.value.reduce((a, s) => a + s.requests, 0) : null);

// --- build -----------------------------------------------------------------------------------

export function buildReport(all: LedgerRecord[], o: ReportOptions): { ok: true; report: WrappedReport } | { ok: false; error: string } {
  const timeZone = o.timeZone ?? 'UTC';
  if (!isValidTimeZone(timeZone)) return { ok: false, error: 'invalid_time_zone' };
  if (o.providers?.some(p => !(PROVIDERS as readonly string[]).includes(p))) return { ok: false, error: 'invalid_provider' };
  const w = resolveWeek({ now: o.now, timeZone, ...(o.week !== undefined ? { week: o.week } : {}) });
  if (!w.ok) return w;

  const records = select(all, o);
  const base = o.metrics ?? {};
  const cur = computePeriodMetrics(records, { ...base, start: w.start, end: w.end, now: o.now });
  const prevBounds = weekBounds(w.start - 1, timeZone);
  const prev = computePeriodMetrics(records, { ...base, start: prevBounds.start, end: prevBounds.end, now: o.now });
  // A user with nothing before this week has no baseline to compare against.
  const newUser = !records.some(r => r.effectiveObservedAt < w.start);

  const aliases = [...new Set(records.map(r => r.accountAlias))].sort();
  const accountLabel = (a: string) => (o.includeAccountNames ? a : `Account ${aliases.indexOf(a) + 1}`);
  const devices = new Set(records.map(r => r.devicePseudonym)).size;

  const unattributed = cur.clientMix.value?.unattributedRequests ?? 0;
  const counted = totalRequests(cur) ?? 0;
  const unattributedShare = counted > 0 ? unattributed / counted : 0;

  const notices: Notice[] = [];
  if (cur.completeness.reasons.includes('period_not_finished')) notices.push({ id: 'partial_week', text: 'This week has not finished, so every figure covers only the part that has passed.' });
  if (cur.completeness.reasons.includes('sparse_data')) notices.push({ id: 'sparse_data', text: `Only ${cur.completeness.daysWithData} of ${cur.completeness.periodDays} days have data, so figures may understate the week.` });
  if (cur.completeness.daysWithData === 0) notices.push({ id: 'no_activity', text: 'No data was recorded for this week and selection. Nothing below is zero; it is unavailable.' });
  if (newUser && cur.completeness.daysWithData > 0) notices.push({ id: 'new_user', text: 'This is your first recorded week, so there is no earlier week to compare with.' });
  if (unattributedShare >= HIGH_UNATTRIBUTED_SHARE) notices.push({ id: 'high_unattributed', text: `${pct(unattributedShare)} of counted requests could not be tied to a supported client. Client figures cover the rest only.` });
  if ((cur.subscriptionCost.value?.planChanges ?? 0) > 0) notices.push({ id: 'plan_change', text: 'Your plan changed during this week. Plan cost is split by the days each plan was active.' });

  const sections: ReportSection[] = [
    { id: 'usage', title: 'Usage', notes: [], metrics: [
      rm(cur.providerMix, 'Provider mix', v => v.map(s => `${s.key} ${pct(s.share)}`).join(', ') + ` (${v.reduce((a, s) => a + s.requests, 0)} requests counted locally)`),
    ] },
    { id: 'clients', title: 'Client attribution', notes: [], metrics: [
      rm(cur.clientMix, 'Supported-client mix', v => `${v.clients.map(s => `${s.key} ${pct(s.share)}`).join(', ')}; ${v.unattributedRequests} requests unattributed`),
      rm(cur.attributableActivity, 'Attributable activity', v => Object.entries(v).map(([k, c]) => `${k.split('|').map((x, i) => (i === 1 ? accountLabel(x) : x)).join(' / ')}: ${pct(c.low)} to ${pct(c.high)} explained`).join('; ')),
    ] },
    { id: 'quota', title: 'Quota and interruptions', notes: [], metrics: [
      rm(cur.quotaRiskEvents, 'Quota risk events', v => `${v.windowsAtRisk} window(s) reached ${v.threshold}%, ${v.windowsAtLimit} reached 100%`),
      rm(cur.preventedInterruptions, 'Prevented interruptions', v => `${v} confirmed by you`),
      rm(cur.resetUtilization, 'Reset utilization', v => `${pts(v.meanPercent)}% of quota used at reset across ${v.windows} window(s)`),
      rm(cur.unusedQuota, 'Unused quota', v => `${pts(v.meanPercent)}% of quota left at reset across ${v.windows} window(s)`),
    ] },
    { id: 'forecast', title: 'Forecast performance', notes: [], metrics: [
      rm(cur.forecastAccuracy, 'Forecast accuracy', v => `one-hour forecasts were off by ${pts(v.maePoints)} quota points on average (${v.comparisons} comparisons)`),
    ] },
    { id: 'plan', title: 'Plan', notes: [], metrics: [
      rm(cur.subscriptionCost, 'Subscription cost', v => Object.entries(v.byCurrency).map(([c, minor]) => money(minor, c)).join(' + ') + ' prorated for the week'),
    ] },
  ];

  // Comparison only when both periods meet the completeness thresholds. Thresholds come from the metrics options, never lowered here.
  let comparison: Comparison;
  const why: string[] = [];
  if (!cur.completeness.complete) why.push(...cur.completeness.reasons.map(r => `this_week_${r}`));
  if (newUser) why.push('no_earlier_data');
  else if (!prev.completeness.complete) why.push(...prev.completeness.reasons.map(r => `previous_week_${r}`));
  if (why.length) comparison = { allowed: false, reasons: [...new Set(why)] };
  else {
    const rows: ComparisonRow[] = [];
    const add = (metricId: MetricId, label: string, unit: string, a: number | null, b: number | null) => { if (a !== null && b !== null) rows.push({ metricId, label, current: a, previous: b, delta: Math.round((a - b) * 100) / 100, unit }); };
    add('provider_mix', 'Requests counted locally', 'requests', totalRequests(cur), totalRequests(prev));
    add('quota_risk_events', 'Windows at risk', 'windows', cur.quotaRiskEvents.value?.windowsAtRisk ?? null, prev.quotaRiskEvents.value?.windowsAtRisk ?? null);
    add('quota_risk_events', 'Windows at 100%', 'windows', cur.quotaRiskEvents.value?.windowsAtLimit ?? null, prev.quotaRiskEvents.value?.windowsAtLimit ?? null);
    add('unused_quota', 'Unused quota at reset', 'percent', cur.unusedQuota.value?.meanPercent ?? null, prev.unusedQuota.value?.meanPercent ?? null);
    add('forecast_accuracy', 'Forecast error', 'quota points', cur.forecastAccuracy.value?.maePoints ?? null, prev.forecastAccuracy.value?.maePoints ?? null);
    comparison = { allowed: true, previousWeek: prevBounds, rows };
  }

  const suggestions: Suggestion[] = [];
  if (unattributedShare >= HIGH_UNATTRIBUTED_SHARE) suggestions.push({ id: 'raise_attribution', text: 'Much of your activity is unattributed. Turning on a local collector for the clients you use, or including your other devices, would let this report cover more of it.', basedOn: ['client_mix'] });
  if ((cur.quotaRiskEvents.value?.windowsAtLimit ?? 0) > 0) suggestions.push({ id: 'review_limit_windows', text: `${cur.quotaRiskEvents.value?.windowsAtLimit} window(s) reached 100%. Check the forecast earlier in those windows to see the margin before a limit.`, basedOn: ['quota_risk_events', 'forecast_accuracy'] });
  if ((cur.unusedQuota.value?.windows ?? 0) >= UNUSED_QUOTA_HINT_MIN_WINDOWS && (cur.unusedQuota.value?.meanPercent ?? 0) >= UNUSED_QUOTA_HINT_PERCENT) suggestions.push({ id: 'possible_spare_capacity', text: 'Windows often ended with a lot of quota unused. This is an upper bound from one week, not a recommendation to change plan; compare plans with your own prices before deciding.', basedOn: ['unused_quota', 'reset_utilization'] });
  if (cur.attributableActivity.reasons.includes('no_calibration') && cur.completeness.daysWithData > 0) suggestions.push({ id: 'add_calibration', text: 'Add a calibration to see how much quota movement your local activity explains.', basedOn: ['attributable_activity'] });
  if (cur.subscriptionCost.status === 'unavailable' && cur.completeness.daysWithData > 0) suggestions.push({ id: 'add_plan_history', text: 'Enter your plan history and a price to see the prorated plan cost for the week.', basedOn: ['subscription_cost'] });
  if (cur.completeness.reasons.includes('sparse_data') && cur.completeness.daysWithData > 0) suggestions.push({ id: 'collect_more_days', text: 'Several days have no data. Keep collectors running so weekly comparisons can be shown.', basedOn: ['provider_mix'] });

  const glossary = Object.values(METRIC_DEFINITIONS).map(d => ({ id: d.id, name: d.name, definition: d.definition, caveat: d.caveat, claim: d.claim, needsUserAction: d.needsUserAction }));
  const report: WrappedReport = {
    reportVersion: REPORT_VERSION,
    period: { start: w.start, end: w.end, label: `${dayLabel(w.start, timeZone)} to ${dayLabel(w.end - 1, timeZone)}` },
    timeZone, generatedOn: dayLabel(o.now, timeZone),
    selection: { accounts: o.includeAccountNames ? aliases : aliases.map(accountLabel), providers: [...new Set(records.map(r => r.provider))].sort(), devices, includeAccountNames: o.includeAccountNames === true },
    completeness: cur.completeness, newUser, notices, sections, comparison, suggestions, glossary,
  };
  return { ok: true, report };
}

export const contentHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

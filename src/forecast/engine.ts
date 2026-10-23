import { currentView, RESET_PERCENT_DROP, RESET_AT_TOLERANCE_MS } from '../ledger/ledger.js';
import type { LedgerRecord, Provider, WindowType } from '../ledger/types.js';

// Reset-aware quota forecasts. See docs/FORECASTS.md for the rules.
// Pure and deterministic: reads ledger provider snapshots, writes nothing.
// Quota percentages are the only unit used; token estimates are never converted to quota.

const HOUR = 3_600_000;
export const WINDOW_MS: Partial<Record<WindowType, number>> = { five_hour: 5 * HOUR, weekly: 7 * 24 * HOUR, daily: 24 * HOUR };
export const MIN_POINTS = 4; // fewer points than this use the window-average fallback
export const MIN_SPAN_MS = 20 * 60_000; // shorter history than this is too sparse for a trend
export const MAX_PROBABILITY = 0.99; // a forecast is never certain; only an observed cap is
export const MIN_PROBABILITY = 0.01;
export const OUTLIER_MAD_K = 3.5;
export const RANGE_RATIO = 2; // burn-rate spread above this is "high uncertainty": show a range, not a time
export const STALE_AFTER_MS: Partial<Record<WindowType, number>> = { five_hour: 30 * 60_000, weekly: 6 * HOUR, daily: 2 * HOUR };

export type ForecastMethod = 'trend' | 'window_average' | 'none';
export type ForecastState = 'limited' | 'ok' | 'idle' | 'insufficient_data' | 'stale';
export type Reason =
  | 'sparse_history' | 'short_span' | 'wide_burn_spread' | 'outliers_removed' | 'clock_anomaly_dropped'
  | 'reset_in_history' | 'unknown_reset' | 'stale_data' | 'capped_reading' | 'no_recent_burn' | 'reset_passed';

export interface Range { low: number; point: number; high: number }

export interface Forecast {
  provider: Provider; accountAlias: string; window: WindowType;
  state: ForecastState;
  method: ForecastMethod;
  usedPercent: number | null; // latest provider-reported reading in the current window
  asOf: number | null; // effective time of that reading
  resetAt: number | null;
  hoursToReset: number | null;
  reservedPercent: number;
  burnPerHour: Range | null; // percentage points per hour
  safeHourlyAllowance: number | null; // points per hour that keep usage under (100 - reserved) at reset
  projectedLimitAt: { earliest: number; latest: number | null; display: 'range' | 'point' } | null; // latest null: may not reach the limit
  probabilityExhaustBeforeReset: number | null;
  confidence: 'high' | 'medium' | 'low';
  reasons: Reason[];
  explanation: string;
}

export interface ForecastOptions {
  now: number;
  provider: Provider; accountAlias: string; window: WindowType;
  reservedPercent?: number; // quota to keep back, 0..100
}

interface Pt { at: number; percent: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * q; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };

// Latest window segment for one provider/account/window, using the ledger's reset rules,
// plus whether a reset occurred earlier in the history and any points dropped as clock anomalies.
function currentSegment(records: LedgerRecord[], o: ForecastOptions): { pts: Pt[]; resetAt: number | null; resetSeen: boolean; clockDropped: number } {
  let pts: Pt[] = []; let lastReset: number | undefined; let resetAt: number | null = null; let resetSeen = false; let clockDropped = 0;
  const snaps = currentView(records)
    .filter(r => r.kind === 'provider_snapshot' && r.provider === o.provider && r.accountAlias === o.accountAlias && r.window?.type === o.window && r.effectiveObservedAt <= o.now)
    .sort((a, b) => a.effectiveObservedAt - b.effectiveObservedAt);
  for (const r of snaps) {
    const pct = r.measures.quotaPercentUsed;
    if (pct === undefined) continue;
    const prev = pts[pts.length - 1];
    const moved = r.window?.resetAt !== undefined && lastReset !== undefined && Math.abs(r.window.resetAt - lastReset) > RESET_AT_TOLERANCE_MS;
    if (prev && (moved || pct < prev.percent - RESET_PERCENT_DROP)) { pts = []; resetSeen = true; clockDropped = 0; }
    const last = pts[pts.length - 1];
    if (last && r.effectiveObservedAt <= last.at) { clockDropped++; continue; } // duplicate or backwards time
    if (last && pct < last.percent) { pts.push({ at: r.effectiveObservedAt, percent: last.percent }); } // small quota correction: keep usage monotonic
    else pts.push({ at: r.effectiveObservedAt, percent: pct });
    if (r.window?.resetAt !== undefined) { lastReset = r.window.resetAt; resetAt = r.window.resetAt; }
  }
  return { pts, resetAt, resetSeen, clockDropped };
}

// Pairwise slopes (points per hour) between readings that are below the cap and far enough apart.
function pairSlopes(pts: Pt[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const dt = pts[j].at - pts[i].at;
    if (dt >= 5 * 60_000) out.push(((pts[j].percent - pts[i].percent) / dt) * HOUR);
  }
  return out;
}

function dropOutliers(slopes: number[]): { kept: number[]; removed: number } {
  if (slopes.length < 5) return { kept: slopes, removed: 0 };
  const m = median(slopes);
  const mad = median(slopes.map(s => Math.abs(s - m)));
  if (mad === 0) return { kept: slopes, removed: 0 };
  const kept = slopes.filter(s => Math.abs(s - m) / (1.4826 * mad) <= OUTLIER_MAD_K);
  return { kept, removed: slopes.length - kept.length };
}

function base(o: ForecastOptions, f: Partial<Forecast>): Forecast {
  return {
    provider: o.provider, accountAlias: o.accountAlias, window: o.window, state: 'insufficient_data', method: 'none',
    usedPercent: null, asOf: null, resetAt: null, hoursToReset: null, reservedPercent: o.reservedPercent ?? 0,
    burnPerHour: null, safeHourlyAllowance: null, projectedLimitAt: null, probabilityExhaustBeforeReset: null,
    confidence: 'low', reasons: [], explanation: '', ...f,
  };
}

export function forecast(records: LedgerRecord[], o: ForecastOptions): Forecast {
  const reserved = clamp(o.reservedPercent ?? 0, 0, 100);
  const { pts, resetAt: seenReset, resetSeen, clockDropped } = currentSegment(records, o);
  const windowMs = WINDOW_MS[o.window];
  const reasons: Reason[] = [];
  if (resetSeen) reasons.push('reset_in_history');
  if (clockDropped) reasons.push('clock_anomaly_dropped');
  if (!pts.length) return base(o, { reservedPercent: reserved, reasons: ['sparse_history'], explanation: 'No provider readings for this window yet.' });

  const lastPt = pts[pts.length - 1];
  const used = lastPt.percent;
  const resetAt = seenReset !== null && seenReset > o.now ? seenReset : null;
  if (seenReset !== null && seenReset <= o.now) reasons.push('reset_passed');
  if (resetAt === null) reasons.push('unknown_reset');
  const hoursToReset = resetAt === null ? null : (resetAt - o.now) / HOUR;
  const common = { reservedPercent: reserved, usedPercent: used, asOf: lastPt.at, resetAt, hoursToReset: hoursToReset === null ? null : r4(hoursToReset) };

  const staleAfter = STALE_AFTER_MS[o.window] ?? 30 * 60_000;
  if (o.now - lastPt.at > staleAfter || seenReset !== null && seenReset <= o.now) {
    reasons.push('stale_data');
    return base(o, { ...common, state: 'stale', reasons, explanation: `Last provider reading is ${Math.round((o.now - lastPt.at) / 60_000)} minutes old${seenReset !== null && seenReset <= o.now ? ' and its window has already reset' : ''}; no forecast is shown until fresh data arrives.` });
  }

  // An observed cap is a fact, not a forecast. It is the only case that reports probability 1.
  if (used >= 100) {
    reasons.push('capped_reading');
    const capAt = pts.find(p => p.percent >= 100)!.at;
    return base(o, { ...common, state: 'limited', method: 'none', projectedLimitAt: { earliest: capAt, latest: capAt, display: 'point' }, probabilityExhaustBeforeReset: 1, confidence: 'high', reasons, safeHourlyAllowance: 0,
      explanation: 'The provider reports this window at its limit. Wait for the reset.' });
  }

  const remaining = 100 - used;
  const budget = Math.max(0, 100 - reserved - used);
  const safe = hoursToReset !== null && hoursToReset > 0 ? r4(budget / hoursToReset) : null;
  const span = lastPt.at - pts[0].at;

  let burn: Range | null = null; let method: ForecastMethod = 'none'; let slopes: number[] = [];
  if (pts.length >= MIN_POINTS && span >= MIN_SPAN_MS) {
    const { kept, removed } = dropOutliers(pairSlopes(pts));
    if (removed) reasons.push('outliers_removed');
    slopes = kept.map(s => Math.max(0, s));
    if (slopes.length) { burn = { low: r4(quantile(slopes, 0.1)), point: r4(median(slopes)), high: r4(quantile(slopes, 0.9)) }; method = 'trend'; }
  } else {
    reasons.push(pts.length < MIN_POINTS ? 'sparse_history' : 'short_span');
  }
  if (!burn && windowMs && resetAt !== null) {
    // Transparent fallback: usage so far divided by time elapsed in the window. No range is claimed.
    const elapsed = o.now - (resetAt - windowMs);
    if (elapsed >= 10 * 60_000) { const avg = r4((used / elapsed) * HOUR); burn = { low: avg, point: avg, high: avg }; method = 'window_average'; }
  }
  if (!burn) return base(o, { ...common, state: 'insufficient_data', reasons, safeHourlyAllowance: safe, explanation: 'Not enough history for a burn rate. Showing the current reading only.' });

  if (burn.high <= 0.0001) {
    reasons.push('no_recent_burn');
    return base(o, { ...common, state: 'idle', method, burnPerHour: burn, safeHourlyAllowance: safe, confidence: 'medium', reasons, probabilityExhaustBeforeReset: hoursToReset === null ? null : MIN_PROBABILITY,
      explanation: 'No measurable burn in recent readings, so no limit time is projected.' });
  }

  const spread = burn.low > 0 ? burn.high / burn.low : Infinity;
  const uncertain = method === 'window_average' || spread > RANGE_RATIO || pts.length < 2 * MIN_POINTS;
  if (spread > RANGE_RATIO) reasons.push('wide_burn_spread');
  const limitIn = (rate: number) => (rate > 0 ? o.now + (remaining / rate) * HOUR : null);
  const earliest = limitIn(burn.high)!;
  const latest = burn.low > 0 ? limitIn(burn.low) : null;
  const display: 'range' | 'point' = uncertain ? 'range' : 'point';
  // The limit only matters if it falls before the reset.
  const beforeReset = (t: number | null) => t !== null && (resetAt === null || t <= resetAt);
  const projectedLimitAt = beforeReset(earliest) ? { earliest, latest, display } : null;

  let probability: number | null = null;
  if (hoursToReset !== null && hoursToReset > 0) {
    const sample = method === 'trend' ? slopes : [burn.low, burn.point, burn.high];
    const hits = sample.filter(s => used + s * hoursToReset >= 100).length;
    probability = r4(clamp((hits + 0.5) / (sample.length + 1), MIN_PROBABILITY, MAX_PROBABILITY)); // Laplace-style smoothing: never exactly 0 or 1
  }
  const confidence: Forecast['confidence'] = method === 'window_average' || span < 2 * HOUR / 3 ? 'low' : uncertain ? 'medium' : 'high';
  const explanation = method === 'window_average'
    ? `Simple estimate: ${used}% used over the elapsed part of the window. Too little history for a trend, so only a range is shown.`
    : projectedLimitAt
      ? `Burn rate ${burn.point}%/h (${burn.low}-${burn.high}). ${display === 'range' ? 'Readings vary too much for a single time, so a range is shown.' : 'Readings are consistent.'}`
      : `Burn rate ${burn.point}%/h; the limit is not expected before the reset.`;
  return base(o, { ...common, state: 'ok', method, burnPerHour: burn, safeHourlyAllowance: safe, projectedLimitAt, probabilityExhaustBeforeReset: probability, confidence, reasons, explanation });
}

export interface RiskNotice { notify: boolean; why: 'new_risk' | 'changed_materially' | 'repeat' | 'no_risk' }

// Repeat-suppression safeguard: a high-risk forecast is surfaced once, then again only
// when the risk class changes or the projected earliest limit time moves by more than the tolerance.
export function riskNotice(prev: Forecast | null, next: Forecast, threshold = 0.8, toleranceMs = 30 * 60_000): RiskNotice {
  const risky = (f: Forecast) => f.state === 'limited' || (f.state === 'ok' && (f.probabilityExhaustBeforeReset ?? 0) >= threshold);
  if (!risky(next)) return { notify: false, why: 'no_risk' };
  if (!prev || !risky(prev)) return { notify: true, why: 'new_risk' };
  const a = prev.projectedLimitAt?.earliest; const b = next.projectedLimitAt?.earliest;
  if (prev.state !== next.state || (a !== undefined && b !== undefined && Math.abs(a - b) > toleranceMs)) return { notify: true, why: 'changed_materially' };
  return { notify: false, why: 'repeat' };
}

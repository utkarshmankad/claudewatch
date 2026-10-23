import { forecast, WINDOW_MS, type ForecastOptions } from './engine.js';
import { segments } from '../ledger/ledger.js';
import type { LedgerRecord, WindowType } from '../ledger/types.js';

// Backtests forecasts against stored ledger history. Reports absolute error and
// calibration per provider/window/horizon. See docs/FORECASTS.md.

export const HORIZONS_HOURS = [1, 3, 6, 24] as const;
const HOUR = 3_600_000;

export interface HorizonStats { provider: string; window: WindowType; horizonHours: number; n: number; maeBurnPoints: number | null; baselineMaePoints: number | null }
export interface CalibrationBin { lo: number; hi: number; n: number; meanForecast: number; observedRate: number }
export interface BacktestReport {
  horizons: HorizonStats[];
  calibration: Record<string, { n: number; brier: number | null; bins: CalibrationBin[] }>; // key provider|window
  skipped: number; // origins without enough history or a known outcome
}

function percentAt(pts: Array<{ at: number; percent: number }>, t: number): number | null {
  const last = pts[pts.length - 1];
  if (t > last.at || t < pts[0].at) return null; // no extrapolated "truth"
  for (let i = 1; i < pts.length; i++) if (pts[i].at >= t) {
    const a = pts[i - 1]; const b = pts[i];
    return a.percent + ((b.percent - a.percent) * (t - a.at)) / (b.at - a.at);
  }
  return last.percent;
}

export function backtest(records: LedgerRecord[], opts: { reservedPercent?: number } = {}): BacktestReport {
  const err = new Map<string, { burn: number[]; flat: number[] }>();
  const probs = new Map<string, Array<{ p: number; y: number }>>();
  let skipped = 0;
  for (const seg of segments(records)) {
    const winMs = WINDOW_MS[seg.window];
    const resetAt = records.filter(r => r.kind === 'provider_snapshot' && r.provider === seg.provider && r.accountAlias === seg.accountAlias && r.window?.type === seg.window && r.effectiveObservedAt === seg.points[seg.points.length - 1].at).map(r => r.window?.resetAt)[0];
    for (const origin of seg.points) {
      const fo: ForecastOptions = { now: origin.at, provider: seg.provider as ForecastOptions['provider'], accountAlias: seg.accountAlias, window: seg.window, ...(opts.reservedPercent !== undefined ? { reservedPercent: opts.reservedPercent } : {}) };
      // Only information available at the origin is used: the engine filters to readings up to `now`.
      const f = forecast(records.filter(r => r.effectiveObservedAt <= origin.at), fo);
      if (f.state !== 'ok' || !f.burnPerHour) { skipped++; continue; }
      for (const h of HORIZONS_HOURS) {
        const truth = percentAt(seg.points, origin.at + h * HOUR);
        if (truth === null) continue;
        const key = `${seg.provider}|${seg.window}|${h}`;
        const e = err.get(key) ?? { burn: [], flat: [] };
        e.burn.push(Math.abs(Math.min(100, origin.percent + f.burnPerHour.point * h) - truth));
        e.flat.push(Math.abs(origin.percent - truth)); // naive baseline: usage stays where it is
        err.set(key, e);
      }
      // Calibration: P(exhaust before reset) vs whether the segment's final reading hit the cap.
      if (f.probabilityExhaustBeforeReset !== null && winMs && resetAt !== undefined && seg.points[seg.points.length - 1].at >= resetAt - 10 * 60_000) {
        const k = `${seg.provider}|${seg.window}`;
        const arr = probs.get(k) ?? [];
        arr.push({ p: f.probabilityExhaustBeforeReset, y: seg.points.some(p => p.percent >= 100) ? 1 : 0 });
        probs.set(k, arr);
      } else skipped++;
    }
  }
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e4) / 1e4 : null);
  const horizons: HorizonStats[] = [...err.entries()].sort().map(([k, v]) => {
    const [provider, window, h] = k.split('|');
    return { provider, window: window as WindowType, horizonHours: Number(h), n: v.burn.length, maeBurnPoints: mean(v.burn), baselineMaePoints: mean(v.flat) };
  });
  const calibration: BacktestReport['calibration'] = {};
  for (const [k, arr] of probs) {
    const bins: CalibrationBin[] = [];
    for (let b = 0; b < 5; b++) {
      const lo = b / 5; const hi = (b + 1) / 5;
      const m = arr.filter(x => x.p >= lo && (b === 4 ? x.p <= hi : x.p < hi));
      if (m.length) bins.push({ lo, hi, n: m.length, meanForecast: mean(m.map(x => x.p))!, observedRate: mean(m.map(x => x.y))! });
    }
    calibration[k] = { n: arr.length, brier: mean(arr.map(x => (x.p - x.y) ** 2)), bins };
  }
  return { horizons, calibration, skipped };
}

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { append } from '../../ledger/ledger.js';
import type { LedgerInput, LedgerRecord } from '../../ledger/types.js';
import { forecast, riskNotice, MAX_PROBABILITY } from '../engine.js';
import { backtest } from '../backtest.js';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const RESET = T0 + 5 * HOUR;

const snap = (at: number, pct: number, o: Partial<LedgerInput> = {}): LedgerInput => ({
  schemaVersion: 1, kind: 'provider_snapshot', provider: 'claude', accountAlias: 'work', devicePseudonym: 'a1b2c3d4e5f60718',
  observedAt: at, ingestedAt: at + 1000, source: 'web', confidence: 'high', measurementMethod: 'provider_reported',
  measures: { quotaPercentUsed: pct }, window: { type: 'five_hour', resetAt: RESET }, ...o,
});
const ledger = (xs: LedgerInput[]): LedgerRecord[] => {
  const r = append([], xs);
  expect(r.rejected).toEqual([]);
  return r.records;
};
const opt = (now: number, extra = {}) => ({ now, provider: 'claude' as const, accountAlias: 'work', window: 'five_hour' as const, ...extra });
// Steady 10 points per hour, one reading every 15 minutes.
const steady = (n: number, step = 15 * MIN, rate = 10) => Array.from({ length: n }, (_, i) => snap(T0 + i * step, (rate * i * step) / HOUR));

describe('forecast', () => {
  it('reports a point limit time and a probability under steady burn', () => {
    const recs = ledger(steady(9, 15 * MIN, 25)); // 2h of readings, 50%, reset in 3h
    const now = T0 + 2 * HOUR;
    const f = forecast(recs, opt(now));
    expect(f.method).toBe('trend');
    expect(f.burnPerHour).toEqual({ low: 25, point: 25, high: 25 });
    expect(f.projectedLimitAt).toEqual({ earliest: now + 2 * HOUR, latest: now + 2 * HOUR, display: 'point' });
  });

  it('drops the projection when the limit falls after the reset', () => {
    const f = forecast(ledger(steady(9)), opt(T0 + 2 * HOUR + MIN));
    expect(f.projectedLimitAt).toBeNull();
    expect(f.probabilityExhaustBeforeReset).toBeLessThan(0.1);
  });

  it('computes safe hourly allowance and honours reserved quota', () => {
    const recs = ledger(steady(9));
    const now = T0 + 2 * HOUR;
    const f = forecast(recs, opt(now));
    expect(f.safeHourlyAllowance).toBeCloseTo((100 - 20) / 3, 3);
    const r = forecast(recs, opt(now, { reservedPercent: 20 }));
    expect(r.safeHourlyAllowance).toBeCloseTo((100 - 20 - 20) / 3, 3);
  });

  it('flags a likely block with a high but never certain probability', () => {
    const recs = ledger(steady(9, 15 * MIN, 30)); // 60% after 2h at 30/h; limit in ~1.3h, reset in 3h
    const f = forecast(recs, opt(T0 + 2 * HOUR));
    expect(f.projectedLimitAt).not.toBeNull();
    expect(f.probabilityExhaustBeforeReset!).toBeGreaterThan(0.8);
    expect(f.probabilityExhaustBeforeReset!).toBeLessThanOrEqual(MAX_PROBABILITY);
  });

  it('reports a range, not a time, when burn is erratic', () => {
    const pcts = [0, 6, 6, 24, 24, 30, 52, 52, 60];
    const f = forecast(ledger(pcts.map((p, i) => snap(T0 + i * 15 * MIN, p))), opt(T0 + 2 * HOUR));
    expect(f.reasons).toContain('wide_burn_spread');
    expect(f.projectedLimitAt?.display).toBe('range');
    expect(f.confidence).not.toBe('high');
  });

  it('falls back to a transparent window average with sparse history', () => {
    const f = forecast(ledger([snap(T0 + 2 * HOUR, 30)]), opt(T0 + 2 * HOUR + 5 * MIN));
    expect(f.method).toBe('window_average');
    expect(f.reasons).toContain('sparse_history');
    expect(f.confidence).toBe('low');
    if (f.projectedLimitAt) expect(f.projectedLimitAt.display).toBe('range');
  });

  it('gives insufficient data with no reset and too little history', () => {
    const f = forecast(ledger([snap(T0, 5, { window: { type: 'five_hour' } })]), opt(T0 + MIN));
    expect(f.state).toBe('insufficient_data');
    expect(f.projectedLimitAt).toBeNull();
  });

  it('returns insufficient_data with no readings at all', () => {
    expect(forecast([], opt(T0)).state).toBe('insufficient_data');
  });

  it('treats a provider cap as a fact and reports it exactly once as certain', () => {
    const recs = ledger([...steady(5), snap(T0 + 75 * MIN, 100), snap(T0 + 90 * MIN, 100)]);
    const f = forecast(recs, opt(T0 + 95 * MIN));
    expect(f.state).toBe('limited');
    expect(f.probabilityExhaustBeforeReset).toBe(1);
    expect(f.projectedLimitAt?.earliest).toBe(T0 + 75 * MIN);
  });

  it('never reports a probability of exactly 1 or 0 for an uncapped window', () => {
    const f = forecast(ledger(steady(9, 15 * MIN, 45)), opt(T0 + 2 * HOUR));
    expect(f.probabilityExhaustBeforeReset).toBeGreaterThan(0.95);
    expect(f.probabilityExhaustBeforeReset).toBeLessThanOrEqual(MAX_PROBABILITY);
    const idle = forecast(ledger(steady(9, 15 * MIN, 0)), opt(T0 + 2 * HOUR));
    expect(idle.state).toBe('idle');
    expect(idle.probabilityExhaustBeforeReset).toBeGreaterThan(0);
  });

  it('forecasts only from the window after a reset', () => {
    const next = RESET + 5 * HOUR;
    const recs = ledger([...steady(9, 15 * MIN, 40).map((r, i) => snap(T0 + i * 15 * MIN, Math.min(99, i * 10))),
      ...Array.from({ length: 6 }, (_, i) => snap(RESET + 5 * MIN + i * 15 * MIN, i * 1, { window: { type: 'five_hour', resetAt: next } }))]);
    const f = forecast(recs, opt(RESET + 90 * MIN));
    expect(f.reasons).toContain('reset_in_history');
    expect(f.usedPercent).toBe(5);
    expect(f.burnPerHour!.point).toBeLessThan(5);
  });

  it('ignores a single outlier jump in the burn rate', () => {
    const pcts = [0, 2, 4, 6, 8, 10, 12, 14, 16];
    const clean = forecast(ledger(pcts.map((p, i) => snap(T0 + i * 15 * MIN, p))), opt(T0 + 2 * HOUR));
    const spiky = forecast(ledger(pcts.map((p, i) => snap(T0 + i * 15 * MIN, i === 4 ? 12 : p))), opt(T0 + 2 * HOUR));
    expect(Math.abs(spiky.burnPerHour!.point - clean.burnPerHour!.point)).toBeLessThan(3);
  });

  it('keeps usage monotonic across a small quota correction', () => {
    const pcts = [0, 4, 8, 12, 11.5, 16, 20];
    const f = forecast(ledger(pcts.map((p, i) => snap(T0 + i * 15 * MIN, p))), opt(T0 + 95 * MIN));
    expect(f.reasons).not.toContain('reset_in_history');
    expect(f.burnPerHour!.point).toBeGreaterThan(10);
  });

  it('survives duplicate and backwards timestamps (clock changes)', () => {
    const xs = steady(8);
    const bad = snap(T0 + 3 * 15 * MIN, 50, { devicePseudonym: 'b2c3d4e5f6071829' });
    const recs = ledger([...xs, bad]);
    const f = forecast(recs, opt(T0 + 2 * HOUR));
    expect(f.state).toBe('ok');
    expect(f.reasons).toContain('clock_anomaly_dropped');
  });

  it('refuses to forecast from stale data and after a passed reset', () => {
    const recs = ledger(steady(9));
    const stale = forecast(recs, opt(T0 + 4 * HOUR));
    expect(stale.state).toBe('stale');
    expect(stale.projectedLimitAt).toBeNull();
    expect(stale.probabilityExhaustBeforeReset).toBeNull();
    expect(forecast(recs, opt(RESET + MIN)).reasons).toContain('reset_passed');
  });

  it('treats five-hour and weekly windows independently', () => {
    const weekly = Array.from({ length: 6 }, (_, i) => snap(T0 + i * 2 * HOUR, i * 0.5, { window: { type: 'weekly', resetAt: T0 + 168 * HOUR } }));
    const recs = ledger([...steady(9), ...weekly]);
    const w = forecast(recs, opt(T0 + 10 * HOUR, { window: 'weekly' }));
    const f = forecast(recs, opt(T0 + 2 * HOUR));
    expect(w.window).toBe('weekly');
    expect(w.usedPercent).toBe(2.5);
    expect(f.usedPercent).toBe(20);
  });

  it('is deterministic', () => {
    const recs = ledger(steady(9));
    expect(forecast(recs, opt(T0 + 2 * HOUR))).toEqual(forecast(recs, opt(T0 + 2 * HOUR)));
  });
});

describe('riskNotice', () => {
  const risky = () => forecast(ledger(steady(9, 15 * MIN, 30)), opt(T0 + 2 * HOUR));
  it('notifies once for a new risk and suppresses repeats', () => {
    const a = risky();
    expect(riskNotice(null, a)).toEqual({ notify: true, why: 'new_risk' });
    expect(riskNotice(a, a)).toEqual({ notify: false, why: 'repeat' });
  });
  it('notifies again when the projection moves materially or the cap is hit', () => {
    const a = risky();
    const moved = { ...a, projectedLimitAt: { ...a.projectedLimitAt!, earliest: a.projectedLimitAt!.earliest + 2 * HOUR } };
    expect(riskNotice(a, moved).why).toBe('changed_materially');
    const capped = forecast(ledger([...steady(5), snap(T0 + 75 * MIN, 100)]), opt(T0 + 80 * MIN));
    expect(riskNotice(a, capped).notify).toBe(true);
  });
  it('stays quiet without risk', () => {
    expect(riskNotice(null, forecast(ledger(steady(9)), opt(T0 + 2 * HOUR))).why).toBe('no_risk');
  });
});

describe('backtest on stored synthetic fixtures', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/synthetic-history.json', import.meta.url), 'utf8')) as LedgerInput[];
  const recs = ledger(raw);
  const rep = backtest(recs);

  it('reports absolute error by provider, window and horizon', () => {
    const keys = rep.horizons.map(h => `${h.provider}|${h.window}|${h.horizonHours}`);
    expect(keys).toContain('claude|five_hour|1');
    expect(keys).toContain('chatgpt|five_hour|1');
    expect(keys).toContain('claude|weekly|24');
    for (const h of rep.horizons) { expect(h.n).toBeGreaterThan(0); expect(h.maeBurnPoints).not.toBeNull(); }
  });

  it('beats the stay-flat baseline at the one-hour horizon on active windows', () => {
    const h = rep.horizons.find(x => x.provider === 'claude' && x.window === 'five_hour' && x.horizonHours === 1)!;
    expect(h.maeBurnPoints!).toBeLessThan(h.baselineMaePoints!);
  });

  it('reports calibration with a Brier score and non-empty bins', () => {
    const c = rep.calibration['claude|five_hour'];
    expect(c.n).toBeGreaterThan(10);
    expect(c.brier).toBeGreaterThanOrEqual(0);
    expect(c.brier).toBeLessThanOrEqual(1);
    expect(c.bins.length).toBeGreaterThan(0);
    for (const b of c.bins) expect(b.observedRate).toBeGreaterThanOrEqual(0);
  });

  it('never produces an uncapped probability of 1 anywhere in the fixtures', () => {
    for (const r of recs.filter(x => x.measures.quotaPercentUsed !== undefined).filter((_, i) => i % 7 === 0)) {
      const f = forecast(recs, { now: r.effectiveObservedAt + MIN, provider: r.provider, accountAlias: r.accountAlias, window: r.window!.type });
      if (f.state === 'ok') expect(f.probabilityExhaustBeforeReset).toBeLessThanOrEqual(MAX_PROBABILITY);
    }
  });
});

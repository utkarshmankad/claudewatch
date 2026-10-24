import { describe, expect, it } from 'vitest';
import { SAMPLE_CONTRIBUTION, MIN_COHORT_SIZE, type RadarContribution } from '../contribution.js';
import { RadarIngest } from '../ingest.js';
import { PrivacyBudget, aggregateBucket, laplace, median, noisyRate, publish, suppress, type AggregateRow } from '../aggregate.js';
import { detectIncidents } from '../detect.js';
import { RadarPipeline } from '../pipeline.js';
import { mulberry32, runSimulation, type Scenario } from '../simulate.js';

const T0 = Date.UTC(2026, 9, 24, 6);
const mk = (over: Partial<RadarContribution> = {}): RadarContribution => ({ ...SAMPLE_CONTRIBUTION, timeBucket: '2026-10-24T06:00:00Z', ...over });
const pseud = (i: number) => i.toString(16).padStart(32, '0');
const ingestor = (limit = 1000) => new RadarIngest({ verifyToken: (t) => t.startsWith('ok-'), dailyLimitPerSource: limit, randomSalt: () => 'salt' });
const NOW = T0 + 7 * 3_600_000;

describe('ingestion', () => {
  it('accepts a valid envelope and counts it', () => {
    const i = ingestor();
    expect(i.ingest({ token: 'ok-1', pseudonym: pseud(1), contribution: mk() }, 's', NOW)).toEqual({ accepted: true });
    expect(i.counters.accepted).toBe(1);
    expect(i.size()).toBe(1);
  });

  it('gives callers a generic rejection while counting the real reason', () => {
    const i = ingestor();
    const bad = i.ingest({ token: 'ok-1', pseudonym: pseud(1), contribution: { ...mk(), prompt: 'x' } }, 's', NOW);
    expect(bad).toEqual({ accepted: false, reason: 'rejected' });
    expect(i.counters.rejected.schema).toBe(1);
    expect(i.ingest({ token: 'forged', pseudonym: pseud(1), contribution: mk() }, 's', NOW)).toEqual({ accepted: false, reason: 'rejected' });
    expect(i.counters.rejected.token_invalid).toBe(1);
    expect(i.ingest({ token: 'ok-1', pseudonym: 'not-hex', contribution: mk() }, 's', NOW).accepted).toBe(false);
    expect(i.counters.rejected.pseudonym).toBe(1);
    expect(i.ingest(null as never, 's', NOW).accepted).toBe(false);
    expect(i.ingest({ token: '', pseudonym: pseud(1), contribution: mk() }, 's', NOW).accepted).toBe(false);
  });

  it('spends a token once and ignores duplicate contributions from one pseudonym', () => {
    const i = ingestor();
    expect(i.ingest({ token: 'ok-1', pseudonym: pseud(1), contribution: mk() }, 's', NOW).accepted).toBe(true);
    expect(i.ingest({ token: 'ok-1', pseudonym: pseud(2), contribution: mk() }, 's', NOW).accepted).toBe(false);
    expect(i.counters.rejected.token_spent).toBe(1);
    expect(i.ingest({ token: 'ok-2', pseudonym: pseud(1), contribution: mk() }, 's', NOW).accepted).toBe(false);
    expect(i.counters.rejected.duplicate).toBe(1);
  });

  it('rejects future and stale buckets', () => {
    const i = ingestor();
    expect(i.ingest({ token: 'ok-1', pseudonym: pseud(1), contribution: mk({ timeBucket: '2026-10-25T00:00:00Z' }) }, 's', NOW).accepted).toBe(false);
    expect(i.ingest({ token: 'ok-2', pseudonym: pseud(2), contribution: mk({ timeBucket: '2026-10-12T00:00:00Z' }) }, 's', NOW).accepted).toBe(false);
    expect(i.counters.rejected.time_window).toBe(2);
  });

  it('rate limits per hashed source and resets daily', () => {
    const i = ingestor(2);
    const send = (n: number, now: number) => i.ingest({ token: `ok-${n}`, pseudonym: pseud(n), contribution: mk() }, 'same', now);
    expect(send(1, NOW).accepted).toBe(true);
    expect(send(2, NOW).accepted).toBe(true);
    expect(send(3, NOW)).toEqual({ accepted: false, reason: 'rate_limited' });
    expect(send(4, NOW + 86_400_000).accepted).toBe(true);
  });

  it('purges raw rows after seven days and nothing else is kept for them', () => {
    const i = ingestor();
    i.ingest({ token: 'ok-1', pseudonym: pseud(1), contribution: mk() }, 's', NOW);
    expect(i.purge(NOW + 6 * 86_400_000)).toBe(0);
    expect(i.purge(NOW + 8 * 86_400_000)).toBe(1);
    expect(i.size()).toBe(0);
    // the token and dedupe memory went with the row, so the same pseudonym may contribute again in a fresh window
    expect(i.ingest({ token: 'ok-1', pseudonym: pseud(1), contribution: mk({ timeBucket: '2026-11-01T00:00:00Z' }) }, 's', Date.UTC(2026, 10, 1, 7)).accepted).toBe(true);
  });

  it('never stores the source address', () => {
    const i = ingestor();
    i.ingest({ token: 'ok-1', pseudonym: pseud(1), contribution: mk() }, '203.0.113.9', NOW);
    expect(JSON.stringify(i.withRows((r) => r))).not.toContain('203.0.113.9');
    expect(JSON.stringify(i)).not.toContain('203.0.113.9');
  });
});

const rowsOf = (n: number, over: Partial<RadarContribution> = {}) => {
  const i = ingestor();
  for (let k = 0; k < n; k++) i.ingest({ token: `ok-${k}`, pseudonym: pseud(k), contribution: mk(over) }, `s${k}`, NOW);
  return i;
};

describe('aggregation', () => {
  it('counts distinct contributors and rates', () => {
    const i = ingestor();
    for (let k = 0; k < 10; k++) i.ingest({ token: `ok-${k}`, pseudonym: pseud(k), contribution: mk({ parserResult: k < 3 ? 'error' : 'ok', resetBehavior: k < 2 ? 'later' : 'as_expected' }) }, `s${k}`, NOW);
    const { rows } = i.withRows((r) => aggregateBucket(r, () => []));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.n).toBe(10);
    expect(rows[0]!.rates.error).toBeCloseTo(0.3);
    expect(rows[0]!.rates.resetDeviation).toBeCloseTo(0.2);
  });

  it('counts a pseudonym once per cohort even if rows repeat', () => {
    const rows = [0, 1].map((k) => ({ contribution: mk(), pseudonymHash: 'same', receivedAt: NOW + k }));
    expect(aggregateBucket(rows, () => []).rows[0]!.n).toBe(1);
  });

  it('quarantines a cohort that jumps past five times its trailing median', () => {
    const i = rowsOf(120);
    const hist = [20, 22, 21, 19];
    const r = i.withRows((rows) => aggregateBucket(rows, () => hist));
    expect(r.rows).toHaveLength(0);
    expect(r.quarantined).toBe(1);
    expect(i.withRows((rows) => aggregateBucket(rows, () => [20, 22])).rows).toHaveLength(1); // too little history to judge
    expect(i.withRows((rows) => aggregateBucket(rows, () => hist.map((x) => x * 10))).rows).toHaveLength(1);
  });

  const agg = (n: number, over: Partial<AggregateRow> = {}): AggregateRow => ({ provider: 'claude', planType: 'free', regionBucket: 'emea', windowType: 'rolling_5h', timeBucket: '2026-10-24T06:00:00Z', n, rates: { schemaMismatch: 0, missingFields: 0, error: 0, resetDeviation: 0 }, ...over });

  it('suppresses cohorts below the minimum and never publishes them', () => {
    const { published, suppressed } = suppress([agg(MIN_COHORT_SIZE - 1, { windowType: 'daily' }), agg(MIN_COHORT_SIZE - 1, { provider: 'chatgpt' })]);
    expect(published).toEqual([]);
    expect(suppressed).toBe(2);
    expect(suppress([agg(MIN_COHORT_SIZE)]).published).toHaveLength(1);
  });

  it('complementary-suppresses the smallest sibling when exactly one sibling is suppressed', () => {
    const rows = [agg(5, { windowType: 'daily' }), agg(30, { windowType: 'weekly' }), agg(90, { windowType: 'rolling_5h' })];
    const { published } = suppress(rows);
    expect(published.map((r) => r.windowType)).toEqual(['rolling_5h']);
    // two suppressed siblings cannot be recovered by subtraction from one another, so no extra suppression
    const two = suppress([agg(5, { windowType: 'daily' }), agg(6, { windowType: 'monthly' }), agg(30, { windowType: 'weekly' }), agg(90, { windowType: 'rolling_5h' })]);
    expect(two.published).toHaveLength(2);
  });

  it('enforces the per-cohort privacy budget', () => {
    const b = new PrivacyBudget(3, 1);
    expect(b.spend('c')).toBeCloseTo(1 / 3);
    b.spend('c');
    b.spend('c');
    expect(b.spend('c')).toBeNull();
    expect(b.used('c')).toBe(3);
    const rows = [agg(100)];
    const budget = new PrivacyBudget(1, 1);
    expect(publish(rows, budget, mulberry32(1))).toHaveLength(1);
    expect(publish(rows, budget, mulberry32(1))).toHaveLength(0);
  });

  it('adds zero-mean noise that shrinks with cohort size and clamps to [0,1]', () => {
    const rng = mulberry32(5);
    const spread = (n: number) => { const xs = Array.from({ length: 2000 }, () => noisyRate(n / 2, n, 1 / 3, rng) - 0.5); return Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length); };
    expect(spread(25)).toBeGreaterThan(spread(400) * 4);
    const clamp = Array.from({ length: 500 }, () => noisyRate(0, 20, 1 / 3, rng));
    expect(Math.min(...clamp)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...Array.from({ length: 500 }, () => noisyRate(20, 20, 1 / 3, rng)))).toBeLessThanOrEqual(1);
    expect(Math.abs(Array.from({ length: 4000 }, () => laplace(1, rng)).reduce((a, x) => a + x, 0) / 4000)).toBeLessThan(0.1);
    expect(Number.isFinite(laplace(1, () => 0))).toBe(true);
    expect(Number.isFinite(laplace(1, () => 1))).toBe(true);
  });

  it('computes medians', () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('detection', () => {
  const series = (vals: number[], over: Partial<AggregateRow> = {}) => vals.map((v, i) => ({
    provider: 'claude' as const, planType: 'free' as const, regionBucket: 'emea' as const, windowType: 'rolling_5h' as const,
    timeBucket: new Date(Date.UTC(2026, 9, 1) + i * 6 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), n: 200,
    rates: { schemaMismatch: v, missingFields: 0, error: 0, resetDeviation: 0 }, ...over,
  }));
  const NOW2 = Date.UTC(2026, 9, 10);

  it('stays quiet on a flat series and on a single spike', () => {
    expect(detectIncidents(series([0, 0.01, 0, 0.01, 0, 0, 0.01, 0]), NOW2)).toEqual([]);
    expect(detectIncidents(series([0, 0, 0, 0, 0, 0.9, 0, 0, 0]), NOW2)).toEqual([]);
  });

  it('needs a baseline before it will alert', () => {
    expect(detectIncidents(series([0.9, 0.9, 0.9]), NOW2)).toEqual([]);
  });

  it('opens an incident after two elevated buckets and closes it after two normal ones', () => {
    const open = detectIncidents(series([0, 0, 0, 0, 0.8, 0.8]), NOW2);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'parser_failure', status: 'active', sampleBand: '200+', provider: 'claude' });
    expect(open[0]!.firstObserved).toBe('2026-10-02T00:00:00Z');
    const closed = detectIncidents(series([0, 0, 0, 0, 0.8, 0.8, 0, 0]), NOW2);
    expect(closed[0]!.status).toBe('resolved');
  });

  it('raises confidence with cohort size, consistency, recency and data quality', () => {
    const big = detectIncidents(series([0, 0, 0, 0, 0.9, 0.9]), Date.UTC(2026, 9, 2, 12))[0]!.confidence;
    const small = detectIncidents(series([0, 0, 0, 0, 0.9, 0.9], { n: 25 }), Date.UTC(2026, 9, 2, 12))[0]!.confidence;
    const stale = detectIncidents(series([0, 0, 0, 0, 0.9, 0.9]), Date.UTC(2026, 9, 12))[0]!.confidence;
    const dirty = detectIncidents(series([0, 0, 0, 0, 0.9, 0.9]), Date.UTC(2026, 9, 2, 12), { dataQuality: 0.4 })[0]!.confidence;
    expect(big).toBeGreaterThan(small);
    expect(big).toBeGreaterThan(stale);
    expect(big).toBeGreaterThan(dirty);
    expect(big).toBeLessThanOrEqual(1);
  });

  it('ignores a rise that is inside the published noise of a small cohort', () => {
    expect(detectIncidents(series([0, 0, 0, 0, 0.25, 0.25], { n: 20 }), NOW2)).toEqual([]);
    expect(detectIncidents(series([0, 0, 0, 0, 0.25, 0.25], { n: 400 }), NOW2)).toHaveLength(1);
  });

  it('labels a single-region problem as a plan or region anomaly and a global one by its signal', () => {
    const emea = series([0, 0, 0, 0, 0.8, 0.8]);
    const amer = series([0, 0, 0, 0, 0, 0], { regionBucket: 'americas' });
    expect(detectIncidents([...emea, ...amer], NOW2)[0]!.kind).toBe('plan_region_anomaly');
    const both = detectIncidents([...emea, ...series([0, 0, 0, 0, 0.8, 0.8], { regionBucket: 'americas' })], NOW2);
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ kind: 'parser_failure', regionBuckets: ['americas', 'emea'] });
  });

  it('detects a window-share shift as a quota change', () => {
    const rows: ReturnType<typeof series> = [];
    for (let i = 0; i < 8; i++) {
      const shift = i >= 5;
      rows.push(...series([0], {}).map((r) => ({ ...r, timeBucket: new Date(Date.UTC(2026, 9, 1) + i * 6 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), n: shift ? 40 : 160 })));
      rows.push(...series([0], { windowType: 'daily' }).map((r) => ({ ...r, timeBucket: new Date(Date.UTC(2026, 9, 1) + i * 6 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), n: shift ? 160 : 40 })));
    }
    const inc = detectIncidents(rows, NOW2);
    expect(inc.some((i) => i.kind === 'quota_window_change')).toBe(true);
  });

  it('is deterministic', () => {
    const rows = series([0, 0, 0, 0, 0.8, 0.8]);
    expect(detectIncidents(rows, NOW2)).toEqual(detectIncidents([...rows].reverse(), NOW2));
  });
});

describe('pipeline and simulation', () => {
  it('publishes closed buckets only, once, and exposes bands rather than counts', () => {
    const p = new RadarPipeline({ verifyToken: () => true, dailyLimitPerSource: 1e6 }, mulberry32(1));
    for (let k = 0; k < 40; k++) p.ingest({ token: `t${k}`, pseudonym: pseud(k), contribution: mk() }, `s${k}`, NOW);
    p.tick(T0 + 3_600_000); // bucket still open
    expect(p.publishedRowCount()).toBe(0);
    p.tick(T0 + 8 * 3_600_000);
    expect(p.publishedRowCount()).toBe(1);
    p.tick(T0 + 9 * 3_600_000);
    expect(p.metrics.bucketsPublished).toBe(1);
    expect(JSON.stringify(p.incidents(NOW))).not.toMatch(/pseudonym|token|"n":/);
  });

  it('expires aggregates after ninety days', () => {
    const p = new RadarPipeline({ verifyToken: () => true, dailyLimitPerSource: 1e6 }, mulberry32(1));
    for (let k = 0; k < 40; k++) p.ingest({ token: `t${k}`, pseudonym: pseud(k), contribution: mk() }, `s${k}`, NOW);
    p.tick(T0 + 8 * 3_600_000);
    p.tick(T0 + 91 * 86_400_000);
    expect(p.publishedRowCount()).toBe(0);
  });

  const scenarios: Scenario[] = [
    { provider: 'claude', effect: 'schema_removal', startTick: 14, durationTicks: 8 },
    { provider: 'chatgpt', effect: 'provider_outage', startTick: 26, durationTicks: 8 },
    { provider: 'claude', effect: 'reset_window_change', startTick: 38, durationTicks: 8 },
    { provider: 'chatgpt', effect: 'missing_fields', startTick: 50, durationTicks: 8, region: 'emea' },
    { provider: 'claude', effect: 'quota_correction', startTick: 62, durationTicks: 8 },
  ];

  it('replays identically for the same seed', () => {
    const cfg = { seed: 11, ticks: 24, contributorsPerSeries: 40, scenarios: [{ provider: 'claude', effect: 'provider_outage', startTick: 12, durationTicks: 6 }] as Scenario[], providers: ['claude' as const], plans: ['free' as const], regions: ['emea' as const] };
    expect(runSimulation(cfg)).toEqual(runSimulation(cfg));
  });

  it('detects synthetic incidents quickly with few false alerts', { timeout: 120_000 }, () => {
    const reports = [1, 2, 3].map((seed) => runSimulation({ seed, ticks: 76, contributorsPerSeries: 100, scenarios }));
    const raised = reports.reduce((a, r) => a + r.incidentsRaised, 0);
    const tp = reports.reduce((a, r) => a + r.truePositives, 0);
    const found = reports.reduce((a, r) => a + r.detected, 0);
    expect(tp / raised).toBeGreaterThanOrEqual(0.8);
    expect(found / (reports.length * scenarios.length)).toBeGreaterThanOrEqual(0.8);
    for (const r of reports) for (const h of r.timeToDetectionHours) expect(h).toBeLessThanOrEqual(12);
  });

  it('raises nothing on quiet traffic and quarantines a poisoning burst', { timeout: 120_000 }, () => {
    const quiet = runSimulation({ seed: 21, ticks: 60, contributorsPerSeries: 100, scenarios: [] });
    expect(quiet.incidentsRaised).toBe(0);
    const poisoned = runSimulation({ seed: 22, ticks: 36, contributorsPerSeries: 100, scenarios: [], poisonTick: 24 });
    expect(poisoned.quarantined).toBeGreaterThanOrEqual(1);
    expect(poisoned.incidentsRaised).toBe(0);
  });

  it('suppresses everything when cohorts are too small, so nothing can be detected or leaked', { timeout: 60_000 }, () => {
    const r = runSimulation({ seed: 5, ticks: 30, contributorsPerSeries: 10, scenarios: [{ provider: 'claude', effect: 'provider_outage', startTick: 16, durationTicks: 8 }] });
    expect(r.incidentsRaised).toBe(0);
    expect(r.suppressed).toBeGreaterThan(0);
  });
});

// Replayable Radar simulation (prompt 4.2). Synthetic contributors drive the real ingest/aggregate/detect path with a
// seeded PRNG, so a seed reproduces the same precision, recall, time-to-detection and false-alert numbers.
import { createHash } from 'node:crypto';
import { RADAR_SCHEMA_VERSION, type RadarContribution } from './contribution.js';
import { RadarPipeline } from './pipeline.js';
import type { IncidentKind } from './detect.js';
import type { DetectOptions } from './detect.js';

const HOUR = 3_600_000;
const BUCKET = 6 * HOUR;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Provider = RadarContribution['provider'];
type Plan = RadarContribution['planType'];
type Region = RadarContribution['regionBucket'];

export type Effect =
  | { type: 'schema_removal' } | { type: 'missing_fields' } | { type: 'provider_outage' } | { type: 'reset_window_change' } | { type: 'quota_correction' };

export interface Scenario {
  provider: Provider;
  effect: Effect['type'];
  /** First affected tick (0-based) and number of ticks the change persists. */
  startTick: number;
  durationTicks: number;
  /** Restrict to one region or plan; omit for all. */
  region?: Region;
  plan?: Plan;
}

export interface SimConfig {
  seed: number;
  ticks: number;
  contributorsPerSeries: number;
  scenarios: Scenario[];
  providers?: Provider[];
  plans?: Plan[];
  regions?: Region[];
  detect?: Partial<DetectOptions>;
  startMs?: number;
  /** Fraction of contributions that are poisoning submissions from one cohort at `poisonTick` (0 disables). */
  poisonTick?: number;
}

const EXPECTED: Record<Effect['type'], IncidentKind> = {
  schema_removal: 'parser_failure', missing_fields: 'missing_fields', provider_outage: 'provider_error_spike',
  reset_window_change: 'reset_pattern_change', quota_correction: 'quota_window_change',
};

export interface SimReport {
  seed: number;
  incidentsRaised: number;
  truePositives: number;
  falseAlerts: number;
  scenarios: number;
  detected: number;
  precision: number;
  recall: number;
  /** Per detected scenario, hours from the first affected bucket to the tick at which the incident first appeared. */
  timeToDetectionHours: number[];
  meanTimeToDetectionHours: number | null;
  /** False alerts per 100 series-days of simulated traffic. */
  falseAlertsPer100SeriesDays: number;
  quarantined: number;
  suppressed: number;
}

const hex = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);

function pick<T>(rng: () => number, weighted: readonly (readonly [T, number])[]): T {
  const total = weighted.reduce((a, [, w]) => a + w, 0);
  let x = rng() * total;
  for (const [v, w] of weighted) { if ((x -= w) < 0) return v; }
  return weighted[weighted.length - 1]![0];
}

export function runSimulation(cfg: SimConfig): SimReport {
  const rng = mulberry32(cfg.seed);
  const noiseRng = mulberry32(cfg.seed ^ 0x9e3779b9);
  const providers = cfg.providers ?? ['claude', 'chatgpt'];
  const plans = cfg.plans ?? ['free', 'individual_paid'];
  const regions = cfg.regions ?? ['americas', 'emea'];
  const start = cfg.startMs ?? Date.UTC(2026, 9, 1);
  const pipe = new RadarPipeline({ verifyToken: () => true, dailyLimitPerSource: 1_000_000 }, noiseRng, cfg.detect);
  let tokenSeq = 0;
  const allIncidents: { id: string; kind: IncidentKind; provider: Provider; firstObserved: string; tick: number }[] = [];
  const seen = new Set<string>();

  for (let tick = 0; tick < cfg.ticks; tick++) {
    const bucketStart = start + tick * BUCKET;
    const bucketIso = new Date(bucketStart).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const sendAt = bucketStart + BUCKET - 1;
    for (const provider of providers) for (const planType of plans) for (const regionBucket of regions) {
      // quota_correction moves traffic between window types; everything else keeps rolling_5h plus a small daily stream.
      const sc = cfg.scenarios.filter((s) => s.provider === provider && tick >= s.startTick && tick < s.startTick + s.durationTicks
        && (!s.region || s.region === regionBucket) && (!s.plan || s.plan === planType));
      const effect = (e: Effect['type']) => sc.some((s) => s.effect === e);
      for (let i = 0; i < cfg.contributorsPerSeries; i++) {
        const person = `${provider}|${planType}|${regionBucket}|${i}`;
        const switched = effect('quota_correction') && rng() < 0.7;
        const windowType: RadarContribution['windowType'] = switched ? 'daily' : (i % 4 === 0 ? 'daily' : 'rolling_5h');
        const parserResult = effect('schema_removal') && rng() < 0.85 ? 'schema_mismatch'
          : effect('missing_fields') && rng() < 0.8 ? 'missing_fields'
          : effect('provider_outage') && rng() < 0.75 ? 'error'
          : pick<RadarContribution['parserResult']>(rng, [['ok', 0.96], ['partial', 0.02], ['missing_fields', 0.005], ['schema_mismatch', 0.005], ['error', 0.01]]);
        const resetBehavior = effect('reset_window_change') && rng() < 0.8 ? 'later'
          : pick<RadarContribution['resetBehavior']>(rng, [['as_expected', 0.95], ['earlier', 0.02], ['later', 0.02], ['unknown', 0.01]]);
        const contribution: RadarContribution = {
          schemaVersion: RADAR_SCHEMA_VERSION, provider, planType, regionBucket, windowType,
          schemaSignature: hex(`sig|${provider}|${effect('schema_removal') ? 'v2' : 'v1'}`, 16), parserResult, resetBehavior,
          extensionVersion: '0.1.1', timeBucket: bucketIso,
        };
        pipe.ingest({ token: `t${tokenSeq++}`, pseudonym: hex(person, 32), contribution }, `src-${tokenSeq}`, sendAt);
      }
    }
    if (cfg.poisonTick === tick) {
      // 40x the usual cohort size from one cohort, as many different pseudonyms: must be quarantined, not counted.
      const p = providers[0]!;
      for (let i = 0; i < cfg.contributorsPerSeries * 40; i++) {
        pipe.ingest({
          token: `t${tokenSeq++}`, pseudonym: hex(`poison|${i}`, 32),
          contribution: { schemaVersion: RADAR_SCHEMA_VERSION, provider: p, planType: plans[0]!, regionBucket: regions[0]!, windowType: 'rolling_5h', schemaSignature: hex('x', 16), parserResult: 'error', resetBehavior: 'unknown', extensionVersion: '0.1.1', timeBucket: bucketIso },
        }, `p-${i}`, sendAt);
      }
    }
    const now = bucketStart + BUCKET + 2 * HOUR;
    pipe.tick(now);
    for (const inc of pipe.incidents(now)) {
      if (seen.has(inc.id)) continue;
      seen.add(inc.id);
      allIncidents.push({ id: inc.id, kind: inc.kind, provider: inc.provider, firstObserved: inc.firstObserved, tick });
    }
  }


  // Score: an incident is true when it matches a scenario by provider and expected kind, starting no earlier than the
  // scenario and before it ends. A scenario limited to one region/plan is expected as plan_region_anomaly.
  const truthful = new Set<string>();
  const ttd: number[] = [];
  for (const s of cfg.scenarios) {
    const narrow = (s.region || s.plan) && s.effect !== 'quota_correction' && (regions.length >= 2 || plans.length >= 2);
    const expected = narrow ? 'plan_region_anomaly' : EXPECTED[s.effect];
    const t0 = start + s.startTick * BUCKET;
    const t1 = t0 + s.durationTicks * BUCKET;
    const hits = allIncidents.filter((i) => i.provider === s.provider && i.kind === expected && Date.parse(i.firstObserved) >= t0 && Date.parse(i.firstObserved) < t1);
    for (const h of hits) truthful.add(h.id);
    if (hits.length) ttd.push((Math.min(...hits.map((h) => h.tick)) - s.startTick) * BUCKET / HOUR);
  }
  const tp = truthful.size;
  const falseAlerts = allIncidents.length - tp;
  const seriesDays = providers.length * plans.length * regions.length * (cfg.ticks / 4);
  return {
    seed: cfg.seed, incidentsRaised: allIncidents.length, truePositives: tp, falseAlerts, scenarios: cfg.scenarios.length, detected: ttd.length,
    precision: allIncidents.length ? tp / allIncidents.length : 1,
    recall: cfg.scenarios.length ? ttd.length / cfg.scenarios.length : 1,
    timeToDetectionHours: ttd, meanTimeToDetectionHours: ttd.length ? ttd.reduce((a, b) => a + b, 0) / ttd.length : null,
    falseAlertsPer100SeriesDays: (falseAlerts / seriesDays) * 100,
    quarantined: pipe.metrics.cohortsQuarantined, suppressed: pipe.metrics.cohortsSuppressed,
  };
}

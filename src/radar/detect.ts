// Limit Change Radar anomaly rules (prompt 4.2). Transparent baseline-and-threshold rules over published (noised,
// thresholded) cohorts. No learned model: every incident can be explained by "rate X rose by Y over baseline for K buckets".
import { BUCKET_HOURS, sampleBand, type Provider, type RadarContribution } from './contribution.js';
import { DAILY_EPSILON, MAX_VIEWS, median, RATE_NAMES, seriesId, type PublishedRow, type Rates } from './aggregate.js';

export const INCIDENT_KINDS = ['parser_failure', 'missing_fields', 'reset_pattern_change', 'quota_window_change', 'provider_error_spike', 'plan_region_anomaly'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export interface DetectOptions {
  /** Minimum rise over baseline for a rate to count as elevated. */
  rateDelta: number;
  /** Minimum shift in a window type's share of a series' contributors. */
  shareDelta: number;
  /** Consecutive elevated buckets required to open an incident, and normal buckets required to close it. */
  confirmBuckets: number;
  /** Prior normal buckets needed before a series can alert, and the most that feed the baseline. */
  minBaseline: number;
  maxBaseline: number;
  /** Fraction of accepted contributions that survived validation and quarantine, for the confidence data-quality term. */
  dataQuality: number;
  /** Rates carry Laplace noise of scale 1/(n*epsilonPerView); a rise must also exceed noiseMultiple times that scale. */
  epsilonPerView: number;
  noiseMultiple: number;
}

export const DEFAULT_DETECT: DetectOptions = { rateDelta: 0.2, shareDelta: 0.3, confirmBuckets: 2, minBaseline: 4, maxBaseline: 8, dataQuality: 1, epsilonPerView: DAILY_EPSILON / MAX_VIEWS, noiseMultiple: 4 };

export interface Incident {
  id: string;
  kind: IncidentKind;
  provider: Provider;
  planTypes: RadarContribution['planType'][];
  regionBuckets: RadarContribution['regionBucket'][];
  windowTypes: RadarContribution['windowType'][];
  firstObserved: string;
  lastObserved: string;
  status: 'active' | 'resolved';
  /** 0..1 from cohort size, consistency, recency and data quality. */
  confidence: number;
  sampleBand: ReturnType<typeof sampleBand>;
  /** Plain-language reason, safe to show: it names rates and thresholds, never contributors. */
  evidence: string;
}

interface Point { t: string; v: number; n: number; /** Noise scale of v; 0 for exact values. */ noise: number }
interface Run { start: string; last: string; excess: number[]; ns: number[]; active: boolean }

/** Chronological state machine: baseline from recent normal points, open after K elevated, close after K normal. */
function scan(points: readonly Point[], delta: number, o: DetectOptions, twoSided: boolean): Run[] {
  const runs: Run[] = [];
  const normal: number[] = [];
  let pending: Point[] = [];
  let open: Run | null = null;
  let calm = 0;
  for (const p of points) {
    const base = median(normal.slice(-o.maxBaseline));
    const ready = normal.length >= o.minBaseline || open !== null;
    const diff = twoSided ? Math.abs(p.v - base) : p.v - base;
    const elevated = ready && diff >= Math.max(delta, o.noiseMultiple * p.noise);
    if (open) {
      if (elevated) { open.last = p.t; open.excess.push(diff); open.ns.push(p.n); calm = 0; }
      else if (++calm >= o.confirmBuckets) { open.active = false; open = null; calm = 0; normal.push(p.v); }
      continue;
    }
    if (elevated) {
      pending.push(p);
      if (pending.length >= o.confirmBuckets) {
        open = { start: pending[0]!.t, last: p.t, excess: pending.map(() => diff), ns: pending.map((x) => x.n), active: true };
        runs.push(open);
        pending = [];
        calm = 0;
      }
    } else {
      pending = [];
      normal.push(p.v);
    }
  }
  return runs;
}

const KIND_FOR_RATE: Record<keyof Rates, IncidentKind> = {
  schemaMismatch: 'parser_failure', missingFields: 'missing_fields', error: 'provider_error_spike', resetDeviation: 'reset_pattern_change',
};

interface Alert { kind: IncidentKind; signal: string; row: SeriesInfo; run: Run }
interface SeriesInfo { provider: Provider; planType: RadarContribution['planType']; regionBucket: RadarContribution['regionBucket']; windowType: RadarContribution['windowType'] }

function confidence(run: Run, nowMs: number, o: DetectOptions, delta: number): number {
  const meanN = run.ns.reduce((a, b) => a + b, 0) / run.ns.length;
  const size = Math.min(1, meanN / 200);
  const consistency = run.excess.reduce((a, e) => a + Math.min(1, e / (2 * delta)), 0) / run.excess.length;
  const ageHours = Math.max(0, (nowMs - (Date.parse(run.last) + BUCKET_HOURS * 3_600_000)) / 3_600_000);
  const recency = Math.pow(0.5, ageHours / 24);
  const c = 0.35 * size + 0.3 * consistency + 0.15 * recency + 0.2 * o.dataQuality;
  return Math.round(Math.min(1, Math.max(0, c)) * 100) / 100;
}

/** Detect incidents over all published rows. Pure and deterministic: same rows and `now` give the same incidents. */
export function detectIncidents(rows: readonly PublishedRow[], now: number, opts: Partial<DetectOptions> = {}): Incident[] {
  const o = { ...DEFAULT_DETECT, ...opts };
  const bySeries = new Map<string, PublishedRow[]>();
  const byGroup = new Map<string, PublishedRow[]>();
  for (const r of rows) {
    (bySeries.get(seriesId(r)) ?? bySeries.set(seriesId(r), []).get(seriesId(r))!).push(r);
    const g = `${r.provider}|${r.planType}|${r.regionBucket}`;
    (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(r);
  }
  const alerts: (Alert & { delta: number })[] = [];
  for (const list of bySeries.values()) {
    list.sort((a, b) => a.timeBucket.localeCompare(b.timeBucket));
    const info: SeriesInfo = list[0]!;
    for (const name of RATE_NAMES) {
      const pts = list.map((r) => ({ t: r.timeBucket, v: r.rates[name], n: r.n, noise: 1 / (r.n * o.epsilonPerView) }));
      for (const run of scan(pts, o.rateDelta, o, false)) alerts.push({ kind: KIND_FOR_RATE[name], signal: name, row: info, run, delta: o.rateDelta });
    }
  }
  // Quota/window changes: a window type's share of a provider/plan/region group moves sharply.
  for (const list of byGroup.values()) {
    const times = [...new Set(list.map((r) => r.timeBucket))].sort();
    const windows = [...new Set(list.map((r) => r.windowType))];
    if (windows.length < 2) continue;
    for (const w of windows) {
      const pts: Point[] = times.map((t) => {
        const at = list.filter((r) => r.timeBucket === t);
        const total = at.reduce((a, r) => a + r.n, 0);
        const mine = at.find((r) => r.windowType === w);
        return { t, v: total ? (mine?.n ?? 0) / total : 0, n: mine?.n ?? 0, noise: 0 };
      });
      for (const run of scan(pts, o.shareDelta, o, true)) alerts.push({ kind: 'quota_window_change', signal: `windowShare:${w}`, row: list.find((r) => r.windowType === w) ?? list[0]!, run, delta: o.shareDelta });
    }
  }
  return merge(alerts, rows, now, o);
}

/** Merge series alerts that overlap in time for the same provider and signal; classify scope. */
function merge(alerts: (Alert & { delta: number })[], rows: readonly PublishedRow[], now: number, o: DetectOptions): Incident[] {
  const latest = rows.reduce((m, r) => (r.timeBucket > m ? r.timeBucket : m), '');
  const groups: (Alert & { delta: number })[][] = [];
  for (const a of alerts.sort((x, y) => x.run.start.localeCompare(y.run.start))) {
    const slack = BUCKET_HOURS * 3_600_000 * o.confirmBuckets;
    const g = groups.find((grp) => grp[0]!.row.provider === a.row.provider && grp[0]!.kind === a.kind && grp[0]!.signal === a.signal
      && Math.abs(Date.parse(grp[0]!.run.start) - Date.parse(a.run.start)) <= slack);
    if (g) g.push(a); else groups.push([a]);
  }
  const incidents: Incident[] = groups.map((g) => {
    const provider = g[0]!.row.provider;
    const providerRows = rows.filter((r) => r.provider === provider);
    const allPlans = new Set(providerRows.map((r) => r.planType));
    const allRegions = new Set(providerRows.map((r) => r.regionBucket));
    const plans = [...new Set(g.map((a) => a.row.planType))].sort();
    const regions = [...new Set(g.map((a) => a.row.regionBucket))].sort();
    const windows = [...new Set(g.map((a) => a.row.windowType))].sort();
    const narrow = g[0]!.kind !== 'quota_window_change' && ((allRegions.size >= 2 && regions.length === 1) || (allPlans.size >= 2 && plans.length === 1));
    const start = g.map((a) => a.run.start).sort()[0]!;
    const last = g.map((a) => a.run.last).sort().slice(-1)[0]!;
    const conf = Math.max(...g.map((a) => confidence(a.run, now, o, a.delta)));
    const minN = Math.min(...g.flatMap((a) => a.run.ns));
    const kind = narrow ? 'plan_region_anomaly' : g[0]!.kind;
    return {
      id: `${provider}:${kind}:${start}`, kind, provider, planTypes: plans, regionBuckets: regions, windowTypes: windows,
      firstObserved: start, lastObserved: last, status: g.some((a) => a.run.active) && last >= latest ? 'active' : 'resolved',
      confidence: conf, sampleBand: sampleBand(minN),
      evidence: `${g[0]!.signal} differed from its recent baseline by at least ${g[0]!.delta} for ${Math.max(...g.map((a) => a.run.excess.length))}+ consecutive 6-hour windows`,
    } satisfies Incident;
  });
  return incidents.sort((a, b) => a.firstObserved.localeCompare(b.firstObserved) || a.id.localeCompare(b.id));
}

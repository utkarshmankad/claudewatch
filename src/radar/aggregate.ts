// Limit Change Radar aggregation (prompt 4.2): cohorts, poisoning quarantine, minimum-cohort and complementary
// suppression, and noise under a per-cohort privacy budget. Anything published is a PublishedRow; AggregateRow is internal.
import { MIN_COHORT_SIZE, sampleBand, type RadarContribution } from './contribution.js';
import type { RawRow } from './ingest.js';

export const QUARANTINE_FACTOR = 5;
export const QUARANTINE_HISTORY = 8;
export const QUARANTINE_MIN_HISTORY = 3;
/** Daily epsilon per cohort, spread over at most MAX_VIEWS releases (design section 4). */
export const DAILY_EPSILON = 1.0;
export const MAX_VIEWS = 3;

export type Rng = () => number;

export interface SeriesKey { provider: RadarContribution['provider']; planType: RadarContribution['planType']; regionBucket: RadarContribution['regionBucket']; windowType: RadarContribution['windowType'] }
export interface CohortKey extends SeriesKey { timeBucket: string }

export const seriesId = (k: SeriesKey) => `${k.provider}|${k.planType}|${k.regionBucket}|${k.windowType}`;
export const cohortId = (k: CohortKey) => `${seriesId(k)}|${k.timeBucket}`;

export interface Rates { schemaMismatch: number; missingFields: number; error: number; resetDeviation: number }
export const RATE_NAMES = ['schemaMismatch', 'missingFields', 'error', 'resetDeviation'] as const;

/** Exact, internal. Never leaves the aggregation job. */
export interface AggregateRow extends CohortKey { n: number; rates: Rates }

/** What may be released: noised rates, and exact n kept only for the in-process detector (incidents expose a band). */
export interface PublishedRow extends CohortKey { n: number; rates: Rates }

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Laplace(0, scale) via inverse CDF. */
export function laplace(scale: number, rng: Rng): number {
  const u = Math.min(0.499999999, Math.max(-0.499999999, rng() - 0.5));
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

/** Noise a count/n rate. One contributor moves the rate by at most 1/n, so scale = (1/n) / epsilonPerView. */
export function noisyRate(count: number, n: number, epsilonPerView: number, rng: Rng): number {
  const r = count / n + laplace(1 / (n * epsilonPerView), rng);
  return Math.min(1, Math.max(0, r));
}

/**
 * Aggregate the raw rows of ONE closed time bucket. A contributor counts once per cohort (the ingest dedupe also enforces this).
 * `history(series)` returns the distinct-contributor counts of that series' previous published buckets, newest last.
 */
export function aggregateBucket(rows: readonly RawRow[], history: (series: string) => readonly number[]): { rows: AggregateRow[]; quarantined: number } {
  const groups = new Map<string, { key: CohortKey; people: Map<string, RadarContribution> }>();
  for (const r of rows) {
    const c = r.contribution;
    const key: CohortKey = { provider: c.provider, planType: c.planType, regionBucket: c.regionBucket, windowType: c.windowType, timeBucket: c.timeBucket };
    const id = cohortId(key);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { key, people: new Map() }));
    if (!g.people.has(r.pseudonymHash)) g.people.set(r.pseudonymHash, c);
  }
  const out: AggregateRow[] = [];
  let quarantined = 0;
  for (const g of groups.values()) {
    const n = g.people.size;
    const past = history(seriesId(g.key)).slice(-QUARANTINE_HISTORY);
    const base = median(past);
    // Poisoning defence: a cohort that jumps well past its own trailing median is held back, not counted.
    if (past.length >= QUARANTINE_MIN_HISTORY && base > 0 && n > QUARANTINE_FACTOR * base) { quarantined++; continue; }
    let schemaMismatch = 0, missingFields = 0, error = 0, resetDeviation = 0;
    for (const c of g.people.values()) {
      if (c.parserResult === 'schema_mismatch') schemaMismatch++;
      else if (c.parserResult === 'missing_fields') missingFields++;
      else if (c.parserResult === 'error') error++;
      if (c.resetBehavior === 'earlier' || c.resetBehavior === 'later' || c.resetBehavior === 'absent') resetDeviation++;
    }
    out.push({ ...g.key, n, rates: { schemaMismatch: schemaMismatch / n, missingFields: missingFields / n, error: error / n, resetDeviation: resetDeviation / n } });
  }
  return { rows: out.sort((a, b) => cohortId(a).localeCompare(cohortId(b))), quarantined };
}

/** Drop cohorts below MIN_COHORT_SIZE, then complementary-suppress so a lone suppressed sibling cannot be recovered by subtraction. */
export function suppress(rows: readonly AggregateRow[]): { published: AggregateRow[]; suppressed: number } {
  const siblings = new Map<string, AggregateRow[]>();
  for (const r of rows) {
    const k = `${r.provider}|${r.timeBucket}|${r.planType}|${r.regionBucket}`;
    (siblings.get(k) ?? siblings.set(k, []).get(k)!).push(r);
  }
  const keep = new Set<AggregateRow>();
  let suppressed = 0;
  for (const group of siblings.values()) {
    const ok = group.filter((r) => r.n >= MIN_COHORT_SIZE);
    suppressed += group.length - ok.length;
    if (group.length - ok.length === 1 && ok.length > 0) {
      ok.sort((a, b) => a.n - b.n || cohortId(a).localeCompare(cohortId(b)));
      ok.shift();
      suppressed++;
    }
    for (const r of ok) keep.add(r);
  }
  return { published: rows.filter((r) => keep.has(r)), suppressed };
}

/** Tracks releases per cohort; a cohort gets MAX_VIEWS releases sharing DAILY_EPSILON, then nothing more. */
export class PrivacyBudget {
  private views = new Map<string, number>();
  constructor(private readonly maxViews = MAX_VIEWS, private readonly epsilon = DAILY_EPSILON) {}

  /** Epsilon for this release, or null when the cohort's budget is spent. */
  spend(cohort: string): number | null {
    const used = this.views.get(cohort) ?? 0;
    if (used >= this.maxViews) return null;
    this.views.set(cohort, used + 1);
    return this.epsilon / this.maxViews;
  }

  used(cohort: string): number {
    return this.views.get(cohort) ?? 0;
  }
}

/** Apply noise and spend budget for each suppressed-and-surviving cohort. Cohorts with no budget are withheld. */
export function publish(rows: readonly AggregateRow[], budget: PrivacyBudget, rng: Rng): PublishedRow[] {
  const out: PublishedRow[] = [];
  for (const r of rows) {
    const eps = budget.spend(cohortId(r));
    if (eps === null) continue;
    const noisy = (x: number) => noisyRate(Math.round(x * r.n), r.n, eps, rng);
    out.push({ ...r, rates: { schemaMismatch: noisy(r.rates.schemaMismatch), missingFields: noisy(r.rates.missingFields), error: noisy(r.rates.error), resetDeviation: noisy(r.rates.resetDeviation) } });
  }
  return out;
}

/** The only cohort-size figure that may reach a UI or feed. */
export const publicBand = (n: number) => sampleBand(n);

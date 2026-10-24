// Limit Change Radar pipeline (prompt 4.2): ingest -> close buckets -> aggregate -> suppress -> noise -> detect.
// Not wired to any endpoint or the extension yet; 4.3 consumes `incidents()`.
import { BUCKET_HOURS, RETENTION_DAYS } from './contribution.js';
import { aggregateBucket, cohortId, publish, PrivacyBudget, seriesId, suppress, type PublishedRow, type Rng } from './aggregate.js';
import { detectIncidents, type DetectOptions, type Incident } from './detect.js';
import { RadarIngest, type IngestEnvelope, type IngestOptions, type IngestOutcome } from './ingest.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Wait this long after a bucket closes so jittered sends (up to 30 minutes) have arrived. */
export const CLOSE_GRACE_MS = HOUR;

export interface PipelineMetrics { bucketsPublished: number; cohortsPublished: number; cohortsSuppressed: number; cohortsQuarantined: number; budgetWithheld: number }

export class RadarPipeline {
  readonly ingestor: RadarIngest;
  readonly metrics: PipelineMetrics = { bucketsPublished: 0, cohortsPublished: 0, cohortsSuppressed: 0, cohortsQuarantined: 0, budgetWithheld: 0 };
  private published = new Map<string, PublishedRow>();
  private done = new Set<string>();
  private budget = new PrivacyBudget();
  /** Distinct-contributor counts per series, published buckets only; feeds the quarantine baseline. */
  private history = new Map<string, { t: string; n: number }[]>();

  constructor(ingestOpts: IngestOptions, private readonly rng: Rng, private readonly detectOpts: Partial<DetectOptions> = {}) {
    this.ingestor = new RadarIngest(ingestOpts);
  }

  ingest(env: IngestEnvelope, source: string, now: number): IngestOutcome {
    return this.ingestor.ingest(env, source, now);
  }

  /** Close every bucket that has ended (plus grace) and not yet been published; then expire old data. */
  tick(now: number): void {
    const buckets = this.ingestor.withRows((rows) => [...new Set(rows.map((r) => r.contribution.timeBucket))].sort());
    for (const b of buckets) {
      if (this.done.has(b) || Date.parse(b) + BUCKET_HOURS * HOUR + CLOSE_GRACE_MS > now) continue;
      this.done.add(b);
      const { rows: agg, quarantined } = this.ingestor.withRows((rows) =>
        aggregateBucket(rows.filter((r) => r.contribution.timeBucket === b), (s) => (this.history.get(s) ?? []).map((h) => h.n)));
      const { published, suppressed } = suppress(agg);
      const out = publish(published, this.budget, this.rng);
      for (const r of out) {
        this.published.set(cohortId(r), r);
        const h = this.history.get(seriesId(r)) ?? [];
        h.push({ t: r.timeBucket, n: r.n });
        this.history.set(seriesId(r), h);
      }
      this.metrics.bucketsPublished++;
      this.metrics.cohortsPublished += out.length;
      this.metrics.cohortsSuppressed += suppressed;
      this.metrics.cohortsQuarantined += quarantined;
      this.metrics.budgetWithheld += published.length - out.length;
    }
    this.ingestor.purge(now);
    const cutoff = new Date(now - RETENTION_DAYS.aggregate * DAY).toISOString();
    for (const [k, r] of this.published) if (r.timeBucket < cutoff) this.published.delete(k);
    for (const [s, h] of this.history) {
      const kept = h.filter((x) => x.t >= cutoff);
      if (kept.length) this.history.set(s, kept); else this.history.delete(s);
    }
  }

  /** Aggregate-only incident feed. Contains bands and scopes, never rows or exact counts. */
  incidents(now: number): Incident[] {
    return detectIncidents([...this.published.values()], now, this.detectOpts);
  }

  publishedRowCount(): number {
    return this.published.size;
  }
}

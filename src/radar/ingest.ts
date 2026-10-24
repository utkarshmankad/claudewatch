// Limit Change Radar ingestion (prompt 4.2). Validates envelopes, enforces single-use tokens and rate limits, and keeps
// raw rows for RETENTION_DAYS.rawContribution only. Nothing here stores a source address or exposes a single row.
import { createHash, randomBytes } from 'node:crypto';
import { BUCKET_HOURS, RETENTION_DAYS, validateContribution, type RadarContribution } from './contribution.js';

const DAY_MS = 86_400_000;
const PSEUDONYM_RE = /^[0-9a-f]{32}$/;

export interface IngestEnvelope {
  /** Single-use token from the issuance endpoint. Verified, then only its hash is kept until it expires. */
  token: string;
  /** Rotating (weekly) pseudonym; used only to count distinct contributors, stored hashed. */
  pseudonym: string;
  contribution: unknown;
}

/** Callers learn only "rejected" or "rate_limited"; the detailed reason goes to the counters, never to the response. */
export type IngestOutcome = { accepted: true } | { accepted: false; reason: 'rejected' | 'rate_limited' };

export type RejectReason = 'schema' | 'token_invalid' | 'token_spent' | 'pseudonym' | 'time_window' | 'duplicate' | 'rate_limited';

export interface IngestCounters { accepted: number; rejected: Record<RejectReason, number> }

export interface RawRow { contribution: RadarContribution; pseudonymHash: string; receivedAt: number }

export interface IngestOptions {
  /** Returns true when the token carries a valid issuer signature. Real deployments plug in blind-signature verification. */
  verifyToken: (token: string) => boolean;
  /** Max accepted+attempted requests per hashed source per UTC day. */
  dailyLimitPerSource?: number;
  /** Random bytes for the daily salt; injectable for tests. */
  randomSalt?: () => string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const bucketMs = (iso: string) => Date.parse(iso);

export class RadarIngest {
  private rows: RawRow[] = [];
  private spent = new Map<string, number>();
  private seen = new Set<string>();
  private hits = new Map<string, number>();
  private saltDay = -1;
  private salt = '';
  readonly counters: IngestCounters = {
    accepted: 0,
    rejected: { schema: 0, token_invalid: 0, token_spent: 0, pseudonym: 0, time_window: 0, duplicate: 0, rate_limited: 0 },
  };

  constructor(private readonly opts: IngestOptions) {}

  /** `source` is the edge's view of the caller; it is hashed with a daily salt and never stored. */
  ingest(env: IngestEnvelope, source: string, now: number): IngestOutcome {
    if (this.limited(source, now)) return this.reject('rate_limited', 'rate_limited');
    if (typeof env !== 'object' || env === null) return this.reject('schema', 'rejected');
    const v = validateContribution(env.contribution);
    if (!v.ok) return this.reject('schema', 'rejected');
    if (typeof env.token !== 'string' || env.token.length === 0 || env.token.length > 512 || !this.opts.verifyToken(env.token)) return this.reject('token_invalid', 'rejected');
    const tokenHash = sha(env.token);
    if (this.spent.has(tokenHash)) return this.reject('token_spent', 'rejected');
    if (typeof env.pseudonym !== 'string' || !PSEUDONYM_RE.test(env.pseudonym)) return this.reject('pseudonym', 'rejected');
    const start = bucketMs(v.value.timeBucket);
    // Sends are jittered by up to 30 minutes, so a bucket is valid from its start until RETENTION_DAYS later; future buckets never are.
    if (start > now || now - start > RETENTION_DAYS.rawContribution * DAY_MS) return this.reject('time_window', 'rejected');
    const pseudonymHash = sha(env.pseudonym);
    const c = v.value;
    const dedupe = `${pseudonymHash}|${c.provider}|${c.planType}|${c.regionBucket}|${c.windowType}|${c.timeBucket}`;
    if (this.seen.has(dedupe)) return this.reject('duplicate', 'rejected');
    this.spent.set(tokenHash, now);
    this.seen.add(dedupe);
    this.rows.push({ contribution: c, pseudonymHash, receivedAt: now });
    this.counters.accepted++;
    return { accepted: true };
  }

  /** Aggregate jobs are the only readers; there is deliberately no accessor that returns rows to an operator. */
  withRows<T>(job: (rows: readonly RawRow[]) => T): T {
    return job(this.rows);
  }

  size(): number {
    return this.rows.length;
  }

  /** Delete raw rows and spent-token hashes past retention. Returns how many rows were removed. */
  purge(now: number): number {
    const cutoff = now - RETENTION_DAYS.rawContribution * DAY_MS;
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.receivedAt >= cutoff);
    for (const [k, t] of this.spent) if (t < cutoff) this.spent.delete(k);
    const live = new Set(this.rows.map((r) => dedupeKey(r)));
    for (const k of this.seen) if (!live.has(k)) this.seen.delete(k);
    return before - this.rows.length;
  }

  private limited(source: string, now: number): boolean {
    const day = Math.floor(now / DAY_MS);
    if (day !== this.saltDay) {
      this.saltDay = day;
      this.salt = (this.opts.randomSalt ?? (() => randomBytes(16).toString('hex')))();
      this.hits.clear();
    }
    const key = sha(this.salt + source);
    const n = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, n);
    return n > (this.opts.dailyLimitPerSource ?? BUCKETS_PER_DAY_LIMIT);
  }

  private reject(reason: RejectReason, outward: 'rejected' | 'rate_limited'): IngestOutcome {
    this.counters.rejected[reason]++;
    return { accepted: false, reason: outward };
  }
}

/** One valid send per bucket per day is expected; allow a few retries and several providers behind one NAT. */
const BUCKETS_PER_DAY_LIMIT = (24 / BUCKET_HOURS) * 10;

function dedupeKey(r: RawRow): string {
  const c = r.contribution;
  return `${r.pseudonymHash}|${c.provider}|${c.planType}|${c.regionBucket}|${c.windowType}|${c.timeBucket}`;
}

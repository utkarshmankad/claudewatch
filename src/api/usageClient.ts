import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type BucketWidth = '1m' | '1h' | '1d';

export type ServiceTier =
  | 'standard'
  | 'batch'
  | 'priority'
  | 'priority_on_demand'
  | 'flex'
  | 'flex_discount';

// ---------------------------------------------------------------------------
// Usage report — GET /v1/organizations/usage_report/messages
// ---------------------------------------------------------------------------

export type UsageGroupBy =
  | 'workspace_id'
  | 'api_key_id'
  | 'user_id'
  | 'model'
  | 'service_tier'
  | 'context_window'
  | 'inference_geo';

export interface CacheCreationTokens {
  /** Tokens written to ephemeral 1-hour cache */
  ephemeral_1h_input_tokens: number;
  /** Tokens written to ephemeral 5-minute cache */
  ephemeral_5m_input_tokens: number;
}

/**
 * One row inside a usage time-bucket.
 * Dimension fields (model, workspace_id, …) are non-null only when
 * that dimension was included in group_by.
 */
export interface UsageResult {
  model: string | null;
  workspace_id: string | null;
  api_key_id: string | null;
  service_tier: ServiceTier | null;
  context_window: string | null;
  inference_geo: string | null;
  /** Non-cached input tokens */
  uncached_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: CacheCreationTokens;
}

/** One time-bucket returned by the usage report */
export interface UsageBucket {
  starting_at: string;
  ending_at: string;
  results: UsageResult[];
}

/** Raw paginated response from GET /v1/organizations/usage_report/messages */
export interface UsageReportPage {
  data: UsageBucket[];
  has_more: boolean;
  /** Present when has_more is true */
  next_page: string | null;
}

// ---------------------------------------------------------------------------
// Cost report — GET /v1/organizations/cost_report
// ---------------------------------------------------------------------------

export type CostType =
  | 'tokens'
  | 'web_search'
  | 'code_execution'
  | 'session_usage';

export type TokenType =
  | 'uncached_input_tokens'
  | 'output_tokens'
  | 'cache_read_input_tokens'
  | 'cache_creation.ephemeral_1h_input_tokens'
  | 'cache_creation.ephemeral_5m_input_tokens';

/**
 * One row inside a cost time-bucket.
 * `amount` is a decimal string — e.g. "1.234567" means $1.234567 USD.
 */
export interface CostResult {
  model: string | null;
  workspace_id: string | null;
  /** Decimal string in USD, e.g. "0.0025" */
  amount: string;
  currency: 'USD';
  cost_type: CostType | null;
  token_type: TokenType | null;
  service_tier: 'standard' | 'batch' | null;
  description: string | null;
  inference_geo: string | null;
  context_window: string | null;
}

/** One time-bucket returned by the cost report */
export interface CostBucket {
  starting_at: string;
  ending_at: string;
  results: CostResult[];
}

/** Raw paginated response from GET /v1/organizations/cost_report */
export interface CostReportPage {
  data: CostBucket[];
  has_more: boolean;
  next_page: string | null;
}

// ---------------------------------------------------------------------------
// Query option types
// ---------------------------------------------------------------------------

export interface UsageQueryOptions {
  /** Filter to a single workspace. Default: all workspaces. */
  workspaceId?: string;
  /** Override window start. Default: first day of current UTC calendar month. */
  startingAt?: Date;
  /** Override window end. Default: now. */
  endingAt?: Date;
  /** Additional group-by dimensions beyond model. */
  extraGroupBy?: UsageGroupBy[];
}

export interface CostQueryOptions {
  workspaceId?: string;
  startingAt?: Date;
  endingAt?: Date;
}

// ---------------------------------------------------------------------------
// Billing period
// ---------------------------------------------------------------------------

export interface BillingPeriod {
  /** ISO 8601 UTC */
  startingAt: string;
  /** ISO 8601 UTC */
  endingAt: string;
}

/**
 * Returns the current Anthropic billing period: 1st of the current UTC month → now.
 */
export function currentBillingPeriod(): BillingPeriod {
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    startingAt: startOfMonth.toISOString(),
    endingAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class UsageClient {
  private readonly sdk: Anthropic;

  constructor(adminApiKey: string) {
    // The SDK injects x-api-key, anthropic-version, user-agent, and retry logic.
    this.sdk = new Anthropic({ apiKey: adminApiKey });
  }

  /**
   * Fetch all daily usage buckets for the current billing period, grouped by model.
   * Follows all pagination pages and returns the full collected set.
   */
  async fetchUsageByModel(opts: UsageQueryOptions = {}): Promise<UsageBucket[]> {
    const { startingAt, endingAt } = resolveWindow(opts.startingAt, opts.endingAt);

    const base = new URLSearchParams({
      starting_at: startingAt,
      ending_at: endingAt,
      bucket_width: '1d' satisfies BucketWidth,
    });
    base.append('group_by[]', 'model');
    for (const dim of opts.extraGroupBy ?? []) {
      base.append('group_by[]', dim);
    }
    if (opts.workspaceId) {
      base.append('workspace_ids[]', opts.workspaceId);
    }

    return this.paginateUsage(base);
  }

  /**
   * Fetch all cost buckets for the current billing period.
   * Follows all pagination pages and returns the full collected set.
   */
  async fetchCostReport(opts: CostQueryOptions = {}): Promise<CostBucket[]> {
    const { startingAt, endingAt } = resolveWindow(opts.startingAt, opts.endingAt);

    const base = new URLSearchParams({
      starting_at: startingAt,
      ending_at: endingAt,
    });
    if (opts.workspaceId) {
      base.append('workspace_ids[]', opts.workspaceId);
    }

    return this.paginateCost(base);
  }

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  private async paginateUsage(base: URLSearchParams): Promise<UsageBucket[]> {
    const all: UsageBucket[] = [];
    let cursor: string | null = null;

    do {
      const resp: UsageReportPage = await this.sdk.get<UsageReportPage>(
        buildPath('/v1/organizations/usage_report/messages', base, cursor),
      );
      all.push(...resp.data);
      cursor = resp.has_more ? (resp.next_page ?? null) : null;
    } while (cursor !== null);

    return all;
  }

  private async paginateCost(base: URLSearchParams): Promise<CostBucket[]> {
    const all: CostBucket[] = [];
    let cursor: string | null = null;

    do {
      const resp: CostReportPage = await this.sdk.get<CostReportPage>(
        buildPath('/v1/organizations/cost_report', base, cursor),
      );
      all.push(...resp.data);
      cursor = resp.has_more ? (resp.next_page ?? null) : null;
    } while (cursor !== null);

    return all;
  }
}

// ---------------------------------------------------------------------------
// Convenience aggregators (pure — no I/O)
// ---------------------------------------------------------------------------

/** Sum all uncached_input_tokens across every bucket and result */
export function totalUncachedInputTokens(buckets: UsageBucket[]): number {
  return sum(buckets, (r) => r.uncached_input_tokens);
}

/** Sum all output_tokens across every bucket and result */
export function totalOutputTokens(buckets: UsageBucket[]): number {
  return sum(buckets, (r) => r.output_tokens);
}

/** Sum cache_read_input_tokens across every bucket and result */
export function totalCacheReadTokens(buckets: UsageBucket[]): number {
  return sum(buckets, (r) => r.cache_read_input_tokens);
}

/** Sum cache write tokens (both TTL tiers) across every bucket and result */
export function totalCacheWriteTokens(buckets: UsageBucket[]): number {
  return sum(
    buckets,
    (r) =>
      r.cache_creation.ephemeral_1h_input_tokens +
      r.cache_creation.ephemeral_5m_input_tokens,
  );
}

/**
 * Aggregate usage by model across all buckets.
 * Returns a map of model name → summed token counts.
 */
export function usageByModel(buckets: UsageBucket[]): Map<string, UsageResult> {
  const acc = new Map<string, UsageResult>();
  for (const bucket of buckets) {
    for (const r of bucket.results) {
      const key = r.model ?? '(unknown)';
      const existing = acc.get(key);
      if (!existing) {
        acc.set(key, {
          ...r,
          cache_creation: { ...r.cache_creation },
        });
      } else {
        existing.uncached_input_tokens += r.uncached_input_tokens;
        existing.output_tokens += r.output_tokens;
        existing.cache_read_input_tokens += r.cache_read_input_tokens;
        existing.cache_creation.ephemeral_1h_input_tokens +=
          r.cache_creation.ephemeral_1h_input_tokens;
        existing.cache_creation.ephemeral_5m_input_tokens +=
          r.cache_creation.ephemeral_5m_input_tokens;
      }
    }
  }
  return acc;
}

/**
 * Break cost buckets into daily / weekly / monthly period totals.
 * Buckets whose ending_at falls within a period window are counted for that window.
 */
export function computePeriodCosts(
  buckets: CostBucket[],
): { daily: number; weekly: number; monthly: number } {
  const now = new Date();

  const dayStart = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  ));
  const weekStart = new Date(now);
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
  weekStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  let daily = 0;
  let weekly = 0;
  let monthly = 0;

  for (const bucket of buckets) {
    const end = new Date(bucket.ending_at);
    const cost = bucket.results.reduce((s, r) => s + parseFloat(r.amount), 0);
    if (end >= monthStart) monthly += cost;
    if (end >= weekStart) weekly += cost;
    if (end >= dayStart) daily += cost;
  }

  return { daily, weekly, monthly };
}

/**
 * Sum the total cost in USD across all cost buckets.
 * `amount` is a decimal string; this converts and accumulates safely.
 */
export function totalCostUSD(buckets: CostBucket[]): number {
  let total = 0;
  for (const bucket of buckets) {
    for (const r of bucket.results) {
      total += parseFloat(r.amount);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveWindow(
  start: Date | undefined,
  end: Date | undefined,
): { startingAt: string; endingAt: string } {
  const period = currentBillingPeriod();
  return {
    startingAt: (start ?? new Date(period.startingAt)).toISOString(),
    endingAt: (end ?? new Date(period.endingAt)).toISOString(),
  };
}

/**
 * Build a relative path + query string.
 * The SDK keeps the pre-built search string intact because:
 *  - opts.query is not passed → undefined → url.search is not overwritten
 *  - defaultQuery() returns undefined → isEmptyObj(undefined) = true → merged step skipped
 */
function buildPath(
  endpoint: string,
  base: URLSearchParams,
  cursor: string | null,
): string {
  const sp = new URLSearchParams(base);
  if (cursor) sp.set('page', cursor);
  return `${endpoint}?${sp.toString()}`;
}

function sum(buckets: UsageBucket[], pick: (r: UsageResult) => number): number {
  let total = 0;
  for (const bucket of buckets) {
    for (const r of bucket.results) total += pick(r);
  }
  return total;
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CostBucket, UsageBucket } from '../usageClient.js';

// Must use vi.hoisted() so the reference is available inside the vi.mock() factory.
const mockSdkGet = vi.hoisted(() => vi.fn());

// The Anthropic constructor is called with `new`, so the mock must be a class
// (or a regular `function`). Arrow functions cannot be constructors.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    get = mockSdkGet;
  },
}));

import {
  UsageClient,
  computePeriodCosts,
  currentBillingPeriod,
  totalCostUSD,
  totalUncachedInputTokens,
  totalOutputTokens,
  totalCacheReadTokens,
  totalCacheWriteTokens,
  usageByModel,
} from '../usageClient.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCostBucket(endingAt: string, ...amounts: number[]): CostBucket {
  return {
    starting_at: new Date(new Date(endingAt).getTime() - 86_400_000).toISOString(),
    ending_at: endingAt,
    results: amounts.map(amt => ({
      model: null,
      workspace_id: null,
      amount: String(amt),
      currency: 'USD' as const,
      cost_type: 'tokens' as const,
      token_type: 'uncached_input_tokens' as const,
      service_tier: 'standard' as const,
      description: null,
      inference_geo: null,
      context_window: null,
    })),
  };
}

function makeUsageBucket(
  startingAt: string,
  model: string,
  uncached: number,
  output = 0,
  cacheRead = 0,
  cache1h = 0,
  cache5m = 0,
): UsageBucket {
  return {
    starting_at: startingAt,
    ending_at: new Date(new Date(startingAt).getTime() + 86_400_000).toISOString(),
    results: [{
      model,
      workspace_id: null,
      api_key_id: null,
      service_tier: null,
      context_window: null,
      inference_geo: null,
      uncached_input_tokens: uncached,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation: { ephemeral_1h_input_tokens: cache1h, ephemeral_5m_input_tokens: cache5m },
    }],
  };
}

const FIXED_NOW = new Date('2024-06-15T14:30:00.000Z'); // Saturday

// ── totalCostUSD ───────────────────────────────────────────────────────────

describe('totalCostUSD', () => {
  it('returns 0 for empty input', () => {
    expect(totalCostUSD([])).toBe(0);
  });

  it('sums all result amounts in one bucket', () => {
    expect(totalCostUSD([makeCostBucket('2024-06-15T12:00:00Z', 1.5, 0.5)])).toBeCloseTo(2.0);
  });

  it('sums amounts across multiple buckets', () => {
    expect(totalCostUSD([
      makeCostBucket('2024-06-14T12:00:00Z', 1.0),
      makeCostBucket('2024-06-15T12:00:00Z', 2.5),
    ])).toBeCloseTo(3.5);
  });

  it('handles high-precision decimal strings without losing significant digits', () => {
    expect(totalCostUSD([
      makeCostBucket('2024-06-15T12:00:00Z', 0.000001, 0.000002),
    ])).toBeCloseTo(0.000003, 8);
  });
});

// ── computePeriodCosts ─────────────────────────────────────────────────────

describe('computePeriodCosts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('returns zeros for empty input', () => {
    expect(computePeriodCosts([])).toEqual({ daily: 0, weekly: 0, monthly: 0 });
  });

  it('counts a bucket ending today in all three periods', () => {
    const r = computePeriodCosts([makeCostBucket('2024-06-15T12:00:00Z', 3.0)]);
    expect(r.daily).toBeCloseTo(3.0);
    expect(r.weekly).toBeCloseTo(3.0);
    expect(r.monthly).toBeCloseTo(3.0);
  });

  it('counts a bucket ending yesterday in weekly and monthly only', () => {
    // June 14 is in the same week (week starts June 9) and same month
    const r = computePeriodCosts([makeCostBucket('2024-06-14T12:00:00Z', 2.0)]);
    expect(r.daily).toBe(0);
    expect(r.weekly).toBeCloseTo(2.0);
    expect(r.monthly).toBeCloseTo(2.0);
  });

  it('counts a bucket from before week start in monthly only', () => {
    // June 8 is before week start (June 9) but within June
    const r = computePeriodCosts([makeCostBucket('2024-06-08T12:00:00Z', 5.0)]);
    expect(r.daily).toBe(0);
    expect(r.weekly).toBe(0);
    expect(r.monthly).toBeCloseTo(5.0);
  });

  it('excludes a bucket from last month entirely', () => {
    const r = computePeriodCosts([makeCostBucket('2024-05-31T12:00:00Z', 10.0)]);
    expect(r.daily).toBe(0);
    expect(r.weekly).toBe(0);
    expect(r.monthly).toBe(0);
  });

  it('partitions a mix of buckets into the correct period totals', () => {
    const r = computePeriodCosts([
      makeCostBucket('2024-06-15T12:00:00Z', 1.0), // today
      makeCostBucket('2024-06-10T12:00:00Z', 2.0), // this week, not today
      makeCostBucket('2024-06-03T12:00:00Z', 3.0), // this month, not this week
      makeCostBucket('2024-05-20T12:00:00Z', 4.0), // last month
    ]);
    expect(r.daily).toBeCloseTo(1.0);
    expect(r.weekly).toBeCloseTo(3.0);   // today + this-week bucket
    expect(r.monthly).toBeCloseTo(6.0);  // today + this-week + this-month buckets
  });
});

// ── usageByModel ───────────────────────────────────────────────────────────

describe('usageByModel', () => {
  it('returns an empty map for empty input', () => {
    expect(usageByModel([])).toEqual(new Map());
  });

  it('aggregates tokens for the same model across buckets', () => {
    const b1 = makeUsageBucket('2024-06-14T00:00:00Z', 'sonnet', 1000);
    const b2 = makeUsageBucket('2024-06-15T00:00:00Z', 'sonnet', 2000);
    expect(usageByModel([b1, b2]).get('sonnet')?.uncached_input_tokens).toBe(3000);
  });

  it('keeps different models separate', () => {
    const b1 = makeUsageBucket('2024-06-15T00:00:00Z', 'sonnet', 1000);
    const b2 = makeUsageBucket('2024-06-15T00:00:00Z', 'opus', 500);
    const result = usageByModel([b1, b2]);
    expect(result.size).toBe(2);
    expect(result.get('sonnet')?.uncached_input_tokens).toBe(1000);
    expect(result.get('opus')?.uncached_input_tokens).toBe(500);
  });

  it('groups null model under "(unknown)"', () => {
    const bucket: UsageBucket = {
      starting_at: '2024-06-15T00:00:00Z',
      ending_at: '2024-06-16T00:00:00Z',
      results: [{
        model: null,
        workspace_id: null,
        api_key_id: null,
        service_tier: null,
        context_window: null,
        inference_geo: null,
        uncached_input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      }],
    };
    expect(usageByModel([bucket]).get('(unknown)')?.uncached_input_tokens).toBe(100);
  });

  it('accumulates all token types per model', () => {
    const b1 = makeUsageBucket('2024-06-15T00:00:00Z', 'm', 100, 50, 20, 10, 5);
    const b2 = makeUsageBucket('2024-06-14T00:00:00Z', 'm', 200, 100, 40, 20, 10);
    const r = usageByModel([b1, b2]).get('m');
    expect(r?.uncached_input_tokens).toBe(300);
    expect(r?.output_tokens).toBe(150);
    expect(r?.cache_read_input_tokens).toBe(60);
    expect(r?.cache_creation.ephemeral_1h_input_tokens).toBe(30);
    expect(r?.cache_creation.ephemeral_5m_input_tokens).toBe(15);
  });
});

// ── Token aggregators ──────────────────────────────────────────────────────

describe('token aggregators', () => {
  const bucket = makeUsageBucket('2024-06-15T00:00:00Z', 'test', 1000, 500, 200, 50, 30);

  it('totalUncachedInputTokens', () => {
    expect(totalUncachedInputTokens([bucket])).toBe(1000);
  });

  it('totalOutputTokens', () => {
    expect(totalOutputTokens([bucket])).toBe(500);
  });

  it('totalCacheReadTokens', () => {
    expect(totalCacheReadTokens([bucket])).toBe(200);
  });

  it('totalCacheWriteTokens sums both TTL tiers', () => {
    expect(totalCacheWriteTokens([bucket])).toBe(80); // 50 + 30
  });

  it('sums correctly across multiple buckets', () => {
    const b2 = makeUsageBucket('2024-06-14T00:00:00Z', 'test', 400, 200, 100, 25, 15);
    expect(totalUncachedInputTokens([bucket, b2])).toBe(1400);
    expect(totalOutputTokens([bucket, b2])).toBe(700);
  });
});

// ── currentBillingPeriod ───────────────────────────────────────────────────

describe('currentBillingPeriod', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('starts on the first of the current UTC month', () => {
    expect(currentBillingPeriod().startingAt).toBe('2024-06-01T00:00:00.000Z');
  });

  it('ends at the current instant', () => {
    expect(currentBillingPeriod().endingAt).toBe(FIXED_NOW.toISOString());
  });
});

// ── UsageClient (mocked Anthropic SDK) ────────────────────────────────────

describe('UsageClient.fetchUsageByModel', () => {
  let client: UsageClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new UsageClient('test-key');
  });

  it('returns buckets from a single-page response', async () => {
    const bucket = makeUsageBucket('2024-06-15T00:00:00Z', 'sonnet', 1000);
    mockSdkGet.mockResolvedValueOnce({ data: [bucket], has_more: false, next_page: null });

    const result = await client.fetchUsageByModel();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(bucket);
  });

  it('follows pagination until has_more is false', async () => {
    const b1 = makeUsageBucket('2024-06-14T00:00:00Z', 'sonnet', 500);
    const b2 = makeUsageBucket('2024-06-15T00:00:00Z', 'opus', 800);

    mockSdkGet
      .mockResolvedValueOnce({ data: [b1], has_more: true, next_page: 'cursor-abc' })
      .mockResolvedValueOnce({ data: [b2], has_more: false, next_page: null });

    const result = await client.fetchUsageByModel();
    expect(result).toHaveLength(2);
    expect(mockSdkGet).toHaveBeenCalledTimes(2);
    expect(mockSdkGet).toHaveBeenNthCalledWith(2, expect.stringContaining('page=cursor-abc'));
  });

  it('returns an empty array when the response has no data', async () => {
    mockSdkGet.mockResolvedValueOnce({ data: [], has_more: false, next_page: null });
    expect(await client.fetchUsageByModel()).toEqual([]);
  });

  it('includes workspaceId as a workspace_ids[] query param', async () => {
    mockSdkGet.mockResolvedValueOnce({ data: [], has_more: false, next_page: null });
    await client.fetchUsageByModel({ workspaceId: 'ws-xyz' });
    expect(mockSdkGet).toHaveBeenCalledWith(expect.stringContaining('workspace_ids'));
  });
});

describe('UsageClient.fetchCostReport', () => {
  let client: UsageClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new UsageClient('test-key');
  });

  it('returns cost buckets from a single-page response', async () => {
    const bucket = makeCostBucket('2024-06-15T12:00:00Z', 5.0);
    mockSdkGet.mockResolvedValueOnce({ data: [bucket], has_more: false, next_page: null });

    const result = await client.fetchCostReport();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(bucket);
  });

  it('follows pagination for the cost report', async () => {
    const b1 = makeCostBucket('2024-06-14T12:00:00Z', 1.0);
    const b2 = makeCostBucket('2024-06-15T12:00:00Z', 2.0);

    mockSdkGet
      .mockResolvedValueOnce({ data: [b1], has_more: true, next_page: 'pg2' })
      .mockResolvedValueOnce({ data: [b2], has_more: false, next_page: null });

    const result = await client.fetchCostReport();
    expect(result).toHaveLength(2);
    expect(mockSdkGet).toHaveBeenCalledTimes(2);
    expect(mockSdkGet).toHaveBeenNthCalledWith(2, expect.stringContaining('page=pg2'));
  });
});

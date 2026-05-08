/**
 * Integration test: wires UsageClient → computePeriodCosts → evaluateThresholdsWithCosts
 * together with a mocked Anthropic SDK and a mocked DB layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SpendThreshold } from '../config/schema.js';
import type { CostBucket, UsageBucket } from '../api/usageClient.js';

// vi.hoisted() ensures these values are created before vi.mock() factories run.
const mockSdkGet = vi.hoisted(() => vi.fn());
const mockHasAlertFired = vi.hoisted(() => vi.fn());
const mockRecordAlert = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  // Must be a class (or regular function), not an arrow function — arrow
  // functions cannot be used as constructors (`new Anthropic(...)`).
  default: class MockAnthropic {
    get = mockSdkGet;
  },
}));

vi.mock('../store/db.js', () => ({
  hasAlertFired: mockHasAlertFired,
  recordAlert: mockRecordAlert,
  getDb: vi.fn(),
  closeDb: vi.fn(),
  insertSnapshot: vi.fn(),
  getLatestSnapshot: vi.fn().mockReturnValue(null),
  getAlertHistory: vi.fn().mockReturnValue([]),
  getDailyTokensByModel: vi.fn().mockReturnValue([]),
  getDailyTokenTotals: vi.fn().mockReturnValue([]),
  insertPlanInfo: vi.fn(),
  getLatestPlanInfo: vi.fn().mockReturnValue(null),
}));

// threshold.ts imports getTotalCostSince from usage.ts; prevent the chain
// from reaching better-sqlite3.
vi.mock('../store/usage.js', () => ({
  getTotalCostSince: vi.fn().mockReturnValue(0),
  insertUsageRecords: vi.fn(),
  insertCostRecords: vi.fn(),
  logAlert: vi.fn(),
}));

import { UsageClient, computePeriodCosts } from '../api/usageClient.js';
import { evaluateThresholdsWithCosts } from '../alerts/threshold.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2024-06-15T14:30:00.000Z'); // Saturday

function costBucket(endingAt: string, amount: number): CostBucket {
  return {
    starting_at: new Date(new Date(endingAt).getTime() - 86_400_000).toISOString(),
    ending_at: endingAt,
    results: [{
      model: null,
      workspace_id: null,
      amount: String(amount),
      currency: 'USD',
      cost_type: 'tokens',
      token_type: 'uncached_input_tokens',
      service_tier: 'standard',
      description: null,
      inference_geo: null,
      context_window: null,
    }],
  };
}

function usageBucket(model: string, tokens: number): UsageBucket {
  return {
    starting_at: '2024-06-15T00:00:00Z',
    ending_at: '2024-06-16T00:00:00Z',
    results: [{
      model,
      workspace_id: null,
      api_key_id: null,
      service_tier: null,
      context_window: null,
      inference_geo: null,
      uncached_input_tokens: tokens,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    }],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Integration: fetch → compute costs → evaluate thresholds', () => {
  let client: UsageClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    mockHasAlertFired.mockReturnValue(false);
    client = new UsageClient('sk-admin-test');
  });

  afterEach(() => { vi.useRealTimers(); });

  it('triggers a threshold when today\'s cost exceeds the limit', async () => {
    mockSdkGet.mockResolvedValue({ data: [costBucket('2024-06-15T12:00:00Z', 15)], has_more: false, next_page: null });

    const costs = computePeriodCosts(await client.fetchCostReport());

    const thresholds: SpendThreshold[] = [
      { amountUsd: 10, period: 'daily', notifyEmail: false, notifyDesktop: true },
    ];
    const triggered = evaluateThresholdsWithCosts(thresholds, costs);

    expect(triggered).toHaveLength(1);
    expect(triggered[0]?.actualUsd).toBeCloseTo(15);
    expect(mockRecordAlert).toHaveBeenCalledOnce();
    expect(mockRecordAlert).toHaveBeenCalledWith(10, 'daily', 15, ['desktop']);
  });

  it('does not trigger when cost is below every threshold', async () => {
    mockSdkGet.mockResolvedValue({ data: [costBucket('2024-06-15T12:00:00Z', 4)], has_more: false, next_page: null });

    const costs = computePeriodCosts(await client.fetchCostReport());
    const thresholds: SpendThreshold[] = [
      { amountUsd: 10, period: 'daily', notifyEmail: true, notifyDesktop: true },
    ];

    expect(evaluateThresholdsWithCosts(thresholds, costs)).toHaveLength(0);
    expect(mockRecordAlert).not.toHaveBeenCalled();
  });

  it('deduplicates: a second poll at higher spend does not re-fire the same alert', async () => {
    mockSdkGet.mockResolvedValue({ data: [costBucket('2024-06-15T12:00:00Z', 20)], has_more: false, next_page: null });

    const thresholds: SpendThreshold[] = [
      { amountUsd: 10, period: 'daily', notifyEmail: true, notifyDesktop: false },
    ];

    // Poll 1 — fires
    mockHasAlertFired.mockReturnValue(false);
    const costs1 = computePeriodCosts(await client.fetchCostReport());
    expect(evaluateThresholdsWithCosts(thresholds, costs1)).toHaveLength(1);

    // Poll 2 — already fired; DB guard returns true
    mockHasAlertFired.mockReturnValue(true);
    const costs2 = computePeriodCosts(await client.fetchCostReport());
    expect(evaluateThresholdsWithCosts(thresholds, costs2)).toHaveLength(0);

    expect(mockRecordAlert).toHaveBeenCalledTimes(1);
  });

  it('correctly assigns costs to their respective periods across multi-bucket responses', async () => {
    mockSdkGet.mockResolvedValue({
      data: [
        costBucket('2024-06-15T12:00:00Z', 10), // today → daily + weekly + monthly
        costBucket('2024-06-10T12:00:00Z', 5),  // this week (not today) → weekly + monthly
        costBucket('2024-06-03T12:00:00Z', 3),  // this month (not this week) → monthly only
      ],
      has_more: false,
      next_page: null,
    });

    const costs = computePeriodCosts(await client.fetchCostReport());
    expect(costs.daily).toBeCloseTo(10);
    expect(costs.weekly).toBeCloseTo(15);
    expect(costs.monthly).toBeCloseTo(18);
  });

  it('follows API pagination and accumulates all cost pages', async () => {
    mockSdkGet
      .mockResolvedValueOnce({ data: [costBucket('2024-06-14T12:00:00Z', 5)], has_more: true, next_page: 'p2' })
      .mockResolvedValueOnce({ data: [costBucket('2024-06-15T12:00:00Z', 10)], has_more: false, next_page: null });

    const costs = computePeriodCosts(await client.fetchCostReport());
    expect(mockSdkGet).toHaveBeenCalledTimes(2);
    expect(costs.daily).toBeCloseTo(10);    // only today's bucket
    expect(costs.monthly).toBeCloseTo(15);  // both buckets
  });

  it('aggregates usage tokens across multiple models', async () => {
    mockSdkGet.mockResolvedValue({
      data: [
        usageBucket('claude-3-5-sonnet', 5000),
        usageBucket('claude-3-opus', 1000),
      ],
      has_more: false,
      next_page: null,
    });

    const buckets = await client.fetchUsageByModel();
    const total = buckets.reduce(
      (sum, b) => sum + b.results.reduce((s, r) => s + r.uncached_input_tokens, 0),
      0,
    );
    expect(total).toBe(6000);
  });
});

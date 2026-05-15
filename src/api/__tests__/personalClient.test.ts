import { describe, it, expect, vi, beforeEach } from 'vitest';
import { estimateTokenCost, PersonalUsageClient } from '../personalClient.js';

// ---------------------------------------------------------------------------
// estimateTokenCost — pure function, no mocks needed
// ---------------------------------------------------------------------------

describe('estimateTokenCost', () => {
  it('returns 0 for all-zero input', () => {
    expect(estimateTokenCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0);
  });

  it('charges input tokens at $0.80 / MTok', () => {
    const cost = estimateTokenCost({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(cost).toBeCloseTo(0.80, 6);
  });

  it('charges output tokens at $4.00 / MTok', () => {
    const cost = estimateTokenCost({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(cost).toBeCloseTo(4.00, 6);
  });

  it('charges cache-read tokens at $0.08 / MTok', () => {
    const cost = estimateTokenCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 });
    expect(cost).toBeCloseTo(0.08, 6);
  });

  it('charges cache-write tokens at $1.00 / MTok', () => {
    const cost = estimateTokenCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 });
    expect(cost).toBeCloseTo(1.00, 6);
  });

  it('sums all token types correctly', () => {
    const cost = estimateTokenCost({
      inputTokens:      1_000_000,
      outputTokens:     1_000_000,
      cacheReadTokens:  1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    // $0.80 + $4.00 + $0.08 + $1.00 = $5.88
    expect(cost).toBeCloseTo(5.88, 6);
  });

  it('handles fractional token counts without throwing', () => {
    expect(() => estimateTokenCost({ inputTokens: 500, outputTokens: 250, cacheReadTokens: 100, cacheWriteTokens: 50 })).not.toThrow();
  });

  it('scales linearly — halving tokens halves cost', () => {
    const full  = estimateTokenCost({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const half  = estimateTokenCost({ inputTokens:   500_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(half).toBeCloseTo(full / 2, 8);
  });
});

// ---------------------------------------------------------------------------
// PersonalUsageClient.sampleUsage — mocked Anthropic SDK
// ---------------------------------------------------------------------------

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

describe('PersonalUsageClient.sampleUsage', () => {
  let client: PersonalUsageClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new PersonalUsageClient('sk-test-key');
  });

  it('calls messages.create with haiku model and max_tokens=1', async () => {
    mockCreate.mockResolvedValueOnce({
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    await client.sampleUsage();

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
    }));
  });

  it('maps SDK response fields to PersonalUsageSample correctly', async () => {
    mockCreate.mockResolvedValueOnce({
      model: 'claude-haiku-4-5-20251001',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      },
    });

    const result = await client.sampleUsage();

    expect(result).toEqual({
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
  });

  it('defaults cache fields to 0 when absent from SDK response', async () => {
    mockCreate.mockResolvedValueOnce({
      model: 'claude-haiku-4-5-20251001',
      usage: {
        input_tokens: 8,
        output_tokens: 1,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: undefined,
      },
    });

    const result = await client.sampleUsage();
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheWriteTokens).toBe(0);
  });

  it('propagates SDK errors', async () => {
    mockCreate.mockRejectedValueOnce(new Error('rate limited'));
    await expect(client.sampleUsage()).rejects.toThrow('rate limited');
  });
});

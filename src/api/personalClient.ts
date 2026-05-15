import Anthropic from '@anthropic-ai/sdk';

export interface PersonalUsageSample {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Lightweight client for personal API keys (sk-ant-api03-...).
 * Makes a minimal /v1/messages call each tick and captures the usage field
 * to track cumulative token consumption locally.
 */
export class PersonalUsageClient {
  private readonly sdk: Anthropic;

  constructor(apiKey: string) {
    this.sdk = new Anthropic({ apiKey });
  }

  async sampleUsage(): Promise<PersonalUsageSample> {
    const msg = await this.sdk.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return {
      model: msg.model,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    };
  }
}

// claude-haiku-4-5-20251001 public pricing (USD per million tokens).
// Source: https://www.anthropic.com/pricing
const PRICE_PER_MTOK = {
  input:      0.80,
  output:     4.00,
  cacheRead:  0.08,
  cacheWrite: 1.00,
} as const;

/**
 * Estimate USD cost from token counts using claude-haiku-4-5 public pricing.
 * Used in personal mode where the cost API is unavailable.
 */
export function estimateTokenCost(sample: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  return (
    sample.inputTokens      * PRICE_PER_MTOK.input +
    sample.cacheReadTokens  * PRICE_PER_MTOK.cacheRead +
    sample.cacheWriteTokens * PRICE_PER_MTOK.cacheWrite +
    sample.outputTokens     * PRICE_PER_MTOK.output
  ) / 1_000_000;
}

import { describe, expect, it } from 'vitest';
import { recommendPlan, reconcileAttribution } from '../insights.js';

describe('analytics insights', () => {
  it('returns plan-fit bands', () => {
    expect(recommendPlan(50, 100).status).toBe('comfortable');
    expect(recommendPlan(85, 100).status).toBe('near-limit');
    expect(recommendPlan(110, 100).status).toBe('over-limit');
  });
  it('labels the remainder as inferred unattributed usage', () => {
    const result = reconcileAttribution([{ client: 'web', provider: 'claude', confidence: 'observed', inputTokens: 20, outputTokens: 10, events: 1, lastSeenAt: '' }], 100);
    expect(result.unattributedTokens).toBe(70);
    expect(result.caveat).toContain('inferred');
  });
});

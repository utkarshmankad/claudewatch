import { describe, expect, it } from 'vitest';
import { parseUsageEvent } from '../server.js';

describe('usage event ingestion validation', () => {
  const valid = { eventId: 'e1', provider: 'claude', deviceId: 'd1', client: 'web', source: 'browser_stream', confidence: 'observed' };

  it('accepts the metadata-only event contract', () => {
    expect(parseUsageEvent({ ...valid, inputTokens: 10 })?.inputTokens).toBe(10);
  });

  it('rejects missing identity and invalid confidence', () => {
    expect(parseUsageEvent({ ...valid, eventId: undefined })).toBeNull();
    expect(parseUsageEvent({ ...valid, eventId: '   ' })).toBeNull();
    expect(parseUsageEvent({ ...valid, confidence: 'certain' })).toBeNull();
    expect(parseUsageEvent({ ...valid, recordedAt: 'not-a-date' })).toBeNull();
  });

  it('drops unknown metadata so prompt content cannot enter the ledger', () => {
    const parsed = parseUsageEvent({ ...valid, metadata: { pct7d: 42, prompt: 'secret text' } });
    expect(parsed?.metadata).toEqual({ pct7d: 42 });
  });
});

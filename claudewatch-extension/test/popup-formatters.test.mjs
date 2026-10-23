import { beforeAll, describe, expect, it } from 'vitest';
import { formatWindowEnd, validEpochMs, quotaCaption } from '../popup/formatters.mjs';

describe('popup window end-time formatting', () => {
  it('formats an ISO reset timestamp with date, time, and timezone', () => {
    expect(formatWindowEnd('2026-10-09T13:00:00.000Z', {
      locale: 'en-US',
      timeZone: 'Asia/Kolkata',
    })).toBe('Fri, Oct 9, 6:30 PM GMT+5:30');
  });

  it('formats numeric timestamps in the requested browser timezone', () => {
    expect(formatWindowEnd(Date.UTC(2026, 9, 16, 9, 5), {
      locale: 'en-GB',
      timeZone: 'UTC',
    })).toBe('Fri 16 Oct, 09:05 UTC');
  });

  it('returns a placeholder for absent or invalid reset timestamps', () => {
    expect(formatWindowEnd(null)).toBe('—');
    expect(formatWindowEnd('not-a-date')).toBe('—');
    expect(validEpochMs('not-a-date')).toBeNull();
  });
});

describe('quota captions', () => {
  let contract;
  beforeAll(async () => {
    globalThis.self = globalThis;
    await import('../provider-contract.js');
    contract = globalThis.TokenWatcherContract;
  });
  const fmtPct = p => `${Math.round(p)}%`;
  const caption = args => quotaCaption({ fmtPct, contract, ...args });

  it('labels provider-reported values', () => {
    expect(caption({ source: 'provider_reported' })).toBe('Provider-reported');
  });

  it('labels local estimates as not provider-reported', () => {
    expect(caption({ source: 'local_estimate' })).toMatch(/Estimate from local tokens/);
    expect(caption({ source: 'local_estimate' })).toMatch(/not provider-reported/);
  });

  it('shows a forecast with its confidence, never as a provider value', () => {
    const text = caption({ source: 'provider_reported', forecastMeta: { projectedPct: 62, saturated: false, confidence: 'medium' } });
    expect(text).toBe('Provider-reported · forecast 62% (medium confidence)');
  });

  it('describes a saturated forecast as risk instead of 100%', () => {
    const text = caption({ source: 'provider_reported', forecastMeta: { projectedPct: 100, saturated: true, confidence: 'low' } });
    expect(text).toContain('may reach limit');
    expect(text).not.toContain('100%');
  });

  it('explains why a reading is unavailable', () => {
    expect(caption({ source: null, errorCategory: 'auth_expired' })).toMatch(/Sign in/);
    expect(caption({ source: null, errorCategory: 'window_unavailable' })).toMatch(/did not report/);
    expect(caption({ source: null })).toMatch(/did not report/);
  });
});

import { describe, expect, it } from 'vitest';
import { formatWindowEnd, validEpochMs } from '../popup/formatters.mjs';

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

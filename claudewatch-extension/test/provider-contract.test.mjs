import { beforeAll, describe, expect, it } from 'vitest';

let C;
beforeAll(async () => {
  globalThis.self = globalThis;
  await import('../provider-contract.js');
  C = globalThis.TokenWatcherContract;
});

const NOW = Date.parse('2026-10-01T12:00:00Z');
const good = (over = {}) => ({
  contractVersion: 1, provider: 'claude', accountId: 'a', windowType: '5h', windowSeconds: 18000,
  usedPct: 40, remainingPct: 60, resetsAt: '2026-10-01T14:00:00Z',
  sourceTimestamp: null, fetchTimestamp: '2026-10-01T12:00:00Z',
  provenance: 'provider_reported', confidence: 'authoritative', error: null, ...over,
});

describe('validateReading', () => {
  it('accepts a consistent provider-reported reading', () => {
    expect(C.validateReading(good(), { now: NOW })).toBeNull();
  });

  it.each([
    ['used above 100', { usedPct: 101, remainingPct: -1 }, 'invalid_used_pct'],
    ['negative used', { usedPct: -1, remainingPct: 101 }, 'invalid_used_pct'],
    ['NaN used', { usedPct: NaN }, 'invalid_used_pct'],
    ['remaining does not complement used', { usedPct: 40, remainingPct: 40 }, 'inconsistent_percentages'],
    ['unknown provider', { provider: 'bard' }, 'invalid_provider'],
    ['unknown window', { windowType: '1h' }, 'invalid_window_type'],
    ['unknown provenance', { provenance: 'guess' }, 'invalid_provenance'],
    ['unparseable fetch time', { fetchTimestamp: 'yesterday' }, 'invalid_fetch_timestamp'],
    ['fetch time far in the future', { fetchTimestamp: '2026-10-01T13:00:00Z' }, 'fetch_timestamp_in_future'],
    ['source time after fetch time', { sourceTimestamp: '2026-10-01T12:30:00Z' }, 'source_after_fetch'],
    ['unparseable reset', { resetsAt: 'soon' }, 'invalid_reset_time'],
    ['reset a month away for a 5h window', { resetsAt: '2026-11-01T00:00:00Z' }, 'reset_beyond_window'],
  ])('rejects %s', (_label, over, code) => {
    expect(C.validateReading(good(over), { now: NOW })).toBe(code);
  });

  it('tolerates small clock skew between provider and device', () => {
    expect(C.validateReading(good({ fetchTimestamp: '2026-10-01T12:03:00Z' }), { now: NOW })).toBeNull();
  });

  it('does not validate values of an error reading', () => {
    const err = good({ usedPct: null, remainingPct: null, error: { category: 'auth_expired', message: 'x' } });
    expect(C.validateReading(err, { now: NOW })).toBeNull();
  });
});

describe('validateSnapshot', () => {
  const snap = over => ({ site: 'gemini', accountId: 'a', pct5h: 10, pct7d: 20, resetsAt5h: '2026-10-01T14:00:00Z', ...over });

  it('rejects percentages above 100 instead of storing them', () => {
    expect(C.validateSnapshot(snap({ pct5h: 140 }), { now: NOW })).toBe('invalid_pct5h');
    expect(C.validateSnapshot(snap({ pct7d: 1000 }), { now: NOW })).toBe('invalid_pct7d');
  });

  it('rejects negative, non-finite and impossible reset values', () => {
    expect(C.validateSnapshot(snap({ pct5h: -1 }), { now: NOW })).toBe('invalid_pct5h');
    expect(C.validateSnapshot(snap({ pct7d: Infinity }), { now: NOW })).toBe('invalid_pct7d');
    expect(C.validateSnapshot(snap({ resetsAt5h: 'later' }), { now: NOW })).toBe('invalid_resetsAt5h');
    expect(C.validateSnapshot(snap({ resetsAt5h: '2027-01-01T00:00:00Z' }), { now: NOW })).toBe('invalid_resetsAt5h');
  });

  it('requires a known provider and an account identity', () => {
    expect(C.validateSnapshot(snap({ site: 'x' }), { now: NOW })).toBe('invalid_site');
    expect(C.validateSnapshot(snap({ accountId: null }), { now: NOW })).toBe('account_identity_missing');
    expect(C.validateSnapshot(snap(), { now: NOW })).toBeNull();
  });
});

describe('toReadings', () => {
  it('returns one provider-reported reading per window with fetch time and no invented source time', () => {
    const readings = C.toReadings({ site: 'claude', accountId: 'a', pct5h: 25, pct7d: 50, resetsAt5h: '2026-10-01T14:00:00Z', resetsAt7d: '2026-10-04T12:00:00Z' }, { fetchedAt: NOW, now: NOW });
    expect(readings.map(r => [r.windowType, r.usedPct, r.remainingPct])).toEqual([['5h', 25, 75], ['7d', 50, 50]]);
    for (const r of readings) {
      expect(r.provenance).toBe('provider_reported');
      expect(r.sourceTimestamp).toBeNull();
      expect(r.fetchTimestamp).toBe('2026-10-01T12:00:00.000Z');
      expect(C.validateReading(r, { now: NOW })).toBeNull();
    }
  });

  it('turns an unreported window into an explained error reading, not a zero', () => {
    const [, week] = C.toReadings({ site: 'claude', accountId: 'a', pct5h: 25, pct7d: null }, { fetchedAt: NOW, now: NOW });
    expect(week.usedPct).toBeNull();
    expect(week.error.category).toBe('window_unavailable');
    expect(week.error.message).toMatch(/did not report/);
  });

  it('keeps provider percentages and local estimates apart', () => {
    const [r] = C.toReadings({ site: 'claude', accountId: 'a', pct5h: 25, localTokens5h: 9000 }, { fetchedAt: NOW, now: NOW });
    expect(r).not.toHaveProperty('localTokens5h');
    expect(r.provenance).toBe('provider_reported');
  });
});

describe('projectUsage', () => {
  const project = (currentPct, ratePerHour, horizonHours) => C.projectUsage({ currentPct, ratePerHour, horizonHours, now: NOW });

  it('does not saturate a modest burn rate', () => {
    const p = project(20, 5, 4);
    expect(p).toMatchObject({ projectedPct: 40, saturated: false, hoursToLimit: null, exhaustsAt: null });
  });

  it('flags saturation and reports when the limit is hit instead of repeating 100', () => {
    const slow = project(50, 10, 8);  // raw 130
    const fast = project(50, 25, 8);  // raw 250
    expect(slow.projectedPct).toBe(100);
    expect(fast.projectedPct).toBe(100);
    expect(slow.saturated && fast.saturated).toBe(true);
    // The clamped value alone is identical; the contract still tells the two apart.
    expect(slow.hoursToLimit).toBeCloseTo(5);
    expect(fast.hoursToLimit).toBeCloseTo(2);
    expect(slow.exhaustsAt).not.toBe(fast.exhaustsAt);
  });

  it('never projects below the current reading and ignores negative rates', () => {
    expect(project(30, -5, 4).projectedPct).toBe(30);
  });

  it('yields no forecast when already at the limit or inputs are unusable', () => {
    expect(project(100, 5, 4)).toBeNull();
    expect(project(NaN, 5, 4)).toBeNull();
    expect(project(20, Infinity, 4)).toBeNull();
    expect(project(20, 5, 0)).toBeNull();
    expect(project(120, 5, 4)).toBeNull();
  });

  it('formats a saturated forecast as a risk, not as 100%', () => {
    const pct = v => `${Math.round(v)}%`;
    expect(C.formatForecast(project(20, 5, 4), pct)).toBe('→ 40%');
    expect(C.formatForecast(project(50, 25, 8), pct)).toBe('may reach limit');
    expect(C.formatForecast(null, pct)).toBeNull();
  });
});

describe('copy', () => {
  it('has a user-facing reason for every error category the adapters and policy emit', () => {
    for (const c of ['window_unavailable', 'reading_invalid', 'provider_schema_changed', 'auth_expired', 'provider_tab_missing', 'rate_limited', 'network', 'timeout']) {
      expect(C.describeUnavailable(c)).not.toBe(C.describeUnavailable('other'));
    }
  });

  it('labels provenance so provider data is distinguishable from estimates', () => {
    expect(C.describeProvenance('provider_reported')).toMatch(/provider/i);
    expect(C.describeProvenance('local_estimate')).toMatch(/estimated/i);
    expect(C.describeProvenance('forecast')).toMatch(/forecast/i);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SpendThreshold } from '../../config/schema.js';

// vi.hoisted() is the Vitest 4.x way to share mock references between
// the vi.mock() factory and the test body without relying on deprecated
// automatic "mock*" prefix hoisting.
const mockHasAlertFired = vi.hoisted(() => vi.fn());
const mockRecordAlert = vi.hoisted(() => vi.fn());

vi.mock('../../store/db.js', () => ({
  hasAlertFired: mockHasAlertFired,
  recordAlert: mockRecordAlert,
}));

// usage.ts is imported transitively by threshold.ts; mock it so the chain
// never reaches better-sqlite3.
vi.mock('../../store/usage.js', () => ({
  getTotalCostSince: vi.fn().mockReturnValue(0),
}));

import { evaluateThresholdsWithCosts, periodStart } from '../threshold.js';

const FIXED_NOW = new Date('2024-06-15T14:30:00.000Z'); // Saturday

describe('periodStart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('returns midnight UTC of the current day for "daily"', () => {
    expect(periodStart('daily')).toBe('2024-06-15T00:00:00.000Z');
  });

  it('returns the most recent Sunday midnight UTC for "weekly"', () => {
    // June 15 is Saturday (getUTCDay()=6) → Sun June 9
    expect(periodStart('weekly')).toBe('2024-06-09T00:00:00.000Z');
  });

  it('returns the first of the current UTC month for "monthly"', () => {
    expect(periodStart('monthly')).toBe('2024-06-01T00:00:00.000Z');
  });
});

describe('evaluateThresholdsWithCosts', () => {
  const daily: SpendThreshold = { amountUsd: 10, period: 'daily', notifyEmail: true, notifyDesktop: false };
  const weekly: SpendThreshold = { amountUsd: 50, period: 'weekly', notifyEmail: false, notifyDesktop: true };
  const monthly: SpendThreshold = { amountUsd: 200, period: 'monthly', notifyEmail: true, notifyDesktop: true };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    mockHasAlertFired.mockReturnValue(false);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('returns an empty array when the threshold list is empty', () => {
    expect(evaluateThresholdsWithCosts([], { daily: 100, weekly: 200, monthly: 300 })).toEqual([]);
  });

  it('does not trigger when actual cost is strictly below the threshold', () => {
    const result = evaluateThresholdsWithCosts([daily], { daily: 9.99, weekly: 0, monthly: 0 });
    expect(result).toHaveLength(0);
    expect(mockRecordAlert).not.toHaveBeenCalled();
  });

  it('triggers when actual cost exactly equals the threshold', () => {
    const result = evaluateThresholdsWithCosts([daily], { daily: 10, weekly: 0, monthly: 0 });
    expect(result).toHaveLength(1);
    expect(result[0]?.threshold).toBe(daily);
    expect(result[0]?.actualUsd).toBe(10);
  });

  it('triggers when actual cost exceeds the threshold', () => {
    const result = evaluateThresholdsWithCosts([daily], { daily: 42.5, weekly: 0, monthly: 0 });
    expect(result).toHaveLength(1);
    expect(result[0]?.actualUsd).toBe(42.5);
  });

  it('deduplicates: does not re-fire when hasAlertFired returns true', () => {
    mockHasAlertFired.mockReturnValue(true);
    const result = evaluateThresholdsWithCosts([daily], { daily: 99, weekly: 0, monthly: 0 });
    expect(result).toHaveLength(0);
    expect(mockRecordAlert).not.toHaveBeenCalled();
  });

  it('calls recordAlert with correct arguments when triggered', () => {
    evaluateThresholdsWithCosts([daily], { daily: 15, weekly: 0, monthly: 0 });
    expect(mockRecordAlert).toHaveBeenCalledWith(10, 'daily', 15, ['email']);
  });

  it('passes the correct periodStart timestamp to hasAlertFired', () => {
    evaluateThresholdsWithCosts([daily], { daily: 15, weekly: 0, monthly: 0 });
    expect(mockHasAlertFired).toHaveBeenCalledWith(10, 'daily', '2024-06-15T00:00:00.000Z');
  });

  it('builds channels list from notifyEmail and notifyDesktop flags', () => {
    const emailOnly: SpendThreshold = { amountUsd: 1, period: 'daily', notifyEmail: true, notifyDesktop: false };
    const desktopOnly: SpendThreshold = { amountUsd: 1, period: 'weekly', notifyEmail: false, notifyDesktop: true };
    const both: SpendThreshold = { amountUsd: 1, period: 'monthly', notifyEmail: true, notifyDesktop: true };

    evaluateThresholdsWithCosts([emailOnly], { daily: 5, weekly: 5, monthly: 5 });
    expect(mockRecordAlert).toHaveBeenLastCalledWith(1, 'daily', 5, ['email']);

    vi.clearAllMocks();
    mockHasAlertFired.mockReturnValue(false);

    evaluateThresholdsWithCosts([desktopOnly], { daily: 5, weekly: 5, monthly: 5 });
    expect(mockRecordAlert).toHaveBeenLastCalledWith(1, 'weekly', 5, ['desktop']);

    vi.clearAllMocks();
    mockHasAlertFired.mockReturnValue(false);

    evaluateThresholdsWithCosts([both], { daily: 5, weekly: 5, monthly: 5 });
    expect(mockRecordAlert).toHaveBeenLastCalledWith(1, 'monthly', 5, ['email', 'desktop']);
  });

  it('evaluates each threshold independently against its own period cost', () => {
    // daily cost < threshold, weekly cost >= threshold, monthly cost >= threshold
    const result = evaluateThresholdsWithCosts(
      [daily, weekly, monthly],
      { daily: 5, weekly: 60, monthly: 250 },
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.threshold.period).toBe('weekly');
    expect(result[1]?.threshold.period).toBe('monthly');
  });

  it('records one alert per triggered threshold in a single call', () => {
    evaluateThresholdsWithCosts(
      [daily, weekly, monthly],
      { daily: 20, weekly: 80, monthly: 300 },
    );
    expect(mockRecordAlert).toHaveBeenCalledTimes(3);
  });
});

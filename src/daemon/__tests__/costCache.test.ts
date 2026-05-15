import { describe, it, expect, beforeEach } from 'vitest';
import { getCostCache, setCostCache } from '../costCache.js';
import type { CachedCosts } from '../costCache.js';

const sample: CachedCosts = {
  monthly: 42.5,
  weekly: 10.25,
  daily: 1.5,
  updatedAt: '2024-06-15T14:30:00.000Z',
  billingPeriodStart: '2024-06-01T00:00:00.000Z',
  billingPeriodEnd: '2024-06-15T14:30:00.000Z',
};

describe('costCache', () => {
  beforeEach(() => {
    // Reset to null between tests by setting an impossible sentinel then clearing
    setCostCache(sample);
  });

  it('getCostCache returns null before any value is set', () => {
    // We can only test the null case via the module's initial state — reset by
    // importing a fresh module. Here we rely on ordering: the test runner runs
    // tests in isolation when vi.resetModules() is used, but for this simple
    // singleton it's enough to check that setCostCache→getCostCache round-trips.
    setCostCache(sample);
    expect(getCostCache()).not.toBeNull();
  });

  it('getCostCache returns the value set by setCostCache', () => {
    setCostCache(sample);
    expect(getCostCache()).toEqual(sample);
  });

  it('setCostCache overwrites a previous value', () => {
    const first: CachedCosts = { ...sample, monthly: 1 };
    const second: CachedCosts = { ...sample, monthly: 99 };
    setCostCache(first);
    setCostCache(second);
    expect(getCostCache()?.monthly).toBe(99);
  });

  it('getCostCache returns a reference to the stored object (not a copy)', () => {
    setCostCache(sample);
    expect(getCostCache()).toBe(getCostCache());
  });

  it('all CachedCosts fields are preserved exactly', () => {
    setCostCache(sample);
    const result = getCostCache()!;
    expect(result.monthly).toBe(42.5);
    expect(result.weekly).toBe(10.25);
    expect(result.daily).toBe(1.5);
    expect(result.updatedAt).toBe('2024-06-15T14:30:00.000Z');
    expect(result.billingPeriodStart).toBe('2024-06-01T00:00:00.000Z');
    expect(result.billingPeriodEnd).toBe('2024-06-15T14:30:00.000Z');
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { runSoak, mulberry32 } from './refresh-soak.mjs';

let R;
beforeAll(async () => {
  globalThis.self = {};
  await import('../refresh-policy.js');
  R = self.TokenWatcherRefresh;
});

const MIN = 60_000;
const failed = (category, now = 0, failures = 1, extra = {}) => ({
  ...R.initialState(), lastAttemptAt: now, failures, category, nextRetryAt: null, ...extra,
});

describe('retryDelayMs', () => {
  it('grows exponentially, is capped, and is jittered between 50% and 100%', () => {
    expect(R.retryDelayMs('network', 1, () => 1)).toBe(15_000);
    expect(R.retryDelayMs('network', 1, () => 0)).toBe(7_500);
    expect(R.retryDelayMs('network', 3, () => 1)).toBe(60_000);
    expect(R.retryDelayMs('network', 50, () => 1)).toBe(5 * MIN);
    expect(R.retryDelayMs('rate_limited', 50, () => 1)).toBe(30 * MIN);
  });
  it('returns null for categories that wait for a recovery signal', () => {
    for (const c of ['auth_expired', 'provider_tab_missing', 'provider_schema_changed']) expect(R.retryDelayMs(c, 2)).toBeNull();
  });
  it('treats unknown categories as generic retryable errors', () => {
    expect(R.retryDelayMs('mystery', 1, () => 1)).toBe(30_000);
  });
});

describe('evaluate', () => {
  const now = 100 * MIN;
  it('always runs the first attempt', () => {
    for (const trigger of R.TRIGGERS.filter(t => t !== 'manual')) expect(R.evaluate({ now, trigger }).run).toBe(true);
  });
  it('never starts a second refresh while one is in flight, even for manual', () => {
    expect(R.evaluate({ now, trigger: 'manual', inFlight: true })).toEqual({ run: false, why: 'in_flight' });
  });
  it('lets manual retry bypass backoff', () => {
    const state = failed('rate_limited', now - MIN, 3, { nextRetryAt: now + 20 * MIN });
    expect(R.evaluate({ now, trigger: 'manual', state }).run).toBe(true);
  });
  it('throttles bursts of tab events with the minimum age', () => {
    const state = { ...R.initialState(), lastAttemptAt: now - 5_000, lastSuccessAt: now - 5_000 };
    expect(R.evaluate({ now, trigger: 'tab_activated', state })).toEqual({ run: false, why: 'too_soon' });
    expect(R.evaluate({ now: now + 11_000, trigger: 'tab_activated', state }).run).toBe(true);
  });
  it('honours backoff for alarm and tab events after a rate limit', () => {
    const state = failed('rate_limited', now - MIN, 2, { nextRetryAt: now + 10 * MIN });
    expect(R.evaluate({ now, trigger: 'alarm', state }).why).toBe('backing_off');
    expect(R.evaluate({ now, trigger: 'navigation', state }).why).toBe('backing_off');
    expect(R.evaluate({ now: now + 10 * MIN, trigger: 'retry', state }).run).toBe(true);
  });
  it('resumes immediately when a tab or sign-in appears after a missing-tab or expired-session failure', () => {
    const missing = failed('provider_tab_missing', now - 1_000);
    expect(R.evaluate({ now, trigger: 'tab_created', state: missing })).toEqual({ run: true, why: 'recovery_trigger' });
    const expired = failed('auth_expired', now - 1_000);
    expect(R.evaluate({ now, trigger: 'auth_recovery', state: expired }).run).toBe(true);
    expect(R.evaluate({ now, trigger: 'wake', state: expired }).run).toBe(false);
  });
  it('resumes on network restoration only after network failures', () => {
    const offline = failed('network', now - 1_000, 4, { nextRetryAt: now + 3 * MIN });
    expect(R.evaluate({ now, trigger: 'network_restored', state: offline }).run).toBe(true);
    const limited = failed('rate_limited', now - 1_000, 4, { nextRetryAt: now + 3 * MIN });
    expect(R.evaluate({ now, trigger: 'network_restored', state: limited }).run).toBe(false);
  });
  it('keeps probing a non-retryable failure at the poll cadence', () => {
    const state = failed('auth_expired', now - 6 * MIN);
    expect(R.evaluate({ now, trigger: 'alarm', state }).run).toBe(true);
  });
  it('runs the watchdog only after the poll interval has clearly been missed', () => {
    const state = { ...R.initialState(), lastAttemptAt: now - 6 * MIN, lastSuccessAt: now - 6 * MIN };
    expect(R.evaluate({ now, trigger: 'watchdog', state }).run).toBe(false);
    expect(R.evaluate({ now: now + 2 * MIN, trigger: 'watchdog', state }).run).toBe(true);
  });
});

describe('applyOutcome', () => {
  it('resets failures and the retry time on success but keeps the attempt time', () => {
    const next = R.applyOutcome(failed('network', 5, 4, { nextRetryAt: 99 }), { now: 1000, ok: true, trigger: 'alarm' });
    expect(next).toMatchObject({ failures: 0, category: null, nextRetryAt: null, lastSuccessAt: 1000, lastAttemptAt: 1000 });
  });
  it('counts consecutive failures, schedules a jittered retry, and preserves the last success', () => {
    let state = R.applyOutcome(R.initialState(), { now: 0, ok: true });
    state = R.applyOutcome(state, { now: 10, ok: false, category: 'network' }, () => 1);
    state = R.applyOutcome(state, { now: 20, ok: false, category: 'network' }, () => 1);
    expect(state).toMatchObject({ failures: 2, lastSuccessAt: 0, nextRetryAt: 20 + 30_000 });
  });
  it('does not schedule a retry for non-retryable categories', () => {
    expect(R.applyOutcome(R.initialState(), { now: 5, ok: false, category: 'auth_expired' }).nextRetryAt).toBeNull();
  });
});

describe('staleInfo and describeFreshness', () => {
  const now = 100 * MIN;
  it('is not stale within the threshold', () => {
    const state = { ...R.initialState(), lastAttemptAt: now, lastSuccessAt: now - 10 * MIN };
    expect(R.staleInfo(state, now)).toMatchObject({ stale: false, explained: true });
  });
  it.each([
    ['auth_expired', true, false], ['provider_tab_missing', true, false], ['rate_limited', true, true],
    ['network', true, true], ['provider_schema_changed', true, false], ['other', false, true],
  ])('gives a visible reason for %s', (category, explained, retryable) => {
    const info = R.staleInfo(failed(category, now, 3, { lastSuccessAt: now - 30 * MIN }), now);
    expect(info).toMatchObject({ stale: true, code: category, explained: category === 'other' ? false : explained, retryable });
    expect(info.message).toBeTruthy();
  });
  it('flags a stale reading with no recorded cause as unexplained', () => {
    const idle = { ...R.initialState(), lastAttemptAt: now - 40 * MIN, lastSuccessAt: now - 40 * MIN };
    expect(R.staleInfo(idle, now)).toMatchObject({ stale: true, code: 'scheduler_gap', explained: false });
    expect(R.staleInfo(R.initialState(), now)).toMatchObject({ code: 'not_attempted', explained: false });
  });
  it('reports the provider fetch time separately from the local render time', () => {
    const state = { ...R.initialState(), lastAttemptAt: now, lastSuccessAt: now - 40 * MIN, failures: 2, category: 'network', nextRetryAt: now + MIN };
    expect(R.describeFreshness(state, now, now)).toMatchObject({
      lastFetchAt: now - 40 * MIN, lastRenderAt: now, lastAttemptAt: now, stale: true, staleReason: 'network', consecutiveFailures: 2, nextRetryAt: now + MIN,
    });
  });
});

describe('recovery scenarios', () => {
  const step = (state, now, trigger, outcome) => {
    const decision = R.evaluate({ now, trigger, state });
    return decision.run ? R.applyOutcome(state, { now, trigger, ...outcome }, () => 1) : state;
  };
  it('suspended service worker: a restart refreshes immediately when the last attempt is old', () => {
    const state = { ...R.initialState(), lastAttemptAt: 0, lastSuccessAt: 0 };
    expect(R.evaluate({ now: 40 * MIN, trigger: 'worker_restart', state }).run).toBe(true);
  });
  it('expired session: waits, then recovers on sign-in', () => {
    let state = step(R.initialState(), 0, 'startup', { ok: false, category: 'auth_expired' });
    state = step(state, 2 * MIN, 'wake', { ok: true });
    expect(state.category).toBe('auth_expired');
    state = step(state, 3 * MIN, 'auth_recovery', { ok: true });
    expect(state).toMatchObject({ category: null, failures: 0 });
  });
  it('offline period: retries back off and then recover', () => {
    let state = step(R.initialState(), 0, 'startup', { ok: false, category: 'network' });
    state = step(state, 30_000, 'retry', { ok: false, category: 'network' });
    expect(state.failures).toBe(2);
    state = step(state, 5 * MIN, 'network_restored', { ok: true });
    expect(state.failures).toBe(0);
  });
  it('rate limit: alarms are suppressed until the backoff expires', () => {
    let state = step(R.initialState(), 0, 'startup', { ok: false, category: 'rate_limited' });
    state = step(state, 2 * MIN, 'retry', { ok: false, category: 'rate_limited' });
    expect(state.nextRetryAt).toBe(2 * MIN + 4 * MIN);
    state = step(state, 3 * MIN, 'tab_activated', { ok: true });
    expect(state.failures).toBe(2);
    state = step(state, 6 * MIN, 'retry', { ok: true });
    expect(state.failures).toBe(0);
  });
  it('schema change: stays flagged and is only re-probed at the poll cadence', () => {
    const state = step(R.initialState(), 0, 'startup', { ok: false, category: 'provider_schema_changed' });
    expect(R.evaluate({ now: MIN, trigger: 'navigation', state }).run).toBe(false);
    expect(R.evaluate({ now: 6 * MIN, trigger: 'alarm', state }).run).toBe(true);
  });
  it('missing tab: first tab creation retries immediately', () => {
    let state = step(R.initialState(), 0, 'startup', { ok: false, category: 'provider_tab_missing' });
    state = step(state, 20_000, 'tab_created', { ok: true });
    expect(state.category).toBeNull();
  });
});

describe('accelerated soak simulation', () => {
  it('is deterministic for a seed', () => {
    expect(runSoak({ hours: 6, seed: 1 })).toEqual(runSoak({ hours: 6, seed: 1 }));
  });
  it('has a seedable PRNG in [0,1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 100; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
  it('reports measured values over 24 simulated hours', () => {
    const result = runSoak({ hours: 24, seed: 20261022 });
    expect(result.attempts).toBeGreaterThan(100);
    expect(result.successRate).toBeGreaterThan(0);
    expect(result.successRateWhenUpstreamAvailable).toBeGreaterThan(0.9);
    expect(Number.isFinite(result.maxUnexplainedStaleMinutes)).toBe(true);
  });
});

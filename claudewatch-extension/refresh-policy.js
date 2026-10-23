// Pure refresh-scheduling policy shared by the service worker and tests.
// No chrome.* access and no timers: callers pass the clock and the random source,
// so the same decisions can be replayed deterministically in the soak simulation.
(function registerRefreshPolicy(scope) {
  const POLL_MS = 5 * 60_000;
  const STALE_MS = 15 * 60_000;

  const TRIGGERS = [
    'install', 'startup', 'worker_restart', 'wake', 'focus', 'tab_created', 'tab_activated',
    'navigation', 'alarm', 'watchdog', 'manual', 'auth_recovery', 'network_restored', 'retry', 'stats_read',
  ];

  // Triggers that signal the cause of a failure may be gone, per category. Rate limits and
  // schema changes have none: only time (or an extension update) fixes them.
  const TAB_RECOVERY = ['tab_created', 'tab_activated', 'navigation', 'auth_recovery'];
  const NETWORK_RECOVERY = ['network_restored'];
  // Minimum age of the last attempt before a trigger may start another one.
  const MIN_AGE_MS = {
    install: 0, startup: 0, worker_restart: 0, tab_created: 0, navigation: 0, auth_recovery: 0, network_restored: 0, manual: 0,
    retry: 0, watchdog: POLL_MS + 2 * 60_000, tab_activated: 15_000, stats_read: 60_000, focus: POLL_MS, wake: POLL_MS, alarm: POLL_MS - 15_000,
  };

  // retryable: backs off automatically. Otherwise the reading waits for a recovery trigger
  // (and the normal poll cadence, which keeps probing at the slow rate).
  const POLICY = {
    network:                 { retryable: true,  baseMs: 15_000,  maxMs: 5 * 60_000,  resumeOn: NETWORK_RECOVERY, message: 'No network connection. Retrying automatically.' },
    timeout:                 { retryable: true,  baseMs: 15_000,  maxMs: 5 * 60_000,  resumeOn: NETWORK_RECOVERY, message: 'The provider timed out. Retrying automatically.' },
    provider_tab_timeout:    { retryable: true,  baseMs: 30_000,  maxMs: 5 * 60_000,  message: 'The provider tab did not respond. Retrying automatically.' },
    rate_limited:            { retryable: true,  baseMs: 120_000, maxMs: 30 * 60_000, message: 'The provider is rate limiting requests. Backing off.' },
    other:                   { retryable: true,  baseMs: 30_000,  maxMs: 10 * 60_000, message: 'Unexpected error. Retrying automatically.' },
    auth_expired:            { retryable: false, resumeOn: TAB_RECOVERY, message: 'Signed out or session expired. Sign in to the provider, then retry.' },
    provider_tab_missing:    { retryable: false, resumeOn: TAB_RECOVERY, message: 'No signed-in provider tab is open. Open the provider site, then retry.' },
    provider_schema_changed: { retryable: false, message: 'The provider changed its response format. An update is needed.' },
  };

  const policyFor = category => POLICY[category] ?? POLICY.other;

  // Full-jitter-lite: 50-100% of the capped exponential delay.
  function retryDelayMs(category, failures, random = Math.random) {
    const policy = policyFor(category);
    if (!policy.retryable) return null;
    const exponent = Math.min(Math.max(failures, 1) - 1, 16);
    const capped = Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
    return Math.round(capped * (0.5 + 0.5 * random()));
  }

  function initialState() {
    return { lastAttemptAt: null, lastSuccessAt: null, failures: 0, category: null, nextRetryAt: null, lastTrigger: null };
  }

  // Idempotent: callers may invoke this for every event; only one cause is returned.
  function evaluate({ now, trigger, state = initialState(), inFlight = false }) {
    if (inFlight) return { run: false, why: 'in_flight' };
    if (trigger === 'manual') return { run: true, why: 'manual' };
    const minAge = MIN_AGE_MS[trigger] ?? POLL_MS;
    if (state.lastAttemptAt == null) return { run: true, why: 'never_attempted' };
    const recovery = state.category != null && (policyFor(state.category).resumeOn ?? []).includes(trigger);
    if (recovery) return { run: true, why: 'recovery_trigger' };
    if (state.nextRetryAt != null && now < state.nextRetryAt) return { run: false, why: 'backing_off' };
    // Without a recovery signal a non-retryable failure is only re-probed at the poll cadence.
    const slow = state.category != null && !policyFor(state.category).retryable && trigger !== 'startup' && trigger !== 'install';
    if (now - state.lastAttemptAt < (slow ? Math.max(minAge, MIN_AGE_MS.alarm) : minAge)) return { run: false, why: 'too_soon' };
    return { run: true, why: 'due' };
  }

  function applyOutcome(state, { now, ok, category = 'other', trigger = null }, random = Math.random) {
    const base = { ...initialState(), ...state, lastAttemptAt: now, lastTrigger: trigger };
    if (ok) return { ...base, lastSuccessAt: now, failures: 0, category: null, nextRetryAt: null };
    const failures = base.failures + 1;
    const delay = retryDelayMs(category, failures, random);
    return { ...base, failures, category, nextRetryAt: delay == null ? null : now + delay };
  }

  // The user-visible stale reason. "Unexplained" means stale with no recorded cause:
  // that is the interval the scheduler is accountable for.
  function staleInfo(state = initialState(), now = Date.now()) {
    const ageMs = state.lastSuccessAt == null ? null : Math.max(0, now - state.lastSuccessAt);
    const stale = ageMs == null || ageMs > STALE_MS;
    if (!stale) return { stale: false, ageMs, code: null, message: null, explained: true, retryable: false, nextRetryAt: null };
    if (state.category) {
      const policy = policyFor(state.category);
      return {
        stale: true, ageMs, code: state.category, message: policy.message, explained: state.category !== 'other',
        retryable: policy.retryable, nextRetryAt: state.nextRetryAt,
      };
    }
    if (state.lastAttemptAt == null) {
      return { stale: true, ageMs, code: 'not_attempted', message: 'No refresh has run yet.', explained: false, retryable: true, nextRetryAt: null };
    }
    return { stale: true, ageMs, code: 'scheduler_gap', message: 'Refresh has not succeeded recently and no error was recorded.', explained: false, retryable: true, nextRetryAt: null };
  }

  // Provider fetch time and local render time are separate on purpose: a fresh render of
  // an old reading must not look current.
  function describeFreshness(state, now, lastRenderAt = null) {
    const info = staleInfo(state, now);
    return {
      lastFetchAt: state.lastSuccessAt, lastAttemptAt: state.lastAttemptAt, lastRenderAt,
      stale: info.stale, staleReason: info.code, staleMessage: info.message, retryable: info.retryable,
      nextRetryAt: info.nextRetryAt, consecutiveFailures: state.failures ?? 0,
    };
  }

  scope.TokenWatcherRefresh = {
    POLL_MS, STALE_MS, TRIGGERS, POLICY,
    retryDelayMs, initialState, evaluate, applyOutcome, staleInfo, describeFreshness,
  };
})(self);

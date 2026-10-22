// Accelerated refresh soak: drives the real refresh policy (refresh-policy.js) against a
// simulated provider and a deterministic fake clock. It exercises the scheduling logic, not
// a real browser or provider, and says so in its report.
import { readFileSync } from 'node:fs';

const MIN = 60_000;
const load = () => {
  globalThis.self = globalThis.self ?? {};
  new Function('self', readFileSync(new URL('../refresh-policy.js', import.meta.url), 'utf8'))(globalThis.self);
  return globalThis.self.TokenWatcherRefresh;
};

// Small seeded PRNG so a run is reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fault windows injected into the provider, in minutes from the start. `endsBy` says what clears it.
function buildFaults(random, hours) {
  const faults = [];
  const add = (kind, count, minLen, maxLen) => {
    for (let i = 0; i < count; i++) {
      const start = Math.floor(random() * (hours * 60 - maxLen - 5));
      faults.push({ kind, start, end: start + minLen + Math.floor(random() * (maxLen - minLen)) });
    }
  };
  add('offline', 6, 5, 40);
  add('rate_limited', 4, 10, 45);
  add('schema_changed', 1, 20, 40);
  add('session_expired', 3, 15, 90);   // cleared only by a sign-in (navigation) after the window
  add('tab_missing', 3, 10, 60);       // cleared by a tab being opened
  add('worker_suspended', 24, 6, 25);  // alarms are lost while suspended
  return faults;
}

export function runSoak({ hours = 24, seed = 20261022 } = {}) {
  const R = load();
  const random = mulberry32(seed);
  const faults = buildFaults(random, hours);
  const activeFault = (kind, minute) => faults.find(f => f.kind === kind && minute >= f.start && minute < f.end);
  const category = {
    offline: 'network', rate_limited: 'rate_limited', schema_changed: 'provider_schema_changed',
    session_expired: 'auth_expired', tab_missing: 'provider_tab_missing',
  };

  let state = R.initialState();
  let attempts = 0, successes = 0, availableAttempts = 0, availableSuccesses = 0;
  let lastUserEventMinute = -Infinity;
  const stats = { maxStaleMs: 0, maxUnexplainedStaleMs: 0, staleMs: 0, unexplainedStaleMs: 0 };
  let curStale = 0, curUnexplained = 0, curAwake = 0, maxUnexplainedAwake = 0;

  const upstream = minute => {
    for (const kind of ['offline', 'rate_limited', 'schema_changed']) if (activeFault(kind, minute)) return category[kind];
    const session = faults.find(f => f.kind === 'session_expired' && minute >= f.start && minute < f.end);
    if (session && lastUserEventMinute < session.start + 1) return 'auth_expired';
    // A user signing in/opening a tab after the window start clears these.
    const missing = faults.find(f => f.kind === 'tab_missing' && minute >= f.start && minute < f.end);
    if (missing && lastUserEventMinute < missing.start + 1) return 'provider_tab_missing';
    return null;
  };

  const attempt = (minute, trigger) => {
    const now = minute * MIN;
    const decision = R.evaluate({ now, trigger, state });
    if (!decision.run) return;
    const failure = upstream(minute);
    attempts++; if (!failure) successes++;
    const clean = !faults.some(f => ['offline', 'rate_limited', 'schema_changed', 'session_expired', 'tab_missing'].includes(f.kind) && minute >= f.start && minute < f.end);
    if (clean) { availableAttempts++; if (!failure) availableSuccesses++; }
    state = R.applyOutcome(state, { now, ok: !failure, category: failure ?? 'other', trigger }, random);
  };

  // User behaviour: the user ends a sign-in/tab fault by returning to the provider a little after it ends.
  const userEvents = new Map();
  for (const f of faults.filter(x => x.kind === 'session_expired' || x.kind === 'tab_missing')) {
    userEvents.set(f.end - 1 - Math.floor(random() * 3), f.kind === 'session_expired' ? 'navigation' : 'tab_created');
  }

  let wasSuspended = false;
  for (let minute = 0; minute < hours * 60; minute++) {
    const suspended = Boolean(activeFault('worker_suspended', minute));
    if (!suspended && wasSuspended) attempt(minute, 'worker_restart');
    wasSuspended = suspended;
    if (minute === 0) attempt(minute, 'startup');
    if (userEvents.has(minute)) { lastUserEventMinute = minute; attempt(minute, userEvents.get(minute)); }
    // Network restoration is observed by the worker when connectivity returns.
    const offline = activeFault('offline', minute);
    if (offline && minute === offline.end - 1) attempt(minute, 'network_restored');
    // Alarms only fire while the worker is alive.
    if (!suspended) {
      if (minute % (R.POLL_MS / MIN) === 0) attempt(minute, 'alarm');
      if (state.nextRetryAt != null && minute * MIN >= state.nextRetryAt) attempt(minute, 'retry');
      attempt(minute, 'watchdog');
    }
    const info = R.staleInfo(state, minute * MIN);
    if (info.stale && minute * MIN > R.STALE_MS) {
      curStale += MIN; stats.staleMs += MIN;
      if (info.explained) { curUnexplained = 0; curAwake = 0; } else {
        curUnexplained += MIN; stats.unexplainedStaleMs += MIN;
        // Time while the worker was suspended (alarms lost) is reported separately from time it was running.
        curAwake = suspended ? 0 : curAwake + MIN;
      }
      maxUnexplainedAwake = Math.max(maxUnexplainedAwake, curAwake);
      stats.maxStaleMs = Math.max(stats.maxStaleMs, curStale);
      stats.maxUnexplainedStaleMs = Math.max(stats.maxUnexplainedStaleMs, curUnexplained);
    } else { curStale = 0; curUnexplained = 0; curAwake = 0; }
  }

  return {
    seed, hours, attempts, successes, availableAttempts, availableSuccesses,
    successRate: attempts ? successes / attempts : null,
    successRateWhenUpstreamAvailable: availableAttempts ? availableSuccesses / availableAttempts : null,
    maxStaleMinutes: stats.maxStaleMs / MIN,
    maxUnexplainedStaleMinutes: stats.maxUnexplainedStaleMs / MIN,
    maxUnexplainedStaleWhileWorkerRunningMinutes: maxUnexplainedAwake / MIN,
    totalStaleMinutes: stats.staleMs / MIN,
    totalUnexplainedStaleMinutes: stats.unexplainedStaleMs / MIN,
    faults: faults.map(f => ({ ...f })),
  };
}

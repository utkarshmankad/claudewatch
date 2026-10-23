// activity-collector.js — opt-in, metadata-only browser activity observations.
// Observations feed the usage ledger as local_activity records. They are
// evidence of local use, never authoritative quota measurements. Nothing here
// performs network I/O. Loaded by the service worker via importScripts and by
// the settings page via <script>; tests import it with a stubbed `self`.
(function registerActivityCollector(scope) {
  const SCHEMA_VERSION = 1;
  const EVENTS_KEY = 'activity_events_v1';
  const SETTINGS_KEY = 'activity_settings_v1';
  const SESSION_KEY = 'activity_sessions_v1';
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RETENTION = Object.freeze({ maxAgeMs: 30 * DAY_MS, maxEvents: 5000 });
  const MIN_TS = Date.UTC(2020, 0, 1);
  const MAX_TS = Date.UTC(2100, 0, 1);

  const PROVIDERS = ['claude', 'chatgpt', 'gemini'];
  const ACTIVITY_TYPES = ['message_sent', 'message_completed', 'message_failed'];
  const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;
  const ID_PATTERN = /^[a-f0-9]{32}$/;
  const SESSION_PATTERN = /^[a-f0-9]{16,32}$/;

  // What the user is told will be recorded. The settings page renders this
  // list verbatim so the consent text cannot drift from the schema.
  const RECORDED_FIELDS = Object.freeze([
    'Which assistant (Claude, ChatGPT or Gemini)',
    'When the activity happened',
    'A random local session identifier that changes when the browser restarts',
    'The model name, only when the page states it reliably',
    'A coarse activity type: message sent, completed or failed',
  ]);
  const NEVER_RECORDED = Object.freeze([
    'Prompt or response text', 'Attachments', 'Conversation titles', 'Full URLs', 'Page contents', 'Cookies or tokens',
  ]);

  const ALLOWED_KEYS = new Set(['v', 'id', 'provider', 'ts', 'sessionId', 'model', 'activityType']);

  // Returns { ok, errors[] }. Fail closed: unknown fields are rejected, so free
  // text cannot ride along. Never throws, never mutates.
  function validateActivity(event) {
    const errors = [];
    if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, errors: ['event_not_object'] };
    for (const key of Object.keys(event)) if (!ALLOWED_KEYS.has(key)) errors.push(`unknown_field:${key}`);
    if (event.v !== SCHEMA_VERSION) errors.push('unsupported_schema_version');
    if (typeof event.id !== 'string' || !ID_PATTERN.test(event.id)) errors.push('invalid_id');
    if (!PROVIDERS.includes(event.provider)) errors.push('invalid_provider');
    if (!Number.isInteger(event.ts) || event.ts < MIN_TS || event.ts > MAX_TS) errors.push('invalid_ts');
    if (typeof event.sessionId !== 'string' || !SESSION_PATTERN.test(event.sessionId)) errors.push('invalid_session');
    if (event.model !== undefined && !(typeof event.model === 'string' && MODEL_PATTERN.test(event.model))) errors.push('invalid_model');
    if (!ACTIVITY_TYPES.includes(event.activityType)) errors.push('invalid_activity_type');
    return { ok: errors.length === 0, errors };
  }

  function randomHex(bytes) {
    const buf = new Uint8Array(bytes);
    (scope.crypto || globalThis.crypto).getRandomValues(buf);
    return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
  }

  // Storage adapter: { get(key) -> Promise<any|null>, set(key, value) -> Promise, remove(key) -> Promise }
  function chromeStorageAdapter() {
    return {
      get: key => new Promise(resolve => chrome.storage.local.get(key, r => resolve(r?.[key] ?? null))),
      set: (key, value) => new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve)),
      remove: key => new Promise(resolve => chrome.storage.local.remove(key, resolve)),
    };
  }

  function createStore(storage, { now = () => Date.now() } = {}) {
    // Writes are serialized so concurrent tabs and service-worker wake-ups
    // cannot lose or duplicate events through interleaved read-modify-write.
    let queue = Promise.resolve();
    const serialize = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

    const readSettings = async () => ({ enabled: false, ...(await storage.get(SETTINGS_KEY)) });
    const readEvents = async () => {
      const stored = await storage.get(EVENTS_KEY);
      return Array.isArray(stored) ? stored.filter(e => validateActivity(e).ok) : [];
    };
    const prune = events => {
      const cutoff = now() - RETENTION.maxAgeMs;
      return events.filter(e => e.ts >= cutoff).slice(-RETENTION.maxEvents);
    };

    return {
      isEnabled: async () => (await readSettings()).enabled === true,
      setEnabled: enabled => serialize(async () => {
        await storage.set(SETTINGS_KEY, { enabled: enabled === true, changedAt: now() });
        // Turning collection off also stops holding what was collected.
        if (!enabled) { await storage.remove(EVENTS_KEY); await storage.remove(SESSION_KEY); }
        return { ok: true, enabled: enabled === true };
      }),
      // Idempotent by event id: re-delivery after a service-worker restart or a
      // retried message is counted once.
      record: event => serialize(async () => {
        if (!(await readSettings()).enabled) return { ok: false, reason: 'not_enabled' };
        const check = validateActivity(event);
        if (!check.ok) return { ok: false, reason: 'invalid', errors: check.errors };
        const events = await readEvents();
        if (events.some(e => e.id === event.id)) return { ok: true, duplicate: true };
        events.push({ ...event });
        events.sort((a, b) => a.ts - b.ts);
        await storage.set(EVENTS_KEY, prune(events));
        return { ok: true, duplicate: false };
      }),
      list: () => readEvents(),
      // Local session ids live in storage, not memory, so a restarted service
      // worker keeps the same id for the same tab. They are random and carry no
      // account, URL or conversation information.
      sessionFor: (tabId, browserEpoch) => serialize(async () => {
        const map = (await storage.get(SESSION_KEY)) || {};
        const key = `${browserEpoch}:${tabId}`;
        if (!map[key]) {
          const fresh = {};
          for (const [k, v] of Object.entries(map)) if (k.startsWith(`${browserEpoch}:`)) fresh[k] = v;
          fresh[key] = randomHex(8);
          await storage.set(SESSION_KEY, fresh);
          return fresh[key];
        }
        return map[key];
      }),
      // Immediate deletion of every observation and session id.
      clear: () => serialize(async () => { await storage.remove(EVENTS_KEY); await storage.remove(SESSION_KEY); return { ok: true }; }),
      exportJson: async () => JSON.stringify({ schemaVersion: SCHEMA_VERSION, exportedAt: now(), events: await readEvents() }, null, 2),
    };
  }

  // Maps observations to ledger LedgerInput records (see docs/LEDGER.md).
  // They are low-confidence local estimates: one request each, no quota percent.
  // `accountAlias` is fixed by the caller; the collector cannot tell accounts apart.
  function toLedgerInputs(events, { accountAlias, devicePseudonym, ingestedAt }) {
    return events
      .filter(e => validateActivity(e).ok && e.activityType === 'message_completed')
      .map(e => ({
        schemaVersion: 1,
        kind: 'local_activity',
        provider: e.provider,
        accountAlias,
        devicePseudonym,
        observedAt: e.ts,
        ingestedAt,
        source: 'web',
        confidence: 'low',
        measurementMethod: 'local_estimate',
        measures: { requestCount: 1 },
      }));
  }

  scope.TokenWatcherActivity = Object.freeze({
    SCHEMA_VERSION, RETENTION, PROVIDERS, ACTIVITY_TYPES, RECORDED_FIELDS, NEVER_RECORDED,
    validateActivity, createStore, chromeStorageAdapter, toLedgerInputs,
  });
})(typeof self !== 'undefined' ? self : globalThis);

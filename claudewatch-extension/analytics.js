// analytics.js — local-only, versioned analytics contract for Token Watcher.
// Events never leave the browser: nothing here performs network I/O. The module
// validates every event against an allow-list schema, stores a bounded,
// retention-limited log in chrome.storage.local, and computes the baseline
// metrics documented in docs/product-hunt/baseline/METRICS_CONTRACT.md.
// Loaded by the service worker via importScripts and by the settings page via
// <script>; tests import it with a stubbed `self`.
(function registerAnalytics(scope) {
  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'analytics_events_v1';
  const META_KEY = 'analytics_meta_v1';
  const DAY_MS = 24 * 60 * 60 * 1000;

  const RETENTION = Object.freeze({
    maxAgeDays: 90,       // covers week-four retention (days 28-34) with margin
    maxEvents: 5000,
    maxAgeMs: 90 * DAY_MS,
  });

  const PROVIDERS = ['claude', 'chatgpt', 'gemini'];
  const ERROR_CATEGORIES = [
    'none', 'provider_tab_missing', 'provider_tab_timeout', 'auth_expired',
    'rate_limited', 'provider_schema_changed', 'network', 'timeout', 'other',
  ];
  const TRIGGERS = ['install', 'startup', 'alarm', 'tab', 'focus', 'wake', 'manual', 'other'];

  // Each property is an enum (array), 'bool', or { type: 'int', min, max }.
  // Free-form strings are not representable, which is what keeps prompt text,
  // URLs and identifiers out of the log by construction.
  const int = (min, max) => ({ type: 'int', min, max });
  const EVENT_DEFINITIONS = Object.freeze({
    installed: { description: 'Extension installed.', props: {} },
    onboarding_completed: { description: 'User finished the onboarding page.', props: {} },
    provider_connected: { description: 'First provider-reported snapshot saved for a provider.', props: { provider: PROVIDERS } },
    first_useful_reading: { description: 'First trustworthy provider-reported quota reading after install.', props: { provider: PROVIDERS, secondsSinceInstall: int(0, 31_536_000) } },
    first_recommendation: { description: 'First recommendation (plan or provider switch) shown to the user.', props: { kind: ['plan', 'provider_switch', 'wait', 'other'] } },
    refresh_result: { description: 'One provider refresh attempt finished.', props: { provider: PROVIDERS, ok: 'bool', errorCategory: ERROR_CATEGORIES, trigger: TRIGGERS, durationMs: int(0, 600_000) } },
    stale_started: { description: 'A provider reading crossed the stale threshold.', props: { provider: PROVIDERS, reason: ERROR_CATEGORIES, explained: 'bool' } },
    stale_ended: { description: 'A stale provider reading was refreshed.', props: { provider: PROVIDERS, staleSeconds: int(0, 31_536_000), explained: 'bool' } },
    attribution_measured: { description: 'Attribution coverage sample (emitted from Phase 1 reconciliation).', props: { attributedUnits: int(0, 1_000_000), eligibleUnits: int(0, 1_000_000) } },
    alert_shown: { description: 'A quota-risk alert was shown.', props: { level: ['warn', 'high', 'critical'], provider: PROVIDERS } },
    alert_action: { description: 'User acted on an alert.', props: { action: ['switch_provider', 'wait', 'plan_action', 'dismiss'], provider: PROVIDERS } },
    report_shared: { description: 'User exported or shared a usage report.', props: { channel: ['copy', 'download', 'link'] } },
    active_day: { description: 'Extension surface opened; at most one per local day.', props: { surface: ['popup', 'settings', 'onboarding'] } },
  });

  // Defence in depth on top of the allow-list: names and values that must never
  // be recorded even if a schema change one day adds a free-form property.
  const PROHIBITED_KEY_PATTERN = /prompt|response|message|content|text|body|cookie|token|session|credential|secret|password|authorization|bearer|email|account|org(anization)?id|user(id|name)?$|device|title|url|href|dom|html|page|attachment|conversation|name$/i;
  const PROHIBITED_VALUE_PATTERNS = [
    /[^\s@]+@[^\s@]+\.[^\s@]+/,                       // e-mail address
    /https?:\/\//i,                                   // URL
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // UUID account/org id
    /\beyJ[\w-]+\.[\w-]+\.[\w-]+/,                    // JWT
    /\b(sk|pk|sess|key)-[\w-]{12,}/i,                 // API key / session credential
    /[A-Za-z0-9+/_-]{32,}={0,2}/,                     // long opaque blob
  ];

  function checkValue(spec, value) {
    if (Array.isArray(spec)) return spec.includes(value);
    if (spec === 'bool') return typeof value === 'boolean';
    if (spec?.type === 'int') return Number.isInteger(value) && value >= spec.min && value <= spec.max;
    return false;
  }

  // Returns { ok, errors[] }. Never throws, never mutates the event.
  function validateEvent(event) {
    const errors = [];
    if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, errors: ['event_not_object'] };
    const allowedTop = new Set(['name', 'ts', 'props', 'v']);
    for (const key of Object.keys(event)) if (!allowedTop.has(key)) errors.push(`unknown_field:${key}`);
    const def = EVENT_DEFINITIONS[event.name];
    if (!def) errors.push(`unknown_event:${String(event.name).slice(0, 40)}`);
    if (event.v !== undefined && event.v !== SCHEMA_VERSION) errors.push('unsupported_schema_version');
    if (!Number.isFinite(event.ts)) errors.push('invalid_ts');
    const props = event.props ?? {};
    if (typeof props !== 'object' || Array.isArray(props)) errors.push('props_not_object');
    else {
      for (const [key, value] of Object.entries(props)) {
        if (PROHIBITED_KEY_PATTERN.test(key)) { errors.push(`prohibited_field:${key}`); continue; }
        if (typeof value === 'string' && PROHIBITED_VALUE_PATTERNS.some(p => p.test(value))) {
          errors.push(`prohibited_value:${key}`); continue;
        }
        if (!def) continue;
        if (!(key in def.props)) errors.push(`unknown_prop:${key}`);
        else if (!checkValue(def.props[key], value)) errors.push(`invalid_prop:${key}`);
      }
      if (def) for (const key of Object.keys(def.props)) if (!(key in props)) errors.push(`missing_prop:${key}`);
    }
    return { ok: errors.length === 0, errors };
  }

  function localDay(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Storage adapter: { get(key) -> Promise<any|null>, set(key, value) -> Promise, remove(key) -> Promise }
  function chromeStorageAdapter(area = chrome.storage.local) {
    return {
      get: key => new Promise(resolve => area.get(key, d => resolve(d?.[key] ?? null))),
      set: (key, value) => new Promise((resolve, reject) => area.set({ [key]: value }, () => {
        const error = chrome.runtime?.lastError;
        if (error) reject(new Error(error.message)); else resolve();
      })),
      remove: key => new Promise(resolve => area.remove(key, resolve)),
    };
  }

  function prune(events, now) {
    const cutoff = now - RETENTION.maxAgeMs;
    return events.filter(e => e.ts >= cutoff && e.ts <= now + DAY_MS).slice(-RETENTION.maxEvents);
  }

  function createStore(storage, { clock = Date.now } = {}) {
    let queue = Promise.resolve();
    const serialize = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

    async function readMeta(now) {
      const meta = (await storage.get(META_KEY)) ?? {};
      return meta.installedAt ? meta : { ...meta, installedAt: null, firstSeen: now };
    }

    // Records a validated event. Invalid events are dropped and reported, never stored.
    function record(name, props = {}, ts = clock()) {
      return serialize(async () => {
        const event = { v: SCHEMA_VERSION, name, ts, props };
        const result = validateEvent(event);
        if (!result.ok) return { ok: false, errors: result.errors };
        const existing = (await storage.get(STORAGE_KEY)) ?? [];
        const next = prune(existing.concat(event), ts);
        await storage.set(STORAGE_KEY, next);
        if (name === 'installed') {
          const meta = await readMeta(ts);
          if (!meta.installedAt) await storage.set(META_KEY, { ...meta, installedAt: ts });
        }
        return { ok: true };
      });
    }

    // Records `active_day` once per local day per surface.
    function recordActiveDay(surface, ts = clock()) {
      return serialize(async () => {
        const day = localDay(ts);
        const existing = (await storage.get(STORAGE_KEY)) ?? [];
        if (existing.some(e => e.name === 'active_day' && e.props.surface === surface && localDay(e.ts) === day)) return { ok: true, skipped: true };
        const event = { v: SCHEMA_VERSION, name: 'active_day', ts, props: { surface } };
        const result = validateEvent(event);
        if (!result.ok) return { ok: false, errors: result.errors };
        await storage.set(STORAGE_KEY, prune(existing.concat(event), ts));
        return { ok: true };
      });
    }

    return {
      record,
      recordActiveDay,
      list: async () => (await storage.get(STORAGE_KEY)) ?? [],
      meta: async () => (await storage.get(META_KEY)) ?? {},
      // Deletes every analytics event and the install anchor.
      clear: () => serialize(async () => { await storage.remove(STORAGE_KEY); await storage.remove(META_KEY); }),
      exportJson: async () => JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date(clock()).toISOString(),
        meta: (await storage.get(META_KEY)) ?? {},
        events: (await storage.get(STORAGE_KEY)) ?? [],
      }, null, 2),
    };
  }

  // Maps an internal error code/message and HTTP status to a closed category.
  // Raw error text is never stored: it can embed URLs or provider responses.
  function categorizeError(error, status = 0) {
    const text = String(error ?? '').toLowerCase();
    if (!text && !status) return 'other';
    if (text.includes('provider_tab_missing')) return 'provider_tab_missing';
    if (text.includes('schema') ) return 'provider_schema_changed';
    if (text.includes('timeout')) return text.includes('provider_tab') ? 'provider_tab_timeout' : 'timeout';
    if (status === 401 || status === 403 || text.includes('unauthor') || text.includes('auth')) return 'auth_expired';
    if (status === 429 || text.includes('rate')) return 'rate_limited';
    if (text.includes('fetch') || text.includes('network') || text.includes('failed to')) return 'network';
    return 'other';
  }

  const UNKNOWN = 'unknown';
  const metric = (id, label, formula, value, numerator = null, denominator = null, note = '') =>
    ({ id, label, formula, value, numerator, denominator, note });
  const ratio = (num, den) => (den > 0 ? num / den : UNKNOWN);

  // Computes the baseline metrics. Anything without evidence is the string
  // 'unknown' — values are never estimated or defaulted to zero.
  function computeMetrics(events, meta = {}, now = Date.now()) {
    const by = name => events.filter(e => e.name === name);
    const installedAt = meta.installedAt ?? null;
    const installs = by('installed');
    const metrics = [];

    const firstReading = by('first_useful_reading')[0];
    metrics.push(metric('activation', 'Activation',
      '1 if first_useful_reading exists after installed, else 0; unknown without installed',
      installedAt == null ? UNKNOWN : (firstReading ? 1 : 0)));

    metrics.push(metric('first_useful_reading_seconds', 'Time to first useful reading',
      'first_useful_reading.secondsSinceInstall',
      firstReading ? firstReading.props.secondsSinceInstall : UNKNOWN));

    const rec = by('first_recommendation')[0];
    metrics.push(metric('first_recommendation_seconds', 'Time to first recommendation',
      'first_recommendation.ts - installed.ts',
      rec && installedAt != null ? Math.round((rec.ts - installedAt) / 1000) : UNKNOWN,
      null, null, installs.length ? '' : 'No installed event recorded on this device.'));

    const connected = new Set(by('provider_connected').map(e => e.props.provider));
    metrics.push(metric('provider_connection_rate', 'Provider connection rate',
      'distinct providers with provider_connected / 3 supported providers',
      installedAt == null && !connected.size ? UNKNOWN : connected.size / PROVIDERS.length,
      connected.size, PROVIDERS.length));

    const refreshes = by('refresh_result').filter(e => e.props.errorCategory !== 'provider_tab_missing');
    const ok = refreshes.filter(e => e.props.ok).length;
    metrics.push(metric('refresh_success_rate', 'Refresh success rate',
      'ok refresh_result / all refresh_result, excluding provider_tab_missing (provider not open)',
      ratio(ok, refreshes.length), ok, refreshes.length));

    const ended = by('stale_ended');
    const secs = ended.map(e => e.props.staleSeconds).sort((a, b) => a - b);
    metrics.push(metric('stale_duration_p50_seconds', 'Median stale duration', 'median of stale_ended.staleSeconds',
      secs.length ? secs[Math.floor((secs.length - 1) / 2)] : UNKNOWN, null, secs.length));
    metrics.push(metric('stale_duration_max_seconds', 'Maximum stale duration', 'max of stale_ended.staleSeconds',
      secs.length ? secs[secs.length - 1] : UNKNOWN, null, secs.length));
    const unexplained = ended.filter(e => !e.props.explained).length;
    metrics.push(metric('unexplained_stale_rate', 'Unexplained stale rate',
      'stale_ended with explained=false / all stale_ended', ratio(unexplained, ended.length), unexplained, ended.length));

    const samples = by('attribution_measured');
    const attributed = samples.reduce((s, e) => s + e.props.attributedUnits, 0);
    const eligible = samples.reduce((s, e) => s + e.props.eligibleUnits, 0);
    metrics.push(metric('attribution_coverage', 'Attribution coverage',
      'sum(attributedUnits) / sum(eligibleUnits), reset intervals excluded', ratio(attributed, eligible), attributed, eligible,
      samples.length ? '' : 'Needs the Phase 1 ledger; no emitter exists yet.'));

    const shown = by('alert_shown').length;
    const acted = by('alert_action').filter(e => e.props.action !== 'dismiss').length;
    metrics.push(metric('alert_action_rate', 'Alert action rate',
      'alert_action (excluding dismiss) / alert_shown', ratio(acted, shown), acted, shown));

    metrics.push(metric('report_shares', 'Report shares', 'count of report_shared',
      installedAt == null && !by('report_shared').length ? UNKNOWN : by('report_shared').length));

    // Week-four retention: any active_day 28..34 days after install.
    let retention = UNKNOWN;
    let note = 'Needs a recorded install and at least 35 days of history.';
    if (installedAt != null && now - installedAt >= 35 * DAY_MS) {
      const hit = by('active_day').some(e => e.ts - installedAt >= 28 * DAY_MS && e.ts - installedAt < 35 * DAY_MS);
      retention = hit ? 1 : 0; note = '';
    }
    metrics.push(metric('week4_retention', 'Week-four retention',
      '1 if active_day occurs 28-34 days after installed, else 0 (cohort rate = mean across installs)', retention, null, null, note));

    return metrics;
  }

  const api = {
    SCHEMA_VERSION, STORAGE_KEY, META_KEY, RETENTION, EVENT_DEFINITIONS, PROVIDERS, ERROR_CATEGORIES, TRIGGERS,
    validateEvent, categorizeError, createStore, chromeStorageAdapter, computeMetrics, prune, localDay, UNKNOWN,
  };
  scope.TokenWatcherAnalytics = api;
})(self);

// Provider usage contract shared by the service worker, the popup and tests.
// One reading describes one quota window of one provider account. Pure functions only:
// no chrome.* access, callers pass the clock.
//
// Provider-reported quotas, local token estimates and forecasts are distinct provenances
// and are never merged into one number: a reading carries exactly one of them.
(function registerProviderContract(scope) {
  const CONTRACT_VERSION = 1;
  const PROVIDERS = ['claude', 'chatgpt', 'gemini'];
  const WINDOW_SECONDS = { '5h': 5 * 3600, '7d': 7 * 24 * 3600 };

  const PROVENANCE = {
    provider_reported: 'Reported by the provider',
    local_estimate: 'Estimated from tokens seen in this browser',
    forecast: 'Forecast from recent provider readings',
  };
  const CONFIDENCE = ['authoritative', 'estimated', 'high', 'medium', 'low'];

  // Source and fetch times come from different clocks (provider vs. this device).
  const CLOCK_SKEW_MS = 5 * 60_000;
  // A reset further away than the window itself (plus slack) is not a reset of that window.
  const RESET_SLACK_MS = 60 * 60_000;

  // Error categories reuse the refresh-policy vocabulary and add two reading-level ones.
  const UNAVAILABLE_COPY = {
    window_unavailable: 'The provider did not report this window.',
    reading_invalid: 'The provider returned a value that cannot be correct, so it is hidden.',
    provider_schema_changed: 'The provider changed its response format. An update is needed.',
    auth_expired: 'Signed out or session expired. Sign in to the provider, then retry.',
    provider_tab_missing: 'No signed-in provider tab is open. Open the provider site, then retry.',
    rate_limited: 'The provider is rate limiting requests. Showing the last reading.',
    network: 'No network connection. Showing the last reading.',
    timeout: 'The provider timed out. Showing the last reading.',
    provider_tab_timeout: 'The provider tab did not respond. Showing the last reading.',
    other: 'Usage is unavailable for an unknown reason.',
  };

  const isPct = value => Number.isFinite(value) && value >= 0 && value <= 100;
  const toMs = value => (typeof value === 'number' ? value : Date.parse(value ?? ''));

  function describeUnavailable(category) {
    return UNAVAILABLE_COPY[category] ?? UNAVAILABLE_COPY.other;
  }

  function describeProvenance(provenance) {
    return PROVENANCE[provenance] ?? 'Unknown source';
  }

  // Returns a reason code, or null when the reading is internally consistent.
  function validateReading(reading, { now = Date.now() } = {}) {
    if (!reading || !PROVIDERS.includes(reading.provider)) return 'invalid_provider';
    if (!WINDOW_SECONDS[reading.windowType]) return 'invalid_window_type';
    if (!Object.hasOwn(PROVENANCE, reading.provenance)) return 'invalid_provenance';
    if (!CONFIDENCE.includes(reading.confidence)) return 'invalid_confidence';
    if (reading.error) return null; // an error reading carries no value to validate
    if (!isPct(reading.usedPct)) return 'invalid_used_pct';
    if (!isPct(reading.remainingPct)) return 'invalid_remaining_pct';
    if (Math.abs(reading.usedPct + reading.remainingPct - 100) > 0.01) return 'inconsistent_percentages';
    const fetched = toMs(reading.fetchTimestamp);
    if (!Number.isFinite(fetched)) return 'invalid_fetch_timestamp';
    if (fetched > now + CLOCK_SKEW_MS) return 'fetch_timestamp_in_future';
    if (reading.sourceTimestamp != null) {
      const source = toMs(reading.sourceTimestamp);
      if (!Number.isFinite(source)) return 'invalid_source_timestamp';
      if (source > fetched + CLOCK_SKEW_MS) return 'source_after_fetch';
    }
    if (reading.resetsAt != null) {
      const reset = toMs(reading.resetsAt);
      if (!Number.isFinite(reset)) return 'invalid_reset_time';
      const horizon = WINDOW_SECONDS[reading.windowType] * 1000 + RESET_SLACK_MS;
      if (reset > fetched + horizon) return 'reset_beyond_window';
    }
    return null;
  }

  // Snapshot-level check used before persisting. Percentages must be real percentages.
  function validateSnapshot(snapshot, { now = Date.now() } = {}) {
    if (!snapshot || !PROVIDERS.includes(snapshot.site)) return 'invalid_site';
    if (!(snapshot.organizationId ?? snapshot.accountId ?? snapshot.email)) return 'account_identity_missing';
    for (const key of ['5h', '7d']) {
      const pct = snapshot[`pct${key}`];
      if (pct != null && !isPct(pct)) return `invalid_pct${key}`;
      const reset = snapshot[`resetsAt${key}`];
      if (reset != null) {
        const resetMs = toMs(reset);
        if (!Number.isFinite(resetMs)) return `invalid_resetsAt${key}`;
        if (resetMs > now + WINDOW_SECONDS[key] * 1000 + RESET_SLACK_MS) return `invalid_resetsAt${key}`;
      }
    }
    return null;
  }

  function reading(snapshot, windowType, fetchTimestamp, sourceTimestamp, error = null) {
    const pct = snapshot?.[`pct${windowType}`];
    const base = {
      contractVersion: CONTRACT_VERSION, provider: snapshot?.site, accountId: snapshot?.accountId ?? null,
      windowType, windowSeconds: snapshot?.[`windowSeconds${windowType}`] ?? WINDOW_SECONDS[windowType],
      resetsAt: snapshot?.[`resetsAt${windowType}`] ?? null,
      sourceTimestamp, fetchTimestamp, provenance: 'provider_reported', confidence: 'authoritative',
    };
    if (error) return { ...base, usedPct: null, remainingPct: null, error: { category: error, message: describeUnavailable(error) } };
    return { ...base, usedPct: pct, remainingPct: Math.round((100 - pct) * 1000) / 1000, error: null };
  }

  // Splits an adapter snapshot into one contract reading per window. A window the
  // provider did not report becomes an explicit error reading, not a missing value.
  // `fetchedAt` is when we got the data; `sourceAt` is the provider's own timestamp when
  // it supplies one, otherwise null (unknown is not the same as "now").
  function toReadings(snapshot, { fetchedAt, sourceAt = null, now = Date.now() } = {}) {
    const fetchTimestamp = new Date(toMs(fetchedAt ?? now)).toISOString();
    const sourceTimestamp = sourceAt == null ? null : new Date(toMs(sourceAt)).toISOString();
    return ['5h', '7d'].map(windowType => {
      if (snapshot?.[`pct${windowType}`] == null) {
        return reading(snapshot, windowType, fetchTimestamp, sourceTimestamp, 'window_unavailable');
      }
      const r = reading(snapshot, windowType, fetchTimestamp, sourceTimestamp);
      return validateReading(r, { now }) ? { ...r, usedPct: null, remainingPct: null, error: { category: 'reading_invalid', message: describeUnavailable('reading_invalid') } } : r;
    });
  }

  // Projection of a window's usage to its reset. Clamping at 100 hides how far past the
  // limit a fast burn rate points, and made every heavy user read "100%". We keep the
  // clamped value for gauges, flag saturation, and report when the limit would be hit.
  function projectUsage({ currentPct, ratePerHour, horizonHours, now = Date.now() }) {
    if (!isPct(currentPct) || !Number.isFinite(ratePerHour) || !Number.isFinite(horizonHours) || horizonHours <= 0) return null;
    if (currentPct >= 100) return null; // already at the limit: nothing to forecast
    const rate = Math.max(0, ratePerHour);
    const raw = currentPct + rate * horizonHours;
    const saturated = raw >= 100;
    const hoursToLimit = saturated && rate > 0 ? (100 - currentPct) / rate : null;
    return {
      projectedPct: Math.min(100, Math.max(currentPct, raw)),
      saturated,
      hoursToLimit,
      exhaustsAt: hoursToLimit == null ? null : new Date(now + hoursToLimit * 3600_000).toISOString(),
    };
  }

  // Short UI label for a forecast, without ever printing a saturated value as a point estimate.
  function formatForecast(forecast, fmtPct) {
    if (!forecast || forecast.projectedPct == null) return null;
    return forecast.saturated ? 'may reach limit' : `→ ${fmtPct(forecast.projectedPct)}`;
  }

  scope.TokenWatcherContract = {
    CONTRACT_VERSION, PROVIDERS, WINDOW_SECONDS, PROVENANCE, CONFIDENCE, CLOCK_SKEW_MS,
    describeUnavailable, describeProvenance, validateReading, validateSnapshot,
    toReadings, projectUsage, formatForecast,
  };
})(typeof self !== 'undefined' ? self : globalThis);

// Provider adapters: turn each provider's raw response into contract snapshots.
// Pure and clock-injectable so the same code runs in the service worker and in the
// adapter contract tests (test/provider-adapters.test.mjs).
(function registerProviderAdapters(scope) {
  // ── Plan detection (Claude-specific) ─────────────────────────────────────
  function detectPlan(data) {
    const s = (typeof data === 'string' ? data : JSON.stringify(data)).toLowerCase();
    if (s.includes('max_20') || s.includes('max20'))              return 'max20x';
    if (s.includes('max_5')  || s.includes('max5'))               return 'max5x';
    if (s.includes('claude_max') || s.includes('"max"'))          return 'max';
    if (s.includes('claude_pro') || s.includes('"pro"')
        || s.includes("'pro'")  || s.includes('pro_plan'))        return 'pro';
    if (s.includes('claude_free')|| s.includes('"free"')
        || s.includes('free_plan'))                                return 'free';
    return null;
  }

  // ── Rate-limit window extraction ──────────────────────────────────────────
  function extractRateLimitFromResponse(data) {
    if (!data || typeof data !== 'object') return null;

    // Current claude.ai /usage shape. Values are percentages (0..100), whereas
    // older message_limit SSE events may use fractions (0..1).
    if (data.five_hour || data.seven_day) {
      return {
        type: null,
        remaining: null,
        resetsAt: data.five_hour?.resets_at ?? null,
        resetsAt7d: data.seven_day?.resets_at ?? null,
        utilization5h: data.five_hour?.utilization ?? null,
        utilization7d: data.seven_day?.utilization ?? null,
      };
    }

    function fromWindows(windows) {
      if (!windows || typeof windows !== 'object') return null;
      const win5h = windows['5h'];
      const win7d = windows['7d'];
      if (!win5h && !win7d) return null;
      return {
        resetsAt:      win5h?.resets_at ? new Date(win5h.resets_at * 1000).toISOString() : null,
        resetsAt7d:    win7d?.resets_at ? new Date(win7d.resets_at * 1000).toISOString() : null,
        utilization5h: win5h?.utilization ?? null,
        utilization7d: win7d?.utilization ?? null,
      };
    }

    const windowsSources = [
      data.windows, data.rate_limit?.windows, data.message_limit?.windows,
      data.limits?.windows, data.usage?.windows,
    ];
    for (const w of windowsSources) {
      const r = fromWindows(w);
      if (r && (r.resetsAt || r.utilization5h != null)) {
        return {
          type:      data.type ?? data.rate_limit?.type ?? data.message_limit?.type ?? null,
          remaining: data.remaining ?? data.rate_limit?.remaining ?? data.message_limit?.remaining ?? null,
          ...r,
        };
      }
    }

    const candidates = [
      data.rate_limit, data.rateLimit, data.message_limit,
      data.account?.rate_limit, data.usage?.rate_limit,
      data.limits?.rate_limit, data.limits,
      data.current_period, data.window, data.usage_window,
    ];
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      const resetsAt = c.resetsAt ?? c.resets_at ?? c.reset_at
                     ?? c.windowResetsAt ?? c.window_resets_at
                     ?? c.period_end ?? c.current_period_end ?? null;
      if (resetsAt) return { type: c.type ?? null, resetsAt, remaining: c.remaining ?? c.messages_remaining ?? null };
    }
    return null;
  }

  const asPct = value => value == null ? null : (value <= 1 ? value * 100 : value);
  const fractionPct = value => value == null ? null : value * 100;
  const unixIso = value => Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;

  function classifyChatGptWindows(rateLimit) {
    const duration = window => window?.limit_window_seconds ?? window?.window_seconds ?? window?.window_size_seconds ?? null;
    const split = Math.sqrt(5 * 3600 * 7 * 24 * 3600);
    const primary = rateLimit?.primary_window ?? rateLimit?.session_window ?? rateLimit?.five_hour_window ?? null;
    const secondary = rateLimit?.secondary_window ?? rateLimit?.weekly_window ?? rateLimit?.seven_day_window ?? null;
    let w5h = null, w7d = null;
    for (const w of [primary, secondary]) {
      const seconds = duration(w);
      if (!w || !Number.isFinite(seconds)) continue;
      if (seconds < split) w5h = w; else w7d = w;
    }
    if (!w5h && primary && !Number.isFinite(duration(primary))) w5h = primary;
    if (!w7d && secondary && !Number.isFinite(duration(secondary))) w7d = secondary;
    return { w5h, w7d };
  }

  const chatGptPct = window => {
    if (!window) return null;
    const explicit = window.used_percent ?? window.utilization_percent ?? window.percent_used;
    if (Number.isFinite(explicit)) return Math.min(100, Math.max(0, explicit));
    const used = window.used ?? window.tokens_used;
    const limit = window.limit ?? window.token_limit;
    return Number.isFinite(used) && Number.isFinite(limit) && limit > 0
      ? Math.min(100, Math.max(0, used / limit * 100)) : null;
  };

  const chatGptReset = window => {
    const value = window?.reset_at ?? window?.reset_time ?? window?.resets_at;
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
    if (Number.isFinite(value)) return new Date(value * (value < 1e12 ? 1000 : 1)).toISOString();
    if (Number.isFinite(window?.reset_after_seconds)) return new Date(Date.now() + window.reset_after_seconds * 1000).toISOString();
    return null;
  };

  function normalizeChatGptUsage(raw, email) {
    const usage = raw?.usage?.rate_limit ? raw.usage : raw?.data?.rate_limit ? raw.data : raw?.usage ?? raw;
    if (!usage?.rate_limit) return null;
    const resolvedEmail = usage.email ?? email ?? null;
    const { w5h, w7d } = classifyChatGptWindows(usage.rate_limit);
    const duration = window => window?.limit_window_seconds ?? window?.window_seconds ?? window?.window_size_seconds ?? null;
    const additionalLimits = (Array.isArray(usage.additional_rate_limits) ? usage.additional_rate_limits : [])
      .map(item => {
        const window = item?.rate_limit?.primary_window ?? item?.rate_limit?.secondary_window;
        if (typeof window?.used_percent !== 'number') return null;
        return {
          name: item.limit_name ?? item.metered_feature ?? 'Feature limit',
          feature: item.metered_feature ?? null,
          pct: window.used_percent, resetsAt: unixIso(window.reset_at),
          windowSeconds: window.limit_window_seconds ?? null,
        };
      }).filter(Boolean).slice(0, 5);
    return {
      // Some personal sessions omit identity fields even though the quota is
      // authoritative. Preserve that snapshot under one stable local account.
      site: 'chatgpt', accountId: usage.account_id ?? usage.user_id ?? resolvedEmail ?? 'default', email: resolvedEmail,
      plan: usage.plan_type ?? null,
      pct5h: chatGptPct(w5h), pct7d: chatGptPct(w7d),
      resetsAt5h: chatGptReset(w5h), resetsAt7d: chatGptReset(w7d),
      windowSeconds5h: duration(w5h), windowSeconds7d: duration(w7d),
      additionalLimits,
    };
  }

  function parseBatchResponse(text, rpcId) {
    for (const line of String(text ?? '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === ")]}'" || /^\d+$/.test(trimmed)) continue;
      try {
        const rows = JSON.parse(trimmed);
        for (const row of Array.isArray(rows) ? rows : []) {
          if (row?.[0] === 'wrb.fr' && row?.[1] === rpcId && row[2]) return JSON.parse(row[2]);
        }
      } catch {}
    }
    return null;
  }

  function normalizeGeminiUsage(raw) {
    const data = parseBatchResponse(raw?.batchText, raw?.rpcId ?? 'jSf9Qc');
    if (!Array.isArray(data) || !Array.isArray(data[1])) return null;
    let pct5h = null, pct7d = null, resetsAt5h = null, resetsAt7d = null;
    for (const w of data[1]) {
      if (!Array.isArray(w) || !Number.isFinite(w[1])) continue;
      const pct = fractionPct(w[1]);
      const reset = unixIso(w[3]?.[0]?.[0]);
      if (w[2] === 1) { pct5h = pct; resetsAt5h = reset; }
      if (w[2] === 2) { pct7d = pct; resetsAt7d = reset; }
    }
    return {
      // WIZ internals can expose a request-scoped numeric value as accountId.
      // Prefer the signed-in email, which remains stable across polls.
      site: 'gemini', accountId: raw.email ?? raw.accountId ?? null, email: raw.email ?? null,
      plan: data[0] != null ? `Plan ${data[0]}` : null,
      pct5h, pct7d, resetsAt5h, resetsAt7d,
      windowSeconds5h: 5 * 3600, windowSeconds7d: 7 * 24 * 3600,
      additionalLimits: [],
    };
  }

  const WINDOWS = { windowSeconds5h: 5 * 3600, windowSeconds7d: 7 * 24 * 3600 };

  function normalizeClaudeOrg(item) {
    const rateLimit = extractRateLimitFromResponse(item?.usage);
    if (!rateLimit) return null;
    return {
      site: 'claude', accountId: item.orgId, organizationId: item.orgId,
      accountName: item.org?.name ?? item.org?.display_name ?? 'Claude organization', email: null,
      plan: detectPlan(item.org) ?? detectPlan(item.usage),
      pct5h: asPct(rateLimit.utilization5h), pct7d: asPct(rateLimit.utilization7d),
      resetsAt5h: rateLimit.resetsAt, resetsAt7d: rateLimit.resetsAt7d,
      ...WINDOWS, additionalLimits: [],
    };
  }

  const NETWORK_ERRORS = /network|failed to fetch|offline|ERR_INTERNET/i;

  // Maps a failed provider message to a refresh-policy error category.
  function categorizeFailure(msg) {
    const status = Number(msg?.status ?? 0);
    const text = String(msg?.error ?? '');
    if (status === 429 || /rate.?limit/i.test(text)) return 'rate_limited';
    if (status === 401 || status === 403 || /auth|signed.?out|expired/i.test(text)) return 'auth_expired';
    if (/provider_tab_missing/.test(text)) return 'provider_tab_missing';
    if (/provider_tab_timeout/.test(text)) return 'provider_tab_timeout';
    if (/timeout|abort/i.test(text)) return 'timeout';
    if (NETWORK_ERRORS.test(text)) return 'network';
    return 'other';
  }

  // One entry point for all providers. Returns the snapshots to persist and, when there
  // are none, why: a failed fetch keeps its category, a "successful" fetch that yields no
  // usable snapshot means the response shape changed.
  function adapt(msg) {
    const site = msg?.site ?? 'unknown';
    let snapshots = [];
    if (site === 'chatgpt') snapshots = [normalizeChatGptUsage(msg.snapshot, msg.snapshot?.email)];
    else if (site === 'gemini') snapshots = [normalizeGeminiUsage(msg.snapshot)];
    else if (site === 'claude') {
      const orgs = Array.isArray(msg.snapshot?.organizations) ? msg.snapshot.organizations : [];
      snapshots = orgs.map(normalizeClaudeOrg);
    }
    snapshots = snapshots.filter(Boolean);
    const category = msg?.ok ? (snapshots.length ? null : 'provider_schema_changed') : categorizeFailure(msg);
    return { site, snapshots, category };
  }

  scope.TokenWatcherAdapters = {
    detectPlan, extractRateLimitFromResponse, asPct, classifyChatGptWindows,
    normalizeChatGptUsage, normalizeGeminiUsage, normalizeClaudeOrg, parseBatchResponse,
    categorizeFailure, adapt,
  };
})(typeof self !== 'undefined' ? self : globalThis);

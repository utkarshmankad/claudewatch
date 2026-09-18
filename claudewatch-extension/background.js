// background.js — service worker
// Accumulates SSE token counts across Claude, ChatGPT, and Gemini.
// Maintains 5h/7d rolling windows, detects plan, updates badge.

importScripts('provider-collectors.js');

const TAG = '[TokenWatcher]';

// ── Constants ──────────────────────────────────────────────────────────────
const WINDOW_5H_MS       = 5  * 60 * 60 * 1000;
const WINDOW_7D_MS       = 7  * 24 * 60 * 60 * 1000;
const MAX_HISTORY        = 2000;
const MAX_USAGE_HISTORY  = 7000;
const POLL_INTERVAL_MIN  = 5;
const PROVIDER_STALE_MS  = 15 * 60 * 1000;

// Approximate token limits per 5-hour window (community-derived estimates).
// Claude-specific. ChatGPT/Gemini don't share this window model.
const PLAN_LIMITS = {
  free:   { limit5h:  10_000, name: 'Free'    },
  pro:    { limit5h:  44_000, name: 'Pro'     },
  max:    { limit5h: 150_000, name: 'Max'     },
  max5x:  { limit5h: 220_000, name: 'Max 5×'  },
  max20x: { limit5h: 880_000, name: 'Max 20×' },
};

// Sites that Token Watcher accepts messages from
const ALLOWED_PREFIXES = [
  'https://claude.ai/',
  'https://chatgpt.com/',
  'https://chat.openai.com/',
  'https://gemini.google.com/',
];

// ── Storage keys ──────────────────────────────────────────────────────────
const K_HISTORY       = 'token_history';     // [{ts,input,output,src,site}]
const K_WIN5H         = 'window_5h';         // {startMs, resetMs}
const K_PLAN          = 'detected_plan';     // plan key string (Claude only)
const K_RATELIMIT     = 'rate_limit';        // Claude rate-limit info
const K_ORG_ID        = 'org_id';            // Claude org UUID
const K_LAST_BACKFILL = 'last_backfill_ts';  // epoch ms of last conversation backfill
const K_PROVIDER_USAGE = 'provider_usage';   // {site: normalized authoritative snapshot}
const K_USAGE_HISTORY  = 'usage_history';    // 7d account-scoped quota snapshots
const K_PROVIDER_ACCOUNTS = 'provider_accounts'; // {site: {accountKey: snapshot}}
const K_PROVIDER_SELECTIONS = 'provider_selections'; // {site: accountKey}
const K_DEVICE_ID = 'device_id';
const K_LAST_COORDINATED_REFRESH = 'last_coordinated_refresh_at';

// ── Storage helpers ───────────────────────────────────────────────────────
const lget = (k)    => new Promise(r => chrome.storage.local.get(k,  d => r(d[k]  ?? null)));
const lset = (k, v) => new Promise(r => chrome.storage.local.set({[k]: v}, r));
let providerSaveQueue = Promise.resolve();

async function getDeviceId() {
  let id = await lget(K_DEVICE_ID);
  if (!id) { id = crypto.randomUUID(); await lset(K_DEVICE_ID, id); }
  return id;
}

async function sendCoreEvent(event) {
  try {
    const settings = await new Promise(resolve => chrome.storage.sync.get({ coreSyncEnabled: false, analyticsUserId: '', analyticsTeamId: '' }, resolve));
    if (!settings.coreSyncEnabled) return;
    await fetch('http://localhost:7734/api/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...event, deviceId: await getDeviceId(), userId: settings.analyticsUserId || null, teamId: settings.analyticsTeamId || null }),
    });
  } catch { /* Core is optional and local-only. */ }
}

function stableAccountKey(snapshot) {
  const raw = snapshot?.organizationId ?? snapshot?.accountId ?? snapshot?.email;
  if (!snapshot?.site || !raw) return null;
  return `${snapshot.site}:${String(raw)}`;
}

function validateProviderSnapshot(snapshot) {
  if (!snapshot || !['claude', 'chatgpt', 'gemini'].includes(snapshot.site)) return 'invalid_site';
  if (!stableAccountKey(snapshot)) return 'account_identity_missing';
  for (const key of ['pct5h', 'pct7d']) {
    const value = snapshot[key];
    if (value != null && (!Number.isFinite(value) || value < 0 || value > 1000)) return `invalid_${key}`;
  }
  for (const key of ['resetsAt5h', 'resetsAt7d']) {
    if (snapshot[key] != null && !Number.isFinite(Date.parse(snapshot[key]))) return `invalid_${key}`;
  }
  return null;
}

// ── Badge ─────────────────────────────────────────────────────────────────
function updateBadge(pct) {
  if (pct == null || isNaN(pct)) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const p = Math.round(pct);
  chrome.action.setBadgeText({ text: `${p}%` });
  chrome.action.setBadgeBackgroundColor({
    color: p >= 90 ? '#ef4444' : p >= 70 ? '#f59e0b' : '#6366f1',
  });
}

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

async function mergeRateLimit(newInfo) {
  if (!newInfo) return;
  const existing = (await lget(K_RATELIMIT)) ?? {};
  const merged = { ...existing };
  for (const [k, v] of Object.entries(newInfo)) {
    if (v != null) merged[k] = v;
  }
  merged.savedAt = new Date().toISOString();
  await lset(K_RATELIMIT, merged);
}

// ── Provider quota normalization and history ─────────────────────────────
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
    site: 'chatgpt', accountId: usage.account_id ?? usage.user_id ?? email ?? null, email: email ?? null,
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
    site: 'gemini', accountId: raw.accountId ?? raw.email ?? null, email: raw.email ?? null,
    plan: data[0] != null ? `Plan ${data[0]}` : null,
    pct5h, pct7d, resetsAt5h, resetsAt7d,
    windowSeconds5h: 5 * 3600, windowSeconds7d: 7 * 24 * 3600,
    additionalLimits: [],
  };
}

function forecastWindowDetails(history, site, accountId, key, currentPct, resetsAt) {
  const now = Date.now();
  const resetMs = Date.parse(resetsAt ?? '');
  if (currentPct == null || !Number.isFinite(resetMs) || resetMs <= now) return null;
  const pctKey = key === '5h' ? 'pct5h' : 'pct7d';
  const resetKey = key === '5h' ? 'resetsAt5h' : 'resetsAt7d';
  const lookbackMs = key === '5h' ? 6 * 3600000 : WINDOW_7D_MS;
  const samples = history.filter(h => {
    const sampleResetMs = Date.parse(h[resetKey] ?? '');
    return h.ts >= now - lookbackMs && h.ts <= now && h.site === site && h.accountId === accountId &&
      Number.isFinite(h[pctKey]) && Number.isFinite(sampleResetMs) && Math.abs(sampleResetMs - resetMs) < 60_000;
  })
    .sort((a, b) => a.ts - b.ts);
  if (samples.length < 2) return null;
  const first = samples[0], last = samples[samples.length - 1];
  const spanHours = (last.ts - first.ts) / 3600000;
  if (spanHours < 0.5) return null;
  const growth = Math.max(0, samples[samples.length - 1][pctKey] - samples[0][pctKey]);
  const ratePerHour = growth / spanHours;
  const horizonHours = (resetMs - now) / 3600000;
  const coverageTarget = key === '5h' ? 3 : 48;
  const confidenceScore = Math.min(1, samples.length / 12) * Math.min(1, spanHours / coverageTarget) * Math.min(1, 12 / Math.max(1, horizonHours));
  return {
    projectedPct: Math.min(100, Math.max(0, currentPct, currentPct + ratePerHour * horizonHours)),
    ratePerHour,
    sampleCount: samples.length,
    confidence: confidenceScore >= 0.67 ? 'high' : confidenceScore >= 0.34 ? 'medium' : 'low',
  };
}

async function saveProviderSnapshot(snapshot, capturedAt) {
  if (!snapshot) return;
  const validationError = validateProviderSnapshot(snapshot);
  if (validationError) throw new Error(validationError);
  const ts = Date.parse(capturedAt ?? '') || Date.now();
  const accountKey = stableAccountKey(snapshot);
  const stored = { ...snapshot, accountKey, capturedAt: new Date(ts).toISOString(), ts };
  const accounts = (await lget(K_PROVIDER_ACCOUNTS)) ?? {};
  accounts[snapshot.site] = accounts[snapshot.site] ?? {};
  accounts[snapshot.site][accountKey] = stored;
  await lset(K_PROVIDER_ACCOUNTS, accounts);

  const selections = (await lget(K_PROVIDER_SELECTIONS)) ?? {};
  if (snapshot.site !== 'claude' || !selections[snapshot.site] || !accounts[snapshot.site][selections[snapshot.site]]) {
    selections[snapshot.site] = accountKey;
    await lset(K_PROVIDER_SELECTIONS, selections);
  }
  const current = (await lget(K_PROVIDER_USAGE)) ?? {};
  current[snapshot.site] = accounts[snapshot.site][selections[snapshot.site]];
  await lset(K_PROVIDER_USAGE, current); // compatibility projection for popup/badge

  const history = (await lget(K_USAGE_HISTORY)) ?? [];
  const point = { ts, site: snapshot.site, accountId: snapshot.accountId,
    pct5h: snapshot.pct5h, pct7d: snapshot.pct7d,
    resetsAt5h: snapshot.resetsAt5h, resetsAt7d: snapshot.resetsAt7d };
  const prev = history[history.length - 1];
  if (!prev || prev.site !== point.site || prev.accountId !== point.accountId ||
      prev.pct5h !== point.pct5h || prev.pct7d !== point.pct7d || ts - prev.ts >= POLL_INTERVAL_MIN * 60_000) {
    history.push(point);
  }
  const cutoff = Date.now() - WINDOW_7D_MS;
  const trimmed = history.filter(h => h.ts >= cutoff).slice(-MAX_USAGE_HISTORY);
  await lset(K_USAGE_HISTORY, trimmed);
  void sendCoreEvent({
    eventId: crypto.randomUUID(), recordedAt: stored.capturedAt,
    provider: snapshot.site, accountId: snapshot.accountId,
    organizationId: snapshot.organizationId ?? null, client: 'account_aggregate',
    utilizationPct: snapshot.pct5h, windowSeconds: snapshot.windowSeconds5h,
    source: 'provider_quota', confidence: 'authoritative',
    metadata: { pct7d: snapshot.pct7d, windowSeconds7d: snapshot.windowSeconds7d },
  });
}

function enqueueProviderSnapshot(snapshot, capturedAt) {
  providerSaveQueue = providerSaveQueue.catch(() => {}).then(() => saveProviderSnapshot(snapshot, capturedAt));
  return providerSaveQueue;
}

// ── Conversation token extraction (Claude-specific) ───────────────────────
function extractConvTokens(data) {
  const events = [];
  const msgs = data?.chat_messages ?? data?.messages ?? null;
  if (!Array.isArray(msgs)) return events;

  for (const msg of msgs) {
    const createdAt = msg.created_at ?? msg.timestamp ?? null;
    if (!createdAt) continue;
    const ts = Date.parse(createdAt);
    if (!ts || isNaN(ts)) continue;

    const u = msg.usage ?? msg.token_usage ?? msg.tokens ?? null;
    if (!u) continue;

    const input  = u.input_tokens  ?? u.inputTokens  ?? u.prompt_tokens    ?? 0;
    const output = u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0;
    if (input === 0 && output === 0) continue;

    events.push({ ts, input, output, src: 'conv', site: 'claude' });
  }
  return events;
}

// Merge new token events into K_HISTORY, deduplicating by 10s bucket
async function mergeTokenHistory(events) {
  if (!events?.length) return 0;

  const history = (await lget(K_HISTORY)) ?? [];
  const BUCKET  = 10_000;
  const existing = new Set(history.map(e => Math.round(e.ts / BUCKET)));

  let added = 0;
  for (const ev of events) {
    const bucket = Math.round(ev.ts / BUCKET);
    if (!existing.has(bucket)) {
      history.push(ev);
      existing.add(bucket);
      added++;
    }
  }

  if (added > 0) {
    history.sort((a, b) => a.ts - b.ts);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    await lset(K_HISTORY, history);
    console.log(`${TAG} Merged ${added} events from conversation; history now ${history.length}`);
  }
  return added;
}

// ── Token accumulation ────────────────────────────────────────────────────
async function addTokens(inputTokens, outputTokens, capturedAt, rateLimit, site = 'claude') {
  const ts  = capturedAt ? Date.parse(capturedAt) : Date.now();
  const now = Date.now();

  const history = (await lget(K_HISTORY)) ?? [];
  history.push({ ts, input: inputTokens, output: outputTokens, src: 'sse', site });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  await lset(K_HISTORY, history);
  void sendCoreEvent({
    eventId: crypto.randomUUID(), recordedAt: new Date(ts).toISOString(), provider: site,
    client: 'web', inputTokens, outputTokens, source: 'browser_stream',
    confidence: inputTokens > 0 ? 'observed' : 'estimated',
  });

  // 5h window is Claude-specific (tied to Claude's rate-limit model)
  if (site === 'claude') {
    let win = await lget(K_WIN5H);
    if (!win || now >= win.resetMs) {
      win = { startMs: ts, resetMs: ts + WINDOW_5H_MS };
      await lset(K_WIN5H, win);
    }

    if (rateLimit && (rateLimit.resetsAt || rateLimit.type)) {
      await mergeRateLimit(rateLimit);
      if (rateLimit.resetsAt) {
        const resetMs = Date.parse(rateLimit.resetsAt);
        if (!isNaN(resetMs)) {
          win = { startMs: resetMs - WINDOW_5H_MS, resetMs };
          await lset(K_WIN5H, win);
        }
      }
    }
  }

  const plan       = (await lget(K_PLAN)) ?? 'pro';
  const limit5h    = PLAN_LIMITS[plan]?.limit5h ?? PLAN_LIMITS.pro.limit5h;
  const win        = await lget(K_WIN5H);
  const startMs    = win?.startMs ?? now - WINDOW_5H_MS;
  const claudeHist = history.filter(e => (e.site ?? 'claude') === 'claude');
  const tokens5h   = claudeHist.filter(e => e.ts >= startMs).reduce((s, e) => s + e.input + e.output, 0);
  const pct5h      = (tokens5h / limit5h) * 100;

  updateBadge(pct5h);
  console.log(`${TAG} [${site}] +${inputTokens}in+${outputTokens}out | Claude 5h:${tokens5h} (${pct5h.toFixed(1)}%)`);
}

// ── Build stats payload for popup ─────────────────────────────────────────
async function getStats() {
  const history   = (await lget(K_HISTORY))   ?? [];
  const win       = (await lget(K_WIN5H))     ?? null;
  const plan      = (await lget(K_PLAN))      ?? 'pro';
  const rateLimit = (await lget(K_RATELIMIT)) ?? null;
  const providerUsage = (await lget(K_PROVIDER_USAGE)) ?? {};
  const providerAccounts = (await lget(K_PROVIDER_ACCOUNTS)) ?? {};
  const providerSelections = (await lget(K_PROVIDER_SELECTIONS)) ?? {};
  let migratedAccounts = false;
  for (const [site, snapshot] of Object.entries(providerUsage)) {
    const accountKey = stableAccountKey(snapshot);
    if (!accountKey || providerAccounts[site]?.[accountKey]) continue;
    providerAccounts[site] = providerAccounts[site] ?? {};
    providerAccounts[site][accountKey] = { ...snapshot, accountKey };
    providerSelections[site] = providerSelections[site] ?? accountKey;
    migratedAccounts = true;
  }
  if (migratedAccounts) {
    await lset(K_PROVIDER_ACCOUNTS, providerAccounts);
    await lset(K_PROVIDER_SELECTIONS, providerSelections);
  }
  const providerHealth = {};
  const usageHistory = (await lget(K_USAGE_HISTORY)) ?? [];
  const now       = Date.now();

  for (const site of ['claude', 'chatgpt', 'gemini']) {
    const poll = (await lget(`last_usage_poll_${site}`)) ?? null;
    const selected = providerUsage[site] ?? null;
    const ageMs = selected?.ts ? Math.max(0, now - selected.ts) : null;
    providerHealth[site] = {
      ...poll,
      ageMs,
      stale: ageMs == null || ageMs > PROVIDER_STALE_MS,
      hasData: Boolean(selected),
    };
  }

  function resolveFromRateLimit() {
    if (!rateLimit?.resetsAt) return null;
    const rlResetMs = Date.parse(rateLimit.resetsAt);
    if (!isNaN(rlResetMs) && rlResetMs > now) {
      return { startMs: rlResetMs - WINDOW_5H_MS, resetMs: rlResetMs };
    }
    return null;
  }

  let startMs, resetMs;
  if (win && now < win.resetMs) {
    startMs = win.startMs; resetMs = win.resetMs;
  } else {
    const rl = resolveFromRateLimit();
    if (rl) {
      startMs = rl.startMs; resetMs = rl.resetMs;
    } else if (history.length) {
      const minTs = Math.min(...history.map(e => e.ts));
      startMs = minTs; resetMs = minTs + WINDOW_5H_MS;
      if (now >= resetMs) { startMs = now; resetMs = now + WINDOW_5H_MS; }
    } else {
      startMs = now; resetMs = now + WINDOW_5H_MS;
    }
  }

  // Claude-specific gauge values
  const claudeHistory    = history.filter(e => (e.site ?? 'claude') === 'claude');
  const capturedTokens5h = claudeHistory.filter(e => e.ts >= startMs).reduce((s, e) => s + e.input + e.output, 0);
  const capturedTokens7d = claudeHistory.filter(e => e.ts >= now - WINDOW_7D_MS).reduce((s, e) => s + e.input + e.output, 0);
  const limit5h          = PLAN_LIMITS[plan]?.limit5h ?? PLAN_LIMITS.pro.limit5h;
  const lastTs           = history.length ? history[history.length - 1].ts : null;

  const rlWindowOpen   = rateLimit?.resetsAt   && Date.parse(rateLimit.resetsAt)   > now;
  const rl7dWindowOpen = rateLimit?.resetsAt7d && Date.parse(rateLimit.resetsAt7d) > now;
  const authPct5h = rlWindowOpen   ? asPct(rateLimit.utilization5h) : null;
  const authPct7d = rl7dWindowOpen ? asPct(rateLimit.utilization7d) : null;
  const pct5h     = authPct5h ?? (capturedTokens5h > 0 ? (capturedTokens5h / limit5h) * 100 : null);
  const pct7d     = authPct7d ?? (capturedTokens7d > 0 ? (capturedTokens7d / (limit5h * 7)) * 100 : null);

  const tokens5h = authPct5h != null ? Math.round((authPct5h / 100) * limit5h)       : capturedTokens5h;
  const tokens7d = authPct7d != null ? Math.round((authPct7d / 100) * (limit5h * 7)) : capturedTokens7d;

  const planTable = Object.entries(PLAN_LIMITS).map(([key, { limit5h: lim5h, name }]) => ({
    key, name, isCurrent: key === plan,
    pct5h: tokens5h > 0 ? (tokens5h / lim5h)       * 100 : null,
    pct7d: tokens7d > 0 ? (tokens7d / (lim5h * 7)) * 100 : null,
  }));

  // Per-site token breakdown
  const SITES = ['claude', 'chatgpt', 'gemini'];
  const siteBreakdown = {};
  for (const s of SITES) {
    const sh = history.filter(e => (e.site ?? 'claude') === s);
    siteBreakdown[s] = {
      tokens5h: sh.filter(e => e.ts >= startMs).reduce((acc, e) => acc + e.input + e.output, 0),
      tokens7d: sh.filter(e => e.ts >= now - WINDOW_7D_MS).reduce((acc, e) => acc + e.input + e.output, 0),
      lastTs:   sh.length ? sh[sh.length - 1].ts : null,
    };
  }

  const activeSite = history.length > 0 ? (history[history.length - 1].site ?? 'claude') : null;
  const resetMs7d  = rateLimit?.resetsAt7d ? Date.parse(rateLimit.resetsAt7d) : null;

  for (const snapshot of Object.values(providerUsage)) {
    const forecast5h = forecastWindowDetails(usageHistory, snapshot.site, snapshot.accountId, '5h', snapshot.pct5h, snapshot.resetsAt5h);
    const forecast7d = forecastWindowDetails(usageHistory, snapshot.site, snapshot.accountId, '7d', snapshot.pct7d, snapshot.resetsAt7d);
    snapshot.forecast5h = forecast5h?.projectedPct ?? null;
    snapshot.forecast7d = forecast7d?.projectedPct ?? null;
    snapshot.forecastMeta5h = forecast5h;
    snapshot.forecastMeta7d = forecast7d;
  }

  return {
    plan,
    planName:    PLAN_LIMITS[plan]?.name ?? 'Pro',
    tokens5h,
    tokens7d,
    pct5h,
    pct7d,
    limit5h,
    resetMs5h:   resetMs,
    timeLeft5h:  Math.max(0, resetMs - now),
    timeLeft7d:  resetMs7d ? Math.max(0, resetMs7d - now) : null,
    history,
    planTable,
    lastTs,
    rlType:      rlWindowOpen ? (rateLimit?.type      ?? null) : null,
    rlResetsAt:  rlWindowOpen ? (rateLimit?.resetsAt  ?? null) : null,
    rlRemaining: rlWindowOpen ? (rateLimit?.remaining ?? null) : null,
    siteBreakdown,
    activeSite,
    providerUsage,
    providerAccounts,
    providerSelections,
    providerHealth,
    usageHistory,
  };
}

async function selectProviderAccount(site, accountKey) {
  const accounts = (await lget(K_PROVIDER_ACCOUNTS)) ?? {};
  if (!accounts[site]?.[accountKey]) return false;
  const selections = (await lget(K_PROVIDER_SELECTIONS)) ?? {};
  selections[site] = accountKey;
  await lset(K_PROVIDER_SELECTIONS, selections);
  const current = (await lget(K_PROVIDER_USAGE)) ?? {};
  current[site] = accounts[site][accountKey];
  await lset(K_PROVIDER_USAGE, current);
  return true;
}

// ── Background polling (Claude-specific) ──────────────────────────────────
async function pollOrgUsage(orgId) {
  const urls = [
    `https://claude.ai/api/organizations/${orgId}`,
    `https://claude.ai/api/organizations/${orgId}/usage`,
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!resp.ok) continue;
      const data = await resp.json();

      const p = detectPlan(data);
      if (p) await lset(K_PLAN, p);

      const rl = extractRateLimitFromResponse(data);
      if (rl && (rl.resetsAt || rl.utilization5h != null)) {
        await mergeRateLimit(rl);
        if (rl.resetsAt) {
          const resetMs = Date.parse(rl.resetsAt);
          if (!isNaN(resetMs)) await lset(K_WIN5H, { startMs: resetMs - WINDOW_5H_MS, resetMs });
        }
        console.log(`${TAG} poll org usage OK — resetsAt=${rl.resetsAt} util5h=${rl.utilization5h}`);
        return;
      }
    } catch (err) {
      console.log(`${TAG} poll ${url} error:`, err.message);
    }
  }
}

async function backfillFromConversations(orgId) {
  const lastBackfill = (await lget(K_LAST_BACKFILL)) ?? null;
  const now = Date.now();
  const cutoffMs = lastBackfill ? lastBackfill - 2 * 60_000 : now - WINDOW_7D_MS;

  try {
    const listResp = await fetch(
      `https://claude.ai/api/organizations/${orgId}/chat_conversations?limit=50`,
      { credentials: 'include', headers: { Accept: 'application/json' } }
    );
    if (!listResp.ok) return;

    const listData = await listResp.json();
    const convs = Array.isArray(listData) ? listData : (listData.conversations ?? listData.chat_conversations ?? []);
    const toFetch = convs.filter(c => {
      const t = Date.parse(c.updated_at ?? c.created_at ?? '');
      return !isNaN(t) && t >= cutoffMs;
    });

    if (convs.length > 0) console.log(`${TAG} backfill: conv list sample keys:`, Object.keys(convs[0]).join(', '));

    let totalAdded = 0, loggedSample = false;
    for (const conv of toFetch) {
      const convId = conv.uuid ?? conv.id;
      if (!convId) continue;
      try {
        const r = await fetch(
          `https://claude.ai/api/organizations/${orgId}/chat_conversations/${convId}?tree=True&rendering_mode=messages`,
          { credentials: 'include', headers: { Accept: 'application/json' } }
        );
        if (!r.ok) continue;
        const convData = await r.json();
        const events   = extractConvTokens(convData);
        if (events.length) {
          totalAdded += await mergeTokenHistory(events);
        } else if (!loggedSample) {
          const msgs = convData?.chat_messages ?? convData?.messages ?? [];
          const sampleMsg = msgs.find(m => m.sender === 'assistant' || m.role === 'assistant') ?? msgs[0];
          console.log(`${TAG} backfill sample — top-level keys:`, Object.keys(convData).join(', '));
          console.log(`${TAG} backfill sample — msg usage field:`, JSON.stringify(sampleMsg?.usage ?? null));
          loggedSample = true;
        }
      } catch {}
    }

    await lset(K_LAST_BACKFILL, now);
    if (totalAdded > 0) {
      console.log(`${TAG} backfill: +${totalAdded} token events from ${toFetch.length} convs`);
      const stats = await getStats();
      updateBadge(stats.pct5h);
    } else {
      console.log(`${TAG} backfill: ${toFetch.length} convs checked, no new events`);
    }
  } catch (err) {
    console.log(`${TAG} backfill error:`, err.message);
  }
}

async function backgroundPoll() {
  console.log(`${TAG} background poll`);
  try {
    const resp = await fetch('https://claude.ai/api/organizations', {
      credentials: 'include', headers: { Accept: 'application/json' },
    });
    if (!resp.ok) { console.log(`${TAG} poll /api/organizations → ${resp.status}`); return; }
    const data = await resp.json();

    const p = detectPlan(data);
    if (p) await lset(K_PLAN, p);

    const rl = extractRateLimitFromResponse(data);
    if (rl) await mergeRateLimit(rl);

    const orgs  = Array.isArray(data) ? data : (data.organizations ?? [data]);
    const orgId = orgs[0]?.uuid ?? orgs[0]?.id ?? null;
    const resolvedOrgId = orgId ?? (await lget(K_ORG_ID));
    if (orgId) await lset(K_ORG_ID, orgId);

    if (resolvedOrgId) {
      await pollOrgUsage(resolvedOrgId);
      await backfillFromConversations(resolvedOrgId);
    }

    const stats = await getStats();
    updateBadge(stats.pct5h);
  } catch (err) {
    console.log(`${TAG} backgroundPoll error:`, err.message);
  }
}

async function saveProviderUsageResult(msg) {
  const site = msg.site ?? 'unknown';
  const capturedAt = msg.capturedAt ?? new Date().toISOString();
  let normalized = null;
  if (site === 'chatgpt') normalized = normalizeChatGptUsage(msg.snapshot, msg.snapshot?.email);
  if (site === 'gemini') normalized = normalizeGeminiUsage(msg.snapshot);
  const snapshots = site === 'claude' && Array.isArray(msg.snapshot?.organizations) ? msg.snapshot.organizations : [];
  if (site === 'claude') await lset('claude_org_usage', snapshots);
  const first = snapshots[0];
  if (first) {
    await lset(K_ORG_ID, first.orgId);
    const plan = detectPlan(first.org) ?? detectPlan(first.usage);
    if (plan) await lset(K_PLAN, plan);
    const rateLimit = extractRateLimitFromResponse(first.usage);
    if (rateLimit) {
      normalized = {
        site: 'claude', accountId: first.orgId, email: null,
        plan, pct5h: asPct(rateLimit.utilization5h), pct7d: asPct(rateLimit.utilization7d),
        resetsAt5h: rateLimit.resetsAt, resetsAt7d: rateLimit.resetsAt7d,
        windowSeconds5h: 5 * 3600, windowSeconds7d: 7 * 24 * 3600, additionalLimits: [],
      };
      await mergeRateLimit(rateLimit);
      if (rateLimit.resetsAt) {
        const resetMs = Date.parse(rateLimit.resetsAt);
        if (!isNaN(resetMs)) await lset(K_WIN5H, { startMs: resetMs - WINDOW_5H_MS, resetMs });
      }
    }
  }
  const normalizedClaude = snapshots.map(item => {
    const rateLimit = extractRateLimitFromResponse(item.usage);
    if (!rateLimit) return null;
    return {
      site: 'claude', accountId: item.orgId, organizationId: item.orgId,
      accountName: item.org?.name ?? item.org?.display_name ?? 'Claude organization', email: null,
      plan: detectPlan(item.org) ?? detectPlan(item.usage),
      pct5h: asPct(rateLimit.utilization5h), pct7d: asPct(rateLimit.utilization7d),
      resetsAt5h: rateLimit.resetsAt, resetsAt7d: rateLimit.resetsAt7d,
      windowSeconds5h: 5 * 3600, windowSeconds7d: 7 * 24 * 3600, additionalLimits: [],
    };
  }).filter(Boolean);
  const toSave = site === 'claude' ? normalizedClaude : (normalized ? [normalized] : []);
  const previous = (await lget(`last_usage_poll_${site}`)) ?? {};
  const ok = Boolean(msg.ok) && toSave.length > 0;
  const validationFailure = Boolean(msg.ok) && toSave.length === 0;
  await lset(`last_usage_poll_${site}`, {
    ok, capturedAt, lastSuccessAt: ok ? capturedAt : (previous.lastSuccessAt ?? null),
    consecutiveFailures: ok ? 0 : (previous.consecutiveFailures ?? 0) + 1,
    error: validationFailure ? 'provider_schema_changed' : (msg.error ?? null),
    status: msg.status ?? null, authPath: msg.authPath ?? 'page_bridge',
  });
  await Promise.all(toSave.map(item => enqueueProviderSnapshot(item, capturedAt)));
  const stats = await getStats();
  updateBadge(stats.pct5h);
  return { ok, saved: toSave.length };
}

let coordinatedRefresh = null;

async function collectAllProviders() {
  if (coordinatedRefresh) return coordinatedRefresh;
  coordinatedRefresh = collectAllProvidersOnce().finally(() => { coordinatedRefresh = null; });
  return coordinatedRefresh;
}

async function collectAllProvidersOnce() {
  await lset(K_LAST_COORDINATED_REFRESH, Date.now());
  await backgroundPoll();
  const collectors = self.TokenWatcherProviders;
  if (!collectors) return;
  // Await sequentially so the MV3 service worker stays alive until storage is
  // complete and one provider failure never prevents the other from running.
  for (const collect of [collectors.collectChatGpt, collectors.collectGemini]) {
    try {
      const result = await collect();
      await saveProviderUsageResult({ ...result, capturedAt: new Date().toISOString() });
    } catch (error) {
      console.warn(`${TAG} provider collector failed:`, error.message);
    }
  }
}

async function requestProviderRefresh(reason, minimumAgeMs = 60_000) {
  const lastRefresh = (await lget(K_LAST_COORDINATED_REFRESH)) ?? 0;
  if (Date.now() - lastRefresh < minimumAgeMs) return false;
  console.log(`${TAG} provider refresh requested: ${reason}`);
  await collectAllProviders();
  return true;
}

function isProviderUrl(url) {
  return ALLOWED_PREFIXES.some(prefix => url?.startsWith(prefix));
}

function ensureAlarms() {
  chrome.alarms.get('heartbeat', alarm => {
    if (!alarm) chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
  });
  chrome.alarms.get('poll', alarm => {
    if (!alarm) chrome.alarms.create('poll', { periodInMinutes: POLL_INTERVAL_MIN });
  });
}

// ── Message router ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fromAllowedSite = sender.tab && ALLOWED_PREFIXES.some(p => sender.tab.url?.startsWith(p));
  const fromExtension   = !sender.tab;

  if (msg.type === 'SSE_TOKENS' && fromAllowedSite) {
    addTokens(msg.inputTokens ?? 0, msg.outputTokens ?? 0, msg.capturedAt, msg.rateLimit ?? null, msg.site ?? 'claude')
      .then(() => reply({ ok: true }))
      .catch(e => reply({ ok: false, err: e.message }));
    return true;
  }

  if (msg.type === 'INTERCEPTED_API' && fromAllowedSite) {
    const site = msg.site ?? 'claude';

    // Plan detection (Claude only)
    if (site === 'claude') {
      const p = detectPlan(msg.data);
      if (p) lset(K_PLAN, p).catch(() => {});

      // Cache org UUID
      if (msg.url?.includes('/api/organizations')) {
        const orgs  = Array.isArray(msg.data) ? msg.data : (msg.data?.organizations ?? [msg.data]);
        const orgId = orgs[0]?.uuid ?? orgs[0]?.id ?? null;
        if (orgId) lset(K_ORG_ID, orgId).catch(() => {});
      }

      // Anchor rate-limit window from API response
      const rlInfo = extractRateLimitFromResponse(msg.data);
      if (rlInfo?.resetsAt) {
        const rlResetMs = Date.parse(rlInfo.resetsAt);
        if (!isNaN(rlResetMs)) {
          mergeRateLimit(rlInfo).catch(() => {});
          lget(K_WIN5H).then(win => {
            if (!win || Math.abs(rlResetMs - win.resetMs) > 60_000) {
              lset(K_WIN5H, { startMs: rlResetMs - WINDOW_5H_MS, resetMs: rlResetMs });
            }
          }).catch(() => {});
          console.log(`${TAG} API rate-limit window anchored via ${msg.url}: resetsAt=${rlInfo.resetsAt}`);
        }
      }

      // Extract token usage from conversation load responses
      if (msg.url?.includes('/chat_conversations/') && msg.url?.includes('rendering_mode')) {
        const events = extractConvTokens(msg.data);
        if (events.length > 0) {
          mergeTokenHistory(events).catch(() => {});
        }
      }
    }

    reply({ ok: true });
    return false;
  }

  if (msg.type === 'PROVIDER_USAGE_SNAPSHOT' && fromAllowedSite) {
    saveProviderUsageResult(msg)
      .then(result => reply(result))
      .catch(e => reply({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'SELECT_PROVIDER_ACCOUNT' && fromExtension) {
    selectProviderAccount(msg.site, msg.accountKey)
      .then(ok => reply({ ok }))
      .catch(e => reply({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'OPEN_POPUP_CONTEXT' && fromAllowedSite) {
    chrome.action.openPopup().catch(() => {});
    reply({ ok: true });
    return false;
  }

  if (msg.type === 'GET_STATS' && (fromExtension || fromAllowedSite)) {
    getStats()
      .then(s  => reply(s))
      .catch(() => reply(null));
    return true;
  }

  if (msg.type === 'SET_PLAN' && (fromExtension || fromAllowedSite)) {
    lset(K_PLAN, msg.plan)
      .then(() => reply({ ok: true }))
      .catch(() => reply({ ok: false }));
    return true;
  }

  return false;
});

// ── Alarms ────────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat') {
    const s = await getStats();
    updateBadge(s.pct5h);
    ensureAlarms();
    requestProviderRefresh('heartbeat-watchdog', (POLL_INTERVAL_MIN + 2) * 60_000).catch(() => {});
  } else if (alarm.name === 'poll') {
    collectAllProviders().catch(err => console.warn(`${TAG} provider collection failed:`, err.message));
  }
});

// ── Init ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.alarms.clear('heartbeat', () => chrome.alarms.create('heartbeat', { periodInMinutes: 1 }));
  chrome.alarms.clear('poll',      () => chrome.alarms.create('poll',      { periodInMinutes: POLL_INTERVAL_MIN }));
  chrome.action.setBadgeText({ text: '' });
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
  }
  collectAllProviders().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  collectAllProviders().catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, tab => {
    if (isProviderUrl(tab?.url)) requestProviderRefresh('provider-tab-activated').catch(() => {});
  });
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isProviderUrl(tab?.url)) {
    requestProviderRefresh('provider-tab-loaded').catch(() => {});
  }
});

chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    requestProviderRefresh('browser-focused', POLL_INTERVAL_MIN * 60_000).catch(() => {});
  }
});

chrome.idle.onStateChanged.addListener(state => {
  if (state === 'active') requestProviderRefresh('browser-woke', POLL_INTERVAL_MIN * 60_000).catch(() => {});
});

ensureAlarms();

console.log(`${TAG} service worker initialised`);

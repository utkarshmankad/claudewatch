// background.js — service worker
// Accumulates SSE token counts, maintains 5h/7d rolling windows,
// detects plan, updates badge.

const TAG = '[ClaudeWatch]';

// ── Constants ──────────────────────────────────────────────────────────────
const WINDOW_5H_MS       = 5  * 60 * 60 * 1000;
const WINDOW_7D_MS       = 7  * 24 * 60 * 60 * 1000;
const MAX_HISTORY        = 2000;
const POLL_INTERVAL_MIN  = 5;   // background poll for cross-client usage

// Approximate token limits per 5-hour window (community-derived estimates).
const PLAN_LIMITS = {
  free:   { limit5h:  10_000, name: 'Free'    },
  pro:    { limit5h:  44_000, name: 'Pro'     },
  max:    { limit5h: 150_000, name: 'Max'     },
  max5x:  { limit5h: 220_000, name: 'Max 5×'  },
  max20x: { limit5h: 880_000, name: 'Max 20×' },
};

// ── Storage keys ──────────────────────────────────────────────────────────
const K_HISTORY   = 'token_history';   // [{ts,input,output,src}]
const K_WIN5H     = 'window_5h';       // {startMs, resetMs}
const K_PLAN      = 'detected_plan';   // plan key string
const K_RATELIMIT = 'rate_limit';      // {type, resetsAt, remaining, utilization5h, ...}
const K_ORG_ID    = 'org_id';          // discovered org UUID for background polling

// ── Storage helpers ───────────────────────────────────────────────────────
const lget = (k)    => new Promise(r => chrome.storage.local.get(k,  d => r(d[k]  ?? null)));
const lset = (k, v) => new Promise(r => chrome.storage.local.set({[k]: v}, r));

// ── Badge ─────────────────────────────────────────────────────────────────
function updateBadge(pct) {
  if (pct == null || isNaN(pct)) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const p = Math.round(pct);
  chrome.action.setBadgeText({ text: `${p}%` });
  chrome.action.setBadgeBackgroundColor({
    color: p >= 90 ? '#ef4444' : p >= 70 ? '#f59e0b' : '#06b6d4',
  });
}

// ── Plan detection ────────────────────────────────────────────────────────
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

// ── Rate-limit window extraction from any API response ───────────────────
// Handles both the SSE message_limit shape and REST API response shapes.
// Returns null if no usable data found.
function extractRateLimitFromResponse(data) {
  if (!data || typeof data !== 'object') return null;

  // Extract from a windows object: {5h: {utilization, resets_at}, 7d: {...}}
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

  // Search common paths where claude.ai encodes the windows structure
  const windowsSources = [
    data.windows,
    data.rate_limit?.windows,
    data.message_limit?.windows,
    data.limits?.windows,
    data.usage?.windows,
  ];
  for (const w of windowsSources) {
    const r = fromWindows(w);
    if (r && (r.resetsAt || r.utilization5h != null)) {
      return {
        type:      data.type ?? data.rate_limit?.type ?? data.message_limit?.type ?? null,
        remaining: data.remaining ?? data.rate_limit?.remaining
                   ?? data.message_limit?.remaining ?? null,
        ...r,
      };
    }
  }

  // Fall back: scan flat candidate objects for a resetsAt timestamp
  const candidates = [
    data.rate_limit, data.rateLimit, data.message_limit,
    data.account?.rate_limit, data.usage?.rate_limit,
    data.limits?.rate_limit, data.limits,
    data.current_period, data.window, data.usage_window,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const resetsAt = c.resetsAt        ?? c.resets_at         ??
                     c.reset_at        ?? c.windowResetsAt    ??
                     c.window_resets_at ?? c.period_end       ??
                     c.current_period_end ?? null;
    if (resetsAt) {
      return {
        type:      c.type ?? null,
        resetsAt,
        remaining: c.remaining ?? c.messages_remaining ?? null,
      };
    }
  }
  return null;
}

// Merge new rate-limit data into storage without losing existing fields.
// Only overwrites a field when the incoming value is non-null, so that
// a REST poll (which may lack utilization5h) never wipes SSE-captured data.
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

// ── Conversation token extraction ─────────────────────────────────────────
// claude.ai loads full conversation data via GET /api/organizations/{o}/
// chat_conversations/{c}?tree=True&rendering_mode=messages after each reply.
// That response includes per-message usage — mine it for real token counts.

function extractConvTokens(data) {
  const events = [];
  const msgs = data?.chat_messages ?? data?.messages ?? null;
  if (!Array.isArray(msgs)) return events;

  for (const msg of msgs) {
    // Timestamp — required for window placement
    const createdAt = msg.created_at ?? msg.timestamp ?? null;
    if (!createdAt) continue;
    const ts = Date.parse(createdAt);
    if (!ts || isNaN(ts)) continue;

    // Token usage — try several possible field shapes
    const u = msg.usage ?? msg.token_usage ?? msg.tokens ?? null;
    if (!u) continue;

    const input  = u.input_tokens  ?? u.inputTokens  ?? u.prompt_tokens     ?? 0;
    const output = u.output_tokens ?? u.outputTokens ?? u.completion_tokens  ?? 0;
    if (input === 0 && output === 0) continue;

    // Tag as 'conv' so we can see the source in logs
    events.push({ ts, input, output, src: 'conv' });
  }

  return events;
}

// Merge new token events into K_HISTORY, deduplicating by timestamp bucket.
// Events within 10 s of an existing entry are considered duplicates.
async function mergeTokenHistory(events) {
  if (!events?.length) return 0;

  const history = (await lget(K_HISTORY)) ?? [];
  const BUCKET  = 10_000; // 10 s dedup window
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

// ── Token accumulation (from SSE) ─────────────────────────────────────────
async function addTokens(inputTokens, outputTokens, capturedAt, rateLimit) {
  const ts  = capturedAt ? Date.parse(capturedAt) : Date.now();
  const now = Date.now();

  const history = (await lget(K_HISTORY)) ?? [];
  history.push({ ts, input: inputTokens, output: outputTokens, src: 'sse' });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  await lset(K_HISTORY, history);

  // 5-hour window — always persist on first creation or expiry
  let win = await lget(K_WIN5H);
  if (!win || now >= win.resetMs) {
    win = { startMs: ts, resetMs: ts + WINDOW_5H_MS };
    await lset(K_WIN5H, win);
  }

  const tokens5h = history.filter(e => e.ts >= win.startMs).reduce((s, e) => s + e.input + e.output, 0);
  const tokens7d = history.filter(e => e.ts >= now - WINDOW_7D_MS).reduce((s, e) => s + e.input + e.output, 0);

  const plan  = (await lget(K_PLAN)) ?? 'pro';
  const limit = PLAN_LIMITS[plan]?.limit5h ?? PLAN_LIMITS.pro.limit5h;
  const pct5h = (tokens5h / limit) * 100;

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

  updateBadge(pct5h);
  console.log(`${TAG} SSE +${inputTokens}in+${outputTokens}out → 5h:${tokens5h} (${pct5h.toFixed(1)}%)`);
}

// ── Build stats payload for popup ─────────────────────────────────────────
async function getStats() {
  const history   = (await lget(K_HISTORY))   ?? [];
  const win       = (await lget(K_WIN5H))     ?? null;
  const plan      = (await lget(K_PLAN))      ?? 'pro';
  const rateLimit = (await lget(K_RATELIMIT)) ?? null;
  const now       = Date.now();

  // Resolve an authoritative resetMs from K_RATELIMIT if available and still in the future
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
    startMs = win.startMs;
    resetMs = win.resetMs;
  } else {
    // K_WIN5H is missing or expired — try K_RATELIMIT first, then estimate from history
    const rl = resolveFromRateLimit();
    if (rl) {
      startMs = rl.startMs;
      resetMs = rl.resetMs;
    } else if (history.length) {
      const minTs = Math.min(...history.map(e => e.ts));
      startMs = minTs;
      resetMs = minTs + WINDOW_5H_MS;
      if (now >= resetMs) { startMs = now; resetMs = now + WINDOW_5H_MS; }
    } else {
      startMs = now;
      resetMs = now + WINDOW_5H_MS;
    }
  }

  const capturedTokens5h = history.filter(e => e.ts >= startMs).reduce((s, e) => s + e.input + e.output, 0);
  const capturedTokens7d = history.filter(e => e.ts >= now - WINDOW_7D_MS).reduce((s, e) => s + e.input + e.output, 0);
  const limit5h           = PLAN_LIMITS[plan]?.limit5h ?? PLAN_LIMITS.pro.limit5h;
  const lastTs            = history.length ? history[history.length - 1].ts : null;

  // Claude's authoritative utilization (0.0–1.0) beats our captured-token estimate
  const authPct5h = rateLimit?.utilization5h != null ? rateLimit.utilization5h * 100 : null;
  const authPct7d = rateLimit?.utilization7d != null ? rateLimit.utilization7d * 100 : null;
  const pct5h     = authPct5h ?? (capturedTokens5h > 0 ? (capturedTokens5h / limit5h) * 100 : null);
  const pct7d     = authPct7d ?? (capturedTokens7d > 0 ? (capturedTokens7d / (limit5h * 7)) * 100 : null);

  // Infer token counts from authoritative utilization × plan limit so the gauge
  // shows a meaningful number even when SSE capture is incomplete.
  const tokens5h = authPct5h != null ? Math.round((authPct5h / 100) * limit5h)       : capturedTokens5h;
  const tokens7d = authPct7d != null ? Math.round((authPct7d / 100) * (limit5h * 7)) : capturedTokens7d;

  // Plan table uses inferred counts so every row is calibrated consistently
  const planTable = Object.entries(PLAN_LIMITS).map(([key, { limit5h: lim5h, name }]) => ({
    key,
    name,
    isCurrent: key === plan,
    pct5h:  tokens5h > 0 ? (tokens5h / lim5h)       * 100 : null,
    pct7d:  tokens7d > 0 ? (tokens7d / (lim5h * 7)) * 100 : null,
  }));

  const resetMs7d = rateLimit?.resetsAt7d ? Date.parse(rateLimit.resetsAt7d) : null;

  return {
    plan,
    planName:      PLAN_LIMITS[plan]?.name ?? 'Pro',
    tokens5h,
    tokens7d,
    pct5h,
    pct7d,
    limit5h,
    resetMs5h:     resetMs,
    timeLeft5h:    Math.max(0, resetMs - now),
    timeLeft7d:    resetMs7d ? Math.max(0, resetMs7d - now) : null,
    history,
    planTable,
    lastTs,
    rlType:        rateLimit?.type      ?? null,
    rlResetsAt:    rateLimit?.resetsAt  ?? null,
    rlRemaining:   rateLimit?.remaining ?? null,
  };
}

// ── Background polling ────────────────────────────────────────────────────
// Periodically fetches claude.ai REST endpoints using the user's session
// cookies so usage from Claude Desktop and other clients stays reflected.
// The service worker has host_permissions for claude.ai, so fetch() from
// here automatically includes the browser's cookies for that domain.

async function pollOrgUsage(orgId) {
  const urls = [
    `https://claude.ai/api/organizations/${orgId}`,
    `https://claude.ai/api/organizations/${orgId}/usage`,
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!resp.ok) continue;
      const data = await resp.json();

      const p = detectPlan(data);
      if (p) await lset(K_PLAN, p);

      const rl = extractRateLimitFromResponse(data);
      if (rl && (rl.resetsAt || rl.utilization5h != null)) {
        await mergeRateLimit(rl);
        if (rl.resetsAt) {
          const resetMs = Date.parse(rl.resetsAt);
          if (!isNaN(resetMs)) {
            await lset(K_WIN5H, { startMs: resetMs - WINDOW_5H_MS, resetMs });
          }
        }
        console.log(`${TAG} poll org usage OK — resetsAt=${rl.resetsAt} util5h=${rl.utilization5h}`);
        return;
      }
    } catch (err) {
      console.log(`${TAG} poll ${url} error:`, err.message);
    }
  }
}

async function backgroundPoll() {
  console.log(`${TAG} background poll`);
  try {
    const resp = await fetch('https://claude.ai/api/organizations', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      console.log(`${TAG} poll /api/organizations → ${resp.status}`);
      return;
    }
    const data = await resp.json();

    const p = detectPlan(data);
    if (p) await lset(K_PLAN, p);

    const rl = extractRateLimitFromResponse(data);
    if (rl) await mergeRateLimit(rl);

    // Extract org UUID — claude.ai returns an array of org objects
    const orgs  = Array.isArray(data) ? data : (data.organizations ?? [data]);
    const orgId = orgs[0]?.uuid ?? orgs[0]?.id ?? null;
    if (orgId) {
      await lset(K_ORG_ID, orgId);
      await pollOrgUsage(orgId);
    } else {
      // Try with a previously discovered org ID
      const stored = await lget(K_ORG_ID);
      if (stored) await pollOrgUsage(stored);
    }

    const stats = await getStats();
    updateBadge(stats.pct5h);
  } catch (err) {
    console.log(`${TAG} backgroundPoll error:`, err.message);
  }
}

// ── Message router ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fromClaude    = sender.tab?.url?.startsWith('https://claude.ai/');
  const fromExtension = !sender.tab;

  if (msg.type === 'SSE_TOKENS' && fromClaude) {
    addTokens(msg.inputTokens ?? 0, msg.outputTokens ?? 0, msg.capturedAt, msg.rateLimit ?? null)
      .then(() => reply({ ok: true }))
      .catch(e  => reply({ ok: false, err: e.message }));
    return true;
  }

  if (msg.type === 'INTERCEPTED_API' && fromClaude) {
    // Plan detection
    const p = detectPlan(msg.data);
    if (p) lset(K_PLAN, p).catch(() => {});

    // Cache org UUID when we see it from the /api/organizations intercept
    if (msg.url?.includes('/api/organizations')) {
      const orgs  = Array.isArray(msg.data) ? msg.data : (msg.data?.organizations ?? [msg.data]);
      const orgId = orgs[0]?.uuid ?? orgs[0]?.id ?? null;
      if (orgId) lset(K_ORG_ID, orgId).catch(() => {});
    }

    // Scan every API response for an authoritative rate-limit window reset time.
    // claude.ai encodes this in organization/account responses so we can anchor
    // the 5h window even when the user is well within their limit.
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

    // Extract real token counts from conversation load responses.
    // claude.ai GETs /chat_conversations/{id}?tree=True&rendering_mode=messages
    // after every completion — its response contains per-message usage.
    if (msg.url?.includes('/chat_conversations/') && msg.url?.includes('rendering_mode')) {
      const events = extractConvTokens(msg.data);
      if (events.length > 0) {
        mergeTokenHistory(events).catch(() => {});
      } else {
        // Log structure so we can inspect what fields are available
        console.log(`${TAG} conv response (no usage found):`, JSON.stringify(msg.data).slice(0, 600));
      }
    }

    reply({ ok: true });
    return false;
  }

  if (msg.type === 'GET_STATS' && (fromExtension || fromClaude)) {
    getStats()
      .then(s  => reply(s))
      .catch(() => reply(null));
    return true;
  }

  if (msg.type === 'SET_PLAN' && (fromExtension || fromClaude)) {
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
  } else if (alarm.name === 'poll') {
    backgroundPoll().catch(() => {});
  }
});

// ── Init ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.alarms.clear('heartbeat', () => {
    chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
  });
  chrome.alarms.clear('poll', () => {
    chrome.alarms.create('poll', { periodInMinutes: POLL_INTERVAL_MIN });
  });
  chrome.action.setBadgeText({ text: '' });
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
  }
  // Fetch current state immediately on install/update
  backgroundPoll().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.get('heartbeat', e => {
    if (!e) chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
  });
  chrome.alarms.get('poll', e => {
    if (!e) chrome.alarms.create('poll', { periodInMinutes: POLL_INTERVAL_MIN });
  });
  // Fetch fresh data on browser start — catches usage from Desktop overnight
  backgroundPoll().catch(() => {});
});

console.log(`${TAG} service worker initialised`);

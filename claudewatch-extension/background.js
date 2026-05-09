// background.js — service worker
// Accumulates SSE token counts, maintains 5h/7d rolling windows,
// detects plan, updates badge, optionally syncs to local Core daemon.

const TAG = '[ClaudeWatch]';

// ── Constants ──────────────────────────────────────────────────────────────
const WINDOW_5H_MS  = 5  * 60 * 60 * 1000;
const WINDOW_7D_MS  = 7  * 24 * 60 * 60 * 1000;
const MAX_HISTORY   = 1000;
const DEFAULT_CORE  = 'http://localhost:7734';

// Approximate token limits per 5-hour window (community-derived estimates).
// 7-day limit = 5h limit × 7 (one full window used per day).
const PLAN_LIMITS = {
  free:   { limit5h:  10_000, name: 'Free'    },
  pro:    { limit5h:  44_000, name: 'Pro'     },
  max:    { limit5h: 150_000, name: 'Max'     },
  max5x:  { limit5h: 220_000, name: 'Max 5×'  },
  max20x: { limit5h: 880_000, name: 'Max 20×' },
};

// ── Storage keys ──────────────────────────────────────────────────────────
const K_HISTORY   = 'token_history';   // [{ts,input,output}]
const K_WIN5H     = 'window_5h';       // {startMs, resetMs}
const K_PLAN      = 'detected_plan';   // plan key string
const K_STATUS    = 'core_status';     // {connected,lastSync}
const K_RATELIMIT = 'rate_limit';      // {type, resetsAt, remaining} from message_limit SSE event

// ── Storage helpers ───────────────────────────────────────────────────────
const lget = (k)    => new Promise(r => chrome.storage.local.get(k,  d => r(d[k]  ?? null)));
const lset = (k, v) => new Promise(r => chrome.storage.local.set({[k]: v}, r));
const sget = (d)    => new Promise(r => chrome.storage.sync.get(d, r));

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

// ── Core daemon sync (optional, fails silently) ───────────────────────────
async function syncCore(tokens5h, plan) {
  const { coreUrl } = await sget({ coreUrl: DEFAULT_CORE });
  try {
    const lim = PLAN_LIMITS[plan]?.limit5h ?? PLAN_LIMITS.pro.limit5h;
    const res = await fetch(`${coreUrl}/api/session`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        tokensUsed: tokens5h,
        tokenLimit: lim,
        plan,
        capturedAt: new Date().toISOString(),
      }),
    });
    await lset(K_STATUS, { connected: res.ok, lastSync: new Date().toISOString() });
  } catch {
    await lset(K_STATUS, { connected: false, lastSync: null });
  }
}

// ── Token accumulation ────────────────────────────────────────────────────
async function addTokens(inputTokens, outputTokens, capturedAt, rateLimit) {
  const ts  = capturedAt ? Date.parse(capturedAt) : Date.now();
  const now = Date.now();

  // Append to history
  const history = (await lget(K_HISTORY)) ?? [];
  history.push({ ts, input: inputTokens, output: outputTokens });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  await lset(K_HISTORY, history);

  // 5-hour window: create on first token, reset when expired — always persist
  let win = await lget(K_WIN5H);
  if (!win || now >= win.resetMs) {
    win = { startMs: ts, resetMs: ts + WINDOW_5H_MS };
    await lset(K_WIN5H, win);
  }

  // Compute rolling totals
  const tokens5h = history
    .filter(e => e.ts >= win.startMs)
    .reduce((s, e) => s + e.input + e.output, 0);

  const tokens7d = history
    .filter(e => e.ts >= now - WINDOW_7D_MS)
    .reduce((s, e) => s + e.input + e.output, 0);

  const plan   = (await lget(K_PLAN)) ?? 'pro';
  const limit  = PLAN_LIMITS[plan]?.limit5h ?? PLAN_LIMITS.pro.limit5h;
  const pct5h  = (tokens5h / limit) * 100;

  // Persist rate-limit metadata from the SSE message_limit event
  if (rateLimit && (rateLimit.resetsAt || rateLimit.type)) {
    await lset(K_RATELIMIT, { ...rateLimit, savedAt: new Date().toISOString() });
    // Use resetsAt from claude.ai directly as the window reset time
    if (rateLimit.resetsAt) {
      const resetMs = Date.parse(rateLimit.resetsAt);
      if (!isNaN(resetMs)) {
        win = { startMs: win.startMs, resetMs };
        await lset(K_WIN5H, win);
      }
    }
  }

  updateBadge(pct5h);
  syncCore(tokens5h, plan).catch(() => {});

  console.log(`${TAG} tokens +${inputTokens}in+${outputTokens}out → 5h:${tokens5h} (${pct5h.toFixed(1)}%)`);
}

// ── Build stats payload for popup ─────────────────────────────────────────
async function getStats() {
  const history   = (await lget(K_HISTORY))   ?? [];
  const win       = (await lget(K_WIN5H))     ?? null;
  const plan      = (await lget(K_PLAN))      ?? 'pro';
  const status    = (await lget(K_STATUS))    ?? null;
  const rateLimit = (await lget(K_RATELIMIT)) ?? null;
  const now       = Date.now();

  let startMs, resetMs;
  if (win) {
    startMs = win.startMs;
    resetMs = win.resetMs;
    if (now >= resetMs) { startMs = now; resetMs = now + WINDOW_5H_MS; }
  } else if (history.length) {
    // K_WIN5H never saved (old bug) — bootstrap from earliest token in history
    const minTs = Math.min(...history.map(e => e.ts));
    startMs = minTs;
    resetMs = minTs + WINDOW_5H_MS;
    if (now >= resetMs) { startMs = now; resetMs = now + WINDOW_5H_MS; }
  } else {
    startMs = now;
    resetMs = now + WINDOW_5H_MS;
  }

  const tokens5h = history
    .filter(e => e.ts >= startMs)
    .reduce((s, e) => s + e.input + e.output, 0);

  const tokens7d = history
    .filter(e => e.ts >= now - WINDOW_7D_MS)
    .reduce((s, e) => s + e.input + e.output, 0);

  // Per-plan comparison
  const planTable = Object.entries(PLAN_LIMITS).map(([key, { limit5h, name }]) => ({
    key,
    name,
    isCurrent: key === plan,
    pct5h:  tokens5h > 0 ? (tokens5h / limit5h)        * 100 : null,
    pct7d:  tokens7d > 0 ? (tokens7d / (limit5h * 7))  * 100 : null,
  }));

  const limit5h  = PLAN_LIMITS[plan]?.limit5h ?? PLAN_LIMITS.pro.limit5h;
  const lastTs   = history.length ? history[history.length - 1].ts : null;

  return {
    plan,
    planName:     PLAN_LIMITS[plan]?.name ?? 'Pro',
    tokens5h,
    tokens7d,
    pct5h:        tokens5h > 0 ? (tokens5h / limit5h)       * 100 : null,
    pct7d:        tokens7d > 0 ? (tokens7d / (limit5h * 7)) * 100 : null,
    limit5h,
    resetMs5h:    resetMs,
    timeLeft5h:   Math.max(0, resetMs - now),
    history,
    planTable,
    lastTs,
    coreConnected: status?.connected ?? false,
    // Rate-limit info from claude.ai message_limit SSE event
    rlType:      rateLimit?.type      ?? null,
    rlResetsAt:  rateLimit?.resetsAt  ?? null,
    rlRemaining: rateLimit?.remaining ?? null,
  };
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
    const p = detectPlan(msg.data);
    if (p) lset(K_PLAN, p).catch(() => {});
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

// ── Heartbeat alarm ────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'heartbeat') return;
  const s = await getStats();
  updateBadge(s.pct5h);
  if (s.tokens5h > 0) syncCore(s.tokens5h, s.plan).catch(() => {});
});

// ── Init ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.alarms.clear('heartbeat', () => {
    chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
  });
  chrome.action.setBadgeText({ text: '' });
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.get('heartbeat', e => {
    if (!e) chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
  });
});

console.log(`${TAG} service worker initialised`);

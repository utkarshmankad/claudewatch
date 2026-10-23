// background.js — service worker
// Accumulates SSE token counts across Claude, ChatGPT, and Gemini.
// Maintains 5h/7d rolling windows, detects plan, updates badge.

// The worker is an ES module so Autopilot alerts can share the popup's policy code. These classic scripts
// register themselves on `self`, so importing them for side effects is equivalent to the old importScripts.
import './provider-collectors.js';
import './activity-collector.js';
import './analytics.js';
import './refresh-policy.js';
import './provider-contract.js';
import './provider-adapters.js';
import { evaluateAlerts, recordAlertAction } from './autopilot/alert-runner.mjs';
import { PROVIDER_URLS } from './autopilot/view-model.mjs';
import { openProviderText } from './autopilot/messages.mjs';

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
const K_STALE_STATE = 'analytics_stale_state'; // {site: {since, reason, explained}}
const providerRefreshes = new Map();
const K_REFRESH_STATE = site => `refresh_state_${site}`;
const PROVIDER_SITES = ['chatgpt', 'gemini', 'claude'];

// ── Storage helpers ───────────────────────────────────────────────────────
const lget = (k)    => new Promise(r => chrome.storage.local.get(k,  d => r(d[k]  ?? null)));
const lset = (k, v) => new Promise((resolve, reject) => chrome.storage.local.set({[k]: v}, () => {
  const error = chrome.runtime.lastError;
  if (error) reject(new Error(error.message)); else resolve();
}));
let providerSaveQueue = Promise.resolve();

async function getDeviceId() {
  let id = await lget(K_DEVICE_ID);
  if (!id) { id = crypto.randomUUID(); await lset(K_DEVICE_ID, id); }
  return id;
}

// ── Local analytics (never sent off-device) ──────────────────────────────
const analytics = self.TokenWatcherAnalytics.createStore(self.TokenWatcherAnalytics.chromeStorageAdapter());
const track = (name, props) => analytics.record(name, props).catch(() => {});

// ── Opt-in browser activity observations (metadata only) ───────────────
const activity = self.TokenWatcherActivity.createStore(self.TokenWatcherActivity.chromeStorageAdapter());

// Identifies the current browser run so local session ids reset on restart.
async function browserEpoch() {
  try {
    const stored = await chrome.storage.session.get('activity_epoch');
    if (stored.activity_epoch) return stored.activity_epoch;
    const epoch = Date.now().toString(36);
    await chrome.storage.session.set({ activity_epoch: epoch });
    return epoch;
  } catch { return 'e0'; }
}

async function recordActivity(msg, tab) {
  if (tab.incognito) return { ok: false, reason: 'incognito_excluded' };
  if (!(await activity.isEnabled())) return { ok: false, reason: 'not_enabled' };
  const sessionId = await activity.sessionFor(tab.id, await browserEpoch());
  return activity.record({
    v: 1, id: msg.eventId, provider: msg.site, ts: msg.ts, sessionId, activityType: msg.activityType,
  });
}

// Maps scheduler triggers onto the closed analytics trigger enum.
function analyticsTrigger(trigger) {
  if (['install', 'startup', 'alarm', 'manual', 'wake', 'focus'].includes(trigger)) return trigger;
  if (['tab_created', 'tab_activated', 'navigation'].includes(trigger)) return 'tab';
  if (trigger === 'watchdog') return 'alarm';
  if (trigger === 'stats_read') return 'manual';
  return 'other';
}

async function getRefreshState(site) {
  return { ...self.TokenWatcherRefresh.initialState(), ...((await lget(K_REFRESH_STATE(site))) ?? {}) };
}

// Records the outcome of one refresh and schedules the bounded, jittered retry alarm.
async function recordRefreshOutcome(site, trigger, ok, category) {
  const R = self.TokenWatcherRefresh;
  const next = R.applyOutcome(await getRefreshState(site), { now: Date.now(), ok, category, trigger });
  await lset(K_REFRESH_STATE(site), next);
  const alarmName = `retry_${site}`;
  if (next.nextRetryAt != null) chrome.alarms.create(alarmName, { when: Math.max(next.nextRetryAt, Date.now() + 30_000) });
  else chrome.alarms.clear(alarmName);
  return next;
}

// Classifies one finished refresh from the stored poll record (or the thrown error).
async function classifyRefresh(site, startedAt, thrown) {
  const A = self.TokenWatcherAnalytics;
  const poll = (await lget(`last_usage_poll_${site}`)) ?? {};
  const ok = !thrown && Date.parse(poll.lastSuccessAt ?? '') >= startedAt;
  const pollIsFresh = Date.parse(poll.capturedAt ?? '') >= startedAt;
  const errorCategory = ok ? 'none'
    : thrown ? A.categorizeError(thrown.message)
    : pollIsFresh ? A.categorizeError(poll.error, poll.status) : 'other';
  return { ok, errorCategory };
}

async function trackRefreshOutcome(site, startedAt, trigger, { ok, errorCategory }) {
  try {
    const durationMs = Math.min(600_000, Math.max(0, Date.now() - startedAt));
    await track('refresh_result', { provider: site, ok, errorCategory, trigger: analyticsTrigger(trigger), durationMs });
    if (!ok) return;
    const existing = await analytics.list();
    if (!existing.some(e => e.name === 'provider_connected' && e.props.provider === site)) {
      await track('provider_connected', { provider: site });
    }
    if (!existing.some(e => e.name === 'first_useful_reading')) {
      const { installedAt } = await analytics.meta();
      if (installedAt) await track('first_useful_reading', { provider: site, secondsSinceInstall: Math.round((Date.now() - installedAt) / 1000) });
    }
    const staleState = (await lget(K_STALE_STATE)) ?? {};
    if (staleState[site]) {
      await track('stale_ended', { provider: site, staleSeconds: Math.round((Date.now() - staleState[site].since) / 1000), explained: staleState[site].explained });
      delete staleState[site];
      await lset(K_STALE_STATE, staleState);
    }
  } catch { /* analytics must never affect refresh */ }
}

// Called from the heartbeat: records when a connected provider crosses the stale threshold.
async function trackStaleTransitions() {
  try {
    const A = self.TokenWatcherAnalytics;
    const connected = new Set((await analytics.list()).filter(e => e.name === 'provider_connected').map(e => e.props.provider));
    const staleState = (await lget(K_STALE_STATE)) ?? {};
    let changed = false;
    for (const site of connected) {
      const poll = (await lget(`last_usage_poll_${site}`)) ?? {};
      const lastOk = Date.parse(poll.lastSuccessAt ?? '');
      if (!Number.isFinite(lastOk) || Date.now() - lastOk <= PROVIDER_STALE_MS || staleState[site]) continue;
      const reason = poll.ok === false ? A.categorizeError(poll.error, poll.status) : 'other';
      const explained = poll.ok === false && reason !== 'other';
      staleState[site] = { since: lastOk + PROVIDER_STALE_MS, reason, explained };
      await track('stale_started', { provider: site, reason, explained });
      changed = true;
    }
    if (changed) await lset(K_STALE_STATE, staleState);
  } catch { /* analytics must never affect the heartbeat */ }
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

const validateProviderSnapshot = snapshot => self.TokenWatcherContract.validateSnapshot(snapshot);

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

const { detectPlan, extractRateLimitFromResponse, asPct } = self.TokenWatcherAdapters;

async function mergeRateLimit(newInfo, { authoritative = false } = {}) {
  if (!newInfo) return;
  const existing = (await lget(K_RATELIMIT)) ?? {};
  const merged = { ...existing };
  // A provider /usage response is the current source of truth. Clear the
  // transient message-limit warning left by an older SSE event when the
  // authoritative response no longer reports it.
  if (authoritative) {
    merged.type = newInfo.type ?? null;
    merged.remaining = newInfo.remaining ?? null;
  }
  for (const [k, v] of Object.entries(newInfo)) {
    if (v != null) merged[k] = v;
  }
  merged.savedAt = new Date().toISOString();
  await lset(K_RATELIMIT, merged);
}

// ── Provider quota normalization and history ─────────────────────────────
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
  const projection = self.TokenWatcherContract.projectUsage({ currentPct, ratePerHour, horizonHours, now });
  if (!projection) return null;
  return {
    ...projection,
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
  const capturedIso = new Date(ts).toISOString();
  const readings = self.TokenWatcherContract.toReadings(snapshot, { fetchedAt: capturedIso });
  const stored = { ...snapshot, accountKey, capturedAt: capturedIso, ts, readings };
  const accounts = (await lget(K_PROVIDER_ACCOUNTS)) ?? {};
  accounts[snapshot.site] = accounts[snapshot.site] ?? {};
  accounts[snapshot.site][accountKey] = stored;
  // Bound persisted account state and clean up duplicates produced by old,
  // unstable provider identifiers. Ten entries still supports account switching.
  for (const site of Object.keys(accounts)) {
    accounts[site] = Object.fromEntries(Object.entries(accounts[site] ?? {})
      .sort(([, a], [, b]) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, 10));
  }
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
    const pollSuccessMs = Date.parse(poll?.lastSuccessAt ?? '');
    const snapshotMs = Number.isFinite(selected?.ts) ? selected.ts : null;
    const lastUpdatedAt = Math.max(
      Number.isFinite(pollSuccessMs) ? pollSuccessMs : 0,
      snapshotMs ?? 0,
    ) || null;
    const ageMs = lastUpdatedAt ? Math.max(0, now - lastUpdatedAt) : null;
    const freshness = self.TokenWatcherRefresh.describeFreshness(await getRefreshState(site), now, now);
    providerHealth[site] = {
      ...poll,
      ...freshness,
      lastUpdatedAt,
      lastFetchAt: freshness.lastFetchAt ?? lastUpdatedAt,
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

  // Provenance of the two gauge percentages: provider-reported, or a local token estimate.
  const pct5hSource = authPct5h != null ? 'provider_reported' : (pct5h != null ? 'local_estimate' : null);
  const pct7dSource = authPct7d != null ? 'provider_reported' : (pct7d != null ? 'local_estimate' : null);

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
    pct5hSource,
    pct7dSource,
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
        await mergeRateLimit(rl, { authoritative: true });
        if (rl.resetsAt) {
          const resetMs = Date.parse(rl.resetsAt);
          if (!isNaN(resetMs)) await lset(K_WIN5H, { startMs: resetMs - WINDOW_5H_MS, resetMs });
        }
        console.log(`${TAG} poll org usage OK — resetsAt=${rl.resetsAt} util5h=${rl.utilization5h}`);
        return { data, rateLimit: rl };
      }
    } catch (err) {
      console.log(`${TAG} poll ${url} error:`, err.message);
    }
  }
  return null;
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

// Keeps a failed poll visible to the stale-reason logic instead of returning silently.
async function recordPollFailure(site, error, status = 0) {
  const previous = (await lget(`last_usage_poll_${site}`)) ?? {};
  await lset(`last_usage_poll_${site}`, {
    ok: false, capturedAt: new Date().toISOString(), lastSuccessAt: previous.lastSuccessAt ?? null,
    consecutiveFailures: (previous.consecutiveFailures ?? 0) + 1, error, status, authPath: 'service_worker',
  });
}

async function backgroundPoll() {
  console.log(`${TAG} background poll`);
  try {
    const resp = await fetch('https://claude.ai/api/organizations', {
      credentials: 'include', headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      console.log(`${TAG} poll /api/organizations → ${resp.status}`);
      await recordPollFailure('claude', 'organizations_fetch_failed', resp.status);
      return;
    }
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
      const polled = await pollOrgUsage(resolvedOrgId);
      if (polled?.rateLimit) {
        const capturedAt = new Date().toISOString();
        const org = orgs.find(item => (item?.uuid ?? item?.id) === resolvedOrgId) ?? orgs[0] ?? {};
        const rateLimit = polled.rateLimit;
        await enqueueProviderSnapshot({
          site: 'claude', accountId: resolvedOrgId, organizationId: resolvedOrgId,
          accountName: org?.name ?? org?.display_name ?? 'Claude organization', email: null,
          plan: detectPlan(org) ?? detectPlan(polled.data) ?? p,
          pct5h: asPct(rateLimit.utilization5h), pct7d: asPct(rateLimit.utilization7d),
          resetsAt5h: rateLimit.resetsAt, resetsAt7d: rateLimit.resetsAt7d,
          windowSeconds5h: 5 * 3600, windowSeconds7d: 7 * 24 * 3600, additionalLimits: [],
        }, capturedAt);
        await lset('last_usage_poll_claude', {
          ok: true, capturedAt, lastSuccessAt: capturedAt,
          consecutiveFailures: 0, error: null, status: 200, authPath: 'service_worker',
        });
      } else {
        await recordPollFailure('claude', polled ? 'provider_schema_changed' : 'usage_fetch_failed', polled?.status ?? 0);
      }
      await backfillFromConversations(resolvedOrgId);
    } else {
      await recordPollFailure('claude', 'provider_schema_changed');
    }

    const stats = await getStats();
    updateBadge(stats.pct5h);
  } catch (err) {
    console.log(`${TAG} backgroundPoll error:`, err.message);
    await recordPollFailure('claude', err.message).catch(() => {});
  }
}

async function saveProviderUsageResult(msg) {
  const site = msg.site ?? 'unknown';
  const capturedAt = msg.capturedAt ?? new Date().toISOString();
  const { snapshots: adapted, category } = self.TokenWatcherAdapters.adapt(msg);
  const snapshots = site === 'claude' && Array.isArray(msg.snapshot?.organizations) ? msg.snapshot.organizations : [];
  if (site === 'claude') await lset('claude_org_usage', snapshots);
  const first = snapshots[0];
  if (first) {
    await lset(K_ORG_ID, first.orgId);
    const plan = detectPlan(first.org) ?? detectPlan(first.usage);
    if (plan) await lset(K_PLAN, plan);
    const rateLimit = extractRateLimitFromResponse(first.usage);
    if (rateLimit) {
      await mergeRateLimit(rateLimit, { authoritative: true });
      if (rateLimit.resetsAt) {
        const resetMs = Date.parse(rateLimit.resetsAt);
        if (!isNaN(resetMs)) await lset(K_WIN5H, { startMs: resetMs - WINDOW_5H_MS, resetMs });
      }
    }
  }
  // Impossible readings are dropped here so one bad window cannot corrupt stored history.
  const toSave = adapted.filter(item => !validateProviderSnapshot(item));
  const previous = (await lget(`last_usage_poll_${site}`)) ?? {};
  const ok = Boolean(msg.ok) && toSave.length > 0;
  // Nothing usable from a "successful" fetch, or only impossible values: the format changed.
  const validationFailure = Boolean(msg.ok) && toSave.length === 0;
  await lset(`last_usage_poll_${site}`, {
    ok, capturedAt, lastSuccessAt: ok ? capturedAt : (previous.lastSuccessAt ?? null),
    consecutiveFailures: ok ? 0 : (previous.consecutiveFailures ?? 0) + 1,
    error: validationFailure ? 'provider_schema_changed' : (msg.error ?? null),
    errorCategory: ok ? null : (validationFailure ? 'provider_schema_changed' : category),
    status: msg.status ?? null, authPath: msg.authPath ?? 'page_bridge',
  });
  await Promise.all(toSave.map(item => enqueueProviderSnapshot(item, capturedAt)));
  const stats = await getStats();
  updateBadge(stats.pct5h);
  return { ok, saved: toSave.length };
}

async function collectAllProviders(trigger = 'other') {
  return Promise.allSettled(['chatgpt', 'gemini', 'claude'].map(site => collectProvider(site, trigger)));
}

function withRefreshTimeout(promise, site, timeoutMs = 30_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${site}_refresh_timeout`)), timeoutMs)),
  ]);
}

async function collectProvider(site, trigger = 'other') {
  if (providerRefreshes.has(site)) return providerRefreshes.get(site);
  const startedAt = Date.now();
  let thrown = null;
  const refresh = collectProviderOnce(site)
    .catch(error => { thrown = error; console.warn(`${TAG} ${site} collector failed:`, error.message); })
    .then(async () => {
      const outcome = await classifyRefresh(site, startedAt, thrown);
      await recordRefreshOutcome(site, trigger, outcome.ok, outcome.ok ? null : outcome.errorCategory)
        .catch(error => console.warn(`${TAG} ${site} refresh state not saved:`, error.message));
      await trackRefreshOutcome(site, startedAt, trigger, outcome);
    })
    .finally(() => providerRefreshes.delete(site));
  providerRefreshes.set(site, refresh);
  return refresh;
}

async function collectProviderOnce(site) {
  await lset(`last_provider_refresh_attempt_${site}`, Date.now());
  if (site === 'claude') return withRefreshTimeout(backgroundPoll(), site, 45_000);
  const collectors = self.TokenWatcherProviders;
  if (!collectors) return;
  const collect = site === 'chatgpt' ? collectors.collectChatGpt : collectors.collectGemini;
  if (!collect) return;
  const result = await withRefreshTimeout(collect(), site);
  return saveProviderUsageResult({ ...result, capturedAt: new Date().toISOString() });
}

// Idempotent: every trigger funnels through the policy, which decides whether to run.
async function requestProviderRefresh(trigger, site = null) {
  const R = self.TokenWatcherRefresh;
  const due = [];
  for (const provider of site ? [site] : PROVIDER_SITES) {
    const decision = R.evaluate({
      now: Date.now(), trigger, state: await getRefreshState(provider), inFlight: providerRefreshes.has(provider),
    });
    if (decision.run) due.push(provider);
  }
  if (!due.length) return false;
  console.log(`${TAG} provider refresh requested: ${trigger} (${due.join(', ')})`);
  await Promise.allSettled(due.map(provider => collectProvider(provider, trigger)));
  runAlerts();
  return true;
}

// ── Autopilot alerts ──────────────────────────────────────────────────────
const alertLookup = (key, subs, fallback) => {
  try { return chrome.i18n.getMessage(key, subs) || fallback; } catch { return fallback; }
};
let alertsRunning = false;

async function showAlert({ id, title, message, provider }) {
  await new Promise(resolve => chrome.notifications.create(`ap-alert-${id}-${provider ?? 'none'}`, {
    type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 0,
    buttons: provider ? [{ title: openProviderText(alertLookup) }] : [],
  }, () => { void chrome.runtime.lastError; resolve(); }));
}

// Decision alerts never throw into the refresh path; one evaluation runs at a time.
async function runAlerts() {
  if (alertsRunning) return;
  alertsRunning = true;
  try {
    await evaluateAlerts({ stats: await getStats(), notify: showAlert, track, t: alertLookup });
  } catch (err) {
    console.warn(`${TAG} alert evaluation failed:`, err.message);
  } finally {
    alertsRunning = false;
  }
}

const alertProvider = id => { const p = id.split('-').pop(); return PROVIDER_SITES.includes(p) ? p : null; };
function openAlertProvider(id) {
  const provider = alertProvider(id);
  if (!provider) return;
  chrome.tabs.create({ url: PROVIDER_URLS[provider] });
  recordAlertAction('switch_provider', provider, Date.now(), track).catch(() => {});
}
chrome.notifications.onClicked.addListener(id => { if (id.startsWith('ap-alert-')) { openAlertProvider(id); chrome.notifications.clear(id); } });
chrome.notifications.onButtonClicked.addListener(id => { if (id.startsWith('ap-alert-')) { openAlertProvider(id); chrome.notifications.clear(id); } });
chrome.notifications.onClosed.addListener((id, byUser) => {
  if (byUser && id.startsWith('ap-alert-')) recordAlertAction('dismiss', alertProvider(id), Date.now(), track).catch(() => {});
});

function providerFromUrl(url) {
  if (url?.startsWith('https://chatgpt.com/') || url?.startsWith('https://chat.openai.com/')) return 'chatgpt';
  if (url?.startsWith('https://gemini.google.com/')) return 'gemini';
  if (url?.startsWith('https://claude.ai/')) return 'claude';
  return null;
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

  if (msg.type === 'ACTIVITY_OBSERVED' && fromAllowedSite) {
    recordActivity(msg, sender.tab).then(r => reply(r)).catch(() => reply({ ok: false }));
    return true;
  }

  if (msg.type === 'ACTIVITY_SET_ENABLED' && fromExtension) {
    activity.setEnabled(msg.enabled === true).then(r => reply(r)).catch(() => reply({ ok: false }));
    return true;
  }

  if (msg.type === 'ACTIVITY_SUMMARY' && fromExtension) {
    // Counts only: the popup never needs the observations themselves.
    Promise.all([activity.isEnabled(), activity.list()]).then(([enabled, events]) => {
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const counts24h = {};
      for (const e of events) if (e.activityType === 'message_completed' && e.ts >= since) counts24h[e.provider] = (counts24h[e.provider] ?? 0) + 1;
      reply({ enabled, counts24h });
    }).catch(() => reply(null));
    return true;
  }

  if (msg.type === 'ACTIVITY_CLEAR' && fromExtension) {
    activity.clear().then(r => reply(r)).catch(() => reply({ ok: false }));
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
          mergeRateLimit(rlInfo, { authoritative: msg.url?.includes('/usage') }).catch(() => {});
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

  if (msg.type === 'ANALYTICS_ACTIVE_DAY' && fromExtension) {
    const surface = ['popup', 'settings', 'onboarding'].includes(msg.surface) ? msg.surface : null;
    (surface ? analytics.recordActiveDay(surface) : Promise.resolve({ ok: false }))
      .then(r => reply(r)).catch(() => reply({ ok: false }));
    return true;
  }

  if (msg.type === 'ANALYTICS_ONBOARDING_DONE' && fromExtension) {
    track('onboarding_completed', {}).then(() => reply({ ok: true }));
    return true;
  }

  // Autopilot UI events. Only allow-listed names reach the store, and the store validates props
  // against the closed schema, so no free text or identifiers can be recorded.
  if (msg.type === 'ANALYTICS_AUTOPILOT' && fromExtension) {
    const names = ['recommendation_impression', 'explanation_viewed', 'provider_opened', 'wait_chosen', 'recommendation_dismissed', 'preference_changed', 'autopilot_toggled', 'alert_feedback'];
    (names.includes(msg.name) ? analytics.record(msg.name, msg.props ?? {}) : Promise.resolve({ ok: false }))
      .then(async (r) => {
        // First recommendation ever shown: the activation-time metric reads this event.
        if (r?.ok && msg.name === 'recommendation_impression') {
          const existing = await analytics.list();
          if (!existing.some(e => e.name === 'first_recommendation')) {
            await track('first_recommendation', { kind: msg.props?.state === 'all_limited' ? 'wait' : 'provider_switch' });
          }
        }
        // Opening a provider or choosing to wait is credited to a recent alert, if there is one.
        if (r?.ok && msg.name === 'provider_opened') recordAlertAction('switch_provider', msg.props?.provider, Date.now(), track).catch(() => {});
        if (r?.ok && msg.name === 'wait_chosen') recordAlertAction('wait', null, Date.now(), track).catch(() => {});
        reply(r ?? { ok: false });
      }).catch(() => reply({ ok: false }));
    return true;
  }

  if (msg.type === 'ANALYTICS_CLEAR' && fromExtension) {
    analytics.clear().then(() => lset(K_STALE_STATE, {})).then(() => reply({ ok: true })).catch(() => reply({ ok: false }));
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
    requestProviderRefresh('stats_read', sender.tab ? providerFromUrl(sender.tab.url) : null).catch(() => {});
    getStats()
      .then(s  => reply(s))
      .catch(() => reply(null));
    return true;
  }

  if (msg.type === 'REFRESH_NOW' && fromExtension) {
    const site = PROVIDER_SITES.includes(msg.site) ? msg.site : null;
    Promise.allSettled((site ? [site] : PROVIDER_SITES).map(provider => collectProvider(provider, 'manual')))
      .then(async () => { const stats = await getStats(); reply({ ok: true, providerHealth: stats.providerHealth }); })
      .catch(() => reply({ ok: false }));
    return true;
  }

  if (msg.type === 'SET_PLAN' && (fromExtension || fromAllowedSite)) {
    lset(K_PLAN, msg.plan)
      .then(() => { recordAlertAction('plan_action', null, Date.now(), track).catch(() => {}); reply({ ok: true }); })
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
    trackStaleTransitions();
    runAlerts();
    requestProviderRefresh('watchdog').catch(() => {});
  } else if (alarm.name === 'poll') {
    requestProviderRefresh('alarm').catch(err => console.warn(`${TAG} provider collection failed:`, err.message));
  } else if (alarm.name.startsWith('retry_')) {
    const site = alarm.name.slice('retry_'.length);
    if (PROVIDER_SITES.includes(site)) requestProviderRefresh('retry', site).catch(() => {});
  }
});

// ── Init ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.alarms.clear('heartbeat', () => chrome.alarms.create('heartbeat', { periodInMinutes: 1 }));
  chrome.alarms.clear('poll',      () => chrome.alarms.create('poll',      { periodInMinutes: POLL_INTERVAL_MIN }));
  chrome.action.setBadgeText({ text: '' });
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
    track('installed', {});
  }
  collectAllProviders('install').catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  collectAllProviders('startup').catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, tab => {
    const site = providerFromUrl(tab?.url);
    if (site) requestProviderRefresh('tab_activated', site).catch(() => {});
  });
});

chrome.tabs.onCreated.addListener(tab => {
  const site = providerFromUrl(tab?.url ?? tab?.pendingUrl);
  if (site) requestProviderRefresh('tab_created', site).catch(() => {});
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  const site = providerFromUrl(tab?.url);
  if (changeInfo.status === 'complete' && site) {
    requestProviderRefresh('navigation', site).catch(() => {});
  }
});

// A provider session cookie appearing again means sign-in succeeded: retry without waiting.
chrome.cookies.onChanged.addListener(({ removed, cookie }) => {
  if (removed) return;
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  const isHost = host => domain === host || domain.endsWith(`.${host}`);
  const site = isHost('claude.ai') ? 'claude'
    : isHost('chatgpt.com') || isHost('chat.openai.com') ? 'chatgpt'
    : isHost('gemini.google.com') ? 'gemini' : null;
  if (!site) return;
  getRefreshState(site).then(state => {
    if (state.category === 'auth_expired') requestProviderRefresh('auth_recovery', site).catch(() => {});
  }).catch(() => {});
});

// Service workers have no window, but they do receive connectivity events.
self.addEventListener('online', () => { requestProviderRefresh('network_restored').catch(() => {}); });

chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    requestProviderRefresh('focus').catch(() => {});
  }
});

chrome.idle.onStateChanged.addListener(state => {
  if (state === 'active') requestProviderRefresh('wake').catch(() => {});
});

ensureAlarms();
// The worker may have been suspended and restarted: re-check anything that is due.
requestProviderRefresh('worker_restart').catch(() => {});

console.log(`${TAG} service worker initialised`);

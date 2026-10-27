// Real-browser refresh soak: loads the real extension (claudewatch-extension/) into Chromium and drives it against a
// fixture "provider" served in place of https://chatgpt.com, with injected faults. Nothing talks to a real provider and
// no account or credential is involved. Runs in real time; faults are dense ("safe accelerated schedule"), the clock is not.
//
//   xvfb-run -a node scripts/soak/browser-soak.mjs   (SOAK_MINUTES, SOAK_TOTAL_MINUTES, SOAK_OFFSET_MINUTES, SOAK_SEED,
//                                                     SOAK_PROFILE, SOAK_OUT, SOAK_FAULT_EVERY_MIN)
//
// A long run is split into legs (GitHub Actions job limit is 6 h). Every leg regenerates the same seeded fault plan for the
// whole run and executes its own slice; a leg ends by closing the browser, and the next one reopens the same profile, which
// is itself a browser-restart test.
import { chromium } from 'playwright';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = path.join(root, 'claudewatch-extension');
const env = (k, d) => process.env[k] ?? d;
const MINUTES = Number(env('SOAK_MINUTES', '10'));
const TOTAL = Number(env('SOAK_TOTAL_MINUTES', String(MINUTES)));
const OFFSET = Number(env('SOAK_OFFSET_MINUTES', '0'));
const SEED = Number(env('SOAK_SEED', '20261024'));
const FAULT_EVERY = Number(env('SOAK_FAULT_EVERY_MIN', '12'));
const PROFILE = path.resolve(env('SOAK_PROFILE', path.join(root, '.soak-profile')));
const OUT = path.resolve(env('SOAK_OUT', path.join(root, 'soak-out')));
const SAMPLE_MS = Number(env('SOAK_SAMPLE_SECONDS', '30')) * 1000;
mkdirSync(OUT, { recursive: true });

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The fault plan for the whole run, in minutes from its start. Same seed, same plan, whichever leg reads it.
// Kinds are dealt from a shuffled deck, so every kind is injected before any repeats (a short run still covers them all).
export function buildPlan(total, every, seed) {
  const random = mulberry32(seed);
  const kinds = [
    ['offline', 5, 12], ['rate_limited', 6, 12], ['session_expired', 8, 15], ['tab_missing', 5, 12], ['schema_changed', 8, 12],
    ['worker_stopped', 0, 0], ['browser_restart', 0, 0],
  ];
  let deck = [];
  const next = () => {
    if (deck.length === 0) {
      deck = [...kinds];
      for (let i = deck.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    }
    return deck.pop();
  };
  const plan = [];
  let prevEnd = 0;
  for (let at = 3 + Math.floor(random() * every); at < total - Math.min(15, Math.floor(total / 4)); at += Math.max(3, Math.floor(every * (0.6 + random() * 0.8)))) {
    const [kind, min, max] = next();
    const start = Math.max(at, prevEnd + 1); // faults do not overlap, so each recovery is measured on its own
    const end = start + (max ? min + Math.floor(random() * (max - min)) : 0);
    plan.push({ kind, start, end });
    prevEnd = end;
    at = Math.max(at, end);
  }
  return plan;
}

const usageBody = (n) => ({
  email: 'soak@example.test', account_id: 'acct-soak', plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 10 + (n % 60), limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600 },
    secondary_window: { used_percent: 20 + (n % 30), limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 86400 },
  },
});

const mode = { fault: null }; // the provider's current behaviour
let served = 0;
async function routeProvider(route) {
  const url = new URL(route.request().url());
  const f = mode.fault;
  if (route.request().resourceType() === 'document' && url.pathname === '/') {
    // A signed-out page is still a page; the usage call is what fails.
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>fixture provider</title><p>fixture</p>' });
  }
  if (url.pathname === '/backend-api/wham/usage') {
    served += 1;
    if (f === 'rate_limited') return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"rate_limited"}' });
    if (f === 'session_expired') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
    if (f === 'schema_changed') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ unexpected: 'shape', nested: { windows: [] } }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(usageBody(served)) });
  }
  if (url.pathname === '/api/auth/session') {
    if (f === 'session_expired') return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accessToken: 'fixture-token', user: { email: 'soak@example.test' } }) });
  }
  return route.fulfill({ status: 204, body: '' });
}

let context = null;
let extensionId = null;
let probe = null; // an extension page used to read chrome.storage even while the service worker is asleep

async function launch() {
  context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    ...(process.env.SOAK_CHROME ? { executablePath: process.env.SOAK_CHROME } : {}),
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check'],
  });
  await context.route('https://chatgpt.com/**', routeProvider);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = new URL(sw.url()).host;
  probe = await context.newPage();
  await probe.goto(`chrome-extension://${extensionId}/privacy/privacy.html`);
  await openProviderTab();
  // The install flow opens an onboarding tab; it is not part of the test.
  for (const p of context.pages()) if (p.url().includes('onboarding')) await p.close().catch(() => {});
}

async function openProviderTab() {
  const page = await context.newPage();
  await page.goto('https://chatgpt.com/');
  return page;
}

const providerTabs = () => context.pages().filter((p) => p.url().startsWith('https://chatgpt.com/'));

const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))]);

async function readState() {
  return within(probe.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['refresh_state_chatgpt'], (v) => resolve(v.refresh_state_chatgpt ?? null)))), 15_000, 'reading refresh state');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plan = buildPlan(TOTAL, FAULT_EVERY, SEED);
const events = [];
const log = (event) => { const line = { at: new Date().toISOString(), minute: Math.round((Date.now() - startedAt) / 6000) / 10 + OFFSET, ...event }; events.push(line); appendFileSync(path.join(OUT, 'events.jsonl'), JSON.stringify(line) + '\n'); console.log(JSON.stringify(line)); };

async function apply(step) {
  log({ type: 'fault_start', kind: step.kind });
  if (step.kind === 'offline') { await context.setOffline(true); mode.fault = 'offline'; }
  else if (step.kind === 'tab_missing') { for (const p of providerTabs()) await p.close().catch(() => {}); mode.fault = 'tab_missing'; }
  else if (step.kind === 'worker_stopped') {
    const cdp = await context.newCDPSession(probe);
    await cdp.send('ServiceWorker.enable').catch(() => {});
    await cdp.send('ServiceWorker.stopAllWorkers').catch(() => {});
    mode.fault = null; // a stopped worker is woken by the next alarm or event; nothing else is broken
  } else if (step.kind === 'browser_restart') {
    await context.close();
    await launch();
    mode.fault = null;
  } else mode.fault = step.kind;
}

async function clear(step) {
  if (step.kind === 'worker_stopped' || step.kind === 'browser_restart') return;
  log({ type: 'fault_end', kind: step.kind });
  if (step.kind === 'offline') await context.setOffline(false);
  if (step.kind === 'tab_missing' || step.kind === 'session_expired') {
    mode.fault = null;
    if (providerTabs().length === 0) await openProviderTab(); // opening a tab / signing in is what recovers these
    else await providerTabs()[0].reload().catch(() => {});
    return;
  }
  mode.fault = null;
}

const startedAt = Date.now();
const policySrc = readFileSync(path.join(EXT, 'refresh-policy.js'), 'utf8');
globalThis.self = globalThis.self ?? globalThis;
new Function('self', policySrc)(globalThis.self);
const policy = globalThis.self.TokenWatcherRefresh;

if (OFFSET > 0 && !existsSync(PROFILE)) console.log(JSON.stringify({ type: 'profile_missing', note: 'the previous leg left no browser profile; starting a fresh one' }));
await launch();
log({ type: 'leg_start', offsetMinutes: OFFSET, legMinutes: MINUTES, totalMinutes: TOTAL, plan: plan.length, extensionId });

const mySteps = plan.filter((p) => p.start >= OFFSET && p.start < OFFSET + MINUTES);
const active = [];
let lastSample = 0;
let prevAttempt = null;
let prevSuccess = null;
const sampleFile = path.join(OUT, 'samples.jsonl');

while (Date.now() - startedAt < MINUTES * 60_000) {
  const minute = (Date.now() - startedAt) / 60_000 + OFFSET;
  for (const step of mySteps) {
    if (!step.started && minute >= step.start) { step.started = true; await apply(step); active.push(step); }
  }
  for (const step of [...active]) {
    if (minute >= step.end) { active.splice(active.indexOf(step), 1); await clear(step); }
  }
  if (Date.now() - lastSample >= SAMPLE_MS) {
    lastSample = Date.now();
    let state = null;
    let readError = null;
    try { state = await readState(); } catch (e) { readError = String(e.message ?? e).slice(0, 120); try { probe = await context.newPage(); await probe.goto(`chrome-extension://${extensionId}/privacy/privacy.html`); } catch { /* retried next sample */ } }
    const now = Date.now();
    const info = state ? policy.staleInfo(state, now) : null;
    const attemptChanged = state && state.lastAttemptAt !== prevAttempt;
    const successChanged = state && state.lastSuccessAt !== prevSuccess;
    prevAttempt = state?.lastAttemptAt ?? prevAttempt;
    prevSuccess = state?.lastSuccessAt ?? prevSuccess;
    const row = {
      t: now, minute: Math.round(minute * 10) / 10, fault: active.map((a) => a.kind), state, readError,
      stale: info?.stale ?? null, staleCode: info?.code ?? null, explained: info?.explained ?? null, ageMs: info?.ageMs ?? null, attemptChanged, successChanged,
    };
    appendFileSync(sampleFile, JSON.stringify(row) + '\n');
    console.log(`sample minute=${row.minute} fault=[${row.fault}] stale=${row.stale} code=${row.staleCode} ageSec=${row.ageMs == null ? 'n/a' : Math.round(row.ageMs / 1000)} trigger=${state?.lastTrigger ?? 'n/a'} failures=${state?.failures ?? 'n/a'}${readError ? ` readError=${readError}` : ''}`);
  }
  await sleep(1000);
}

for (const step of active) await clear(step);
log({ type: 'leg_end', providerRequestsServed: served });
await context.close();
writeFileSync(path.join(OUT, 'leg.json'), JSON.stringify({ offsetMinutes: OFFSET, legMinutes: MINUTES, totalMinutes: TOTAL, seed: SEED, plan, executed: mySteps.filter((s) => s.started).length, providerRequestsServed: served }, null, 2));

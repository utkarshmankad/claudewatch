import { beforeEach, describe, expect, it } from 'vitest';
import { candidateAlerts, decideAlert, recordShown, parseAlertPrefs, thresholdCandidates, inQuietHours, DEFAULT_ALERT_PREFS, DEDUPE_MS } from '../autopilot/alerts.mjs';
import { assignArm, attributeAction, closeExpired, resolveForecasts, buildReport, newEntry, appendHistory, setFeedback, MAX_HISTORY, ATTRIBUTION_WINDOW_MS, FORECAST_HORIZON_MS } from '../autopilot/experiment.mjs';
import { evaluateAlerts, recordAlertAction, recordAlertFeedback, recordNotificationsDisabled, loadReport } from '../autopilot/alert-runner.mjs';
import { clearAlertData, EXPERIMENT_KEY } from '../autopilot/alert-store.mjs';
import { alertText } from '../autopilot/messages.mjs';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const t = (key, subs, fallback) => `${fallback}`;
const prefs = (o = {}) => parseAlertPrefs(o);

describe('parseAlertPrefs', () => {
  it('falls back to defaults and clamps the cooldown', () => {
    expect(parseAlertPrefs(null)).toEqual({ ...DEFAULT_ALERT_PREFS, mutedProviders: [] });
    expect(parseAlertPrefs({ cooldownMinutes: 1 }).cooldownMinutes).toBe(15);
    expect(parseAlertPrefs({ cooldownMinutes: 99999 }).cooldownMinutes).toBe(720);
    expect(parseAlertPrefs({ mutedProviders: ['claude', 'x', 'claude'], quietHours: { startHour: 3, endHour: 3, utcOffsetMinutes: 0 } }))
      .toMatchObject({ mutedProviders: ['claude'], quietHours: null });
  });
});

const snap = (o = {}) => ({ at: NOW, action: 'use', provider: 'claude', confidence: 'medium', status: {}, prefsKey: 'k', ...o });
const rec = (o = {}) => ({ action: 'use', provider: 'claude', warnings: [], ...o });
const input = (provider, forecasts = []) => ({ provider, forecasts });

describe('candidateAlerts', () => {
  it('fires action_changed only when action or provider changes and the data is trustworthy', () => {
    const prev = snap();
    expect(candidateAlerts({ prev, next: snap(), rec: rec(), inputs: [] })).toEqual([]);
    const changed = candidateAlerts({ prev, next: snap({ provider: 'chatgpt' }), rec: rec({ provider: 'chatgpt' }), inputs: [], explain: { key: 'limit_reached', provider: 'claude' } });
    expect(changed).toMatchObject([{ kind: 'action_changed', provider: 'chatgpt', cause: { key: 'limit_reached' } }]);
    expect(candidateAlerts({ prev, next: snap({ provider: 'chatgpt' }), rec: rec({ provider: 'chatgpt', warnings: ['stale_data'] }), inputs: [] })).toEqual([]);
    expect(candidateAlerts({ prev: null, next: snap(), rec: rec(), inputs: [] })).toEqual([]);
    expect(candidateAlerts({ prev, next: snap({ action: 'none', provider: null }), rec: rec({ action: 'none', provider: null }), inputs: [] })).toEqual([]);
  });

  it('flags block_likely from the recommended provider forecast warnings', () => {
    const c = candidateAlerts({ prev: snap(), next: snap(), rec: rec({ warnings: ['high_exhaustion_risk'] }), inputs: [] });
    expect(c.map((x) => x.kind)).toEqual(['block_likely']);
    expect(candidateAlerts({ prev: snap(), next: snap(), rec: rec({ warnings: ['limit_expected_soon', 'no_history'] }), inputs: [] })).toEqual([]);
  });

  it('flags a reset that is minutes away for a limited provider that is not the recommendation', () => {
    const limited = (resetAt) => input('gemini', [{ window: 'five_hour', state: 'limited', resetAt, usedPercent: 100 }]);
    expect(candidateAlerts({ prev: snap(), next: snap(), rec: rec(), inputs: [limited(NOW + 10 * 60_000)] }).map((x) => x.kind)).toEqual(['reset_approaching']);
    expect(candidateAlerts({ prev: snap(), next: snap(), rec: rec(), inputs: [limited(NOW + 2 * HOUR)] })).toEqual([]);
    expect(candidateAlerts({ prev: snap(), next: snap(), rec: rec({ provider: 'gemini' }), inputs: [limited(NOW + 10 * 60_000)] })).toEqual([]);
    // A second window that stays limited for hours means the reset does not free the provider.
    const both = input('gemini', [{ window: 'five_hour', state: 'limited', resetAt: NOW + 5 * 60_000 }, { window: 'weekly', state: 'limited', resetAt: NOW + 30 * HOUR }]);
    expect(candidateAlerts({ prev: snap(), next: snap(), rec: rec(), inputs: [both] })).toEqual([]);
  });

  it('suggests a plan review only for a confident, nearly spent weekly window with days left', () => {
    const wk = (o) => input('claude', [{ window: 'weekly', state: 'ok', confidence: 'medium', usedPercent: 93, hoursToReset: 100, ...o }]);
    expect(candidateAlerts({ prev: snap(), next: snap(), rec: rec(), inputs: [wk({})] }).map((x) => x.kind)).toEqual(['plan_review']);
    for (const o of [{ usedPercent: 80 }, { hoursToReset: 10 }, { confidence: 'low' }, { state: 'stale' }]) {
      expect(candidateAlerts({ prev: snap(), next: snap(), rec: rec(), inputs: [wk(o)] })).toEqual([]);
    }
  });
});

describe('decideAlert', () => {
  const cand = (o = {}) => ({ kind: 'action_changed', provider: 'chatgpt', action: 'use', cause: null, ...o });
  const run = (o = {}) => decideAlert({ candidates: [cand()], frequency: 'important', alertPrefs: prefs(), state: {}, now: NOW, ...o });

  it('respects the notification frequency', () => {
    expect(run({ frequency: 'off' })).toEqual({ alert: null, suppressed: 'frequency_off' });
    expect(run({ candidates: [cand({ kind: 'plan_review' })] })).toEqual({ alert: null, suppressed: 'frequency' });
    expect(run({ candidates: [cand({ kind: 'plan_review' })], frequency: 'all' }).alert).toMatchObject({ kind: 'plan_review', level: 'warn' });
    expect(run().alert).toMatchObject({ kind: 'action_changed', key: 'action_changed:chatgpt:use' });
    expect(run({ candidates: [cand({ kind: 'block_likely' })] }).alert.level).toBe('high');
  });

  it('skips muted providers and quiet hours', () => {
    expect(run({ alertPrefs: prefs({ mutedProviders: ['chatgpt'] }) })).toEqual({ alert: null, suppressed: 'muted' });
    const quiet = { startHour: 11, endHour: 13, utcOffsetMinutes: 0 };
    expect(run({ alertPrefs: prefs({ quietHours: quiet }) })).toEqual({ alert: null, suppressed: 'quiet_hours' });
    expect(inQuietHours(NOW, { startHour: 22, endHour: 7, utcOffsetMinutes: 0 })).toBe(false);
    expect(inQuietHours(NOW, null)).toBe(false);
    expect(run({ alertPrefs: prefs({ quietHours: { startHour: 22, endHour: 7, utcOffsetMinutes: 0 } }) }).alert).not.toBeNull();
  });

  it('drops an identical alert for six hours and a similar one for the cooldown', () => {
    const first = run().alert;
    const state = recordShown({}, first, NOW);
    expect(run({ state, now: NOW + 5 * HOUR })).toEqual({ alert: null, suppressed: 'duplicate' });
    expect(run({ state, now: NOW + DEDUPE_MS }).alert).not.toBeNull();
    // Same kind and provider, different action: not a duplicate, but still inside the cooldown.
    const other = [cand({ action: 'wait' })];
    expect(run({ state, candidates: other, now: NOW + 30 * 60_000 })).toEqual({ alert: null, suppressed: 'cooldown' });
    expect(run({ state, candidates: other, now: NOW + 61 * 60_000 }).alert).not.toBeNull();
    expect(run({ state, candidates: other, alertPrefs: prefs({ cooldownMinutes: 15 }), now: NOW + 16 * 60_000 }).alert).not.toBeNull();
  });

  it('falls through to the next candidate when the first is suppressed', () => {
    const state = recordShown({}, run().alert, NOW);
    const r = run({ state, now: NOW + HOUR, candidates: [cand(), cand({ kind: 'block_likely' })] });
    expect(r.alert.kind).toBe('block_likely');
    expect(r.suppressed).toBe('duplicate');
  });

  it('keeps plan_review to one a day and prunes old dedupe entries', () => {
    const c = [cand({ kind: 'plan_review' })];
    const state = recordShown({}, run({ candidates: c, frequency: 'all' }).alert, NOW);
    expect(run({ candidates: c, frequency: 'all', state, now: NOW + 7 * HOUR }).suppressed).toBe('cooldown');
    const later = recordShown(state, { key: 'x', kind: 'block_likely', provider: 'gemini' }, NOW + 25 * HOUR);
    expect(Object.keys(later.lastShown)).toEqual(['x']);
  });
});

describe('thresholdCandidates (experiment control arm)', () => {
  it('fires once per window and reset', () => {
    const inputs = [input('claude', [{ window: 'five_hour', usedPercent: 85, resetAt: NOW + HOUR }])];
    const [c] = thresholdCandidates(inputs, {}, NOW);
    expect(c).toMatchObject({ kind: 'threshold', provider: 'claude', level: 'high' });
    expect(thresholdCandidates(inputs, { thresholdFired: { [c.windowKey]: NOW } }, NOW)).toEqual([]);
    expect(thresholdCandidates([input('claude', [{ window: 'five_hour', usedPercent: 40, resetAt: NOW }])], {}, NOW)).toEqual([]);
    expect(thresholdCandidates([input('claude', [{ window: 'weekly', usedPercent: 97, resetAt: null }])], {}, NOW)[0].level).toBe('critical');
  });
});

describe('experiment', () => {
  const entry = (o = {}) => ({ ...newEntry({ id: `${o.ts ?? NOW}`, now: NOW, alert: { kind: 'action_changed', provider: 'chatgpt', level: 'warn' }, arm: 'autopilot' }), ...o });

  it('assigns once and keeps the assignment', () => {
    const a = assignArm(null, NOW, () => 0.1);
    expect(a).toEqual({ arm: 'threshold', assignedAt: NOW });
    expect(assignArm(a, NOW + 1, () => 0.9)).toBe(a);
    expect(assignArm(null, NOW, () => 0.9).arm).toBe('autopilot');
    expect(assignArm({ arm: 'bogus' }, NOW, () => 0.9).arm).toBe('autopilot');
  });

  it('credits an action to the latest open alert inside the window only', () => {
    const h = [entry({ ts: NOW - 2 * HOUR, id: 'old' }), entry({ ts: NOW - 10 * 60_000, id: 'new' })];
    const r = attributeAction(h, 'switch_provider', 'chatgpt', NOW);
    expect(r.entry.id).toBe('new');
    expect(r.history[1]).toMatchObject({ outcome: 'switch_provider', actedAt: NOW });
    expect(attributeAction(r.history, 'wait', null, NOW).entry).toBeNull(); // already acted on
    expect(attributeAction([entry({ ts: NOW - ATTRIBUTION_WINDOW_MS - 1 })], 'wait', null, NOW).entry).toBeNull();
    expect(attributeAction(h, 'teleport', null, NOW).entry).toBeNull();
    const block = [entry({ kind: 'block_likely', provider: 'claude', ts: NOW - 60_000 })];
    expect(attributeAction(block, 'switch_provider', 'gemini', NOW).entry).toBeNull(); // opened an unrelated provider
    expect(attributeAction(block, 'switch_provider', 'claude', NOW).entry).not.toBeNull();
  });

  it('closes expired alerts as ignored and bounds the history', () => {
    expect(closeExpired([entry({ ts: NOW - 2 * HOUR })], NOW)[0].outcome).toBe('ignored');
    expect(closeExpired([entry({ ts: NOW - 60_000 })], NOW)[0].outcome).toBe('pending');
    let h = [];
    for (let i = 0; i < MAX_HISTORY + 5; i++) h = appendHistory(h, entry({ id: String(i) }));
    expect(h).toHaveLength(MAX_HISTORY);
    expect(h[0].id).toBe('5');
  });

  it('judges block_likely forecasts against what the provider did afterwards', () => {
    const e = entry({ kind: 'block_likely', provider: 'claude', ts: NOW - FORECAST_HORIZON_MS - 1 });
    expect(resolveForecasts([e], { claude: NOW - HOUR }, NOW)[0].limitReached).toBe(true);
    expect(resolveForecasts([e], { claude: e.ts - 1 }, NOW)[0].limitReached).toBe(false);
    expect(resolveForecasts([e], {}, NOW)[0].limitReached).toBe(false);
    expect(resolveForecasts([{ ...e, ts: NOW - HOUR }], {}, NOW)[0].limitReached).toBeNull(); // horizon not over yet
    expect(resolveForecasts([entry({ ts: NOW - 20 * HOUR })], {}, NOW)[0].limitReached).toBeNull(); // not a forecast alert
  });

  it('reports rates per arm with null instead of a fake zero when there is nothing to divide', () => {
    expect(buildReport([], {}).arms.autopilot).toMatchObject({ shown: 0, actionRatePercent: null, forecastErrorPercent: null });
    const h = [
      entry({ outcome: 'switch_provider' }), entry({ outcome: 'wait' }), entry({ outcome: 'dismiss', feedback: 'false_positive' }), entry({ outcome: 'ignored' }),
      entry({ arm: 'threshold', kind: 'threshold', outcome: 'ignored' }),
      entry({ kind: 'block_likely', outcome: 'ignored', limitReached: false }), entry({ kind: 'block_likely', outcome: 'ignored', limitReached: true }),
    ];
    const r = buildReport(h, { threshold: 2 });
    expect(r.arms.autopilot).toMatchObject({ shown: 6, acted: 2, actionRatePercent: 33.3, dismissed: 1, falsePositiveFeedback: 1, forecastErrorPercent: 50, forecastsJudged: 2, notificationDisables: 0 });
    expect(r.arms.threshold).toMatchObject({ shown: 1, acted: 0, actionRatePercent: 0, notificationDisables: 2 });
    expect(setFeedback(h, h[0].id, 'bogus')).toBe(h);
  });
});

describe('alertText', () => {
  it('produces a title and body for every kind without user data', () => {
    for (const kind of ['action_changed', 'block_likely', 'reset_approaching', 'plan_review', 'threshold']) {
      const { title, message } = alertText(t, { kind, action: 'use', cause: { key: 'reset', provider: 'claude' } }, 'Claude');
      expect(title.length, kind).toBeGreaterThan(0);
      expect(message.length, kind).toBeGreaterThan(0);
    }
    expect(alertText(t, { kind: 'action_changed', action: 'wait', cause: null }, '').title).toMatch(/wait/i);
    expect(alertText(t, { kind: 'nope' }, '').title).toBe('Autopilot');
  });
});

// ── runner, against an in-memory chrome.storage ──
function installChrome() {
  const areas = { sync: {}, local: {} };
  const area = (name) => ({
    get: (key, cb) => cb(typeof key === 'string' ? (key in areas[name] ? { [key]: areas[name][key] } : {}) : {}),
    set: (obj, cb) => { Object.assign(areas[name], structuredClone(obj)); cb?.(); },
    remove: (keys, cb) => { for (const k of [].concat(keys)) delete areas[name][k]; cb?.(); },
  });
  globalThis.chrome = { storage: { sync: area('sync'), local: area('local') }, runtime: {} };
  return areas;
}

const snapshot = (pct5h, extra = {}) => ({ ts: NOW - 60_000, accountId: 'a', pct5h, pct7d: 10, resetsAt5h: NOW + 3 * HOUR, resetsAt7d: NOW + 3 * 24 * HOUR, ...extra });
const fresh = { ok: true, stale: false, hasData: true };
const stats = (usage) => ({ providerUsage: usage, providerHealth: Object.fromEntries(Object.keys(usage).map((k) => [k, fresh])), usageHistory: [] });

describe('evaluateAlerts', () => {
  let areas; let shown; let events;
  const run = (usage, at = NOW, extra = {}) => evaluateAlerts({ stats: stats(usage), now: at, notify: async (n) => { shown.push(n); }, track: (n, p) => events.push([n, p]), t, ...extra });
  beforeEach(() => { areas = installChrome(); shown = []; events = []; });

  it('stays quiet on first run, then alerts once when the recommendation changes', async () => {
    expect((await run({ claude: snapshot(20), chatgpt: snapshot(60) })).reason).toBe('none_due');
    const r = await run({ claude: snapshot(100), chatgpt: snapshot(60) }, NOW + 10 * 60_000);
    expect(r.reason).toBe('shown');
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ provider: 'chatgpt' });
    expect(events).toContainEqual(['autopilot_alert_shown', { kind: 'action_changed', arm: 'autopilot' }]);
    // The same situation on the next poll is not announced again.
    expect((await run({ claude: snapshot(100), chatgpt: snapshot(60) }, NOW + 15 * 60_000)).alert).toBeNull();
    expect(shown).toHaveLength(1);
    const { history } = await loadReport();
    expect(history).toHaveLength(1);
    expect(JSON.stringify(areas.local)).not.toMatch(/accountId|"a"/);
  });

  it('shows nothing when notifications are off, Autopilot is disabled, or nothing has been read', async () => {
    areas.sync.autopilotPrefs = { notificationFrequency: 'off' };
    await run({ claude: snapshot(20), chatgpt: snapshot(60) });
    expect((await run({ claude: snapshot(100), chatgpt: snapshot(60) }, NOW + HOUR)).reason).toBe('frequency_off');
    areas.sync.autopilotPrefs = { disabled: true };
    expect((await run({ claude: snapshot(100) }, NOW + 2 * HOUR)).reason).toBe('disabled');
    areas.sync.autopilotPrefs = {};
    expect((await run({}, NOW + 3 * HOUR)).reason).toBe('no_readings');
    expect(shown).toHaveLength(0);
  });

  it('counts suppressed alerts by reason', async () => {
    areas.sync.autopilotAlertPrefs = { mutedProviders: ['chatgpt'] };
    await run({ claude: snapshot(20), chatgpt: snapshot(60) });
    expect((await run({ claude: snapshot(100), chatgpt: snapshot(60) }, NOW + HOUR)).reason).toBe('muted');
    expect(areas.local.autopilot_alert_state.suppressed).toEqual({ muted: 1 });
  });

  it('runs the threshold alert for users assigned to the control arm, once per window', async () => {
    areas.sync.autopilotAlertPrefs = { experimentOptIn: true };
    expect((await run({ claude: snapshot(85) }, NOW, { rand: () => 0.1 })).reason).toBe('shown');
    expect(events).toContainEqual(['experiment_assigned', { arm: 'threshold' }]);
    expect(shown).toHaveLength(1);
    expect((await run({ claude: snapshot(90) }, NOW + 5 * 60_000, { rand: () => 0.9 })).alert).toBeNull(); // arm is sticky
    expect((await loadReport()).arm).toBe('threshold');
  });

  it('attributes actions, takes feedback and counts disables for the report', async () => {
    areas.sync.autopilotAlertPrefs = { experimentOptIn: true };
    await run({ claude: snapshot(20), chatgpt: snapshot(60) }, NOW, { rand: () => 0.9 });
    await run({ claude: snapshot(100), chatgpt: snapshot(60) }, NOW + 60_000, { rand: () => 0.9 });
    expect(await recordAlertAction('switch_provider', 'chatgpt', NOW + 120_000, (n, p) => events.push([n, p]))).toBe(true);
    expect(await recordAlertAction('wait', null, NOW + 130_000)).toBe(false);
    const { history } = await loadReport();
    expect(await recordAlertFeedback(history[0].id, 'useful', (n, p) => events.push([n, p]))).toBe(true);
    expect(await recordAlertFeedback('missing', 'useful')).toBe(false);
    await recordNotificationsDisabled();
    const { report } = await loadReport();
    expect(report.arms.autopilot).toMatchObject({ shown: 1, acted: 1, actionRatePercent: 100, notificationDisables: 1 });
    expect(events).toContainEqual(['autopilot_alert_action', { action: 'switch_provider', kind: 'action_changed' }]);
    expect(events).toContainEqual(['alert_feedback', { verdict: 'useful' }]);
  });

  it('removes all alert data on request', async () => {
    await run({ claude: snapshot(20), chatgpt: snapshot(60) });
    await run({ claude: snapshot(100), chatgpt: snapshot(60) }, NOW + HOUR);
    await clearAlertData();
    expect(Object.keys(areas.local)).toEqual([]);
    expect((await loadReport()).report.arms.autopilot.shown).toBe(0);
    expect(EXPERIMENT_KEY).toBe('autopilot_experiment');
  });
});

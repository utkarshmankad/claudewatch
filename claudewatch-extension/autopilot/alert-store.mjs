// Storage for Autopilot alerts. Alert settings follow the browser (sync); state, history and the experiment
// stay on this device (local). Values are enums, provider ids and timestamps: no content or identifiers.
import { parseAlertPrefs } from './alerts.mjs';

export const ALERT_PREFS_KEY = 'autopilotAlertPrefs';
export const ALERT_STATE_KEY = 'autopilot_alert_state';
export const ALERT_HISTORY_KEY = 'autopilot_alert_history';
export const EXPERIMENT_KEY = 'autopilot_experiment';

const call = (area, method, arg) => new Promise((resolve) => {
  try { chrome.storage[area][method](arg, (v) => { void chrome.runtime?.lastError; resolve(v); }); } catch { resolve(undefined); }
});
const getLocal = async (key) => (await call('local', 'get', key))?.[key] ?? null;
const setLocal = (key, value) => call('local', 'set', { [key]: value });

export async function loadAlertPrefs() {
  return parseAlertPrefs((await call('sync', 'get', ALERT_PREFS_KEY))?.[ALERT_PREFS_KEY]);
}
export async function saveAlertPrefs(prefs) {
  const clean = parseAlertPrefs(prefs);
  await call('sync', 'set', { [ALERT_PREFS_KEY]: clean });
  return clean;
}

export const loadAlertState = async () => (await getLocal(ALERT_STATE_KEY)) ?? { lastShown: {}, lastByKind: {}, thresholdFired: {}, limitSeen: {}, prev: null, suppressed: {} };
export const saveAlertState = (s) => setLocal(ALERT_STATE_KEY, s);
export const loadHistory = async () => (await getLocal(ALERT_HISTORY_KEY)) ?? [];
export const saveHistory = (h) => setLocal(ALERT_HISTORY_KEY, h);
export const loadExperiment = async () => (await getLocal(EXPERIMENT_KEY)) ?? { assignment: null, disables: {} };
export const saveExperiment = (e) => setLocal(EXPERIMENT_KEY, e);

// Removes every local trace of alerts and the experiment (history, state, assignment, counters).
export async function clearAlertData() {
  await call('local', 'remove', [ALERT_STATE_KEY, ALERT_HISTORY_KEY, EXPERIMENT_KEY]);
}

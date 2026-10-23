// Persistence for Autopilot: preferences in chrome.storage.sync (follow the user's browser),
// the last recommendation summary in chrome.storage.local (per device). Both hold settings and
// provider names only; no prompts, conversation content or account identifiers.
import { parsePreferences } from './policy.mjs';

export const PREFS_KEY = 'autopilotPrefs';
export const LAST_KEY = 'autopilot_last';
export const DISMISS_KEY = 'autopilot_dismissed';
export const IMPRESSION_KEY = 'autopilot_impression';
export const IMPRESSION_TTL_MS = 6 * 3_600_000;

const call = (area, method, arg) => new Promise((resolve) => {
  try { chrome.storage[area][method](arg, (v) => { void chrome.runtime?.lastError; resolve(v); }); } catch { resolve(undefined); }
});

export async function loadPrefs() {
  const v = await call('sync', 'get', PREFS_KEY);
  return parsePreferences(v?.[PREFS_KEY]);
}

export async function savePrefs(prefs) {
  const clean = parsePreferences(prefs);
  await call('sync', 'set', { [PREFS_KEY]: clean });
  return clean;
}

export async function loadLocal(key) {
  const v = await call('local', 'get', key);
  return v?.[key] ?? null;
}

export const saveLocal = (key, value) => call('local', 'set', { [key]: value });

// A recommendation is identified by action, provider and confidence only.
export const recKey = (rec) => `${rec.action}:${rec.provider ?? '-'}:${rec.confidence}`;

// True when this recommendation has not been counted as an impression in the last six hours.
export function shouldRecordImpression(last, key, now) {
  return !(last && last.key === key && now - last.at < IMPRESSION_TTL_MS);
}

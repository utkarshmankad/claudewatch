// Autopilot controls on the settings page. Each change is saved immediately to chrome.storage.sync
// (see autopilot/store.mjs) and reported as an enum-only analytics event naming the setting, never its value.
import { loadPrefs, savePrefs } from '../autopilot/store.mjs';
import { PROVIDERS, TASK_PROFILES, NOTIFICATION_FREQUENCIES } from '../autopilot/policy.mjs';
import { PROVIDER_NAMES } from '../autopilot/view-model.mjs';
import { taskText, frequencyText } from '../autopilot/messages.mjs';

const t = (key, subs, fallback) => (window.TokenWatcherI18n ? window.TokenWatcherI18n.t(key, subs, fallback) : fallback);
const $ = (id) => document.getElementById(id);
const track = (name, props) => chrome.runtime.sendMessage({ type: 'ANALYTICS_AUTOPILOT', name, props }, () => void chrome.runtime.lastError);

let prefs = null;
let savedTimer = null;

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function fill() {
  $('ap-task').replaceChildren(...TASK_PROFILES.map((v) => option(v, taskText(t, v))));
  $('ap-notify').replaceChildren(...NOTIFICATION_FREQUENCIES.map((v) => option(v, frequencyText(t, v))));
  $('ap-pinned').replaceChildren(option('', t('apPinnedNone', undefined, 'No preference')), ...PROVIDERS.map((p) => option(p, PROVIDER_NAMES[p])));
  const box = $('ap-exclude');
  for (const p of PROVIDERS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = p;
    input.id = `ap-ex-${p}`;
    label.append(input, document.createTextNode(PROVIDER_NAMES[p]));
    box.appendChild(label);
  }
}

function show() {
  $('ap-enabled').checked = !prefs.disabled;
  $('ap-task').value = prefs.task;
  $('ap-reserved').value = String(Math.round(prefs.reservedPercent));
  const wh = prefs.workingHours;
  $('ap-hours-on').checked = Boolean(wh);
  $('ap-hours-start').value = String(wh?.startHour ?? 9);
  $('ap-hours-end').value = String(wh?.endHour ?? 17);
  for (const id of ['ap-hours-start', 'ap-hours-end']) $(id).disabled = !wh;
  $('ap-notify').value = prefs.notificationFrequency;
  $('ap-pinned').value = prefs.pinned ?? '';
  for (const p of PROVIDERS) $(`ap-ex-${p}`).checked = prefs.excluded.includes(p);
  // An excluded provider cannot also be preferred (exclusion wins), so make that visible.
  for (const o of $('ap-pinned').options) o.disabled = Boolean(o.value) && prefs.excluded.includes(o.value);
}

async function change(setting, patch) {
  prefs = await savePrefs({ ...prefs, ...patch });
  show();
  track(setting === 'enabled' ? 'autopilot_toggled' : 'preference_changed', setting === 'enabled' ? { enabled: !prefs.disabled } : { setting });
  const note = $('ap-saved');
  note.textContent = t('apSetSaved', undefined, 'Saved ✓');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { note.textContent = ''; }, 2500);
}

const hour = (id, lo, hi, fallback) => {
  const n = Number.parseInt($(id).value, 10);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};

function workingHours() {
  const startHour = hour('ap-hours-start', 0, 23, 9);
  let endHour = hour('ap-hours-end', 0, 24, 17);
  if (endHour === startHour) endHour = (startHour + 1) % 24 || 24; // start and end must differ
  return { startHour, endHour, utcOffsetMinutes: -new Date().getTimezoneOffset() };
}

document.addEventListener('DOMContentLoaded', async () => {
  fill();
  prefs = await loadPrefs();
  show();
  $('ap-enabled').addEventListener('change', (e) => change('enabled', { disabled: !e.target.checked }));
  $('ap-task').addEventListener('change', (e) => change('task', { task: e.target.value }));
  $('ap-reserved').addEventListener('change', (e) => {
    const n = Number.parseFloat(e.target.value);
    change('reserved', { reservedPercent: Number.isFinite(n) ? Math.min(90, Math.max(0, n)) : 0 });
  });
  $('ap-hours-on').addEventListener('change', (e) => change('working_hours', { workingHours: e.target.checked ? workingHours() : null }));
  for (const id of ['ap-hours-start', 'ap-hours-end']) $(id).addEventListener('change', () => change('working_hours', { workingHours: workingHours() }));
  $('ap-notify').addEventListener('change', (e) => change('notification_frequency', { notificationFrequency: e.target.value }));
  $('ap-pinned').addEventListener('change', (e) => change('pinned', { pinned: e.target.value || null }));
  $('ap-exclude').addEventListener('change', () => change('excluded', { excluded: PROVIDERS.filter((p) => $(`ap-ex-${p}`).checked) }));
});

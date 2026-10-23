// Autopilot alert controls, notification history and the local experiment report on the settings page.
// Settings save immediately (chrome.storage.sync); history and experiment data are device-local.
import { loadAlertPrefs, saveAlertPrefs, clearAlertData } from '../autopilot/alert-store.mjs';
import { loadReport, recordAlertFeedback, recordNotificationsDisabled } from '../autopilot/alert-runner.mjs';
import { PROVIDERS } from '../autopilot/policy.mjs';
import { PROVIDER_NAMES } from '../autopilot/view-model.mjs';

const t = (key, subs, fallback) => (window.TokenWatcherI18n ? window.TokenWatcherI18n.t(key, subs, fallback) : fallback);
const $ = (id) => document.getElementById(id);
const track = (name, props) => chrome.runtime.sendMessage({ type: 'ANALYTICS_AUTOPILOT', name, props }, () => void chrome.runtime.lastError);

let prefs = null;
let savedTimer = null;

function flash(text) {
  $('al-saved').textContent = text;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('al-saved').textContent = ''; }, 2500);
}

function show() {
  const q = prefs.quietHours;
  $('al-quiet-on').checked = Boolean(q);
  $('al-quiet-start').value = String(q?.startHour ?? 22);
  $('al-quiet-end').value = String(q?.endHour ?? 7);
  for (const id of ['al-quiet-start', 'al-quiet-end']) $(id).disabled = !q;
  $('al-cooldown').value = String(prefs.cooldownMinutes);
  for (const p of PROVIDERS) $(`al-mute-${p}`).checked = prefs.mutedProviders.includes(p);
  $('al-experiment').checked = prefs.experimentOptIn;
}

async function change(patch) {
  prefs = await saveAlertPrefs({ ...prefs, ...patch });
  show();
  flash(t('alSaved', undefined, 'Saved ✓'));
  await renderReport();
}

const hour = (id, lo, hi, fallback) => {
  const n = Number.parseInt($(id).value, 10);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};
function quietHours() {
  const startHour = hour('al-quiet-start', 0, 23, 22);
  let endHour = hour('al-quiet-end', 0, 24, 7);
  if (endHour === startHour) endHour = (startHour + 1) % 24 || 24;
  return { startHour, endHour, utcOffsetMinutes: -new Date().getTimezoneOffset() };
}

const outcomeText = (o) => ({
  pending: () => t('alOutcome_pending', undefined, 'Waiting for your action'),
  ignored: () => t('alOutcome_ignored', undefined, 'No action'),
  switch_provider: () => t('alOutcome_switch_provider', undefined, 'You switched provider'),
  wait: () => t('alOutcome_wait', undefined, 'You chose to wait'),
  plan_action: () => t('alOutcome_plan_action', undefined, 'You changed plan'),
  dismiss: () => t('alOutcome_dismiss', undefined, 'You dismissed it'),
}[o]?.() ?? o);
const kindText = (k) => ({
  action_changed: () => t('alKind_action_changed', undefined, 'Recommendation changed'),
  block_likely: () => t('alKind_block_likely', undefined, 'Block likely'),
  reset_approaching: () => t('alKind_reset_approaching', undefined, 'Reset approaching'),
  plan_review: () => t('alKind_plan_review', undefined, 'Plan review'),
  threshold: () => t('alKind_threshold', undefined, 'Threshold'),
}[k]?.() ?? k);

function historyItem(e) {
  const li = document.createElement('li');
  const when = new Date(e.ts).toLocaleString();
  const who = e.provider ? ` · ${PROVIDER_NAMES[e.provider] ?? e.provider}` : '';
  li.append(document.createTextNode(`${when} · ${kindText(e.kind)}${who} · ${outcomeText(e.outcome)} `));
  if (e.feedback) {
    li.append(document.createTextNode(`(${t('alRated', undefined, 'Rated')}: ${e.feedback === 'useful' ? t('alUseful', undefined, 'Useful') : t('alFalsePositive', undefined, 'False alarm')})`));
  } else {
    for (const [verdict, label] of [['useful', t('alUseful', undefined, 'Useful')], ['false_positive', t('alFalsePositive', undefined, 'False alarm')]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost btn-sm';
      b.textContent = label;
      b.addEventListener('click', async () => { await recordAlertFeedback(e.id, verdict, (n, p) => track(n, p)); await renderReport(); });
      li.append(b);
    }
  }
  return li;
}

async function renderReport() {
  const { report, history, arm } = await loadReport();
  const list = $('al-history');
  list.replaceChildren(...history.slice().reverse().map(historyItem));
  $('al-empty').hidden = history.length > 0;
  const text = $('al-report');
  if (!prefs.experimentOptIn || !arm) { text.textContent = ''; return; }
  const r = report.arms[arm];
  text.textContent = r.shown === 0
    ? t('alReportNone', undefined, 'Experiment: no data yet.')
    : t('alReport', [arm, String(r.shown), String(r.acted), String(r.dismissed), String(r.falsePositiveFeedback), String(r.notificationDisables)],
      `Experiment (${arm}): ${r.shown} shown, ${r.acted} acted on, ${r.dismissed} dismissed, ${r.falsePositiveFeedback} false alarms, notifications turned off ${r.notificationDisables} times.`);
}

document.addEventListener('DOMContentLoaded', async () => {
  const box = $('al-mute');
  for (const p of PROVIDERS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = p;
    input.id = `al-mute-${p}`;
    label.append(input, document.createTextNode(PROVIDER_NAMES[p]));
    box.appendChild(label);
  }
  prefs = await loadAlertPrefs();
  show();
  await renderReport();

  $('al-quiet-on').addEventListener('change', (e) => change({ quietHours: e.target.checked ? quietHours() : null }));
  for (const id of ['al-quiet-start', 'al-quiet-end']) $(id).addEventListener('change', () => change({ quietHours: quietHours() }));
  $('al-cooldown').addEventListener('change', (e) => change({ cooldownMinutes: Number.parseInt(e.target.value, 10) }));
  box.addEventListener('change', () => change({ mutedProviders: PROVIDERS.filter((p) => $(`al-mute-${p}`).checked) }));
  $('al-experiment').addEventListener('change', (e) => change({ experimentOptIn: e.target.checked }));
  $('al-clear').addEventListener('click', async () => {
    await clearAlertData();
    prefs = await saveAlertPrefs({ ...prefs, experimentOptIn: false });
    show();
    await renderReport();
    flash(t('alCleared', undefined, 'Removed ✓'));
  });
  // Turning notifications off from the Autopilot card counts as a "notification disable" for the experiment.
  $('ap-notify')?.addEventListener('change', async (e) => {
    if (e.target.value === 'off') { await recordNotificationsDisabled(); await renderReport(); }
  });
});

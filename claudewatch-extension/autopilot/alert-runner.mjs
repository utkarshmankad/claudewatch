// Runs Autopilot alerts from the service worker: recompute the recommendation after a refresh, decide whether
// an alert is due, show it, and keep the notification history that the experiment report is built from.
// Browser glue lives in the injected `notify` and `track`, so the decision flow is testable without chrome.*.
import { recommend } from './policy.mjs';
import { buildProviderInputs } from './inputs.mjs';
import { snapshotOf, explainChange, PROVIDER_NAMES } from './view-model.mjs';
import { alertText } from './messages.mjs';
import { loadPrefs } from './store.mjs';
import { candidateAlerts, decideAlert, recordShown, thresholdCandidates, parseAlertPrefs } from './alerts.mjs';
import { loadAlertPrefs, loadAlertState, saveAlertState, loadHistory, saveHistory, loadExperiment, saveExperiment } from './alert-store.mjs';
import { assignArm, newEntry, appendHistory, closeExpired, resolveForecasts, attributeAction, setFeedback, buildReport } from './experiment.mjs';

const offset = (now) => -new Date(now).getTimezoneOffset();
const withOffset = (wh, now) => (wh ? { ...wh, utcOffsetMinutes: offset(now) } : wh);

// stats: the GET_STATS reply. notify({ id, title, message, provider }) shows the notification.
// track(name, props) records an enum-only analytics event. t is the message lookup.
export async function evaluateAlerts({ stats, now = Date.now(), notify, track = () => {}, t, rand = Math.random }) {
  const prefs = await loadPrefs();
  if (prefs.disabled) return { alert: null, reason: 'disabled' };
  const alertPrefs = await loadAlertPrefs();
  const [state, rawHistory, experiment] = await Promise.all([loadAlertState(), loadHistory(), loadExperiment()]);
  const effective = { ...prefs, workingHours: withOffset(prefs.workingHours, now) };
  const quiet = { ...alertPrefs, quietHours: withOffset(alertPrefs.quietHours, now) };

  const inputs = buildProviderInputs(stats, now);
  const rec = recommend(inputs, effective, now);
  const snap = snapshotOf(rec, inputs, effective, now);
  const next = { ...state, limitSeen: { ...state.limitSeen }, suppressed: { ...state.suppressed }, prev: snap };
  for (const i of inputs) if (i.forecasts.some((f) => f.state === 'limited')) next.limitSeen[i.provider] = now;
  let history = resolveForecasts(closeExpired(rawHistory, now), next.limitSeen, now);

  let exp = experiment;
  if (alertPrefs.experimentOptIn) {
    const assignment = assignArm(experiment.assignment, now, rand);
    if (assignment !== experiment.assignment) { exp = { ...experiment, assignment }; track('experiment_assigned', { arm: assignment.arm }); }
  }
  const arm = alertPrefs.experimentOptIn ? exp.assignment.arm : 'autopilot';

  const hasReading = inputs.some((i) => i.hasReading);
  let result = { alert: null, reason: hasReading ? 'none_due' : 'no_readings' };
  if (hasReading) {
    const candidates = arm === 'threshold'
      ? thresholdCandidates(inputs, next, now)
      : candidateAlerts({ prev: state.prev, next: snap, rec, inputs, explain: explainChange(state.prev, snap) });
    const { alert, suppressed } = decideAlert({ candidates, frequency: prefs.notificationFrequency, alertPrefs: quiet, state: next, now });
    if (alert) {
      const id = `${now}`;
      const name = alert.provider ? PROVIDER_NAMES[alert.provider] ?? alert.provider : '';
      const text = alertText(t, alert, name);
      let shown = recordShown(next, alert, now);
      if (alert.windowKey) shown = { ...shown, thresholdFired: { ...shown.thresholdFired, [alert.windowKey]: now } };
      Object.assign(next, shown);
      history = appendHistory(history, newEntry({ id, now, alert, arm }));
      await notify({ id, title: text.title, message: text.message, provider: alert.provider });
      track('autopilot_alert_shown', { kind: alert.kind, arm });
      result = { alert, reason: 'shown' };
    } else if (suppressed) {
      next.suppressed[suppressed] = (next.suppressed[suppressed] ?? 0) + 1;
      result = { alert: null, reason: suppressed };
    }
  }
  await Promise.all([saveAlertState(next), saveHistory(history), exp !== experiment ? saveExperiment(exp) : null]);
  return result;
}

// A user action (open provider, wait, plan change, notification dismissed) credited to the latest open alert.
export async function recordAlertAction(action, provider, now = Date.now(), track = () => {}) {
  const history = await loadHistory();
  const { history: updated, entry } = attributeAction(history, action, provider ?? null, now);
  if (!entry) return false;
  await saveHistory(updated);
  track('autopilot_alert_action', { action, kind: entry.kind });
  return true;
}

export async function recordAlertFeedback(id, verdict, track = () => {}) {
  const history = await loadHistory();
  const updated = setFeedback(history, id, verdict);
  await saveHistory(updated);
  const entry = updated.find((e) => e.id === id && e.feedback === verdict);
  if (entry) track('alert_feedback', { verdict });
  return Boolean(entry);
}

// Counted against the arm the user is assigned to; with no experiment the count goes to 'autopilot'.
export async function recordNotificationsDisabled() {
  const [exp, alertPrefs] = await Promise.all([loadExperiment(), loadAlertPrefs()]);
  const arm = alertPrefs.experimentOptIn && exp.assignment ? exp.assignment.arm : 'autopilot';
  await saveExperiment({ ...exp, disables: { ...exp.disables, [arm]: (exp.disables?.[arm] ?? 0) + 1 } });
}

export async function loadReport() {
  const [history, exp] = await Promise.all([loadHistory(), loadExperiment()]);
  return { report: buildReport(history, exp.disables), history, arm: exp.assignment?.arm ?? null };
}

export { parseAlertPrefs };

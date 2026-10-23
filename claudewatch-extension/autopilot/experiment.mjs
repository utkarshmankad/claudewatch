// Local-only alert experiment (Prompt 2.4): threshold alerts versus Autopilot decision alerts.
// Nothing here leaves the browser. Assignment is a coin flip stored on this device after the user opts in,
// and the report is computed from the notification history. See docs/AUTOPILOT_ALERTS.md for removal.

export const ARMS = Object.freeze(['threshold', 'autopilot']);
export const ATTRIBUTION_WINDOW_MS = 60 * 60_000; // an action counts for an alert only inside this window
export const FORECAST_HORIZON_MS = 6 * 3_600_000; // a "block likely" alert is judged against this horizon
export const MAX_HISTORY = 50;
export const ACTIONS = Object.freeze(['switch_provider', 'wait', 'plan_action', 'dismiss']);

// Assigns an arm once; later calls return the stored assignment. `rand` is injected for tests.
export function assignArm(existing, now, rand = Math.random) {
  if (existing && ARMS.includes(existing.arm)) return existing;
  return { arm: rand() < 0.5 ? 'threshold' : 'autopilot', assignedAt: now };
}

export function newEntry({ id, now, alert, arm }) {
  return { id, ts: now, kind: alert.kind, provider: alert.provider, level: alert.level, arm, outcome: 'pending', actedAt: null, feedback: null, limitReached: null };
}

export const appendHistory = (history, entry) => [...history, entry].slice(-MAX_HISTORY);

// Attributes a user action to the most recent still-open alert inside the window. For switch_provider and
// wait the alert must be for the same provider or for no particular provider; plan_action and dismiss accept any.
export function attributeAction(history, action, provider, now) {
  if (!ACTIONS.includes(action)) return { history, entry: null };
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e.outcome !== 'pending' || now - e.ts > ATTRIBUTION_WINDOW_MS) continue;
    if (action === 'switch_provider' && provider && e.provider && e.provider !== provider && e.kind !== 'action_changed') continue;
    const next = history.slice();
    next[i] = { ...e, outcome: action, actedAt: now };
    return { history: next, entry: next[i] };
  }
  return { history, entry: null };
}

// Pending alerts whose window has passed without an action are closed as ignored.
export const closeExpired = (history, now) =>
  history.map((e) => (e.outcome === 'pending' && now - e.ts > ATTRIBUTION_WINDOW_MS ? { ...e, outcome: 'ignored' } : e));

export function setFeedback(history, id, verdict) {
  if (!['useful', 'false_positive'].includes(verdict)) return history;
  return history.map((e) => (e.id === id ? { ...e, feedback: verdict } : e));
}

// Marks block-likely alerts older than the horizon with whether the provider really hit its limit afterwards.
// limitSeen: provider -> last time a limited reading was observed.
export function resolveForecasts(history, limitSeen, now) {
  return history.map((e) => {
    if (e.kind !== 'block_likely' || e.limitReached !== null || now - e.ts < FORECAST_HORIZON_MS) return e;
    const seen = limitSeen?.[e.provider];
    return { ...e, limitReached: typeof seen === 'number' && seen >= e.ts };
  });
}

const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

// Per-arm report. disables: { arm: count } of times notifications were turned off while assigned to that arm.
export function buildReport(history, disables = {}) {
  const arms = {};
  for (const arm of ARMS) {
    const rows = history.filter((e) => e.arm === arm);
    const acted = rows.filter((e) => ['switch_provider', 'wait', 'plan_action'].includes(e.outcome)).length;
    const dismissed = rows.filter((e) => e.outcome === 'dismiss').length;
    const falsePositive = rows.filter((e) => e.feedback === 'false_positive').length;
    const judged = rows.filter((e) => e.kind === 'block_likely' && e.limitReached !== null);
    const wrong = judged.filter((e) => !e.limitReached).length;
    arms[arm] = {
      shown: rows.length, acted, actionRatePercent: rate(acted, rows.length), dismissed,
      notificationDisables: disables[arm] ?? 0, falsePositiveFeedback: falsePositive,
      forecastErrorPercent: rate(wrong, judged.length), forecastsJudged: judged.length,
    };
  }
  return { windowMinutes: ATTRIBUTION_WINDOW_MS / 60_000, arms };
}

// Autopilot decision alerts (Prompt 2.4). Pure and deterministic: no chrome.* calls, no clock reads.
// An alert is a small record { kind, provider, level, key, cause } built from provider names and
// enum codes only, so nothing user-written or account-specific can reach a notification or the history.
import { inWorkingHours } from './policy.mjs';

export const ALERT_KINDS = Object.freeze(['action_changed', 'block_likely', 'reset_approaching', 'plan_review']);
// Notification frequency decides which kinds may fire: 'off' none, 'important' the first two and the experiment's threshold alert, 'all' every kind.
export const IMPORTANT_KINDS = Object.freeze(['action_changed', 'block_likely', 'threshold']);
export const LEVEL_BY_KIND = Object.freeze({ action_changed: 'warn', block_likely: 'high', reset_approaching: 'warn', plan_review: 'warn' });

export const DEFAULT_ALERT_PREFS = Object.freeze({
  quietHours: null, cooldownMinutes: 60, mutedProviders: [], experimentOptIn: false,
});
export const MIN_COOLDOWN_MIN = 15;
export const MAX_COOLDOWN_MIN = 720;
// Same alert (kind + provider + action) is never repeated inside this window, whatever the cooldown.
export const DEDUPE_MS = 6 * 3_600_000;
export const PLAN_REVIEW_COOLDOWN_MS = 24 * 3_600_000;
export const RESET_SOON_MS = 15 * 60_000;
const PROVIDER_IDS = ['claude', 'chatgpt', 'gemini'];

export function parseAlertPrefs(raw) {
  const o = typeof raw === 'object' && raw !== null ? raw : {};
  const q = o.quietHours;
  const ok = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const quietHours = q && ok(q.startHour, 0, 23) && ok(q.endHour, 0, 24) && ok(q.utcOffsetMinutes, -720, 840) && q.startHour !== q.endHour
    ? { startHour: q.startHour, endHour: q.endHour, utcOffsetMinutes: q.utcOffsetMinutes } : null;
  const cd = typeof o.cooldownMinutes === 'number' && Number.isFinite(o.cooldownMinutes) ? Math.round(o.cooldownMinutes) : DEFAULT_ALERT_PREFS.cooldownMinutes;
  const mutedProviders = Array.isArray(o.mutedProviders) ? [...new Set(o.mutedProviders.filter((p) => PROVIDER_IDS.includes(p)))] : [];
  return { quietHours, cooldownMinutes: Math.min(MAX_COOLDOWN_MIN, Math.max(MIN_COOLDOWN_MIN, cd)), mutedProviders, experimentOptIn: o.experimentOptIn === true };
}

export const inQuietHours = (now, quietHours) => Boolean(quietHours) && inWorkingHours(now, quietHours);

// Candidate alerts for one evaluation, before any suppression. prev/next are snapshotOf() summaries,
// rec the current recommendation and inputs the policy inputs.
export function candidateAlerts({ prev, next, rec, inputs, explain }) {
  const out = [];
  const lowTrust = rec.warnings.includes('stale_data') || rec.warnings.includes('no_history');
  if (prev && (prev.action !== next.action || prev.provider !== next.provider) && next.action !== 'none' && !lowTrust) {
    out.push({ kind: 'action_changed', provider: next.provider, action: next.action, cause: explain ?? { key: 'quota_changed', provider: next.provider } });
  }
  if (rec.action === 'use' && !lowTrust && (rec.warnings.includes('limit_expected_soon') || rec.warnings.includes('high_exhaustion_risk'))) {
    out.push({ kind: 'block_likely', provider: rec.provider, action: rec.action, cause: null });
  }
  for (const i of inputs) {
    const limited = i.forecasts.filter((f) => f.state === 'limited' && typeof f.resetAt === 'number');
    if (!limited.length) continue;
    const soonest = Math.min(...limited.map((f) => f.resetAt));
    // The reset matters only while the user cannot use this provider, i.e. every window that blocks it resets soon.
    if (soonest > next.at && soonest - next.at <= RESET_SOON_MS && limited.every((f) => f.resetAt - next.at <= RESET_SOON_MS) && rec.provider !== i.provider) {
      out.push({ kind: 'reset_approaching', provider: i.provider, action: rec.action, cause: null, resetAt: soonest });
    }
  }
  for (const i of inputs) {
    const wk = i.forecasts.find((f) => f.window === 'weekly' && f.state === 'ok' && f.confidence !== 'low');
    if (wk && wk.usedPercent >= 90 && wk.hoursToReset !== null && wk.hoursToReset > 48) {
      out.push({ kind: 'plan_review', provider: i.provider, action: rec.action, cause: null });
    }
  }
  return out;
}

// Applies frequency, per-provider mute, quiet hours, dedupe and cooldown. Returns
// { alert, suppressed } where suppressed is the reason of the first candidate dropped (or null).
// state.lastShown maps alert key -> time shown; state.lastByKind maps "kind:provider" -> time shown.
export function decideAlert({ candidates, frequency, alertPrefs, state, now }) {
  if (frequency === 'off') return { alert: null, suppressed: candidates.length ? 'frequency_off' : null };
  let suppressed = null;
  const note = (why) => { suppressed = suppressed ?? why; };
  for (const c of candidates) {
    if (frequency === 'important' && !IMPORTANT_KINDS.includes(c.kind)) { note('frequency'); continue; }
    if (c.provider && alertPrefs.mutedProviders.includes(c.provider)) { note('muted'); continue; }
    if (inQuietHours(now, alertPrefs.quietHours)) { note('quiet_hours'); continue; }
    const key = `${c.kind}:${c.provider ?? '-'}:${c.action ?? '-'}`;
    const lastSame = state.lastShown?.[key];
    if (lastSame != null && now - lastSame < DEDUPE_MS) { note('duplicate'); continue; }
    const lastKind = state.lastByKind?.[`${c.kind}:${c.provider ?? '-'}`];
    const cooldown = c.kind === 'plan_review' ? PLAN_REVIEW_COOLDOWN_MS : alertPrefs.cooldownMinutes * 60_000;
    if (lastKind != null && now - lastKind < cooldown) { note('cooldown'); continue; }
    return { alert: { ...c, level: LEVEL_BY_KIND[c.kind], key }, suppressed };
  }
  return { alert: null, suppressed };
}

export function recordShown(state, alert, now) {
  return {
    ...state,
    lastShown: { ...pruneTimes(state.lastShown, now), [alert.key]: now },
    lastByKind: { ...pruneTimes(state.lastByKind, now), [`${alert.kind}:${alert.provider ?? '-'}`]: now },
  };
}

// Keeps the dedupe maps from growing: anything older than a day can no longer suppress an alert.
function pruneTimes(map, now) {
  return Object.fromEntries(Object.entries(map ?? {}).filter(([, t]) => now - t < 24 * 3_600_000));
}

// Legacy arm of the experiment: a plain threshold alert, once per provider window until it resets.
export const THRESHOLD_PERCENT = 80;
export function thresholdCandidates(inputs, state, now) {
  const out = [];
  for (const i of inputs) {
    for (const f of i.forecasts) {
      if (f.usedPercent == null || f.usedPercent < THRESHOLD_PERCENT) continue;
      const windowKey = `${i.provider}:${f.window}:${f.resetAt ?? 'none'}`;
      if (state.thresholdFired?.[windowKey]) continue;
      out.push({ kind: 'threshold', provider: i.provider, action: null, cause: null, windowKey, level: f.usedPercent >= 95 ? 'critical' : 'high', key: `threshold:${i.provider}:${f.window}` });
    }
  }
  return out.slice(0, 1);
}

// Autopilot recommendation policy for the extension. A JavaScript port of src/recommend/policy.ts
// (Prompt 2.2): the extension has no build step and cannot import the daemon's TypeScript.
// test/autopilot-parity.test.mjs runs both against the same scenarios so they cannot drift.
// Pure and deterministic. It ranks remaining quota and risk, never model quality.

export const PROVIDERS = Object.freeze(['claude', 'chatgpt', 'gemini']);
export const TASK_PROFILES = Object.freeze(['coding', 'research', 'writing', 'analysis', 'general']);

export const DEFAULT_PREFERENCES = Object.freeze({
  disabled: false, task: 'general', pinned: null, excluded: [], reservedPercent: 0, workingHours: null, affinity: {},
  notificationFrequency: 'important', // consumed by Autopilot alerts (Prompt 2.4); stored here only
});
export const NOTIFICATION_FREQUENCIES = Object.freeze(['off', 'important', 'all']);

const HOUR = 3_600_000;
const SOON_MS = 30 * 60_000;
const HIGH_RISK = 0.8;
const CLOSE_CALL = 5;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const rank = { low: 0, medium: 1, high: 2 };
const minConf = (a, b) => (rank[a] <= rank[b] ? a : b);
const isProvider = (x) => PROVIDERS.includes(x);

export function inWorkingHours(now, wh) {
  if (!wh) return true;
  const h = Math.floor((((now + wh.utcOffsetMinutes * 60_000) % (24 * HOUR)) + 24 * HOUR) % (24 * HOUR) / HOUR);
  return wh.startHour <= wh.endHour ? h >= wh.startHour && h < wh.endHour : h >= wh.startHour || h < wh.endHour;
}

function ineligible(c, p) {
  if (p.excluded.includes(c.provider)) return 'excluded';
  if (!c.authenticated) return 'unauthenticated'; // never route a user to a provider they are not signed in to
  if (c.health === 'offline') return 'offline';
  if (c.privacyRestricted) return 'privacy_restricted';
  return null;
}

function assess(c, p, now, working) {
  const warnings = [];
  let confidence = 'high';
  let blocked = false; let blockedUntil = null; let unknownReset = false;
  let headroom = null; let penalty = 0; let usable = 0;
  const limitedWindows = c.forecasts.filter((f) => f.state === 'limited').length;

  for (const f of c.forecasts) {
    if (f.state === 'limited') {
      blocked = true;
      if (f.resetAt === null || f.resetAt <= now) unknownReset = true;
      else blockedUntil = blockedUntil === null ? f.resetAt : Math.max(blockedUntil, f.resetAt);
      continue;
    }
    if (f.state === 'stale') { warnings.push('stale_data'); confidence = 'low'; penalty += 25; continue; }
    if (f.state === 'insufficient_data' && f.usedPercent === null) continue;
    usable++;
    if (f.usedPercent !== null) { const h = Math.max(0, 100 - p.reservedPercent - f.usedPercent); headroom = headroom === null ? h : Math.min(headroom, h); }
    confidence = minConf(confidence, f.confidence);
    if (f.state === 'insufficient_data') { confidence = minConf(confidence, 'low'); penalty += 10; continue; }
    if (f.window === 'five_hour' && !working) continue;
    const risk = f.probabilityExhaustBeforeReset ?? 0;
    penalty += 40 * risk;
    if (risk >= HIGH_RISK) warnings.push('high_exhaustion_risk');
    if (f.projectedLimitAt && f.projectedLimitAt.earliest - now <= SOON_MS) warnings.push('limit_expected_soon');
  }
  if (blocked && limitedWindows < c.forecasts.length && c.forecasts.some((f) => f.state === 'ok' && (f.usedPercent ?? 100) < 100)) warnings.push('conflicting_windows');
  if (blocked && unknownReset) { warnings.push('wait_until_unknown'); blockedUntil = null; }
  if (!c.forecasts.length || (usable === 0 && !blocked && !warnings.includes('stale_data'))) { warnings.push('no_history'); confidence = 'low'; }
  if (c.health === 'degraded') { warnings.push('degraded_provider'); penalty += 15; confidence = minConf(confidence, 'medium'); }

  const base = headroom ?? 50;
  const score = blocked ? 0 : Math.round(clamp(base - penalty, 0, 100) * 100) / 100;
  return { provider: c.provider, accountAlias: c.accountAlias, score, headroomPercent: headroom, blocked, blockedUntil, confidence, warnings: [...new Set(warnings)] };
}

function compare(p) {
  const aff = p.affinity[p.task] ?? [];
  const pos = (x) => { const i = aff.indexOf(x); return i === -1 ? aff.length : i; };
  return (a, b) => Number(a.blocked) - Number(b.blocked) || b.score - a.score || pos(a.provider) - pos(b.provider)
    || a.provider.localeCompare(b.provider) || a.accountAlias.localeCompare(b.accountAlias);
}

// The English `explanation` of the TypeScript engine is not produced here: the popup builds
// localized text from the structured fields (warnings, considered, waitUntil) instead.
export function recommend(inputs, prefs, now) {
  const p = { ...DEFAULT_PREFERENCES, ...prefs };
  const empty = (noneReason, considered = []) =>
    ({ action: 'none', noneReason, provider: null, accountAlias: null, waitUntil: null, confidence: 'low', alternatives: [], considered, inputsUsed: [], warnings: [] });
  if (p.disabled) return empty('disabled');

  const considered = [];
  const eligible = [];
  for (const c of [...inputs].sort((a, b) => a.provider.localeCompare(b.provider) || a.accountAlias.localeCompare(b.accountAlias))) {
    const why = ineligible(c, p);
    if (why) considered.push({ provider: c.provider, accountAlias: c.accountAlias, reason: why }); else eligible.push(c);
  }
  if (!eligible.length) return empty('no_eligible_provider', considered);

  const working = inWorkingHours(now, p.workingHours);
  const cands = eligible.map((c) => assess(c, p, now, working)).sort(compare(p));
  const usable = cands.filter((c) => !c.blocked);
  const inputsUsed = ['quota_forecasts', 'provider_health', 'task_profile', 'reserved_quota', ...(p.workingHours ? ['working_hours'] : []), ...(p.pinned ? ['pinned_provider'] : []), ...(p.excluded.length ? ['exclusions'] : []), ...(considered.some((x) => x.reason === 'privacy_restricted') ? ['privacy_restrictions'] : [])];
  const common = { considered, inputsUsed, outsideWorkingHours: !working };

  if (!usable.length) {
    const times = cands.map((c) => c.blockedUntil).filter((t) => t !== null);
    const waitUntil = times.length ? Math.min(...times) : null;
    const earliest = cands.find((c) => c.blockedUntil === waitUntil) ?? cands[0];
    return { action: 'wait', noneReason: null, provider: waitUntil === null ? null : earliest.provider, accountAlias: waitUntil === null ? null : earliest.accountAlias, waitUntil, confidence: waitUntil === null ? 'low' : 'medium', alternatives: [], ...common, warnings: waitUntil === null ? ['wait_until_unknown'] : [] };
  }

  const warnings = [];
  let pick = usable[0];
  if (p.pinned) {
    const pinnedIn = inputs.find((i) => i.provider === p.pinned);
    const cand = usable.find((c) => c.provider === p.pinned);
    if (cand) pick = cand;
    else if (cands.some((c) => c.provider === p.pinned)) warnings.push('pinned_blocked');
    else if (pinnedIn) warnings.push('pinned_ineligible');
    else warnings.push('pinned_unavailable');
  }
  const alternatives = usable.filter((c) => c !== pick);
  warnings.push(...pick.warnings);
  let confidence = pick.confidence;
  if (!alternatives.length) { warnings.push('single_candidate'); confidence = minConf(confidence, 'medium'); }
  else if (!p.pinned && pick.score - alternatives[0].score < CLOSE_CALL) { warnings.push('close_call'); confidence = minConf(confidence, 'medium'); }
  if (pick.warnings.includes('stale_data') || pick.warnings.includes('no_history')) confidence = 'low';
  return { action: 'use', noneReason: null, provider: pick.provider, accountAlias: pick.accountAlias, waitUntil: null, confidence, alternatives, ...common, warnings: [...new Set(warnings)], headroomPercent: pick.headroomPercent };
}

// Parses stored preferences defensively: unknown or malformed fields fall back to defaults.
export function parsePreferences(raw) {
  const o = typeof raw === 'object' && raw !== null ? raw : {};
  const task = TASK_PROFILES.includes(o.task) ? o.task : DEFAULT_PREFERENCES.task;
  const excluded = Array.isArray(o.excluded) ? [...new Set(o.excluded.filter(isProvider))] : [];
  const pinned = isProvider(o.pinned) && !excluded.includes(o.pinned) ? o.pinned : null; // exclusion wins over pin
  const reservedPercent = typeof o.reservedPercent === 'number' && Number.isFinite(o.reservedPercent) ? clamp(o.reservedPercent, 0, 100) : 0;
  const w = o.workingHours;
  const ok = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  const workingHours = w && ok(w.startHour, 0, 23) && ok(w.endHour, 0, 24) && ok(w.utcOffsetMinutes, -720, 840) && w.startHour !== w.endHour
    ? { startHour: w.startHour, endHour: w.endHour, utcOffsetMinutes: w.utcOffsetMinutes } : null;
  const affinity = {};
  if (typeof o.affinity === 'object' && o.affinity !== null) {
    for (const t of TASK_PROFILES) if (Array.isArray(o.affinity[t])) affinity[t] = [...new Set(o.affinity[t].filter(isProvider))];
  }
  const notificationFrequency = NOTIFICATION_FREQUENCIES.includes(o.notificationFrequency) ? o.notificationFrequency : DEFAULT_PREFERENCES.notificationFrequency;
  return { disabled: o.disabled === true, task, pinned, excluded, reservedPercent, workingHours, affinity, notificationFrequency };
}

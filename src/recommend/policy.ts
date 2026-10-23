import type { Forecast } from '../forecast/engine.js';
import { PROVIDERS } from '../ledger/types.js';
import type { Provider } from '../ledger/types.js';

// Deterministic recommendation policy. See docs/RECOMMENDATIONS.md for the rules.
// Pure: same inputs, same output. It ranks remaining quota and risk, never model quality.

export const TASK_PROFILES = ['coding', 'research', 'writing', 'analysis', 'general'] as const;
export type TaskProfile = (typeof TASK_PROFILES)[number];

export type Health = 'ok' | 'degraded' | 'offline';

export interface ProviderInput {
  provider: Provider;
  accountAlias: string;
  authenticated: boolean;
  health: Health;
  privacyRestricted?: boolean; // user or policy forbids sending this task's data to this provider
  forecasts: Forecast[]; // one per window; may be empty (no history)
}

export interface WorkingHours { startHour: number; endHour: number; utcOffsetMinutes: number } // endHour exclusive; may wrap midnight

export interface Preferences {
  disabled: boolean;
  task: TaskProfile;
  pinned: Provider | null;
  excluded: Provider[];
  reservedPercent: number;
  workingHours: WorkingHours | null;
  // User-declared preference per task, in order. A tie-break only, never an objective quality ranking.
  affinity: Partial<Record<TaskProfile, Provider[]>>;
}

export const DEFAULT_PREFERENCES: Preferences = { disabled: false, task: 'general', pinned: null, excluded: [], reservedPercent: 0, workingHours: null, affinity: {} };

export type Confidence = 'high' | 'medium' | 'low';
export type Action = 'use' | 'wait' | 'none';
export type NoneReason = 'disabled' | 'no_eligible_provider';
export type IneligibleReason = 'excluded' | 'unauthenticated' | 'offline' | 'privacy_restricted';
export type Warning =
  | 'stale_data' | 'no_history' | 'limit_expected_soon' | 'high_exhaustion_risk' | 'degraded_provider'
  | 'pinned_unavailable' | 'pinned_blocked' | 'pinned_ineligible' | 'close_call' | 'single_candidate' | 'conflicting_windows' | 'wait_until_unknown';

export interface Candidate {
  provider: Provider; accountAlias: string;
  score: number; // 0..100 headroom after penalties; comparable only within one recommendation
  headroomPercent: number | null;
  blockedUntil: number | null; // set only when blocked; null with blocked=true means the reset time is unknown
  blocked: boolean;
  confidence: Confidence;
  warnings: Warning[];
}

export interface Recommendation {
  action: Action;
  noneReason: NoneReason | null;
  provider: Provider | null;
  accountAlias: string | null;
  waitUntil: number | null;
  confidence: Confidence;
  alternatives: Candidate[];
  considered: Array<{ provider: Provider; accountAlias: string; reason: IneligibleReason }>;
  inputsUsed: string[];
  warnings: Warning[];
  explanation: string;
}

const HOUR = 3_600_000;
const SOON_MS = 30 * 60_000;
const HIGH_RISK = 0.8;
const CLOSE_CALL = 5;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const minConf = (a: Confidence, b: Confidence): Confidence => (rank[a] <= rank[b] ? a : b);

export function inWorkingHours(now: number, wh: WorkingHours | null): boolean {
  if (!wh) return true;
  const h = Math.floor((((now + wh.utcOffsetMinutes * 60_000) % (24 * HOUR)) + 24 * HOUR) % (24 * HOUR) / HOUR);
  return wh.startHour <= wh.endHour ? h >= wh.startHour && h < wh.endHour : h >= wh.startHour || h < wh.endHour;
}

function ineligible(c: ProviderInput, p: Preferences): IneligibleReason | null {
  if (p.excluded.includes(c.provider)) return 'excluded';
  if (!c.authenticated) return 'unauthenticated'; // never route a user to a provider they are not signed in to
  if (c.health === 'offline') return 'offline';
  if (c.privacyRestricted) return 'privacy_restricted';
  return null;
}

function assess(c: ProviderInput, p: Preferences, now: number, working: boolean): Candidate {
  const warnings: Warning[] = [];
  let confidence: Confidence = 'high';
  let blocked = false; let blockedUntil: number | null = null; let unknownReset = false;
  let headroom: number | null = null; let penalty = 0; let usable = 0;
  const limitedWindows = c.forecasts.filter(f => f.state === 'limited').length;

  for (const f of c.forecasts) {
    if (f.state === 'limited') {
      blocked = true;
      if (f.resetAt === null || f.resetAt <= now) unknownReset = true;
      else blockedUntil = blockedUntil === null ? f.resetAt : Math.max(blockedUntil, f.resetAt); // every capped window must reset
      continue;
    }
    if (f.state === 'stale') { warnings.push('stale_data'); confidence = 'low'; penalty += 25; continue; }
    if (f.state === 'insufficient_data' && f.usedPercent === null) continue; // no readings: handled as no history below
    usable++;
    if (f.usedPercent !== null) { const h = Math.max(0, 100 - p.reservedPercent - f.usedPercent); headroom = headroom === null ? h : Math.min(headroom, h); }
    confidence = minConf(confidence, f.confidence);
    if (f.state === 'insufficient_data') { confidence = minConf(confidence, 'low'); penalty += 10; continue; }
    // Outside working hours a five-hour window will reset before the next session, so its risk is not counted.
    if (f.window === 'five_hour' && !working) continue;
    const risk = f.probabilityExhaustBeforeReset ?? 0;
    penalty += 40 * risk;
    if (risk >= HIGH_RISK) warnings.push('high_exhaustion_risk');
    if (f.projectedLimitAt && f.projectedLimitAt.earliest - now <= SOON_MS) warnings.push('limit_expected_soon');
  }
  if (blocked && limitedWindows < c.forecasts.length && c.forecasts.some(f => f.state === 'ok' && (f.usedPercent ?? 100) < 100)) warnings.push('conflicting_windows');
  if (blocked && unknownReset) { warnings.push('wait_until_unknown'); blockedUntil = null; }
  if (!c.forecasts.length || (usable === 0 && !blocked && !warnings.includes('stale_data'))) { warnings.push('no_history'); confidence = 'low'; }
  if (c.health === 'degraded') { warnings.push('degraded_provider'); penalty += 15; confidence = minConf(confidence, 'medium'); }

  const base = headroom ?? 50; // unknown headroom scores as a neutral middle, with low confidence above
  const score = blocked ? 0 : Math.round(clamp(base - penalty, 0, 100) * 100) / 100;
  return { provider: c.provider, accountAlias: c.accountAlias, score, headroomPercent: headroom, blocked, blockedUntil, confidence, warnings: [...new Set(warnings)] };
}

// Order: unblocked first, then score, then the user's declared affinity for the task, then provider name.
function compare(p: Preferences) {
  const aff = p.affinity[p.task] ?? [];
  const pos = (x: Provider) => { const i = aff.indexOf(x); return i === -1 ? aff.length : i; };
  return (a: Candidate, b: Candidate) =>
    Number(a.blocked) - Number(b.blocked) || b.score - a.score || pos(a.provider) - pos(b.provider) || a.provider.localeCompare(b.provider) || a.accountAlias.localeCompare(b.accountAlias);
}

const label = (c: { provider: Provider; accountAlias: string }) => `${c.provider} (${c.accountAlias})`;

export function recommend(inputs: ProviderInput[], prefs: Partial<Preferences>, now: number): Recommendation {
  const p: Preferences = { ...DEFAULT_PREFERENCES, ...prefs };
  const empty = (noneReason: NoneReason, explanation: string, considered: Recommendation['considered'] = []): Recommendation =>
    ({ action: 'none', noneReason, provider: null, accountAlias: null, waitUntil: null, confidence: 'low', alternatives: [], considered, inputsUsed: [], warnings: [], explanation });
  if (p.disabled) return empty('disabled', 'Recommendations are turned off.');

  const considered: Recommendation['considered'] = [];
  const eligible: ProviderInput[] = [];
  for (const c of [...inputs].sort((a, b) => a.provider.localeCompare(b.provider) || a.accountAlias.localeCompare(b.accountAlias))) {
    const why = ineligible(c, p);
    if (why) considered.push({ provider: c.provider, accountAlias: c.accountAlias, reason: why }); else eligible.push(c);
  }
  if (!eligible.length) return empty('no_eligible_provider', 'No signed-in, reachable provider is available for this task, so there is nothing to recommend.', considered);

  const working = inWorkingHours(now, p.workingHours);
  const cands = eligible.map(c => assess(c, p, now, working)).sort(compare(p));
  const usable = cands.filter(c => !c.blocked);
  const inputsUsed = ['quota_forecasts', 'provider_health', 'task_profile', 'reserved_quota', ...(p.workingHours ? ['working_hours'] : []), ...(p.pinned ? ['pinned_provider'] : []), ...(p.excluded.length ? ['exclusions'] : []), ...(considered.some(x => x.reason === 'privacy_restricted') ? ['privacy_restrictions'] : [])];
  const common = { considered, inputsUsed };

  if (!usable.length) {
    const times = cands.map(c => c.blockedUntil).filter((t): t is number => t !== null);
    const waitUntil = times.length ? Math.min(...times) : null;
    const earliest = cands.find(c => c.blockedUntil === waitUntil) ?? cands[0];
    const warnings: Warning[] = waitUntil === null ? ['wait_until_unknown'] : [];
    return { action: 'wait', noneReason: null, provider: waitUntil === null ? null : earliest.provider, accountAlias: waitUntil === null ? null : earliest.accountAlias, waitUntil, confidence: waitUntil === null ? 'low' : 'medium', alternatives: [], ...common, warnings,
      explanation: waitUntil === null
        ? 'Every available provider is at its limit and no reset time is known. Check the providers directly.'
        : `Every available provider is at its limit. ${label(earliest)} is the first to reset, in about ${Math.max(1, Math.round((waitUntil - now) / 60_000))} minutes.` };
  }

  const warnings: Warning[] = [];
  let pick = usable[0];
  if (p.pinned) {
    const pinnedIn = inputs.find(i => i.provider === p.pinned);
    const cand = usable.find(c => c.provider === p.pinned);
    if (cand) pick = cand;
    else if (cands.some(c => c.provider === p.pinned)) warnings.push('pinned_blocked');
    else if (pinnedIn) warnings.push('pinned_ineligible');
    else warnings.push('pinned_unavailable');
  }
  const alternatives = usable.filter(c => c !== pick);
  warnings.push(...pick.warnings);
  let confidence = pick.confidence;
  if (!alternatives.length) { warnings.push('single_candidate'); confidence = minConf(confidence, 'medium'); }
  else if (!p.pinned && pick.score - alternatives[0].score < CLOSE_CALL) { warnings.push('close_call'); confidence = minConf(confidence, 'medium'); }
  if (pick.warnings.includes('stale_data') || pick.warnings.includes('no_history')) confidence = 'low';

  const parts = [`Use ${label(pick)}`];
  parts.push(pick.headroomPercent === null ? 'quota headroom is unknown' : `about ${Math.round(pick.headroomPercent)}% quota left after your reserve`);
  const note: string[] = [];
  if (p.pinned && pick.provider === p.pinned) note.push('you pinned it');
  if (warnings.includes('pinned_blocked')) note.push(`your pinned provider (${p.pinned}) is at its limit`);
  if (warnings.includes('pinned_ineligible')) note.push(`your pinned provider (${p.pinned}) is not usable right now`);
  if (warnings.includes('pinned_unavailable')) note.push(`your pinned provider (${p.pinned}) has no data`);
  if (warnings.includes('stale_data')) note.push('some quota data is out of date, so treat this as a guess');
  if (warnings.includes('no_history')) note.push('there is not enough history to forecast');
  if (warnings.includes('high_exhaustion_risk')) note.push('limit risk is high before the reset');
  if (warnings.includes('limit_expected_soon')) note.push('the limit may arrive within 30 minutes');
  if (warnings.includes('degraded_provider')) note.push('the provider reports degraded service');
  if (warnings.includes('conflicting_windows')) note.push('another usage window is at its limit');
  if (warnings.includes('close_call')) note.push('the next option is nearly as good');
  if (!working) note.push('outside your working hours, five-hour limits are not counted');
  const explanation = `${parts.join('; ')}${note.length ? `. Note: ${note.join('; ')}` : ''}. This ranks remaining quota and risk, not model quality.`;
  return { action: 'use', noneReason: null, provider: pick.provider, accountAlias: pick.accountAlias, waitUntil: null, confidence, alternatives, ...common, warnings: [...new Set(warnings)], explanation };
}

const isProvider = (x: unknown): x is Provider => typeof x === 'string' && (PROVIDERS as readonly string[]).includes(x);

// Parse stored preferences defensively: unknown or malformed fields fall back to defaults.
export function parsePreferences(raw: unknown): Preferences {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const task = (TASK_PROFILES as readonly unknown[]).includes(o['task']) ? (o['task'] as TaskProfile) : DEFAULT_PREFERENCES.task;
  const excluded = Array.isArray(o['excluded']) ? [...new Set(o['excluded'].filter(isProvider))] : [];
  const pinned = isProvider(o['pinned']) && !excluded.includes(o['pinned']) ? o['pinned'] : null; // exclusion wins over pin
  const reserved = typeof o['reservedPercent'] === 'number' && Number.isFinite(o['reservedPercent']) ? clamp(o['reservedPercent'], 0, 100) : 0;
  const w = o['workingHours'] as Record<string, unknown> | null | undefined;
  const ok = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  const workingHours = w && ok(w['startHour'], 0, 23) && ok(w['endHour'], 0, 24) && ok(w['utcOffsetMinutes'], -720, 840) && w['startHour'] !== w['endHour']
    ? { startHour: w['startHour'], endHour: w['endHour'], utcOffsetMinutes: w['utcOffsetMinutes'] } : null;
  const affinity: Preferences['affinity'] = {};
  const a = o['affinity'];
  if (typeof a === 'object' && a !== null) for (const t of TASK_PROFILES) { const v = (a as Record<string, unknown>)[t]; if (Array.isArray(v)) affinity[t] = [...new Set(v.filter(isProvider))]; }
  return { disabled: o['disabled'] === true, task, pinned, excluded, reservedPercent: reserved, workingHours, affinity };
}

// One-line decision record for logs. Contains no account aliases, prompts or conversation content.
export function decisionLogLine(r: Recommendation): string {
  return `[recommend] action=${r.action} provider=${r.provider ?? '-'} confidence=${r.confidence} alternatives=${r.alternatives.length} considered=${r.considered.map(c => `${c.provider}:${c.reason}`).join(',') || '-'} warnings=${r.warnings.join(',') || '-'}`;
}

import { createHash, randomBytes } from 'node:crypto';
import type { CardTemplate } from './shareCards.js';

// Opt-in acquisition-loop experiment framework (Prompt 5.5, operation key 2026-10-10.1/prompt-5.5).
// Pure functions: assignment, referral codes, event validation and metrics aggregation. No network code, no storage,
// no measurement. The live run needs a consented cohort and deployed endpoints and is deferred gate evidence.
// Protocol and privacy rules: docs/GROWTH_EXPERIMENT.md.

export const EXPERIMENT_ID = 'wrapped-share-v1';
export const DAY_MS = 86_400_000;

// --- variants ---------------------------------------------------------------------------------

export const VARIANTS = ['card_provider_mix', 'card_quota_streak', 'control_no_share'] as const;
export type Variant = (typeof VARIANTS)[number];

/** Card format shown for each variant. Both are factual (percentages and achievements, see SHARE_CARDS.md). The control has none. */
export const VARIANT_TEMPLATE: Record<Variant, CardTemplate | null> = {
  card_provider_mix: 'provider_mix', card_quota_streak: 'quota_streak', control_no_share: null,
};

export interface Consent { optedIn: boolean }
export type AssignResult = { ok: true; variant: Variant } | { ok: false; error: 'not_opted_in' | 'invalid_secret' };

/**
 * Deterministic local assignment. `installSecret` is a random value that stays on this device and is never sent;
 * the same secret and experiment always give the same variant, so nothing needs to be stored or fetched.
 * Without explicit opt-in nobody is assigned and nothing is recorded.
 */
export function assignVariant(consent: Consent, installSecret: string, experimentId: string = EXPERIMENT_ID): AssignResult {
  if (consent.optedIn !== true) return { ok: false, error: 'not_opted_in' };
  if (installSecret.length < 16) return { ok: false, error: 'invalid_secret' };
  const digest = createHash('sha256').update(`${experimentId}\u0000${installSecret}`).digest();
  const bucket = digest.readUInt32BE(0) % VARIANTS.length;
  return { ok: true, variant: VARIANTS[bucket] as Variant };
}

export interface OfferPolicy { showShareButton: boolean; autoPrompt: false; incentive: false; preChecked: false; countdown: false; requiresPreview: true }

/**
 * What the interface may do per variant. The fixed members are the no-dark-patterns rules: the share control is a
 * passive button inside the report, never a popup, reward, countdown, pre-checked option or guilt message, and sharing
 * always goes through the mandatory preview of Prompt 5.3. The control group sees no share control at all.
 */
export function offerPolicy(variant: Variant): OfferPolicy {
  return { showShareButton: VARIANT_TEMPLATE[variant] !== null, autoPrompt: false, incentive: false, preChecked: false, countdown: false, requiresPreview: true };
}

// --- referral codes ---------------------------------------------------------------------------

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, same alphabet as shareLinks.ts
export const REFERRAL_CODE_LENGTH = 10;
const TAG_CLASS_SIZE = 10; // 30 of the 32 symbols are used for the format tag; each format owns 10 of them

function randomIndex(max: number): number {
  const limit = 256 - (256 % max); // rejection sampling: no modulo bias
  for (;;) {
    const b = randomBytes(1)[0] as number;
    if (b < limit) return b % max;
  }
}

/**
 * One new code per share action. Position 0 carries only the card format (which of three variants produced the share) so
 * referred installs can be compared by format; the other nine symbols are random. No account, device, time, participant id
 * or counter goes in, so nothing about the sharer can be derived, and two codes from the same sharer cannot be linked.
 * The tag does reveal the card format, and that is disclosed in the protocol.
 */
export function newExperimentReferralCode(variant: Variant): string | null {
  const klass = VARIANTS.indexOf(variant);
  if (VARIANT_TEMPLATE[variant] === null) return null; // the control never produces a code
  let code = ALPHABET[klass * TAG_CLASS_SIZE + randomIndex(TAG_CLASS_SIZE)] as string;
  for (let i = 1; i < REFERRAL_CODE_LENGTH; i++) code += ALPHABET[randomIndex(32)] as string;
  return code;
}

/** The card format a code was issued under, or null if the code is malformed. */
export function variantOfReferralCode(code: string): Variant | null {
  if (code.length !== REFERRAL_CODE_LENGTH) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  const idx = ALPHABET.indexOf(code.charAt(0));
  const klass = Math.floor(idx / TAG_CLASS_SIZE);
  const v = VARIANTS[klass];
  if (v === undefined || VARIANT_TEMPLATE[v] === null) return null;
  return v;
}

// --- funnel and events ------------------------------------------------------------------------

/** Funnel order. Sharer-side stages come from a participant; install-side stages come from an install that used a code. */
export const FUNNEL_STAGES = ['report_viewed', 'card_previewed', 'card_exported', 'card_shared', 'referred_install', 'activated_install', 'retained_install'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const OPT_OUT_REASONS = ['not_useful', 'privacy_concern', 'too_many_prompts', 'other'] as const;
export type OptOutReason = (typeof OPT_OUT_REASONS)[number];
export const SUPPORT_CATEGORIES = ['card_content', 'privacy_concern', 'export_failed', 'referral_problem', 'other'] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

/**
 * The whole instrumentation surface. `subject` is a random id made for this experiment only (participant) or for one
 * install (install); `day` is a whole UTC day number, never a timestamp. There is no free text, account, device,
 * provider, value or destination field, and `sanitizeEvents` drops anything else.
 */
export type ExperimentEvent =
  | { type: 'participant_stage'; subject: string; day: number; stage: 'report_viewed' | 'card_previewed' | 'card_exported' | 'card_shared' }
  | { type: 'install_stage'; subject: string; day: number; stage: 'referred_install' | 'activated_install'; referralCode: string }
  | { type: 'install_active'; subject: string; day: number } // at most one per install per day; derives retained_install
  | { type: 'opt_out'; subject: string; day: number; reason: OptOutReason }
  | { type: 'support_issue'; subject: string; day: number; category: SupportCategory };

export interface Participant { subject: string; variant: Variant; optedInDay: number }

export const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);

const ID_OK = (s: unknown): s is string => typeof s === 'string' && s.length >= 8 && s.length <= 64 && [...s].every(c => /[A-Za-z0-9_-]/.test(c));
const isDay = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 100_000;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

export interface SanitizeResult { events: ExperimentEvent[]; rejected: number }

/** Keeps only well-formed events, rebuilt from an allow-list of keys. Unknown properties are dropped; bad events are counted and discarded. */
export function sanitizeEvents(raw: readonly unknown[]): SanitizeResult {
  const events: ExperimentEvent[] = [];
  let rejected = 0;
  for (const r of raw) {
    const e = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
    if (!ID_OK(e['subject']) || !isDay(e['day'])) { rejected++; continue; }
    const subject = e['subject'], day = e['day'];
    if (e['type'] === 'participant_stage' && oneOf(['report_viewed', 'card_previewed', 'card_exported', 'card_shared'] as const, e['stage'])) {
      events.push({ type: 'participant_stage', subject, day, stage: e['stage'] });
    } else if (e['type'] === 'install_stage' && oneOf(['referred_install', 'activated_install'] as const, e['stage'])
      && typeof e['referralCode'] === 'string' && variantOfReferralCode(e['referralCode']) !== null) {
      events.push({ type: 'install_stage', subject, day, stage: e['stage'], referralCode: e['referralCode'] });
    } else if (e['type'] === 'install_active') {
      events.push({ type: 'install_active', subject, day });
    } else if (e['type'] === 'opt_out' && oneOf(OPT_OUT_REASONS, e['reason'])) {
      events.push({ type: 'opt_out', subject, day, reason: e['reason'] });
    } else if (e['type'] === 'support_issue' && oneOf(SUPPORT_CATEGORIES, e['category'])) {
      events.push({ type: 'support_issue', subject, day, category: e['category'] });
    } else rejected++;
  }
  return { events, rejected };
}

// --- statistics -------------------------------------------------------------------------------

export interface Rate { numerator: number; denominator: number; rate: number | null; ci95: [number, number] | null }

/** Wilson score interval, 95 percent. Null when there is no denominator. */
export function rateOf(numerator: number, denominator: number): Rate {
  if (denominator <= 0) return { numerator, denominator, rate: null, ci95: null };
  const z = 1.959964, p = numerator / denominator, n = denominator;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { numerator, denominator, rate: p, ci95: [Math.max(0, centre - half), Math.min(1, centre + half)] };
}

// --- aggregation ------------------------------------------------------------------------------

export const RETENTION_WINDOW = { startDay: 21, endDay: 28 } as const; // week four of an install's life: days 21 to 27 after its first day

export interface AggregateOptions {
  /** Today as a whole UTC day. Cohorts that have not reached the end of week four are reported separately, never counted as lost. */
  today: number;
  /**
   * Smallest sample the owner accepts per variant before a rate may be called usable. It has no default because the plan
   * leaves the threshold to the approved experiment design; when unset, `sampleSufficient` is null.
   */
  minSample?: number;
}

export interface VariantReport {
  variant: Variant;
  template: CardTemplate | null;
  participants: number;
  viewers: number;
  exportRate: Rate | null; // distinct participants who exported, among those who viewed a report. Null for the control (no card)
  shareRate: Rate | null; // distinct participants who shared, among those who viewed a report. Null for the control
  referredInstalls: number;
  referredActivation: Rate | null; // referred installs that activated, among referred installs. Null when none
  referredRetention: Rate | null; // activated referred installs active in their own week four, among those whose week four has ended
  week4Retention: Rate | null; // participants active in their own week four, among participants whose week four has ended
  week4Immature: number; // participants whose week four had not ended and so are excluded from retention
  optOuts: Rate; // distinct participants who opted out, among participants
  optOutReasons: Record<OptOutReason, number>;
  supportIssues: { total: number; per100Participants: number | null; byCategory: Record<SupportCategory, number> };
  sampleSufficient: boolean | null;
}

export interface ExperimentReport {
  experimentId: string;
  today: number;
  variants: VariantReport[];
  funnel: Record<Variant, Record<FunnelStage, number>>; // distinct subjects per stage; install-side stages count distinct codes' installs
  droppedEvents: { afterOptOut: number; unknownSubject: number; unmatchedReferral: number };
  note: string;
}

const zeroRecord = <T extends string>(keys: readonly T[]): Record<T, number> => Object.fromEntries(keys.map(k => [k, 0])) as Record<T, number>;

/**
 * Computes the report from sanitized events. Events after a participant's opt-out are ignored (data minimisation); events
 * from unknown participants are counted and dropped. It reports differences and intervals and never picks a winner:
 * variant selection is a gate decision made by a person with real data.
 */
export function aggregateExperiment(participants: readonly Participant[], events: readonly ExperimentEvent[], o: AggregateOptions): ExperimentReport {
  const byId = new Map(participants.map(p => [p.subject, p]));
  const optOutDay = new Map<string, number>();
  for (const e of events) if (e.type === 'opt_out' && byId.has(e.subject)) optOutDay.set(e.subject, Math.min(optOutDay.get(e.subject) ?? Infinity, e.day));

  const dropped = { afterOptOut: 0, unknownSubject: 0, unmatchedReferral: 0 };
  const stageSubjects = new Map<string, Set<string>>(); // `${variant}|${stage}` -> subjects
  const mark = (v: Variant, s: FunnelStage, id: string): void => {
    const k = `${v}|${s}`;
    (stageSubjects.get(k) ?? stageSubjects.set(k, new Set()).get(k)!).add(id);
  };
  const activeDays = new Map<string, Set<number>>(); // subject (participant or install) -> active days
  const installs = new Map<string, { variant: Variant; firstDay: number; activated: boolean }>();
  const optReasons = new Map<Variant, Map<OptOutReason, Set<string>>>();
  const support = new Map<Variant, Map<SupportCategory, number>>();

  for (const e of events) {
    if (e.type === 'install_stage') {
      const variant = variantOfReferralCode(e.referralCode);
      if (variant === null) { dropped.unmatchedReferral++; continue; }
      const rec = installs.get(e.subject) ?? { variant, firstDay: e.day, activated: false };
      rec.firstDay = Math.min(rec.firstDay, e.day);
      if (e.stage === 'activated_install') rec.activated = true;
      installs.set(e.subject, rec);
      mark(variant, e.stage, e.subject);
      continue;
    }
    if (e.type === 'install_active') {
      (activeDays.get(e.subject) ?? activeDays.set(e.subject, new Set()).get(e.subject)!).add(e.day);
      continue;
    }
    const p = byId.get(e.subject);
    if (!p) { dropped.unknownSubject++; continue; }
    const out = optOutDay.get(e.subject);
    if (out !== undefined && e.day > out) { dropped.afterOptOut++; continue; }
    if (e.type === 'participant_stage') mark(p.variant, e.stage, e.subject);
    else if (e.type === 'opt_out') {
      const m = optReasons.get(p.variant) ?? optReasons.set(p.variant, new Map()).get(p.variant)!;
      (m.get(e.reason) ?? m.set(e.reason, new Set()).get(e.reason)!).add(e.subject);
    } else {
      const m = support.get(p.variant) ?? support.set(p.variant, new Map()).get(p.variant)!;
      m.set(e.category, (m.get(e.category) ?? 0) + 1);
    }
  }

  // Retained install: active during days 21 to 27 after its first referred-install day, once that week has ended.
  const retainedInstalls = new Map<string, boolean>();
  for (const [id, rec] of installs) {
    if (!rec.activated || o.today < rec.firstDay + RETENTION_WINDOW.endDay) continue;
    const days = activeDays.get(id);
    const hit = days !== undefined && [...days].some(d => d >= rec.firstDay + RETENTION_WINDOW.startDay && d < rec.firstDay + RETENTION_WINDOW.endDay);
    retainedInstalls.set(id, hit);
    if (hit) mark(rec.variant, 'retained_install', id);
  }

  const funnel = {} as ExperimentReport['funnel'];
  const variants: VariantReport[] = VARIANTS.map(variant => {
    const template = VARIANT_TEMPLATE[variant];
    const mine = participants.filter(p => p.variant === variant);
    const n = mine.length;
    const set = (s: FunnelStage): Set<string> => stageSubjects.get(`${variant}|${s}`) ?? new Set();
    funnel[variant] = Object.fromEntries(FUNNEL_STAGES.map(s => [s, set(s).size])) as Record<FunnelStage, number>;

    const viewers = set('report_viewed');
    const hasCard = template !== null;
    const refInstalls = [...installs.values()].filter(i => i.variant === variant);

    // Participant week-four retention: the participant's own report views or card events are not activity; the product
    // reports activity through 'install_active' events keyed by the participant's subject.
    let matured = 0, retained = 0;
    for (const p of mine) {
      if (o.today < p.optedInDay + RETENTION_WINDOW.endDay) continue;
      const out = optOutDay.get(p.subject);
      matured++;
      if (out !== undefined && out < p.optedInDay + RETENTION_WINDOW.endDay) continue; // opted out before the window: not retained
      const days = activeDays.get(p.subject);
      if (days !== undefined && [...days].some(d => d >= p.optedInDay + RETENTION_WINDOW.startDay && d < p.optedInDay + RETENTION_WINDOW.endDay && (out === undefined || d <= out))) retained++;
    }

    const reasons = zeroRecord(OPT_OUT_REASONS);
    const rm = optReasons.get(variant);
    if (rm) for (const [k, s] of rm) reasons[k] = s.size;
    const optedOut = new Set([...(rm?.values() ?? [])].flatMap(s => [...s]));
    const cats = zeroRecord(SUPPORT_CATEGORIES);
    const sm = support.get(variant);
    if (sm) for (const [k, c] of sm) cats[k] = c;
    const total = Object.values(cats).reduce((a, b) => a + b, 0);

    return {
      variant, template, participants: n, viewers: viewers.size,
      exportRate: hasCard ? rateOf(set('card_exported').size, viewers.size) : null,
      shareRate: hasCard ? rateOf(set('card_shared').size, viewers.size) : null,
      referredInstalls: refInstalls.length,
      referredActivation: hasCard && refInstalls.length > 0 ? rateOf(refInstalls.filter(i => i.activated).length, refInstalls.length) : null,
      referredRetention: (() => {
        const m = [...retainedInstalls].filter(([id]) => installs.get(id)?.variant === variant);
        return m.length > 0 ? rateOf(m.filter(([, hit]) => hit).length, m.length) : null;
      })(),
      week4Retention: matured > 0 ? rateOf(retained, matured) : null,
      week4Immature: n - matured,
      optOuts: rateOf(optedOut.size, n),
      optOutReasons: reasons,
      supportIssues: { total, per100Participants: n > 0 ? (total / n) * 100 : null, byCategory: cats },
      sampleSufficient: o.minSample === undefined ? null : n >= o.minSample,
    };
  });

  return {
    experimentId: EXPERIMENT_ID, today: o.today, variants, funnel, droppedEvents: dropped,
    note: 'Rates are descriptive with 95% Wilson intervals. No variant is selected here; selection and removal of losing variants are gate decisions that need real cohort data.',
  };
}

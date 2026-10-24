import { describe, expect, it } from 'vitest';
import {
  aggregateExperiment, assignVariant, FUNNEL_STAGES, newExperimentReferralCode, offerPolicy, rateOf, REFERRAL_CODE_LENGTH,
  sanitizeEvents, variantOfReferralCode, VARIANTS, VARIANT_TEMPLATE,
  type ExperimentEvent, type Participant, type Variant,
} from '../growthExperiment.js';
import { buildCard, REFERRAL_RE, type CardInputs } from '../shareCards.js';

// ALL DATA IN THIS FILE IS SYNTHETIC. It exercises the arithmetic and the privacy rules. It is not a measurement of
// any user, cohort or product behavior, and no number here may be quoted as a result.

const D0 = 20_000; // synthetic day number
const SECRET = (n: number): string => `synthetic-secret-${String(n).padStart(6, '0')}`;
const pid = (v: string, n: number): string => `SYN-P-${v.slice(-6)}-${n}`;

describe('assignment (synthetic)', () => {
  it('assigns nobody without explicit opt-in', () => {
    expect(assignVariant({ optedIn: false }, SECRET(1))).toEqual({ ok: false, error: 'not_opted_in' });
    expect(assignVariant({ optedIn: undefined as unknown as boolean }, SECRET(1))).toEqual({ ok: false, error: 'not_opted_in' });
  });
  it('rejects a weak secret', () => {
    expect(assignVariant({ optedIn: true }, 'short')).toEqual({ ok: false, error: 'invalid_secret' });
  });
  it('is deterministic per secret and experiment, and varies with the experiment id', () => {
    const a = assignVariant({ optedIn: true }, SECRET(7));
    expect(assignVariant({ optedIn: true }, SECRET(7))).toEqual(a);
    const other = new Set(Array.from({ length: 40 }, (_, i) => { const r = assignVariant({ optedIn: true }, SECRET(7), `exp-${i}`); return r.ok ? r.variant : 'x'; }));
    expect(other.size).toBeGreaterThan(1);
  });
  it('covers all three variants roughly evenly over synthetic secrets', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 3000; i++) { const r = assignVariant({ optedIn: true }, SECRET(i)); if (r.ok) counts[r.variant] = (counts[r.variant] ?? 0) + 1; }
    expect(Object.keys(counts).sort()).toEqual([...VARIANTS].sort());
    for (const v of VARIANTS) expect(counts[v]).toBeGreaterThan(850);
  });
  it('has two factual card formats and a no-share control', () => {
    expect(VARIANT_TEMPLATE).toEqual({ card_provider_mix: 'provider_mix', card_quota_streak: 'quota_streak', control_no_share: null });
  });
  it('never allows a dark pattern in any variant', () => {
    for (const v of VARIANTS) {
      const p = offerPolicy(v);
      expect(p).toMatchObject({ autoPrompt: false, incentive: false, preChecked: false, countdown: false, requiresPreview: true });
    }
    expect(offerPolicy('control_no_share').showShareButton).toBe(false);
    expect(offerPolicy('card_provider_mix').showShareButton).toBe(true);
  });
});

describe('referral code (synthetic)', () => {
  it('is valid for the existing card builder and never issued for the control', () => {
    expect(newExperimentReferralCode('control_no_share')).toBeNull();
    for (let i = 0; i < 200; i++) expect(newExperimentReferralCode('card_provider_mix') as string).toMatch(REFERRAL_RE);
  });
  it('carries only the card format in position 0 and decodes it', () => {
    for (const v of ['card_provider_mix', 'card_quota_streak'] as const) {
      for (let i = 0; i < 300; i++) expect(variantOfReferralCode(newExperimentReferralCode(v) as string)).toBe(v);
    }
  });
  it('is unlinkable: no repeats and no shared structure across codes from the same format', () => {
    const codes = Array.from({ length: 2000 }, () => newExperimentReferralCode('card_quota_streak') as string);
    expect(new Set(codes).size).toBe(codes.length);
    // Each of the nine random positions should use many symbols; a derived or counter value would not.
    for (let pos = 1; pos < REFERRAL_CODE_LENGTH; pos++) expect(new Set(codes.map(c => c[pos])).size).toBeGreaterThan(25);
  });
  it('contains no input derived from the sharer: the generator takes only the format', () => {
    expect(newExperimentReferralCode.length).toBe(1);
  });
  it('rejects malformed codes', () => {
    expect(variantOfReferralCode('')).toBeNull();
    expect(variantOfReferralCode('short')).toBeNull();
    expect(variantOfReferralCode('ILOU000000')).toBeNull(); // excluded symbols
    expect(variantOfReferralCode('Z' + '0'.repeat(9))).toBeNull(); // tag class beyond the variants
    expect(variantOfReferralCode('a' + '0'.repeat(9))).toBeNull(); // lowercase
  });
  it('can be placed on a real card as the optional, default-off referral field', () => {
    const inputs: CardInputs = {
      periodLabel: '2026-10-05', partial: false, providerShares: [{ provider: 'claude', percent: 60 }, { provider: 'chatgpt', percent: 40 }],
      streakDays: null, daysUnderLimitPercent: null, windowsAtLimit: null, preventedConfirmed: null, headroomPercent: null, forecastWithinPoints: null, activeDaysPercent: null,
    };
    const r = buildCard(inputs, 'provider_mix', { referralCode: newExperimentReferralCode('card_provider_mix') as string });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.card.fields.find(f => f.id === 'referral')?.enabled).toBe(false);
  });
});

describe('event sanitizing (synthetic)', () => {
  const code = newExperimentReferralCode('card_provider_mix') as string;
  it('keeps allow-listed fields only and drops extra properties', () => {
    const { events, rejected } = sanitizeEvents([
      { type: 'participant_stage', subject: 'SYN-P-00001', day: D0, stage: 'report_viewed', account: 'leak@example.com', url: 'https://x.invalid' },
    ]);
    expect(rejected).toBe(0);
    expect(events[0]).toEqual({ type: 'participant_stage', subject: 'SYN-P-00001', day: D0, stage: 'report_viewed' });
    expect(JSON.stringify(events)).not.toContain('leak');
  });
  it('rejects bad subjects, non-day timestamps, unknown types, free text reasons and bad codes', () => {
    const { events, rejected } = sanitizeEvents([
      null, 'x', {}, { type: 'participant_stage', subject: 'short', day: D0, stage: 'report_viewed' },
      { type: 'participant_stage', subject: 'SYN-P-00001', day: Date.now(), stage: 'report_viewed' }, // millisecond timestamp
      { type: 'participant_stage', subject: 'SYN-P-00001', day: D0, stage: 'retained_install' },
      { type: 'opt_out', subject: 'SYN-P-00001', day: D0, reason: 'my boss is called Bob' },
      { type: 'support_issue', subject: 'SYN-P-00001', day: D0, category: 'free text' },
      { type: 'install_stage', subject: 'SYN-I-00001', day: D0, stage: 'referred_install', referralCode: 'nope' },
      { type: 'participant_stage', subject: 'has space!!', day: D0, stage: 'report_viewed' },
    ]);
    expect(events).toHaveLength(0);
    expect(rejected).toBe(10);
  });
  it('accepts each valid event type', () => {
    const { events, rejected } = sanitizeEvents([
      { type: 'install_stage', subject: 'SYN-I-00001', day: D0, stage: 'referred_install', referralCode: code },
      { type: 'install_active', subject: 'SYN-I-00001', day: D0 + 1 },
      { type: 'opt_out', subject: 'SYN-P-00001', day: D0, reason: 'privacy_concern' },
      { type: 'support_issue', subject: 'SYN-P-00001', day: D0, category: 'export_failed' },
    ]);
    expect(rejected).toBe(0);
    expect(events).toHaveLength(4);
  });
});

describe('rateOf (synthetic)', () => {
  it('is null without a denominator and bounded otherwise', () => {
    expect(rateOf(0, 0)).toEqual({ numerator: 0, denominator: 0, rate: null, ci95: null });
    const r = rateOf(5, 10);
    expect(r.rate).toBe(0.5);
    expect(r.ci95![0]).toBeGreaterThan(0.23);
    expect(r.ci95![1]).toBeLessThan(0.77);
    expect(rateOf(0, 5).ci95![0]).toBe(0);
    expect(rateOf(5, 5).ci95![1]).toBe(1);
  });
});

// --- synthetic fixture ------------------------------------------------------------------------
// Per card variant: 10 participants, all opted in on D0, so week four ends at D0 + 28.
// provider_mix: 10 viewers, 6 previewed, 4 exported, 2 shared. Week-four active: 6 of 10.
// quota_streak: 10 viewers, 8 previewed, 6 exported, 3 shared. Week-four active: 5 of 10.
// control: 10 viewers, nothing else. Week-four active: 4 of 10.
function fixture(): { participants: Participant[]; events: ExperimentEvent[] } {
  const participants: Participant[] = [];
  const events: ExperimentEvent[] = [];
  const spec: Array<[Variant, number, number, number, number]> = [
    ['card_provider_mix', 6, 4, 2, 6], ['card_quota_streak', 8, 6, 3, 5], ['control_no_share', 0, 0, 0, 4],
  ];
  for (const [variant, prev, exp, shr, ret] of spec) {
    for (let i = 0; i < 10; i++) {
      const subject = pid(variant, i);
      participants.push({ subject, variant, optedInDay: D0 });
      events.push({ type: 'participant_stage', subject, day: D0 + 1, stage: 'report_viewed' });
      if (i < prev) events.push({ type: 'participant_stage', subject, day: D0 + 1, stage: 'card_previewed' });
      if (i < exp) events.push({ type: 'participant_stage', subject, day: D0 + 1, stage: 'card_exported' });
      if (i < shr) events.push({ type: 'participant_stage', subject, day: D0 + 1, stage: 'card_shared' });
      if (i < ret) events.push({ type: 'install_active', subject, day: D0 + 22 });
    }
  }
  return { participants, events };
}

describe('aggregateExperiment (synthetic fixture)', () => {
  const { participants, events } = fixture();
  const report = aggregateExperiment(participants, events, { today: D0 + 40 });
  const get = (v: Variant) => report.variants.find(x => x.variant === v)!;

  it('computes export and share rate per card variant and leaves the control null', () => {
    expect(get('card_provider_mix').exportRate).toMatchObject({ numerator: 4, denominator: 10, rate: 0.4 });
    expect(get('card_provider_mix').shareRate).toMatchObject({ numerator: 2, denominator: 10, rate: 0.2 });
    expect(get('card_quota_streak').exportRate).toMatchObject({ numerator: 6, denominator: 10, rate: 0.6 });
    expect(get('card_quota_streak').shareRate).toMatchObject({ numerator: 3, denominator: 10 });
    expect(get('control_no_share').exportRate).toBeNull();
    expect(get('control_no_share').shareRate).toBeNull();
  });
  it('computes week-four retention for every arm, including the control', () => {
    expect(get('card_provider_mix').week4Retention).toMatchObject({ numerator: 6, denominator: 10 });
    expect(get('card_quota_streak').week4Retention).toMatchObject({ numerator: 5, denominator: 10 });
    expect(get('control_no_share').week4Retention).toMatchObject({ numerator: 4, denominator: 10 });
  });
  it('builds the funnel from distinct subjects', () => {
    expect(report.funnel.card_quota_streak).toMatchObject({ report_viewed: 10, card_previewed: 8, card_exported: 6, card_shared: 3, referred_install: 0 });
    expect(Object.keys(report.funnel.card_provider_mix)).toEqual([...FUNNEL_STAGES]);
  });
  it('counts a repeated event once', () => {
    const dup = aggregateExperiment(participants, [...events, ...events], { today: D0 + 40 });
    expect(dup.funnel.card_quota_streak.card_exported).toBe(6);
  });
  it('excludes participants whose week four has not ended and reports how many', () => {
    const early = aggregateExperiment(participants, events, { today: D0 + 27 });
    expect(early.variants[0]!.week4Retention).toBeNull();
    expect(early.variants[0]!.week4Immature).toBe(10);
  });
  it('leaves sampleSufficient null unless the owner sets a minimum', () => {
    expect(get('card_provider_mix').sampleSufficient).toBeNull();
    const withMin = aggregateExperiment(participants, events, { today: D0 + 40, minSample: 11 });
    expect(withMin.variants.every(v => v.sampleSufficient === false)).toBe(true);
    expect(aggregateExperiment(participants, events, { today: D0 + 40, minSample: 10 }).variants.every(v => v.sampleSufficient === true)).toBe(true);
  });
  it('does not choose a winner', () => {
    expect(JSON.stringify(Object.keys(report)) + JSON.stringify(Object.keys(report.variants[0]!))).not.toMatch(/winner|best|rank|selected/i);
    expect(report.note).toMatch(/No variant is selected/);
  });
});

describe('referred installs (synthetic)', () => {
  const participants: Participant[] = [];
  const mixCode = () => newExperimentReferralCode('card_provider_mix') as string;
  const streakCode = () => newExperimentReferralCode('card_quota_streak') as string;
  const inst = (n: number): string => `SYN-I-${String(n).padStart(5, '0')}`;
  const events: ExperimentEvent[] = [];
  // 4 installs via a provider_mix code: 3 activate, of which 2 are active in week four. 2 installs via quota_streak: 1 activates, not retained.
  const plan: Array<[number, string, boolean, boolean]> = [
    [1, mixCode(), true, true], [2, mixCode(), true, true], [3, mixCode(), true, false], [4, mixCode(), false, false],
    [5, streakCode(), true, false], [6, streakCode(), false, false],
  ];
  for (const [n, code, activated, retained] of plan) {
    events.push({ type: 'install_stage', subject: inst(n), day: D0 + 2, stage: 'referred_install', referralCode: code });
    if (activated) events.push({ type: 'install_stage', subject: inst(n), day: D0 + 3, stage: 'activated_install', referralCode: code });
    if (retained) events.push({ type: 'install_active', subject: inst(n), day: D0 + 2 + 23 });
  }
  const r = aggregateExperiment(participants, events, { today: D0 + 2 + 28 });
  const get = (v: Variant) => r.variants.find(x => x.variant === v)!;

  it('attributes installs to the card format from the code alone', () => {
    expect(get('card_provider_mix').referredInstalls).toBe(4);
    expect(get('card_quota_streak').referredInstalls).toBe(2);
    expect(get('control_no_share').referredInstalls).toBe(0);
  });
  it('computes referred activation and referred retention', () => {
    expect(get('card_provider_mix').referredActivation).toMatchObject({ numerator: 3, denominator: 4 });
    expect(get('card_quota_streak').referredActivation).toMatchObject({ numerator: 1, denominator: 2 });
    expect(get('card_provider_mix').referredRetention).toMatchObject({ numerator: 2, denominator: 3 });
    expect(get('card_quota_streak').referredRetention).toMatchObject({ numerator: 0, denominator: 1 });
    expect(get('control_no_share').referredActivation).toBeNull();
    expect(r.funnel.card_provider_mix).toMatchObject({ referred_install: 4, activated_install: 3, retained_install: 2 });
  });
  it('does not count immature installs as lost', () => {
    const early = aggregateExperiment(participants, events, { today: D0 + 2 + 27 });
    expect(get('card_provider_mix').referredRetention).not.toBeNull();
    expect(early.variants[0]!.referredRetention).toBeNull();
  });
});

describe('opt-out feedback and support issues (synthetic)', () => {
  const participants: Participant[] = Array.from({ length: 4 }, (_, i) => ({ subject: `SYN-P-QS-${i}`, variant: 'card_quota_streak' as const, optedInDay: D0 }));
  const events: ExperimentEvent[] = [
    { type: 'opt_out', subject: 'SYN-P-QS-0', day: D0 + 5, reason: 'not_useful' },
    { type: 'opt_out', subject: 'SYN-P-QS-1', day: D0 + 6, reason: 'privacy_concern' },
    { type: 'opt_out', subject: 'SYN-P-QS-1', day: D0 + 7, reason: 'privacy_concern' }, // same person twice
    { type: 'support_issue', subject: 'SYN-P-QS-2', day: D0 + 3, category: 'export_failed' },
    { type: 'support_issue', subject: 'SYN-P-QS-2', day: D0 + 4, category: 'export_failed' },
    { type: 'support_issue', subject: 'SYN-P-QS-3', day: D0 + 4, category: 'card_content' },
    { type: 'participant_stage', subject: 'SYN-P-QS-0', day: D0 + 4, stage: 'report_viewed' }, // before opt-out: kept
    { type: 'participant_stage', subject: 'SYN-P-QS-0', day: D0 + 8, stage: 'card_shared' }, // after opt-out: dropped
    { type: 'participant_stage', subject: 'SYN-P-UNKNOWN', day: D0 + 8, stage: 'report_viewed' },
    { type: 'install_active', subject: 'SYN-P-QS-0', day: D0 + 22 }, // activity after opt-out must not count as retention
  ];
  const r = aggregateExperiment(participants, events, { today: D0 + 40 });
  const v = r.variants.find(x => x.variant === 'card_quota_streak')!;

  it('counts opt-outs once per participant with a fixed reason set', () => {
    expect(v.optOuts).toMatchObject({ numerator: 2, denominator: 4, rate: 0.5 });
    expect(v.optOutReasons).toEqual({ not_useful: 1, privacy_concern: 1, too_many_prompts: 0, other: 0 });
  });
  it('counts support issues by category and per 100 participants', () => {
    expect(v.supportIssues.total).toBe(3);
    expect(v.supportIssues.per100Participants).toBe(75);
    expect(v.supportIssues.byCategory).toMatchObject({ export_failed: 2, card_content: 1, privacy_concern: 0 });
  });
  it('ignores events after opt-out and from unknown subjects', () => {
    expect(r.droppedEvents).toEqual({ afterOptOut: 2, unknownSubject: 1, unmatchedReferral: 0 });
    expect(r.funnel.card_quota_streak).toMatchObject({ report_viewed: 1, card_shared: 0 });
    expect(v.week4Retention).toMatchObject({ numerator: 0, denominator: 4 });
  });
  it('handles an empty experiment', () => {
    const e = aggregateExperiment([], [], { today: D0 });
    expect(e.variants.every(x => x.participants === 0 && x.week4Retention === null && x.supportIssues.per100Participants === null)).toBe(true);
  });
});

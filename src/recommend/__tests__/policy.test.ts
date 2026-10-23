import { describe, expect, it } from 'vitest';
import { decisionLogLine, inWorkingHours, parsePreferences, recommend, TASK_PROFILES } from '../policy.js';
import { fc, provider, runScenarios, SCENARIOS, SIM_NOW } from '../simulate.js';

const HOUR = 3_600_000;
const two = () => [provider('claude', [fc('claude', 'five_hour', { usedPercent: 20 })]), provider('chatgpt', [fc('chatgpt', 'five_hour', { usedPercent: 20 })])];

describe('simulation scenarios', () => {
  for (const r of runScenarios()) it(r.scenario.name, () => { expect({ action: r.result.action, provider: r.result.provider }).toEqual(r.scenario.expect); });
  it('is deterministic', () => { expect(runScenarios()).toEqual(runScenarios()); });
  it('covers the required scenarios', () => { expect(SCENARIOS.length).toBeGreaterThanOrEqual(9); });
});

describe('safety invariants', () => {
  it('never recommends an unauthenticated, offline, excluded or privacy-restricted provider', () => {
    for (const mod of [{ authenticated: false }, { health: 'offline' as const }, { privacyRestricted: true }]) {
      const r = recommend([provider('claude', [fc('claude', 'five_hour', { usedPercent: 0 })], mod), provider('chatgpt', [fc('chatgpt', 'five_hour', { usedPercent: 99 })])], {}, SIM_NOW);
      expect(r.provider).toBe('chatgpt');
      expect(r.considered.map(c => c.provider)).toEqual(['claude']);
    }
    const ex = recommend(two(), { excluded: ['claude', 'chatgpt'] }, SIM_NOW);
    expect(ex).toMatchObject({ action: 'none', noneReason: 'no_eligible_provider', provider: null });
  });
  it('a pin cannot force an ineligible or blocked provider', () => {
    const r = recommend([provider('claude', [fc('claude', 'five_hour')], { authenticated: false }), provider('chatgpt', [fc('chatgpt', 'five_hour')])], { pinned: 'claude' }, SIM_NOW);
    expect(r.provider).toBe('chatgpt');
    expect(r.warnings).toContain('pinned_ineligible');
    const b = recommend([provider('claude', [fc('claude', 'five_hour', { state: 'limited', usedPercent: 100, resetAt: SIM_NOW + HOUR })]), provider('chatgpt', [fc('chatgpt', 'five_hour')])], { pinned: 'claude' }, SIM_NOW);
    expect(b.provider).toBe('chatgpt');
    expect(b.warnings).toContain('pinned_blocked');
    expect(recommend(two().slice(1), { pinned: 'gemini' }, SIM_NOW).warnings).toContain('pinned_unavailable');
  });
  it('honours a pin when the pinned provider is usable, even if another scores higher', () => {
    const r = recommend([provider('claude', [fc('claude', 'five_hour', { usedPercent: 70 })]), provider('chatgpt', [fc('chatgpt', 'five_hour', { usedPercent: 5 })])], { pinned: 'claude' }, SIM_NOW);
    expect(r.provider).toBe('claude');
    expect(r.alternatives.map(a => a.provider)).toEqual(['chatgpt']);
  });
  it('disabled returns no recommendation', () => {
    expect(recommend(two(), { disabled: true }, SIM_NOW)).toMatchObject({ action: 'none', noneReason: 'disabled' });
  });
  it('stale or missing data is flagged and never high confidence', () => {
    const r = recommend([provider('claude', [fc('claude', 'five_hour', { state: 'stale', probabilityExhaustBeforeReset: null })])], {}, SIM_NOW);
    expect(r.warnings).toContain('stale_data');
    expect(r.confidence).toBe('low');
    const n = recommend([provider('gemini', [])], {}, SIM_NOW);
    expect(n.warnings).toContain('no_history');
    expect(n.confidence).toBe('low');
  });
  it('does not claim model quality', () => { expect(recommend(two(), {}, SIM_NOW).explanation).toMatch(/not model quality/); });
});

describe('policy details', () => {
  it('waits for the earliest reset, requiring every capped window to reset', () => {
    const r = recommend([
      provider('claude', [fc('claude', 'five_hour', { state: 'limited', usedPercent: 100, resetAt: SIM_NOW + HOUR }), fc('claude', 'weekly', { state: 'limited', usedPercent: 100, resetAt: SIM_NOW + 50 * HOUR })]),
      provider('chatgpt', [fc('chatgpt', 'five_hour', { state: 'limited', usedPercent: 100, resetAt: SIM_NOW + 2 * HOUR })])], {}, SIM_NOW);
    expect(r).toMatchObject({ action: 'wait', provider: 'chatgpt', waitUntil: SIM_NOW + 2 * HOUR });
  });
  it('waits with an unknown time when no reset is known', () => {
    const r = recommend([provider('claude', [fc('claude', 'five_hour', { state: 'limited', usedPercent: 100, resetAt: null })])], {}, SIM_NOW);
    expect(r).toMatchObject({ action: 'wait', provider: null, waitUntil: null, confidence: 'low' });
    expect(r.warnings).toContain('wait_until_unknown');
  });
  it('reserved quota reduces headroom', () => {
    const r = recommend([provider('claude', [fc('claude', 'five_hour', { usedPercent: 30 })])], { reservedPercent: 20 }, SIM_NOW);
    expect(r.alternatives).toEqual([]);
    expect(r.explanation).toContain('about 50%');
  });
  it('uses declared affinity only as a tie-break', () => {
    const tie = recommend(two(), { task: 'coding', affinity: { coding: ['chatgpt', 'claude'] } }, SIM_NOW);
    expect(tie.provider).toBe('chatgpt');
    const clear = recommend([provider('claude', [fc('claude', 'five_hour', { usedPercent: 10 })]), provider('chatgpt', [fc('chatgpt', 'five_hour', { usedPercent: 60 })])], { task: 'coding', affinity: { coding: ['chatgpt'] } }, SIM_NOW);
    expect(clear.provider).toBe('claude');
  });
  it('close calls and single candidates cap confidence at medium', () => {
    expect(recommend(two(), {}, SIM_NOW)).toMatchObject({ confidence: 'medium' });
    expect(recommend(two(), {}, SIM_NOW).warnings).toContain('close_call');
    expect(recommend(two().slice(0, 1), {}, SIM_NOW).warnings).toContain('single_candidate');
  });
  it('high risk, imminent limit and degraded health lower the score and warn', () => {
    const r = recommend([provider('claude', [fc('claude', 'five_hour', { probabilityExhaustBeforeReset: 0.9, projectedLimitAt: { earliest: SIM_NOW + 600_000, latest: null, display: 'range' } })], { health: 'degraded' })], {}, SIM_NOW);
    expect(r.warnings).toEqual(expect.arrayContaining(['high_exhaustion_risk', 'limit_expected_soon', 'degraded_provider']));
  });
  it('outside working hours five-hour risk is ignored', () => {
    const risky = [provider('claude', [fc('claude', 'five_hour', { usedPercent: 50, probabilityExhaustBeforeReset: 0.95 })]), provider('chatgpt', [fc('chatgpt', 'five_hour', { usedPercent: 60 })])];
    const wh = { startHour: 9, endHour: 17, utcOffsetMinutes: 0 };
    expect(recommend(risky, { workingHours: wh }, SIM_NOW).provider).toBe('chatgpt'); // 12:00 UTC, inside
    expect(recommend(risky, { workingHours: wh }, SIM_NOW + 8 * HOUR).provider).toBe('claude'); // 20:00 UTC, outside
  });
  it('working hours wrap midnight and honour the offset', () => {
    const night = { startHour: 22, endHour: 6, utcOffsetMinutes: 0 };
    expect(inWorkingHours(Date.UTC(2026, 9, 1, 23), night)).toBe(true);
    expect(inWorkingHours(Date.UTC(2026, 9, 1, 12), night)).toBe(false);
    expect(inWorkingHours(Date.UTC(2026, 9, 1, 12), { startHour: 9, endHour: 17, utcOffsetMinutes: -600 })).toBe(false); // 02:00 local
    expect(inWorkingHours(SIM_NOW, null)).toBe(true);
  });
  it('flags a capped window beside an open one as conflicting', () => {
    const r = recommend([provider('claude', [fc('claude', 'five_hour', { usedPercent: 5 }), fc('claude', 'weekly', { state: 'limited', usedPercent: 100 })]), provider('chatgpt', [fc('chatgpt', 'five_hour')])], {}, SIM_NOW);
    expect(r.provider).toBe('chatgpt');
  });
});

describe('parsePreferences', () => {
  it('falls back to defaults for junk', () => {
    expect(parsePreferences(null)).toMatchObject({ disabled: false, task: 'general', pinned: null, excluded: [], reservedPercent: 0, workingHours: null });
    expect(parsePreferences({ task: 'nope', pinned: 'bing', excluded: 'x', reservedPercent: 'a', workingHours: { startHour: 3, endHour: 3, utcOffsetMinutes: 0 } })).toMatchObject({ task: 'general', pinned: null, excluded: [], reservedPercent: 0, workingHours: null });
  });
  it('accepts valid values, clamps reserve and lets exclusion beat a pin', () => {
    const p = parsePreferences({ disabled: true, task: 'coding', pinned: 'claude', excluded: ['claude', 'gemini', 'gemini', 'bing'], reservedPercent: 140, workingHours: { startHour: 9, endHour: 17, utcOffsetMinutes: 60 }, affinity: { coding: ['gemini', 'claude', 'x'], writing: 'no' } });
    expect(p).toEqual({ disabled: true, task: 'coding', pinned: null, excluded: ['claude', 'gemini'], reservedPercent: 100, workingHours: { startHour: 9, endHour: 17, utcOffsetMinutes: 60 }, affinity: { coding: ['gemini', 'claude'] } });
    expect(parsePreferences({ pinned: 'chatgpt' }).pinned).toBe('chatgpt');
    expect(TASK_PROFILES).toEqual(['coding', 'research', 'writing', 'analysis', 'general']);
  });
});

describe('decisionLogLine', () => {
  it('is a single line without account aliases', () => {
    const line = decisionLogLine(recommend([provider('claude', [fc('claude', 'five_hour')], { accountAlias: 'secret-alias' }), provider('chatgpt', [], { authenticated: false })], {}, SIM_NOW));
    expect(line).toContain('action=use provider=claude');
    expect(line).toContain('chatgpt:unauthenticated');
    expect(line).not.toContain('secret-alias');
    expect(line).not.toContain('\n');
  });
});

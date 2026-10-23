import { describe, expect, it } from 'vitest';
import { recommend as recommendTs, parsePreferences as parseTs } from '../../src/recommend/policy.ts';
import { SCENARIOS, SIM_NOW } from '../../src/recommend/simulate.ts';
import { recommend, parsePreferences, inWorkingHours, DEFAULT_PREFERENCES } from '../autopilot/policy.mjs';
import { buildProviderInputs, coarseRisk } from '../autopilot/inputs.mjs';
import { buildViewModel, explainChange, snapshotOf, nextReset } from '../autopilot/view-model.mjs';
import { recKey, shouldRecordImpression, IMPRESSION_TTL_MS } from '../autopilot/store.mjs';
import { warningText, causeText, consideredText } from '../autopilot/messages.mjs';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const pick = (r) => ({
  action: r.action, noneReason: r.noneReason, provider: r.provider, waitUntil: r.waitUntil, confidence: r.confidence,
  alternatives: r.alternatives.map((a) => [a.provider, a.score, a.blocked]), considered: r.considered, warnings: [...r.warnings].sort(), inputsUsed: r.inputsUsed,
});

describe('policy parity with src/recommend/policy.ts', () => {
  for (const s of SCENARIOS) {
    it(`matches the TypeScript engine: ${s.name}`, () => {
      expect(pick(recommend(s.inputs, s.prefs, SIM_NOW))).toEqual(pick(recommendTs(s.inputs, s.prefs, SIM_NOW)));
    });
  }

  it('matches under pins, exclusions, reserve, disable and working hours', () => {
    const base = SCENARIOS[0].inputs;
    const variants = [
      { pinned: 'chatgpt' }, { pinned: 'claude', excluded: ['claude'] }, { excluded: ['claude', 'chatgpt'] }, { reservedPercent: 25 },
      { disabled: true }, { task: 'coding', affinity: { coding: ['chatgpt', 'claude'] } },
      { workingHours: { startHour: 9, endHour: 17, utcOffsetMinutes: 0 } }, { workingHours: { startHour: 22, endHour: 6, utcOffsetMinutes: 60 } },
    ];
    for (const raw of variants) {
      for (const s of SCENARIOS) {
        const prefs = parsePreferences(raw);
        const prefsTs = parseTs(raw);
        expect({ ...prefs, notificationFrequency: undefined }).toEqual({ ...prefsTs, notificationFrequency: undefined });
        expect(pick(recommend(s.inputs, prefs, SIM_NOW)), `${s.name} ${JSON.stringify(raw)}`).toEqual(pick(recommendTs(s.inputs, prefsTs, SIM_NOW)));
      }
      expect(recommend(base, parsePreferences(raw), SIM_NOW).action).toBe(recommendTs(base, parseTs(raw), SIM_NOW).action);
    }
  });

  it('parses malformed stored preferences to safe defaults', () => {
    expect(parsePreferences(null)).toEqual({ ...DEFAULT_PREFERENCES, excluded: [], affinity: {}, workingHours: null });
    expect(parsePreferences({ task: 'poetry', reservedPercent: 'lots', excluded: ['x', 'gemini'], pinned: 'gemini', notificationFrequency: 'hourly', workingHours: { startHour: 5, endHour: 5, utcOffsetMinutes: 0 } }))
      .toMatchObject({ task: 'general', reservedPercent: 0, excluded: ['gemini'], pinned: null, notificationFrequency: 'important', workingHours: null });
    expect(inWorkingHours(NOW, { startHour: 9, endHour: 17, utcOffsetMinutes: 0 })).toBe(true);
    expect(inWorkingHours(NOW, { startHour: 13, endHour: 17, utcOffsetMinutes: 0 })).toBe(false);
  });
});

const snap = (o = {}) => ({ ts: NOW - 60_000, accountId: 'a', pct5h: 20, pct7d: 10, resetsAt5h: NOW + 3 * HOUR, resetsAt7d: NOW + 3 * 24 * HOUR, ...o });
const fresh = { ok: true, stale: false, hasData: true };
const stats = (o = {}) => ({ providerUsage: {}, providerHealth: {}, usageHistory: [], ...o });

describe('buildProviderInputs', () => {
  it('treats a provider with no reading as unauthenticated so it is never recommended', () => {
    const inputs = buildProviderInputs(stats({ providerUsage: { chatgpt: snap({ pct5h: 50 }) }, providerHealth: { chatgpt: fresh } }), NOW);
    expect(inputs.find((i) => i.provider === 'claude')).toMatchObject({ authenticated: false, hasReading: false, forecasts: [] });
    const rec = recommend(inputs, DEFAULT_PREFERENCES, NOW);
    expect(rec).toMatchObject({ action: 'use', provider: 'chatgpt' });
    expect(rec.considered.map((c) => c.provider)).toEqual(['claude', 'gemini']);
  });

  it('marks auth_expired providers unauthenticated even when an old reading exists', () => {
    const inputs = buildProviderInputs(stats({ providerUsage: { claude: snap(), gemini: snap({ pct5h: 80 }) }, providerHealth: { claude: { ...fresh, ok: false, errorCategory: 'auth_expired' }, gemini: fresh } }), NOW);
    expect(inputs.find((i) => i.provider === 'claude').authenticated).toBe(false);
    expect(recommend(inputs, DEFAULT_PREFERENCES, NOW).provider).toBe('gemini');
  });

  it('reports a window at 100% as limited and stale health as stale', () => {
    const inputs = buildProviderInputs(stats({ providerUsage: { claude: snap({ pct5h: 100 }), chatgpt: snap() }, providerHealth: { claude: fresh, chatgpt: { ...fresh, stale: true } } }), NOW);
    expect(inputs.find((i) => i.provider === 'claude').forecasts.map((f) => f.state)).toEqual(['limited', 'insufficient_data']);
    expect(inputs.find((i) => i.provider === 'chatgpt').forecasts.every((f) => f.state === 'stale')).toBe(true);
  });

  it('gives sparse history an insufficient_data forecast with low confidence, never a risk', () => {
    const [claude] = buildProviderInputs(stats({ providerUsage: { claude: snap() }, providerHealth: { claude: fresh } }), NOW);
    expect(claude.forecasts[0]).toMatchObject({ state: 'insufficient_data', confidence: 'low', probabilityExhaustBeforeReset: null });
  });

  it('flags a steep burn as likely to exhaust before reset, with medium confidence at most', () => {
    const history = [0, 1, 2, 3, 4].map((i) => ({ site: 'claude', accountId: 'a', ts: NOW - (5 - i) * 15 * 60_000, pct5h: 30 + i * 10, pct7d: 10 }));
    const [claude] = buildProviderInputs(stats({ providerUsage: { claude: snap({ pct5h: 70 }) }, providerHealth: { claude: fresh }, usageHistory: history }), NOW);
    const f = claude.forecasts[0];
    expect(f).toMatchObject({ state: 'ok', method: 'trend', confidence: 'medium', probabilityExhaustBeforeReset: 0.85 });
    expect(f.projectedLimitAt.earliest).toBeGreaterThan(NOW);
  });

  it('coarseRisk returns null without enough points, span or a known reset', () => {
    const spec = { ms: 5 * HOUR, minSpanMs: 20 * 60_000 };
    const base = { history: [], pctKey: 'pct5h', usedPercent: 50, resetAt: NOW + HOUR, now: NOW, spec };
    expect(coarseRisk(base)).toBeNull();
    expect(coarseRisk({ ...base, resetAt: null })).toBeNull();
    const flat = [0, 1, 2, 3].map((i) => ({ ts: NOW - (40 - i * 10) * 60_000, pct5h: 50 }));
    expect(coarseRisk({ ...base, history: flat })).toMatchObject({ probability: 0.05 });
    const tight = [0, 1, 2, 3].map((i) => ({ ts: NOW - (3 - i) * 60_000, pct5h: 50 + i }));
    expect(coarseRisk({ ...base, history: tight })).toBeNull();
  });
});

describe('buildViewModel states', () => {
  const run = (st, prefs = DEFAULT_PREFERENCES) => {
    const inputs = buildProviderInputs(st, NOW);
    const rec = recommend(inputs, prefs, NOW);
    return { inputs, rec, vm: buildViewModel({ rec, inputs, prefs, now: NOW }) };
  };

  it('loading before a recommendation exists', () => {
    expect(buildViewModel({ rec: null, inputs: [], prefs: DEFAULT_PREFERENCES, now: NOW })).toEqual({ state: 'loading' });
  });

  it('insufficient data when no provider has a reading, and when none is eligible', () => {
    expect(run(stats()).vm).toMatchObject({ state: 'insufficient', reason: 'no_readings' });
    const { vm } = run(stats({ providerUsage: { claude: snap() }, providerHealth: { claude: fresh } }), { ...DEFAULT_PREFERENCES, excluded: ['claude'] });
    expect(vm).toMatchObject({ state: 'insufficient', reason: 'no_eligible_provider' });
  });

  it('disabled when the user turned recommendations off', () => {
    expect(run(stats({ providerUsage: { claude: snap() } }), { ...DEFAULT_PREFERENCES, disabled: true }).vm.state).toBe('disabled');
  });

  it('stale when the only data is stale, still showing low confidence', () => {
    const { vm } = run(stats({ providerUsage: { claude: snap() }, providerHealth: { claude: { ...fresh, stale: true } } }));
    expect(vm).toMatchObject({ state: 'stale', provider: 'claude', confidence: 'low' });
  });

  it('all_limited with the earliest reset', () => {
    const { vm } = run(stats({
      providerUsage: { claude: snap({ pct5h: 100, resetsAt5h: NOW + 2 * HOUR }), chatgpt: snap({ pct5h: 100, resetsAt5h: NOW + HOUR }) },
      providerHealth: { claude: fresh, chatgpt: fresh },
    }));
    expect(vm).toMatchObject({ state: 'all_limited', provider: 'chatgpt', waitUntil: NOW + HOUR });
  });

  it('ready: headroom, reset context, unranked alphabetical alternatives and a reserve', () => {
    const { vm, inputs } = run(stats({
      providerUsage: { claude: snap({ pct5h: 10 }), chatgpt: snap({ pct5h: 40 }), gemini: snap({ pct5h: 30 }) },
      providerHealth: { claude: fresh, chatgpt: fresh, gemini: fresh },
    }), { ...DEFAULT_PREFERENCES, reservedPercent: 10 });
    expect(vm).toMatchObject({ state: 'ready', provider: 'claude', headroomPercent: 80, resetAt: NOW + 3 * HOUR });
    expect(vm.alternatives).toEqual(['chatgpt', 'gemini']);
    expect(nextReset(inputs, 'claude', NOW)).toBe(NOW + 3 * HOUR);
    expect(nextReset(inputs, 'nobody', NOW)).toBeNull();
  });

  it('never recommends a signed-out provider whatever the user prefers', () => {
    const { rec } = run(stats({ providerUsage: { chatgpt: snap({ pct5h: 60 }) }, providerHealth: { chatgpt: fresh } }), { ...DEFAULT_PREFERENCES, pinned: 'claude' });
    expect(rec.provider).toBe('chatgpt');
    expect(rec.warnings).toContain('pinned_ineligible');
  });
});

describe('explainChange', () => {
  const mk = (provider, over = {}, prefs = DEFAULT_PREFERENCES) => {
    const status = { claude: { auth: true, limited: false, stale: false, used: 10 }, chatgpt: { auth: true, limited: false, stale: false, used: 30 }, ...over };
    return { at: NOW, action: provider ? 'use' : 'wait', provider, confidence: 'medium', status, prefsKey: JSON.stringify(prefs) };
  };

  it('is null when nothing changed or there is no previous recommendation', () => {
    expect(explainChange(null, mk('claude'))).toBeNull();
    expect(explainChange(mk('claude'), mk('claude'))).toBeNull();
  });

  it('names the quota or forecast event behind the change', () => {
    expect(explainChange(mk('claude'), mk('chatgpt', { claude: { auth: true, limited: true, stale: false, used: 100 } }))).toEqual({ key: 'limit_reached', provider: 'claude' });
    expect(explainChange(mk('claude'), mk('chatgpt', { claude: { auth: false, limited: false, stale: false, used: 10 } }))).toEqual({ key: 'signed_out', provider: 'claude' });
    expect(explainChange(mk('claude'), mk('chatgpt', { claude: { auth: true, limited: false, stale: true, used: 10 } }))).toEqual({ key: 'went_stale', provider: 'claude' });
    expect(explainChange(mk('claude'), mk('chatgpt'))).toEqual({ key: 'quota_changed', provider: 'chatgpt' });
    expect(explainChange(mk('claude'), mk(null, {}))).toEqual({ key: 'all_limited', provider: null });
    expect(explainChange(mk('claude'), mk('chatgpt', {}, { ...DEFAULT_PREFERENCES, task: 'coding' }))).toEqual({ key: 'preferences', provider: 'chatgpt' });
  });

  it('credits a reset or refresh of the newly recommended provider', () => {
    const before = mk('chatgpt', { claude: { auth: true, limited: true, stale: false, used: 100 } });
    expect(explainChange(before, mk('claude'))).toEqual({ key: 'reset', provider: 'claude' });
    expect(explainChange(mk('chatgpt', { claude: { auth: true, limited: false, stale: true, used: 10 } }), mk('claude'))).toEqual({ key: 'refreshed', provider: 'claude' });
  });

  it('snapshotOf stores only provider names, flags and percentages', () => {
    const inputs = buildProviderInputs(stats({ providerUsage: { claude: snap() }, providerHealth: { claude: fresh } }), NOW);
    const s = snapshotOf(recommend(inputs, DEFAULT_PREFERENCES, NOW), inputs, DEFAULT_PREFERENCES, NOW);
    expect(Object.keys(s).sort()).toEqual(['action', 'at', 'confidence', 'prefsKey', 'provider', 'status']);
    expect(s.status.claude).toEqual({ auth: true, limited: false, stale: false, used: 20 });
    expect(JSON.stringify(s)).not.toMatch(/accountId|email|@/);
  });
});

describe('impression de-duplication and message helpers', () => {
  it('records one impression per distinct recommendation per six hours', () => {
    const key = recKey({ action: 'use', provider: 'claude', confidence: 'high' });
    expect(key).toBe('use:claude:high');
    expect(shouldRecordImpression(null, key, NOW)).toBe(true);
    expect(shouldRecordImpression({ key, at: NOW - HOUR }, key, NOW)).toBe(false);
    expect(shouldRecordImpression({ key, at: NOW - IMPRESSION_TTL_MS }, key, NOW)).toBe(true);
    expect(shouldRecordImpression({ key: 'wait:-:low', at: NOW - 1 }, key, NOW)).toBe(true);
  });

  it('falls back to English text and null for unknown codes', () => {
    const t = (_k, _s, fallback) => fallback;
    expect(warningText(t, 'stale_data')).toBe('Quota data is out of date.');
    expect(warningText(t, 'made_up')).toBeNull();
    expect(consideredText(t, 'excluded', 'Claude')).toBe('Claude: excluded by you');
    expect(consideredText(t, 'nope', 'Claude')).toBeNull();
    expect(causeText(t, 'limit_reached', 'Claude')).toBe('Claude reached its limit');
    expect(causeText(t, 'unknown_cause', 'Claude')).toBe('quota readings changed');
  });
});

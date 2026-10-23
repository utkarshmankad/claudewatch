import type { Forecast } from '../forecast/engine.js';
import type { Provider, WindowType } from '../ledger/types.js';
import { recommend } from './policy.js';
import type { Preferences, ProviderInput, Recommendation } from './policy.js';

// Simulation harness: named scenarios with synthetic forecasts, run through the real policy.
// Synthetic data only; it demonstrates behaviour, not product accuracy. See docs/RECOMMENDATIONS.md.

export const SIM_NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const HOUR = 3_600_000;

export function fc(provider: Provider, window: WindowType, o: Partial<Forecast> = {}): Forecast {
  return {
    provider, accountAlias: 'main', window, state: 'ok', method: 'trend', usedPercent: 20, asOf: SIM_NOW - 60_000, resetAt: SIM_NOW + 3 * HOUR, hoursToReset: 3,
    reservedPercent: 0, burnPerHour: { low: 4, point: 5, high: 6 }, safeHourlyAllowance: 26, projectedLimitAt: null, probabilityExhaustBeforeReset: 0.03,
    confidence: 'high', reasons: [], explanation: '', ...o,
  };
}
export const provider = (p: Provider, forecasts: Forecast[], o: Partial<ProviderInput> = {}): ProviderInput =>
  ({ provider: p, accountAlias: 'main', authenticated: true, health: 'ok', forecasts, ...o });

export interface Scenario { name: string; inputs: ProviderInput[]; prefs: Partial<Preferences>; expect: { action: Recommendation['action']; provider: Provider | null } }

const limited = (p: Provider, w: WindowType, resetIn: number) => fc(p, w, { state: 'limited', usedPercent: 100, probabilityExhaustBeforeReset: 1, resetAt: SIM_NOW + resetIn * HOUR, hoursToReset: resetIn, safeHourlyAllowance: 0 });
const stale = (p: Provider, w: WindowType) => fc(p, w, { state: 'stale', asOf: SIM_NOW - 4 * HOUR, probabilityExhaustBeforeReset: null, burnPerHour: null, confidence: 'low' });

export const SCENARIOS: Scenario[] = [
  { name: 'abundant quota', inputs: [provider('claude', [fc('claude', 'five_hour', { usedPercent: 10 })]), provider('chatgpt', [fc('chatgpt', 'five_hour', { usedPercent: 30 })])], prefs: {}, expect: { action: 'use', provider: 'claude' } },
  { name: 'imminent block on the leader', inputs: [
    provider('claude', [fc('claude', 'five_hour', { usedPercent: 55, probabilityExhaustBeforeReset: 0.95, projectedLimitAt: { earliest: SIM_NOW + 15 * 60_000, latest: SIM_NOW + 40 * 60_000, display: 'range' } })]),
    provider('chatgpt', [fc('chatgpt', 'five_hour', { usedPercent: 45 })])], prefs: {}, expect: { action: 'use', provider: 'chatgpt' } },
  { name: 'stale provider data', inputs: [provider('claude', [stale('claude', 'five_hour')]), provider('chatgpt', [fc('chatgpt', 'five_hour', { usedPercent: 60 })])], prefs: {}, expect: { action: 'use', provider: 'chatgpt' } },
  { name: 'one provider offline', inputs: [provider('claude', [fc('claude', 'five_hour', { usedPercent: 5 })], { health: 'offline' }), provider('chatgpt', [fc('chatgpt', 'five_hour', { usedPercent: 70 })])], prefs: {}, expect: { action: 'use', provider: 'chatgpt' } },
  { name: 'conflicting windows', inputs: [provider('claude', [fc('claude', 'five_hour', { usedPercent: 5 }), limited('claude', 'weekly', 40)]), provider('chatgpt', [fc('chatgpt', 'five_hour', { usedPercent: 50 })])], prefs: {}, expect: { action: 'use', provider: 'chatgpt' } },
  { name: 'no history', inputs: [provider('claude', []), provider('gemini', [])], prefs: {}, expect: { action: 'use', provider: 'claude' } },
  { name: 'privacy restriction', inputs: [provider('claude', [fc('claude', 'five_hour', { usedPercent: 5 })], { privacyRestricted: true }), provider('chatgpt', [fc('chatgpt', 'five_hour', { usedPercent: 60 })])], prefs: {}, expect: { action: 'use', provider: 'chatgpt' } },
  { name: 'all providers limited', inputs: [provider('claude', [limited('claude', 'five_hour', 2)]), provider('chatgpt', [limited('chatgpt', 'five_hour', 1)])], prefs: {}, expect: { action: 'wait', provider: 'chatgpt' } },
  { name: 'unauthenticated provider is never chosen', inputs: [provider('claude', [fc('claude', 'five_hour', { usedPercent: 1 })], { authenticated: false }), provider('chatgpt', [fc('chatgpt', 'five_hour', { usedPercent: 90 })])], prefs: {}, expect: { action: 'use', provider: 'chatgpt' } },
];

export function runScenarios(scenarios: Scenario[] = SCENARIOS, now = SIM_NOW): Array<{ scenario: Scenario; result: Recommendation; pass: boolean }> {
  return scenarios.map(s => {
    const result = recommend(s.inputs, s.prefs, now);
    return { scenario: s, result, pass: result.action === s.expect.action && result.provider === s.expect.provider };
  });
}

import { describe, it, expect } from 'vitest';
import { computeSoak, renderReport, parseExport } from '../../scripts/soak-24h-lib.mjs';

const T0 = Date.parse('2026-10-24T00:00:00Z');
const m = min => T0 + min * 60000;
const refresh = (min, ok, errorCategory = 'none') => ({ v: 1, name: 'refresh_result', ts: m(min), props: { provider: 'claude', ok, errorCategory, trigger: 'alarm', durationMs: 10 } });
const ended = (min, staleSeconds, explained) => ({ v: 1, name: 'stale_ended', ts: m(min), props: { provider: 'claude', staleSeconds, explained } });

describe('computeSoak (synthetic events, test only)', () => {
  const events = [refresh(1, true), refresh(6, false, 'network'), refresh(11, false, 'provider_tab_missing'), refresh(121, true), ended(121, 1200, true), ended(300, 900, false), refresh(2000, true)];
  const r = computeSoak({ events }, { startAt: T0, endAt: m(1440), restartedAt: m(100), networkCutAt: m(5), networkRestoredAt: m(7) });

  it('applies the contract exclusion and denominator', () => {
    expect(r.refreshAttempts).toBe(4);
    expect(r.excludedProviderTabMissing).toBe(1);
    expect(r.denominator).toBe(3);
    expect(r.successRate).toBeCloseTo(2 / 3);
  });
  it('ignores events outside the window', () => { expect(r.refreshAttempts).toBe(4); });
  it('computes unexplained stale metrics', () => {
    expect(r.unexplainedStaleEnded).toBe(1);
    expect(r.maxUnexplainedStaleSeconds).toBe(900);
    expect(r.maxStaleSeconds).toBe(1200);
  });
  it('measures recovery from markers', () => {
    expect(r.restartRecovery).toMatchObject({ status: 'measured', seconds: 21 * 60 });
    expect(r.networkRestoreRecovery.seconds).toBe(114 * 60);
  });
  it('reports unknown rather than zero when there is no data', () => {
    const e = computeSoak({ events: [] }, { startAt: T0, endAt: m(10) });
    expect(e.successRate).toBeNull();
    expect(e.maxUnexplainedStaleSeconds).toBeNull();
    expect(e.requiredMarkersMissing).toHaveLength(3);
    expect(renderReport(e, { buildSha: 'x', exportedAt: 'y' })).toContain('shorter than 24 h');
  });
  it('rejects non-exports', () => { expect(() => parseExport('{"events":[]}')).toThrow(); });
});

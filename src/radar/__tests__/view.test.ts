import { describe, expect, it } from 'vitest';
import type { Incident } from '../detect.js';
import { DEFAULT_NOTIFY_PREFS, notificationKey, selectNotifications, validatePrefs } from '../notify.js';
import { RADAR_DISCLAIMER, buildRadarView, confidenceLabel } from '../view.js';
import { buildDiagnosticReport, exportReport, previewReport } from '../diagnostics.js';

const inc = (over: Partial<Incident> = {}): Incident => ({
  id: 'i1', kind: 'parser_failure', provider: 'claude', planTypes: ['free'], regionBuckets: [], windowTypes: ['daily'],
  firstObserved: '2026-10-24T06:00:00Z', lastObserved: '2026-10-24T12:00:00Z', status: 'active', confidence: 0.8, sampleBand: '50-199', evidence: 'rate rose', ...over,
});

describe('radar view', () => {
  it('is empty with the beta disclaimer when there are no incidents', () => {
    const v = buildRadarView([], 1);
    expect(v.state).toBe('empty');
    expect(v.beta).toBe(true);
    expect(v.disclaimer).toBe(RADAR_DISCLAIMER);
    expect(v.disclaimer).toMatch(/not provider announcements/);
  });

  it('shows scope, first observed, confidence, sample band, workaround and resolution', () => {
    const [i] = buildRadarView([inc()], 1).incidents;
    expect(i).toMatchObject({ providerLabel: 'Claude', plans: ['Free'], regions: ['All observed regions'], firstObserved: '2026-10-24T06:00:00Z', confidenceLabel: 'high', sampleBand: '50-199' });
    expect(i!.workaround.length).toBeGreaterThan(10);
    expect(i!.resolution).toMatch(/Ongoing/);
  });

  it('orders active before resolved and reports no_active', () => {
    const r = inc({ id: 'r', status: 'resolved', firstObserved: '2026-10-25T00:00:00Z' });
    const v = buildRadarView([r, inc()], 1);
    expect(v.incidents.map(i => i.id)).toEqual(['i1', 'r']);
    expect(buildRadarView([r], 1).state).toBe('no_active');
  });

  it('hides everything when Radar is off and exposes only the allowed fields', () => {
    expect(buildRadarView([inc()], 1, false)).toMatchObject({ state: 'disabled', incidents: [] });
    expect(Object.keys(buildRadarView([inc()], 1).incidents[0]!).sort()).toEqual(
      ['confidence', 'confidenceLabel', 'evidence', 'firstObserved', 'id', 'kind', 'lastObserved', 'plans', 'provider', 'providerLabel', 'regions', 'resolution', 'sampleBand', 'status', 'title', 'workaround']);
  });

  it('labels confidence at 0.5 and 0.75', () => {
    expect([0.2, 0.5, 0.74, 0.75].map(confidenceLabel)).toEqual(['low', 'medium', 'medium', 'high']);
  });
});

describe('notification controls', () => {
  const on = { ...DEFAULT_NOTIFY_PREFS, enabled: true };
  it('is off by default', () => {
    expect(DEFAULT_NOTIFY_PREFS.enabled).toBe(false);
    expect(selectNotifications([inc()], DEFAULT_NOTIFY_PREFS, new Set())).toEqual([]);
  });
  it('filters by confidence, provider, kind and resolved', () => {
    expect(selectNotifications([inc()], on, new Set())).toHaveLength(1);
    expect(selectNotifications([inc({ confidence: 0.4 })], on, new Set())).toHaveLength(0);
    expect(selectNotifications([inc()], { ...on, providers: ['gemini'] }, new Set())).toHaveLength(0);
    expect(selectNotifications([inc()], { ...on, kinds: ['provider_error_spike'] }, new Set())).toHaveLength(0);
    expect(selectNotifications([inc({ status: 'resolved' })], on, new Set())).toHaveLength(0);
    expect(selectNotifications([inc({ status: 'resolved' })], { ...on, notifyOnResolved: true }, new Set())).toHaveLength(1);
  });
  it('does not repeat a notification already sent', () => {
    expect(selectNotifications([inc()], on, new Set([notificationKey(inc())]))).toHaveLength(0);
    expect(selectNotifications([inc({ status: 'resolved' })], { ...on, notifyOnResolved: true }, new Set([notificationKey(inc())]))).toHaveLength(1);
  });
  it('validates preferences strictly', () => {
    expect(validatePrefs({ ...on }).ok).toBe(true);
    for (const bad of [null, [], { ...on, extra: 1 }, { ...on, minConfidence: 2 }, { ...on, providers: ['nope'] }, { ...on, kinds: 'x' }, { ...on, enabled: 'yes' }])
      expect(validatePrefs(bad).ok, JSON.stringify(bad)).toBe(false);
  });
});

describe('diagnostic report', () => {
  const input = {
    appVersion: '0.1.1', extensionVersion: 'user@example.com', radarContributionEnabled: true, radarNotificationsEnabled: false,
    remoteConfigVersion: 3, audit: [{ at: 1, action: 'applied' as const, version: 3, reason: 'secret reason' }, { at: 2, action: 'applied' as const, version: 4, reason: 'x' }],
    parserCounts: [{ provider: 'claude' as const, parserResult: 'ok' as const, count: 5 }, { provider: 'claude' as const, parserResult: 'ok' as const, count: 2 }, { provider: 'evil' as never, parserResult: 'ok' as const, count: 1 }],
  };
  it('contains only counts, versions and flags', () => {
    const r = buildDiagnosticReport(input);
    expect(r.extensionVersion).toBe('unknown');
    expect(r.remoteConfigEvents).toEqual({ applied: 2 });
    expect(r.parserResults).toEqual([{ provider: 'claude', parserResult: 'ok', count: 7 }]);
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/example\.com|secret reason|evil/);
  });
  it('previews every field and requires review before export', () => {
    const r = buildDiagnosticReport(input);
    const p = previewReport(r);
    expect(p.requiresReview).toBe(true);
    expect(p.fields.map(f => f.name)).toEqual(Object.keys(r));
    expect(() => exportReport(r, false)).toThrow(/Review/);
    expect(JSON.parse(exportReport(r, true))).toEqual(r);
  });
});

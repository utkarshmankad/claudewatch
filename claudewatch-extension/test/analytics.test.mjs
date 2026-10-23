import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let A;
beforeAll(async () => {
  globalThis.self = {};
  await import('../analytics.js');
  A = self.TokenWatcherAnalytics;
});

const DAY = 86_400_000;
const memoryStorage = () => {
  const data = new Map();
  return {
    get: async k => data.get(k) ?? null,
    set: async (k, v) => { data.set(k, structuredClone(v)); },
    remove: async k => { data.delete(k); },
    data,
  };
};
const ev = (name, props = {}, ts = 1_000) => ({ v: 1, name, ts, props });

describe('event schema', () => {
  it('accepts a well-formed event for every defined name', () => {
    const samples = {
      installed: {}, onboarding_completed: {}, provider_connected: { provider: 'claude' },
      first_useful_reading: { provider: 'gemini', secondsSinceInstall: 30 },
      first_recommendation: { kind: 'plan' },
      refresh_result: { provider: 'chatgpt', ok: true, errorCategory: 'none', trigger: 'alarm', durationMs: 120 },
      stale_started: { provider: 'claude', reason: 'auth_expired', explained: true },
      stale_ended: { provider: 'claude', staleSeconds: 900, explained: true },
      attribution_measured: { attributedUnits: 8, eligibleUnits: 10 },
      alert_shown: { level: 'warn', provider: 'claude' },
      alert_action: { action: 'wait', provider: 'claude' },
      report_shared: { channel: 'copy' },
      active_day: { surface: 'popup' },
      recommendation_impression: { action: 'use', provider: 'claude', confidence: 'medium', state: 'ready' },
      explanation_viewed: { action: 'wait' },
      autopilot_alert_shown: { kind: 'block_likely', arm: 'autopilot' }, autopilot_alert_action: { action: 'dismiss', kind: 'threshold' },
      alert_feedback: { verdict: 'false_positive' }, experiment_assigned: { arm: 'threshold' },
      provider_opened: { provider: 'gemini', source: 'alternative' },
      wait_chosen: { provider: 'none' },
      recommendation_dismissed: { action: 'use' },
      preference_changed: { setting: 'reserved' },
      autopilot_toggled: { enabled: false },
    };
    expect(Object.keys(samples).sort()).toEqual(Object.keys(A.EVENT_DEFINITIONS).sort());
    for (const [name, props] of Object.entries(samples)) expect(A.validateEvent(ev(name, props)), name).toEqual({ ok: true, errors: [] });
  });

  it('rejects unknown events, unknown props, bad enums, ranges and missing props', () => {
    expect(A.validateEvent(ev('prompt_sent')).errors).toContain('unknown_event:prompt_sent');
    expect(A.validateEvent(ev('provider_connected', { provider: 'claude', plan: 'pro' })).errors).toContain('unknown_prop:plan');
    expect(A.validateEvent(ev('provider_connected', { provider: 'openai' })).errors).toContain('invalid_prop:provider');
    expect(A.validateEvent(ev('first_useful_reading', { provider: 'claude', secondsSinceInstall: -1 })).errors).toContain('invalid_prop:secondsSinceInstall');
    expect(A.validateEvent(ev('provider_connected')).errors).toContain('missing_prop:provider');
    expect(A.validateEvent({ ...ev('installed'), extra: 1 }).errors).toContain('unknown_field:extra');
    expect(A.validateEvent(ev('installed', {}, NaN)).errors).toContain('invalid_ts');
    expect(A.validateEvent(null).ok).toBe(false);
  });

  it.each([
    'promptText', 'prompt', 'responseBody', 'cookie', 'cookies', 'sessionKey', 'sessionToken', 'accessToken',
    'authorization', 'credentials', 'password', 'secret', 'email', 'accountId', 'organizationId', 'orgId',
    'userId', 'deviceId', 'conversationTitle', 'pageUrl', 'url', 'domContent', 'html', 'attachment', 'displayName',
  ])('rejects prohibited field name %s', key => {
    const result = A.validateEvent(ev('provider_connected', { provider: 'claude', [key]: 'x' }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`prohibited_field:${key}`);
  });

  it.each([
    ['e-mail', 'someone@example.com'],
    ['URL', 'https://claude.ai/chat/abc'],
    ['UUID', '3f2b8c1e-9d4a-4b7e-8a6f-1c2d3e4f5a6b'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123'],
    ['API key', 'sk-ant-api03-abcdefghijkl'],
    ['opaque blob', 'QWxhZGRpbjpvcGVuIHNlc2FtZVF1aWNrQnJvd25Gb3g'],
  ])('rejects prohibited value shape: %s', (_label, value) => {
    const result = A.validateEvent(ev('provider_connected', { provider: 'claude', kind: value }));
    expect(result.errors).toContain('prohibited_value:kind');
  });

  it('never stores a rejected event', async () => {
    const storage = memoryStorage();
    const store = A.createStore(storage, { clock: () => 5_000 });
    expect(await store.record('provider_connected', { provider: 'claude', email: 'a@b.co' })).toMatchObject({ ok: false });
    expect(await store.record('provider_connected', { provider: 'claude', note: 'https://claude.ai' })).toMatchObject({ ok: false });
    expect(await store.list()).toEqual([]);
    expect(JSON.stringify([...storage.data.values()])).not.toMatch(/a@b\.co|claude\.ai/);
  });

  it('keeps the committed JSON schema in sync with the code', () => {
    const file = fileURLToPath(new URL('../../docs/product-hunt/baseline/event-schema.v1.json', import.meta.url));
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.schemaVersion).toBe(A.SCHEMA_VERSION);
    expect(doc.retention).toEqual({ maxAgeDays: 90, maxEvents: 5000 });
    expect(doc.events).toEqual(JSON.parse(JSON.stringify(A.EVENT_DEFINITIONS)));
  });
});

describe('store and retention', () => {
  it('records valid events and anchors install time', async () => {
    const store = A.createStore(memoryStorage(), { clock: () => 10_000 });
    expect((await store.record('installed', {})).ok).toBe(true);
    expect((await store.meta()).installedAt).toBe(10_000);
    expect(await store.list()).toHaveLength(1);
  });

  it('prunes events older than 90 days and caps the log at 5000', () => {
    const now = 200 * DAY;
    const events = [ev('installed', {}, now - 91 * DAY), ev('installed', {}, now - 89 * DAY)];
    expect(A.prune(events, now)).toHaveLength(1);
    const many = Array.from({ length: 5100 }, (_, i) => ev('installed', {}, now - 1000 + i));
    expect(A.prune(many, now + 6000)).toHaveLength(5000);
  });

  it('serializes concurrent writes without losing events', async () => {
    const store = A.createStore(memoryStorage(), { clock: () => 1_000 });
    await Promise.all(Array.from({ length: 25 }, () => store.record('report_shared', { channel: 'copy' })));
    expect(await store.list()).toHaveLength(25);
  });

  it('records one active_day per surface per local day', async () => {
    const store = A.createStore(memoryStorage());
    const t = new Date(2026, 0, 5, 9).getTime();
    await store.recordActiveDay('popup', t);
    await store.recordActiveDay('popup', t + 3600_000);
    await store.recordActiveDay('settings', t);
    await store.recordActiveDay('popup', t + DAY);
    expect((await store.list()).map(e => e.props.surface)).toEqual(['popup', 'settings', 'popup']);
  });

  it('clear deletes events and install anchor; export contains schema version', async () => {
    const store = A.createStore(memoryStorage());
    await store.record('installed', {});
    expect(JSON.parse(await store.exportJson())).toMatchObject({ schemaVersion: 1, events: [{ name: 'installed' }] });
    await store.clear();
    expect(await store.list()).toEqual([]);
    expect(await store.meta()).toEqual({});
  });
});

describe('error categories', () => {
  it.each([
    ['provider_tab_missing', 0, 'provider_tab_missing'],
    ['provider_tab_timeout', 0, 'provider_tab_timeout'],
    ['chatgpt_refresh_timeout', 0, 'timeout'],
    ['provider_schema_changed', 200, 'provider_schema_changed'],
    ['HTTP 401', 401, 'auth_expired'],
    ['whatever', 429, 'rate_limited'],
    ['Failed to fetch', 0, 'network'],
    ['strange', 500, 'other'],
    [null, 0, 'other'],
  ])('%s/%s -> %s', (error, status, expected) => expect(A.categorizeError(error, status)).toBe(expected));
});

describe('metrics', () => {
  const byId = (metrics, id) => metrics.find(m => m.id === id);

  it('reports unknown for every metric when there is no evidence', () => {
    const metrics = A.computeMetrics([], {}, 100 * DAY);
    for (const m of metrics) expect(m.value, m.id).toBe('unknown');
  });

  it('computes rates from events and excludes provider_tab_missing from refresh success', () => {
    const events = [
      ev('refresh_result', { provider: 'claude', ok: true, errorCategory: 'none', trigger: 'alarm', durationMs: 1 }),
      ev('refresh_result', { provider: 'claude', ok: false, errorCategory: 'auth_expired', trigger: 'alarm', durationMs: 1 }),
      ev('refresh_result', { provider: 'gemini', ok: false, errorCategory: 'provider_tab_missing', trigger: 'alarm', durationMs: 1 }),
      ev('provider_connected', { provider: 'claude' }),
      ev('alert_shown', { level: 'warn', provider: 'claude' }),
      ev('alert_shown', { level: 'high', provider: 'claude' }),
      ev('alert_action', { action: 'wait', provider: 'claude' }),
      ev('alert_action', { action: 'dismiss', provider: 'claude' }),
      ev('stale_ended', { provider: 'claude', staleSeconds: 600, explained: true }),
      ev('stale_ended', { provider: 'claude', staleSeconds: 1800, explained: false }),
      ev('attribution_measured', { attributedUnits: 8, eligibleUnits: 10 }),
    ];
    const m = A.computeMetrics(events, { installedAt: 1 }, 2_000);
    expect(byId(m, 'refresh_success_rate')).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
    expect(byId(m, 'provider_connection_rate').value).toBeCloseTo(1 / 3);
    expect(byId(m, 'alert_action_rate')).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
    expect(byId(m, 'stale_duration_p50_seconds').value).toBe(600);
    expect(byId(m, 'stale_duration_max_seconds').value).toBe(1800);
    expect(byId(m, 'unexplained_stale_rate').value).toBe(0.5);
    expect(byId(m, 'attribution_coverage').value).toBe(0.8);
    expect(byId(m, 'activation').value).toBe(0);
  });

  it('computes week-four retention only once 35 days of history exist', () => {
    const active = ev('active_day', { surface: 'popup' }, 30 * DAY);
    expect(byId(A.computeMetrics([active], { installedAt: 0 }, 34 * DAY), 'week4_retention').value).toBe('unknown');
    expect(byId(A.computeMetrics([active], { installedAt: 0 }, 36 * DAY), 'week4_retention').value).toBe(1);
    expect(byId(A.computeMetrics([], { installedAt: 0 }, 36 * DAY), 'week4_retention').value).toBe(0);
  });

  it('computes time to first reading and recommendation', () => {
    const events = [
      ev('first_useful_reading', { provider: 'claude', secondsSinceInstall: 42 }),
      ev('first_recommendation', { kind: 'plan' }, 5_000),
    ];
    const m = A.computeMetrics(events, { installedAt: 1_000 }, 9_000);
    expect(byId(m, 'first_useful_reading_seconds').value).toBe(42);
    expect(byId(m, 'first_recommendation_seconds').value).toBe(4);
    expect(byId(m, 'activation').value).toBe(1);
  });
});

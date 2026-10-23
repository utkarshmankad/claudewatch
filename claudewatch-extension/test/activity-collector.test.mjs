import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateRecord } from '../../src/ledger/validate.js';
import { append } from '../../src/ledger/ledger.js';

let Act;
beforeAll(async () => {
  globalThis.self = { crypto: globalThis.crypto };
  await import('../activity-collector.js');
  Act = self.TokenWatcherActivity;
});

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);
const memoryStorage = () => {
  const data = new Map();
  return {
    get: async k => (data.has(k) ? structuredClone(data.get(k)) : null),
    set: async (k, v) => { data.set(k, structuredClone(v)); },
    remove: async k => { data.delete(k); },
    data,
  };
};
const hex = n => n.toString(16).padStart(32, '0');
const ev = (n, over = {}) => ({ v: 1, id: hex(n), provider: 'claude', ts: T0 + n, sessionId: 'a'.repeat(16), activityType: 'message_completed', ...over });
const enabledStore = async (opts) => {
  const storage = memoryStorage();
  const store = Act.createStore(storage, opts);
  await store.setEnabled(true);
  return { store, storage };
};

describe('validation', () => {
  it('accepts a well-formed event with and without a model', () => {
    expect(Act.validateActivity(ev(1)).ok).toBe(true);
    expect(Act.validateActivity(ev(1, { model: 'claude-sonnet-5-5' })).ok).toBe(true);
  });
  it.each([
    ['unknown field (prompt text)', { prompt: 'hello' }],
    ['url field', { url: 'https://claude.ai/chat/abc' }],
    ['conversation title', { title: 'My secret plan' }],
    ['bad provider', { provider: 'bing' }],
    ['bad activity type', { activityType: 'typing' }],
    ['model with spaces/text', { model: 'a model with free text' }],
    ['timestamp out of range', { ts: 5 }],
    ['non-integer ts', { ts: 1.5e12 + 0.5 }],
    ['bad session id', { sessionId: 'https://x.test' }],
    ['bad id', { id: 'nope' }],
    ['wrong schema version', { v: 2 }],
  ])('rejects %s', (_label, over) => {
    expect(Act.validateActivity(ev(1, over)).ok).toBe(false);
  });
  it('rejects non-objects without throwing', () => {
    for (const bad of [null, undefined, 'x', 3, []]) expect(Act.validateActivity(bad).ok).toBe(false);
  });
});

describe('opt-in and deletion', () => {
  it('records nothing until enabled', async () => {
    const store = Act.createStore(memoryStorage());
    expect(await store.isEnabled()).toBe(false);
    expect(await store.record(ev(1))).toEqual({ ok: false, reason: 'not_enabled' });
    expect(await store.list()).toEqual([]);
  });
  it('rejects invalid events even when enabled', async () => {
    const { store } = await enabledStore();
    const r = await store.record(ev(1, { prompt: 'secret' }));
    expect(r.ok).toBe(false);
    expect(await store.list()).toEqual([]);
  });
  it('clear removes events and session ids immediately', async () => {
    const { store, storage } = await enabledStore();
    await store.sessionFor(1, 'e1');
    await store.record(ev(1));
    await store.clear();
    expect(await store.list()).toEqual([]);
    expect([...storage.data.keys()].filter(k => k !== 'activity_settings_v1')).toEqual([]);
    expect(await store.isEnabled()).toBe(true);
  });
  it('turning collection off deletes what was collected', async () => {
    const { store } = await enabledStore();
    await store.record(ev(1));
    await store.setEnabled(false);
    expect(await store.list()).toEqual([]);
    expect(await store.isEnabled()).toBe(false);
  });
  it('lists the fields it records and never records', () => {
    expect(Act.RECORDED_FIELDS.length).toBeGreaterThan(3);
    expect(Act.NEVER_RECORDED.join(' ')).toMatch(/Prompt or response text/);
    expect(Act.NEVER_RECORDED.join(' ')).toMatch(/Full URLs/);
  });
});

describe('durability across service worker restarts', () => {
  it('re-delivered events are stored once', async () => {
    const { store } = await enabledStore();
    expect((await store.record(ev(1))).duplicate).toBe(false);
    expect((await store.record(ev(1))).duplicate).toBe(true);
    expect(await store.list()).toHaveLength(1);
  });
  it('a fresh store over the same storage (restart) sees prior events and does not duplicate', async () => {
    const { store, storage } = await enabledStore();
    await store.record(ev(1));
    const restarted = Act.createStore(storage);
    expect((await restarted.record(ev(1))).duplicate).toBe(true);
    await restarted.record(ev(2));
    expect((await restarted.list()).map(e => e.id)).toEqual([hex(1), hex(2)]);
  });
  it('concurrent writes from several tabs lose nothing and duplicate nothing', async () => {
    const { store } = await enabledStore();
    await Promise.all([1, 2, 3, 4, 5, 3, 2, 1].map(n => store.record(ev(n))));
    expect((await store.list()).map(e => e.id)).toEqual([1, 2, 3, 4, 5].map(hex));
  });
});

describe('sessions: multiple tabs, accounts and navigation', () => {
  it('gives each tab its own stable session id', async () => {
    const { store } = await enabledStore();
    const a = await store.sessionFor(10, 'e1');
    const b = await store.sessionFor(11, 'e1');
    expect(a).not.toBe(b);
    expect(await store.sessionFor(10, 'e1')).toBe(a);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });
  it('session ids survive a restart and reset on a new browser run', async () => {
    const { store, storage } = await enabledStore();
    const a = await store.sessionFor(10, 'e1');
    expect(await Act.createStore(storage).sessionFor(10, 'e1')).toBe(a);
    expect(await store.sessionFor(10, 'e2')).not.toBe(a);
  });
  it('navigating between conversations keeps one session because no conversation data is read', async () => {
    const { store } = await enabledStore();
    const s = await store.sessionFor(10, 'e1');
    await store.record(ev(1, { sessionId: s }));
    await store.record(ev(2, { sessionId: s }));
    const sessions = new Set((await store.list()).map(e => e.sessionId));
    expect(sessions.size).toBe(1);
  });
  it('events carry no account identifier, so multiple signed-in accounts share the caller-supplied alias', async () => {
    const { store } = await enabledStore();
    await store.record(ev(1));
    for (const e of await store.list()) {
      expect(Object.keys(e).sort()).toEqual(['activityType', 'id', 'provider', 'sessionId', 'ts', 'v']);
    }
  });
});

describe('failed requests and retention', () => {
  it('stores failed attempts but does not forward them to the ledger as usage', async () => {
    const { store } = await enabledStore();
    await store.record(ev(1, { activityType: 'message_failed' }));
    await store.record(ev(2));
    const inputs = Act.toLedgerInputs(await store.list(), { accountAlias: 'default', devicePseudonym: 'ab'.repeat(8), ingestedAt: T0 + 1000 });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].observedAt).toBe(T0 + 2);
  });
  it('drops events older than 30 days and caps the count', async () => {
    let clock = T0;
    const { store } = await enabledStore({ now: () => clock });
    await store.record(ev(1));
    clock = T0 + 31 * DAY;
    await store.record(ev(2, { ts: clock }));
    expect((await store.list()).map(e => e.id)).toEqual([hex(2)]);
  });
  it('ignores corrupted stored entries', async () => {
    const { store, storage } = await enabledStore();
    await storage.set('activity_events_v1', [ev(1), { junk: true }, 'x']);
    expect((await store.list()).map(e => e.id)).toEqual([hex(1)]);
  });
  it('exports only validated events', async () => {
    const { store } = await enabledStore();
    await store.record(ev(1));
    const out = JSON.parse(await store.exportJson());
    expect(out.schemaVersion).toBe(1);
    expect(out.events).toHaveLength(1);
  });
});

describe('ledger feed', () => {
  it('produces ledger-valid local_activity records that are never quota measurements', async () => {
    const { store } = await enabledStore();
    await store.record(ev(1, { provider: 'chatgpt' }));
    await store.record(ev(2, { provider: 'gemini' }));
    const inputs = Act.toLedgerInputs(await store.list(), { accountAlias: 'default', devicePseudonym: 'cd'.repeat(8), ingestedAt: T0 + 5000 });
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(validateRecord(input).ok).toBe(true);
      expect(input.kind).toBe('local_activity');
      expect(input.source).toBe('web');
      expect(input.confidence).toBe('low');
      expect(input.measures).toEqual({ requestCount: 1 });
    }
    const first = append([], inputs);
    expect(first.accepted).toBe(2);
    expect(append(first.records, inputs).duplicates).toBe(2);
  });
});

describe('wiring', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const read = f => readFileSync(root + f, 'utf8');
  it('the service worker loads the collector and checks opt-in, incognito and sender', () => {
    const bg = read('background.js');
    expect(bg).toMatch(/importScripts\([^)]*activity-collector\.js/);
    expect(bg).toMatch(/tab\.incognito/);
    expect(bg).toMatch(/ACTIVITY_OBSERVED' && fromAllowedSite/);
    expect(bg).toMatch(/ACTIVITY_SET_ENABLED' && fromExtension/);
    expect(bg).toMatch(/ACTIVITY_CLEAR' && fromExtension/);
  });
  it('the page-side signal carries only a coarse type, never a URL or text', () => {
    const interceptor = read('interceptor.js');
    const calls = interceptor.match(/postToIsolated\('STREAM_ACTIVITY'[^;]*;/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c).not.toMatch(/url|text|body|title/i);
    const content = read('content.js');
    const block = content.slice(content.indexOf("type === 'STREAM_ACTIVITY'"), content.indexOf("type === 'INTERCEPTED_API'"));
    expect(block).not.toMatch(/location|href|document\./);
  });
  it('is not part of the default off state: settings page exposes consent and deletion', () => {
    const html = read('settings/settings.html');
    expect(html).toMatch(/id="activity-enabled"/);
    expect(html).toMatch(/id="activity-delete"/);
    expect(html).not.toMatch(/id="activity-enabled"[^>]*checked/);
  });
});

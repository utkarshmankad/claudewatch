import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { alertsFor, dedupeKeyFor } from '../alerts.js';
import { renderView } from '../render.js';
import type { UiNode } from '../render.js';
import { buildCompanionView, forecastsFor, riskOf, SYNC_STALE_AFTER_MS } from '../viewModel.js';
import type { CompanionInput } from '../viewModel.js';
import type { SyncLedgerRecord } from '../../sync/e2ee/allowlist.js';
import { validateLedgerRecord } from '../../sync/e2ee/allowlist.js';
import { forecast } from '../../forecast/engine.js';
import { toLedgerRecord } from '../viewModel.js';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

function snap(provider: string, alias: string, pct: number, at: number, resetAt: number, type = 'five_hour', n = 0): SyncLedgerRecord {
  return {
    kind: 'provider_snapshot', provider, accountAlias: alias, devicePseudonym: 'a1b2c3d4e5f60718', observedAt: at, source: 'web', confidence: 'high',
    measurementMethod: 'provider_reported', measures: { quotaPercentUsed: pct }, window: { type, resetAt }, id: `abcdef0123456789${String(Math.floor(at / 1000) + n).padStart(10, '0')}`,
  };
}

/** A steep climb that exhausts the 5-hour window before reset. */
function risky(provider = 'claude', alias = 'work'): SyncLedgerRecord[] {
  return [0, 1, 2, 3, 4, 5].map((i) => snap(provider, alias, 40 + i * 9, NOW - (30 - i * 5) * 60_000, NOW + 2 * H));
}
function calm(provider = 'chatgpt', alias = 'home'): SyncLedgerRecord[] {
  return [0, 1, 2, 3, 4, 5].map((i) => snap(provider, alias, 10 + i, NOW - (30 - i * 5) * 60_000, NOW + 4 * H));
}

const input = (over: Partial<CompanionInput> = {}): CompanionInput => ({
  records: [...risky(), ...calm()], prefs: {}, devices: [{ name: 'Laptop', lastSeenAt: NOW - H, revoked: false, current: true }], lastSyncAt: NOW - 5 * 60_000, now: NOW, ...over,
});

describe('view model', () => {
  it('shows normalized quotas, reset times, a recommendation, device health and notification settings', () => {
    const v = buildCompanionView(input({ prefs: { alertFrequency: 'low', providerMute: { gemini: true }, quietHours: { startMinute: 1320, endMinute: 420 } } }));
    expect(v.quotas.map((q) => `${q.provider}/${q.accountAlias}/${q.window}`)).toEqual(['chatgpt/home/five_hour', 'claude/work/five_hour']);
    const claude = v.quotas.find((q) => q.provider === 'claude');
    expect(claude?.usedPercent).toBe(85);
    expect(claude?.resetAt).toBe(NOW + 2 * H);
    expect(claude?.hoursToReset).toBeCloseTo(2, 1);
    expect(claude?.risk).toBe('high');
    expect(v.quotas.find((q) => q.provider === 'chatgpt')?.risk).toBe('none');
    expect(v.recommendation?.action).toBe('use');
    expect(v.recommendation?.provider).toBe('chatgpt');
    expect(v.recommendation?.summary.length).toBeGreaterThan(0);
    expect(v.devices).toEqual([{ name: 'Laptop', lastSeenAt: NOW - H, health: 'ok', current: true }]);
    expect(v.notifications).toEqual({ alertFrequency: 'low', mutedProviders: ['gemini'], quietHours: { startMinute: 1320, endMinute: 420 } });
    expect(v.sync.freshness).toBe('fresh');
  });

  it('never recommends a muted provider', () => {
    const v = buildCompanionView(input({ prefs: { providerMute: { chatgpt: true } } }));
    expect(v.recommendation?.provider).not.toBe('chatgpt');
  });

  it('marks sync freshness and device health honestly', () => {
    expect(buildCompanionView(input({ lastSyncAt: null })).sync.freshness).toBe('never');
    expect(buildCompanionView(input({ lastSyncAt: NOW - SYNC_STALE_AFTER_MS - 1 })).sync.freshness).toBe('stale');
    const v = buildCompanionView(input({ devices: [
      { name: null, lastSeenAt: NOW - 3 * 24 * H, revoked: false, current: false },
      { name: 'Old phone', lastSeenAt: NOW, revoked: true, current: false },
    ] }));
    expect(v.devices.map((d) => [d.name, d.health])).toEqual([['Unnamed device', 'stale'], ['Old phone', 'revoked']]);
  });

  it('handles an empty ledger and stale readings', () => {
    const empty = buildCompanionView(input({ records: [] }));
    expect(empty.quotas).toEqual([]);
    expect(empty.recommendation).toBeNull();
    const stale = buildCompanionView(input({ now: NOW + 3 * H }));
    expect(stale.quotas.every((q) => q.state === 'stale' || q.state === 'insufficient_data')).toBe(true);
  });

  it('exposes only allow-listed fields: every output string is a known label, number or alias', () => {
    const v = buildCompanionView(input());
    const serialized = JSON.stringify(v);
    for (const banned of ['cookie', 'token', 'http', '@', 'prompt', 'response']) expect(serialized.toLowerCase()).not.toContain(banned);
    expect(() => validateLedgerRecord({ ...risky()[0], prompt: 'secret' })).toThrow();
  });

  it('classifies risk from the forecast', () => {
    const [f] = forecastsFor(risky(), NOW);
    expect(f && riskOf(f)).toBe('high');
    const [g] = forecastsFor(calm(), NOW);
    expect(g && riskOf(g)).toBe('none');
  });
});

describe('alerts', () => {
  const fc = (records: SyncLedgerRecord[], now: number) => forecast(records.map(toLedgerRecord), { now, provider: records[0]!.provider as 'claude', accountAlias: records[0]!.accountAlias, window: 'five_hour' });

  it('raises quota_risk once for a new risk and stays quiet on repeats', async () => {
    const next = fc(risky(), NOW);
    const first = await alertsFor(null, next, {}, NOW);
    expect(first.map((a) => a.kind)).toEqual(['quota_risk']);
    expect(await alertsFor(next, next, {}, NOW)).toEqual([]);
  });

  it('is silent for calm windows, muted providers and frequency off', async () => {
    expect(await alertsFor(null, fc(calm('claude', 'work'), NOW), {}, NOW)).toEqual([]);
    const next = fc(risky(), NOW);
    expect(await alertsFor(null, next, { providerMute: { claude: true } }, NOW)).toEqual([]);
    expect(await alertsFor(null, next, { alertFrequency: 'off' }, NOW)).toEqual([]);
  });

  it('raises a reset alert once a limited window has reset', async () => {
    const limited = forecast(
      [snap('claude', 'work', 100, NOW - 60_000, NOW + H)].map(toLedgerRecord),
      { now: NOW, provider: 'claude', accountAlias: 'work', window: 'five_hour' },
    );
    expect(limited.state).toBe('limited');
    const after = forecast([...[snap('claude', 'work', 5, NOW + 2 * H, NOW + 7 * H)].map(toLedgerRecord)], { now: NOW + 2 * H, provider: 'claude', accountAlias: 'work', window: 'five_hour' });
    const alerts = await alertsFor(limited, after, {}, NOW + 2 * H);
    expect(alerts.map((a) => a.kind)).toContain('reset');
  });

  it('builds opaque, stable dedupe keys that carry no readable content', async () => {
    const f = { provider: 'claude' as const, accountAlias: 'work', window: 'five_hour' as const, resetAt: NOW + H };
    const a = await dedupeKeyFor('quota_risk', f, 3);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await dedupeKeyFor('quota_risk', f, 3)).toBe(a);
    expect(await dedupeKeyFor('quota_risk', f, 4)).not.toBe(a);
    expect(await dedupeKeyFor('reset', f, 3)).not.toBe(a);
    expect(a).not.toContain('work');
  });
});

describe('render', () => {
  const texts = (nodes: UiNode[]): string[] => nodes.flatMap((n) => [...(n.text !== undefined ? [n.text] : []), ...texts(n.children ?? [])]);

  it('renders the not-connected state without a view', () => {
    expect(texts(renderView(null)).join(' ')).toContain('Not connected');
  });

  it('renders quotas, resets, recommendation, devices and settings as text nodes', () => {
    const out = texts(renderView(buildCompanionView(input()))).join('\n');
    expect(out).toContain('claude (work) 5-hour');
    expect(out).toContain('85% used');
    expect(out).toContain('2026-10-24 14:00 UTC');
    expect(out).toContain('High risk');
    expect(out).toContain('Laptop (this device): healthy');
    expect(out).toContain('Frequency: normal');
    expect(out).toContain('Quiet hours: off');
  });

  it('keeps hostile text inert: it stays a string in a text node and tags are from a fixed set', () => {
    const view = buildCompanionView(input({ devices: [{ name: '<img src=x onerror=alert(1)>', lastSeenAt: NOW, revoked: false, current: false }] }));
    const tree = renderView(view);
    const tags = new Set<string>();
    const walk = (ns: UiNode[]): void => ns.forEach((n) => { tags.add(n.tag); walk(n.children ?? []); });
    walk(tree);
    expect([...tags].every((t) => ['section', 'h2', 'p', 'ul', 'li', 'span', 'div'].includes(t))).toBe(true);
    expect(texts(tree).join('')).toContain('<img src=x onerror=alert(1)>');
  });

  it('labels stale sync and never-synced state', () => {
    expect(texts(renderView(buildCompanionView(input({ lastSyncAt: null })))).join(' ')).toContain('Never synced');
    expect(texts(renderView(buildCompanionView(input({ lastSyncAt: NOW - 2 * SYNC_STALE_AFTER_MS })))).join(' ')).toContain('Stale: last synced');
  });
});

describe('service worker', () => {
  const source = readFileSync(join(process.cwd(), 'companion', 'sw.js'), 'utf8');

  function load() {
    const listeners: Record<string, (e: unknown) => void> = {};
    const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
    const posted: unknown[] = [];
    const sandbox = {
      self: {
        addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; },
        registration: { showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); } },
        clients: { claim: async () => undefined, matchAll: async () => [{ postMessage: (m: unknown) => posted.push(m), focus: async () => undefined }], openWindow: async () => undefined },
        location: { origin: 'https://companion.test' },
        skipWaiting: async () => undefined,
      },
      caches: { open: async () => ({ addAll: async () => undefined }), keys: async () => [], match: async () => undefined, delete: async () => true },
      fetch: async () => undefined,
      URL, JSON, Object,
    };
    vm.runInNewContext(source, sandbox);
    const push = async (data: string | null) => {
      const waits: Promise<unknown>[] = [];
      listeners['push']?.({ data: data === null ? null : { text: () => data }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    };
    return { listeners, shown, posted, push };
  }

  it('registers the lifecycle handlers it needs', () => {
    expect(Object.keys(load().listeners).sort()).toEqual(['activate', 'fetch', 'install', 'notificationclick', 'push', 'pushsubscriptionchange']);
  });

  it('shows fixed text per kind with a collapsing tag, and never echoes payload content', async () => {
    const w = load();
    await w.push(JSON.stringify({ v: 1, k: 'quota_risk', extra: 'claude 91% work@example.com' }));
    await w.push(JSON.stringify({ v: 1, k: 'reset' }));
    expect(w.shown.map((s) => s.title)).toEqual(['ClaudeWatch: quota risk', 'ClaudeWatch: quota reset']);
    expect(w.shown[0]?.options['tag']).toBe('claudewatch-quota_risk');
    expect(w.shown[0]?.options['renotify']).toBe(false);
    expect(JSON.stringify(w.shown)).not.toMatch(/91|example\.com|claude 9/);
  });

  it('falls back to the generic text for empty, malformed or unknown payloads', async () => {
    const w = load();
    for (const data of [null, 'not json', JSON.stringify({ v: 2, k: 'reset' }), JSON.stringify({ v: 1, k: '__proto__' }), JSON.stringify({ v: 1, k: 'constructor' })]) await w.push(data);
    expect(w.shown).toHaveLength(5);
    expect(new Set(w.shown.map((s) => s.title))).toEqual(new Set(['ClaudeWatch: quota risk']));
  });

  it('asks open pages to resubscribe when the push service rotates the subscription', async () => {
    const w = load();
    const waits: Promise<unknown>[] = [];
    w.listeners['pushsubscriptionchange']?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(w.posted).toEqual([{ type: 'resubscribe' }]);
  });
});

describe('static shell', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), 'companion', f), 'utf8');

  it('ships a strict CSP and no inline script, style, remote script or eval', () => {
    const html = read('index.html');
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/\sstyle=|\son\w+=/);
    expect(html).not.toMatch(/src="https?:|href="https?:/);
  });

  it('keeps the page and worker free of HTML injection sinks and credentials', () => {
    for (const f of ['app.js', 'sw.js']) {
      const code = read(f);
      expect(code, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage|document\.cookie/);
    }
    expect(read('app.js')).not.toMatch(/fetch\(/);
    expect(read('sw.js')).not.toMatch(/Authorization|Bearer|accountId|deviceId/i);
  });

  it('declares response headers that match the page CSP and add framing, transport and referrer protection', () => {
    const headers = read('_headers');
    const html = read('index.html');
    const metaCsp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    const headerCsp = /Content-Security-Policy: (.+)/.exec(headers)?.[1] ?? '';
    expect(headerCsp.replace("; frame-ancestors 'none'", '')).toBe(metaCsp);
    expect(headerCsp).toContain("frame-ancestors 'none'");
    for (const h of ['Strict-Transport-Security', 'X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer', 'Permissions-Policy']) expect(headers).toContain(h);
    expect(headers).toMatch(/\/sw\.js\n\s+Cache-Control: no-cache/);
  });

  it('has an installable manifest', () => {
    const m = JSON.parse(read('manifest.webmanifest')) as Record<string, unknown>;
    expect(m['display']).toBe('standalone');
    expect(m['start_url']).toBe('./');
    expect(Array.isArray(m['icons'])).toBe(true);
  });
});

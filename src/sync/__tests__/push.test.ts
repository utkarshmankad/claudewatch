import { describe, expect, it } from 'vitest';
import { MemoryStorage, SyncClient } from '../client/client.js';
import type { ClientDeps, Transport } from '../client/client.js';
import { createSyncService } from '../service/handler.js';
import type { SyncService } from '../service/handler.js';
import { DEFAULT_PUSH_HOSTS, hostAllowed, inQuietHours, pushPayload, validateKinds, validatePushEndpoint, validatePushKeys, validateQuietHours } from '../service/push.js';
import type { PushMessage, PushSender } from '../service/push.js';

const BASE = 'https://sync.test';
const EP = 'https://fcm.googleapis.com/fcm/send/abc123';
const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const MIN = 60_000;

interface Rig { clock: { t: number }; service: SyncService; sent: PushMessage[]; sender: { status: number | 'throw' }; deps: () => ClientDeps }

function rig(config = {}): Rig {
  const clock = { t: Date.UTC(2026, 9, 24, 12, 0, 0) };
  const sent: PushMessage[] = [];
  const sender = { status: 201 as number | 'throw' };
  const pushSender: PushSender = async (m) => {
    sent.push(m);
    if (sender.status === 'throw') throw new Error('network');
    return { status: sender.status };
  };
  const service = createSyncService({ now: () => clock.t, config, pushSender });
  const transport: Transport = async (url, init) => service.fetch(new Request(url, init));
  return { clock, service, sent, sender, deps: () => ({ storage: new MemoryStorage(), transport, now: () => clock.t, sleep: async () => undefined }) };
}

async function pair(r: Rig): Promise<{ a: SyncClient; b: SyncClient }> {
  const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
  const { code } = await a.createEnrollmentCode();
  const join = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
  await a.pendingJoin(code);
  await a.approveJoin(code, join.sas);
  return { a, b: await join.finish() };
}

describe('push validation', () => {
  it('accepts hosted push services and rejects everything else', () => {
    expect(validatePushEndpoint(EP)).toBe(EP);
    expect(validatePushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toContain('mozilla');
    for (const bad of [
      'http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://127.0.0.1/x', 'https://[::1]/x',
      'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://localhost/x', 'ftp://fcm.googleapis.com/x', 'not a url', '', 42, 'https://169.254.169.254/latest',
    ]) {
      expect(() => validatePushEndpoint(bad), String(bad)).toThrow();
    }
    expect(() => validatePushEndpoint(`https://fcm.googleapis.com/${'a'.repeat(600)}`)).toThrow();
    expect(DEFAULT_PUSH_HOSTS.every((s) => !s.includes('/'))).toBe(true);
  });

  it('validates keys, quiet hours and kinds', () => {
    expect(validatePushKeys(KEYS.p256dh, KEYS.auth)).toEqual(KEYS);
    expect(() => validatePushKeys('short', KEYS.auth)).toThrow();
    expect(() => validatePushKeys(KEYS.p256dh, 'bad key!')).toThrow();
    expect(validateQuietHours(undefined)).toBeNull();
    expect(validateQuietHours({ startMinute: 1320, endMinute: 420, utcOffsetMinutes: 60 })).toEqual({ startMinute: 1320, endMinute: 420, utcOffsetMinutes: 60 });
    for (const bad of [{ startMinute: 1440, endMinute: 0, utcOffsetMinutes: 0 }, { startMinute: 0, endMinute: 0, utcOffsetMinutes: 900 }, { startMinute: 0, endMinute: 1, utcOffsetMinutes: 0, extra: 1 }, [], 'x']) {
      expect(() => validateQuietHours(bad)).toThrow();
    }
    expect(validateKinds(undefined)).toEqual(['quota_risk', 'reset']);
    expect(validateKinds(['reset', 'reset'])).toEqual(['reset']);
    expect(() => validateKinds([])).toThrow();
    expect(() => validateKinds(['spam'])).toThrow();
  });

  it('computes quiet hours across midnight and with offsets', () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 9, 24, h, m);
    const night = { startMinute: 22 * 60, endMinute: 7 * 60, utcOffsetMinutes: 0 };
    expect(inQuietHours(at(23), night)).toBe(true);
    expect(inQuietHours(at(6, 59), night)).toBe(true);
    expect(inQuietHours(at(7), night)).toBe(false);
    expect(inQuietHours(at(12), night)).toBe(false);
    expect(inQuietHours(at(21, 59), night)).toBe(false);
    expect(inQuietHours(at(20), { ...night, utcOffsetMinutes: 180 })).toBe(true); // 23:00 local
    expect(inQuietHours(at(1), { ...night, utcOffsetMinutes: -300 })).toBe(false); // 20:00 local
    expect(inQuietHours(at(5), { ...night, utcOffsetMinutes: -300 })).toBe(true); // 00:00 local
  });

  it('treats equal start and end as no quiet hours', () => {
    expect(inQuietHours(Date.now(), { startMinute: 60, endMinute: 60, utcOffsetMinutes: 0 })).toBe(false);
    expect(inQuietHours(Date.now(), null)).toBe(false);
  });

  it('keeps the payload generic', () => {
    expect(JSON.parse(pushPayload('quota_risk'))).toEqual({ v: 1, k: 'quota_risk' });
    expect(pushPayload('reset')).not.toMatch(/\d{2,}/);
  });
});

describe('push lifecycle', () => {
  it('registers, reports status without echoing the endpoint, renews and revokes', async () => {
    const r = rig();
    const { a } = await pair(r);
    expect(await a.pushStatus()).toEqual({ active: false });
    const { expiresAt } = await a.registerPush({ endpoint: EP, keys: KEYS });
    expect(expiresAt).toBe(r.clock.t + 30 * 24 * 60 * MIN);
    const status = await a.pushStatus();
    expect(status.active).toBe(true);
    expect(JSON.stringify(status)).not.toContain('fcm');
    r.clock.t += 10 * 24 * 60 * MIN;
    expect((await a.renewPush()).expiresAt).toBe(r.clock.t + 30 * 24 * 60 * MIN);
    await a.revokePush();
    expect(await a.pushStatus()).toEqual({ active: false });
    await expect(a.renewPush()).rejects.toThrow();
  });

  it('rejects an endpoint that is not a hosted push service', async () => {
    const r = rig();
    const { a } = await pair(r);
    await expect(a.registerPush({ endpoint: 'https://attacker.example/hook', keys: KEYS })).rejects.toThrow();
    await expect(a.registerPush({ endpoint: 'https://169.254.169.254/x', keys: KEYS })).rejects.toThrow();
    expect(r.service.store.accounts.values().next().value?.push.size).toBe(0);
  });

  it('lets a subscription expire and drops it on retention', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await b.registerPush({ endpoint: EP, keys: KEYS });
    r.clock.t += 31 * 24 * 60 * MIN;
    await a.sync();
    const result = await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'ab12' });
    expect(result.sent).toBe(0);
    expect(r.sent).toHaveLength(0);
    expect(await b.pushStatus()).toEqual({ active: false });
    expect(r.service.store.audit.some((e) => e.type === 'push_expired')).toBe(true);
    await b.registerPush({ endpoint: EP, keys: KEYS });
    r.clock.t += 31 * 24 * 60 * MIN;
    r.service.runRetention();
    expect([...r.service.store.accounts.values()][0]?.push.size).toBe(0);
  });

  it('removes subscriptions when a device is revoked or removed, and on account deletion', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await b.registerPush({ endpoint: EP, keys: KEYS });
    const bId = b.deviceId as string;
    await a.revokeDevice(bId);
    const account = [...r.service.store.accounts.values()][0];
    expect(account?.push.size).toBe(0);
    expect((await a.notifyOthers({ kind: 'reset', dedupeKey: 'cd34' })).sent).toBe(0);
    await a.registerPush({ endpoint: EP, keys: KEYS });
    const receipt = await a.deleteAccount();
    expect(receipt.objectCount).toBeGreaterThanOrEqual(0);
    expect(r.service.store.accounts.size).toBe(0);
  });

  it('records deletion of subscriptions in the receipt', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.registerPush({ endpoint: EP, keys: KEYS });
    await b.registerPush({ endpoint: EP, keys: KEYS });
    const receipt = (await a.deleteAccount()) as unknown as { pushSubscriptionCount: number };
    expect(receipt.pushSubscriptionCount).toBe(2);
  });
});

describe('notify', () => {
  it('sends a generic payload to other devices only, never to the caller', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.registerPush({ endpoint: EP, keys: KEYS });
    await b.registerPush({ endpoint: 'https://web.push.apple.com/Qabc', keys: KEYS });
    const res = await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'ab12' });
    expect(res).toEqual({ sent: 1, suppressed: { quietHours: 0, duplicate: 0 }, failed: 0 });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.endpoint).toContain('apple');
    expect(JSON.parse(r.sent[0]?.payload ?? '')).toEqual({ v: 1, k: 'quota_risk' });
    expect(r.sent[0]?.ttlSeconds).toBe(3600);
    expect(r.sent[0]?.urgency).toBe('normal');
  });

  it('suppresses duplicates for the same key until the window passes, but not a different key', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await b.registerPush({ endpoint: EP, keys: KEYS });
    expect((await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'aa' })).sent).toBe(1);
    expect((await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'aa' })).suppressed.duplicate).toBe(1);
    expect((await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'bb' })).sent).toBe(1);
    expect((await a.notifyOthers({ kind: 'reset', dedupeKey: 'aa' })).sent).toBe(1);
    r.clock.t += 7 * 60 * MIN;
    expect((await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'aa' })).sent).toBe(1);
    expect(r.sent).toHaveLength(4);
  });

  it('honours quiet hours and does not consume the dedupe slot while quiet', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    // 12:00 UTC with a +0 offset; quiet 11:00-13:00.
    await b.registerPush({ endpoint: EP, keys: KEYS }, { quietHours: { startMinute: 11 * 60, endMinute: 13 * 60, utcOffsetMinutes: 0 } });
    const quiet = await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'aa' });
    expect(quiet.suppressed.quietHours).toBe(1);
    expect(r.sent).toHaveLength(0);
    r.clock.t += 90 * MIN; // 13:30 UTC
    expect((await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'aa' })).sent).toBe(1);
  });

  it('respects the kinds a device opted into', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await b.registerPush({ endpoint: EP, keys: KEYS }, { kinds: ['reset'] });
    expect((await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'aa' })).sent).toBe(0);
    expect((await a.notifyOthers({ kind: 'reset', dedupeKey: 'aa' })).sent).toBe(1);
    expect(r.sent[0]?.urgency).toBe('low');
  });

  it('drops a subscription the push service reports gone and counts other failures', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await b.registerPush({ endpoint: EP, keys: KEYS });
    r.sender.status = 500;
    expect((await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'aa' })).failed).toBe(1);
    r.sender.status = 'throw';
    expect((await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'bb' })).failed).toBe(1);
    expect((await b.pushStatus()).active).toBe(true);
    r.sender.status = 410;
    await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'cc' });
    expect((await b.pushStatus()).active).toBe(false);
  });

  it('caps pushes per device per hour', async () => {
    const r = rig({ pushPerDevicePerHour: 3, notifyPerHour: 100, requestsPerMinute: 1000 });
    const { a, b } = await pair(r);
    await b.registerPush({ endpoint: EP, keys: KEYS });
    let sent = 0;
    for (let i = 0; i < 6; i += 1) sent += (await a.notifyOthers({ kind: 'quota_risk', dedupeKey: `0${i}` })).sent;
    expect(sent).toBe(3);
  });

  it('rate limits notify requests per account', async () => {
    const r = rig({ notifyPerHour: 2, requestsPerMinute: 1000 });
    const { a, b } = await pair(r);
    await b.registerPush({ endpoint: EP, keys: KEYS });
    await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'aa' });
    await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'bb' });
    await expect(a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'cc' })).rejects.toThrow();
  });

  it('rejects unknown kinds and readable dedupe keys, and needs a configured sender', async () => {
    const r = rig();
    const { a } = await pair(r);
    await expect(a.notifyOthers({ kind: 'spam' as never, dedupeKey: 'aa' })).rejects.toThrow();
    await expect(a.notifyOthers({ kind: 'reset', dedupeKey: 'work account at 91%' })).rejects.toThrow();
    const bare = createSyncService({});
    const res = await bare.fetch(new Request(`${BASE}/v1/push/notify`, { method: 'POST', body: '{}' }));
    expect(res.status).toBe(401);
  });

  it('requires an authenticated device for every push route', async () => {
    const r = rig();
    for (const [method, path] of [['PUT', '/v1/push/subscription'], ['GET', '/v1/push/subscription'], ['DELETE', '/v1/push/subscription'], ['POST', '/v1/push/renew'], ['POST', '/v1/push/notify']]) {
      const res = await r.service.fetch(new Request(`${BASE}${path}`, { method, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' }));
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('answers 503 when no push transport is configured', async () => {
    const clock = { t: Date.UTC(2026, 9, 24, 12) };
    const service = createSyncService({ now: () => clock.t });
    const transport: Transport = async (url, init) => service.fetch(new Request(url, init));
    const a = await SyncClient.enable({ storage: new MemoryStorage(), transport, now: () => clock.t, sleep: async () => undefined, retryDelaysMs: [] }, { baseUrl: BASE, region: 'eu' });
    await expect(a.notifyOthers({ kind: 'reset', dedupeKey: 'aa' })).rejects.toThrow();
  });

  it('writes audit events without endpoints, keys or usage content', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await b.registerPush({ endpoint: EP, keys: KEYS });
    await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'ab12' });
    await a.notifyOthers({ kind: 'quota_risk', dedupeKey: 'ab12' });
    const log = JSON.stringify(r.service.store.audit);
    expect(log).toContain('push_subscribed');
    expect(log).toContain('push_sent');
    expect(log).toContain('push_suppressed');
    for (const secret of ['fcm', KEYS.auth, KEYS.p256dh, 'ab12']) expect(log).not.toContain(secret);
  });
});

describe('service hardening found in the 3.4 security review', () => {
  it('sends strict transport and framing headers on every response', async () => {
    const r = rig();
    const res = await r.service.fetch(new Request(`${BASE}/v1/nothing`));
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not let a client choose its rate-limit bucket with X-Forwarded-For unless a proxy is trusted', async () => {
    const create = (r: Rig, ip: string) => r.service.fetch(new Request(`${BASE}/v1/accounts`, {
      method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify({ region: 'eu', signPublic: 'a'.repeat(20), encPublic: 'b'.repeat(20) }),
    }));
    const r = rig();
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) codes.push((await create(r, `203.0.113.${i}`)).status);
    expect(codes.slice(10)).toEqual([429, 429]);
    const trusted = rig({ trustForwardedFor: true });
    const ok: number[] = [];
    for (let i = 0; i < 12; i += 1) ok.push((await create(trusted, `203.0.113.${i}`)).status);
    expect(ok.every((c) => c === 201)).toBe(true);
    const cf = rig();
    for (let i = 0; i < 12; i += 1) expect((await cf.service.fetch(new Request(`${BASE}/v1/accounts`, { method: 'POST', headers: { 'cf-connecting-ip': `198.51.100.${i}` }, body: JSON.stringify({ region: 'eu', signPublic: 'a'.repeat(20), encPublic: 'b'.repeat(20) }) }))).status).toBe(201);
  });

  it('prunes expired rate-limit windows so memory cannot grow without bound', async () => {
    const r = rig({ trustForwardedFor: true });
    for (let i = 0; i < 50; i += 1) {
      await r.service.fetch(new Request(`${BASE}/v1/enrollments/join`, { method: 'POST', headers: { 'x-forwarded-for': `10.0.0.${i}` }, body: JSON.stringify({ token: 'x', signPublic: 'a', encPublic: 'b' }) }));
    }
    expect(r.service.rateLimitEntries()).toBeGreaterThanOrEqual(50);
    r.clock.t += 61 * MIN;
    r.service.runRetention();
    expect(r.service.rateLimitEntries()).toBe(0);
  });

  it('R6: matches exact hosts, and sub-domains only where the service really hands them out', () => {
    // Windows sub-domains are per device; they are the only wildcard.
    expect(validatePushEndpoint('https://db5p.notify.windows.com/?token=abc')).toContain('notify.windows.com');
    expect(validatePushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=abc')).toContain('notify.windows.com');
    for (const bad of [
      'https://notify.windows.com/x', // the bare domain is not a push host
      'https://evil.notify.windows.com.evil.example/x', 'https://-x.notify.windows.com/x', 'https://x_y.notify.windows.com/x',
      'https://takeover.googleapis.com/x', 'https://x.fcm.googleapis.com/x', 'https://x.updates.push.services.mozilla.com/x',
      'https://sub.web.push.apple.com/x', 'https://push.services.mozilla.com/x', 'https://web.push.apple.com.evil.example/x',
    ]) {
      expect(() => validatePushEndpoint(bad), bad).toThrow();
    }
    expect(hostAllowed('a.b.notify.windows.com', ['*.notify.windows.com'])).toBe(true);
    expect(hostAllowed('notify.windows.com', ['*.notify.windows.com'])).toBe(false);
    expect(hostAllowed('fcm.googleapis.com', ['fcm.googleapis.com'])).toBe(true);
    expect(hostAllowed('x.fcm.googleapis.com', ['fcm.googleapis.com'])).toBe(false);
  });

  it('rejects look-alike and parser-confusion endpoints, and stores only the normalised host', () => {
    for (const bad of [
      'https://fcm.googleapis.com@evil.example/x', 'https://fcm.googIeapis.com/x', 'https://fcm.googleapis.com.evil.example/x',
      'https://evil.example/https://fcm.googleapis.com/x', 'https://fcm.googleapis.com#@evil.example', 'https://２５５.２５５.２５５.２５５/x', 'https://0x7f.1/x',
    ]) {
      expect(() => validatePushEndpoint(bad), bad).toThrow();
    }
    // A backslash is a path separator for https URLs, so this really is the allowed host; the stored value is the normalised form.
    const normalised = validatePushEndpoint('https://fcm.googleapis.com\\@evil.example/x');
    expect(new URL(normalised).hostname).toBe('fcm.googleapis.com');
  });
});

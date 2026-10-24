// Regression tests for the Phase 3 security review (docs/product-hunt/gates/phase-3/security-review.md).
// Each test plays a service that is not honest, which the threat model (T1) says the clients must withstand.
import { describe, expect, it } from 'vitest';
import { MemoryStorage, SyncClient } from '../client/client.js';
import type { Transport } from '../client/client.js';
import { generateDeviceKeys, wrapAccountKey, randomBytes } from '../e2ee/crypto.js';
import { createSyncService } from '../service/handler.js';

const BASE = 'https://sync.test';

function record(n: number): Record<string, unknown> {
  return {
    kind: 'provider_snapshot', provider: 'claude', accountAlias: 'work', devicePseudonym: 'a1b2c3d4e5f60718', observedAt: 1_700_000_000_000 + n,
    source: 'web', confidence: 'high', measurementMethod: 'provider_reported', measures: { quotaPercentUsed: n % 100 },
    id: `abcdef0123456789${String(n).padStart(8, '0')}`,
  };
}

type Rewrite = (path: string, method: string, body: Record<string, unknown> | undefined, res: Response) => Promise<Response | undefined> | Response | undefined;

function rig() {
  const clock = { t: 1_800_000_000_000 };
  const service = createSyncService({ now: () => clock.t });
  const hooks: { before?: (path: string, method: string, body: Record<string, unknown> | undefined) => Record<string, unknown> | undefined; after?: Rewrite } = {};
  const calls: string[] = [];
  const transport: Transport = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    let body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    body = hooks.before?.(path, init.method, body) ?? body;
    const res = await service.fetch(new Request(url, { ...init, ...(body ? { body: JSON.stringify(body) } : {}) }));
    return (await hooks.after?.(path, init.method, body, res.clone())) ?? res;
  };
  const deps = () => ({ storage: new MemoryStorage(), transport, now: () => clock.t, sleep: async () => undefined });
  return { service, hooks, calls, deps };
}

async function pair(r: ReturnType<typeof rig>) {
  const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
  const { code } = await a.createEnrollmentCode();
  const join = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
  await a.approveJoin(code, join.sas);
  return { a, b: await join.finish(), code };
}

const replace = (res: Response, patch: (json: Record<string, unknown>) => Record<string, unknown>): Promise<Response> =>
  res.json().then((j: Record<string, unknown>) => new Response(JSON.stringify(patch(j)), { status: res.status }));

describe('enrollment against a dishonest service', () => {
  it('refuses to wrap the account key for a joining key the service substituted (SAS grinding)', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    const { code } = await a.createEnrollmentCode();
    await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
    const attacker = await generateDeviceKeys();
    r.hooks.after = (path, _m, _b, res) => (path === '/v1/enrollments/pending'
      ? replace(res, (j) => ({ joined: { ...(j['joined'] as object), encPublic: attacker.encPublic } }))
      : undefined);
    await expect(a.approveJoin(code, '000000')).rejects.toThrow(/key confirmation/);
    expect(r.calls.filter((c) => c === 'POST /v1/enrollments/approve')).toHaveLength(0);
  });

  it('refuses a service that fabricates the confirmation for its own key', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    const { code } = await a.createEnrollmentCode();
    await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
    const attacker = await generateDeviceKeys();
    r.hooks.after = (path, _m, _b, res) => (path === '/v1/enrollments/pending'
      ? replace(res, () => ({ joined: { signPublic: attacker.signPublic, encPublic: attacker.encPublic, confirm: 'a'.repeat(64) } }))
      : undefined);
    await expect(a.pendingJoin(code)).rejects.toThrow(/key confirmation/);
  });

  it('rejects a 2-part code from an older client', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    const { code } = await a.createEnrollmentCode();
    const old = code.split('.').slice(0, 2).join('.');
    await expect(SyncClient.startJoin(r.deps(), { baseUrl: BASE, code: old, region: 'eu' })).rejects.toThrow(/malformed/);
  });

  it('the joiner rejects an account key the service wrapped itself', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    const { code } = await a.createEnrollmentCode();
    const join = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
    await a.approveJoin(code, join.sas);
    const joinerEnc = [...r.service.store.accounts.values()][0]!.devices;
    const encPublic = [...joinerEnc.values()].find((d) => !d.revoked && d.deviceId !== a.deviceId)!.encPublic;
    // The service swaps in a key of its own, wrapped to the joiner's public key with a binding it can guess.
    const known = randomBytes(32);
    const forged = await wrapAccountKey(known, encPublic, `enroll|${[...r.service.store.accounts.keys()][0]}|1`);
    r.hooks.after = (path, _m, _b, res) => (path === '/v1/enrollments/status' ? replace(res, (j) => ({ ...j, wrapped: forged })) : undefined);
    await expect(join.finish()).rejects.toThrow();
  });

  it('does not register a device when the approval body is malformed', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    const { code } = await a.createEnrollmentCode();
    const join = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
    r.hooks.before = (path, _m, body) => (path === '/v1/enrollments/approve' ? { ...body, wrapped: { bad: true } } : undefined);
    await expect(a.approveJoin(code, join.sas)).rejects.toThrow();
    const account = [...r.service.store.accounts.values()][0]!;
    expect(account.devices.size).toBe(1);
  });
});

describe('key distribution against a dishonest service', () => {
  it('does not wrap a rotated key for a device key the service substituted or invented', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    const attacker = await generateDeviceKeys();
    r.hooks.after = (path, method, _b, res) => (path === '/v1/devices' && method === 'GET'
      ? replace(res, (j) => ({
        ...j,
        devices: (j['devices'] as Array<Record<string, unknown>>).map((d) => (d['deviceId'] === b.deviceId ? { ...d, encPublic: attacker.encPublic } : d))
          .concat([{ deviceId: 'invented', encPublic: attacker.encPublic, enrolledAt: 0, lastSeenAt: 0, revoked: false }]),
      }))
      : undefined);
    await a.rotateKey();
    expect(r.calls.filter((c) => c === 'PUT /v1/keywraps')).toHaveLength(0);
    expect(a.unverifiedDevices().sort()).toEqual([b.deviceId, 'invented'].sort());
  });

  it('still distributes to pinned devices, including ones learned from the encrypted device list', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.rotateKey();
    expect(a.unverifiedDevices()).toEqual([]);
    expect((await b.pull()).undecryptable).toBe(0);
    expect(b.status().epoch).toBe(2);
    // A device that is not the approver learns the third device's key through its published, encrypted entry.
    const { code } = await a.createEnrollmentCode();
    const join = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
    await a.approveJoin(code, join.sas);
    const c = await join.finish();
    await c.nameDevice('Tablet');
    await c.sync();
    await b.sync();
    await b.rotateKey();
    expect(b.unverifiedDevices()).toEqual([]);
    expect((await c.pull()).undecryptable).toBe(0);
    expect(c.status().epoch).toBe(3);
  });

  it('does not adopt a key wrap the service made, even for a future epoch', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    const bDevice = [...[...r.service.store.accounts.values()][0]!.devices.values()].find((d) => d.deviceId === b.deviceId)!;
    const accountId = [...r.service.store.accounts.keys()][0]!;
    const known = randomBytes(32);
    const forged = await wrapAccountKey(known, bDevice.encPublic, `keywrap|${accountId}|${b.deviceId}|2`);
    const account = [...r.service.store.accounts.values()][0]!;
    account.epoch = 2;
    account.keyWraps.push({ deviceId: b.deviceId!, epoch: 2, fromEncPublic: bDevice.encPublic, wrapped: forged });
    await b.pull();
    expect(b.status().epoch).toBe(1);
    expect(b.status().failures.undecryptable).toBeGreaterThan(0);
    void a;
  });
});

describe('convergence fixes found by the review', () => {
  it('a device with queued changes learns a rotation before it uploads', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.rotateKey();
    await b.queueLedger([record(1)]);
    await expect(b.sync()).resolves.toBeDefined();
    expect(b.status().pending).toBe(0);
    expect(b.status().epoch).toBe(2);
    await a.pull();
    expect(a.ledger).toHaveLength(1);
  });

  it('objects that arrived before their epoch key are applied once the key arrives', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.rotateKey();
    await a.queueLedger([record(1)]);
    await a.flush();
    let hide = true;
    r.hooks.after = (path, _m, _b, res) => (hide && path === '/v1/keywraps' ? replace(res, () => ({ wraps: [] })) : undefined);
    const first = await b.pull();
    expect(first.undecryptable).toBe(1);
    expect(b.ledger).toHaveLength(0);
    hide = false;
    const second = await b.pull();
    expect(second.applied).toBe(1);
    expect(b.ledger).toHaveLength(1);
  });

  it('the later of two pending preference writes from one device wins', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    await a.setPrefs({ planLabel: 'first' });
    await a.setPrefs({ planLabel: 'second' });
    expect(a.prefs.planLabel).toBe('second');
  });
});

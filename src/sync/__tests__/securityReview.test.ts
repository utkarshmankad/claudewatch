// Regression tests for the Phase 3 security review (docs/product-hunt/gates/phase-3/security-review.md).
// Each test plays a service that is not honest, which the threat model (T1) says the clients must withstand.
import { describe, expect, it } from 'vitest';
import { MemoryStorage, SyncClient, SyncUnavailableError } from '../client/client.js';
import type { Transport } from '../client/client.js';
import { enrollmentTag, generateDeviceKeys, randomBytes, sign, wrapAccountKey } from '../e2ee/crypto.js';
import { validateEnvelope } from '../e2ee/envelope.js';
import { createSyncService } from '../service/handler.js';

const BASE = 'https://sync.test';

function record(n: number): Record<string, unknown> {
  return {
    kind: 'provider_snapshot', provider: 'claude', accountAlias: 'work', devicePseudonym: 'a1b2c3d4e5f60718', observedAt: 1_700_000_000_000 + n,
    source: 'web', confidence: 'high', measurementMethod: 'provider_reported', measures: { quotaPercentUsed: n % 100 },

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
  return { service, hooks, calls, deps, clock };
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
    await b.queueLedger([record(7)]); // a device is known to its peers once it has uploaded anything
    await b.sync();
    await c.sync();
    await b.sync();
    await b.rotateKey();
    expect(b.unverifiedDevices()).toEqual([]);
    expect((await c.pull()).undecryptable).toBe(0);
    expect(c.status().epoch).toBe(3);
  });

  it('never sends a new key to a device this client revoked, even if the service lists it as active', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    r.hooks.after = (path, method, _b, res) => (path === '/v1/devices' && method === 'GET'
      ? replace(res, (j) => ({ ...j, devices: (j['devices'] as Array<Record<string, unknown>>).map((d) => ({ ...d, revoked: false })) }))
      : undefined);
    await a.revokeDevice(b.deviceId!);
    expect(r.calls.filter((c) => c === 'PUT /v1/keywraps')).toHaveLength(0);
    expect(a.unverifiedDevices()).toEqual([]);
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

describe('malformed replies from the service (found by fuzzing)', () => {
  it('a key-wrap list that is not an array is a failed sync, not a crash', async () => {
    const r = rig();
    const { b } = await pair(r);
    r.hooks.after = (path, _m, _b, res) => (path === '/v1/keywraps' ? replace(res, () => ({ wraps: 5 })) : undefined);
    await expect(b.pull()).rejects.toBeInstanceOf(SyncUnavailableError);
  });

  it('objects with a non-integer sequence are counted as corrupt and do not poison the cursor', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([record(1)]);
    await a.flush();
    let poison = true;
    r.hooks.after = (path, _m, _b, res) => (poison && path === '/v1/objects' && res.status === 200
      ? replace(res, (j) => ({ ...j, objects: [{ seq: 1e300, objectId: 'x', epoch: 1, schemaVersion: 1, nonce: 'n', ciphertext: 'c' }, { seq: 'x' }, null, 7] }))
      : undefined);
    const first = await b.pull();
    expect(first.corrupt).toBe(2);
    poison = false;
    expect((await b.pull()).applied).toBe(1);
  });

  it('a non-object reply body is a failed call', async () => {
    const r = rig();
    const { b } = await pair(r);
    r.hooks.after = (path) => (path === '/v1/devices' ? new Response('[1,2,3]', { status: 200 }) : undefined);
    await expect(b.listDevices()).rejects.toBeInstanceOf(SyncUnavailableError);
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

describe('audit log growth (found by load testing)', () => {
  it('folds repeated unauthenticated events into one counted entry', async () => {
    const r = rig();
    for (let i = 0; i < 500; i += 1) await r.service.fetch(new Request(`${BASE}/v1/devices`, { headers: { authorization: 'Bearer nope' } }));
    const failed = r.service.store.audit.filter((e) => e.type === 'auth_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.count).toBe(500);
  });

  it('counts are kept per account, and a new minute starts a new entry', async () => {
    const clock = { t: 1_800_000_000_000 };
    const service = createSyncService({ now: () => clock.t });
    const call = () => service.fetch(new Request(`${BASE}/v1/devices`, { headers: { authorization: 'Bearer nope' } }));
    await call(); await call();
    clock.t += 61_000;
    await call();
    expect(service.store.audit.filter((e) => e.type === 'auth_failed').map((e) => e.count ?? 1)).toEqual([2, 1]);
  });
});

describe('open findings from the first review, now closed', () => {
  it('CR-7: a device enrolled after a rotation can read history from before it joined', async () => {
    const r = rig();
    const { a } = await pair(r);
    await a.queueLedger([record(1)]);
    await a.flush();
    await a.rotateKey();
    await a.queueLedger([record(2)]);
    await a.flush();
    const { code } = await a.createEnrollmentCode();
    const join = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
    await a.approveJoin(code, join.sas);
    const c = await join.finish();
    const res = await c.pull();
    expect(res.undecryptable).toBe(0);
    expect(c.ledger).toHaveLength(2);
  });

  it('CR-3: a lost enrollment-status response does not strand the new device', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    const { code } = await a.createEnrollmentCode();
    const join = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
    await a.approveJoin(code, join.sas);
    let lose = true;
    r.hooks.after = (path) => (lose && path === '/v1/enrollments/status' ? new Response('', { status: 502 }) : undefined);
    await expect(join.finish()).rejects.toThrow();
    lose = false;
    await expect(join.finish()).resolves.toBeDefined();
  });

  it('CR-5: a retried upload resends the same bytes, so the hash chain does not fork', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([record(1)]);
    await a.flush();
    await a.queueLedger([record(2)]);
    let lost = 4; // the service stores the first attempt; every reply is lost until the client gives up
    r.hooks.after = async (path, method, _b, res) => {
      if (lost > 0 && method === 'PUT' && path === '/v1/objects') { lost -= 1; await res.text(); return new Response('', { status: 503 }); }
      return undefined;
    };
    await expect(a.flush()).rejects.toBeInstanceOf(SyncUnavailableError);
    await a.flush(); // retried later: must resend the stored bytes, not seal again
    await a.queueLedger([record(3)]);
    await a.flush();
    const res = await b.pull();
    expect(res.warnings).not.toContain('chain_fork');
    expect(b.ledger).toHaveLength(3);
  });

  it('CR-4: a rotation interrupted after the epoch bump is finished by the next call', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    let fail = true;
    r.hooks.after = (path, method, _b, res) => (fail && path === '/v1/devices' && method === 'GET' && r.calls.filter((c) => c === 'POST /v1/epoch').length > 0
      ? new Response('', { status: 503 }) : (void res, undefined));
    await expect(a.rotateKey()).rejects.toBeInstanceOf(SyncUnavailableError);
    fail = false;
    await a.queueLedger([record(5)]);
    await a.sync(); // resumes the rotation: hands the key to b, then uploads under the new epoch
    const res = await b.pull();
    expect(res.undecryptable).toBe(0);
    expect(b.status().epoch).toBe(2);
    expect(b.ledger).toHaveLength(1);
  });

  it('CR-8: a record whose id is not derived from its content is rejected from a peer', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([{ ...record(1), id: 'abcdef0123456789abcdef0123456789' }]);
    await a.flush();
    const res = await b.pull();
    expect(res.corrupt).toBe(1);
    expect(b.ledger).toHaveLength(0);
  });

  it('R8: a revoked device that still holds the old key cannot forge the next epoch\'s wrap, even with a service that serves it', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    const { code } = await a.createEnrollmentCode();
    const join = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
    await a.approveJoin(code, join.sas);
    const c = await join.finish();
    await c.queueLedger([record(1)]);
    await b.queueLedger([record(2)]);
    await c.sync(); await b.sync(); await a.sync();
    await a.revokeDevice(c.deviceId!);
    // The service drops a's wrap for b and serves one made by c, who holds epoch 1's key and so can compute a valid tag.
    const account = [...r.service.store.accounts.values()][0]!;
    const accountId = [...r.service.store.accounts.keys()][0]!;
    const cState = (c as any).state; // eslint-disable-line @typescript-eslint/no-explicit-any
    const bDevice = account.devices.get(b.deviceId!)!;
    const tag = await enrollmentTag(cState.keys['1'], 'rotation', accountId, b.deviceId!, '2');
    const newKey = randomBytes(32);
    const forged = await wrapAccountKey(newKey, bDevice.encPublic, `keywrap|${accountId}|${b.deviceId}|2|${tag}`);
    const signature = await sign(cState.deviceKeys.signPrivateJwk, `keywrap|${accountId}|${b.deviceId}|2|${forged.ephemeralPublic}|${forged.nonce}|${forged.ciphertext}`);
    account.keyWraps = account.keyWraps.filter((w) => w.deviceId !== b.deviceId);
    account.keyWraps.push({ deviceId: b.deviceId!, epoch: 2, fromEncPublic: cState.deviceKeys.encPublic, signature, wrapped: forged });
    await b.pull();
    expect(b.status().epoch).toBe(1); // c was unpinned by the revocation entry in the log, so its signed wrap is refused
    expect(b.status().failures.undecryptable).toBeGreaterThan(0);
  });

  it('R9: a revocation reaches peers through the encrypted log, not the service', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    const { code } = await a.createEnrollmentCode();
    const join = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
    await a.approveJoin(code, join.sas);
    const c = await join.finish();
    await c.queueLedger([record(9)]);
    await b.queueLedger([record(8)]);
    await c.sync(); await b.sync(); await a.sync(); // everyone has uploaded, so everyone is pinned
    expect((b as any).state.trustedKeys).toContain((c as any).state.deviceKeys.encPublic); // eslint-disable-line @typescript-eslint/no-explicit-any
    await a.revokeDevice(c.deviceId!);
    // The service lies and says c was never revoked.
    r.hooks.after = (path, method, _b, res) => (path === '/v1/devices' && method === 'GET'
      ? replace(res, (j) => ({ ...j, devices: (j['devices'] as Array<Record<string, unknown>>).map((d) => ({ ...d, revoked: false })) }))
      : undefined);
    await b.sync(); // b hears about the revocation from a's published entry
    await b.rotateKey();
    expect((b as any).state.trustedKeys).not.toContain((c as any).state.deviceKeys.encPublic); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.calls.filter((x) => x === 'PUT /v1/keywraps').length).toBeGreaterThan(0);
    const wrapsForC = [...r.service.store.accounts.values()][0]!.keyWraps.filter((w) => w.deviceId === c.deviceId && w.epoch === 3);
    expect(wrapsForC).toHaveLength(0);
  });

  it('LT-2: expired rate-limit windows are dropped as the table grows, not only at the hourly clean-up', async () => {
    const clock = { t: 1_800_000_000_000 };
    const service = createSyncService({ now: () => clock.t, config: { sweepAbove: 300 } });
    const hit = (i: number) => service.fetch(new Request(`${BASE}/v1/enrollments/join`, { method: 'POST', headers: { 'cf-connecting-ip': `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'x', signPublic: 'a', encPublic: 'b', confirm: 'c' }) }));
    for (let i = 0; i < 500; i += 1) await hit(i);
    expect(service.rateLimitEntries()).toBeGreaterThan(400); // nothing has expired yet, so nothing may be dropped
    clock.t += 2 * 60 * 60 * 1000; // two hours later every window has expired
    for (let i = 0; i < 20; i += 1) await hit(100_000 + i);
    expect(service.rateLimitEntries()).toBeLessThan(100);
  });
});

describe('round 3: remaining risks', () => {
  it('R12: two devices rotating at once end up with the same key; the loser is told and drops its attempt', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    const results = await Promise.allSettled([a.rotateKey(), b.rotateKey()]);
    const won = results.filter((x) => x.status === 'fulfilled');
    const lost = results.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(String(lost[0]!.reason)).toMatch(/superseded/);
    await a.sync(); await b.sync();
    const key = (c: unknown) => (c as any).state.keys['2']; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(key(a)).toBeDefined();
    expect(key(a)).toBe(key(b));
    expect((b as any).state.pendingRotation).toBeUndefined(); // eslint-disable-line @typescript-eslint/no-explicit-any
    // and they can still write to each other under the shared epoch
    await a.queueLedger([record(31)]); await a.flush();
    expect((await b.pull()).applied).toBe(1);
  });

  it('R12: a lost reply to our own epoch bump is recognised by its commitment, not mistaken for a rival', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    let lost = 4; // the bump lands but every reply is lost, so the retry sees "already bumped"
    r.hooks.after = async (path, method, _b, res) => {
      if (lost > 0 && method === 'POST' && path === '/v1/epoch') { lost -= 1; await res.text(); return new Response('', { status: 503 }); }
      return undefined;
    };
    await expect(a.rotateKey()).rejects.toBeInstanceOf(SyncUnavailableError);
    await a.sync(); // resumes: the server's commitment is ours, so this finishes the hand-out
    expect((await b.pull()).undecryptable).toBe(0);
    expect(b.status().epoch).toBe(2);
  });

  it('R12: the service refuses an epoch bump without a well-formed commitment', async () => {
    const r = rig();
    const { a } = await pair(r);
    const sessionBody = (a as any).session; // eslint-disable-line @typescript-eslint/no-explicit-any
    void sessionBody;
    r.hooks.before = (path, _m, body) => (path === '/v1/epoch' ? { ...body, commit: 'nothex' } : undefined);
    await expect(a.rotateKey()).rejects.toBeInstanceOf(SyncUnavailableError);
    expect((a as any).state.pendingRotation).toBeDefined(); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('R10: a device approved by one peer is pinned by the others before it has uploaded anything', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    const { code } = await a.createEnrollmentCode();
    const join = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
    await a.approveJoin(code, join.sas);
    const c = await join.finish(); // c never uploads anything
    await a.queueLedger([record(41)]);
    await a.flush(); // a's next upload carries the vouch for c
    await b.pull();
    const cKey = (c as any).state.deviceKeys.encPublic; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((b as any).state.trustedKeys).toContain(cKey); // eslint-disable-line @typescript-eslint/no-explicit-any
    await b.rotateKey();
    expect(b.unverifiedDevices()).toEqual([]);
    expect((await c.pull()).undecryptable).toBe(0);
    expect(c.status().epoch).toBe(2);
  });

  it('R10: a vouch must be well formed', () => {
    expect(() => validateEnvelope({ v: 1, epoch: 1, sender: 'x', deviceSeq: 1, prev_hash: '', kind: 'prefs', items: [], vouch: [{ enc: 'no', sign: 'no' }] })).toThrow();
    expect(() => validateEnvelope({ v: 1, epoch: 1, sender: 'x', deviceSeq: 1, prev_hash: '', kind: 'prefs', items: [], vouch: [] })).toThrow();
  });
});

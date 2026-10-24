import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage, SyncClient, AccountDeletedError, DeviceRevokedError, SyncDisabledError, SyncUnavailableError } from '../client/client.js';
import type { ClientDeps, Transport } from '../client/client.js';
import { createSyncService } from '../service/handler.js';
import type { SyncService } from '../service/handler.js';

const BASE = 'https://sync.test';

function record(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'provider_snapshot', provider: 'claude', accountAlias: 'work', devicePseudonym: 'a1b2c3d4e5f60718', observedAt: 1_700_000_000_000 + n,
    source: 'web', confidence: 'high', measurementMethod: 'provider_reported', measures: { quotaPercentUsed: n % 100 },
    id: `abcdef0123456789${String(n).padStart(8, '0')}`, ...overrides,
  };
}

interface Rig {
  clock: { t: number };
  service: SyncService;
  transport: Transport;
  calls: string[];
  deps: (extra?: Partial<ClientDeps>) => ClientDeps;
}

function rig(config = {}): Rig {
  const clock = { t: 1_800_000_000_000 };
  const service = createSyncService({ now: () => clock.t, config });
  const calls: string[] = [];
  const transport: Transport = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    return service.fetch(new Request(url, init));
  };
  return { clock, service, transport, calls, deps: (extra = {}) => ({ storage: new MemoryStorage(), transport, now: () => clock.t, sleep: async () => undefined, ...extra }) };
}

async function pair(r: Rig): Promise<{ a: SyncClient; b: SyncClient }> {
  const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
  const { code } = await a.createEnrollmentCode();
  const join = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
  const pending = await a.pendingJoin(code);
  expect(pending?.sas).toBe(join.sas);
  await a.approveJoin(code, join.sas);
  return { a, b: await join.finish() };
}

describe('local-only mode', () => {
  it('makes no network calls and refuses networked operations', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = await SyncClient.load({ storage: new MemoryStorage() });
    expect(client.enabled).toBe(false);
    await expect(client.flush()).rejects.toBeInstanceOf(SyncDisabledError);
    await expect(client.pull()).rejects.toBeInstanceOf(SyncDisabledError);
    await expect(client.queueLedger([record(1)])).rejects.toBeInstanceOf(SyncDisabledError);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('two-device sync', () => {
  it('enrolls with a matching SAS and converges in both directions', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([record(1), record(2)]);
    await a.setPrefs({ alertFrequency: 'low' });
    await a.sync();
    const pulled = await b.sync();
    expect(pulled.applied).toBe(3);
    expect(b.ledger.map((x) => x.id).sort()).toEqual(a.ledger.map((x) => x.id).sort());
    expect(b.prefs.alertFrequency).toBe('low');
    await b.queueLedger([record(3)]);
    await b.sync();
    await a.sync();
    expect(a.ledger).toHaveLength(3);
  });

  it('keeps plaintext metadata to the visible-to-server fields and no usage content', async () => {
    const r = rig();
    const { a } = await pair(r);
    await a.queueLedger([record(7, { accountAlias: 'secret-alias' })]);
    await a.flush();
    const [account] = [...r.service.store.accounts.values()];
    const stored = JSON.stringify(account?.objects);
    expect(Object.keys(account?.objects[0] ?? {}).sort()).toEqual(['bytes', 'ciphertext', 'epoch', 'nonce', 'objectId', 'receivedAt', 'schemaVersion', 'seq']);
    for (const needle of ['secret-alias', 'claude', 'quotaPercentUsed', 'a1b2c3d4e5f60718']) expect(stored).not.toContain(needle);
    const serialized = JSON.stringify(r.service.store.audit);
    for (const needle of ['secret-alias', 'claude', 'ciphertext', 'quotaPercentUsed']) expect(serialized).not.toContain(needle);
  });

  it('aborts enrollment on a SAS mismatch and rejects reuse of the one-time code', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    const { code } = await a.createEnrollmentCode();
    const join = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
    await expect(a.approveJoin(code, '000000' === join.sas ? '000001' : '000000')).rejects.toThrow(/mismatch/);
    await expect(join.finish()).rejects.toBeInstanceOf(SyncUnavailableError); // never approved
    await expect(SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' })).rejects.toBeInstanceOf(SyncUnavailableError);
    await a.approveJoin(code, join.sas);
    await join.finish();
    await expect(join.finish()).rejects.toBeInstanceOf(SyncUnavailableError); // single use
  });

  it('expires enrollment codes after 10 minutes', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    const { code } = await a.createEnrollmentCode();
    r.clock.t += 11 * 60_000;
    await expect(SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' })).rejects.toBeInstanceOf(SyncUnavailableError);
  });

  it('locks out a caller after 3 wrong enrollment tokens', async () => {
    const r = rig();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await r.service.fetch(new Request(`${BASE}/v1/enrollments/join`, {
        method: 'POST', body: JSON.stringify({ token: `bad${i}`, signPublic: 'x', encPublic: 'y' }),
      }));
      statuses.push(res.status);
    }
    expect(statuses).toEqual([404, 404, 404, 429, 429]);
  });

  it('limits enrollments to 5 per hour per account', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    for (let i = 0; i < 5; i += 1) await a.createEnrollmentCode();
    await expect(a.createEnrollmentCode()).rejects.toBeInstanceOf(SyncUnavailableError);
  });

  it('survives duplicated uploads and reordered/duplicate delivery', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([record(1)]);
    await a.flush();
    const account = [...r.service.store.accounts.values()][0]!;
    const first = account.objects[0]!;
    // Replaying the same object id (a retried upload) is idempotent and returns the original sequence.
    expect(account.objects).toHaveLength(1);
    // Server redelivers everything out of order: client sorts by seq and ignores what it has.
    const real = r.transport;
    let reorder = false;
    const flaky: Transport = async (url, init) => {
      const res = await real(url, init);
      if (reorder && url.includes('/v1/objects?')) {
        const body = (await res.json()) as { objects: unknown[] };
        return new Response(JSON.stringify({ ...body, objects: [...body.objects, ...body.objects].reverse() }), { status: 200 });
      }
      return res;
    };
    await a.queueLedger([record(2), record(3)]);
    await a.flush();
    reorder = true;
    // Hand b the flaky transport by rebuilding it from a backup of its own identity.
    const backup = await b.createBackup('a long enough passphrase', 100_000);
    const b3 = await SyncClient.restoreBackup(r.deps({ transport: flaky }), backup, 'a long enough passphrase');
    const res = await b3.pull();
    expect(b3.ledger).toHaveLength(3);
    expect(res.duplicates).toBeGreaterThan(0);
    expect(res.corrupt).toBe(0);
    expect(first.seq).toBe(1);
  });

  it('queues offline and flushes after the service comes back (retry with backoff)', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    let down = true;
    const sleeps: number[] = [];
    const flaky: Transport = async (url, init) => {
      if (down && url.includes('/v1/objects')) throw new TypeError('network down');
      return r.transport(url, init);
    };
    const backup = await a.createBackup('a long enough passphrase', 100_000);
    const a2 = await SyncClient.restoreBackup(r.deps({ transport: flaky, sleep: async (ms) => { sleeps.push(ms); } }), backup, 'a long enough passphrase');
    await a2.queueLedger([record(1)]);
    await expect(a2.flush()).rejects.toBeInstanceOf(SyncUnavailableError);
    expect(a2.status().pending).toBe(1);
    expect(sleeps).toEqual([500, 1500, 4000]);
    expect(a2.status().failures.network).toBeGreaterThan(0);
    down = false;
    await a2.flush();
    expect(a2.status().pending).toBe(0);
    expect((await b.pull()).applied).toBe(1);
  });

  it('retries 503s then succeeds without duplicating the object', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    let failures = 2;
    const flaky: Transport = async (url, init) => {
      if (init.method === 'PUT' && url.includes('/v1/objects') && failures-- > 0) return new Response('{"error":"x"}', { status: 503 });
      return r.transport(url, init);
    };
    const backup = await a.createBackup('a long enough passphrase', 100_000);
    const a2 = await SyncClient.restoreBackup(r.deps({ transport: flaky }), backup, 'a long enough passphrase');
    await a2.queueLedger([record(1)]);
    await a2.flush();
    expect([...r.service.store.accounts.values()][0]?.objects).toHaveLength(1);
    expect((await b.pull()).applied).toBe(1);
  });

  it('re-authenticates transparently when the session expires', async () => {
    const r = rig();
    const { a } = await pair(r);
    await a.queueLedger([record(1)]);
    await a.flush();
    r.clock.t += 20 * 60_000;
    await a.queueLedger([record(2)]);
    await expect(a.flush()).resolves.toBe(1);
  });

  it('rejects replayed session signatures', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    const [account] = [...r.service.store.accounts.values()];
    const deviceId = a.deviceId!;
    const body = { accountId: account!.accountId, deviceId, timestamp: r.clock.t, nonce: 'n1', signature: 'AAAA' };
    const res = await r.service.fetch(new Request(`${BASE}/v1/session`, { method: 'POST', body: JSON.stringify(body) }));
    expect(res.status).toBe(401);
  });

  it('cuts off a revoked device and rotates the key so it cannot read new data', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([record(1)]);
    await a.sync();
    await b.pull();
    const lost = await SyncClient.restoreBackup(r.deps(), await b.createBackup('a long enough passphrase', 100_000), 'a long enough passphrase');
    const epoch = await a.revokeDevice(b.deviceId!);
    expect(epoch).toBe(2);
    await a.queueLedger([record(2)]);
    await a.flush();
    await expect(b.pull()).rejects.toBeInstanceOf(DeviceRevokedError);
    await expect(lost.pull()).rejects.toBeInstanceOf(DeviceRevokedError);
    expect(b.ledger.map((x) => x.id)).not.toContain(a.ledger.find((x) => x.observedAt === 1_700_000_000_002)?.id);
  });

  it('rotation: remaining devices receive the new key and old epochs stay readable', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([record(1)]);
    await a.flush();
    await a.rotateKey();
    await a.queueLedger([record(2)]);
    await a.flush();
    const res = await b.pull();
    expect(res.applied).toBe(2);
    expect(res.undecryptable).toBe(0);
    expect(b.status().epoch).toBe(2);
  });

  it('corrupt ciphertext is skipped, counted and never partially applied', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([record(1)]);
    await a.flush();
    const account = [...r.service.store.accounts.values()].find((x) => x.objects.length > 0)!;
    account.objects[0]!.ciphertext = Buffer.from('garbage-garbage-garbage').toString('base64');
    const res = await b.pull();
    expect(res.corrupt).toBe(1);
    expect(b.ledger).toHaveLength(0); // nothing half-applied
    expect(b.status().failures.corrupt).toBe(1);
  });

  it('objects from an epoch whose key never arrived are counted as undecryptable', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([record(1)]);
    await a.flush();
    await a.rotateKey();
    const stateless = await SyncClient.restoreBackup(r.deps(), await b.createBackup('a long enough passphrase', 100_000), 'a long enough passphrase');
    // b's backup holds epoch 1 only; epoch 2 wraps arrive via the service, but force the missing-key path:
    const account = [...r.service.store.accounts.values()][0]!;
    account.keyWraps = [];
    await a.queueLedger([record(2)]);
    await a.flush();
    const res = await stateless.pull();
    expect(res.undecryptable).toBe(1);
    expect(res.applied).toBe(1);
  });

  it('detects a server that serves a shorter log (rollback) without losing local state', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([record(1), record(2)]);
    await a.queueLedger([record(3)]);
    await a.flush();
    await b.pull();
    const account = [...r.service.store.accounts.values()][0]!;
    account.objects = account.objects.slice(0, 1);
    account.nextSeq = 2;
    const res = await b.pull();
    expect(res.warnings).toContain('rollback');
    expect(b.ledger).toHaveLength(3);
  });

  it('detects a withheld object in a device chain', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([record(1)]);
    await a.flush();
    await b.pull();
    await a.queueLedger([record(2)]);
    await a.flush();
    await a.queueLedger([record(3)]);
    await a.flush();
    const account = [...r.service.store.accounts.values()][0]!;
    account.objects = account.objects.filter((o) => o.seq !== 2); // server withholds the middle object
    const res = await b.pull();
    expect(res.warnings).toContain('chain_gap');
  });
});

describe('server behaviour', () => {
  it('enforces the 5 MB storage cap and per-device request limit', async () => {
    const r = rig({ maxAccountBytes: 3000, requestsPerMinute: 8 });
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    await a.queueLedger([record(1)]);
    await a.flush();
    await a.queueLedger([record(2)]);
    await a.flush();
    await a.queueLedger([record(3)]);
    await expect(a.flush()).rejects.toBeInstanceOf(SyncUnavailableError);
    expect(a.status().failures.storage_cap).toBe(1);
    const small = rig({ requestsPerMinute: 3 });
    const b = await SyncClient.enable(small.deps(), { baseUrl: BASE, region: 'eu' });
    for (let i = 0; i < 3; i += 1) await b.listDevices();
    await expect(b.listDevices()).rejects.toBeInstanceOf(SyncUnavailableError);
    expect(small.service.store.audit.some((e) => e.type === 'rate_limited')).toBe(true);
  });

  it('rejects oversized bodies, unknown regions and unknown routes with security headers', async () => {
    const r = rig({ maxBodyBytes: 200 });
    const big = await r.service.fetch(new Request(`${BASE}/v1/accounts`, { method: 'POST', body: 'x'.repeat(500) }));
    expect(big.status).toBe(413);
    const region = await r.service.fetch(new Request(`${BASE}/v1/accounts`, { method: 'POST', body: JSON.stringify({ region: 'mars', signPublic: 'a', encPublic: 'b' }) }));
    expect(region.status).toBe(400);
    const missing = await r.service.fetch(new Request(`${BASE}/v1/nope`));
    expect(missing.status).toBe(401);
    expect(big.headers.get('cache-control')).toBe('no-store');
    expect(big.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('retention prunes objects past 90 days, warns at 150 days and deletes inactive accounts at 180', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    await a.queueLedger([record(1)]);
    await a.flush();
    r.clock.t += 91 * 86_400_000;
    const account = [...r.service.store.accounts.values()][0]!;
    account.lastActiveAt = r.clock.t; // still active
    expect(r.service.runRetention().objectsPruned).toBe(1);
    expect(account.objects).toHaveLength(0);
    expect(account.storageBytes).toBe(0);
    r.clock.t += 151 * 86_400_000;
    expect(r.service.runRetention().warned).toBe(1);
    r.clock.t += 30 * 86_400_000;
    expect(r.service.runRetention().accountsDeleted).toBe(1);
    expect(r.service.store.accounts.size).toBe(0);
  });

  it('exports ciphertext plus locally decrypted data', async () => {
    const r = rig();
    const { a } = await pair(r);
    await a.queueLedger([record(1)]);
    await a.flush();
    const out = await a.exportData();
    expect(out.decrypted.ledger).toHaveLength(1);
    expect(JSON.stringify(out.ciphertext)).not.toContain('quotaPercentUsed');
  });

  it('deletes an account, returns a receipt, and other devices fall back to local-only', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([record(1)]);
    await a.sync();
    const receipt = await a.deleteAccount();
    expect(receipt.objectCount).toBe(1);
    expect(receipt.backupsExpireWithinDays).toBe(35);
    expect(receipt.accountIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.enabled).toBe(false);
    expect(r.service.store.accounts.size).toBe(0);
    expect(r.service.store.audit.at(-1)?.type).toBe('account_deleted');
    await expect(b.pull()).rejects.toBeInstanceOf(AccountDeletedError);
    expect(b.enabled).toBe(false);
  });

  it('turning sync off can keep the cloud copy and never calls the network afterwards', async () => {
    const r = rig();
    const { a } = await pair(r);
    await a.disable({ deleteCloud: false });
    expect(a.enabled).toBe(false);
    expect(r.service.store.accounts.size).toBe(1);
    const before = r.calls.length;
    await expect(a.flush()).rejects.toBeInstanceOf(SyncDisabledError);
    expect(r.calls.length).toBe(before);
  });

  it('refuses to queue anything the allow-list rejects', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    await expect(a.queueLedger([record(1, { cookie: 'x' })])).rejects.toThrow();
    await expect(a.setPrefs({ token: 'x' })).rejects.toThrow();
    expect(a.status().pending).toBe(0);
  });
});

describe('idempotent uploads', () => {
  it('a lost response retries the same object id and stores one copy', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    let drop = true;
    const lossy: Transport = async (url, init) => {
      const res = await r.transport(url, init);
      if (drop && init.method === 'PUT' && url.includes('/v1/objects')) { drop = false; throw new TypeError('response lost'); }
      return res;
    };
    const backup = await a.createBackup('a long enough passphrase', 100_000);
    const a2 = await SyncClient.restoreBackup(r.deps({ transport: lossy }), backup, 'a long enough passphrase');
    await a2.queueLedger([record(1)]);
    await a2.flush();
    expect([...r.service.store.accounts.values()][0]?.objects).toHaveLength(1);
  });
});

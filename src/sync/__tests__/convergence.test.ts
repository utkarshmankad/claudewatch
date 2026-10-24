import { describe, expect, it } from 'vitest';
import { MemoryStorage, SyncClient, AccountDeletedError, DeviceRevokedError, SyncUnavailableError } from '../client/client.js';
import type { ClientDeps, Transport } from '../client/client.js';
import { createSyncService } from '../service/handler.js';
import { deriveAccountAlias, deriveEventId, canonicalJson, withEventId } from '../convergence/ids.js';
import { effectiveRecords, emptyLedger, mergeRecord, resetBoundaries } from '../convergence/ledgerMerge.js';
import { applyPrefWrite, emptyPrefs, PENDING_SEQ, visiblePrefs } from '../convergence/prefsMerge.js';
import type { SyncLedgerRecord } from '../e2ee/allowlist.js';
import { fromB64, seal } from '../e2ee/crypto.js';

const BASE = 'https://sync.test';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function snapshot(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'provider_snapshot', provider: 'claude', accountAlias: 'work', devicePseudonym: 'a1b2c3d4e5f60718', observedAt: 1_700_000_000_000 + n,
    source: 'web', confidence: 'high', measurementMethod: 'provider_reported', measures: { quotaPercentUsed: n % 100 }, ...overrides,
  };
}

async function rec(n: number, overrides: Record<string, unknown> = {}): Promise<SyncLedgerRecord> {
  return (await withEventId(snapshot(n, overrides))) as unknown as SyncLedgerRecord;
}

interface Rig {
  clock: { t: number };
  service: ReturnType<typeof createSyncService>;
  down: { value: boolean };
  deps: (extra?: Partial<ClientDeps>) => ClientDeps;
}

function rig(): Rig {
  const clock = { t: 1_800_000_000_000 };
  const down = { value: false };
  const service = createSyncService({ now: () => clock.t });
  const transport: Transport = async (url, init) => {
    if (down.value) throw new TypeError('offline');
    return service.fetch(new Request(url, init));
  };
  return { clock, service, down, deps: (extra = {}) => ({ storage: new MemoryStorage(), transport, now: () => clock.t, sleep: async () => undefined, retryDelaysMs: [], ...extra }) };
}

async function join(r: Rig, a: SyncClient): Promise<SyncClient> {
  const { code } = await a.createEnrollmentCode();
  const j = await SyncClient.startJoin(r.deps(), { baseUrl: BASE, code, region: 'eu' });
  await a.approveJoin(code, j.sas);
  return j.finish();
}

async function pair(r: Rig): Promise<{ a: SyncClient; b: SyncClient }> {
  const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
  return { a, b: await join(r, a) };
}

const ids = (c: SyncClient): string[] => c.allRecords.map((x) => x.id).sort();

describe('deterministic identifiers', () => {
  it('derives the same id regardless of key order and ignores a supplied id', async () => {
    const x = snapshot(1);
    const reordered = Object.fromEntries(Object.entries(x).reverse());
    expect(await deriveEventId(x)).toBe(await deriveEventId(reordered));
    expect(await deriveEventId({ ...x, id: 'ffffffffffffffff' })).toBe(await deriveEventId(x));
    expect(await deriveEventId(x)).toMatch(/^[0-9a-f]{32}$/);
    expect(await deriveEventId(snapshot(2))).not.toBe(await deriveEventId(x));
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
  });

  it('gives one provider account the same alias on every device without exposing the raw id', async () => {
    const alias = await deriveAccountAlias('claude', 'Person@Example.com');
    expect(alias).toBe(await deriveAccountAlias('claude', ' person@example.com '));
    expect(alias).not.toBe(await deriveAccountAlias('chatgpt', 'person@example.com'));
    expect(alias).toMatch(/^acct-[0-9a-f]{12}$/);
    expect(alias).not.toMatch(/person|example|@/);
  });

  it('lets two devices queue the same event and end with one record', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([snapshot(5)]);
    await b.queueLedger([snapshot(5)]);
    await a.sync(); await b.sync(); await a.sync();
    expect(a.allRecords).toHaveLength(1);
    expect(ids(a)).toEqual(ids(b));
  });
});

describe('ledger merge', () => {
  it('is order independent, idempotent and never uses the observation time to decide', async () => {
    const records = await Promise.all([1, 2, 3, 4].map((n) => rec(n, { observedAt: 9_000_000_000_000 - n * 1000 })));
    const permutations = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 1, 3, 3, 0, 2]];
    const results: string[] = [];
    for (const order of permutations) {
      const state = emptyLedger();
      for (const i of order) await mergeRecord(state, records[i]!);
      results.push(JSON.stringify(effectiveRecords(state).map((x) => x.id)));
      expect(state.conflicts).toEqual([]);
    }
    expect(new Set(results).size).toBe(1);
  });

  it('rejects a record whose id is not its content hash when ids are strict', async () => {
    const forged = { ...(await rec(1)), id: 'abcdef0123456789abcdef0123456789' };
    expect(await mergeRecord(emptyLedger(), forged, { strictIds: true })).toBe('rejected');
    expect(await mergeRecord(emptyLedger(), await rec(1), { strictIds: true })).toBe('applied');
  });

  it('keeps the same winner on both devices for an id collision and surfaces it', async () => {
    const one = { ...(await rec(1)), id: 'c0ffee00c0ffee00c0ffee00c0ffee00' };
    const two = { ...(await rec(2)), id: one.id };
    const left = emptyLedger(); const right = emptyLedger();
    expect(await mergeRecord(left, one)).toBe('applied');
    expect(await mergeRecord(left, two)).toBe('conflict');
    await mergeRecord(right, two); await mergeRecord(right, one);
    expect(left.records[one.id]).toEqual(right.records[one.id]);
    expect(left.conflicts).toEqual(right.conflicts);
    expect(left.conflicts[0]?.kind).toBe('id_collision');
  });

  it('applies a single correction but keeps competing corrections visible until resolved', async () => {
    const original = await rec(1);
    const fixA = await rec(2, { kind: 'correction', supersedes: original.id, correctionReason: 'parser_fix', measures: { quotaPercentUsed: 10 } });
    const fixB = await rec(3, { kind: 'correction', supersedes: original.id, correctionReason: 'user_edit', measures: { quotaPercentUsed: 20 } });
    const state = emptyLedger();
    await mergeRecord(state, original); await mergeRecord(state, fixA);
    expect(effectiveRecords(state).map((x) => x.id)).toEqual([fixA.id]);
    await mergeRecord(state, fixB);
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]).toMatchObject({ kind: 'competing_correction', subject: original.id });
    expect(effectiveRecords(state).map((x) => x.id).sort()).toEqual([original.id, fixA.id, fixB.id].sort());
  });

  it('treats reset reports within the skew tolerance as one boundary and keeps distant ones apart', async () => {
    const at = 1_800_000_000_000;
    const reset = (n: number, resetAt: number, extra: Record<string, unknown> = {}) =>
      rec(n, { kind: 'reset', window: { type: 'five_hour', resetAt }, ...extra });
    const records = [await reset(1, at), await reset(2, at + 2 * 60_000), await reset(3, at + 5 * HOUR), await reset(4, at + 60_000, { provider: 'chatgpt' })];
    const boundaries = resetBoundaries(records);
    expect(boundaries).toHaveLength(3);
    expect(boundaries.find((b) => b.provider === 'claude' && b.resetAt === at)?.recordIds).toHaveLength(2);
    expect(resetBoundaries([...records].reverse())).toEqual(boundaries);
  });
});

describe('preference merge', () => {
  const write = (value: unknown, seq: number, by: string, base: number) => ({ value, seq, by, base });

  it('applies sequential writes without a conflict', () => {
    const s = emptyPrefs();
    applyPrefWrite(s, 'alertFrequency', write('low', 1, 'A', 0));
    applyPrefWrite(s, 'alertFrequency', write('high', 2, 'B', 1));
    expect(visiblePrefs(s)).toEqual({ alertFrequency: 'high' });
    expect(s.conflicts).toEqual([]);
  });

  it('orders by server sequence and surfaces writes that never saw each other, identically in either arrival order', () => {
    const a = write('low', 3, 'A', 1); const b = write('high', 4, 'B', 1);
    const one = emptyPrefs(); const two = emptyPrefs();
    applyPrefWrite(one, 'alertFrequency', a); applyPrefWrite(one, 'alertFrequency', b);
    applyPrefWrite(two, 'alertFrequency', b); applyPrefWrite(two, 'alertFrequency', a);
    expect(visiblePrefs(one)).toEqual({ alertFrequency: 'high' });
    expect(visiblePrefs(two)).toEqual(visiblePrefs(one));
    expect(one.conflicts).toHaveLength(1);
    expect(two.conflicts).toEqual(one.conflicts);
    // A write that saw both closes the conflict.
    applyPrefWrite(one, 'alertFrequency', write('normal', 5, 'A', 4));
    expect(one.conflicts).toEqual([]);
  });

  it('adopts the server sequence when a pending local write comes back, including inside an open conflict', () => {
    const s = emptyPrefs();
    applyPrefWrite(s, 'planLabel', write('mine', PENDING_SEQ, 'A', 0));
    applyPrefWrite(s, 'planLabel', write('theirs', 2, 'B', 0));
    expect(s.conflicts).toHaveLength(1);
    applyPrefWrite(s, 'planLabel', write('mine', 3, 'A', 0));
    expect(s.register['planLabel']?.seq).toBe(3);
    expect(s.conflicts[0]?.winner.seq).toBe(3);
  });
});

describe('two devices converge', () => {
  it('merges concurrent offline ledger edits from both devices', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([snapshot(1), snapshot(2)]);
    await b.queueLedger([snapshot(3), snapshot(2)]);
    await a.sync(); await b.sync(); await a.sync();
    expect(ids(a)).toEqual(ids(b));
    expect(a.allRecords).toHaveLength(3);
  });

  it('surfaces concurrent preference edits on both devices and resolves them for both', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.setPrefs({ alertFrequency: 'low' });
    await b.setPrefs({ alertFrequency: 'high' });
    await a.sync(); await b.sync(); await a.sync();
    expect(a.prefs).toEqual(b.prefs);
    expect(a.conflicts().prefs).toHaveLength(1);
    expect(b.conflicts().prefs).toHaveLength(1);
    const winner = a.prefs.alertFrequency;
    const loserValue = a.conflicts().prefs[0]?.loser.value;
    expect(loserValue).not.toBe(winner);
    await b.resolvePrefConflict('alertFrequency', 'loser');
    await b.sync(); await a.sync();
    expect(a.prefs.alertFrequency).toBe(loserValue);
    expect(b.prefs.alertFrequency).toBe(loserValue);
    expect(a.conflicts().prefs).toEqual([]);
    expect(b.conflicts().prefs).toEqual([]);
  });

  it('does not report a conflict when the second edit was made after seeing the first', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.setPrefs({ alertFrequency: 'low' });
    await a.sync(); await b.sync();
    await b.setPrefs({ alertFrequency: 'high' });
    await b.sync(); await a.sync();
    expect(a.prefs.alertFrequency).toBe('high');
    expect(a.conflicts().prefs).toEqual([]);
  });

  it('lets the server sequence, not a skewed device clock within the 2 minute window, decide', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps({ now: () => r.clock.t + 90_000 }), { baseUrl: BASE, region: 'eu' });
    const b = await join(r, a);
    await a.setPrefs({ planLabel: 'clock-ahead' });
    await a.flush();
    r.clock.t += 1000;
    await b.pull();
    await b.setPrefs({ planLabel: 'clock-behind' });
    await b.sync(); await a.sync();
    expect(a.prefs.planLabel).toBe('clock-behind');
    expect(b.prefs.planLabel).toBe('clock-behind');
  });

  it('catches up after a long offline period, with an expired session', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.queueLedger([snapshot(1)]);
    await a.sync(); await b.sync();
    r.down.value = true;
    await b.queueLedger([snapshot(2)]);
    await b.setPrefs({ alertFrequency: 'off' });
    await expect(b.sync()).rejects.toBeInstanceOf(SyncUnavailableError);
    expect(b.freshness()).toMatchObject({ state: 'pending_upload', unsyncedChanges: 2 });
    r.clock.t += 20 * DAY;
    r.down.value = false;
    await a.queueLedger([snapshot(3)]);
    await a.sync(); await b.sync(); await a.sync();
    expect(ids(a)).toEqual(ids(b));
    expect(a.allRecords).toHaveLength(3);
    expect(a.prefs.alertFrequency).toBe('off');
    expect(b.freshness().state).toBe('in_sync');
  });

  it('converges reset-boundary events reported by both devices', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    const resetAt = 1_800_000_000_000 + 5 * HOUR;
    await a.queueLedger([snapshot(1, { kind: 'reset', window: { type: 'five_hour', resetAt }, devicePseudonym: 'aaaaaaaaaaaaaaaa' })]);
    await b.queueLedger([snapshot(2, { kind: 'reset', window: { type: 'five_hour', resetAt: resetAt + 90_000 }, devicePseudonym: 'bbbbbbbbbbbbbbbb' })]);
    await a.sync(); await b.sync(); await a.sync();
    expect(a.allRecords).toHaveLength(2);
    expect(resetBoundaries(a.allRecords)).toHaveLength(1);
    expect(resetBoundaries(b.allRecords)).toEqual(resetBoundaries(a.allRecords));
  });

  it('holds back objects from a newer client without calling them corrupt, then replays them', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    // Device B plays a newer client: it seals a v2 envelope the way a future version would.
    const bs = (b as unknown as { state: { keys: Record<string, string>; accountId: string; deviceId: string; epoch: number } }).state;
    const objectId = 'future-object-1';
    const sealed = await seal(fromB64(bs.keys[String(bs.epoch)]!), { accountId: bs.accountId, objectId, epoch: bs.epoch, schemaVersion: 2 },
      { v: 2, epoch: bs.epoch, sender: bs.deviceId, deviceSeq: 99, prev_hash: '', kind: 'ledger_batch', items: [], extra: 'new-field' });
    await (b as unknown as { api: (m: string, p: string, body: unknown) => Promise<Response> }).api('PUT', '/v1/objects', { objectId, epoch: bs.epoch, schemaVersion: 2, ...sealed });
    await b.queueLedger([snapshot(1)]);
    await b.flush();
    const result = await a.pull();
    expect(result).toMatchObject({ held: 1, corrupt: 0, applied: 1 });
    expect(result.warnings).toContain('newer_schema');
    expect(a.metrics().heldForUpgrade).toBe(1);
    expect(a.status().failures.corrupt).toBeUndefined();
    const replay = await a.replayHeld(); // still the old client, so it is held again rather than lost
    expect(replay.held).toBe(1);
  });

  it('keeps accounts separate after an account switch', async () => {
    const r = rig();
    const first = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    await first.queueLedger([snapshot(1)]);
    await first.sync();
    const storage = new MemoryStorage();
    const old = await SyncClient.enable(r.deps({ storage }), { baseUrl: BASE, region: 'eu' });
    await old.disable({ deleteCloud: false });
    expect(await storage.get()).toBeNull();
    const second = await SyncClient.enable(r.deps({ storage }), { baseUrl: BASE, region: 'eu' });
    await second.sync();
    expect(second.allRecords).toEqual([]);
    expect(second.deviceId).not.toBe(first.deviceId);
    expect(await first.accountAlias('claude', 'one@x.test')).not.toBe(await second.accountAlias('claude', 'two@x.test'));
  });

  it('survives a client saved by 3.2 that lacks the newer fields', async () => {
    const r = rig();
    const storage = new MemoryStorage();
    const a = await SyncClient.enable(r.deps({ storage }), { baseUrl: BASE, region: 'eu' });
    const saved = JSON.parse((await storage.get())!) as Record<string, unknown>;
    for (const key of ['prefsState', 'ledgerConflicts', 'directory', 'metrics', 'localChangeAt']) delete saved[key];
    await storage.set(JSON.stringify(saved));
    const reloaded = await SyncClient.load(r.deps({ storage }));
    await reloaded.setPrefs({ alertFrequency: 'low' });
    await reloaded.queueLedger([snapshot(1)]);
    await reloaded.sync();
    expect(reloaded.metrics().syncAttempts).toBe(1);
    expect(a.deviceId).toBe(reloaded.deviceId);
  });

  it('converges three devices with skewed clocks and random offline edits within two rounds', async () => {
    const r = rig();
    const a = await SyncClient.enable(r.deps({ now: () => r.clock.t - 90_000 }), { baseUrl: BASE, region: 'eu' });
    const b = await join(r, a);
    const c = await join(r, a);
    const devices = [a, b, c];
    let seed = 20261024;
    const rand = (n: number): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
    for (let round = 0; round < 6; round += 1) {
      for (const d of devices) {
        if (rand(3) > 0) await d.queueLedger([snapshot(rand(40), { observedAt: 1_700_000_000_000 + rand(1_000_000) })]);
        if (rand(3) === 0) await d.setPrefs({ alertFrequency: ['off', 'low', 'normal', 'high'][rand(4)] });
        if (rand(2) === 0) await d.sync();
      }
    }
    for (let pass = 0; pass < 2; pass += 1) for (const d of devices) await d.sync();
    expect(ids(b)).toEqual(ids(a));
    expect(ids(c)).toEqual(ids(a));
    expect(b.prefs).toEqual(a.prefs);
    expect(c.prefs).toEqual(a.prefs);
    expect(JSON.stringify(b.conflicts().prefs.map((x) => x.key))).toBe(JSON.stringify(a.conflicts().prefs.map((x) => x.key)));
  });
});

describe('device management', () => {
  it('names, inspects and shows last sync for each device', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await a.nameDevice('Laptop');
    await b.nameDevice('Phone');
    await a.sync(); await b.sync(); await a.sync();
    const devices = await a.inspectDevices();
    expect(devices).toHaveLength(2);
    expect(devices.find((d) => d.current)?.name).toBe('Laptop');
    expect(devices.find((d) => !d.current)?.name).toBe('Phone');
    expect(a.freshness()).toMatchObject({ state: 'in_sync', unsyncedChanges: 0 });
    expect(a.freshness().cloudSyncedAt).toBe(r.clock.t);
  });

  it('keeps local freshness separate from cloud freshness', async () => {
    const r = rig();
    const { a } = await pair(r);
    expect(a.freshness().state).toBe('never_synced');
    await a.sync();
    const synced = r.clock.t;
    r.clock.t += HOUR;
    await a.queueLedger([snapshot(1)]);
    expect(a.freshness()).toMatchObject({ state: 'pending_upload', localChangeAt: r.clock.t, cloudSyncedAt: synced });
  });

  it('rejects an unsafe device name', async () => {
    const r = rig();
    const { a } = await pair(r);
    await expect(a.nameDevice('http://evil.test')).rejects.toThrow();
    await expect(a.nameDevice('me@x.test')).rejects.toThrow();
  });

  it('revokes a device, then removes it; only a revoked device can be removed', async () => {
    const r = rig();
    const { a, b } = await pair(r);
    await b.nameDevice('Lost phone');
    await b.sync(); await a.sync();
    expect(b.deviceId).not.toBeNull();
    await expect(a.removeDevice(b.deviceId!)).rejects.toBeInstanceOf(SyncUnavailableError); // 409: revoke first
    await expect(a.removeDevice(a.deviceId!)).rejects.toThrow(/cannot remove itself/);
    await a.revokeDevice(b.deviceId!);
    await expect(b.sync()).rejects.toBeInstanceOf(DeviceRevokedError);
    await a.removeDevice(b.deviceId!);
    const left = await a.inspectDevices();
    expect(left.map((d) => d.deviceId)).toEqual([a.deviceId]);
    expect(r.service.store.audit.some((e) => e.type === 'device_removed')).toBe(true);
    expect(JSON.stringify(r.service.store.audit)).not.toContain('Lost phone');
  });

  it('propagates account deletion: the other device falls back to local-only', async () => {
    const r = rig();
    const storage = new MemoryStorage();
    const a = await SyncClient.enable(r.deps(), { baseUrl: BASE, region: 'eu' });
    const code = await a.createEnrollmentCode();
    const j = await SyncClient.startJoin(r.deps({ storage }), { baseUrl: BASE, code: code.code, region: 'eu' });
    await a.approveJoin(code.code, j.sas);
    const b = await j.finish();
    await b.sync();
    await a.deleteAccount();
    await expect(b.sync()).rejects.toBeInstanceOf(AccountDeletedError);
    expect(b.enabled).toBe(false);
    expect(await storage.get()).toBeNull();
    expect(b.freshness().state).toBe('local_only');
  });
});

describe('convergence metrics', () => {
  it('records attempts, failures, upload latency and convergence time as numbers only', async () => {
    const r = rig();
    const { a } = await pair(r);
    await a.queueLedger([snapshot(1)]);
    r.clock.t += 4000;
    await a.sync();
    let m = a.metrics();
    expect(m).toMatchObject({ syncAttempts: 1, syncFailures: 0, uploads: 1, lastUploadLatencyMs: 4000, lastConvergenceMs: 4000 });
    r.down.value = true;
    await a.queueLedger([snapshot(2)]);
    await expect(a.sync()).rejects.toBeInstanceOf(SyncUnavailableError);
    m = a.metrics();
    expect(m.syncAttempts).toBe(2);
    expect(m.syncFailures).toBe(1);
    for (const value of Object.values(m)) expect(value === null || typeof value === 'number').toBe(true);
  });
});

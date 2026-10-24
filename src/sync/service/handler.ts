// Ciphertext-log HTTP service. Standard Request/Response so the same handler runs in Node and in a Worker.
// It never decrypts anything and never receives provider cookies or credentials.
import { randomId, sha256Hex, verify } from '../e2ee/crypto.js';
import { MemoryStore } from './store.js';
import type { AccountRecord, AuditEvent, DeviceRecord, KeyWrapRecord } from './store.js';
import {
  DEFAULT_PUSH_HOST_SUFFIXES, PUSH_KINDS, PushValidationError, inQuietHours, pushPayload, pushTtlSeconds,
  validateKinds, validatePushEndpoint, validatePushKeys, validateQuietHours,
} from './push.js';
import type { PushKind, PushSender } from './push.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface SyncServiceConfig {
  regions: string[];
  maxAccountBytes: number; // owner decision 2026-10-23: 5 MB placeholder
  maxBodyBytes: number;
  sessionTtlMs: number;
  requestsPerMinute: number;
  enrollmentsPerHour: number;
  joinAttemptsPerHour: number;
  enrollmentTtlMs: number;
  retentionMs: number;
  inactiveWarnMs: number;
  inactiveDeleteMs: number;
  auditRetentionMs: number;
  backupExpiryDays: number;
  clockWindowMs: number;
  pushHostSuffixes: string[];
  pushSubscriptionTtlMs: number;
  pushDedupeMs: number;
  pushPerDevicePerHour: number;
  notifyPerHour: number;
  trustForwardedFor: boolean; // only behind a proxy that overwrites X-Forwarded-For; otherwise a client could pick its own rate-limit bucket
}

export const DEFAULT_CONFIG: SyncServiceConfig = {
  regions: ['eu', 'us'],
  maxAccountBytes: 5 * 1024 * 1024,
  maxBodyBytes: 1024 * 1024,
  sessionTtlMs: 15 * MINUTE,
  requestsPerMinute: 60,
  enrollmentsPerHour: 5,
  joinAttemptsPerHour: 3,
  enrollmentTtlMs: 10 * MINUTE,
  retentionMs: 90 * DAY,
  inactiveWarnMs: 150 * DAY,
  inactiveDeleteMs: 180 * DAY,
  auditRetentionMs: 30 * DAY,
  backupExpiryDays: 35,
  clockWindowMs: 2 * MINUTE,
  pushHostSuffixes: DEFAULT_PUSH_HOST_SUFFIXES,
  pushSubscriptionTtlMs: 30 * DAY,
  pushDedupeMs: 6 * 60 * MINUTE,
  pushPerDevicePerHour: 12,
  notifyPerHour: 30,
  trustForwardedFor: false,
};

interface Session {
  accountId: string;
  deviceId: string;
  expiresAt: number;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export interface SyncService {
  fetch(request: Request): Promise<Response>;
  runRetention(): { objectsPruned: number; accountsDeleted: number; warned: number };
  /** Live rate-limit windows held in memory (hashed keys only). Exposed so tests and operators can see retention bound it. */
  rateLimitEntries(): number;
  store: MemoryStore;
}

function bucket(bytes: number): string {
  if (bytes < 1024) return '<1KiB';
  if (bytes < 64 * 1024) return '<64KiB';
  if (bytes < 1024 * 1024) return '<1MiB';
  return '>=1MiB';
}

export function createSyncService(options: { store?: MemoryStore; now?: () => number; config?: Partial<SyncServiceConfig>; pushSender?: PushSender } = {}): SyncService {
  const store = options.store ?? new MemoryStore();
  const now = options.now ?? Date.now;
  const config: SyncServiceConfig = { ...DEFAULT_CONFIG, ...options.config };
  const sessions = new Map<string, Session>();
  const seenNonces = new Map<string, number>();
  const windows = new Map<string, { start: number; count: number }>();
  const salt = randomId(16); // rotates on restart; rate-limit keys never persist

  const audit = (event: Omit<AuditEvent, 'at'>): void => {
    store.audit.push({ at: now(), ...event });
  };

  async function limit(key: string, max: number, windowMs: number, accountId?: string): Promise<void> {
    const k = await sha256Hex(`${salt}|${key}`);
    const w = windows.get(k);
    const t = now();
    if (!w || t - w.start >= windowMs) {
      windows.set(k, { start: t, count: 1 });
      return;
    }
    w.count += 1;
    if (w.count > max) {
      audit({ type: 'rate_limited', ...(accountId ? { accountId } : {}) });
      throw new HttpError(429, 'rate_limited');
    }
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'strict-transport-security': 'max-age=63072000; includeSubDomains',
        'cross-origin-resource-policy': 'same-origin',
      },
    });
  }

  async function readJson(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > config.maxBodyBytes) throw new HttpError(413, 'body_too_large');
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('shape');
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'bad_json');
    }
  }

  const str = (v: unknown, max = 4096): string => {
    if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new HttpError(400, 'bad_request');
    return v;
  };
  const int = (v: unknown, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new HttpError(400, 'bad_request');
    return v;
  };

  function getAccount(accountId: string): AccountRecord {
    if (store.deleted.has(accountId)) throw new HttpError(410, 'deleted');
    const account = store.accounts.get(accountId);
    if (!account) throw new HttpError(401, 'unauthorized');
    return account;
  }

  async function authenticate(request: Request): Promise<{ account: AccountRecord; device: DeviceRecord }> {
    const header = request.headers.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const session = sessions.get(await sha256Hex(token));
    if (!token || !session || session.expiresAt <= now()) {
      audit({ type: 'auth_failed' });
      throw new HttpError(401, 'unauthorized');
    }
    const account = getAccount(session.accountId);
    const device = account.devices.get(session.deviceId);
    if (!device || device.revoked) {
      audit({ type: 'auth_failed', accountId: account.accountId });
      throw new HttpError(401, 'device_revoked');
    }
    await limit(`device:${device.deviceId}`, config.requestsPerMinute, MINUTE, account.accountId);
    account.lastActiveAt = now();
    device.lastSeenAt = now();
    return { account, device };
  }

  function addDevice(account: AccountRecord, signPublic: string, encPublic: string): DeviceRecord {
    const device: DeviceRecord = {
      deviceId: randomId(), signPublic, encPublic, enrolledAt: now(), lastSeenAt: now(), revoked: false,
    };
    account.devices.set(device.deviceId, device);
    audit({ type: 'device_enrolled', accountId: account.accountId, deviceId: device.deviceId });
    return device;
  }

  const wrapShape = (v: unknown): KeyWrapRecord['wrapped'] => {
    if (typeof v !== 'object' || v === null) throw new HttpError(400, 'bad_request');
    const w = v as Record<string, unknown>;
    return { ephemeralPublic: str(w['ephemeralPublic'], 256), nonce: str(w['nonce'], 64), ciphertext: str(w['ciphertext'], 512) };
  };

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const ipKey = request.headers.get('cf-connecting-ip') ?? (config.trustForwardedFor ? request.headers.get('x-forwarded-for') : null) ?? 'unknown';

    if (method === 'POST' && path === '/v1/accounts') {
      await limit(`create:${ipKey}`, 10, 60 * MINUTE);
      const body = await readJson(request);
      const region = str(body['region'], 16);
      if (!config.regions.includes(region)) throw new HttpError(400, 'unknown_region');
      const account: AccountRecord = {
        accountId: randomId(), region, createdAt: now(), lastActiveAt: now(), epoch: 1, nextSeq: 1, storageBytes: 0,
        devices: new Map(), objects: [], objectIds: new Map(), keyWraps: [], push: new Map(), pushSent: new Map(),
      };
      store.accounts.set(account.accountId, account);
      audit({ type: 'account_created', accountId: account.accountId });
      const device = addDevice(account, str(body['signPublic'], 256), str(body['encPublic'], 256));
      return json(201, { accountId: account.accountId, deviceId: device.deviceId, epoch: account.epoch, region });
    }

    if (method === 'POST' && path === '/v1/session') {
      await limit(`session:${ipKey}`, 30, MINUTE);
      const body = await readJson(request);
      const accountId = str(body['accountId'], 64);
      const deviceId = str(body['deviceId'], 64);
      const timestamp = int(body['timestamp'], 0, Number.MAX_SAFE_INTEGER);
      const nonce = str(body['nonce'], 64);
      const account = getAccount(accountId);
      const device = account.devices.get(deviceId);
      const fresh = Math.abs(now() - timestamp) <= config.clockWindowMs;
      const nonceKey = `${deviceId}|${nonce}`;
      const replay = seenNonces.has(nonceKey);
      const valid = device !== undefined && !device.revoked && fresh && !replay &&
        (await verify(device.signPublic, `session|${accountId}|${deviceId}|${timestamp}|${nonce}`, str(body['signature'], 256)));
      if (!valid || !device) {
        audit({ type: 'auth_failed', accountId });
        throw new HttpError(401, device?.revoked ? 'device_revoked' : 'unauthorized');
      }
      seenNonces.set(nonceKey, now());
      const token = randomId(32);
      const expiresAt = now() + config.sessionTtlMs;
      sessions.set(await sha256Hex(token), { accountId, deviceId, expiresAt });
      return json(200, { token, expiresAt, epoch: account.epoch });
    }

    if (method === 'POST' && path === '/v1/enrollments/join') {
      // Unauthenticated: the new device presents the one-time token. Wrong tokens count against the caller.
      await limit(`join-fail-check:${ipKey}`, 1000, 60 * MINUTE);
      const body = await readJson(request);
      const tokenHash = await sha256Hex(str(body['token'], 128));
      const enrollment = store.enrollments.get(tokenHash);
      if (!enrollment || enrollment.expiresAt <= now() || enrollment.joined) {
        await limit(`join-wrong:${ipKey}`, config.joinAttemptsPerHour, 60 * MINUTE);
        throw new HttpError(404, 'invalid_token');
      }
      enrollment.joined = { signPublic: str(body['signPublic'], 256), encPublic: str(body['encPublic'], 256), confirm: str(body['confirm'], 128) };
      return json(200, { accountId: enrollment.accountId });
    }

    if (method === 'POST' && path === '/v1/enrollments/status') {
      const body = await readJson(request);
      const tokenHash = await sha256Hex(str(body['token'], 128));
      const enrollment = store.enrollments.get(tokenHash);
      if (!enrollment || enrollment.expiresAt <= now()) throw new HttpError(404, 'invalid_token');
      if (!enrollment.approved) return json(200, { status: 'pending' });
      store.enrollments.delete(tokenHash); // single use
      const a = enrollment.approved;
      return json(200, {
        status: 'approved', accountId: enrollment.accountId, deviceId: a.deviceId, epoch: a.epoch,
        fromEncPublic: a.fromEncPublic, wrapped: a.wrapped,
      });
    }

    // Everything below needs a device session.
    const { account, device } = await authenticate(request);

    if (method === 'POST' && path === '/v1/enrollments') {
      await limit(`enroll:${account.accountId}`, config.enrollmentsPerHour, 60 * MINUTE, account.accountId);
      const token = randomId(16);
      const expiresAt = now() + config.enrollmentTtlMs;
      store.enrollments.set(await sha256Hex(token), { tokenHash: await sha256Hex(token), accountId: account.accountId, expiresAt });
      return json(201, { token, expiresAt });
    }

    if (method === 'POST' && path === '/v1/enrollments/pending') {
      const body = await readJson(request);
      const enrollment = store.enrollments.get(await sha256Hex(str(body['token'], 128)));
      if (!enrollment || enrollment.accountId !== account.accountId || enrollment.expiresAt <= now()) throw new HttpError(404, 'invalid_token');
      return json(200, { joined: enrollment.joined ?? null });
    }

    if (method === 'POST' && path === '/v1/enrollments/approve') {
      const body = await readJson(request);
      const tokenHash = await sha256Hex(str(body['token'], 128));
      const enrollment = store.enrollments.get(tokenHash);
      if (!enrollment || enrollment.accountId !== account.accountId || enrollment.expiresAt <= now() || !enrollment.joined || enrollment.approved) {
        throw new HttpError(404, 'invalid_token');
      }
      // Validate everything before registering the device, so a malformed request cannot leave an orphan active device behind.
      const wrapped = wrapShape(body['wrapped']);
      const epoch = int(body['epoch'], 1, account.epoch);
      const newDevice = addDevice(account, enrollment.joined.signPublic, enrollment.joined.encPublic);
      enrollment.approved = { deviceId: newDevice.deviceId, epoch, fromEncPublic: device.encPublic, wrapped };
      return json(200, { deviceId: newDevice.deviceId });
    }

    if (method === 'GET' && path === '/v1/devices') {
      return json(200, {
        epoch: account.epoch,
        devices: [...account.devices.values()].map((d) => ({
          deviceId: d.deviceId, encPublic: d.encPublic, enrolledAt: d.enrolledAt, lastSeenAt: d.lastSeenAt, revoked: d.revoked,
        })),
      });
    }

    const remove = /^\/v1\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (method === 'DELETE' && remove) {
      const target = account.devices.get(remove[1] ?? '');
      if (!target) throw new HttpError(404, 'unknown_device');
      // Only a revoked device can be removed, and never the caller: removal must not be a way to skip revocation.
      if (!target.revoked || target.deviceId === device.deviceId) throw new HttpError(409, 'revoke_first');
      account.devices.delete(target.deviceId);
      account.push.delete(target.deviceId);
      account.keyWraps = account.keyWraps.filter((w) => w.deviceId !== target.deviceId);
      audit({ type: 'device_removed', accountId: account.accountId, deviceId: target.deviceId });
      return json(200, { ok: true });
    }

    const revoke = /^\/v1\/devices\/([A-Za-z0-9_-]{1,64})\/revoke$/.exec(path);
    if (method === 'POST' && revoke) {
      const target = account.devices.get(revoke[1] ?? '');
      if (!target) throw new HttpError(404, 'unknown_device');
      const body = await readJson(request);
      const newEpoch = int(body['newEpoch'], account.epoch + 1, account.epoch + 1);
      target.revoked = true;
      account.push.delete(target.deviceId);
      for (const [hash, s] of sessions) if (s.deviceId === target.deviceId) sessions.delete(hash);
      account.epoch = newEpoch;
      audit({ type: 'device_revoked', accountId: account.accountId, deviceId: target.deviceId });
      audit({ type: 'epoch_rotated', accountId: account.accountId });
      return json(200, { epoch: account.epoch });
    }

    if (method === 'POST' && path === '/v1/epoch') {
      const body = await readJson(request);
      account.epoch = int(body['newEpoch'], account.epoch + 1, account.epoch + 1);
      audit({ type: 'epoch_rotated', accountId: account.accountId });
      return json(200, { epoch: account.epoch });
    }

    if (method === 'PUT' && path === '/v1/keywraps') {
      const body = await readJson(request);
      const target = account.devices.get(str(body['deviceId'], 64));
      if (!target || target.revoked) throw new HttpError(404, 'unknown_device');
      const epoch = int(body['epoch'], 1, account.epoch);
      account.keyWraps = account.keyWraps.filter((w) => !(w.deviceId === target.deviceId && w.epoch === epoch));
      account.keyWraps.push({ deviceId: target.deviceId, epoch, fromEncPublic: device.encPublic, wrapped: wrapShape(body['wrapped']) });
      return json(200, { ok: true });
    }

    if (method === 'GET' && path === '/v1/keywraps') {
      return json(200, { wraps: account.keyWraps.filter((w) => w.deviceId === device.deviceId) });
    }

    if (method === 'PUT' && path === '/v1/objects') {
      const body = await readJson(request);
      const objectId = str(body['objectId'], 64);
      const existing = account.objectIds.get(objectId);
      if (existing !== undefined) return json(200, { seq: existing, duplicate: true });
      const epoch = int(body['epoch'], 1, account.epoch);
      if (epoch < account.epoch) throw new HttpError(409, 'stale_epoch');
      const ciphertext = str(body['ciphertext'], config.maxBodyBytes);
      const bytes = Buffer.byteLength(ciphertext);
      if (account.storageBytes + bytes > config.maxAccountBytes) throw new HttpError(507, 'storage_cap');
      const record = {
        seq: account.nextSeq++, objectId, epoch, schemaVersion: int(body['schemaVersion'], 1, 1000),
        nonce: str(body['nonce'], 64), ciphertext, bytes, receivedAt: now(),
      };
      account.objects.push(record);
      account.objectIds.set(objectId, record.seq);
      account.storageBytes += bytes;
      audit({ type: 'objects_written', accountId: account.accountId, count: 1, bytesBucket: bucket(bytes) });
      return json(201, { seq: record.seq });
    }

    if (method === 'GET' && path === '/v1/objects') {
      const after = Number(url.searchParams.get('after') ?? '0');
      const max = Math.min(Number(url.searchParams.get('limit') ?? '100'), 200);
      if (!Number.isInteger(after) || after < 0 || !Number.isInteger(max) || max < 1) throw new HttpError(400, 'bad_request');
      const objects = account.objects.filter((o) => o.seq > after).slice(0, max);
      return json(200, { head: account.nextSeq - 1, epoch: account.epoch, objects });
    }

    if (method === 'PUT' && path === '/v1/push/subscription') {
      const body = await readJson(request);
      let sub;
      try {
        const keys = validatePushKeys(body['p256dh'], body['auth']);
        sub = {
          deviceId: device.deviceId, endpoint: validatePushEndpoint(body['endpoint'], config.pushHostSuffixes), ...keys,
          createdAt: now(), expiresAt: now() + config.pushSubscriptionTtlMs,
          quietHours: validateQuietHours(body['quietHours']), kinds: validateKinds(body['kinds']),
        };
      } catch (error) {
        if (error instanceof PushValidationError) throw new HttpError(400, `bad_push_${error.message}`);
        throw error;
      }
      account.push.set(device.deviceId, sub);
      audit({ type: 'push_subscribed', accountId: account.accountId, deviceId: device.deviceId });
      return json(200, { expiresAt: sub.expiresAt });
    }

    if (method === 'GET' && path === '/v1/push/subscription') {
      const sub = account.push.get(device.deviceId);
      if (!sub || sub.expiresAt <= now()) return json(200, { active: false });
      // The endpoint and keys are never echoed back.
      return json(200, { active: true, expiresAt: sub.expiresAt, quietHours: sub.quietHours, kinds: sub.kinds });
    }

    if (method === 'POST' && path === '/v1/push/renew') {
      const sub = account.push.get(device.deviceId);
      if (!sub || sub.expiresAt <= now()) throw new HttpError(404, 'no_subscription');
      sub.expiresAt = now() + config.pushSubscriptionTtlMs;
      return json(200, { expiresAt: sub.expiresAt });
    }

    if (method === 'DELETE' && path === '/v1/push/subscription') {
      if (account.push.delete(device.deviceId)) audit({ type: 'push_revoked', accountId: account.accountId, deviceId: device.deviceId });
      return json(200, { ok: true });
    }

    if (method === 'POST' && path === '/v1/push/notify') {
      if (!options.pushSender) throw new HttpError(503, 'push_unavailable');
      await limit(`notify:${account.accountId}`, config.notifyPerHour, 60 * MINUTE, account.accountId);
      const body = await readJson(request);
      const kind = str(body['kind'], 16) as PushKind;
      if (!PUSH_KINDS.includes(kind)) throw new HttpError(400, 'bad_request');
      const dedupeKey = str(body['dedupeKey'], 64);
      if (!/^[0-9a-f]+$/.test(dedupeKey)) throw new HttpError(400, 'bad_request'); // an opaque hash, never readable text
      const t = now();
      let sent = 0;
      let quiet = 0;
      let duplicate = 0;
      let failed = 0;
      for (const sub of [...account.push.values()]) {
        const target = account.devices.get(sub.deviceId);
        if (sub.deviceId === device.deviceId) continue; // the sender already knows
        if (!target || target.revoked || sub.expiresAt <= t) {
          account.push.delete(sub.deviceId);
          audit({ type: 'push_expired', accountId: account.accountId, deviceId: sub.deviceId });
          continue;
        }
        if (!sub.kinds.includes(kind)) continue;
        if (inQuietHours(t, sub.quietHours)) { quiet += 1; continue; }
        const sentKey = `${sub.deviceId}|${kind}|${dedupeKey}`;
        const prior = account.pushSent.get(sentKey);
        if (prior !== undefined && t - prior < config.pushDedupeMs) { duplicate += 1; continue; }
        const rateKey = `push:${sub.deviceId}`;
        try {
          await limit(rateKey, config.pushPerDevicePerHour, 60 * MINUTE, account.accountId);
        } catch {
          duplicate += 1; // a flood is treated like a duplicate for the caller; the rate_limited audit event is already written
          continue;
        }
        try {
          const result = await options.pushSender({
            endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, payload: pushPayload(kind),
            ttlSeconds: pushTtlSeconds(kind), urgency: kind === 'reset' ? 'low' : 'normal',
          });
          if (result.status === 404 || result.status === 410) {
            account.push.delete(sub.deviceId); // the push service says the subscription is gone
            audit({ type: 'push_expired', accountId: account.accountId, deviceId: sub.deviceId });
          } else if (result.status >= 200 && result.status < 300) {
            account.pushSent.set(sentKey, t);
            sent += 1;
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        }
      }
      if (sent > 0) audit({ type: 'push_sent', accountId: account.accountId, count: sent });
      if (quiet + duplicate > 0) audit({ type: 'push_suppressed', accountId: account.accountId, count: quiet + duplicate });
      return json(200, { sent, suppressed: { quietHours: quiet, duplicate }, failed });
    }

    if (method === 'GET' && path === '/v1/export') {
      return json(200, {
        accountId: account.accountId, region: account.region, epoch: account.epoch, exportedAt: now(),
        devices: [...account.devices.values()].map((d) => ({ deviceId: d.deviceId, enrolledAt: d.enrolledAt, revoked: d.revoked })),
        objects: account.objects,
      });
    }

    if (method === 'DELETE' && path === '/v1/account') {
      const receipt = {
        accountIdHash: await sha256Hex(account.accountId),
        deletedAt: now(),
        objectCount: account.objects.length,
        deviceCount: account.devices.size,
        pushSubscriptionCount: account.push.size,
        backupsExpireWithinDays: config.backupExpiryDays,
      };
      deleteAccount(account.accountId);
      return json(200, receipt);
    }

    throw new HttpError(404, 'not_found');
  }

  function deleteAccount(accountId: string): void {
    const account = store.accounts.get(accountId);
    if (!account) return;
    for (const [hash, s] of sessions) if (s.accountId === accountId) sessions.delete(hash);
    for (const [hash, e] of store.enrollments) if (e.accountId === accountId) store.enrollments.delete(hash);
    store.accounts.delete(accountId);
    store.deleted.set(accountId, now());
    audit({ type: 'account_deleted', accountId });
  }

  return {
    store,
    rateLimitEntries: () => windows.size,
    async fetch(request: Request): Promise<Response> {
      try {
        return await route(request);
      } catch (error) {
        if (error instanceof HttpError) return json(error.status, { error: error.code });
        return json(500, { error: 'internal' });
      }
    },
    runRetention() {
      const t = now();
      let objectsPruned = 0;
      let accountsDeleted = 0;
      let warned = 0;
      for (const account of [...store.accounts.values()]) {
        const inactive = t - account.lastActiveAt;
        if (inactive >= config.inactiveDeleteMs) {
          deleteAccount(account.accountId);
          accountsDeleted += 1;
          continue;
        }
        if (inactive >= config.inactiveWarnMs) {
          audit({ type: 'inactive_warning', accountId: account.accountId });
          warned += 1;
        }
        for (const [deviceId, sub] of account.push) {
          if (sub.expiresAt <= t) {
            account.push.delete(deviceId);
            audit({ type: 'push_expired', accountId: account.accountId, deviceId });
          }
        }
        for (const [key, at] of account.pushSent) if (t - at >= config.pushDedupeMs) account.pushSent.delete(key);
        const keep = account.objects.filter((o) => t - o.receivedAt < config.retentionMs);
        const dropped = account.objects.length - keep.length;
        if (dropped > 0) {
          objectsPruned += dropped;
          account.objects = keep;
          account.storageBytes = keep.reduce((sum, o) => sum + o.bytes, 0);
          audit({ type: 'retention_pruned', accountId: account.accountId, count: dropped });
        }
      }
      store.audit = store.audit.filter((e) => t - e.at < config.auditRetentionMs);
      for (const [id, at] of store.deleted) if (t - at >= config.backupExpiryDays * DAY) store.deleted.delete(id);
      for (const [key, w] of windows) if (t - w.start >= 60 * MINUTE) windows.delete(key);
      for (const [key, at] of seenNonces) if (t - at > config.clockWindowMs * 2) seenNonces.delete(key);
      for (const [hash, s] of sessions) if (s.expiresAt <= t) sessions.delete(hash);
      for (const [hash, e] of store.enrollments) if (e.expiresAt <= t) store.enrollments.delete(hash);
      return { objectsPruned, accountsDeleted, warned };
    },
  };
}

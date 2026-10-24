// Sync client: opt-in, enrollment, encrypted upload/download, retry, rotation, backup.
// Local-only (the default) never touches the network: every networked method checks `enabled` first.
import {
  decryptBackup, encryptBackup, fromB64, generateAccountKey, generateDeviceKeys, MAX_SEALS_PER_EPOCH, open, randomBytes, randomId, seal, sha256Hex,
  shortAuthString, sign, toB64, unwrapAccountKey, wrapAccountKey,
} from '../e2ee/crypto.js';
import type { BackupBlob, DeviceKeys, WrappedKey } from '../e2ee/crypto.js';
import { validateDeviceEntry, validateLedgerRecord, validatePrefs } from '../e2ee/allowlist.js';
import type { SyncLedgerRecord, SyncPrefs } from '../e2ee/allowlist.js';
import { ENVELOPE_VERSION, MAX_ITEMS_PER_ENVELOPE, NewerSchemaError, validateEnvelope } from '../e2ee/envelope.js';
import type { Envelope } from '../e2ee/envelope.js';
import { deriveAccountAlias, deriveEventId } from '../convergence/ids.js';
import { effectiveRecords, mergeRecord } from '../convergence/ledgerMerge.js';
import type { LedgerConflict } from '../convergence/ledgerMerge.js';
import { applyPrefWrite, PENDING_SEQ, visiblePrefs } from '../convergence/prefsMerge.js';
import type { PrefConflict, PrefsState } from '../convergence/prefsMerge.js';
import type { PushKind } from '../service/push.js';

export class SyncDisabledError extends Error {
  constructor() {
    super('sync is in local-only mode');
  }
}
export class AccountDeletedError extends Error {}
export class DeviceRevokedError extends Error {}
export class SyncUnavailableError extends Error {}
export class KeyMissingError extends Error {}

export type FailureReason = 'network' | 'server' | 'rate_limited' | 'auth' | 'corrupt' | 'undecryptable' | 'revoked' | 'deleted' | 'storage_cap';
export type SyncWarning = 'rollback' | 'chain_gap' | 'chain_fork' | 'newer_schema';

interface OutboxItem {
  objectId: string;
  kind: Envelope['kind'];
  items: unknown[];
  baseSeq?: number; // server sequence this device had applied when the change was made
  queuedAt?: number;
}

/** What this device knows about a device's user-chosen name, published by that device. */
export interface DirectoryEntry {
  devicePseudonym: string;
  name: string;
  createdDay: number;
  lastSeenDay: number;
  seq: number;
}

/** Counts and durations only. Never content, ids or names. */
export interface SyncMetrics {
  syncAttempts: number;
  syncFailures: number;
  uploads: number;
  lastUploadLatencyMs: number | null; // queued -> accepted by the service
  lastConvergenceMs: number | null; // previous successful pull -> this one, with nothing left in the queue
  heldForUpgrade: number;
}

const DAY_MS = 86_400_000;
const dayOf = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;

interface SyncState {
  v: 1;
  baseUrl: string;
  region: string;
  accountId: string;
  deviceId: string;
  devicePseudonym: string;
  deviceKeys: DeviceKeys;
  keys: Record<string, string>; // epoch -> base64 account key
  epoch: number;
  seals: Record<string, number>;
  outbox: OutboxItem[];
  deviceSeq: number;
  prevHash: string;
  lastSeq: number;
  head: number;
  chains: Record<string, { seq: number; hash: string }>;
  ledger: Record<string, SyncLedgerRecord>;
  prefs: SyncPrefs;
  lastSyncAt: number | null;
  failures: Partial<Record<FailureReason, number>>;
  // Added by 3.3; absent in states saved by 3.2 and defaulted on load.
  prefsState?: PrefsState;
  ledgerConflicts?: LedgerConflict[];
  directory?: Record<string, DirectoryEntry>;
  metrics?: SyncMetrics;
  localChangeAt?: number | null;
  heldSeqs?: number[];
}

export interface KeyValueStorage {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStorage implements KeyValueStorage {
  value: string | null = null;
  async get(): Promise<string | null> { return this.value; }
  async set(value: string): Promise<void> { this.value = value; }
  async clear(): Promise<void> { this.value = null; }
}

export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

export interface ClientDeps {
  storage: KeyValueStorage;
  transport?: Transport;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
}

interface ServerObject { seq: number; objectId: string; epoch: number; schemaVersion: number; nonce: string; ciphertext: string }

export interface PullResult {
  applied: number;
  duplicates: number;
  corrupt: number;
  undecryptable: number;
  held: number; // written by a newer client; kept for after an upgrade, not applied
  conflicts: number; // open conflicts needing the user
  warnings: SyncWarning[];
}

const DEFAULT_DELAYS = [500, 1500, 4000];

const defaultTransport: Transport = (url, init) => fetch(url, init);

export class SyncClient {
  private session: { token: string; expiresAt: number } | null = null;

  private constructor(private state: SyncState | null, private readonly deps: Required<ClientDeps>) {}

  /** Load persisted state. With nothing stored the client is local-only and makes no network calls. */
  static async load(deps: ClientDeps): Promise<SyncClient> {
    const raw = await deps.storage.get();
    const state = raw ? (JSON.parse(raw) as SyncState) : null;
    if (state) SyncClient.upgradeState(state);
    return new SyncClient(state, SyncClient.fill(deps));
  }

  /** Fill the fields added after 3.2 so older saved states keep working. */
  private static upgradeState(state: SyncState): void {
    state.prefsState ??= { register: {}, conflicts: [] };
    state.ledgerConflicts ??= [];
    state.directory ??= {};
    state.metrics ??= { syncAttempts: 0, syncFailures: 0, uploads: 0, lastUploadLatencyMs: null, lastConvergenceMs: null, heldForUpgrade: 0 };
    state.localChangeAt ??= null;
  }

  private static fill(deps: ClientDeps): Required<ClientDeps> {
    return {
      storage: deps.storage,
      transport: deps.transport ?? defaultTransport,
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      retryDelaysMs: deps.retryDelaysMs ?? DEFAULT_DELAYS,
    };
  }

  get enabled(): boolean {
    return this.state !== null;
  }

  private get s(): SyncState {
    if (!this.state) throw new SyncDisabledError();
    return this.state;
  }

  private async save(): Promise<void> {
    if (this.state) await this.deps.storage.set(JSON.stringify(this.state));
  }

  private fail(reason: FailureReason): void {
    if (!this.state) return;
    this.state.failures[reason] = (this.state.failures[reason] ?? 0) + 1;
  }

  status(): { enabled: boolean; lastSyncAt: number | null; pending: number; epoch: number | null; failures: Partial<Record<FailureReason, number>> } {
    return {
      enabled: this.enabled,
      lastSyncAt: this.state?.lastSyncAt ?? null,
      pending: this.state?.outbox.length ?? 0,
      epoch: this.state?.epoch ?? null,
      failures: { ...(this.state?.failures ?? {}) },
    };
  }

  /** Records the user should see: corrections replace what they supersede, except where corrections compete. */
  get ledger(): SyncLedgerRecord[] {
    return this.state ? effectiveRecords({ records: this.state.ledger, conflicts: this.state.ledgerConflicts ?? [] }) : [];
  }

  /** Every record held, including superseded ones. */
  get allRecords(): SyncLedgerRecord[] {
    return Object.values(this.state?.ledger ?? {});
  }

  get prefs(): SyncPrefs {
    return { ...(this.state?.prefs ?? {}) };
  }

  /** Disagreements that need the user: preference writes that never saw each other, and ledger id/correction clashes. */
  conflicts(): { prefs: PrefConflict[]; ledger: LedgerConflict[] } {
    return { prefs: [...(this.state?.prefsState?.conflicts ?? [])], ledger: [...(this.state?.ledgerConflicts ?? [])] };
  }

  metrics(): SyncMetrics {
    return { ...(this.state?.metrics ?? { syncAttempts: 0, syncFailures: 0, uploads: 0, lastUploadLatencyMs: null, lastConvergenceMs: null, heldForUpgrade: 0 }) };
  }

  /** Local freshness (this device's own data) and cloud freshness (last successful exchange) are different things. */
  freshness(): { localChangeAt: number | null; cloudSyncedAt: number | null; unsyncedChanges: number; state: 'local_only' | 'in_sync' | 'pending_upload' | 'never_synced' } {
    const s = this.state;
    if (!s) return { localChangeAt: null, cloudSyncedAt: null, unsyncedChanges: 0, state: 'local_only' };
    const state = s.outbox.length > 0 ? 'pending_upload' : s.lastSyncAt === null ? 'never_synced' : 'in_sync';
    return { localChangeAt: s.localChangeAt ?? null, cloudSyncedAt: s.lastSyncAt, unsyncedChanges: s.outbox.length, state };
  }

  get deviceId(): string | null {
    return this.state?.deviceId ?? null;
  }

  // ---- opt-in and enrollment ----

  /** Explicit opt-in on the first device: generates keys and creates the account. */
  static async enable(deps: ClientDeps, options: { baseUrl: string; region: string }): Promise<SyncClient> {
    const full = SyncClient.fill(deps);
    const deviceKeys = await generateDeviceKeys();
    const baseUrl = options.baseUrl.replace(/\/$/, '');
    const res = await SyncClient.rawPost(full, `${baseUrl}/v1/accounts`, {
      region: options.region, signPublic: deviceKeys.signPublic, encPublic: deviceKeys.encPublic,
    });
    const data = (await res.json()) as { accountId: string; deviceId: string; epoch: number };
    const client = new SyncClient(
      SyncClient.freshState(baseUrl, options.region, data.accountId, data.deviceId, deviceKeys, data.epoch, toB64(generateAccountKey())),
      full,
    );
    await client.save();
    return client;
  }

  private static freshState(baseUrl: string, region: string, accountId: string, deviceId: string, deviceKeys: DeviceKeys, epoch: number, ak: string): SyncState {
    return {
      v: 1, baseUrl, region, accountId, deviceId, devicePseudonym: Buffer.from(randomBytes(8)).toString('hex'),
      deviceKeys, keys: { [String(epoch)]: ak }, epoch, seals: {}, outbox: [], deviceSeq: 0, prevHash: '', lastSeq: 0, head: 0,
      chains: {}, ledger: {}, prefs: {}, lastSyncAt: null, failures: {},
      prefsState: { register: {}, conflicts: [] }, ledgerConflicts: [], directory: {}, localChangeAt: null,
      metrics: { syncAttempts: 0, syncFailures: 0, uploads: 0, lastUploadLatencyMs: null, lastConvergenceMs: null, heldForUpgrade: 0 },
    };
  }

  private static async rawPost(deps: Required<ClientDeps>, url: string, body: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await deps.transport(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new SyncUnavailableError('network');
    }
    if (!res.ok) throw new SyncUnavailableError(`HTTP ${res.status}`);
    return res;
  }

  /** Existing device: create a one-time enrollment code (token + this device's public key). */
  async createEnrollmentCode(): Promise<{ code: string; expiresAt: number }> {
    const res = await this.api('POST', '/v1/enrollments', {});
    const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: number };
    return { code: `${token}.${Buffer.from(this.s.deviceKeys.encPublic).toString('base64url')}`, expiresAt };
  }

  /** Existing device: the joining device's short authentication string, or null if nobody has joined yet. */
  async pendingJoin(code: string): Promise<{ sas: string } | null> {
    const res = await this.api('POST', '/v1/enrollments/pending', { token: code.split('.')[0] });
    const { joined } = (await res.json()) as { joined: { signPublic: string; encPublic: string } | null };
    if (!joined) return null;
    return { sas: await shortAuthString(this.s.deviceKeys.encPublic, joined.encPublic) };
  }

  /** Existing device: call only after the user confirmed both devices show the same SAS. */
  async approveJoin(code: string, expectedSas: string): Promise<void> {
    const pending = await this.pendingJoin(code);
    if (!pending || pending.sas !== expectedSas) throw new Error('short authentication string mismatch; enrollment aborted');
    const res = await this.api('POST', '/v1/enrollments/pending', { token: code.split('.')[0] });
    const { joined } = (await res.json()) as { joined: { encPublic: string } };
    const ak = this.accountKey(this.s.epoch);
    const wrapped = await wrapAccountKey(ak, joined.encPublic, `enroll|${this.s.accountId}|${this.s.epoch}`);
    await this.api('POST', '/v1/enrollments/approve', { token: code.split('.')[0], wrapped });
  }

  /** New device: present the code. The returned `sas` must be compared with the existing device's. */
  static async startJoin(deps: ClientDeps, options: { baseUrl: string; code: string; region: string }): Promise<{ sas: string; finish: () => Promise<SyncClient> }> {
    const full = SyncClient.fill(deps);
    const baseUrl = options.baseUrl.replace(/\/$/, '');
    const [token, encoded] = options.code.split('.');
    if (!token || !encoded) throw new Error('malformed enrollment code');
    const fromEncPublic = Buffer.from(encoded, 'base64url').toString();
    const deviceKeys = await generateDeviceKeys();
    const res = await SyncClient.rawPost(full, `${baseUrl}/v1/enrollments/join`, {
      token, signPublic: deviceKeys.signPublic, encPublic: deviceKeys.encPublic,
    });
    const { accountId } = (await res.json()) as { accountId: string };
    const sas = await shortAuthString(fromEncPublic, deviceKeys.encPublic);
    const finish = async (): Promise<SyncClient> => {
      const status = await SyncClient.rawPost(full, `${baseUrl}/v1/enrollments/status`, { token });
      const data = (await status.json()) as {
        status: string; deviceId?: string; epoch?: number; fromEncPublic?: string; wrapped?: WrappedKey;
      };
      if (data.status !== 'approved' || !data.deviceId || !data.epoch || !data.wrapped) throw new SyncUnavailableError('enrollment not approved yet');
      if (data.fromEncPublic !== fromEncPublic) throw new Error('enrollment key does not match the code; aborted');
      const ak = await unwrapAccountKey(data.wrapped, deviceKeys.encPrivateJwk, `enroll|${accountId}|${data.epoch}`);
      const client = new SyncClient(
        SyncClient.freshState(baseUrl, options.region, accountId, data.deviceId, deviceKeys, data.epoch, toB64(ak)),
        full,
      );
      await client.save();
      return client;
    };
    return { sas, finish };
  }

  // ---- queueing ----

  /** Validate against the allow-list and queue. Local state updates immediately; upload happens on flush(). */
  async queueLedger(records: Array<Record<string, unknown>>): Promise<void> {
    const s = this.s;
    const valid: SyncLedgerRecord[] = [];
    for (const input of records) {
      // A record without an id gets its content-derived one, so every device names the same event the same way.
      valid.push(validateLedgerRecord(input['id'] === undefined ? { ...input, id: await deriveEventId(input) } : input));
    }
    const ledger = { records: s.ledger, conflicts: s.ledgerConflicts ?? (s.ledgerConflicts = []) };
    const fresh: SyncLedgerRecord[] = [];
    for (const r of valid) if ((await mergeRecord(ledger, r)) === 'applied') fresh.push(r);
    const now = this.deps.now();
    for (let i = 0; i < fresh.length; i += MAX_ITEMS_PER_ENVELOPE) {
      s.outbox.push({ objectId: randomId(), kind: 'ledger_batch', items: fresh.slice(i, i + MAX_ITEMS_PER_ENVELOPE), baseSeq: s.lastSeq, queuedAt: now });
    }
    if (fresh.length > 0) s.localChangeAt = now;
    await this.save();
  }

  async setPrefs(prefs: Record<string, unknown>): Promise<void> {
    const s = this.s;
    const valid = validatePrefs(prefs);
    const reg = s.prefsState ?? (s.prefsState = { register: {}, conflicts: [] });
    for (const [key, value] of Object.entries(valid)) applyPrefWrite(reg, key, { value, seq: PENDING_SEQ, by: s.deviceId, base: s.lastSeq });
    s.prefs = visiblePrefs(reg);
    const now = this.deps.now();
    s.outbox.push({ objectId: randomId(), kind: 'prefs', items: [valid], baseSeq: s.lastSeq, queuedAt: now });
    s.localChangeAt = now;
    await this.save();
  }

  /** Settle an open preference conflict by choosing a value. The new write has seen both sides, so it closes the conflict everywhere. */
  async resolvePrefConflict(key: string, choice: 'winner' | 'loser'): Promise<void> {
    const conflict = (this.s.prefsState?.conflicts ?? []).find((c) => c.key === key);
    if (!conflict) throw new Error(`no open conflict for "${key}"`);
    await this.setPrefs({ [key]: (choice === 'winner' ? conflict.winner : conflict.loser).value });
  }

  // ---- devices ----

  /** Publish this device's own name. Other devices show it as written here; there is no remote rename. */
  async nameDevice(name: string): Promise<void> {
    const s = this.s;
    const now = this.deps.now();
        const dir = s.directory ?? (s.directory = {});
    const entry = { devicePseudonym: s.devicePseudonym, name, createdDay: dir[s.deviceId]?.createdDay ?? dayOf(now), lastSeenDay: dayOf(now) };
    validateDeviceEntry(entry);
    dir[s.deviceId] = { ...entry, seq: PENDING_SEQ };
    s.outbox.push({ objectId: randomId(), kind: 'devices', items: [entry], baseSeq: s.lastSeq, queuedAt: now });
    s.localChangeAt = now;
    await this.save();
  }

  /** Alias for a provider account on this device's ledger records. Identical on every device; the raw identifier is not stored. */
  accountAlias(provider: string, rawAccountId: string): Promise<string> {
    return deriveAccountAlias(provider, rawAccountId);
  }

  /** The service's device list joined with the names devices published. Needs the network for the server half. */
  async inspectDevices(): Promise<Array<{ deviceId: string; name: string | null; enrolledAt: number; lastSeenAt: number; revoked: boolean; current: boolean; lastSeenDay: number | null }>> {
    const dir = this.s.directory ?? {};
    return (await this.listDevices()).map((d) => ({ ...d, name: dir[d.deviceId]?.name ?? null, lastSeenDay: dir[d.deviceId]?.lastSeenDay ?? null }));
  }

  /** Remove a revoked device from the list. Active devices must be revoked first. */
  async removeDevice(deviceId: string): Promise<void> {
    const s = this.s;
    if (deviceId === s.deviceId) throw new Error('this device cannot remove itself; use disable or delete the account');
    await this.api('DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`);
    if (s.directory) delete s.directory[deviceId];
    await this.save();
  }

  // ---- network ----

  private accountKey(epoch: number): Uint8Array {
    const key = this.s.keys[String(epoch)];
    if (!key) throw new KeyMissingError(`no key for epoch ${epoch}`);
    return fromB64(key);
  }

  private async ensureSession(force = false): Promise<string> {
    const s = this.s;
    if (!force && this.session && this.session.expiresAt - 30_000 > this.deps.now()) return this.session.token;
    const timestamp = this.deps.now();
    const nonce = randomId();
    const signature = await sign(s.deviceKeys.signPrivateJwk, `session|${s.accountId}|${s.deviceId}|${timestamp}|${nonce}`);
    const res = await this.deps.transport(`${s.baseUrl}/v1/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: s.accountId, deviceId: s.deviceId, timestamp, nonce, signature }),
    });
    await this.raiseForStatus(res);
    const data = (await res.json()) as { token: string; expiresAt: number };
    this.session = data;
    return data.token;
  }

  private async raiseForStatus(res: Response): Promise<void> {
    if (res.ok) return;
    const code = ((await res.clone().json().catch(() => ({}))) as { error?: string }).error ?? '';
    if (res.status === 410) {
      this.fail('deleted');
      await this.wipe();
      throw new AccountDeletedError('the cloud account was deleted; sync is now local-only');
    }
    if (res.status === 401 && code === 'device_revoked') {
      this.fail('revoked');
      await this.save();
      throw new DeviceRevokedError('this device was revoked');
    }
    if (res.status === 401) { this.fail('auth'); throw new SyncUnavailableError('unauthorized'); }
    if (res.status === 429) { this.fail('rate_limited'); throw new SyncUnavailableError('rate_limited'); }
    if (res.status === 507) { this.fail('storage_cap'); throw new SyncUnavailableError('storage_cap'); }
    if (res.status >= 500) { this.fail('server'); throw new SyncUnavailableError(`HTTP ${res.status}`); }
    throw new SyncUnavailableError(`HTTP ${res.status} ${code}`);
  }

  /** Authenticated request with retry and backoff on network errors, 429 and 5xx; one re-auth on an expired session. */
  private async api(method: string, path: string, body?: unknown): Promise<Response> {
    const s = this.s;
    const delays = this.deps.retryDelaysMs;
    let reauthed = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const token = await this.ensureSession();
        const res = await this.deps.transport(`${s.baseUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (res.status === 401 && !reauthed) {
          const code = ((await res.clone().json().catch(() => ({}))) as { error?: string }).error;
          if (code !== 'device_revoked') {
            reauthed = true;
            this.session = null;
            await this.ensureSession(true);
            attempt -= 1;
            continue;
          }
        }
        await this.raiseForStatus(res);
        return res;
      } catch (error) {
        const retryable = error instanceof SyncUnavailableError && (error.message === 'network' || error.message === 'rate_limited' || error.message.startsWith('HTTP 5'));
        const networkError = !(error instanceof SyncUnavailableError) && !(error instanceof AccountDeletedError) && !(error instanceof DeviceRevokedError) && !(error instanceof SyncDisabledError) && !(error instanceof KeyMissingError);
        if (networkError) this.fail('network');
        if ((retryable || networkError) && attempt < delays.length) {
          await this.deps.sleep(delays[attempt] ?? 0);
          continue;
        }
        await this.save();
        if (networkError) throw new SyncUnavailableError('network');
        throw error;
      }
    }
  }

  /** Upload queued batches in order. A batch keeps its object id across retries so duplicates are harmless. */
  async flush(): Promise<number> {
    const s = this.s;
    let sent = 0;
    while (s.outbox.length > 0) {
      const next = s.outbox[0] as OutboxItem;
      const epoch = s.epoch;
      const count = (s.seals[String(epoch)] ?? 0) + 1;
      if (count > MAX_SEALS_PER_EPOCH) throw new Error('key epoch exhausted; rotate the key');
      const envelope = {
        v: ENVELOPE_VERSION, epoch, sender: s.deviceId, deviceSeq: s.deviceSeq + 1, prev_hash: s.prevHash, kind: next.kind, items: next.items,
        ...(next.baseSeq === undefined ? {} : { baseSeq: next.baseSeq }),
      } as Envelope;
      validateEnvelope(envelope); // never upload something the allow-list would reject
      const sealed = await seal(this.accountKey(epoch), { accountId: s.accountId, objectId: next.objectId, epoch, schemaVersion: ENVELOPE_VERSION }, envelope);
      const res = await this.api('PUT', '/v1/objects', { objectId: next.objectId, epoch, schemaVersion: ENVELOPE_VERSION, ...sealed });
      await res.arrayBuffer();
      s.deviceSeq += 1;
      s.prevHash = await sha256Hex(sealed.ciphertext);
      s.chains[s.deviceId] = { seq: s.deviceSeq, hash: s.prevHash };
      s.seals[String(epoch)] = count;
      s.outbox.shift();
      sent += 1;
      const m = this.metricsRef();
      m.uploads += 1;
      if (next.queuedAt !== undefined) m.lastUploadLatencyMs = Math.max(0, this.deps.now() - next.queuedAt);
      await this.save();
    }
    return sent;
  }

  /** Fetch key wraps addressed to this device (after a rotation or revocation elsewhere). */
  private async collectKeys(): Promise<void> {
    const s = this.s;
    const res = await this.api('GET', '/v1/keywraps');
    const { wraps } = (await res.json()) as { wraps: Array<{ epoch: number; wrapped: WrappedKey }> };
    for (const w of wraps) {
      if (s.keys[String(w.epoch)]) continue;
      try {
        const ak = await unwrapAccountKey(w.wrapped, s.deviceKeys.encPrivateJwk, `keywrap|${s.accountId}|${s.deviceId}|${w.epoch}`);
        s.keys[String(w.epoch)] = toB64(ak);
        if (w.epoch > s.epoch) s.epoch = w.epoch;
      } catch {
        this.fail('undecryptable');
      }
    }
  }

  private metricsRef(): SyncMetrics {
    const s = this.s;
    return (s.metrics ??= { syncAttempts: 0, syncFailures: 0, uploads: 0, lastUploadLatencyMs: null, lastConvergenceMs: null, heldForUpgrade: 0 });
  }

  /** Incremental download: decrypt, validate, dedupe, check chains, apply. Bad objects are skipped, never half-applied. */
  async pull(): Promise<PullResult> {
    const s = this.s;
    const result: PullResult = { applied: 0, duplicates: 0, corrupt: 0, undecryptable: 0, held: 0, conflicts: 0, warnings: [] };
    await this.collectKeys();
    for (;;) {
      const res = await this.api('GET', `/v1/objects?after=${s.lastSeq}&limit=100`);
      const page = (await res.json()) as {
        head: number; epoch: number;
        objects: Array<ServerObject>;
      };
      if (page.head < s.head || page.head < s.lastSeq) {
        if (!result.warnings.includes('rollback')) result.warnings.push('rollback');
        break; // keep local state; do not trust a shorter log
      }
      s.head = page.head;
      if (page.epoch > s.epoch && s.keys[String(page.epoch)]) s.epoch = page.epoch;
      const ordered = [...page.objects].sort((a, b) => a.seq - b.seq);
      for (const obj of ordered) {
        if (obj.seq <= s.lastSeq) { result.duplicates += 1; continue; }
        s.lastSeq = obj.seq;
        await this.processObject(obj, result);
      }
      if (page.objects.length < 100) break;
    }
    s.lastSyncAt = this.deps.now();
    result.conflicts = (s.prefsState?.conflicts.length ?? 0) + (s.ledgerConflicts?.length ?? 0);
    await this.save();
    return result;
  }

  private async processObject(obj: ServerObject, result: PullResult): Promise<void> {
    const s = this.s;
    const keyB64 = s.keys[String(obj.epoch)];
    if (!keyB64) { result.undecryptable += 1; this.fail('undecryptable'); return; }
    let envelope: Envelope;
    try {
      const plain = await open<unknown>(fromB64(keyB64), { accountId: s.accountId, objectId: obj.objectId, epoch: obj.epoch, schemaVersion: obj.schemaVersion }, obj);
      envelope = validateEnvelope(plain);
    } catch (error) {
      if (error instanceof NewerSchemaError) {
        // Written by a newer client: not corrupt. Remember where it is so it can be replayed after an upgrade.
        result.held += 1;
        if (!result.warnings.includes('newer_schema')) result.warnings.push('newer_schema');
        this.metricsRef().heldForUpgrade += 1;
        (s.heldSeqs ??= []).push(obj.seq);
        return;
      }
      result.corrupt += 1;
      this.fail('corrupt');
      return;
    }
    const hash = await sha256Hex(obj.ciphertext);
    this.checkChain(envelope, hash, result);
    result.applied += await this.apply(envelope, obj.seq, result);
  }

  /** After upgrading the client, fetch and apply the objects an older version had to hold back. */
  async replayHeld(): Promise<PullResult> {
    const s = this.s;
    const result: PullResult = { applied: 0, duplicates: 0, corrupt: 0, undecryptable: 0, held: 0, conflicts: 0, warnings: [] };
    const seqs = [...(s.heldSeqs ?? [])];
    s.heldSeqs = [];
    for (const seq of seqs) {
      const res = await this.api('GET', `/v1/objects?after=${seq - 1}&limit=1`);
      const page = (await res.json()) as { objects: ServerObject[] };
      const obj = page.objects.find((o) => o.seq === seq);
      if (obj) await this.processObject(obj, result);
    }
    result.conflicts = (s.prefsState?.conflicts.length ?? 0) + (s.ledgerConflicts?.length ?? 0);
    await this.save();
    return result;
  }

  private checkChain(env: Envelope, hash: string, result: PullResult): void {
    const s = this.s;
    const known = s.chains[env.sender];
    if (!known) {
      s.chains[env.sender] = { seq: env.deviceSeq, hash };
      return;
    }
    if (env.deviceSeq <= known.seq) return; // replay or own echo
    if (env.deviceSeq > known.seq + 1) result.warnings.push('chain_gap');
    else if (env.prev_hash !== known.hash) result.warnings.push('chain_fork');
    s.chains[env.sender] = { seq: env.deviceSeq, hash };
  }

  private async apply(env: Envelope, seq: number, result: PullResult): Promise<number> {
    const s = this.s;
    let applied = 0;
    if (env.kind === 'ledger_batch') {
      const ledger = { records: s.ledger, conflicts: s.ledgerConflicts ?? (s.ledgerConflicts = []) };
      for (const record of env.items) {
        const outcome = await mergeRecord(ledger, record);
        if (outcome === 'applied') applied += 1;
        else result.duplicates += 1;
      }
    } else if (env.kind === 'prefs') {
      const reg = s.prefsState ?? (s.prefsState = { register: {}, conflicts: [] });
      // A 3.2 sender carries no baseSeq; treat its writes as sequential rather than inventing conflicts.
      const base = env.baseSeq ?? seq - 1;
      for (const prefs of env.items) {
        for (const [key, value] of Object.entries(prefs)) if (applyPrefWrite(reg, key, { value, seq, by: env.sender, base })) applied += 1;
      }
      s.prefs = visiblePrefs(reg);
    } else {
      const entry = env.items[0];
      const dir = s.directory ?? (s.directory = {});
      const known = dir[env.sender];
      if (entry && !(known && known.seq !== PENDING_SEQ && known.seq > seq)) {
        dir[env.sender] = {
          ...entry, seq,
          createdDay: Math.min(entry.createdDay, known?.createdDay ?? entry.createdDay),
          lastSeenDay: Math.max(entry.lastSeenDay, known?.lastSeenDay ?? entry.lastSeenDay),
        };
        applied += 1;
      }
    }
    return applied;
  }

  /** Upload, then catch up. Counts attempts and failures, and times how long a queued change took to land. */
  async sync(): Promise<PullResult> {
    const oldest = this.s.outbox.reduce<number | null>((min, item) => (item.queuedAt === undefined ? min : min === null ? item.queuedAt : Math.min(min, item.queuedAt)), null);
    this.metricsRef().syncAttempts += 1;
    try {
      await this.flush();
      const result = await this.pull();
      const m = this.metricsRef();
      if (oldest !== null) m.lastConvergenceMs = Math.max(0, this.deps.now() - oldest);
      await this.save();
      return result;
    } catch (error) {
      if (this.state) {
        this.metricsRef().syncFailures += 1;
        await this.save();
      }
      throw error;
    }
  }

  // ---- devices, rotation, revocation ----

  async listDevices(): Promise<Array<{ deviceId: string; enrolledAt: number; lastSeenAt: number; revoked: boolean; current: boolean }>> {
    const res = await this.api('GET', '/v1/devices');
    const { devices } = (await res.json()) as { devices: Array<{ deviceId: string; enrolledAt: number; lastSeenAt: number; revoked: boolean }> };
    return devices.map((d) => ({ ...d, current: d.deviceId === this.s.deviceId }));
  }

  // ---- companion push (prompt 3.4) ----

  /** Register this device's browser push subscription. The service accepts only hosted push-service endpoints. */
  async registerPush(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    options: { quietHours?: { startMinute: number; endMinute: number; utcOffsetMinutes: number }; kinds?: PushKind[] } = {},
  ): Promise<{ expiresAt: number }> {
    const res = await this.api('PUT', '/v1/push/subscription', {
      endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth,
      ...(options.quietHours ? { quietHours: options.quietHours } : {}), ...(options.kinds ? { kinds: options.kinds } : {}),
    });
    return (await res.json()) as { expiresAt: number };
  }

  async pushStatus(): Promise<{ active: boolean; expiresAt?: number }> {
    return (await (await this.api('GET', '/v1/push/subscription')).json()) as { active: boolean; expiresAt?: number };
  }

  /** Extend the subscription before it expires (30 days by default). */
  async renewPush(): Promise<{ expiresAt: number }> {
    return (await (await this.api('POST', '/v1/push/renew')).json()) as { expiresAt: number };
  }

  async revokePush(): Promise<void> {
    await this.api('DELETE', '/v1/push/subscription');
  }

  /** Ask the service to wake this account's other devices. The request carries a kind and an opaque key, never usage values. */
  async notifyOthers(alert: { kind: PushKind; dedupeKey: string }): Promise<{ sent: number; suppressed: { quietHours: number; duplicate: number }; failed: number }> {
    const res = await this.api('POST', '/v1/push/notify', alert);
    return (await res.json()) as { sent: number; suppressed: { quietHours: number; duplicate: number }; failed: number };
  }

  private async distribute(epoch: number, ak: Uint8Array, exceptDeviceId?: string): Promise<void> {
    const s = this.s;
    const res = await this.api('GET', '/v1/devices');
    const { devices } = (await res.json()) as { devices: Array<{ deviceId: string; encPublic: string; revoked: boolean }> };
    for (const d of devices) {
      if (d.revoked || d.deviceId === s.deviceId || d.deviceId === exceptDeviceId) continue;
      const wrapped = await wrapAccountKey(ak, d.encPublic, `keywrap|${s.accountId}|${d.deviceId}|${epoch}`);
      await this.api('PUT', '/v1/keywraps', { deviceId: d.deviceId, epoch, wrapped });
    }
  }

  /** Rotate to a fresh account key. Old epochs stay readable for devices that hold them. */
  async rotateKey(): Promise<number> {
    const s = this.s;
    const epoch = s.epoch + 1;
    const ak = generateAccountKey();
    await this.api('POST', '/v1/epoch', { newEpoch: epoch });
    s.keys[String(epoch)] = toB64(ak);
    s.epoch = epoch;
    await this.save();
    await this.distribute(epoch, ak);
    return epoch;
  }

  /** Revoke a device and rotate so it cannot read anything written afterwards. */
  async revokeDevice(deviceId: string): Promise<number> {
    const s = this.s;
    const epoch = s.epoch + 1;
    const ak = generateAccountKey();
    await this.api('POST', `/v1/devices/${encodeURIComponent(deviceId)}/revoke`, { newEpoch: epoch });
    s.keys[String(epoch)] = toB64(ak);
    s.epoch = epoch;
    await this.save();
    await this.distribute(epoch, ak, deviceId);
    return epoch;
  }

  // ---- export, deletion, local-only, backup ----

  /** Cloud ciphertext plus a locally decrypted copy of what this device can read. */
  async exportData(): Promise<{ ciphertext: unknown; decrypted: { ledger: SyncLedgerRecord[]; prefs: SyncPrefs } }> {
    const res = await this.api('GET', '/v1/export');
    return { ciphertext: await res.json(), decrypted: { ledger: this.ledger, prefs: this.prefs } };
  }

  /** Delete the cloud account, then fall back to local-only. Returns the service's deletion receipt. */
  async deleteAccount(): Promise<{ accountIdHash: string; deletedAt: number; objectCount: number; backupsExpireWithinDays: number }> {
    const receipt = (await (await this.api('DELETE', '/v1/account')).json()) as {
      accountIdHash: string; deletedAt: number; objectCount: number; backupsExpireWithinDays: number;
    };
    await this.wipe();
    return receipt;
  }

  /** Turn sync off. The local ledger copy is untouched here; optionally ask the service to delete the cloud copy first. */
  async disable(options: { deleteCloud: boolean }): Promise<void> {
    if (!this.state) return;
    if (options.deleteCloud) await this.deleteAccount();
    else await this.wipe();
  }

  private async wipe(): Promise<void> {
    this.state = null;
    this.session = null;
    await this.deps.storage.clear();
  }

  async createBackup(passphrase: string, iterations?: number): Promise<BackupBlob> {
    return encryptBackup(this.s, passphrase, iterations);
  }

  /** Restore this identity (same device keys) from an encrypted backup file. */
  static async restoreBackup(deps: ClientDeps, blob: BackupBlob, passphrase: string): Promise<SyncClient> {
    const state = await decryptBackup<SyncState>(blob, passphrase);
    if (state.v !== 1) throw new Error('unsupported backup contents');
    const restored: SyncState = {
      ...state, outbox: [], lastSeq: 0, head: 0, chains: {}, ledger: {}, ledgerConflicts: [], heldSeqs: [],
      prefs: {}, prefsState: { register: {}, conflicts: [] }, directory: {},
    };
    SyncClient.upgradeState(restored);
    const client = new SyncClient(restored, SyncClient.fill(deps));
    await client.save();
    return client;
  }
}

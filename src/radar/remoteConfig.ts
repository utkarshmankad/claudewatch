import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { PROVIDERS, type Provider } from './contribution.js';

// Signed, versioned remote parser configuration (prompt 4.3). It can only carry narrow selectors, field mappings and
// kill switches. The schema is a closed allowlist: it has no place for host permissions, code, or new collected fields,
// and unknown keys are rejected. See docs/radar/UI_AND_REMOTE_CONFIG.md.

export const CONFIG_SCHEMA_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 16_384;
export const MAX_ENTRIES = 50;
export const MAX_LIFETIME_MS = 14 * 86_400_000;
export const AUDIT_LIMIT = 200;

export const TARGETS = ['usage_percent', 'usage_used', 'usage_limit', 'reset_time', 'plan_label'] as const;
export const KILL_SCOPES = ['radar_contribution', 'remote_config', 'parser'] as const;
export type Target = (typeof TARGETS)[number];

/** CSS selector over a closed character set: no `url(`, no quotes-with-script, no pseudo-functions, bounded length. */
const CSS_SELECTOR = /^[A-Za-z0-9_\-.#>\s[\]="*^$~|]{1,160}$/;
/** Dotted JSON path into a provider response, e.g. `limits.5h.remaining` or `windows[0].resets_at`. */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+|\[\d{1,3}\]){0,8}$/;

export type ConfigEntry =
  | { kind: 'selector'; provider: Provider; target: Target; css: string }
  | { kind: 'field_mapping'; provider: Provider; target: Target; path: string }
  | { kind: 'kill_switch'; scope: (typeof KILL_SCOPES)[number]; provider?: Provider };

export interface RemoteConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  /** Strictly increasing per signing key line; used for anti-rollback. */
  version: number;
  issuedAt: number;
  expiresAt: number;
  /** Staged rollout: percentage of installs (0..100) that apply this version. */
  rolloutPercent: number;
  entries: ConfigEntry[];
}

export interface SignedConfig { payload: string; signature: string; keyId: string }
export interface TrustedKey { keyId: string; publicKeyPem: string }

export type ValidateResult = { ok: true; value: RemoteConfig } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (o: Record<string, unknown>, keys: readonly string[], where: string, errors: string[]) => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${where}: unexpected field ${k}`);
};
const isProvider = (v: unknown): v is Provider => (PROVIDERS as readonly unknown[]).includes(v);
const isTarget = (v: unknown): v is Target => (TARGETS as readonly unknown[]).includes(v);

function validateEntry(e: unknown, i: number, errors: string[]): ConfigEntry | null {
  const w = `entries[${i}]`;
  if (!isObj(e)) { errors.push(`${w}: must be an object`); return null; }
  const n = errors.length;
  if (e['kind'] === 'selector') {
    exact(e, ['kind', 'provider', 'target', 'css'], w, errors);
    if (!isProvider(e['provider'])) errors.push(`${w}: unknown provider`);
    if (!isTarget(e['target'])) errors.push(`${w}: unknown target`);
    if (typeof e['css'] !== 'string' || !CSS_SELECTOR.test(e['css'])) errors.push(`${w}: css selector not allowed`);
  } else if (e['kind'] === 'field_mapping') {
    exact(e, ['kind', 'provider', 'target', 'path'], w, errors);
    if (!isProvider(e['provider'])) errors.push(`${w}: unknown provider`);
    if (!isTarget(e['target'])) errors.push(`${w}: unknown target`);
    if (typeof e['path'] !== 'string' || !FIELD_PATH.test(e['path'])) errors.push(`${w}: field path not allowed`);
  } else if (e['kind'] === 'kill_switch') {
    exact(e, ['kind', 'scope', 'provider'], w, errors);
    if (!(KILL_SCOPES as readonly unknown[]).includes(e['scope'])) errors.push(`${w}: unknown kill-switch scope`);
    if (e['provider'] !== undefined && !isProvider(e['provider'])) errors.push(`${w}: unknown provider`);
  } else errors.push(`${w}: unknown entry kind`);
  return errors.length === n ? (e as unknown as ConfigEntry) : null;
}

export function validateConfig(input: unknown): ValidateResult {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['config must be an object'] };
  exact(input, ['schemaVersion', 'version', 'issuedAt', 'expiresAt', 'rolloutPercent', 'entries'], 'config', errors);
  if (input['schemaVersion'] !== CONFIG_SCHEMA_VERSION) errors.push('unsupported schemaVersion');
  const int = (k: string) => Number.isSafeInteger(input[k]) && (input[k] as number) >= 0;
  if (!int('version') || (input['version'] as number) < 1) errors.push('version must be a positive integer');
  if (!int('issuedAt')) errors.push('issuedAt must be epoch milliseconds');
  if (!int('expiresAt')) errors.push('expiresAt must be epoch milliseconds');
  if (int('issuedAt') && int('expiresAt')) {
    const span = (input['expiresAt'] as number) - (input['issuedAt'] as number);
    if (span <= 0) errors.push('expiresAt must be after issuedAt');
    else if (span > MAX_LIFETIME_MS) errors.push('lifetime exceeds 14 days');
  }
  const rp = input['rolloutPercent'];
  if (typeof rp !== 'number' || !Number.isInteger(rp) || rp < 0 || rp > 100) errors.push('rolloutPercent must be an integer 0..100');
  const entries: ConfigEntry[] = [];
  if (!Array.isArray(input['entries'])) errors.push('entries must be an array');
  else if (input['entries'].length > MAX_ENTRIES) errors.push(`at most ${MAX_ENTRIES} entries`);
  else input['entries'].forEach((e, i) => { const v = validateEntry(e, i, errors); if (v) entries.push(v); });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { ...(input as unknown as RemoteConfig), entries } };
}

/** Deterministic key order so a signer and verifier agree on bytes. The signature covers the exact payload string. */
export function canonicalize(config: RemoteConfig): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
    : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
  return JSON.stringify(sorted(config));
}

export function verifySignature(signed: SignedConfig, keys: readonly TrustedKey[], revoked: ReadonlySet<string> = new Set()): boolean {
  if (revoked.has(signed.keyId)) return false;
  const k = keys.find(t => t.keyId === signed.keyId);
  if (!k) return false;
  try {
    const pub: KeyObject = createPublicKey(k.publicKeyPem);
    return verify(null, Buffer.from(signed.payload, 'utf8'), pub, Buffer.from(signed.signature, 'base64'));
  } catch { return false; }
}

/** 0..99 bucket, stable per (install, version): a version rolls out to the same installs as its percentage grows. */
export function rolloutBucket(installId: string): number {
  return createHash('sha256').update(installId).digest().readUInt16BE(0) % 100;
}

export type AuditAction = 'applied' | 'rejected' | 'staged_skip' | 'rolled_back' | 'expired';
export interface AuditEntry { at: number; action: AuditAction; version: number | null; reason: string }

export interface ConfigState {
  active: RemoteConfig | null;
  /** Last known-good configs, newest last, for instant rollback. */
  previous: RemoteConfig[];
  highestSeenVersion: number;
  /** Versions that were rolled back and must not be applied again. */
  deniedVersions: number[];
  audit: AuditEntry[];
}

export const emptyState = (): ConfigState => ({ active: null, previous: [], highestSeenVersion: 0, deniedVersions: [], audit: [] });

export interface ConfigStore { load(): ConfigState; save(state: ConfigState): void }

export class MemoryConfigStore implements ConfigStore {
  private state: ConfigState = emptyState();
  load() { return structuredClone(this.state); }
  save(s: ConfigState) { this.state = structuredClone(s); }
}

export type ApplyResult = { ok: true; status: 'applied' | 'staged_skip'; version: number } | { ok: false; reason: string };

export interface ManagerOptions {
  keys: readonly TrustedKey[];
  revokedKeyIds?: ReadonlySet<string>;
  /** Random per-install value that never leaves the device; used only for the rollout bucket. */
  installId: string;
  store: ConfigStore;
  now?: () => number;
}

export class RemoteConfigManager {
  private readonly o: ManagerOptions;
  constructor(o: ManagerOptions) { this.o = o; }
  private now() { return (this.o.now ?? Date.now)(); }

  private audit(s: ConfigState, action: AuditAction, version: number | null, reason: string) {
    s.audit.push({ at: this.now(), action, version, reason });
    if (s.audit.length > AUDIT_LIMIT) s.audit.splice(0, s.audit.length - AUDIT_LIMIT);
  }

  /** Verify, validate and (if this install is in the rollout) activate a signed config. Never throws on bad input. */
  apply(signed: SignedConfig): ApplyResult {
    const s = this.o.store.load();
    const reject = (reason: string, version: number | null = null): ApplyResult => { this.audit(s, 'rejected', version, reason); this.o.store.save(s); return { ok: false, reason }; };
    if (typeof signed?.payload !== 'string' || typeof signed.signature !== 'string' || typeof signed.keyId !== 'string') return reject('malformed_envelope');
    if (Buffer.byteLength(signed.payload, 'utf8') > MAX_PAYLOAD_BYTES) return reject('payload_too_large');
    if (!verifySignature(signed, this.o.keys, this.o.revokedKeyIds)) return reject('bad_signature');
    let parsed: unknown;
    try { parsed = JSON.parse(signed.payload); } catch { return reject('invalid_json'); }
    const v = validateConfig(parsed);
    if (!v.ok) return reject(`schema: ${v.errors[0]}`);
    const c = v.value;
    if (signed.payload !== canonicalize(c)) return reject('not_canonical', c.version);
    if (c.expiresAt <= this.now()) return reject('expired', c.version);
    if (c.issuedAt > this.now() + 5 * 60_000) return reject('issued_in_future', c.version);
    if (s.deniedVersions.includes(c.version)) return reject('version_rolled_back', c.version);
    if (c.version <= s.highestSeenVersion) return reject('version_not_newer', c.version);
    s.highestSeenVersion = c.version;
    if (rolloutBucket(this.o.installId) >= c.rolloutPercent) {
      this.audit(s, 'staged_skip', c.version, `outside ${c.rolloutPercent}% rollout`);
      this.o.store.save(s);
      return { ok: true, status: 'staged_skip', version: c.version };
    }
    if (s.active) { s.previous.push(s.active); if (s.previous.length > 3) s.previous.shift(); }
    s.active = c;
    this.audit(s, 'applied', c.version, `${c.entries.length} entries`);
    this.o.store.save(s);
    return { ok: true, status: 'applied', version: c.version };
  }

  /** Instant, offline rollback: drops the active config for the previous good one (or the bundled defaults). */
  rollback(reason = 'manual'): { version: number | null } {
    const s = this.o.store.load();
    if (s.active) {
      if (!s.deniedVersions.includes(s.active.version)) s.deniedVersions.push(s.active.version);
      this.audit(s, 'rolled_back', s.active.version, reason);
      s.active = s.previous.pop() ?? null;
    } else this.audit(s, 'rolled_back', null, `${reason} (nothing active)`);
    this.o.store.save(s);
    return { version: s.active?.version ?? null };
  }

  /** The config in force, or null for bundled defaults. An expired config is dropped and audited once. */
  active(): RemoteConfig | null {
    const s = this.o.store.load();
    if (s.active && s.active.expiresAt <= this.now()) {
      this.audit(s, 'expired', s.active.version, 'expired');
      s.active = null;
      this.o.store.save(s);
    }
    return s.active;
  }

  entries(): ConfigEntry[] { return this.active()?.entries ?? []; }

  isKilled(scope: (typeof KILL_SCOPES)[number], provider?: Provider): boolean {
    return this.entries().some(e => e.kind === 'kill_switch' && e.scope === scope && (e.provider === undefined || e.provider === provider));
  }

  history(): AuditEntry[] { return this.o.store.load().audit; }
}

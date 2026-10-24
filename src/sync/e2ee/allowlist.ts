// Allow-list validator run before encryption and after decryption. Anything not named here is rejected,
// which is how prompts, cookies, tokens, full URLs and raw account identifiers stay on the device.
import { CONFIDENCES, CORRECTION_REASONS, LEDGER_KINDS, MEASUREMENT_METHODS, PROVIDERS, SOURCES, WINDOW_TYPES } from '../../ledger/types.js';

export class AllowListError extends Error {}

const LEDGER_KEYS = [
  'kind', 'provider', 'accountAlias', 'devicePseudonym', 'observedAt', 'source', 'confidence', 'measurementMethod',
  'measures', 'window', 'supersedes', 'correctionReason', 'reconciliation', 'id',
] as const;
const MEASURE_KEYS = ['quotaPercentUsed', 'estimatedTokens', 'requestCount', 'costMicroUsd'] as const;
const PREF_KEYS = ['alertFrequency', 'providerMute', 'quietHours', 'experimentOptIn', 'planLabel'] as const;
const ALERT_FREQUENCIES = ['off', 'low', 'normal', 'high'] as const;

// Free text is limited to short labels; these patterns catch the prohibited kinds if a label is abused.
const FORBIDDEN_TEXT = [
  /:\/\//, // full or partial URLs
  /@/, // emails and handles
  /sk-ant-|sk-[a-z0-9]{16,}|bearer\s|sessionkey|cookie|set-cookie|authorization/i, // credentials
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/, // IPv4 addresses
  /[\r\n\t]/,
];

function fail(path: string, why: string): never {
  throw new AllowListError(`${path}: ${why}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(path, `unknown key "${key}"`);
}

export function checkLabel(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
  if (value.length > max) fail(path, `longer than ${max} characters`);
  for (const pattern of FORBIDDEN_TEXT) if (pattern.test(value)) fail(path, 'contains prohibited content');
  return value;
}

function checkEnum<T extends string>(value: unknown, list: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) fail(path, 'not an allowed value');
  return value as T;
}

function checkNumber(value: unknown, path: string, min: number, max: number, integer: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, 'out of range');
  if (integer && !Number.isInteger(value)) fail(path, 'must be an integer');
  return value;
}

function checkHex(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/.test(value) || value.length < min || value.length > max) fail(path, 'must be hex');
  return value;
}

export interface SyncLedgerRecord {
  kind: string;
  provider: string;
  accountAlias: string;
  devicePseudonym: string;
  observedAt: number;
  source: string;
  confidence: string;
  measurementMethod: string;
  measures: Record<string, number>;
  window?: { type: string; resetAt?: number };
  supersedes?: string;
  correctionReason?: string;
  reconciliation?: { attributedUnits: number; eligibleUnits: number };
  id: string;
}

const MAX_MS = 8.64e15;

export function validateLedgerRecord(input: unknown, path = 'record'): SyncLedgerRecord {
  if (!isObject(input)) return fail(path, 'must be an object');
  exactKeys(input, LEDGER_KEYS, path);
  const r = input;
  const measures = r['measures'];
  if (!isObject(measures)) return fail(`${path}.measures`, 'must be an object');
  exactKeys(measures, MEASURE_KEYS, `${path}.measures`);
  for (const [k, v] of Object.entries(measures)) checkNumber(v, `${path}.measures.${k}`, 0, Number.MAX_SAFE_INTEGER, false);
  const out: SyncLedgerRecord = {
    kind: checkEnum(r['kind'], LEDGER_KINDS, `${path}.kind`),
    provider: checkEnum(r['provider'], PROVIDERS, `${path}.provider`),
    accountAlias: checkLabel(r['accountAlias'], `${path}.accountAlias`, 64),
    devicePseudonym: checkHex(r['devicePseudonym'], `${path}.devicePseudonym`, 8, 64),
    observedAt: checkNumber(r['observedAt'], `${path}.observedAt`, 0, MAX_MS, true),
    source: checkEnum(r['source'], SOURCES, `${path}.source`),
    confidence: checkEnum(r['confidence'], CONFIDENCES, `${path}.confidence`),
    measurementMethod: checkEnum(r['measurementMethod'], MEASUREMENT_METHODS, `${path}.measurementMethod`),
    measures: { ...(measures as Record<string, number>) },
    id: checkHex(r['id'], `${path}.id`, 16, 128),
  };
  if (r['window'] !== undefined) {
    const w = r['window'];
    if (!isObject(w)) return fail(`${path}.window`, 'must be an object');
    exactKeys(w, ['type', 'resetAt'], `${path}.window`);
    out.window = { type: checkEnum(w['type'], WINDOW_TYPES, `${path}.window.type`) };
    if (w['resetAt'] !== undefined) out.window.resetAt = checkNumber(w['resetAt'], `${path}.window.resetAt`, 0, MAX_MS, true);
  }
  if (r['supersedes'] !== undefined) out.supersedes = checkHex(r['supersedes'], `${path}.supersedes`, 16, 128);
  if (r['correctionReason'] !== undefined) out.correctionReason = checkEnum(r['correctionReason'], CORRECTION_REASONS, `${path}.correctionReason`);
  if (r['reconciliation'] !== undefined) {
    const rec = r['reconciliation'];
    if (!isObject(rec)) return fail(`${path}.reconciliation`, 'must be an object');
    exactKeys(rec, ['attributedUnits', 'eligibleUnits'], `${path}.reconciliation`);
    out.reconciliation = {
      attributedUnits: checkNumber(rec['attributedUnits'], `${path}.reconciliation.attributedUnits`, 0, Number.MAX_SAFE_INTEGER, false),
      eligibleUnits: checkNumber(rec['eligibleUnits'], `${path}.reconciliation.eligibleUnits`, 0, Number.MAX_SAFE_INTEGER, false),
    };
  }
  return out;
}

/** Pick the synced fields from a full ledger record (drops ingestedAt, effectiveObservedAt, flags, schemaVersion). */
export function toSyncRecord(record: Record<string, unknown>): SyncLedgerRecord {
  const picked: Record<string, unknown> = {};
  for (const key of LEDGER_KEYS) if (record[key] !== undefined) picked[key] = record[key];
  return validateLedgerRecord(picked);
}

export interface SyncPrefs {
  alertFrequency?: string;
  providerMute?: Record<string, boolean>;
  quietHours?: { startMinute: number; endMinute: number };
  experimentOptIn?: boolean;
  planLabel?: string;
}

export function validatePrefs(input: unknown, path = 'prefs'): SyncPrefs {
  if (!isObject(input)) return fail(path, 'must be an object');
  exactKeys(input, PREF_KEYS, path);
  const out: SyncPrefs = {};
  if (input['alertFrequency'] !== undefined) out.alertFrequency = checkEnum(input['alertFrequency'], ALERT_FREQUENCIES, `${path}.alertFrequency`);
  if (input['providerMute'] !== undefined) {
    const mute = input['providerMute'];
    if (!isObject(mute)) return fail(`${path}.providerMute`, 'must be an object');
    exactKeys(mute, PROVIDERS, `${path}.providerMute`);
    out.providerMute = {};
    for (const [k, v] of Object.entries(mute)) {
      if (typeof v !== 'boolean') return fail(`${path}.providerMute.${k}`, 'must be boolean');
      out.providerMute[k] = v;
    }
  }
  if (input['quietHours'] !== undefined) {
    const q = input['quietHours'];
    if (!isObject(q)) return fail(`${path}.quietHours`, 'must be an object');
    exactKeys(q, ['startMinute', 'endMinute'], `${path}.quietHours`);
    out.quietHours = {
      startMinute: checkNumber(q['startMinute'], `${path}.quietHours.startMinute`, 0, 1439, true),
      endMinute: checkNumber(q['endMinute'], `${path}.quietHours.endMinute`, 0, 1439, true),
    };
  }
  if (input['experimentOptIn'] !== undefined) {
    if (typeof input['experimentOptIn'] !== 'boolean') return fail(`${path}.experimentOptIn`, 'must be boolean');
    out.experimentOptIn = input['experimentOptIn'];
  }
  if (input['planLabel'] !== undefined) out.planLabel = checkLabel(input['planLabel'], `${path}.planLabel`, 40);
  return out;
}

export interface DeviceEntry {
  devicePseudonym: string;
  name: string;
  createdDay: number; // epoch ms rounded down to a UTC day
  lastSeenDay: number;
  /** The device's own key-agreement public key, published inside the encrypted envelope so peers can pin it (the service cannot forge it). */
  encPublic?: string;
  /** Key-agreement public keys of devices this device revoked. Peers stop trusting them even if the service says otherwise. */
  revokedKeys?: string[];
}

export function validateDeviceEntry(input: unknown, path = 'device'): DeviceEntry {
  if (!isObject(input)) return fail(path, 'must be an object');
  exactKeys(input, ['devicePseudonym', 'name', 'createdDay', 'lastSeenDay', 'encPublic', 'revokedKeys'], path);
  const encPublic = input['encPublic'];
  if (encPublic !== undefined && (typeof encPublic !== 'string' || !/^[A-Za-z0-9+/]{80,100}={0,2}$/.test(encPublic))) return fail(`${path}.encPublic`, 'must be a base64 P-256 point');
  const revoked = input['revokedKeys'];
  const point = /^[A-Za-z0-9+/]{80,100}={0,2}$/;
  if (revoked !== undefined && (!Array.isArray(revoked) || revoked.length > 50 || revoked.some((k) => typeof k !== 'string' || !point.test(k)))) return fail(`${path}.revokedKeys`, 'must be up to 50 base64 P-256 points');
  return {
    ...(encPublic === undefined ? {} : { encPublic }),
    ...(revoked === undefined ? {} : { revokedKeys: [...(revoked as string[])] }),
    devicePseudonym: checkHex(input['devicePseudonym'], `${path}.devicePseudonym`, 8, 64),
    name: checkLabel(input['name'], `${path}.name`, 40),
    createdDay: checkNumber(input['createdDay'], `${path}.createdDay`, 0, MAX_MS, true),
    lastSeenDay: checkNumber(input['lastSeenDay'], `${path}.lastSeenDay`, 0, MAX_MS, true),
  };
}

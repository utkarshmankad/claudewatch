// sync-envelope.v1: the only thing that is ever encrypted and uploaded.
import { AllowListError, validateDeviceEntry, validateLedgerRecord, validatePrefs } from './allowlist.js';
import type { DeviceEntry, SyncLedgerRecord, SyncPrefs } from './allowlist.js';

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_KINDS = ['ledger_batch', 'prefs', 'devices'] as const;
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

export type EnvelopeItems =
  | { kind: 'ledger_batch'; items: SyncLedgerRecord[] }
  | { kind: 'prefs'; items: SyncPrefs[] }
  | { kind: 'devices'; items: DeviceEntry[] };

export type Envelope = {
  v: typeof ENVELOPE_VERSION;
  epoch: number;
  sender: string; // opaque device id, so receivers can check each device's chain
  deviceSeq: number; // per-device counter inside the ciphertext; the server sequence still orders delivery
  prev_hash: string; // sha256 of this device's previous uploaded ciphertext, '' for the first
} & EnvelopeItems;

export const MAX_ITEMS_PER_ENVELOPE = 500;

export function validateEnvelope(input: unknown): Envelope {
  if (typeof input !== 'object' || input === null) throw new AllowListError('envelope: must be an object');
  const e = input as Record<string, unknown>;
  const allowed = ['v', 'epoch', 'sender', 'deviceSeq', 'prev_hash', 'kind', 'items'];
  for (const key of Object.keys(e)) if (!allowed.includes(key)) throw new AllowListError(`envelope: unknown key "${key}"`);
  if (e['v'] !== ENVELOPE_VERSION) throw new AllowListError('envelope: unsupported version');
  if (!Number.isInteger(e['epoch']) || (e['epoch'] as number) < 1) throw new AllowListError('envelope.epoch invalid');
  if (typeof e['sender'] !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(e['sender'])) throw new AllowListError('envelope.sender invalid');
  if (!Number.isInteger(e['deviceSeq']) || (e['deviceSeq'] as number) < 1) throw new AllowListError('envelope.deviceSeq invalid');
  if (typeof e['prev_hash'] !== 'string' || !/^[0-9a-f]{0,64}$/.test(e['prev_hash'])) throw new AllowListError('envelope.prev_hash invalid');
  const items = e['items'];
  if (!Array.isArray(items) || items.length > MAX_ITEMS_PER_ENVELOPE) throw new AllowListError('envelope.items invalid');
  const base = { v: ENVELOPE_VERSION, epoch: e['epoch'] as number, sender: e['sender'], deviceSeq: e['deviceSeq'] as number, prev_hash: e['prev_hash'] } as const;
  switch (e['kind']) {
    case 'ledger_batch':
      return { ...base, kind: 'ledger_batch', items: items.map((item, i) => validateLedgerRecord(item, `items[${i}]`)) };
    case 'prefs':
      return { ...base, kind: 'prefs', items: items.map((item, i) => validatePrefs(item, `items[${i}]`)) };
    case 'devices':
      return { ...base, kind: 'devices', items: items.map((item, i) => validateDeviceEntry(item, `items[${i}]`)) };
    default:
      throw new AllowListError('envelope.kind invalid');
  }
}

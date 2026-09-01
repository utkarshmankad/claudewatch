import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { insertUsageEvent, type UsageEventData } from '../store/db.js';

export interface EncryptedEnvelope { version: 1; iv: string; tag: string; ciphertext: string }

function resolveKey(base64Key: string): Buffer {
  const raw = Buffer.from(base64Key, 'base64');
  return raw.length === 32 ? raw : createHash('sha256').update(raw).digest();
}

export function encryptSyncPayload(payload: unknown, base64Key: string): EncryptedEnvelope {
  const key = resolveKey(base64Key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function decryptSyncPayload<T>(envelope: EncryptedEnvelope, base64Key: string): T {
  if (envelope.version !== 1) throw new Error('unsupported sync envelope version');
  const decipher = createDecipheriv('aes-256-gcm', resolveKey(base64Key), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

export async function syncUsageEvent(event: UsageEventData): Promise<boolean> {
  const endpoint = process.env['CLAUDEWATCH_SYNC_URL']?.trim();
  const token = process.env['CLAUDEWATCH_SYNC_TOKEN']?.trim();
  const key = process.env['CLAUDEWATCH_SYNC_KEY']?.trim();
  if (!endpoint || !token || !key) return false;
  const minimal = { ...event, metadata: undefined };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(encryptSyncPayload(minimal, key)),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`cloud sync failed with HTTP ${response.status}`);
  return true;
}

export async function pullCloudEvents(): Promise<number> {
  const endpoint = process.env['CLAUDEWATCH_SYNC_URL']?.trim();
  const token = process.env['CLAUDEWATCH_SYNC_TOKEN']?.trim();
  const key = process.env['CLAUDEWATCH_SYNC_KEY']?.trim();
  if (!endpoint || !token || !key) return 0;
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`cloud pull failed with HTTP ${response.status}`);
  const body = await response.json() as { events?: EncryptedEnvelope[] };
  let inserted = 0;
  for (const envelope of (body.events ?? []).slice(0, 10_000)) {
    try {
      const event = decryptSyncPayload<UsageEventData>(envelope, key);
      if (event?.eventId && event.provider && event.deviceId && event.client && event.source && event.confidence) {
        if (insertUsageEvent(event)) inserted++;
      }
    } catch { /* Ignore corrupt or foreign-key envelopes without exposing payloads. */ }
  }
  return inserted;
}

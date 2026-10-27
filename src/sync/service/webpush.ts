// Web Push sender (security review R4): RFC 8291 message encryption (aes128gcm) and RFC 8292 VAPID (ES256).
// The VAPID private key is supplied by the owner at run time (see vapidFromEnv) and is never stored in the repository.
// Built on WebCrypto only; no dependencies.
import { webcrypto } from 'node:crypto';
import { hostAllowed, DEFAULT_PUSH_HOSTS } from './push.js';
import type { PushMessage, PushSender } from './push.js';

const subtle = webcrypto.subtle;
const enc = new TextEncoder();

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
export const fromB64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'));
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: info }, key, bytes * 8));
}

export interface EncryptOptions { ephemeral?: webcrypto.CryptoKeyPair; salt?: Uint8Array }

/** RFC 8291 section 3-4: one aes128gcm record. `p256dh` and `auth` are the subscriber's base64url values. */
export async function encryptPayload(payload: Uint8Array, p256dh: string, auth: string, options: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad_p256dh');
  if (authSecret.length !== 16) throw new Error('bad_auth');
  if (payload.length > 4096 - 86 - 16 - 1) throw new Error('payload_too_large');
  const eph = options.ephemeral ?? await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const uaKey = await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = options.salt ?? webcrypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, cat(payload, Uint8Array.of(2))));
  const header = cat(salt, Uint8Array.of(0, 0, 0x10, 0), Uint8Array.of(asPublic.length), asPublic);
  return cat(header, body);
}

export interface VapidKeys { privateJwk: webcrypto.JsonWebKey; publicKey: string; subject: string }

/** One-time helper for the owner: prints a key pair to store as a secret. The private half must not be committed. */
export async function generateVapidKeys(subject: string): Promise<VapidKeys> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const privateJwk = await subtle.exportKey('jwk', pair.privateKey);
  return { privateJwk, publicKey: b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))), subject };
}

/** Reads VAPID_PRIVATE_JWK (JSON) and VAPID_SUBJECT (mailto: or https:) from the environment; null when not configured. */
export function vapidFromEnv(env: Record<string, string | undefined> = process.env): VapidKeys | null {
  const raw = env['VAPID_PRIVATE_JWK']; const subject = env['VAPID_SUBJECT'];
  if (!raw || !subject) return null;
  const jwk = JSON.parse(raw) as webcrypto.JsonWebKey;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new Error('bad_vapid_key');
  if (!/^(mailto:|https:\/\/)/.test(subject)) throw new Error('bad_vapid_subject');
  const publicKey = b64u(Uint8Array.of(4, ...fromB64u(jwk.x), ...fromB64u(jwk.y)));
  return { privateJwk: jwk, publicKey, subject };
}

/** RFC 8292: ES256 JWT for the push service origin, valid for at most 12 hours. */
export async function vapidAuthorization(keys: VapidKeys, endpoint: string, nowMs: number): Promise<string> {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: keys.subject })));
  const key = await subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

export interface WebPushOptions { keys: VapidKeys; hosts?: readonly string[]; timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => number }

/**
 * Builds the PushSender the service expects. The host is checked again at send time (the stored endpoint may predate a
 * change to the allow-list), redirects are refused, and the request has a timeout.
 */
export function createWebPushSender(options: WebPushOptions): PushSender {
  const hosts = options.hosts ?? DEFAULT_PUSH_HOSTS;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  return async (message: PushMessage) => {
    const url = new URL(message.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || !hostAllowed(url.hostname, hosts)) throw new Error('push_host_not_allowed');
    const body = await encryptPayload(enc.encode(message.payload), message.p256dh, message.auth);
    const res = await doFetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: {
        Authorization: await vapidAuthorization(options.keys, message.endpoint, now()),
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        TTL: String(message.ttlSeconds), Urgency: message.urgency,
      },
      body,
    });
    return { status: res.status };
  };
}

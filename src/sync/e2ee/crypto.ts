// Client-side cryptography for end-to-end encrypted sync (docs/sync/ARCHITECTURE.md).
// WebCrypto only, so the same code runs in Node, a service worker and a Worker.
import { webcrypto } from 'node:crypto';

type KeyUsage = webcrypto.KeyUsage;

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PAD_BLOCK = 1024;
export const PBKDF2_ITERATIONS = 600_000;
/** Seal operations allowed per key epoch before rotation is forced (well below AES-GCM random-nonce limits). */
export const MAX_SEALS_PER_EPOCH = 2 ** 24;

export type Purpose = 'payload' | 'metadata-mac' | 'device-list';

export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromB64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function randomBytes(length: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(length));
}

export function randomId(bytes = 16): string {
  return Buffer.from(randomBytes(bytes)).toString('base64url');
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return Buffer.from(await subtle.digest('SHA-256', bytes)).toString('hex');
}

export function generateAccountKey(): Uint8Array {
  return randomBytes(32);
}

async function hkdf(secret: Uint8Array, info: string, usages: KeyUsage[]): Promise<webcrypto.CryptoKey> {
  const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

/** Per-purpose, per-epoch subkey. Different purposes or epochs never share a key. */
export function deriveSubkey(accountKey: Uint8Array, purpose: Purpose, epoch: number): Promise<webcrypto.CryptoKey> {
  return hkdf(accountKey, `claudewatch-sync/v1/${purpose}/${epoch}`, ['encrypt', 'decrypt']);
}

export interface ObjectBinding {
  accountId: string;
  objectId: string;
  epoch: number;
  schemaVersion: number;
}

function aad(b: ObjectBinding): Uint8Array {
  return enc.encode(`${b.accountId}|${b.objectId}|${b.epoch}|${b.schemaVersion}`);
}

/** Length-prefix and zero-pad to a multiple of PAD_BLOCK so size leaks only a coarse bucket. */
export function pad(plain: Uint8Array): Uint8Array {
  const total = Math.ceil((plain.length + 4) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, plain.length);
  out.set(plain, 4);
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) throw new Error('corrupt padding');
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  if (length > padded.length - 4) throw new Error('corrupt padding');
  return padded.slice(4, 4 + length);
}

export interface Sealed {
  nonce: string;
  ciphertext: string;
}

export async function seal(accountKey: Uint8Array, binding: ObjectBinding, value: unknown): Promise<Sealed> {
  const key = await deriveSubkey(accountKey, 'payload', binding.epoch);
  const nonce = randomBytes(12);
  const data = pad(enc.encode(JSON.stringify(value)));
  const out = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(binding) }, key, data);
  return { nonce: toB64(nonce), ciphertext: toB64(new Uint8Array(out)) };
}

export async function open<T>(accountKey: Uint8Array, binding: ObjectBinding, sealed: Sealed): Promise<T> {
  const key = await deriveSubkey(accountKey, 'payload', binding.epoch);
  const out = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(sealed.nonce), additionalData: aad(binding) },
    key,
    fromB64(sealed.ciphertext),
  );
  return JSON.parse(dec.decode(unpad(new Uint8Array(out)))) as T;
}

// ---- device keys: ECDSA P-256 for signing, ECDH P-256 for key wrapping ----

export interface DeviceKeys {
  signPublic: string; // base64 raw point
  encPublic: string;
  signPrivateJwk: webcrypto.JsonWebKey;
  encPrivateJwk: webcrypto.JsonWebKey;
}

export async function generateDeviceKeys(): Promise<DeviceKeys> {
  const sign = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const encKey = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return {
    signPublic: toB64(new Uint8Array(await subtle.exportKey('raw', sign.publicKey))),
    encPublic: toB64(new Uint8Array(await subtle.exportKey('raw', encKey.publicKey))),
    signPrivateJwk: await subtle.exportKey('jwk', sign.privateKey),
    encPrivateJwk: await subtle.exportKey('jwk', encKey.privateKey),
  };
}

export async function sign(privateJwk: webcrypto.JsonWebKey, message: string): Promise<string> {
  const key = await subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return toB64(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(message))));
}

export async function verify(publicRaw: string, message: string, signature: string): Promise<boolean> {
  try {
    const key = await subtle.importKey('raw', fromB64(publicRaw), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64(signature), enc.encode(message));
  } catch {
    return false;
  }
}

export interface WrappedKey {
  ephemeralPublic: string;
  nonce: string;
  ciphertext: string;
}

async function wrapKey(shared: Uint8Array, usages: KeyUsage[]): Promise<webcrypto.CryptoKey> {
  return hkdf(shared, 'claudewatch-sync/v1/key-wrap', usages);
}

/** Wrap an account key to a device's ECDH public key. The service only ever relays the result. */
export async function wrapAccountKey(accountKey: Uint8Array, recipientEncPublic: string, bindingInfo: string): Promise<WrappedKey> {
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const recipient = await subtle.importKey('raw', fromB64(recipientEncPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256));
  const key = await wrapKey(shared, ['encrypt']);
  const nonce = randomBytes(12);
  const out = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(bindingInfo) }, key, accountKey);
  return {
    ephemeralPublic: toB64(new Uint8Array(await subtle.exportKey('raw', eph.publicKey))),
    nonce: toB64(nonce),
    ciphertext: toB64(new Uint8Array(out)),
  };
}

export async function unwrapAccountKey(wrapped: WrappedKey, encPrivateJwk: webcrypto.JsonWebKey, bindingInfo: string): Promise<Uint8Array> {
  const priv = await subtle.importKey('jwk', encPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await subtle.importKey('raw', fromB64(wrapped.ephemeralPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
  const key = await wrapKey(shared, ['decrypt']);
  const out = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(wrapped.nonce), additionalData: enc.encode(bindingInfo) },
    key,
    fromB64(wrapped.ciphertext),
  );
  return new Uint8Array(out);
}

/** Short authentication string both devices display; a mismatch means someone sits in the middle. */
export async function shortAuthString(pubA: string, pubB: string): Promise<string> {
  const [first, second] = [pubA, pubB].sort();
  const digest = Buffer.from(await subtle.digest('SHA-256', enc.encode(`sas|${first}|${second}`)));
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

// ---- encrypted backup file (the owner-required recovery path; no recovery phrase) ----

export interface BackupBlob {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
}

async function passphraseKey(passphrase: string, salt: Uint8Array, iterations: number, usages: KeyUsage[]) {
  const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, usages);
}

export async function encryptBackup(value: unknown, passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<BackupBlob> {
  if (passphrase.length < 12) throw new Error('backup passphrase must be at least 12 characters');
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await passphraseKey(passphrase, salt, iterations, ['encrypt']);
  const out = await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, enc.encode(JSON.stringify(value)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: toB64(salt), nonce: toB64(nonce), ciphertext: toB64(new Uint8Array(out)) };
}

export async function decryptBackup<T>(blob: BackupBlob, passphrase: string): Promise<T> {
  if (blob.v !== 1 || blob.kdf !== 'PBKDF2-SHA256') throw new Error('unsupported backup format');
  if (!Number.isInteger(blob.iterations) || blob.iterations < 100_000) throw new Error('backup iteration count too low');
  const key = await passphraseKey(passphrase, fromB64(blob.salt), blob.iterations, ['decrypt']);
  const out = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.nonce) }, key, fromB64(blob.ciphertext));
  return JSON.parse(dec.decode(out)) as T;
}

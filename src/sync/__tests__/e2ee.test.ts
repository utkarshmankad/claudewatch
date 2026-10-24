import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptBackup, deriveSubkey, encryptBackup, generateAccountKey, generateDeviceKeys, open, pad, randomId, seal, shortAuthString, sign,
  unpad, unwrapAccountKey, verify, wrapAccountKey,
} from '../e2ee/crypto.js';
import { AllowListError, toSyncRecord, validateDeviceEntry, validateLedgerRecord, validatePrefs } from '../e2ee/allowlist.js';
import { validateEnvelope } from '../e2ee/envelope.js';

const binding = { accountId: 'acc', objectId: 'obj', epoch: 1, schemaVersion: 1 };

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'provider_snapshot', provider: 'claude', accountAlias: 'work', devicePseudonym: 'a1b2c3d4e5f60718', observedAt: 1_700_000_000_000,
    source: 'web', confidence: 'high', measurementMethod: 'provider_reported', measures: { quotaPercentUsed: 41 },
    window: { type: 'five_hour', resetAt: 1_700_000_900_000 }, id: 'abcdef0123456789abcdef', ...overrides,
  };
}

// Seeded PRNG so fuzz failures are reproducible (same approach as src/ledger/__tests__).
function prng(seed: number): () => number {
  let x = seed;
  return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; };
}

describe('sync cryptography', () => {
  it('round-trips and pads to 1 KiB buckets', async () => {
    const ak = generateAccountKey();
    const sealed = await seal(ak, binding, { hello: 'world' });
    expect(Buffer.from(sealed.ciphertext, 'base64').length).toBe(1024 + 16);
    expect(await open(ak, binding, sealed)).toEqual({ hello: 'world' });
    expect(unpad(pad(new Uint8Array([1, 2, 3])))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects a wrong key', async () => {
    const sealed = await seal(generateAccountKey(), binding, { a: 1 });
    await expect(open(generateAccountKey(), binding, sealed)).rejects.toThrow();
  });

  it.each([
    ['account', { accountId: 'other' }],
    ['object id', { objectId: 'other' }],
    ['epoch', { epoch: 2 }],
    ['schema version', { schemaVersion: 2 }],
  ])('rejects wrong AAD (%s)', async (_name, change) => {
    const ak = generateAccountKey();
    const sealed = await seal(ak, binding, { a: 1 });
    await expect(open(ak, { ...binding, ...change }, sealed)).rejects.toThrow();
  });

  it('rejects truncated and bit-flipped ciphertext', async () => {
    const ak = generateAccountKey();
    const sealed = await seal(ak, binding, { a: 1 });
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    await expect(open(ak, binding, { ...sealed, ciphertext: bytes.subarray(0, bytes.length - 3).toString('base64') })).rejects.toThrow();
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    await expect(open(ak, binding, { ...sealed, ciphertext: bytes.toString('base64') })).rejects.toThrow();
  });

  it('never reuses a nonce over many objects', async () => {
    const ak = generateAccountKey();
    const nonces = new Set<string>();
    for (let i = 0; i < 2000; i += 1) nonces.add((await seal(ak, { ...binding, objectId: String(i) }, { i })).nonce);
    expect(nonces.size).toBe(2000);
  });

  it('separates subkeys by purpose and epoch', async () => {
    const ak = generateAccountKey();
    const a = await seal(ak, binding, { x: 1 });
    // A payload sealed under epoch 1 cannot be opened as epoch 2 even with AAD forced to match.
    await expect(open(ak, { ...binding, epoch: 2 }, a)).rejects.toThrow();
    const iv = new Uint8Array(12);
    const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveSubkey(ak, 'payload', 1), new Uint8Array([1]));
    await expect(webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, await deriveSubkey(ak, 'device-list', 1), ct)).rejects.toThrow();
  });

  it('signs and verifies, and rejects a tampered message', async () => {
    const keys = await generateDeviceKeys();
    const sig = await sign(keys.signPrivateJwk, 'msg');
    expect(await verify(keys.signPublic, 'msg', sig)).toBe(true);
    expect(await verify(keys.signPublic, 'msg2', sig)).toBe(false);
    expect(await verify('not-a-key', 'msg', sig)).toBe(false);
  });

  it('wraps an account key to a device and fails for another device or binding', async () => {
    const [a, b] = [await generateDeviceKeys(), await generateDeviceKeys()];
    const ak = generateAccountKey();
    const wrapped = await wrapAccountKey(ak, a.encPublic, 'bind');
    expect(await unwrapAccountKey(wrapped, a.encPrivateJwk, 'bind')).toEqual(ak);
    await expect(unwrapAccountKey(wrapped, b.encPrivateJwk, 'bind')).rejects.toThrow();
    await expect(unwrapAccountKey(wrapped, a.encPrivateJwk, 'other')).rejects.toThrow();
  });

  it('derives the same SAS on both sides and a different one when a key is swapped', async () => {
    const [a, b, evil] = [await generateDeviceKeys(), await generateDeviceKeys(), await generateDeviceKeys()];
    expect(await shortAuthString(a.encPublic, b.encPublic)).toBe(await shortAuthString(b.encPublic, a.encPublic));
    expect(await shortAuthString(a.encPublic, b.encPublic)).not.toBe(await shortAuthString(a.encPublic, evil.encPublic));
  });

  it('encrypts a backup with a passphrase and refuses weak or wrong ones', async () => {
    const blob = await encryptBackup({ secret: 1 }, 'correct horse battery', 150_000);
    expect(await decryptBackup(blob, 'correct horse battery')).toEqual({ secret: 1 });
    await expect(decryptBackup(blob, 'wrong passphrase!!')).rejects.toThrow();
    await expect(encryptBackup({}, 'short')).rejects.toThrow();
    await expect(decryptBackup({ ...blob, iterations: 10 }, 'correct horse battery')).rejects.toThrow();
    expect(JSON.stringify(blob)).not.toContain('secret');
  });
});

describe('sync allow-list', () => {
  it('accepts a normal record and strips non-synced ledger fields', () => {
    const full = { ...record(), ingestedAt: 1, effectiveObservedAt: 1, flags: [], schemaVersion: 1 };
    expect(toSyncRecord(full)).toEqual(validateLedgerRecord(record()));
  });

  it.each([
    ['unknown key', { prompt: 'write my essay' }],
    ['url alias', { accountAlias: 'https://claude.ai/chat/abc' }],
    ['email alias', { accountAlias: 'me@example.com' }],
    ['cookie alias', { accountAlias: 'sessionKey=abc' }],
    ['api key alias', { accountAlias: 'sk-ant-api03-xxxx' }],
    ['ip alias', { accountAlias: 'host 10.0.0.1' }],
    ['oversized alias', { accountAlias: 'x'.repeat(65) }],
    ['bad provider', { provider: 'other' }],
    ['non-hex pseudonym', { devicePseudonym: 'laptop-01' }],
    ['negative measure', { measures: { requestCount: -1 } }],
    ['unknown measure', { measures: { prompt: 5 } }],
    ['nested unknown', { window: { type: 'five_hour', url: 'x' } }],
  ])('rejects %s', (_name, change) => {
    expect(() => validateLedgerRecord(record(change))).toThrow(AllowListError);
  });

  it('fuzz: random strings in free-text fields never smuggle prohibited content', () => {
    const rand = prng(42);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789:/@=. -\n';
    for (let i = 0; i < 2000; i += 1) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 30) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      let accepted = true;
      try { validateLedgerRecord(record({ accountAlias: text })); } catch { accepted = false; }
      if (accepted) expect(text).not.toMatch(/:\/\/|@|\n|sessionkey|cookie|bearer /i);
    }
  });

  it('validates preferences and device entries', () => {
    expect(validatePrefs({ alertFrequency: 'low', providerMute: { claude: true }, quietHours: { startMinute: 0, endMinute: 480 }, experimentOptIn: false, planLabel: 'Pro' }))
      .toMatchObject({ alertFrequency: 'low' });
    expect(() => validatePrefs({ alertFrequency: 'loud' })).toThrow(AllowListError);
    expect(() => validatePrefs({ theme: 'dark' })).toThrow(AllowListError);
    expect(() => validatePrefs({ providerMute: { openai: true } })).toThrow(AllowListError);
    expect(() => validatePrefs({ quietHours: { startMinute: 2000, endMinute: 0 } })).toThrow(AllowListError);
    expect(validateDeviceEntry({ devicePseudonym: 'abcdef0123456789', name: 'Work laptop', createdDay: 0, lastSeenDay: 0 }).name).toBe('Work laptop');
    expect(() => validateDeviceEntry({ devicePseudonym: 'abcdef0123456789', name: 'http://x', createdDay: 0, lastSeenDay: 0 })).toThrow(AllowListError);
  });

  it('validates envelopes and refuses newer schema versions', () => {
    const base = { v: 1, epoch: 1, sender: randomId(), deviceSeq: 1, prev_hash: '', kind: 'ledger_batch', items: [record()] };
    expect(validateEnvelope(base).kind).toBe('ledger_batch');
    expect(() => validateEnvelope({ ...base, v: 2 })).toThrow(AllowListError);
    expect(() => validateEnvelope({ ...base, extra: 1 })).toThrow(AllowListError);
    expect(() => validateEnvelope({ ...base, items: [record({ id: 'zz' })] })).toThrow(AllowListError);
    expect(() => validateEnvelope({ ...base, kind: 'cookies' })).toThrow(AllowListError);
  });
});

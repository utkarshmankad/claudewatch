import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { b64u, createWebPushSender, encryptPayload, fromB64u, generateVapidKeys, vapidAuthorization, vapidFromEnv } from '../service/webpush.js';

const subtle = webcrypto.subtle;

// RFC 8291 appendix A.
const A = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

async function ephemeral(): Promise<webcrypto.CryptoKeyPair> {
  const pub = fromB64u(A.asPublic);
  const jwk = { kty: 'EC', crv: 'P-256', d: A.asPrivate, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  return {
    privateKey: await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    publicKey: await subtle.importKey('raw', pub, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  };
}

describe('web push sender (R4)', () => {
  it('reproduces the RFC 8291 appendix A message exactly', async () => {
    const out = await encryptPayload(new TextEncoder().encode(A.plaintext), A.uaPublic, A.auth, { ephemeral: await ephemeral(), salt: fromB64u(A.salt) });
    expect(b64u(out)).toBe(A.body);
  });

  it('rejects malformed subscriber keys and oversized payloads', async () => {
    await expect(encryptPayload(new Uint8Array(3), 'AAAA', A.auth)).rejects.toThrow('bad_p256dh');
    await expect(encryptPayload(new Uint8Array(3), A.uaPublic, 'AAAA')).rejects.toThrow('bad_auth');
    await expect(encryptPayload(new Uint8Array(4000), A.uaPublic, A.auth)).rejects.toThrow('payload_too_large');
  });

  it('signs a verifiable ES256 VAPID token for the endpoint origin', async () => {
    const keys = await generateVapidKeys('mailto:owner@example.com');
    const header = await vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/abc', 1_000_000_000_000);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_000_000_000 + 43_200, sub: 'mailto:owner@example.com' });
    const pub = await subtle.importKey('raw', fromB64u(k!), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64u(s!), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
  });

  it('reads keys from the environment only when fully configured and well formed', async () => {
    const keys = await generateVapidKeys('mailto:owner@example.com');
    expect(vapidFromEnv({})).toBeNull();
    expect(vapidFromEnv({ VAPID_PRIVATE_JWK: JSON.stringify(keys.privateJwk), VAPID_SUBJECT: 'mailto:owner@example.com' })?.publicKey).toBe(keys.publicKey);
    expect(() => vapidFromEnv({ VAPID_PRIVATE_JWK: JSON.stringify({ kty: 'EC' }), VAPID_SUBJECT: 'mailto:a@b.c' })).toThrow('bad_vapid_key');
    expect(() => vapidFromEnv({ VAPID_PRIVATE_JWK: JSON.stringify(keys.privateJwk), VAPID_SUBJECT: 'http://x' })).toThrow('bad_vapid_subject');
  });

  it('posts an encrypted body without following redirects, and re-checks the host at send time', async () => {
    const keys = await generateVapidKeys('mailto:owner@example.com');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const send = createWebPushSender({ keys, fetchImpl: (async (u: URL, init: RequestInit) => { calls.push({ url: String(u), init }); return { status: 201 }; }) as unknown as typeof fetch });
    const msg = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: A.uaPublic, auth: A.auth, payload: '{"v":1,"k":"reset"}', ttlSeconds: 3600, urgency: 'low' as const };
    expect(await send(msg)).toEqual({ status: 201 });
    expect(calls[0]!.init.redirect).toBe('error');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h['Content-Encoding']).toBe('aes128gcm');
    expect(h['TTL']).toBe('3600');
    expect(h['Urgency']).toBe('low');
    expect(h['Authorization']).toMatch(/^vapid t=/);
    for (const endpoint of ['https://evil.example/x', 'http://fcm.googleapis.com/x', 'https://u:p@fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x']) {
      await expect(send({ ...msg, endpoint })).rejects.toThrow('push_host_not_allowed');
    }
    expect(calls).toHaveLength(1);
  });
});

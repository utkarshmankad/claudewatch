import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_PAYLOAD_BYTES, MemoryConfigStore, RemoteConfigManager, canonicalize, rolloutBucket, validateConfig,
  type RemoteConfig, type SignedConfig,
} from '../remoteConfig.js';

const NOW = Date.UTC(2026, 9, 24, 12);
const DAY = 86_400_000;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
const KEYS = [{ keyId: 'k1', publicKeyPem: pem }];

const cfg = (over: Partial<RemoteConfig> = {}): RemoteConfig => ({
  schemaVersion: 1, version: 1, issuedAt: NOW - 1000, expiresAt: NOW + DAY, rolloutPercent: 100,
  entries: [{ kind: 'field_mapping', provider: 'claude', target: 'usage_percent', path: 'limits.five_hour.utilization' }], ...over,
});
const signWith = (c: RemoteConfig, key = privateKey, keyId = 'k1'): SignedConfig => {
  const payload = canonicalize(c);
  return { payload, signature: sign(null, Buffer.from(payload), key).toString('base64'), keyId };
};
let clock = NOW;
const mgr = (installId = 'install-a', revoked = new Set<string>()) =>
  new RemoteConfigManager({ keys: KEYS, revokedKeyIds: revoked, installId, store: new MemoryConfigStore(), now: () => clock });

describe('remote config schema', () => {
  it('accepts selectors, field mappings and kill switches', () => {
    const r = validateConfig(cfg({ entries: [
      { kind: 'selector', provider: 'chatgpt', target: 'reset_time', css: 'div.usage > span[data-x="reset"]' },
      { kind: 'kill_switch', scope: 'radar_contribution' },
    ] }));
    expect(r.ok).toBe(true);
  });

  it.each([
    ['host permissions', { hostPermissions: ['https://*/*'] }],
    ['code', { script: 'fetch(1)' }],
    ['new collected fields', { collectFields: ['prompt'] }],
  ])('rejects unknown top-level keys: %s', (_n, extra) => {
    expect(validateConfig({ ...cfg(), ...extra }).ok).toBe(false);
  });

  it('rejects entry keys that would widen scope or run code', () => {
    for (const entry of [
      { kind: 'selector', provider: 'claude', target: 'usage_percent', css: 'a', eval: 'x' },
      { kind: 'field_mapping', provider: 'claude', target: 'prompt_text', path: 'a.b' },
      { kind: 'field_mapping', provider: 'claude', target: 'usage_percent', path: 'a.b; fetch(1)' },
      { kind: 'selector', provider: 'claude', target: 'usage_percent', css: 'a { background: url(http://x) }' },
      { kind: 'selector', provider: 'claude', target: 'usage_percent', css: 'a:has(b)' },
      { kind: 'host_permission', origin: 'https://evil.example' },
      { kind: 'kill_switch', scope: 'everything' },
    ]) expect(validateConfig(cfg({ entries: [entry as never] })).ok, JSON.stringify(entry)).toBe(false);
  });

  it('bounds lifetime, rollout and size', () => {
    expect(validateConfig(cfg({ expiresAt: NOW + 30 * DAY })).ok).toBe(false);
    expect(validateConfig(cfg({ expiresAt: NOW - 5000 })).ok).toBe(false);
    expect(validateConfig(cfg({ rolloutPercent: 101 })).ok).toBe(false);
    expect(validateConfig(cfg({ rolloutPercent: 1.5 })).ok).toBe(false);
    expect(validateConfig(cfg({ entries: Array(51).fill({ kind: 'kill_switch', scope: 'parser' }) })).ok).toBe(false);
  });
});

describe('signature and anti-rollback', () => {
  it('applies a correctly signed config', () => {
    const m = mgr();
    expect(m.apply(signWith(cfg()))).toEqual({ ok: true, status: 'applied', version: 1 });
    expect(m.active()?.version).toBe(1);
    expect(m.entries()).toHaveLength(1);
  });

  it('rejects wrong key, unknown key id, revoked key, tampered payload and bad envelopes', () => {
    expect(mgr().apply(signWith(cfg(), other.privateKey))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(mgr().apply(signWith(cfg(), privateKey, 'nope'))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(mgr('i', new Set(['k1'])).apply(signWith(cfg()))).toEqual({ ok: false, reason: 'bad_signature' });
    const s = signWith(cfg());
    expect(mgr().apply({ ...s, payload: s.payload.replace('"version":1', '"version":2') })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(mgr().apply({ payload: 1 } as never)).toEqual({ ok: false, reason: 'malformed_envelope' });
    const big = { ...cfg(), entries: [] };
    const payload = canonicalize(big) + ' '.repeat(MAX_PAYLOAD_BYTES);
    expect(mgr().apply({ payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64'), keyId: 'k1' })).toEqual({ ok: false, reason: 'payload_too_large' });
  });

  it('rejects a signed payload that fails schema validation', () => {
    const bad = cfg({ entries: [{ kind: 'selector', provider: 'claude', target: 'usage_percent', css: 'a:has(b)' }] });
    const payload = JSON.stringify(bad);
    const r = mgr().apply({ payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64'), keyId: 'k1' });
    expect(r.ok).toBe(false);
  });

  it('rejects expired, replayed and older versions', () => {
    const m = mgr();
    expect(m.apply(signWith(cfg({ version: 2 }))).ok).toBe(true);
    expect(m.apply(signWith(cfg({ version: 2 })))).toEqual({ ok: false, reason: 'version_not_newer' });
    expect(m.apply(signWith(cfg({ version: 1 })))).toEqual({ ok: false, reason: 'version_not_newer' });
    clock = NOW + 2 * DAY;
    expect(m.apply(signWith(cfg({ version: 3, issuedAt: NOW, expiresAt: NOW + DAY })))).toEqual({ ok: false, reason: 'expired' });
    clock = NOW;
  });
});

describe('staged rollout', () => {
  it('applies only to installs inside the percentage and is monotone as it grows', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `install-${i}`);
    const at = (pct: number) => new Set(ids.filter(id => rolloutBucket(id) < pct));
    expect(at(0).size).toBe(0);
    expect(at(100).size).toBe(400);
    const ten = at(10); const fifty = at(50);
    expect([...ten].every(id => fifty.has(id))).toBe(true);
    expect(ten.size).toBeGreaterThan(10);
    expect(ten.size).toBeLessThan(80);
  });

  it('skips an install outside the rollout, records it, and still protects against older versions', () => {
    const id = Array.from({ length: 200 }, (_, i) => `i${i}`).find(x => rolloutBucket(x) >= 50)!;
    const m = mgr(id);
    expect(m.apply(signWith(cfg({ rolloutPercent: 50 })))).toEqual({ ok: true, status: 'staged_skip', version: 1 });
    expect(m.active()).toBeNull();
    expect(m.history().at(-1)?.action).toBe('staged_skip');
    expect(m.apply(signWith(cfg({ version: 2, rolloutPercent: 100 }))).ok).toBe(true);
  });
});

describe('expiry, kill switch, rollback, audit', () => {
  it('drops an expired config and audits it once', () => {
    const m = mgr();
    m.apply(signWith(cfg()));
    clock = NOW + 2 * DAY;
    expect(m.active()).toBeNull();
    expect(m.active()).toBeNull();
    expect(m.history().filter(a => a.action === 'expired')).toHaveLength(1);
    clock = NOW;
  });

  it('honours kill switches by scope and provider', () => {
    const m = mgr();
    m.apply(signWith(cfg({ entries: [{ kind: 'kill_switch', scope: 'parser', provider: 'claude' }] })));
    expect(m.isKilled('parser', 'claude')).toBe(true);
    expect(m.isKilled('parser', 'chatgpt')).toBe(false);
    expect(m.isKilled('radar_contribution')).toBe(false);
  });

  it('rolls back instantly to the previous version and blocks the bad one from returning', () => {
    const m = mgr();
    m.apply(signWith(cfg({ version: 1 })));
    m.apply(signWith(cfg({ version: 2, entries: [{ kind: 'kill_switch', scope: 'radar_contribution' }] })));
    expect(m.isKilled('radar_contribution')).toBe(true);
    expect(m.rollback('bad config')).toEqual({ version: 1 });
    expect(m.isKilled('radar_contribution')).toBe(false);
    expect(m.apply(signWith(cfg({ version: 2 })))).toEqual({ ok: false, reason: 'version_rolled_back' });
    expect(m.rollback()).toEqual({ version: null });
    expect(m.active()).toBeNull();
  });

  it('keeps an audit history of every outcome with no payload content', () => {
    const m = mgr();
    m.apply(signWith(cfg()));
    m.apply(signWith(cfg(), other.privateKey));
    m.rollback('test');
    const h = m.history();
    expect(h.map(a => a.action)).toEqual(['applied', 'rejected', 'rolled_back']);
    expect(JSON.stringify(h)).not.toContain('utilization');
  });

  it('caps the audit log', () => {
    const m = mgr();
    for (let i = 0; i < 260; i++) m.rollback('x');
    expect(m.history().length).toBe(200);
  });
});

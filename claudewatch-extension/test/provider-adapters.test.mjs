import { readdirSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

// Adapter contract: every provider adapter must satisfy the same checks against the same
// fixture kinds. Adding a provider means adding its fixtures; the suite below does not change.
// Fixtures are synthetic: shaped like each provider's response as the adapters parse it,
// with fake identities. They are not captures of live accounts.
const DIR = new URL('./fixtures/providers/', import.meta.url);
const PROVIDERS = ['claude', 'chatgpt', 'gemini'];
const KINDS = ['normal', 'partial', 'missing', 'expired', 'changed-schema', 'rate-limited', 'impossible'];
const load = (provider, kind) => JSON.parse(readFileSync(new URL(`${provider}.${kind}.json`, DIR), 'utf8'));

let A, C;
beforeAll(async () => {
  globalThis.self = globalThis;
  await import('../provider-contract.js');
  await import('../provider-adapters.js');
  A = globalThis.TokenWatcherAdapters;
  C = globalThis.TokenWatcherContract;
});

it('has every fixture kind for every provider and no stray files', () => {
  const expected = PROVIDERS.flatMap(p => KINDS.map(k => `${p}.${k}.json`)).sort();
  expect(readdirSync(DIR).sort()).toEqual(expected);
});

describe.each(PROVIDERS)('%s adapter contract', provider => {
  describe.each(KINDS)('%s fixture', kind => {
    const fixture = load(provider, kind);
    const now = Date.parse(fixture.now);

    it('classifies the outcome', () => {
      const result = A.adapt(fixture.input);
      expect(result.site).toBe(provider);
      expect(result.category).toBe(fixture.expect.category);
      expect(result.snapshots).toHaveLength(fixture.expect.snapshotCount);
    });

    it('emits only contract-valid readings and explains every missing one', () => {
      const { snapshots } = A.adapt(fixture.input);
      for (const snapshot of snapshots) {
        expect(snapshot.site).toBe(provider);
        const readings = C.toReadings(snapshot, { fetchedAt: fixture.input.capturedAt, now });
        expect(readings.map(r => r.windowType)).toEqual(['5h', '7d']);
        fixture.expect.readings.forEach((want, i) => {
          const got = readings[i];
          expect(got.provider).toBe(provider);
          expect(got.provenance).toBe('provider_reported');
          expect(C.validateReading(got, { now })).toBeNull();
          if (want.usedPct == null) {
            expect(got.usedPct).toBeNull();
            expect(got.error?.category).toBe(want.errorCategory);
            expect(got.error.message.length).toBeGreaterThan(10);
          } else {
            expect(got.usedPct).toBeCloseTo(want.usedPct, 5);
            expect(got.remainingPct).toBeCloseTo(100 - want.usedPct, 3);
            expect(got.error).toBeNull();
          }
        });
        // Snapshot-level validation is what gates persistence.
        const rejected = C.validateSnapshot(snapshot, { now }) != null;
        expect(rejected).toBe(Boolean(fixture.expect.rejectedBySnapshotValidation));
      }
    });

    it('never carries credentials, cookies or raw prompt content', () => {
      const text = JSON.stringify(fixture.input).toLowerCase();
      for (const banned of ['cookie', 'authorization', 'bearer ', 'sessionkey', 'access_token', 'prompt']) {
        expect(text).not.toContain(banned);
      }
    });
  });
});

describe('failure categorisation', () => {
  it.each([
    [{ status: 429 }, 'rate_limited'],
    [{ status: 401 }, 'auth_expired'],
    [{ status: 403 }, 'auth_expired'],
    [{ error: 'provider_tab_missing' }, 'provider_tab_missing'],
    [{ error: 'provider_tab_timeout' }, 'provider_tab_timeout'],
    [{ error: 'request timeout' }, 'timeout'],
    [{ error: 'Failed to fetch' }, 'network'],
    [{ error: 'boom' }, 'other'],
  ])('%j -> %s', (msg, category) => {
    expect(A.categorizeFailure(msg)).toBe(category);
  });

  it('treats a successful fetch with an unrecognised body as a schema change for unknown sites too', () => {
    expect(A.adapt({ site: 'claude', ok: true, snapshot: null }).category).toBe('provider_schema_changed');
  });
});

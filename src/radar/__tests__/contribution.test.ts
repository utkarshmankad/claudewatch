import { describe, expect, it } from 'vitest';
import {
  CONTRIBUTION_FIELDS, MIN_COHORT_SIZE, PROHIBITED_FIELD_PATTERN, SAMPLE_CONTRIBUTION, buildContribution, cohortPublishable,
  coarseVersion, previewContribution, sampleBand, timeBucket, validateContribution,
} from '../contribution.js';

const good = () => ({ ...SAMPLE_CONTRIBUTION });

describe('radar contribution schema', () => {
  it('accepts the sample payload', () => {
    expect(validateContribution(good()).ok).toBe(true);
  });

  it.each(['prompt', 'cookie', 'email', 'ip', 'accountId', 'url', 'usage'])('rejects unexpected field %s', (k) => {
    const r = validateContribution({ ...good(), [k]: 'x' });
    expect(r.ok).toBe(false);
  });

  it('rejects missing fields, non-objects and arrays', () => {
    const rest: Record<string, unknown> = good();
    delete rest['provider'];
    expect(validateContribution(rest).ok).toBe(false);
    expect(validateContribution(null).ok).toBe(false);
    expect(validateContribution([]).ok).toBe(false);
    expect(validateContribution('x').ok).toBe(false);
  });

  it('rejects out-of-set and malformed values without echoing them', () => {
    const r = validateContribution({ ...good(), provider: 'secret-value-123', schemaSignature: 'nothex', extensionVersion: '1.2', timeBucket: '2026-10-24T07:13:00Z', schemaVersion: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBe(5);
      expect(r.errors.join(' ')).not.toContain('secret-value-123');
    }
  });

  it('truncates long unexpected field names in errors', () => {
    const r = validateContribution({ ...good(), ['x'.repeat(200)]: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.length).toBeLessThan(80);
  });

  it('allowlist contains no prohibited-looking field names', () => {
    for (const f of CONTRIBUTION_FIELDS) expect(PROHIBITED_FIELD_PATTERN.test(f), f).toBe(false);
  });

  it('the prohibited pattern flags identity and content names', () => {
    for (const f of ['prompt', 'cookie', 'userId', 'accountEmail', 'ipAddress', 'pageUrl', 'sessionToken']) expect(PROHIBITED_FIELD_PATTERN.test(f), f).toBe(true);
  });
});

describe('coarsening', () => {
  it('rounds timestamps to 6-hour UTC buckets', () => {
    expect(timeBucket(Date.parse('2026-10-24T07:59:59.999Z'))).toBe('2026-10-24T06:00:00Z');
    expect(timeBucket(Date.parse('2026-10-24T23:00:00Z'))).toBe('2026-10-24T18:00:00Z');
  });
  it('drops pre-release and build suffixes from versions', () => {
    expect(coarseVersion('1.2.3-beta.4+abc')).toBe('1.2.3');
    expect(coarseVersion('garbage')).toBe('0.0.0');
  });
  it('buildContribution coarsens and validates', () => {
    const c = buildContribution({ ...good(), extensionVersion: '0.1.1-rc.1', observedAt: Date.parse('2026-10-24T13:45:00Z') });
    expect(c.extensionVersion).toBe('0.1.1');
    expect(c.timeBucket).toBe('2026-10-24T12:00:00Z');
    expect(() => buildContribution({ ...good(), schemaSignature: 'bad', observedAt: 0 })).toThrow(/invalid contribution/);
  });
});

describe('preview', () => {
  it('previews the sample and marks it as a sample', () => {
    const p = previewContribution();
    expect(p.isSample).toBe(true);
    expect(JSON.parse(p.json)).toEqual(SAMPLE_CONTRIBUTION);
    expect(p.fields.map((f) => f.name)).toEqual([...CONTRIBUTION_FIELDS]);
    expect(p.neverSent.length).toBeGreaterThan(3);
  });
  it('previews a real payload byte-for-byte and refuses invalid payloads', () => {
    const c = { ...good(), provider: 'gemini' as const };
    expect(JSON.parse(previewContribution(c).json)).toEqual(c);
    expect(previewContribution(c).isSample).toBe(false);
    expect(() => previewContribution({ ...c, extra: 1 } as never)).toThrow(/preview refused/);
  });
});

describe('cohort rule', () => {
  it('suppresses cohorts below the minimum', () => {
    expect(cohortPublishable(MIN_COHORT_SIZE - 1)).toBe(false);
    expect(cohortPublishable(MIN_COHORT_SIZE)).toBe(true);
    expect(cohortPublishable(1.5)).toBe(false);
    expect(cohortPublishable(Number.NaN)).toBe(false);
  });
  it('shows bands, never exact small counts', () => {
    expect([0, 19, 20, 49, 50, 199, 200, 5000].map(sampleBand)).toEqual(['<20', '<20', '20-49', '20-49', '50-199', '50-199', '200+', '200+']);
  });
});

// Limit Change Radar contribution schema (prompt 4.1). Strict allowlist: every field has a closed value set,
// unknown fields are rejected, and nothing free-form is accepted, so a contribution cannot carry content or identity.

export const RADAR_SCHEMA_VERSION = 1;

export const PROVIDERS = ['claude', 'chatgpt', 'gemini', 'copilot', 'cursor', 'other'] as const;
export const PLAN_TYPES = ['free', 'individual_paid', 'team', 'enterprise', 'api', 'unknown'] as const;
export const REGION_BUCKETS = ['americas', 'emea', 'apac', 'other'] as const;
export const WINDOW_TYPES = ['rolling_5h', 'daily', 'weekly', 'monthly', 'other'] as const;
export const PARSER_RESULTS = ['ok', 'partial', 'missing_fields', 'schema_mismatch', 'error'] as const;
export const RESET_BEHAVIORS = ['as_expected', 'earlier', 'later', 'absent', 'unknown'] as const;

export type Provider = (typeof PROVIDERS)[number];

export interface RadarContribution {
  schemaVersion: typeof RADAR_SCHEMA_VERSION;
  provider: Provider;
  planType: (typeof PLAN_TYPES)[number];
  regionBucket: (typeof REGION_BUCKETS)[number];
  windowType: (typeof WINDOW_TYPES)[number];
  /** Truncated hash of the sorted field-name set of the observed provider payload; never values. */
  schemaSignature: string;
  parserResult: (typeof PARSER_RESULTS)[number];
  resetBehavior: (typeof RESET_BEHAVIORS)[number];
  /** Release of the extension, major.minor.patch only. */
  extensionVersion: string;
  /** UTC start of the hour, rounded to a 6-hour bucket, ISO 8601 with zero minutes/seconds. */
  timeBucket: string;
}

export const CONTRIBUTION_FIELDS = [
  'schemaVersion', 'provider', 'planType', 'regionBucket', 'windowType', 'schemaSignature',
  'parserResult', 'resetBehavior', 'extensionVersion', 'timeBucket',
] as const;

/** Names that must never appear, even if someone adds them to the allowlist by mistake. Checked by tests and at runtime. */
export const PROHIBITED_FIELD_PATTERN = /prompt|response|message|content|cookie|token|secret|credential|password|email|account|user|ip|url|host|session|device|id$/i;

export const MIN_COHORT_SIZE = 20;
export const BUCKET_HOURS = 6;
export const RETENTION_DAYS = { rawContribution: 7, aggregate: 90 } as const;

export type ValidationResult = { ok: true; value: RadarContribution } | { ok: false; errors: string[] };

const SIGNATURE_RE = /^[0-9a-f]{16}$/;
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const BUCKET_RE = /^\d{4}-\d{2}-\d{2}T(00|06|12|18):00:00Z$/;

function oneOf<T extends readonly string[]>(set: T, v: unknown): v is T[number] {
  return typeof v === 'string' && (set as readonly string[]).includes(v);
}

/** Validate an untrusted object. Rejects unknown/missing fields, wrong types and out-of-set values; never echoes values. */
export function validateContribution(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: ['payload must be an object'] };
  const o = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(o)) if (!(CONTRIBUTION_FIELDS as readonly string[]).includes(k)) errors.push(`unexpected field: ${k.slice(0, 40)}`);
  for (const k of CONTRIBUTION_FIELDS) if (!(k in o)) errors.push(`missing field: ${k}`);
  if (errors.length) return { ok: false, errors };
  if (o['schemaVersion'] !== RADAR_SCHEMA_VERSION) errors.push('schemaVersion unsupported');
  const enums: [string, readonly string[]][] = [
    ['provider', PROVIDERS], ['planType', PLAN_TYPES], ['regionBucket', REGION_BUCKETS], ['windowType', WINDOW_TYPES],
    ['parserResult', PARSER_RESULTS], ['resetBehavior', RESET_BEHAVIORS],
  ];
  for (const [k, set] of enums) if (!oneOf(set, o[k])) errors.push(`${k} not in allowed set`);
  if (typeof o['schemaSignature'] !== 'string' || !SIGNATURE_RE.test(o['schemaSignature'])) errors.push('schemaSignature must be 16 hex chars');
  if (typeof o['extensionVersion'] !== 'string' || !VERSION_RE.test(o['extensionVersion'])) errors.push('extensionVersion must be major.minor.patch');
  if (typeof o['timeBucket'] !== 'string' || !BUCKET_RE.test(o['timeBucket'])) errors.push('timeBucket must be a 6-hour UTC bucket');
  return errors.length ? { ok: false, errors } : { ok: true, value: o as unknown as RadarContribution };
}

/** Round a timestamp down to its 6-hour UTC bucket. */
export function timeBucket(ms: number): string {
  const step = BUCKET_HOURS * 3_600_000;
  return new Date(Math.floor(ms / step) * step).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Coarsen an extension version to major.minor.patch, dropping any pre-release or build suffix. */
export function coarseVersion(v: string): string {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})/.exec(v);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '0.0.0';
}

/** Build a contribution from already-normalized observations; throws if the result would be invalid. */
export function buildContribution(obs: Omit<RadarContribution, 'schemaVersion' | 'timeBucket' | 'extensionVersion'> & { extensionVersion: string; observedAt: number }): RadarContribution {
  const { observedAt, ...rest } = obs;
  const c: RadarContribution = { ...rest, schemaVersion: RADAR_SCHEMA_VERSION, extensionVersion: coarseVersion(obs.extensionVersion), timeBucket: timeBucket(observedAt) };
  const r = validateContribution(c);
  if (!r.ok) throw new Error(`invalid contribution: ${r.errors.join('; ')}`);
  return r.value;
}

/** A fixed, representative payload shown before opt-in. It is a sample, not the user's data. */
export const SAMPLE_CONTRIBUTION: RadarContribution = Object.freeze({
  schemaVersion: RADAR_SCHEMA_VERSION, provider: 'claude', planType: 'individual_paid', regionBucket: 'emea', windowType: 'rolling_5h',
  schemaSignature: '0123456789abcdef', parserResult: 'ok', resetBehavior: 'as_expected', extensionVersion: '0.1.1', timeBucket: '2026-10-24T06:00:00Z',
});

export interface ContributionPreview { json: string; fields: { name: string; value: string; meaning: string }[]; neverSent: string[]; isSample: boolean }

const MEANINGS: Record<(typeof CONTRIBUTION_FIELDS)[number], string> = {
  schemaVersion: 'Version of this contribution format', provider: 'Which AI service the observation is about',
  planType: 'Coarse plan category, not your plan name or account', regionBucket: 'Continent-sized bucket, not your country or IP location',
  windowType: 'Kind of usage window observed', schemaSignature: 'Fingerprint of the field names the provider page returned (no values)',
  parserResult: 'Whether the extension could read the usage data', resetBehavior: 'Whether the window reset when expected',
  extensionVersion: 'Extension release, to spot version-specific parser faults', timeBucket: 'When, rounded down to a 6-hour UTC bucket',
};

export const NEVER_SENT = ['Prompts or responses', 'Cookies, tokens or credentials', 'Your IP address or any IP-derived identity', 'Email, account or organization identifiers', 'Usage amounts, counts or minute-level activity', 'Page URLs or titles'];

/** Render exactly what would be sent. Pass a real contribution to preview it, or omit it to preview the sample. */
export function previewContribution(c?: RadarContribution): ContributionPreview {
  const value = c ?? SAMPLE_CONTRIBUTION;
  const v = validateContribution(value);
  if (!v.ok) throw new Error('preview refused: payload does not match the schema');
  return {
    json: JSON.stringify(value, CONTRIBUTION_FIELDS as unknown as string[], 2),
    fields: CONTRIBUTION_FIELDS.map((name) => ({ name, value: String(value[name]), meaning: MEANINGS[name] })),
    neverSent: NEVER_SENT, isSample: c === undefined,
  };
}

/** Cohort rule: a group is publishable only when it has at least MIN_COHORT_SIZE distinct contributors. */
export function cohortPublishable(distinctContributors: number): boolean {
  return Number.isInteger(distinctContributors) && distinctContributors >= MIN_COHORT_SIZE;
}

/** Display band for a cohort size; exact counts below the next band are never shown. */
export function sampleBand(distinctContributors: number): '<20' | '20-49' | '50-199' | '200+' {
  if (distinctContributors < MIN_COHORT_SIZE) return '<20';
  if (distinctContributors < 50) return '20-49';
  if (distinctContributors < 200) return '50-199';
  return '200+';
}

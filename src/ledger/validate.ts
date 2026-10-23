import {
  CONFIDENCES, CORRECTION_REASONS, LEDGER_KINDS, LEDGER_SCHEMA_VERSION, MEASUREMENT_METHODS, PROVIDERS, SOURCES, WINDOW_TYPES,
  type LedgerInput,
} from './types.js';

export const MIN_TS = Date.UTC(2020, 0, 1);
export const MAX_TS = Date.UTC(2100, 0, 1);
const ALLOWED_KEYS = new Set([
  'schemaVersion', 'kind', 'provider', 'accountAlias', 'devicePseudonym', 'observedAt', 'ingestedAt', 'source',
  'confidence', 'measurementMethod', 'measures', 'window', 'supersedes', 'correctionReason', 'reconciliation',
]);
const MEASURE_KEYS = new Set(['quotaPercentUsed', 'estimatedTokens', 'requestCount', 'costMicroUsd']);
const ALIAS = /^[A-Za-z0-9 _.-]{1,40}$/;
const PSEUDONYM = /^[a-f0-9]{16,64}$/;
const RECORD_ID = /^[a-f0-9]{64}$/;

export type ValidationResult = { ok: true; value: LedgerInput } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTs = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= MIN_TS && v <= MAX_TS;
const isCount = (v: unknown, max = 1e12): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const oneOf = (list: readonly string[], v: unknown) => typeof v === 'string' && list.includes(v);

// Strict, fail-closed validation. Unknown fields are rejected so free text
// (prompts, ids, page content) cannot ride along in a record.
export function validateRecord(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['record must be an object'] };
  for (const k of Object.keys(raw)) if (!ALLOWED_KEYS.has(k)) errors.push(`unknown field: ${k}`);
  if (raw.schemaVersion !== LEDGER_SCHEMA_VERSION) errors.push('unsupported schemaVersion');
  if (!oneOf(LEDGER_KINDS, raw.kind)) errors.push('invalid kind');
  if (!oneOf(PROVIDERS, raw.provider)) errors.push('invalid provider');
  if (typeof raw.accountAlias !== 'string' || !ALIAS.test(raw.accountAlias)) errors.push('invalid accountAlias');
  if (typeof raw.devicePseudonym !== 'string' || !PSEUDONYM.test(raw.devicePseudonym)) errors.push('invalid devicePseudonym');
  if (!isTs(raw.observedAt)) errors.push('invalid observedAt');
  if (!isTs(raw.ingestedAt)) errors.push('invalid ingestedAt');
  if (!oneOf(SOURCES, raw.source)) errors.push('invalid source');
  if (!oneOf(CONFIDENCES, raw.confidence)) errors.push('invalid confidence');
  if (!oneOf(MEASUREMENT_METHODS, raw.measurementMethod)) errors.push('invalid measurementMethod');

  const m = raw.measures;
  if (!isObj(m)) errors.push('measures must be an object');
  else {
    for (const k of Object.keys(m)) if (!MEASURE_KEYS.has(k)) errors.push(`unknown measure: ${k}`);
    if (m.quotaPercentUsed !== undefined && !(typeof m.quotaPercentUsed === 'number' && Number.isFinite(m.quotaPercentUsed) && m.quotaPercentUsed >= 0 && m.quotaPercentUsed <= 100)) errors.push('quotaPercentUsed out of range');
    for (const k of ['estimatedTokens', 'requestCount', 'costMicroUsd'])
      if (m[k] !== undefined && !isCount(m[k])) errors.push(`${k} must be a non-negative integer`);
  }

  const w = raw.window;
  if (w !== undefined) {
    if (!isObj(w) || !oneOf(WINDOW_TYPES, w.type) || (w.resetAt !== undefined && !isTs(w.resetAt))) errors.push('invalid window');
  }
  if (raw.supersedes !== undefined && !(typeof raw.supersedes === 'string' && RECORD_ID.test(raw.supersedes))) errors.push('invalid supersedes');
  if (raw.correctionReason !== undefined && !oneOf(CORRECTION_REASONS, raw.correctionReason)) errors.push('invalid correctionReason');
  const r = raw.reconciliation;
  if (r !== undefined) {
    if (!isObj(r) || !isCount(r.attributedUnits) || !isCount(r.eligibleUnits) || (r.attributedUnits as number) > (r.eligibleUnits as number)) errors.push('invalid reconciliation');
  }

  // Kind-specific rules keep provider facts separate from local estimates.
  if (errors.length === 0) {
    const meas = m as Record<string, unknown>;
    switch (raw.kind) {
      case 'provider_snapshot':
        if (raw.measurementMethod !== 'provider_reported') errors.push('provider_snapshot must be provider_reported');
        if (meas.quotaPercentUsed === undefined) errors.push('provider_snapshot requires quotaPercentUsed');
        if (!w) errors.push('provider_snapshot requires window');
        break;
      case 'local_activity':
        if (meas.quotaPercentUsed !== undefined) errors.push('local_activity must not carry quotaPercentUsed');
        if (raw.measurementMethod === 'provider_reported') errors.push('local_activity cannot be provider_reported');
        break;
      case 'reset':
        if (!w || (w as { resetAt?: number }).resetAt === undefined) errors.push('reset requires window.resetAt');
        break;
      case 'correction':
        if (raw.supersedes === undefined || raw.correctionReason === undefined) errors.push('correction requires supersedes and correctionReason');
        break;
      case 'reconciliation':
        if (r === undefined) errors.push('reconciliation requires reconciliation');
        break;
    }
    if (raw.kind !== 'correction' && (raw.supersedes !== undefined || raw.correctionReason !== undefined)) errors.push('supersedes only valid on correction');
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: raw as unknown as LedgerInput };
}

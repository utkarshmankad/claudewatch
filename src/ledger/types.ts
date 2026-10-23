// Universal usage ledger, schema v1. See docs/LEDGER.md for the rules.
export const LEDGER_SCHEMA_VERSION = 1;

export const LEDGER_KINDS = ['provider_snapshot', 'local_activity', 'reset', 'correction', 'reconciliation'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const PROVIDERS = ['claude', 'chatgpt', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const SOURCES = ['web', 'claude_code', 'codex', 'gemini_cli', 'desktop', 'api', 'remote', 'unattributed'] as const;
export type LedgerSource = (typeof SOURCES)[number];

export const CONFIDENCES = ['high', 'medium', 'low', 'unknown'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const MEASUREMENT_METHODS = ['provider_reported', 'local_log_parse', 'local_estimate', 'derived', 'user_correction'] as const;
export type MeasurementMethod = (typeof MEASUREMENT_METHODS)[number];

export const WINDOW_TYPES = ['five_hour', 'weekly', 'daily', 'unknown'] as const;
export type WindowType = (typeof WINDOW_TYPES)[number];

export const CORRECTION_REASONS = ['clock_skew', 'duplicate_session', 'parser_fix', 'user_edit'] as const;
export type CorrectionReason = (typeof CORRECTION_REASONS)[number];

// Quota percentages, token estimates, request counts and money are separate
// measures and are never converted into one another.
export interface Measures {
  quotaPercentUsed?: number; // 0..100, provider facts only
  estimatedTokens?: number; // integer >= 0, always an estimate
  requestCount?: number; // integer >= 0, a fact when counted from local logs
  costMicroUsd?: number; // integer >= 0, derived from a price table, an estimate
}

export interface LedgerInput {
  schemaVersion: number;
  kind: LedgerKind;
  provider: Provider;
  accountAlias: string; // user-chosen alias; never a raw account id or email
  devicePseudonym: string; // random per-install hex, not a hardware id
  observedAt: number; // epoch ms UTC, when the thing happened or was read
  ingestedAt: number; // epoch ms UTC, when the ledger received it
  source: LedgerSource;
  confidence: Confidence;
  measurementMethod: MeasurementMethod;
  measures: Measures;
  window?: { type: WindowType; resetAt?: number }; // snapshot and reset records
  supersedes?: string; // correction: id of the record it replaces
  correctionReason?: CorrectionReason;
  reconciliation?: { attributedUnits: number; eligibleUnits: number };
}

export interface LedgerRecord extends LedgerInput {
  id: string; // sha256 over the identity fields, see recordId()
  effectiveObservedAt: number; // observedAt after clock-skew clamping
  flags: Array<'skew_clamped' | 'late_ingest'>;
}

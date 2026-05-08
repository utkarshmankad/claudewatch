import type { SpendThreshold } from '../config/schema.js';

/**
 * Passed to sendEmailAlert / sendDesktopAlert for every threshold crossing.
 *
 * Deduplication guarantee: callers (evaluateThresholdsWithCosts) write an
 * alert_log row and check hasAlertFired() BEFORE constructing this payload,
 * so each AlertPayload represents a genuinely new, not-yet-notified event.
 */
export interface AlertPayload {
  /** The threshold configuration that was crossed */
  threshold: SpendThreshold;
  /** Actual period spend expressed as a percentage of threshold.amountUsd (≥ 100) */
  currentPct: number;
  /** Actual spend for the threshold period in USD */
  estimatedCost: number;
  /** Anthropic billing period (UTC month start → now) */
  billingPeriod: { startingAt: string; endingAt: string };
}

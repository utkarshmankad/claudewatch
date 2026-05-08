import type { SpendThreshold } from '../config/schema.js';
import { getTotalCostSince } from '../store/usage.js';
import { hasAlertFired, recordAlert } from '../store/db.js';

export interface TriggeredThreshold {
  threshold: SpendThreshold;
  actualUsd: number;
}

/**
 * Pre-computed spend totals for each period window, derived directly from
 * API cost buckets. Passed to evaluateThresholdsWithCosts so the daemon
 * never re-queries the DB for spend amounts.
 */
/** Daily/weekly/monthly period cost totals. Structurally matches computePeriodCosts() output. */
export interface PeriodCosts {
  daily: number;
  weekly: number;
  monthly: number;
}

/**
 * Evaluate thresholds against freshly fetched API costs.
 * Records each alert in alert_log exactly once per period window
 * (hasAlertFired guard prevents re-firing on subsequent polls).
 */
export function evaluateThresholdsWithCosts(
  thresholds: SpendThreshold[],
  costs: PeriodCosts,
): TriggeredThreshold[] {
  const triggered: TriggeredThreshold[] = [];

  for (const t of thresholds) {
    const actualUsd = costs[t.period];
    if (actualUsd < t.amountUsd) continue;

    const since = periodStart(t.period);
    if (hasAlertFired(t.amountUsd, t.period, since)) continue;

    const channels: string[] = [];
    if (t.notifyEmail) channels.push('email');
    if (t.notifyDesktop) channels.push('desktop');

    recordAlert(t.amountUsd, t.period, actualUsd, channels);
    triggered.push({ threshold: t, actualUsd });
  }

  return triggered;
}

/**
 * Legacy variant — reads spend from cost_snapshots in SQLite.
 * Used by code still on the old AnthropicAdminClient path.
 */
export function evaluateThresholds(thresholds: SpendThreshold[]): TriggeredThreshold[] {
  const triggered: TriggeredThreshold[] = [];

  for (const t of thresholds) {
    const since = periodStart(t.period);
    const actualUsd = getTotalCostSince(since);

    if (actualUsd < t.amountUsd) continue;
    if (hasAlertFired(t.amountUsd, t.period, since)) continue;

    const channels: string[] = [];
    if (t.notifyEmail) channels.push('email');
    if (t.notifyDesktop) channels.push('desktop');

    recordAlert(t.amountUsd, t.period, actualUsd, channels);
    triggered.push({ threshold: t, actualUsd });
  }

  return triggered;
}

export function periodStart(period: SpendThreshold['period']): string {
  const now = new Date();
  switch (period) {
    case 'daily': {
      const d = new Date(now);
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case 'weekly': {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case 'monthly':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }
}

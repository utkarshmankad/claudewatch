// Metric definitions for weekly and monthly summaries (Prompt 5.1, operation key
// 2026-10-10.1/prompt-5.1). Every metric a report shows must have an entry here. See docs/WRAPPED_METRICS.md.
export const METRICS_VERSION = 1;

// How much a number may be trusted, in the ledger's vocabulary plus two states for gaps.
export type ClaimClass = 'provider_reported' | 'measured' | 'estimated' | 'requires_user_action';
export type MetricStatus = 'provider_reported' | 'measured' | 'estimated' | 'unavailable';

export const METRIC_IDS = [
  'provider_mix', 'client_mix', 'quota_risk_events', 'prevented_interruptions',
  'reset_utilization', 'unused_quota', 'forecast_accuracy', 'attributable_activity', 'subscription_cost',
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export interface MetricDefinition {
  id: MetricId;
  name: string;
  definition: string;
  inputs: string[];
  claim: ClaimClass; // the strongest claim the metric may make when its inputs are complete
  needsUserAction: boolean; // true: the value is unavailable until the user supplies or confirms input
  caveat: string;
}

export const METRIC_DEFINITIONS: Record<MetricId, MetricDefinition> = {
  provider_mix: {
    id: 'provider_mix', name: 'Provider mix',
    definition: 'Share of locally counted requests per provider in the period. Requests are counted from local logs only.',
    inputs: ['local_activity.requestCount'], claim: 'measured', needsUserAction: false,
    caveat: 'Excludes activity on other devices without a collector and activity that never reached a local log.',
  },
  client_mix: {
    id: 'client_mix', name: 'Supported-client mix',
    definition: 'Share of locally counted requests per supported client (web, Claude Code, Codex, Gemini CLI, desktop, API).',
    inputs: ['local_activity.requestCount', 'local_activity.source'], claim: 'measured', needsUserAction: false,
    caveat: 'Unattributed records are reported separately and never assigned to a client.',
  },
  quota_risk_events: {
    id: 'quota_risk_events', name: 'Quota risk events',
    definition: 'Number of quota windows in the period whose provider-reported usage reached the risk threshold (default 80%), and how many reached 100%.',
    inputs: ['provider_snapshot.quotaPercentUsed', 'provider_snapshot.window'], claim: 'provider_reported', needsUserAction: false,
    caveat: 'Counts windows, not minutes. A window with no snapshot near its peak can be undercounted.',
  },
  prevented_interruptions: {
    id: 'prevented_interruptions', name: 'Prevented interruptions',
    definition: 'Number of times the user confirmed that an alert or Autopilot suggestion let them avoid hitting a limit.',
    inputs: ['user confirmations'], claim: 'requires_user_action', needsUserAction: true,
    caveat: 'Never inferred from alerts or forecasts. Without a confirmation the value is unavailable, not zero.',
  },
  reset_utilization: {
    id: 'reset_utilization', name: 'Reset utilization',
    definition: 'Mean of the last provider-reported usage percent in each window that reset during the period.',
    inputs: ['provider_snapshot.quotaPercentUsed', 'window resets'], claim: 'provider_reported', needsUserAction: false,
    caveat: 'A lower bound: the last snapshot before a reset can precede the true final usage.',
  },
  unused_quota: {
    id: 'unused_quota', name: 'Unused quota',
    definition: 'Mean of 100 minus reset utilization across windows that reset during the period.',
    inputs: ['reset_utilization'], claim: 'provider_reported', needsUserAction: false,
    caveat: 'An upper bound, for the same reason as reset utilization. It is a share of a window, not tokens or money.',
  },
  forecast_accuracy: {
    id: 'forecast_accuracy', name: 'Forecast accuracy',
    definition: 'Mean absolute error, in quota points, of one-hour-ahead forecasts replayed against later snapshots in the period.',
    inputs: ['provider_snapshot', 'forecast backtest'], claim: 'estimated', needsUserAction: false,
    caveat: 'Shown only with at least 20 comparisons. It describes this account and period, not the model in general.',
  },
  attributable_activity: {
    id: 'attributable_activity', name: 'Attributable activity',
    definition: 'Share of provider-reported quota movement that local evidence explains, as a range, with the remainder labelled unattributed.',
    inputs: ['ledger reconciliation'], claim: 'estimated', needsUserAction: false,
    caveat: 'Requires a configured calibration. Without one the value is unavailable.',
  },
  subscription_cost: {
    id: 'subscription_cost', name: 'Subscription cost',
    definition: 'Plan price from the pricing catalog (or a manual override), prorated to the days each plan was active in the period, per currency.',
    inputs: ['pricing catalog', 'plan history'], claim: 'estimated', needsUserAction: true,
    caveat: 'The plan history is entered by the user. Currencies are never converted or added together. No savings are derived from tokens.',
  },
};

// Claims that need an explicit user action before they may be shown as a value.
export const requiresUserAction = (id: MetricId): boolean => METRIC_DEFINITIONS[id].needsUserAction;

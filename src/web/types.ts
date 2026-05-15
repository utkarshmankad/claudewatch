// ---------------------------------------------------------------------------
// API response shapes — must stay in sync with src/daemon/server.ts
// ---------------------------------------------------------------------------

export interface BillingPeriod {
  startingAt: string;
  endingAt: string;
}

export interface PeriodCosts {
  monthly: number | null;
  weekly: number | null;
  daily: number | null;
  /** ISO 8601 timestamp of last successful API fetch */
  updatedAt: string | null;
}

export interface SnapshotData {
  recordedAt: string;
  bucketStartingAt: string;
  bucketEndingAt: string;
  model: string | null;
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite1hTokens: number;
  cacheWrite5mTokens: number;
}

export interface SessionData {
  tokensUsed: number | null;
  tokenLimit: number | null;
  plan: string | null;
  resetsAt: string | null;
  windowEnd: string | null;
  pct: number;
}

export interface WeeklyData {
  tokensUsed: number;
  weekStart: string;
  weekReset: string;
  resetsAt: string;
}

export interface StatusResponse {
  billingPeriod: BillingPeriod;
  costs: PeriodCosts;
  spendLimitUsd: number | null;
  weeklySpendLimitUsd: number | null;
  weeklyTokenLimit: number | null;
  pollIntervalMinutes: number;
  lastPollAt: string | null;
  snapshot: SnapshotData | null;
  version: string;
  session: SessionData | null;
  weekly: WeeklyData;
  config: {
    weeklyTokenLimit: number | null;
  };
}

export interface UsageRow {
  day: string;    // YYYY-MM-DD
  model: string;
  tokens: number;
}

export interface UsageResponse {
  rows: UsageRow[];
}

export interface AlertRecord {
  id: number;
  firedAt: string;
  thresholdUsd: number;
  period: string;
  actualUsd: number;
  channels: string[];
}

export interface AlertsResponse {
  alerts: AlertRecord[];
}

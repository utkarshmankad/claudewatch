/**
 * In-process cache of the most recently computed period costs.
 * The daemon's tick function writes here after each API fetch;
 * the Express API server reads it without hitting the DB or the API again.
 */

export interface CachedCosts {
  monthly: number;
  weekly: number;
  daily: number;
  /** ISO 8601 timestamp of the last successful fetch */
  updatedAt: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
}

let cache: CachedCosts | null = null;

export function setCostCache(costs: CachedCosts): void {
  cache = costs;
}

export function getCostCache(): CachedCosts | null {
  return cache;
}

import type { AttributionSummary } from '../store/db.js';

export interface PlanRecommendation {
  status: 'insufficient-data' | 'comfortable' | 'near-limit' | 'over-limit';
  utilizationPct: number | null;
  message: string;
}

export function recommendPlan(tokensUsed: number, tokenLimit: number | null): PlanRecommendation {
  if (!tokenLimit || tokenLimit <= 0) return { status: 'insufficient-data', utilizationPct: null, message: 'Set a weekly token limit to enable plan-fit recommendations.' };
  const utilizationPct = (tokensUsed / tokenLimit) * 100;
  if (utilizationPct >= 100) return { status: 'over-limit', utilizationPct, message: 'Observed usage exceeds the configured plan allowance; evaluate a higher tier or workload routing.' };
  if (utilizationPct >= 80) return { status: 'near-limit', utilizationPct, message: 'Usage is likely to approach the allowance; review high-volume clients before upgrading.' };
  return { status: 'comfortable', utilizationPct, message: 'Observed usage fits within the configured allowance.' };
}

export function reconcileAttribution(rows: AttributionSummary[], authoritativeTokens?: number | null) {
  const observedTokens = rows.filter(r => r.client !== 'account_aggregate').reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  return {
    observedTokens,
    authoritativeTokens: authoritativeTokens ?? null,
    unattributedTokens: authoritativeTokens == null ? null : Math.max(0, authoritativeTokens - observedTokens),
    caveat: 'Unattributed usage is inferred and may include other devices, browsers, automations, or provider-side accounting differences.',
  };
}

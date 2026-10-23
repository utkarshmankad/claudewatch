// Builds policy inputs (ProviderInput[]) from the stats the popup already receives.
// The extension only has the latest provider-reported percentages and a short snapshot history,
// not the daemon ledger, so forecasts here are coarse and say so: confidence is never 'high'.
import { PROVIDERS } from './policy.mjs';

const HOUR = 3_600_000;
const WINDOWS = [
  { key: '5h', window: 'five_hour', ms: 5 * HOUR, minSpanMs: 20 * 60_000 },
  { key: '7d', window: 'weekly', ms: 7 * 24 * HOUR, minSpanMs: 6 * HOUR },
];
const MIN_POINTS = 4;
const AUTH_CATEGORIES = new Set(['auth_expired']);

const epoch = (v) => {
  const n = typeof v === 'number' ? v : Date.parse(v ?? '');
  return Number.isFinite(n) ? n : null;
};

// Coarse trend: straight-line burn over the readings inside the current window. Returns null
// when history is too sparse, in which case the policy treats risk as unknown.
export function coarseRisk({ history, pctKey, usedPercent, resetAt, now, spec }) {
  if (resetAt === null || resetAt <= now) return null;
  const since = resetAt - spec.ms;
  const pts = history.filter((h) => h[pctKey] != null && h.ts >= since && h.ts <= now).sort((a, b) => a.ts - b.ts);
  if (pts.length < MIN_POINTS) return null;
  const span = pts[pts.length - 1].ts - pts[0].ts;
  if (span < spec.minSpanMs) return null;
  const burnPerHour = ((pts[pts.length - 1][pctKey] - pts[0][pctKey]) / span) * HOUR;
  if (!(burnPerHour > 0)) return { probability: 0.05, earliest: null };
  const hoursToLimit = (100 - usedPercent) / burnPerHour;
  const hoursToReset = (resetAt - now) / HOUR;
  // Three coarse buckets rather than a calibrated probability.
  const probability = hoursToLimit < hoursToReset ? 0.85 : hoursToLimit < hoursToReset * 1.5 ? 0.4 : 0.05;
  return { probability, earliest: probability >= 0.85 ? now + hoursToLimit * HOUR * 0.5 : null };
}

function windowForecast({ site, spec, snapshot, health, history, now }) {
  const pct = snapshot?.[`pct${spec.key}`];
  if (pct == null || !Number.isFinite(pct)) return null;
  const resetAt = epoch(snapshot[`resetsAt${spec.key}`]);
  const base = {
    provider: site, accountAlias: 'main', window: spec.window, usedPercent: pct, asOf: snapshot.ts ?? null,
    resetAt, hoursToReset: resetAt === null ? null : Math.max(0, (resetAt - now) / HOUR), reservedPercent: 0,
    method: 'none', burnPerHour: null, safeHourlyAllowance: null, projectedLimitAt: null, probabilityExhaustBeforeReset: null,
    confidence: 'low', reasons: [], explanation: '',
  };
  if (pct >= 100) return { ...base, state: 'limited' };
  if (health?.stale) return { ...base, state: 'stale', reasons: ['stale_data'] };
  const risk = coarseRisk({ history, pctKey: `pct${spec.key}`, usedPercent: pct, resetAt, now, spec });
  if (!risk) return { ...base, state: 'insufficient_data', reasons: ['sparse_history'] };
  return {
    ...base, state: 'ok', method: 'trend', confidence: 'medium', probabilityExhaustBeforeReset: risk.probability,
    projectedLimitAt: risk.earliest === null ? null : { earliest: risk.earliest, latest: null, display: 'range' },
  };
}

// stats: the GET_STATS reply. restricted: providers the user keeps out of this task.
export function buildProviderInputs(stats, now, { restricted = [] } = {}) {
  const usage = stats?.providerUsage ?? {};
  const healthBy = stats?.providerHealth ?? {};
  const history = stats?.usageHistory ?? [];
  return PROVIDERS.map((site) => {
    const snapshot = usage[site] ?? null;
    const health = healthBy[site] ?? null;
    const category = health?.errorCategory ?? health?.category ?? null;
    // No reading at all means no evidence the user is signed in: never route there.
    const authenticated = Boolean(snapshot) && !AUTH_CATEGORIES.has(category);
    const failing = health?.ok === false;
    const siteHistory = history.filter((h) => h.site === site && (!snapshot?.accountId || h.accountId === snapshot.accountId));
    const forecasts = authenticated
      ? WINDOWS.map((spec) => windowForecast({ site, spec, snapshot, health, history: siteHistory, now })).filter(Boolean)
      : [];
    return {
      provider: site, accountAlias: 'main', authenticated,
      health: failing ? (health?.hasData ? 'degraded' : 'offline') : 'ok',
      privacyRestricted: restricted.includes(site),
      forecasts,
      hasReading: Boolean(snapshot),
    };
  });
}

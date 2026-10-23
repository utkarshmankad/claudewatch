import { expect, test } from '@playwright/test';
import type { AnalyticsResponse, LedgerView, StatusResponse } from '../../src/web/types.js';

const status: StatusResponse = {
  billingPeriod: { startingAt: '2026-10-01T00:00:00Z', endingAt: '2026-11-01T00:00:00Z' },
  costs: { monthly: 25, weekly: 10, daily: 5, updatedAt: '2026-10-10T00:00:00Z' },
  spendLimitUsd: 100, weeklySpendLimitUsd: null, weeklyTokenLimit: null,
  pollIntervalMinutes: 5, lastPollAt: null, snapshot: null, version: '0.1.0', session: null,
  weekly: { tokensUsed: 0, weekStart: '2026-10-05', weekReset: '2026-10-12', resetsAt: '2026-10-12' },
  config: { weeklyTokenLimit: null },
};
const analytics: AnalyticsResponse = {
  days: 30, attribution: [], hourlyActivity: [], leaderboard: [],
  reconciliation: { observedTokens: 1200, authoritativeTokens: null, unattributedTokens: null, caveat: 'Local estimates only.' },
  planRecommendation: { status: 'insufficient-data', utilizationPct: null, message: 'Collect more usage before comparing plans.' },
};

const NO_TOTALS = { records: 0, requests: 0, estimatedTokens: 0 };
const emptyLedger: LedgerView = {
  state: 'empty', stateReasons: [], totalRecords: 0, matched: 0, truncated: false, rows: [], quotaChanges: [], providerMovementPoints: 0,
  unidentifiedPoints: { low: 0, high: 0 }, lastProviderSnapshotAt: null, caveat: 'Token figures are local estimates, not billing.',
  totalsByLabel: { provider_reported: NO_TOTALS, measured: NO_TOTALS, estimated: NO_TOTALS, reconciled: NO_TOTALS, corrected: NO_TOTALS, unattributed: NO_TOTALS },
  options: { providers: [], accounts: [], devices: [], clients: [], sources: [], confidences: [] },
};
const T = Date.UTC(2026, 9, 1, 12, 0, 0);
const filledLedger: LedgerView = {
  ...emptyLedger, state: 'partial', stateReasons: ['no_provider_snapshots'], totalRecords: 2, matched: 2, providerMovementPoints: 10, unidentifiedPoints: { low: 10, high: 10 },
  totalsByLabel: { ...emptyLedger.totalsByLabel, provider_reported: { records: 1, requests: 0, estimatedTokens: 0 }, measured: { records: 1, requests: 1, estimatedTokens: 5000 } },
  quotaChanges: [{ provider: 'claude', account: 'work', window: 'five_hour', from: T, to: T + 600_000, providerDeltaPoints: 10, attributedPoints: { low: 0, high: 0 }, unattributedPoints: { low: 10, high: 10 }, evidenceCount: 1, notes: [], explanation: 'No calibration is configured.' }],
  rows: [
    { id: 'a', at: T, provider: 'claude', account: 'work', device: 'a1b2c3d4e5f60718', client: 'web', source: 'provider_reported', confidence: 'high', kind: 'provider_snapshot', label: 'provider_reported', labelText: 'Provider-reported', window: 'five_hour', quotaPercentUsed: 20, flags: [] },
    { id: 'b', at: T + 1, provider: 'claude', account: 'work', device: 'a1b2c3d4e5f60718', client: 'claude_code', source: 'local_log_parse', confidence: 'medium', kind: 'local_activity', label: 'measured', labelText: 'Measured on this device', estimatedTokens: 5000, requestCount: 1, flags: [] },
  ],
  options: { providers: ['claude'], accounts: ['work'], devices: ['a1b2c3d4e5f60718'], clients: ['claude_code', 'web'], sources: ['local_log_parse', 'provider_reported'], confidences: ['high', 'medium'] },
};

test('renders spend and analytics from daemon responses', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const responses: Record<string, unknown> = {
      '/api/status': status,
      '/api/usage': { rows: [] },
      '/api/alerts': { alerts: [] },
      '/api/analytics': analytics,
      '/api/ledger': emptyLedger,
    };
    const path = new URL(route.request().url()).pathname;
    if (!(path in responses)) throw new Error(`Unexpected API request: ${path}`);
    await route.fulfill({ json: responses[path] });
  });
  await page.goto('/');
  await expect(page.getByText('Billing period spend', { exact: true })).toBeVisible();
  await expect(page.getByText('25.0%', { exact: true })).toBeVisible();
  await expect(page.getByText('$75.0000', { exact: true })).toBeVisible();
  await expect(page.getByText('No alerts fired yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('1,200', { exact: true })).toBeVisible();
  await expect(page.locator('a[href="/api/report?days=30&format=csv"]')).toHaveAttribute('href', '/api/report?days=30&format=csv');
  expect(errors).toEqual([]);
});

test('ledger shows an empty state, then text-labelled evidence with filters, export and delete', async ({ page }) => {
  const requests: string[] = [];
  let ledger = emptyLedger;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.pathname}${url.search}`);
    const responses: Record<string, unknown> = { '/api/status': status, '/api/usage': { rows: [] }, '/api/alerts': { alerts: [] }, '/api/analytics': analytics, '/api/ledger': ledger };
    if (route.request().method() === 'DELETE') { ledger = emptyLedger; await route.fulfill({ json: { ok: true, deleted: 2 } }); return; }
    await route.fulfill({ json: responses[url.pathname] });
  });
  await page.goto('/');
  await expect(page.getByText('No ledger data yet.')).toBeVisible();

  ledger = filledLedger;
  await page.reload();
  await expect(page.getByText('Partial picture.')).toBeVisible();
  await expect(page.getByText('Provider-reported', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Measured on this device', { exact: true })).toBeVisible();
  await expect(page.getByText('~5,000 tokens (estimate)')).toBeVisible();
  await expect(page.getByText('Unattributed (no local evidence)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete all ledger data…' })).toBeVisible();

  await page.getByLabel('Client').selectOption('claude_code');
  await expect.poll(() => requests.some(r => r.includes('/api/ledger?client=claude_code'))).toBe(true);
  await expect(page.getByRole('link', { name: 'Export JSON' })).toHaveAttribute('href', '/api/ledger/export?client=claude_code');

  await page.getByRole('button', { name: 'Delete matching records…' }).click();
  await page.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page.getByText('Deleted 2 records from this device.')).toBeVisible();
  expect(requests).toContain('DELETE /api/ledger?client=claude_code&confirm=yes');
});

test('shows an actionable message when the daemon is unavailable', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/');
  await expect(page.getByText('Cannot reach daemon', { exact: true })).toBeVisible();
  await expect(page.getByText('claudewatch start', { exact: true })).toBeVisible();
});

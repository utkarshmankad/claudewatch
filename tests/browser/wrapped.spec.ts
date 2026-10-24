import { expect, test } from '@playwright/test';
import type { AnalyticsResponse, StatusResponse, WrappedPreviewResponse } from '../../src/web/types.js';

// Usage Wrapped panel (Prompt 5.2, operation key 2026-10-10.1/prompt-5.2). API responses are mocked.
test.use({ timezoneId: 'UTC' });

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
  reconciliation: { observedTokens: 0, authoritativeTokens: null, unattributedTokens: null, caveat: 'Local estimates only.' },
  planRecommendation: { status: 'insufficient-data', utilizationPct: null, message: 'Collect more usage before comparing plans.' },
};
const NO_TOTALS = { records: 0, requests: 0, estimatedTokens: 0 };
const emptyLedger = {
  state: 'empty', stateReasons: [], totalRecords: 0, matched: 0, truncated: false, rows: [], quotaChanges: [], providerMovementPoints: 0,
  unidentifiedPoints: { low: 0, high: 0 }, lastProviderSnapshotAt: null, caveat: 'x',
  totalsByLabel: { provider_reported: NO_TOTALS, measured: NO_TOTALS, estimated: NO_TOTALS, reconciled: NO_TOTALS, corrected: NO_TOTALS, unattributed: NO_TOTALS },
  options: { providers: [], accounts: [], devices: [], clients: [], sources: [], confidences: [] },
};
const emptyRadar = { state: 'empty', beta: true, generatedAt: 0, incidents: [], disclaimer: 'Radar shows aggregated observations from opted-in Token Watcher users.' };
const wrapped = {
  report: { period: { label: '2026-10-05 to 2026-10-11' } },
  html: '<!doctype html><html lang="en"><body><h1>Usage Wrapped preview body</h1></body></html>',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
  preview: { token: 'tok123', includes: [{ field: 'Providers', detail: 'claude' }], excludes: ['Device identifiers and device names'], warnings: [] },
} as unknown as WrappedPreviewResponse;

test('wrapped report opens on demand, previews privacy, and enables export only after review', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    const responses: Record<string, unknown> = {
      '/api/status': status, '/api/usage': { rows: [] }, '/api/alerts': { alerts: [] }, '/api/analytics': analytics, '/api/ledger': emptyLedger,
      '/api/radar': emptyRadar, '/api/radar/prefs': { enabled: false },
      '/api/wrapped/choices': { accounts: ['work'], providers: ['claude'], devices: ['a1b2c3d4e5f60718'], timeZone: 'UTC', week: { start: 0, end: 1 } },
      '/api/wrapped': wrapped,
    };
    if (!(url.pathname in responses)) throw new Error(`Unexpected API request: ${url.pathname}`);
    await route.fulfill({ json: responses[url.pathname] });
  });
  await page.goto('/');
  await expect(page.getByText('Built on this device from your local ledger. Nothing is uploaded.')).toBeVisible();
  expect(requests.filter(r => r.startsWith('/api/wrapped'))).toEqual([]);

  await page.getByRole('button', { name: 'Open weekly report' }).click();
  await expect(page.getByRole('region', { name: 'Privacy preview' })).toBeVisible();
  await expect(page.frameLocator('iframe[title="Usage Wrapped report preview"]').getByRole('heading', { name: 'Usage Wrapped preview body' })).toBeVisible();
  await expect(page.getByText('Device 1')).toBeVisible();
  await expect(page.getByText('a1b2c3d4e5f60718')).toHaveCount(0);

  await expect(page.getByText('Export PDF')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Export Image (PNG)' })).toBeDisabled();
  await page.getByLabel('I have reviewed what will be exported').check();
  await expect(page.getByRole('link', { name: 'Export PDF' })).toHaveAttribute('href', '/api/wrapped/export?tz=UTC&format=pdf&token=tok123');
  await expect(page.getByRole('button', { name: 'Export Image (PNG)' })).toBeEnabled();
});

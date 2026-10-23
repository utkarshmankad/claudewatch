import { expect, test } from '@playwright/test';
import type { AnalyticsResponse, StatusResponse } from '../../src/web/types.js';

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

test('renders spend and analytics from daemon responses', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const responses: Record<string, unknown> = {
      '/api/status': status,
      '/api/usage': { rows: [] },
      '/api/alerts': { alerts: [] },
      '/api/analytics': analytics,
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
  await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveAttribute('href', '/api/report?days=30&format=csv');
  expect(errors).toEqual([]);
});

test('shows an actionable message when the daemon is unavailable', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/');
  await expect(page.getByText('Cannot reach daemon', { exact: true })).toBeVisible();
  await expect(page.getByText('claudewatch start', { exact: true })).toBeVisible();
});

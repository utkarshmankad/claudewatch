import { createElement } from 'react';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import type { Config } from '../../config/schema.js';

const fetchCostReport = vi.hoisted(() => vi.fn());

vi.mock('../../api/usageClient.js', () => ({
  UsageClient: class MockUsageClient {
    fetchCostReport = fetchCostReport;
  },
  computePeriodCosts: () => ({ monthly: 1.25, weekly: 0.5, daily: 0.1 }),
  currentBillingPeriod: () => ({
    startingAt: '2024-06-01T00:00:00.000Z',
    endingAt: '2024-06-15T12:00:00.000Z',
  }),
}));

vi.mock('../../store/db.js', () => ({
  getDailyTokenTotals: () => [
    { day: '2024-06-15', totalTokens: 123, byModel: {} },
  ],
  getLatestSnapshot: () => ({ recordedAt: '2024-06-15T11:59:00.000Z' }),
  getAlertHistory: () => [],
}));

import { StatusApp } from '../status.js';

const config: Config = {
  mode: 'admin',
  workspaceId: '',
  spendLimitUSD: 10,
  weeklySpendLimitUsd: null,
  weeklyTokenLimit: null,
  pollIntervalMinutes: 5,
  desktop: false,
  notifyOnEveryPrompt: false,
  thresholds: [],
  email: null,
  anthropicAdminKey: 'sk-ant-test',
  emailPassword: null,
};

describe('StatusApp', () => {
  it('renders the real Ink status view and exits after data loads', async () => {
    fetchCostReport.mockResolvedValueOnce([]);
    const stdout = new PassThrough() as PassThrough & { columns: number; isTTY: boolean };
    stdout.columns = 100;
    stdout.isTTY = true;
    let rendered = '';
    stdout.on('data', chunk => { rendered += String(chunk); });

    const instance = render(createElement(StatusApp, { config }), {
      stdout,
      debug: true,
      exitOnCtrlC: false,
    });
    await instance.waitUntilExit();

    expect(rendered).toContain('ClaudeWatch');
    expect(rendered).toContain('Monthly');
    expect(rendered).toContain('$1.2500');
    expect(rendered).toContain('Token usage');
    expect(rendered).toContain('Recent alerts');
  });
});

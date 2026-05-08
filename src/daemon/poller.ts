import { AnthropicAdminClient } from '../api/client.js';
import { currentBillingPeriod } from '../api/usageClient.js';
import { insertUsageRecords, insertCostRecords, getTotalCostSince } from '../store/usage.js';
import { setCostCache } from './costCache.js';
import { evaluateThresholds } from '../alerts/threshold.js';
import { sendDesktopAlert } from '../alerts/desktop.js';
import { sendEmailAlert } from '../alerts/email.js';
import type { AlertPayload } from '../alerts/types.js';
import type { Config } from '../config/schema.js';

export class UsagePoller {
  private readonly client: AnthropicAdminClient;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
    this.client = new AnthropicAdminClient(config.anthropicAdminKey);
  }

  async poll(): Promise<void> {
    const now = new Date();
    const endTime = now.toISOString();
    // Look back 2× the poll interval to cover the ~5 min API data delay
    const lookbackMs = this.config.pollIntervalMinutes * 2 * 60 * 1000;
    const startTime = new Date(now.getTime() - lookbackMs).toISOString();

    await this.fetchAllUsage(startTime, endTime);
    await this.fetchAllCosts(startTime, endTime);
    this.refreshCostCache(now);
    await this.dispatchAlerts();
  }

  private refreshCostCache(now: Date): void {
    const period = currentBillingPeriod();
    const dayStart = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    )).toISOString();
    const weekStart = new Date(now);
    weekStart.setUTCDate(weekStart.getUTCDate() - 7);
    weekStart.setUTCHours(0, 0, 0, 0);

    setCostCache({
      monthly:            getTotalCostSince(period.startingAt),
      weekly:             getTotalCostSince(weekStart.toISOString()),
      daily:              getTotalCostSince(dayStart),
      updatedAt:          now.toISOString(),
      billingPeriodStart: period.startingAt,
      billingPeriodEnd:   period.endingAt,
    });
  }

  private async fetchAllUsage(startTime: string, endTime: string): Promise<void> {
    let page: string | undefined;
    do {
      const resp = await this.client.fetchUsageReport({ startTime, endTime, page });
      insertUsageRecords(startTime, endTime, resp.data);
      page = resp.has_more ? resp.next_page : undefined;
    } while (page !== undefined);
  }

  private async fetchAllCosts(startTime: string, endTime: string): Promise<void> {
    let page: string | undefined;
    do {
      const resp = await this.client.fetchCostReport({ startTime, endTime, page });
      insertCostRecords(startTime, endTime, resp.data);
      page = resp.has_more ? resp.next_page : undefined;
    } while (page !== undefined);
  }

  private async dispatchAlerts(): Promise<void> {
    const triggered = evaluateThresholds(this.config.thresholds);
    for (const { threshold, actualUsd } of triggered) {
      const payload: AlertPayload = {
        threshold,
        currentPct: (actualUsd / threshold.amountUsd) * 100,
        estimatedCost: actualUsd,
        billingPeriod: currentBillingPeriod(),
      };

      if (threshold.notifyDesktop && this.config.desktop) {
        sendDesktopAlert(payload);
      }
      if (threshold.notifyEmail && this.config.email !== null && this.config.emailPassword !== null) {
        await sendEmailAlert(this.config.email, this.config.emailPassword, payload);
      }
    }
  }
}

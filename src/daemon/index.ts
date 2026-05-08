import { fileURLToPath } from 'url';
import type { Server } from 'http';
import cron, { type ScheduledTask } from 'node-cron';
import { loadConfig } from '../config/manager.js';
import {
  closeDb, insertSnapshot, insertPersonalTokens, getPersonalPeriodTokens,
  getWeeklySpend, getWeeklyTokens, hasAlertFired, recordAlert,
} from '../store/db.js';
import { UsageClient, computePeriodCosts, currentBillingPeriod, totalCostUSD } from '../api/usageClient.js';
import { PersonalUsageClient, estimateTokenCost } from '../api/personalClient.js';
import { evaluateThresholdsWithCosts, periodStart } from '../alerts/threshold.js';
import { sendDesktopAlert } from '../alerts/desktop.js';
import { sendEmailAlert } from '../alerts/email.js';
import type { AlertPayload } from '../alerts/types.js';
import type { Config, SpendThreshold } from '../config/schema.js';
import { setCostCache } from './costCache.js';
import { startWebServer } from './server.js';

// ---------------------------------------------------------------------------
// Single poll tick
// ---------------------------------------------------------------------------

async function runTick(config: Config, client: UsageClient): Promise<void> {
  const [usageBuckets, costBuckets] = await Promise.all([
    client.fetchUsageByModel(),
    client.fetchCostReport(),
  ]);

  if (usageBuckets.length === 0) {
    console.warn('[ClaudeWatch] API returned 0 usage buckets — no data to store');
  } else {
    const now = new Date().toISOString();
    for (const bucket of usageBuckets) {
      for (const r of bucket.results) {
        insertSnapshot({
          recordedAt:          now,
          bucketStartingAt:    bucket.starting_at,
          bucketEndingAt:      bucket.ending_at,
          model:               r.model ?? undefined,
          workspaceId:         r.workspace_id ?? undefined,
          uncachedInputTokens: r.uncached_input_tokens,
          outputTokens:        r.output_tokens,
          cacheReadTokens:     r.cache_read_input_tokens,
          cacheWrite1hTokens:  r.cache_creation.ephemeral_1h_input_tokens,
          cacheWrite5mTokens:  r.cache_creation.ephemeral_5m_input_tokens,
        });
      }
    }
  }

  const totalUsd = totalCostUSD(costBuckets);
  const periodCosts = computePeriodCosts(costBuckets);
  const period = currentBillingPeriod();

  setCostCache({
    monthly: periodCosts.monthly,
    weekly:  periodCosts.weekly,
    daily:   periodCosts.daily,
    updatedAt: new Date().toISOString(),
    billingPeriodStart: period.startingAt,
    billingPeriodEnd:   period.endingAt,
  });

  if (config.spendLimitUSD !== null) {
    const pct = ((totalUsd / config.spendLimitUSD) * 100).toFixed(1);
    console.log(
      `[ClaudeWatch] $${totalUsd.toFixed(4)} / $${config.spendLimitUSD} (${pct}%)`,
    );
  } else {
    console.log(`[ClaudeWatch] $${totalUsd.toFixed(4)} this billing period`);
  }

  if (config.thresholds.length === 0) return;

  const triggered = evaluateThresholdsWithCosts(config.thresholds, periodCosts);

  for (const { threshold: t, actualUsd } of triggered) {
    const payload: AlertPayload = {
      threshold: t,
      currentPct: (actualUsd / t.amountUsd) * 100,
      estimatedCost: actualUsd,
      billingPeriod: period,
    };

    if (t.notifyDesktop && config.desktop) {
      sendDesktopAlert(payload);
    }

    if (t.notifyEmail && config.email && config.emailPassword) {
      await sendEmailAlert(config.email, config.emailPassword, payload).catch(
        (err: unknown) => console.error('[email error]', err),
      );
    }

    console.log(
      `[ClaudeWatch] ALERT: $${actualUsd.toFixed(4)} spent — ` +
      `${payload.currentPct.toFixed(1)}% of $${t.amountUsd} ${t.period} threshold`,
    );
  }

  // Weekly spend limit checks (fires at 80% and 100% of weeklySpendLimitUsd)
  if (config.weeklySpendLimitUsd) {
    const weeklySpend = getWeeklySpend();
    const weeklyPct = (weeklySpend / config.weeklySpendLimitUsd) * 100;
    const weekStart = periodStart('weekly');

    for (const pctLevel of [80, 100] as const) {
      if (weeklyPct < pctLevel) continue;
      const limitAtPct = config.weeklySpendLimitUsd * pctLevel / 100;
      if (hasAlertFired(limitAtPct, 'weekly', weekStart)) continue;

      const syntheticThreshold: SpendThreshold = {
        amountUsd: limitAtPct,
        period: 'weekly',
        notifyEmail: !!(config.email && config.emailPassword),
        notifyDesktop: config.desktop,
      };
      const payload: AlertPayload = {
        threshold: syntheticThreshold,
        currentPct: weeklyPct,
        estimatedCost: weeklySpend,
        billingPeriod: period,
      };
      const channels: string[] = [];
      if (syntheticThreshold.notifyDesktop) {
        channels.push('desktop');
        sendDesktopAlert(payload);
      }
      if (syntheticThreshold.notifyEmail && config.email && config.emailPassword) {
        channels.push('email');
        await sendEmailAlert(config.email, config.emailPassword, payload).catch(
          (err: unknown) => console.error('[email error]', err),
        );
      }
      recordAlert(limitAtPct, 'weekly', weeklySpend, channels);
      console.log(
        `[ClaudeWatch] WEEKLY LIMIT: $${weeklySpend.toFixed(4)} — ` +
        `${weeklyPct.toFixed(1)}% of $${config.weeklySpendLimitUsd} weekly limit`,
      );
    }
  }

  // Weekly token limit checks (fires at 80% and 100% of weeklyTokenLimit)
  if (config.weeklyTokenLimit) {
    const weeklyTokens = getWeeklyTokens();
    const weeklyTokenPct = (weeklyTokens / config.weeklyTokenLimit) * 100;
    const weekStart = periodStart('weekly');

    for (const pctLevel of [80, 100] as const) {
      if (weeklyTokenPct < pctLevel) continue;
      // Store token threshold as a scaled value to avoid collision with USD keys
      const tokenKey = config.weeklyTokenLimit * pctLevel / 100;
      if (hasAlertFired(tokenKey, 'weekly-tokens', weekStart)) continue;

      recordAlert(tokenKey, 'weekly-tokens', weeklyTokens, ['desktop']);
      if (config.desktop) {
        const syntheticThreshold: SpendThreshold = {
          amountUsd: tokenKey,
          period: 'weekly',
          notifyEmail: false,
          notifyDesktop: true,
        };
        sendDesktopAlert({
          threshold: syntheticThreshold,
          currentPct: weeklyTokenPct,
          estimatedCost: 0,
          billingPeriod: period,
        });
      }
      console.log(
        `[ClaudeWatch] WEEKLY TOKEN LIMIT: ${weeklyTokens.toLocaleString()} / ` +
        `${config.weeklyTokenLimit.toLocaleString()} tokens (${weeklyTokenPct.toFixed(1)}%)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Personal mode tick
// ---------------------------------------------------------------------------

async function runPersonalTick(config: Config, client: PersonalUsageClient): Promise<void> {
  const sample = await client.sampleUsage();
  insertPersonalTokens(sample);

  const now = new Date();

  insertSnapshot({
    recordedAt:          now.toISOString(),
    bucketStartingAt:    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    bucketEndingAt:      now.toISOString(),
    model:               sample.model,
    workspaceId:         config.workspaceId || null,
    uncachedInputTokens: sample.inputTokens,
    outputTokens:        sample.outputTokens,
    cacheReadTokens:     sample.cacheReadTokens,
    cacheWrite1hTokens:  sample.cacheWriteTokens,
    cacheWrite5mTokens:  0,
  });

  const dayStart = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  )).toISOString();

  const weekAnchor = new Date(now);
  weekAnchor.setUTCDate(weekAnchor.getUTCDate() - weekAnchor.getUTCDay());
  weekAnchor.setUTCHours(0, 0, 0, 0);
  const weekStart = weekAnchor.toISOString();

  const monthStart = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), 1,
  )).toISOString();

  const periodCosts = {
    daily:   estimateTokenCost(getPersonalPeriodTokens(dayStart)),
    weekly:  estimateTokenCost(getPersonalPeriodTokens(weekStart)),
    monthly: estimateTokenCost(getPersonalPeriodTokens(monthStart)),
  };

  const period = currentBillingPeriod();

  setCostCache({
    monthly: periodCosts.monthly,
    weekly:  periodCosts.weekly,
    daily:   periodCosts.daily,
    updatedAt: now.toISOString(),
    billingPeriodStart: period.startingAt,
    billingPeriodEnd:   period.endingAt,
  });

  const monthlyTokens = getPersonalPeriodTokens(monthStart);
  const totalTokens = monthlyTokens.inputTokens + monthlyTokens.outputTokens;
  console.log(
    `[ClaudeWatch/personal] session tokens this month: ${totalTokens} ` +
    `(~$${periodCosts.monthly.toFixed(6)})`,
  );

  if (config.thresholds.length === 0) return;

  const triggered = evaluateThresholdsWithCosts(config.thresholds, periodCosts);

  for (const { threshold: t, actualUsd } of triggered) {
    const payload: AlertPayload = {
      threshold: t,
      currentPct: (actualUsd / t.amountUsd) * 100,
      estimatedCost: actualUsd,
      billingPeriod: period,
    };

    if (t.notifyDesktop && config.desktop) {
      sendDesktopAlert(payload);
    }

    if (t.notifyEmail && config.email && config.emailPassword) {
      await sendEmailAlert(config.email, config.emailPassword, payload).catch(
        (err: unknown) => console.error('[email error]', err),
      );
    }

    console.log(
      `[ClaudeWatch] ALERT: $${actualUsd.toFixed(6)} spent — ` +
      `${payload.currentPct.toFixed(1)}% of $${t.amountUsd} ${t.period} threshold`,
    );
  }
}

// ---------------------------------------------------------------------------
// One-shot tick (for `claudewatch poll`)
// ---------------------------------------------------------------------------

export async function runOnce(): Promise<void> {
  const config = await loadConfig();
  if (config.mode === 'personal') {
    const client = new PersonalUsageClient(config.anthropicAdminKey);
    await runPersonalTick(config, client);
  } else {
    const client = new UsageClient(config.anthropicAdminKey);
    await runTick(config, client);
  }
}

// ---------------------------------------------------------------------------
// Daemon entry
// ---------------------------------------------------------------------------

export async function startDaemon(): Promise<void> {
  const config = await loadConfig();

  const safeInterval = Math.min(59, Math.max(1, Math.round(config.pollIntervalMinutes)));
  console.log(
    `[ClaudeWatch] daemon started — polling every ${safeInterval} min (mode: ${config.mode})`,
  );

  const webServer: Server = startWebServer(config);

  let tick: () => Promise<void>;
  if (config.mode === 'personal') {
    const client = new PersonalUsageClient(config.anthropicAdminKey);
    tick = () => runPersonalTick(config, client);
  } else {
    const client = new UsageClient(config.anthropicAdminKey);
    tick = () => runTick(config, client);
  }

  await tick().catch((err: unknown) => console.error('[poll error]', err));

  const task: ScheduledTask = cron.schedule(`*/${safeInterval} * * * *`, () => {
    void tick().catch((err: unknown) => console.error('[poll error]', err));
  });

  const shutdown = (): void => {
    console.log('\n[ClaudeWatch] shutting down');
    task.stop();
    webServer.close();
    closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startDaemon().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // Exit 0 when unconfigured so launchd/systemd Restart=on-failure doesn't loop.
    // The PathState/ConditionPathExists guards in the service files also prevent
    // starting without config, but the exit code is the safety net on Linux.
    if (msg.startsWith('Not configured')) {
      console.error('[daemon] Run `claudewatch setup` to configure, then `claudewatch start`.');
      process.exit(0);
    }
    console.error('[daemon fatal]', msg);
    process.exit(1);
  });
}

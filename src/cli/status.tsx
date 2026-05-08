import { useState, useEffect } from 'react';
import { Box, Text, useApp, render } from 'ink';
import { UsageClient, computePeriodCosts, currentBillingPeriod } from '../api/usageClient.js';
import {
  getDailyTokenTotals,
  getLatestSnapshot,
  getAlertHistory,
  type DailyTokenTotal,
  type AlertRecord,
} from '../store/db.js';
import type { Config } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface StatusData {
  monthly: number;
  weekly: number;
  daily: number;
  spendLimitUsd: number | null;
  lastPollAt: string | null;
  dailyTokens: DailyTokenTotal[];
  recentAlerts: AlertRecord[];
  billingPeriod: { startingAt: string; endingAt: string };
}

async function fetchStatusData(config: Config): Promise<StatusData> {
  const client = new UsageClient(config.anthropicAdminKey);
  const period = currentBillingPeriod();

  const [costBuckets, lastSnap, alerts, dailyTokens] = await Promise.all([
    client.fetchCostReport({ startingAt: new Date(period.startingAt) }),
    Promise.resolve(getLatestSnapshot()),
    Promise.resolve(getAlertHistory(5)),
    Promise.resolve(getDailyTokenTotals(30)),
  ]);

  const costs = computePeriodCosts(costBuckets);

  return {
    monthly: costs.monthly,
    weekly: costs.weekly,
    daily: costs.daily,
    spendLimitUsd: config.spendLimitUSD,
    lastPollAt: lastSnap?.recordedAt ?? null,
    dailyTokens,
    recentAlerts: alerts,
    billingPeriod: period,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const BLOCKS = '▁▂▃▄▅▆▇█';

function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 1);
  return values
    .map(v => BLOCKS[Math.min(7, Math.floor((v / max) * 8))])
    .join('');
}

function progressBar(value: number, max: number, width = 22): string {
  const pct = Math.min(value / max, 1);
  const filled = Math.round(pct * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatAge(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

function fmtUtcDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function fmtDay(yyyymmdd: string): string {
  return new Date(`${yyyymmdd}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SpendRow({ label, value, limit }: {
  label: string;
  value: number;
  limit?: number | null;
}) {
  return (
    <Box>
      <Text>  </Text>
      <Text dimColor>{label.padEnd(9)}</Text>
      <Text color="yellow">${value.toFixed(4)}</Text>
      {limit != null && (
        <>
          <Text dimColor> / ${limit.toFixed(2)}  </Text>
          <Text color={value / limit > 0.8 ? 'red' : 'green'}>
            {progressBar(value, limit)}
          </Text>
          <Text dimColor>  {((value / limit) * 100).toFixed(1)}%</Text>
        </>
      )}
    </Box>
  );
}

function Sparkline({ tokens }: { tokens: DailyTokenTotal[] }) {
  if (tokens.length === 0) {
    return <Text dimColor>  no token data yet — is the daemon running?</Text>;
  }

  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  const line = sparkline(tokens.map(d => d.totalTokens));
  const dateRange = `${fmtDay(first.day)} – ${fmtDay(last.day)}`;

  return (
    <Box flexDirection="column">
      <Box>
        <Text>  </Text>
        <Text color="green">{line}</Text>
        <Text dimColor>  {dateRange}</Text>
      </Box>
    </Box>
  );
}

function AlertList({ alerts }: { alerts: AlertRecord[] }) {
  if (alerts.length === 0) {
    return <Text dimColor>  none</Text>;
  }
  return (
    <>
      {alerts.map(a => (
        <Box key={a.id}>
          <Text dimColor>  </Text>
          <Text color="red">${a.actualUsd.toFixed(2)}</Text>
          <Text dimColor>  {a.period} &gt; ${a.thresholdUsd}  ·  {formatAge(a.firedAt)}</Text>
        </Box>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

function StatusApp({ config }: { config: Config }) {
  const { exit } = useApp();
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStatusData(config)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (data !== null || error !== null) exit();
  }, [data, error, exit]);

  if (error) {
    return (
      <Box paddingX={2} paddingY={1}>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (!data) {
    return (
      <Box paddingX={2} paddingY={1}>
        <Text dimColor>Fetching data…</Text>
      </Box>
    );
  }

  const periodLabel =
    `${fmtUtcDate(data.billingPeriod.startingAt)} – ${fmtUtcDate(data.billingPeriod.endingAt)}`;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>

      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">ClaudeWatch</Text>
        <Text dimColor>   billing period: {periodLabel}</Text>
      </Box>

      {/* Spend */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Spend</Text>
        <SpendRow label="Monthly" value={data.monthly} limit={data.spendLimitUsd} />
        <SpendRow label="Weekly"  value={data.weekly} />
        <SpendRow label="Daily"   value={data.daily} />
      </Box>

      {/* Token sparkline */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Token usage — last {data.dailyTokens.length || 30} days</Text>
        <Sparkline tokens={data.dailyTokens} />
      </Box>

      {/* Last poll */}
      <Box marginBottom={1}>
        <Text bold>Last poll  </Text>
        {data.lastPollAt ? (
          <Box>
            <Text color="green">{formatAge(data.lastPollAt)}</Text>
            <Text dimColor>   {data.lastPollAt}</Text>
          </Box>
        ) : (
          <Text dimColor>no data — is the daemon running?  claudewatch start</Text>
        )}
      </Box>

      {/* Recent alerts */}
      <Box flexDirection="column">
        <Text bold>Recent alerts</Text>
        <AlertList alerts={data.recentAlerts} />
      </Box>

    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry-point called by CLI
// ---------------------------------------------------------------------------

export async function runStatus(config: Config): Promise<void> {
  const { waitUntilExit } = render(<StatusApp config={config} />);
  await waitUntilExit();
}

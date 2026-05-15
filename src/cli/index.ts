import { spawnSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { VERSION } from '../version.js';
import Database from 'better-sqlite3';
import { installDaemon, uninstallDaemon } from './commands/install.js';
import { configExists, loadConfig, saveConfigFile, getConfigFilePath } from '../config/manager.js';
import { runSetupWizard } from '../config/index.js';
import { getDbPath, getLatestSnapshot, getLatestPersonalTokens } from '../store/db.js';
import { startDaemonProcess, stopDaemonProcess, writeDaemonPid, clearDaemonPid } from './daemon-ctrl.js';
import { runStatus } from './status.js';
import type { Period } from '../config/schema.js';
import { PERIODS, KEYTAR_SERVICE, API_KEY_ACCOUNT } from '../config/schema.js';

const program = new Command();

program
  .name('claudewatch')
  .description('Monitor Anthropic API token usage and spend')
  .version(VERSION);

// ---------------------------------------------------------------------------
// setup — interactive first-run wizard
// ---------------------------------------------------------------------------

program
  .command('setup')
  .description('Run the interactive first-run setup wizard')
  .option('--reset', 'Overwrite existing config')
  .action(async (opts: { reset?: boolean }) => {
    await runSetupWizard(opts.reset ?? false).catch(exit1);
  });

// ---------------------------------------------------------------------------
// start — launch daemon in background (or foreground with --foreground)
// ---------------------------------------------------------------------------

program
  .command('start')
  .description('Start the daemon in the background')
  .option('--foreground', 'Run daemon in foreground (no detach)')
  .action(async (opts: { foreground?: boolean }) => {
    guardConfigured();
    if (opts.foreground) {
      writeDaemonPid(process.pid);
      try {
        const { startDaemon } = await import('../daemon/index.js');
        await startDaemon();
      } finally {
        clearDaemonPid();
      }
    } else {
      try {
        const pid = startDaemonProcess();
        console.log(`Daemon started (PID ${pid})`);
        console.log(`Logs: ${path.join(process.env['HOME'] ?? '~', '.claudewatch', 'daemon.log')}`);
        console.log('Tip: Run `claudewatch install` to persist the daemon across terminal sessions');
      } catch (err) {
        exit1(err);
      }
    }
  });

// ---------------------------------------------------------------------------
// stop — terminate background daemon
// ---------------------------------------------------------------------------

program
  .command('stop')
  .description('Stop the background daemon')
  .action(() => {
    const stopped = stopDaemonProcess();
    if (stopped) {
      console.log('Daemon stopped.');
    } else {
      console.log('No daemon is running.');
    }
  });

// ---------------------------------------------------------------------------
// status — rich ink TUI
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('Show current spend, daily sparkline, and active alerts')
  .action(async () => {
    guardConfigured();
    const config = await loadConfig().catch(exit1);
    await runStatus(config).catch(exit1);
  });

// ---------------------------------------------------------------------------
// health — daemon + DB diagnostics
// ---------------------------------------------------------------------------

program
  .command('health')
  .description('Show daemon status, last poll time, and file paths')
  .action(async () => {
    guardConfigured();

    const dbPath = getDbPath();
    const cfgPath = getConfigFilePath();
    const logPath = path.join(os.homedir(), '.claudewatch', 'daemon.log');
    const w = 14;
    const pad = (s: string) => s.padEnd(w);

    // 1. Check launchd as source of truth for daemon status
    let daemonStatus = 'stopped';
    let daemonPid: string | null = null;
    try {
      const launchctlOut = execSync(
        'launchctl list com.claudewatch.daemon 2>/dev/null',
      ).toString().trim();

      const pidMatch = launchctlOut.match(/"PID"\s*=\s*(\d+)/);
      if (pidMatch) {
        daemonPid = pidMatch[1]!;
        daemonStatus = 'running';
      } else if (launchctlOut.includes('com.claudewatch.daemon')) {
        // Registered in launchd but not currently running (likely crashed)
        daemonStatus = 'registered (not running — check logs)';
      }
    } catch {
      daemonStatus = 'not installed (run: claudewatch install)';
    }

    // 2. Last poll and next poll from DB + config
    let lastPoll = 'no data yet';
    let nextPoll = '—';
    let tokenSummary = '—';
    let cfg: Awaited<ReturnType<typeof loadConfig>> | undefined;
    try { cfg = await loadConfig(); } catch { /* config unreadable */ }

    const isPersonal = cfg?.mode === 'personal';
    const lastSnap = isPersonal ? null : getLatestSnapshot();
    const lastPersonal = isPersonal ? getLatestPersonalTokens() : null;
    const lastPollTime = lastSnap?.recordedAt ?? lastPersonal?.recordedAt ?? null;

    if (lastPollTime) {
      const pollDate = new Date(lastPollTime);
      const ageMins = Math.floor((Date.now() - pollDate.getTime()) / 60_000);
      const age = ageMins < 1 ? 'just now'
        : ageMins < 60 ? `${ageMins}m ago`
        : `${Math.floor(ageMins / 60)}h ago`;
      lastPoll = `${pollDate.toLocaleTimeString()} (${age})`;

      if (cfg) {
        const nextDate = new Date(pollDate.getTime() + cfg.pollIntervalMinutes * 60_000);
        nextPoll = nextDate > new Date()
          ? `${nextDate.toLocaleTimeString()} (in ${Math.ceil((nextDate.getTime() - Date.now()) / 60_000)}m)`
          : 'overdue';
      }

      if (lastSnap) {
        tokenSummary = [
          `input: ${lastSnap.uncachedInputTokens.toLocaleString()}`,
          `output: ${lastSnap.outputTokens.toLocaleString()}`,
          `cache_read: ${lastSnap.cacheReadTokens.toLocaleString()}`,
        ].join('  ·  ');
      } else if (lastPersonal) {
        tokenSummary = [
          `input: ${lastPersonal.inputTokens.toLocaleString()}`,
          `output: ${lastPersonal.outputTokens.toLocaleString()}`,
          `cache_read: ${lastPersonal.cacheReadTokens.toLocaleString()}`,
          `(personal mode — probe call tokens)`,
        ].join('  ·  ');
      }
    }

    // 3. Scan recent log lines for errors
    let recentErrors = 'none';
    try {
      const logs = execSync(`tail -20 "${logPath}" 2>/dev/null`).toString();
      const errorLines = logs.split('\n')
        .filter(l => l.includes('"level":50') || l.includes('ERROR') || l.includes('error'))
        .slice(-3)
        .map(l => {
          try { return '  ' + (JSON.parse(l) as { msg: string }).msg; } catch { return '  ' + l; }
        });
      recentErrors = errorLines.length > 0 ? '\n' + errorLines.join('\n') : 'none';
    } catch { /* log file may not exist yet */ }

    // 4. DB size
    let dbSize = 'not found';
    try {
      const bytes = fs.statSync(dbPath).size;
      dbSize = `${(bytes / 1024).toFixed(1)} KB`;
    } catch { /* db not yet created */ }

    // 5. Print health report
    console.log('');
    console.log('ClaudeWatch Health');
    console.log('─'.repeat(48));
    console.log(`${pad('Daemon')}${daemonStatus === 'running' ? `● running  (PID ${daemonPid})` : `○ ${daemonStatus}`}`);
    console.log(`${pad('Last poll')}${lastPoll}`);
    console.log(`${pad('Next poll')}${nextPoll}`);
    console.log(`${pad('Tokens')}${tokenSummary}`);
    console.log(`${pad('Errors')}${recentErrors}`);
    console.log(`${pad('DB')}${dbPath}  (${dbSize})`);
    console.log(`${pad('Config')}${cfgPath}`);
    console.log(`${pad('Logs')}${logPath}`);
    console.log(`${pad('Launchd')}${daemonStatus === 'running' ? '✓ installed and running' : '✗ not running'}`);
    console.log('');

    // 6. Actionable hint when daemon is up but no data has been recorded yet
    if (daemonStatus === 'running' && lastPollTime === null) {
      console.log(
        '⚠ Daemon is running but has not polled yet.\n' +
        '  Check logs: claudewatch logs -f\n' +
        '  Force a poll: claudewatch poll --now',
      );
    }
  });

// ---------------------------------------------------------------------------
// config — open config file in $EDITOR
// ---------------------------------------------------------------------------

program
  .command('config')
  .description('Open the config file in $EDITOR')
  .action(() => {
    guardConfigured();
    const cfgPath = getConfigFilePath();
    const editorEnv = process.env['EDITOR'] ?? process.env['VISUAL'] ?? 'nano';
    const parts = editorEnv.split(' ');
    const editor = parts[0]!;
    const editorArgs = [...parts.slice(1), cfgPath];

    const result = spawnSync(editor, editorArgs, { stdio: 'inherit' });
    if (result.error) {
      exit1(new Error(`Could not open editor '${editor}': ${result.error.message}`));
    }
  });

// ---------------------------------------------------------------------------
// threshold — manage spend threshold alerts
// ---------------------------------------------------------------------------

program
  .command('threshold <action>')
  .description('Manage spend threshold alerts (add | list | remove)')
  .option('--amount <usd>', 'Threshold amount in USD', parseFloat)
  .option('--period <period>', 'Period: daily | weekly | monthly')
  .option('--email', 'Notify via email', false)
  .option('--no-desktop', 'Disable desktop notification')
  .option('--index <n>', 'Index of threshold to remove', parseInt)
  .action(async (
    action: string,
    opts: { amount?: number; period?: string; email: boolean; desktop: boolean; index?: number },
  ) => {
    guardConfigured();
    const config = await loadConfig().catch(exit1);

    switch (action) {
      case 'list':
        if (config.thresholds.length === 0) {
          console.log('No thresholds configured.');
        } else {
          config.thresholds.forEach((t, i) =>
            console.log(
              `[${i}] $${t.amountUsd.toFixed(2)} ${t.period}` +
              `  email:${t.notifyEmail}  desktop:${t.notifyDesktop}`,
            ),
          );
        }
        break;

      case 'add': {
        if (opts.amount === undefined || !opts.period) {
          console.error('--amount and --period are required for add');
          process.exit(1);
        }
        if (!(PERIODS as string[]).includes(opts.period)) {
          console.error('--period must be daily, weekly, or monthly');
          process.exit(1);
        }
        config.thresholds.push({
          amountUsd: opts.amount,
          period: opts.period as Period,
          notifyEmail: opts.email,
          notifyDesktop: opts.desktop,
        });
        saveConfigFile(configFileFrom(config));
        console.log(`Added: $${opts.amount} ${opts.period}`);
        break;
      }

      case 'remove': {
        const idx = opts.index;
        if (idx === undefined || idx < 0 || idx >= config.thresholds.length) {
          console.error(`--index must be 0–${config.thresholds.length - 1}`);
          process.exit(1);
        }
        config.thresholds.splice(idx, 1);
        saveConfigFile(configFileFrom(config));
        console.log(`Threshold [${idx}] removed.`);
        break;
      }

      default:
        console.error(`Unknown action: ${action}. Use add | list | remove`);
        process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// poll — run a single tick immediately and print results
// ---------------------------------------------------------------------------

program
  .command('poll')
  .description('Trigger a single poll immediately and print results')
  .option('--now', 'Run immediately (default behaviour)')
  .action(async () => {
    guardConfigured();
    console.log('Running poll tick...');
    const config = await loadConfig().catch(exit1);
    const { runOnce } = await import('../daemon/index.js');
    await runOnce().catch(exit1);

    if (config.mode === 'personal') {
      const row = getLatestPersonalTokens();
      if (row) {
        console.log('\n✓ Sample saved (personal mode):');
        console.log(`  Recorded at: ${row.recordedAt}`);
        console.log(`  Model:       ${row.model}`);
        console.log(`  Input:       ${row.inputTokens.toLocaleString()} tokens`);
        console.log(`  Output:      ${row.outputTokens.toLocaleString()} tokens`);
        console.log(`  Cache read:  ${row.cacheReadTokens.toLocaleString()} tokens`);
      } else {
        console.error('✗ Poll ran but nothing was saved to DB.');
        console.error('  Run: claudewatch debug');
      }
    } else {
      const row = getLatestSnapshot();
      if (row) {
        console.log('\n✓ Snapshot saved:');
        console.log(`  Recorded at: ${row.recordedAt}`);
        console.log(`  Bucket:      ${row.bucketStartingAt} → ${row.bucketEndingAt}`);
        console.log(`  Model:       ${row.model ?? '—'}`);
        console.log(`  Input:       ${row.uncachedInputTokens.toLocaleString()} tokens`);
        console.log(`  Output:      ${row.outputTokens.toLocaleString()} tokens`);
        console.log(`  Cache read:  ${row.cacheReadTokens.toLocaleString()} tokens`);
      } else {
        console.error('✗ Poll ran but nothing was saved to DB.');
        console.error('  Run: claudewatch debug');
      }
    }
  });

// ---------------------------------------------------------------------------
// web — start the local web dashboard and open it in the browser
// ---------------------------------------------------------------------------

program
  .command('web')
  .description('Open the web dashboard at http://localhost:7734')
  .action(async () => {
    guardConfigured();
    const config = await loadConfig().catch(exit1);
    const { startWebServer } = await import('../daemon/server.js');
    const server = startWebServer(config);
    const { default: open } = await import('open');
    await open('http://localhost:7734');
    console.log('✓ Dashboard running at http://localhost:7734 (press Ctrl+C to stop)');
    const shutdown = (): void => { server.close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// ---------------------------------------------------------------------------
// daemon — run in foreground (useful for debugging / systemd)
// ---------------------------------------------------------------------------

program
  .command('daemon')
  .description('Run the polling daemon in the foreground')
  .action(async () => {
    const { startDaemon } = await import('../daemon/index.js');
    await startDaemon();
  });

// ---------------------------------------------------------------------------
// install — register as a launchd service (macOS)
// ---------------------------------------------------------------------------

program
  .command('install')
  .description('Install daemon as a launchd service (survives terminal close, macOS only)')
  .action(async () => {
    guardConfigured();
    await installDaemon().catch(exit1);
  });

// ---------------------------------------------------------------------------
// uninstall — remove the launchd service
// ---------------------------------------------------------------------------

program
  .command('uninstall')
  .description('Remove the launchd service')
  .action(async () => {
    await uninstallDaemon().catch(exit1);
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guardConfigured(): void {
  if (!configExists()) {
    console.error('Not configured. Run: claudewatch setup');
    process.exit(1);
  }
}

function exit1(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

/** Reconstruct a ConfigFile from the runtime Config (strips resolved secrets). */
function configFileFrom(config: ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never) {
  return {
    apiKeyRef: { service: KEYTAR_SERVICE, account: API_KEY_ACCOUNT },
    mode: config.mode,
    workspaceId: config.workspaceId,
    spendLimitUSD: config.spendLimitUSD,
    weeklySpendLimitUsd: config.weeklySpendLimitUsd,
    weeklyTokenLimit: config.weeklyTokenLimit,
    pollIntervalMinutes: config.pollIntervalMinutes,
    desktop: config.desktop,
    notifyOnEveryPrompt: config.notifyOnEveryPrompt,
    thresholds: config.thresholds,
    email: config.email,
  };
}

// ---------------------------------------------------------------------------
// debug — print raw DB contents for troubleshooting
// ---------------------------------------------------------------------------

program
  .command('debug')
  .description('Print raw DB contents for troubleshooting')
  .action(() => {
    const dbPath = path.join(os.homedir(), '.claudewatch', 'usage.db');
    const db = new Database(dbPath, { readonly: true });

    try {
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table'`,
      ).all() as { name: string }[];
      console.log('\nTables:', tables.map(t => t.name).join(', '));

      // usage_snapshots (admin mode)
      const schema = db.prepare(`PRAGMA table_info(usage_snapshots)`).all();
      console.log('\nusage_snapshots schema:');
      console.table(schema);

      const rows = db.prepare(
        `SELECT * FROM usage_snapshots ORDER BY rowid DESC LIMIT 3`,
      ).all();
      console.log('\nLatest 3 usage_snapshots rows:');
      console.log(JSON.stringify(rows, null, 2));

      const count = db.prepare(
        `SELECT COUNT(*) as cnt FROM usage_snapshots`,
      ).get() as { cnt: number };
      console.log(`Total usage_snapshots rows: ${count.cnt}`);

      // personal_session_tokens (personal mode)
      const hasPersonal = tables.some(t => t.name === 'personal_session_tokens');
      if (hasPersonal) {
        const personalSchema = db.prepare(`PRAGMA table_info(personal_session_tokens)`).all();
        console.log('\npersonal_session_tokens schema:');
        console.table(personalSchema);

        const personalRows = db.prepare(
          `SELECT * FROM personal_session_tokens ORDER BY rowid DESC LIMIT 5`,
        ).all();
        console.log('\nLatest 5 personal_session_tokens rows:');
        console.log(JSON.stringify(personalRows, null, 2));

        const personalCount = db.prepare(
          `SELECT COUNT(*) as cnt FROM personal_session_tokens`,
        ).get() as { cnt: number };
        console.log(`Total personal_session_tokens rows: ${personalCount.cnt}`);
      }

      const dbSize = fs.statSync(dbPath).size;
      console.log(`\nDB size: ${(dbSize / 1024).toFixed(1)} KB  (${dbPath})`);
    } finally {
      db.close();
    }
  });

program.parseAsync(process.argv).catch(exit1);

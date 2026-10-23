import { createHash } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from './config.js';
import { appendToLedgerFile } from './ledgerFile.js';
import { CollectorRunner } from './runner.js';
import type { CollectorHealth } from './types.js';

// Same directory as config/manager.ts; not imported from there so the server module stays free of the keychain dependency.
const getConfigDir = (): string => join(homedir(), '.claudewatch');

export const SCAN_INTERVAL_MS = 5 * 60_000;
export const settingsPath = (): string => join(getConfigDir(), 'collectors.json');
export const ledgerPath = (): string => join(getConfigDir(), 'ledger.jsonl');

// Same derivation as the daemon's device id: a hash of the hostname, never the hostname itself.
const devicePseudonym = (): string => createHash('sha256').update(hostname()).digest('hex').slice(0, 16);

let lastHealth: CollectorHealth[] = [];
export const getCollectorHealth = (): CollectorHealth[] => lastHealth;

/** Runs inside the local daemon (the Core). Settings are re-read each scan so enable/disable needs no restart. */
export function startCollectors(): () => void {
  const settings = loadSettings(settingsPath());
  const runner = new CollectorRunner({ home: homedir(), settings, accountAlias: 'default', devicePseudonym: devicePseudonym() });
  lastHealth = runner.health();
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      Object.assign(settings, loadSettings(settingsPath()));
      const { inputs, health } = await runner.scan();
      lastHealth = health;
      if (inputs.length) {
        const r = appendToLedgerFile(ledgerPath(), inputs, Date.now());
        console.log(`[ClaudeWatch] collectors: ${r.accepted} new, ${r.duplicates} duplicate, ${r.rejected} rejected`);
      }
    } catch (err) {
      console.warn('[collectors]', (err as Error).message);
    } finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), SCAN_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** One-shot dry scan for the CLI: reports what would be read without writing the ledger. */
export async function dryScan(): Promise<CollectorHealth[]> {
  const settings = loadSettings(settingsPath());
  const runner = new CollectorRunner({ home: homedir(), settings, accountAlias: 'default', devicePseudonym: devicePseudonym() });
  return (await runner.scan()).health;
}

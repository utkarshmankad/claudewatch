import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { COLLECTOR_IDS, type CollectorId } from './types.js';

export type CollectorSettings = Record<CollectorId, boolean>;

export const defaultSettings = (): CollectorSettings => ({ claude_code: false, codex: false, gemini_cli: false });

// Opt-in: a missing, unreadable or malformed file means every collector is off.
export function loadSettings(path: string): CollectorSettings {
  const out = defaultSettings();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { enabled?: Record<string, unknown> };
    for (const id of COLLECTOR_IDS) if (raw.enabled?.[id] === true) out[id] = true;
  } catch { /* off */ }
  return out;
}

export function saveSettings(path: string, s: CollectorSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ enabled: s }, null, 2) + '\n', { mode: 0o600 });
}

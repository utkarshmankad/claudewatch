#!/usr/bin/env node
/**
 * npm postinstall hook — installs the appropriate OS daemon service.
 *
 * Runs automatically after `npm install -g claudewatch`.
 * Skipped for local / development installs (no npm_config_global).
 * Never fails the overall npm install — all errors are warnings.
 *
 * Set CLAUDEWATCH_NO_POSTINSTALL=1 to opt out entirely.
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Guard: skip in contexts where daemon install makes no sense
// ---------------------------------------------------------------------------

const skip = (reason) => {
  console.log(`[claudewatch] Skipping daemon install: ${reason}`);
  process.exit(0);
};

// User opted out
if (process.env.CLAUDEWATCH_NO_POSTINSTALL) {
  skip('CLAUDEWATCH_NO_POSTINSTALL is set');
}

// CI environments — avoid touching the system in automated pipelines
if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) {
  skip('running in CI (set CLAUDEWATCH_NO_POSTINSTALL=0 to override)');
}

// Only install for global installs — local / workspace installs don't need a
// system-level daemon since the user runs the CLI directly from the project.
if (process.env.npm_config_global !== 'true') {
  skip('local install (only installs daemon for `npm install -g`)');
}

// Never install a user daemon as root — it would run under root's context
// rather than the real user's, breaking keychain / home-dir assumptions.
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  skip('running as root — install as the target user instead');
}

const platform = process.platform;
if (platform !== 'darwin' && platform !== 'linux') {
  skip(`unsupported platform '${platform}' (supported: darwin, linux)`);
}

// ---------------------------------------------------------------------------
// Resolve paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(__filename);
const pkgRoot    = path.dirname(scriptsDir);
const nodeBin    = process.execPath;
const cwBin      = path.join(pkgRoot, 'bin', 'claudewatch.js');

if (!fs.existsSync(cwBin)) {
  console.warn(`[claudewatch] Warning: entry-point not found at ${cwBin}`);
  console.warn('[claudewatch] Run the install script manually after building:');
  console.warn(`  bash ${path.join(scriptsDir, platform === 'darwin'
    ? 'install-daemon-macos.sh'
    : 'install-daemon-linux.sh')}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Dispatch to the platform-specific shell script
// ---------------------------------------------------------------------------

const scriptName = platform === 'darwin'
  ? 'install-daemon-macos.sh'
  : 'install-daemon-linux.sh';
const scriptPath = path.join(scriptsDir, scriptName);

const platformLabel = platform === 'darwin' ? 'launchd' : 'systemd';
console.log(`[claudewatch] Installing ${platformLabel} daemon service…`);
console.log(`[claudewatch]   node : ${nodeBin}`);
console.log(`[claudewatch]   bin  : ${cwBin}`);

const result = spawnSync('bash', [scriptPath, nodeBin, cwBin], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HOME: os.homedir(),
    USER: os.userInfo().username,
  },
});

// ---------------------------------------------------------------------------
// Outcome — never fail the npm install
// ---------------------------------------------------------------------------

if (result.error) {
  console.error(`\n[claudewatch] Daemon install failed: ${result.error.message}`);
} else if (result.status !== 0) {
  console.error(`\n[claudewatch] Daemon install script exited with code ${result.status}.`);
}

if (result.error || result.status !== 0) {
  console.error('[claudewatch] To install manually, run:');
  console.error(`  bash "${scriptPath}" "${nodeBin}" "${cwBin}"`);
}
// Always exit 0 — the daemon install is optional; the CLI is still usable.
process.exit(0);

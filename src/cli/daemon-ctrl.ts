import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = path.join(os.homedir(), '.claudewatch');
const PID_FILE = path.join(DATA_DIR, 'daemon.pid');
const LOG_FILE = path.join(DATA_DIR, 'daemon.log');

// ---------------------------------------------------------------------------
// PID helpers
// ---------------------------------------------------------------------------

export function readDaemonPid(): number | null {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeDaemonPid(pid: number): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid), 'utf-8');
}

export function clearDaemonPid(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

export type DaemonStatus =
  | { running: true; pid: number }
  | { running: false; pid: null };

export function getDaemonStatus(): DaemonStatus {
  const pid = readDaemonPid();
  if (pid === null) return { running: false, pid: null };

  try {
    process.kill(pid, 0); // signal 0 = existence check, throws if gone
    return { running: true, pid };
  } catch {
    clearDaemonPid(); // stale PID file
    return { running: false, pid: null };
  }
}

/**
 * Spawn a detached daemon process using the same Node executable and entry-point
 * script that launched this CLI. stdout/stderr are appended to `~/.claudewatch/daemon.log`.
 * Returns the new PID.
 */
export function startDaemonProcess(): number {
  const status = getDaemonStatus();
  if (status.running) {
    throw new Error(`Daemon is already running (PID ${status.pid})`);
  }

  const logFd = fs.openSync(LOG_FILE, 'a');

  const child = spawn(process.execPath, [process.argv[1]!, 'daemon'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('Daemon spawn failed — no PID assigned');
  }

  writeDaemonPid(pid);
  return pid;
}

/**
 * Send SIGTERM to the running daemon and remove the PID file.
 * Returns false if no daemon was running.
 */
export function stopDaemonProcess(): boolean {
  const pid = readDaemonPid();
  if (pid === null) return false;

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw err; // ESRCH = process already gone
  }

  clearDaemonPid();
  return true;
}

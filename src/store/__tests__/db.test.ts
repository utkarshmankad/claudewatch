import { describe, it, expect, beforeEach, afterEach, vi, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// vi.hoisted runs before imports — cannot reference module-level import bindings.
// Use a plain computed string instead of fs.mkdtempSync().
// db.ts calls fs.mkdirSync(DATA_DIR, { recursive: true }) inside getDb(), so
// the directory is created automatically when the DB is first opened.
const tmpHome = vi.hoisted(
  () => `/tmp/cw-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

vi.mock('os', async () => {
  const actual = await vi.importActual('os') as Record<string, unknown>;
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

import {
  getDb,
  closeDb,
  insertSnapshot,
  getLatestSnapshot,
  getSnapshotsForPeriod,
  hasAlertFired,
  recordAlert,
  getAlertHistory,
  getWeeklySpend,
  getWeeklyTokens,
  getDailyTokensByModel,
  getDailyTokenTotals,
  insertSessionTokens,
  getSessionTokens,
  insertPersonalTokens,
  getPersonalPeriodTokens,
} from '../db.js';

afterAll(() => {
  closeDb();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

function cleanDb(): void {
  closeDb();
  // Delete the DB file so each test starts with a fresh empty schema.
  const dbPath = path.join(tmpHome, '.claudewatch', 'usage.db');
  try { fs.unlinkSync(dbPath); } catch { /* file may not exist on first run */ }
}

beforeEach(cleanDb);
afterEach(cleanDb);

// ---------------------------------------------------------------------------
// getDb / schema migration
// ---------------------------------------------------------------------------

describe('getDb', () => {
  it('returns a Database instance and creates the schema', () => {
    const db = getDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('usage_snapshots');
    expect(names).toContain('alert_log');
    expect(names).toContain('cost_snapshots');
    expect(names).toContain('session_tokens');
    expect(names).toContain('personal_session_tokens');
  });

  it('returns the same instance on repeated calls', () => {
    expect(getDb()).toBe(getDb());
  });

  it('sets user_version to CURRENT_SCHEMA_VERSION (4)', () => {
    const version = getDb().pragma('user_version', { simple: true }) as number;
    expect(version).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// insertSnapshot / getLatestSnapshot
// ---------------------------------------------------------------------------

describe('insertSnapshot', () => {
  it('inserts a row and getLatestSnapshot returns it', () => {
    insertSnapshot({
      recordedAt: '2024-06-15T12:00:00.000Z',
      bucketStartingAt: '2024-06-15T00:00:00.000Z',
      bucketEndingAt: '2024-06-16T00:00:00.000Z',
      model: 'claude-3-sonnet',
      uncachedInputTokens: 100,
      outputTokens: 50,
    });

    const snap = getLatestSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.model).toBe('claude-3-sonnet');
    expect(snap!.uncachedInputTokens).toBe(100);
    expect(snap!.outputTokens).toBe(50);
  });

  it('returns null when the table is empty', () => {
    expect(getLatestSnapshot()).toBeNull();
  });

  it('applies defaults for omitted fields', () => {
    insertSnapshot({});
    const snap = getLatestSnapshot()!;
    expect(snap.model).toBeNull();
    expect(snap.uncachedInputTokens).toBe(0);
    expect(snap.outputTokens).toBe(0);
    expect(snap.cacheReadTokens).toBe(0);
    expect(snap.cacheWrite1hTokens).toBe(0);
    expect(snap.cacheWrite5mTokens).toBe(0);
  });

  it('returns the most recently inserted row', () => {
    insertSnapshot({ model: 'old', recordedAt: '2024-06-14T00:00:00.000Z' });
    insertSnapshot({ model: 'new', recordedAt: '2024-06-15T00:00:00.000Z' });
    expect(getLatestSnapshot()!.model).toBe('new');
  });

  it('stores all cache token tiers correctly', () => {
    insertSnapshot({
      cacheReadTokens: 10,
      cacheWrite1hTokens: 20,
      cacheWrite5mTokens: 30,
    });
    const snap = getLatestSnapshot()!;
    expect(snap.cacheReadTokens).toBe(10);
    expect(snap.cacheWrite1hTokens).toBe(20);
    expect(snap.cacheWrite5mTokens).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// getSnapshotsForPeriod
// ---------------------------------------------------------------------------

describe('getSnapshotsForPeriod', () => {
  it('returns rows within the requested window', () => {
    insertSnapshot({ bucketStartingAt: '2024-06-10T00:00:00.000Z', bucketEndingAt: '2024-06-11T00:00:00.000Z', model: 'in' });
    insertSnapshot({ bucketStartingAt: '2024-05-01T00:00:00.000Z', bucketEndingAt: '2024-05-02T00:00:00.000Z', model: 'out' });

    const rows = getSnapshotsForPeriod('2024-06-01T00:00:00.000Z', '2024-06-30T00:00:00.000Z');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe('in');
  });

  it('returns an empty array when nothing falls in the window', () => {
    insertSnapshot({ bucketStartingAt: '2024-06-15T00:00:00.000Z', bucketEndingAt: '2024-06-16T00:00:00.000Z' });
    const rows = getSnapshotsForPeriod('2024-07-01T00:00:00.000Z', '2024-07-31T00:00:00.000Z');
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// alert_log — hasAlertFired / recordAlert / getAlertHistory
// ---------------------------------------------------------------------------

describe('hasAlertFired', () => {
  it('returns false when no alert has been recorded', () => {
    expect(hasAlertFired(10, 'daily', '2024-06-15T00:00:00.000Z')).toBe(false);
  });

  it('returns true after recordAlert is called with matching args', () => {
    recordAlert(10, 'daily', 12, ['desktop']);
    expect(hasAlertFired(10, 'daily', '1970-01-01T00:00:00.000Z')).toBe(true);
  });

  it('returns false when since is in the future (alert is older)', () => {
    recordAlert(10, 'daily', 12, ['desktop']);
    expect(hasAlertFired(10, 'daily', '2099-01-01T00:00:00.000Z')).toBe(false);
  });

  it('distinguishes by thresholdUsd', () => {
    recordAlert(10, 'daily', 12, ['desktop']);
    expect(hasAlertFired(20, 'daily', '1970-01-01T00:00:00.000Z')).toBe(false);
  });

  it('distinguishes by period', () => {
    recordAlert(10, 'daily', 12, ['desktop']);
    expect(hasAlertFired(10, 'weekly', '1970-01-01T00:00:00.000Z')).toBe(false);
  });
});

describe('recordAlert', () => {
  it('inserts a row into alert_log', () => {
    recordAlert(50, 'monthly', 60, ['email', 'desktop']);
    const history = getAlertHistory(10);
    expect(history).toHaveLength(1);
    expect(history[0]!.thresholdUsd).toBe(50);
    expect(history[0]!.period).toBe('monthly');
    expect(history[0]!.actualUsd).toBe(60);
    expect(history[0]!.channels).toEqual(['email', 'desktop']);
  });

  it('parses channels back from JSON correctly', () => {
    recordAlert(1, 'daily', 2, []);
    expect(getAlertHistory(1)[0]!.channels).toEqual([]);
  });
});

describe('getAlertHistory', () => {
  it('returns rows newest-first', () => {
    // Insert with explicit fired_at values so order is deterministic.
    getDb().prepare(
      `INSERT INTO alert_log (fired_at, threshold_usd, period, actual_usd, channels)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('2024-06-14T00:00:00.000Z', 10, 'daily', 11, '["desktop"]');
    getDb().prepare(
      `INSERT INTO alert_log (fired_at, threshold_usd, period, actual_usd, channels)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('2024-06-15T00:00:00.000Z', 20, 'weekly', 22, '["email"]');

    const history = getAlertHistory(10);
    expect(history[0]!.thresholdUsd).toBe(20);
    expect(history[1]!.thresholdUsd).toBe(10);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) recordAlert(i, 'daily', i + 1, []);
    expect(getAlertHistory(3)).toHaveLength(3);
  });

  it('defaults limit to 50 and returns all rows when fewer exist', () => {
    recordAlert(1, 'daily', 2, []);
    expect(getAlertHistory()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getWeeklySpend — uses calendar week (Sunday anchor)
// ---------------------------------------------------------------------------

describe('getWeeklySpend', () => {
  const FIXED_NOW = new Date('2024-06-15T14:30:00.000Z'); // Saturday

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => vi.useRealTimers());

  it('returns 0 when cost_snapshots is empty', () => {
    expect(getWeeklySpend()).toBe(0);
  });

  it('includes a cost record from this calendar week (after Sunday Jun 9)', () => {
    getDb().prepare(
      `INSERT INTO cost_snapshots (recorded_at, start_time, end_time, workspace_id, amount_usd)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('2024-06-15T10:00:00.000Z', '2024-06-14T00:00:00Z', '2024-06-15T00:00:00Z', '', 5.0);

    expect(getWeeklySpend()).toBeCloseTo(5.0);
  });

  it('excludes a cost record from last week (before Sunday Jun 9)', () => {
    getDb().prepare(
      `INSERT INTO cost_snapshots (recorded_at, start_time, end_time, workspace_id, amount_usd)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('2024-06-08T10:00:00.000Z', '2024-06-07T00:00:00Z', '2024-06-08T00:00:00Z', '', 99.0);

    expect(getWeeklySpend()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getWeeklyTokens — uses calendar week (Sunday anchor)
// ---------------------------------------------------------------------------

describe('getWeeklyTokens', () => {
  const FIXED_NOW = new Date('2024-06-15T14:30:00.000Z'); // Saturday

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => vi.useRealTimers());

  it('returns 0 when usage_snapshots is empty', () => {
    expect(getWeeklyTokens()).toBe(0);
  });

  it('sums all token types from snapshots this calendar week', () => {
    insertSnapshot({
      bucketStartingAt: '2024-06-14T00:00:00.000Z',
      bucketEndingAt: '2024-06-15T00:00:00.000Z',
      uncachedInputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWrite1hTokens: 10,
      cacheWrite5mTokens: 5,
    });
    expect(getWeeklyTokens()).toBe(185); // 100+50+20+10+5
  });

  it('excludes snapshots from before Sunday (week boundary)', () => {
    insertSnapshot({
      bucketStartingAt: '2024-06-08T00:00:00.000Z', // Saturday last week
      bucketEndingAt: '2024-06-09T00:00:00.000Z',
      uncachedInputTokens: 9999,
    });
    expect(getWeeklyTokens()).toBe(0);
  });

  it('includes snapshots from Sunday itself (week start boundary)', () => {
    insertSnapshot({
      bucketStartingAt: '2024-06-09T00:00:00.000Z', // Sunday = week start
      bucketEndingAt: '2024-06-10T00:00:00.000Z',
      uncachedInputTokens: 42,
    });
    expect(getWeeklyTokens()).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// getDailyTokensByModel / getDailyTokenTotals
// ---------------------------------------------------------------------------

describe('getDailyTokensByModel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T23:59:59Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns an empty array when no snapshots exist', () => {
    expect(getDailyTokensByModel(30)).toEqual([]);
  });

  it('groups by day and model and sums token types', () => {
    insertSnapshot({
      bucketStartingAt: '2024-06-15T00:00:00.000Z',
      bucketEndingAt: '2024-06-16T00:00:00.000Z',
      model: 'sonnet',
      uncachedInputTokens: 100,
      outputTokens: 50,
    });
    insertSnapshot({
      bucketStartingAt: '2024-06-15T00:00:00.000Z',
      bucketEndingAt: '2024-06-16T00:00:00.000Z',
      model: 'opus',
      uncachedInputTokens: 200,
      outputTokens: 100,
    });

    const rows = getDailyTokensByModel(1);
    expect(rows.some(r => r.model === 'sonnet')).toBe(true);
    expect(rows.some(r => r.model === 'opus')).toBe(true);
  });
});

describe('getDailyTokenTotals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T23:59:59Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns empty array when no data', () => {
    expect(getDailyTokenTotals(30)).toEqual([]);
  });

  it('sums all token types into totalTokens', () => {
    insertSnapshot({
      bucketStartingAt: '2024-06-15T00:00:00.000Z',
      bucketEndingAt: '2024-06-16T00:00:00.000Z',
      uncachedInputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWrite1hTokens: 3,
      cacheWrite5mTokens: 2,
    });

    const rows = getDailyTokenTotals(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalTokens).toBe(40); // 10+20+5+3+2
  });
});

// ---------------------------------------------------------------------------
// session_tokens — insertSessionTokens / getSessionTokens
// ---------------------------------------------------------------------------

describe('insertSessionTokens / getSessionTokens', () => {
  it('returns null when no session data exists', () => {
    expect(getSessionTokens()).toBeNull();
  });

  it('stores and retrieves session token data', () => {
    insertSessionTokens({
      tokensUsed: 1000,
      tokenLimit: 5000,
      plan: 'pro',
      resetsAt: '2024-07-01T00:00:00.000Z',
      capturedAt: '2024-06-15T12:00:00.000Z',
    });

    const row = getSessionTokens()!;
    expect(row.tokensUsed).toBe(1000);
    expect(row.tokenLimit).toBe(5000);
    expect(row.plan).toBe('pro');
    expect(row.resetsAt).toBe('2024-07-01T00:00:00.000Z');
    expect(row.capturedAt).toBe('2024-06-15T12:00:00.000Z');
  });

  it('returns the most recent session row', () => {
    insertSessionTokens({ tokensUsed: 100, capturedAt: '2024-06-15T10:00:00.000Z' });
    insertSessionTokens({ tokensUsed: 200, capturedAt: '2024-06-15T11:00:00.000Z' });
    expect(getSessionTokens()!.tokensUsed).toBe(200);
  });

  it('accepts null for optional fields', () => {
    insertSessionTokens({ tokensUsed: null, tokenLimit: null, plan: null, resetsAt: null });
    const row = getSessionTokens()!;
    expect(row.tokensUsed).toBeNull();
    expect(row.tokenLimit).toBeNull();
    expect(row.plan).toBeNull();
    expect(row.resetsAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// personal_session_tokens — insertPersonalTokens / getPersonalPeriodTokens
// ---------------------------------------------------------------------------

describe('insertPersonalTokens / getPersonalPeriodTokens', () => {
  const sample = {
    model: 'claude-haiku-4-5-20251001',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
  };

  it('returns zero-valued object when no data exists', () => {
    const result = getPersonalPeriodTokens('1970-01-01T00:00:00.000Z');
    expect(result).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('sums tokens recorded after the given since timestamp', () => {
    insertPersonalTokens(sample, '2024-06-15T10:00:00.000Z');
    insertPersonalTokens(sample, '2024-06-15T11:00:00.000Z');

    const result = getPersonalPeriodTokens('2024-06-15T00:00:00.000Z');
    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(10);
  });

  it('excludes tokens recorded before the since timestamp', () => {
    insertPersonalTokens(sample, '2024-06-14T23:59:59.000Z');
    const result = getPersonalPeriodTokens('2024-06-15T00:00:00.000Z');
    expect(result.inputTokens).toBe(0);
  });
});

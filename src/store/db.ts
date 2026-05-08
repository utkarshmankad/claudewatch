import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PersonalUsageSample } from '../api/personalClient.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(os.homedir(), '.claudewatch');
const DB_PATH = path.join(DATA_DIR, 'usage.db');

// Bump this whenever the schema changes. The migration below handles the
// upgrade from any lower version.
const CURRENT_SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// Exported TypeScript types (camelCase view of the rows)
// ---------------------------------------------------------------------------

export interface UsageSnapshot {
  readonly id: number;
  /** ISO 8601 — when this row was written (daemon poll time) */
  readonly recordedAt: string;
  /** ISO 8601 — start of the API time-bucket this data covers */
  readonly bucketStartingAt: string;
  /** ISO 8601 — end of the API time-bucket */
  readonly bucketEndingAt: string;
  readonly model: string | null;
  readonly workspaceId: string | null;
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /** Cache-write tokens charged at the 1-hour TTL rate */
  readonly cacheWrite1hTokens: number;
  /** Cache-write tokens charged at the 5-minute TTL rate */
  readonly cacheWrite5mTokens: number;
}

/** Input shape for insertSnapshot() — all fields optional; defaults applied inside. */
export interface SnapshotData {
  recordedAt?: string;
  bucketStartingAt?: string;
  bucketEndingAt?: string;
  model?: string | null;
  workspaceId?: string | null;
  uncachedInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWrite1hTokens?: number;
  cacheWrite5mTokens?: number;
}

export interface AlertRecord {
  readonly id: number;
  readonly firedAt: string;
  readonly thresholdUsd: number;
  readonly period: string;
  readonly actualUsd: number;
  readonly channels: string[];
}

export interface PlanInfo {
  readonly id: number;
  readonly fetchedAt: string;
  readonly billingPeriodStart: string;
  readonly billingPeriodEnd: string;
  readonly planName: string | null;
  readonly monthlyBudgetUsd: number | null;
  /** Running total cost for this billing period in USD */
  readonly totalCostUsd: number;
  /** Full JSON payload for debugging / future fields */
  readonly rawJson: string;
}

// ---------------------------------------------------------------------------
// Internal row shapes — what better-sqlite3 hands back (snake_case, flat)
// ---------------------------------------------------------------------------

interface UsageRow {
  id: number;
  recorded_at: string;
  bucket_starting_at: string;
  bucket_ending_at: string;
  model: string | null;
  workspace_id: string | null;
  uncached_input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_1h_tokens: number;
  cache_write_5m_tokens: number;
}

interface AlertRow {
  id: number;
  fired_at: string;
  threshold_usd: number;
  period: string;
  actual_usd: number;
  channels: string; // JSON
}

interface PlanRow {
  id: number;
  fetched_at: string;
  billing_period_start: string;
  billing_period_end: string;
  plan_name: string | null;
  monthly_budget_usd: number | null;
  total_cost_usd: number;
  raw_json: string;
}

// ---------------------------------------------------------------------------
// Singleton connection
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

/** Close the connection (useful in tests). */
export function closeDb(): void {
  _db?.close();
  _db = null;
}

/** Absolute path to the SQLite database file. */
export function getDbPath(): string {
  return DB_PATH;
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

function migrate(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version >= CURRENT_SCHEMA_VERSION) return;

  db.transaction(() => {
    if (version < 1) applyV1(db);
    if (version < 2) applyV2(db);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  })();
}

function applyV2(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS personal_session_tokens (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at        TEXT    NOT NULL,
      model              TEXT    NOT NULL DEFAULT '',
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_personal_recorded
      ON personal_session_tokens (recorded_at DESC);
  `);
}

function applyV1(db: Database.Database): void {
  // Drop old usage_snapshots — column layout changed (new API field names).
  // cost_snapshots and alert_log keep their shape; we add plan_info fresh.
  db.exec(`
    DROP TABLE IF EXISTS usage_snapshots;

    CREATE TABLE usage_snapshots (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at           TEXT    NOT NULL,
      bucket_starting_at    TEXT    NOT NULL,
      bucket_ending_at      TEXT    NOT NULL,
      model                 TEXT,
      workspace_id          TEXT,
      uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_snap_recorded
      ON usage_snapshots (recorded_at DESC);

    CREATE INDEX IF NOT EXISTS idx_snap_bucket
      ON usage_snapshots (bucket_starting_at, bucket_ending_at);

    -- Retained for backward-compat with existing poller code.
    CREATE TABLE IF NOT EXISTS cost_snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at  TEXT    NOT NULL,
      start_time   TEXT    NOT NULL,
      end_time     TEXT    NOT NULL,
      workspace_id TEXT    NOT NULL DEFAULT '',
      amount_usd   REAL    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cost_end
      ON cost_snapshots (end_time);

    CREATE TABLE IF NOT EXISTS alert_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      fired_at      TEXT    NOT NULL,
      threshold_usd REAL    NOT NULL,
      period        TEXT    NOT NULL,
      actual_usd    REAL    NOT NULL,
      channels      TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_alert_lookup
      ON alert_log (threshold_usd, period, fired_at DESC);

    CREATE TABLE IF NOT EXISTS plan_info (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at           TEXT    NOT NULL,
      billing_period_start TEXT    NOT NULL,
      billing_period_end   TEXT    NOT NULL,
      plan_name            TEXT,
      monthly_budget_usd   REAL,
      total_cost_usd       REAL    NOT NULL DEFAULT 0,
      raw_json             TEXT    NOT NULL DEFAULT '{}'
    );
  `);
}

// ---------------------------------------------------------------------------
// usage_snapshots — query functions
// ---------------------------------------------------------------------------

/**
 * Persist one usage row into usage_snapshots.
 * Call once per (bucket × result) from runTick(), or once per personal-mode poll.
 */
export function insertSnapshot(data: SnapshotData): void {
  const db = getDb();
  const now = new Date().toISOString();

  const params = {
    recordedAt:          data.recordedAt          ?? now,
    bucketStartingAt:    data.bucketStartingAt     ?? now,
    bucketEndingAt:      data.bucketEndingAt       ?? now,
    model:               data.model               ?? null,
    workspaceId:         data.workspaceId          ?? null,
    uncachedInputTokens: data.uncachedInputTokens  ?? 0,
    outputTokens:        data.outputTokens         ?? 0,
    cacheReadTokens:     data.cacheReadTokens      ?? 0,
    cacheWrite1hTokens:  data.cacheWrite1hTokens   ?? 0,
    cacheWrite5mTokens:  data.cacheWrite5mTokens   ?? 0,
  };

  console.log('[insertSnapshot] writing:', JSON.stringify(params));

  const result = db.prepare(`
    INSERT INTO usage_snapshots (
      recorded_at, bucket_starting_at, bucket_ending_at,
      model, workspace_id,
      uncached_input_tokens, output_tokens,
      cache_read_tokens, cache_write_1h_tokens, cache_write_5m_tokens
    ) VALUES (
      @recordedAt, @bucketStartingAt, @bucketEndingAt,
      @model, @workspaceId,
      @uncachedInputTokens, @outputTokens,
      @cacheReadTokens, @cacheWrite1hTokens, @cacheWrite5mTokens
    )
  `).run(params);

  if (result.changes === 0) {
    console.error('[insertSnapshot] wrote 0 rows — check column names');
  } else {
    console.log(`[insertSnapshot] saved rowid ${result.lastInsertRowid}`);
  }
}

/**
 * Return all snapshot rows whose bucket falls within [startingAt, endingAt].
 * Ordered by bucket start time then model — ready for chart rendering.
 */
export function getSnapshotsForPeriod(
  startingAt: string,
  endingAt: string,
): UsageSnapshot[] {
  const rows = getDb()
    .prepare<[string, string]>(`
      SELECT *
      FROM   usage_snapshots
      WHERE  bucket_starting_at >= ?
        AND  bucket_ending_at   <= ?
      ORDER BY bucket_starting_at ASC, model ASC
    `)
    .all(startingAt, endingAt) as UsageRow[];

  return rows.map(rowToSnapshot);
}

/**
 * Return one representative row from the most recent poll cycle, or null if
 * the table is empty. Use `recordedAt` on the result to detect stale data.
 */
export function getLatestSnapshot(): UsageSnapshot | null {
  const row = getDb()
    .prepare(`
      SELECT *
      FROM   usage_snapshots
      ORDER BY rowid DESC
      LIMIT  1
    `)
    .get() as UsageRow | undefined;

  return row ? rowToSnapshot(row) : null;
}

// ---------------------------------------------------------------------------
// alert_log — query functions
// ---------------------------------------------------------------------------

/**
 * Return true if an alert for `(thresholdUsd, period)` was already recorded
 * on or after `since` (typically the start of the current period window).
 * Prevents re-firing the same alert on every daemon poll.
 */
export function hasAlertFired(
  thresholdUsd: number,
  period: string,
  since: string,
): boolean {
  const row = getDb()
    .prepare<[number, string, string]>(`
      SELECT 1
      FROM   alert_log
      WHERE  threshold_usd = ?
        AND  period        = ?
        AND  fired_at      >= ?
      LIMIT  1
    `)
    .get(thresholdUsd, period, since);

  return row !== undefined;
}

/**
 * Record that an alert was fired right now.
 * Callers should check hasAlertFired() first to avoid duplicates.
 */
export function recordAlert(
  thresholdUsd: number,
  period: string,
  actualUsd: number,
  channels: string[],
): void {
  getDb()
    .prepare<[string, number, string, number, string]>(`
      INSERT INTO alert_log (fired_at, threshold_usd, period, actual_usd, channels)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      new Date().toISOString(),
      thresholdUsd,
      period,
      actualUsd,
      JSON.stringify(channels),
    );
}

/** Return the full alert history, newest first. */
export function getAlertHistory(limit = 50): AlertRecord[] {
  const rows = getDb()
    .prepare<[number]>(`
      SELECT * FROM alert_log ORDER BY fired_at DESC LIMIT ?
    `)
    .all(limit) as AlertRow[];

  return rows.map(rowToAlert);
}

// ---------------------------------------------------------------------------
// plan_info — query functions
// ---------------------------------------------------------------------------

/** Append a billing-period summary. Keeps history; use getLatestPlanInfo() for current state. */
export function insertPlanInfo(info: Omit<PlanInfo, 'id'>): void {
  getDb()
    .prepare<[string, string, string, string | null, number | null, number, string]>(`
      INSERT INTO plan_info
        (fetched_at, billing_period_start, billing_period_end,
         plan_name, monthly_budget_usd, total_cost_usd, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      info.fetchedAt,
      info.billingPeriodStart,
      info.billingPeriodEnd,
      info.planName,
      info.monthlyBudgetUsd,
      info.totalCostUsd,
      info.rawJson,
    );
}

/** Return the most recently fetched plan/billing summary, or null. */
export function getLatestPlanInfo(): PlanInfo | null {
  const row = getDb()
    .prepare(`
      SELECT * FROM plan_info ORDER BY fetched_at DESC LIMIT 1
    `)
    .get() as PlanRow | undefined;

  return row ? rowToPlanInfo(row) : null;
}

// ---------------------------------------------------------------------------
// usage_snapshots — daily aggregation for sparklines
// ---------------------------------------------------------------------------

export interface DailyTokenTotal {
  /** UTC date string 'YYYY-MM-DD' */
  day: string;
  totalTokens: number;
}

export interface DailyModelTokens {
  day: string;
  model: string;
  tokens: number;
}

/**
 * Return per-day, per-model token totals for the last `days` UTC days.
 * Ordered oldest-first then alphabetically by model — suitable for pivoting
 * into a Recharts stacked bar dataset.
 */
export function getDailyTokensByModel(days: number): DailyModelTokens[] {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  since.setUTCHours(0, 0, 0, 0);

  const rows = getDb()
    .prepare<[string]>(`
      SELECT
        date(bucket_starting_at) AS day,
        COALESCE(model, '(unknown)') AS model,
        SUM(
          uncached_input_tokens + output_tokens + cache_read_tokens +
          cache_write_1h_tokens + cache_write_5m_tokens
        ) AS tokens
      FROM   usage_snapshots
      WHERE  bucket_starting_at >= ?
      GROUP  BY date(bucket_starting_at), model
      ORDER  BY day ASC, model ASC
    `)
    .all(since.toISOString()) as Array<{ day: string; model: string; tokens: number }>;

  return rows.map(r => ({ day: r.day, model: r.model, tokens: r.tokens }));
}

/**
 * Return per-day token totals (all token types summed) for the last `days` UTC days,
 * ordered oldest-first. Days with no data are omitted.
 */
export function getDailyTokenTotals(days: number): DailyTokenTotal[] {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  since.setUTCHours(0, 0, 0, 0);

  const rows = getDb()
    .prepare<[string]>(`
      SELECT
        date(bucket_starting_at) AS day,
        SUM(
          uncached_input_tokens + output_tokens + cache_read_tokens +
          cache_write_1h_tokens + cache_write_5m_tokens
        ) AS total_tokens
      FROM   usage_snapshots
      WHERE  bucket_starting_at >= ?
      GROUP  BY date(bucket_starting_at)
      ORDER  BY day ASC
    `)
    .all(since.toISOString()) as Array<{ day: string; total_tokens: number }>;

  return rows.map(r => ({ day: r.day, totalTokens: r.total_tokens }));
}

// ---------------------------------------------------------------------------
// Weekly aggregations for limit checks
// ---------------------------------------------------------------------------

/** Sum cost_snapshots for the last 7 days (rolling window). */
export function getWeeklySpend(): number {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const row = getDb()
    .prepare<[string]>(`
      SELECT COALESCE(SUM(amount_usd), 0) AS total
      FROM cost_snapshots
      WHERE end_time >= ?
    `)
    .get(sevenDaysAgo) as { total: number };
  return row.total;
}

/** Sum all token types in usage_snapshots for the last 7 days (rolling window). */
export function getWeeklyTokens(): number {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const row = getDb()
    .prepare<[string]>(`
      SELECT COALESCE(SUM(
        uncached_input_tokens + output_tokens + cache_read_tokens +
        cache_write_1h_tokens + cache_write_5m_tokens
      ), 0) AS total
      FROM usage_snapshots
      WHERE bucket_starting_at >= ?
    `)
    .get(sevenDaysAgo) as { total: number };
  return row.total;
}

// ---------------------------------------------------------------------------
// personal_session_tokens — query functions (personal mode)
// ---------------------------------------------------------------------------

/** Persist one usage sample from a personal-mode test call. */
export function insertPersonalTokens(
  sample: PersonalUsageSample,
  recordedAt?: string,
): void {
  getDb()
    .prepare<[string, string, number, number, number, number]>(`
      INSERT INTO personal_session_tokens
        (recorded_at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      recordedAt ?? new Date().toISOString(),
      sample.model,
      sample.inputTokens,
      sample.outputTokens,
      sample.cacheReadTokens,
      sample.cacheWriteTokens,
    );
}

export interface PersonalPeriodTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface PersonalTotalsRow {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** Return the most recently recorded personal usage sample, or null. */
export function getLatestPersonalTokens(): PersonalUsageSample & { recordedAt: string } | null {
  const row = getDb()
    .prepare(`
      SELECT * FROM personal_session_tokens ORDER BY rowid DESC LIMIT 1
    `)
    .get() as {
      id: number;
      recorded_at: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
    } | undefined;

  if (!row) return null;
  return {
    recordedAt: row.recorded_at,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
  };
}

/** Sum all personal session tokens recorded on or after `since` (ISO 8601). */
export function getPersonalPeriodTokens(since: string): PersonalPeriodTokens {
  const row = getDb()
    .prepare<[string]>(`
      SELECT
        COALESCE(SUM(input_tokens), 0)       AS input_tokens,
        COALESCE(SUM(output_tokens), 0)      AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0)  AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
      FROM personal_session_tokens
      WHERE recorded_at >= ?
    `)
    .get(since) as PersonalTotalsRow | undefined;

  return {
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    cacheReadTokens: row?.cache_read_tokens ?? 0,
    cacheWriteTokens: row?.cache_write_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Row → type converters
// ---------------------------------------------------------------------------

function rowToSnapshot(r: UsageRow): UsageSnapshot {
  return {
    id: r.id,
    recordedAt: r.recorded_at,
    bucketStartingAt: r.bucket_starting_at,
    bucketEndingAt: r.bucket_ending_at,
    model: r.model,
    workspaceId: r.workspace_id,
    uncachedInputTokens: r.uncached_input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWrite1hTokens: r.cache_write_1h_tokens,
    cacheWrite5mTokens: r.cache_write_5m_tokens,
  };
}

function rowToAlert(r: AlertRow): AlertRecord {
  return {
    id: r.id,
    firedAt: r.fired_at,
    thresholdUsd: r.threshold_usd,
    period: r.period,
    actualUsd: r.actual_usd,
    channels: JSON.parse(r.channels) as string[],
  };
}

function rowToPlanInfo(r: PlanRow): PlanInfo {
  return {
    id: r.id,
    fetchedAt: r.fetched_at,
    billingPeriodStart: r.billing_period_start,
    billingPeriodEnd: r.billing_period_end,
    planName: r.plan_name,
    monthlyBudgetUsd: r.monthly_budget_usd,
    totalCostUsd: r.total_cost_usd,
    rawJson: r.raw_json,
  };
}

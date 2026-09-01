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
const CURRENT_SCHEMA_VERSION = 6;

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
  /** Source of usage: 'api' | 'claude_code' | 'claude_ai' | 'mobile' */
  readonly sourceTag: string;
  readonly estimatedCostUsd: number;
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
  sourceTag?: string | null;
  estimatedCostUsd?: number;
}

export type UsageConfidence = 'authoritative' | 'observed' | 'estimated' | 'inferred';

export interface UsageEventData {
  eventId: string;
  recordedAt?: string;
  provider: string;
  accountId?: string | null;
  organizationId?: string | null;
  userId?: string | null;
  teamId?: string | null;
  deviceId: string;
  client: string;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  utilizationPct?: number | null;
  windowSeconds?: number | null;
  source: string;
  confidence: UsageConfidence;
  metadata?: Record<string, unknown>;
}

export interface AttributionSummary {
  client: string;
  provider: string;
  confidence: UsageConfidence;
  inputTokens: number;
  outputTokens: number;
  events: number;
  lastSeenAt: string;
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
  source_tag: string | null;
  estimated_cost_usd: number | null;
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
    if (version < 4) applyV4(db);
    if (version < 5) applyV5(db);
    if (version < 6) applyV6(db);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  })();
}

function applyV6(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      event_id         TEXT PRIMARY KEY,
      recorded_at      TEXT NOT NULL,
      provider         TEXT NOT NULL,
      account_id       TEXT,
      organization_id  TEXT,
      user_id           TEXT,
      team_id           TEXT,
      device_id         TEXT NOT NULL,
      client            TEXT NOT NULL,
      model             TEXT,
      input_tokens      INTEGER NOT NULL DEFAULT 0,
      output_tokens     INTEGER NOT NULL DEFAULT 0,
      utilization_pct  REAL,
      window_seconds    INTEGER,
      source            TEXT NOT NULL,
      confidence        TEXT NOT NULL,
      metadata_json     TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_time ON usage_events(recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_attribution ON usage_events(provider, client, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_team ON usage_events(team_id, user_id, recorded_at DESC);
  `);
}

// V5: add source_tag and estimated_cost_usd to usage_snapshots.
// ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite; catch duplicate-column errors.
function applyV5(db: Database.Database): void {
  try { db.exec(`ALTER TABLE usage_snapshots ADD COLUMN source_tag TEXT DEFAULT 'api'`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE usage_snapshots ADD COLUMN estimated_cost_usd REAL DEFAULT 0`); } catch { /* already exists */ }
}

// V4: creates session_tokens with IF NOT EXISTS — safe for all previous versions
// (versions 3 had the same SQL but was applied inconsistently; IF NOT EXISTS handles both).
function applyV4(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at TEXT    NOT NULL,
      tokens_used INTEGER,
      token_limit INTEGER,
      plan        TEXT,
      resets_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_session_recorded
      ON session_tokens (recorded_at DESC);
  `);
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
    sourceTag:           data.sourceTag            ?? 'api',
    estimatedCostUsd:    data.estimatedCostUsd     ?? 0,
  };

  const result = db.prepare(`
    INSERT INTO usage_snapshots (
      recorded_at, bucket_starting_at, bucket_ending_at,
      model, workspace_id,
      uncached_input_tokens, output_tokens,
      cache_read_tokens, cache_write_1h_tokens, cache_write_5m_tokens,
      source_tag, estimated_cost_usd
    ) VALUES (
      @recordedAt, @bucketStartingAt, @bucketEndingAt,
      @model, @workspaceId,
      @uncachedInputTokens, @outputTokens,
      @cacheReadTokens, @cacheWrite1hTokens, @cacheWrite5mTokens,
      @sourceTag, @estimatedCostUsd
    )
  `).run(params);

  if (result.changes === 0) {
    console.error('[insertSnapshot] wrote 0 rows — check column names');
  }
}

export function insertUsageEvent(event: UsageEventData): boolean {
  const result = getDb().prepare(`
    INSERT OR IGNORE INTO usage_events (
      event_id, recorded_at, provider, account_id, organization_id, user_id, team_id,
      device_id, client, model, input_tokens, output_tokens, utilization_pct,
      window_seconds, source, confidence, metadata_json
    ) VALUES (
      @eventId, @recordedAt, @provider, @accountId, @organizationId, @userId, @teamId,
      @deviceId, @client, @model, @inputTokens, @outputTokens, @utilizationPct,
      @windowSeconds, @source, @confidence, @metadataJson
    )
  `).run({
    eventId: event.eventId,
    recordedAt: event.recordedAt ?? new Date().toISOString(),
    provider: event.provider,
    accountId: event.accountId ?? null,
    organizationId: event.organizationId ?? null,
    userId: event.userId ?? null,
    teamId: event.teamId ?? null,
    deviceId: event.deviceId,
    client: event.client,
    model: event.model ?? null,
    inputTokens: Math.max(0, Math.round(event.inputTokens ?? 0)),
    outputTokens: Math.max(0, Math.round(event.outputTokens ?? 0)),
    utilizationPct: event.utilizationPct ?? null,
    windowSeconds: event.windowSeconds ?? null,
    source: event.source,
    confidence: event.confidence,
    metadataJson: JSON.stringify(event.metadata ?? {}),
  });
  return result.changes > 0;
}

export function getAttributionSummary(days = 30, teamId?: string): AttributionSummary[] {
  const since = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString();
  const rows = getDb().prepare(`
    SELECT client, provider, confidence,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           COUNT(*) AS events,
           MAX(recorded_at) AS last_seen_at
    FROM usage_events
    WHERE recorded_at >= @since AND (@teamId IS NULL OR team_id = @teamId)
    GROUP BY client, provider, confidence
    ORDER BY input_tokens + output_tokens DESC
  `).all({ since, teamId: teamId ?? null }) as Array<{
    client: string; provider: string; confidence: UsageConfidence;
    input_tokens: number; output_tokens: number; events: number; last_seen_at: string;
  }>;
  return rows.map(row => ({
    client: row.client, provider: row.provider, confidence: row.confidence,
    inputTokens: row.input_tokens, outputTokens: row.output_tokens,
    events: row.events, lastSeenAt: row.last_seen_at,
  }));
}

export function getHourlyActivity(days = 30, teamId?: string): Array<{ hour: number; tokens: number; events: number }> {
  const since = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString();
  return getDb().prepare(`
    SELECT CAST(strftime('%H', recorded_at) AS INTEGER) AS hour,
           SUM(input_tokens + output_tokens) AS tokens, COUNT(*) AS events
    FROM usage_events
    WHERE recorded_at >= @since AND (@teamId IS NULL OR team_id = @teamId)
    GROUP BY hour ORDER BY hour
  `).all({ since, teamId: teamId ?? null }) as Array<{ hour: number; tokens: number; events: number }>;
}

export function getTeamLeaderboard(days = 30, teamId?: string): Array<{ userId: string; tokens: number; events: number }> {
  const since = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString();
  return getDb().prepare(`
    SELECT COALESCE(user_id, 'unassigned') AS userId,
           SUM(input_tokens + output_tokens) AS tokens, COUNT(*) AS events
    FROM usage_events
    WHERE recorded_at >= @since AND (@teamId IS NULL OR team_id = @teamId)
    GROUP BY COALESCE(user_id, 'unassigned') ORDER BY tokens DESC
  `).all({ since, teamId: teamId ?? null }) as Array<{ userId: string; tokens: number; events: number }>;
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

/** Compute Sunday-anchored calendar week start in UTC (matches periodStart('weekly')). */
function calendarWeekStart(): string {
  const now = new Date();
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Sum cost_snapshots for the current calendar week (Sunday–Saturday, UTC). */
export function getWeeklySpend(): number {
  const weekStart = calendarWeekStart();
  const row = getDb()
    .prepare<[string]>(`
      SELECT COALESCE(SUM(amount_usd), 0) AS total
      FROM cost_snapshots
      WHERE end_time >= ?
    `)
    .get(weekStart) as { total: number };
  return row.total;
}

/** Sum all token types in usage_snapshots for the current calendar week (Sunday–Saturday, UTC). */
export function getWeeklyTokens(): number {
  const weekStart = calendarWeekStart();
  const row = getDb()
    .prepare<[string]>(`
      SELECT COALESCE(SUM(
        uncached_input_tokens + output_tokens + cache_read_tokens +
        cache_write_1h_tokens + cache_write_5m_tokens
      ), 0) AS total
      FROM usage_snapshots
      WHERE bucket_starting_at >= ?
    `)
    .get(weekStart) as { total: number };
  return row.total;
}

// ---------------------------------------------------------------------------
// usage_snapshots — source breakdown
// ---------------------------------------------------------------------------

export interface SourceUsage {
  tokens: number;
  cost: number;
  calls: number;
}

/** Return per-source token totals for usage_snapshots recorded on or after `since`. */
export function getUsageBySource(since: string): Record<string, SourceUsage> {
  const rows = getDb()
    .prepare<[string]>(`
      SELECT
        COALESCE(source_tag, 'api') AS source,
        SUM(
          uncached_input_tokens + output_tokens +
          cache_read_tokens + cache_write_1h_tokens + cache_write_5m_tokens
        ) AS tokens,
        SUM(estimated_cost_usd) AS cost,
        COUNT(*) AS calls
      FROM usage_snapshots
      WHERE recorded_at >= ?
      GROUP BY COALESCE(source_tag, 'api')
    `)
    .all(since) as Array<{ source: string; tokens: number; cost: number; calls: number }>;

  const result: Record<string, SourceUsage> = {};
  for (const row of rows) {
    result[row.source] = {
      tokens: row.tokens ?? 0,
      cost:   row.cost   ?? 0,
      calls:  row.calls  ?? 0,
    };
  }
  return result;
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
// session_tokens — extension-pushed claude.ai session data
// ---------------------------------------------------------------------------

export interface SessionTokens {
  tokensUsed: number | null;
  tokenLimit: number | null;
  plan: string | null;
  resetsAt: string | null;
  capturedAt: string;
}

/** Persist the latest session state pushed by the extension. */
export function insertSessionTokens(data: {
  tokensUsed?: number | null;
  tokenLimit?: number | null;
  plan?: string | null;
  resetsAt?: string | null;
  capturedAt?: string;
}): void {
  getDb()
    .prepare<[string, number | null, number | null, string | null, string | null]>(`
      INSERT INTO session_tokens (recorded_at, tokens_used, token_limit, plan, resets_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      data.capturedAt ?? new Date().toISOString(),
      data.tokensUsed ?? null,
      data.tokenLimit ?? null,
      data.plan ?? null,
      data.resetsAt ?? null,
    );
}

/** Return the most recent session snapshot pushed by the extension, or null. */
export function getSessionTokens(): SessionTokens | null {
  const row = getDb()
    .prepare(`
      SELECT * FROM session_tokens ORDER BY rowid DESC LIMIT 1
    `)
    .get() as {
      recorded_at: string;
      tokens_used: number | null;
      token_limit: number | null;
      plan: string | null;
      resets_at: string | null;
    } | undefined;

  if (!row) return null;
  return {
    tokensUsed: row.tokens_used,
    tokenLimit: row.token_limit,
    plan: row.plan,
    resetsAt: row.resets_at,
    capturedAt: row.recorded_at,
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
    sourceTag: r.source_tag ?? 'api',
    estimatedCostUsd: r.estimated_cost_usd ?? 0,
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

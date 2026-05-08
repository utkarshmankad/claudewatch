import { getDb } from './db.js';
import { recordAlert } from './db.js';
import type { RawUsageRecord, RawCostRecord } from '../api/types.js';

// ---------------------------------------------------------------------------
// usage_snapshots — legacy bridge
//
// The daemon poller still calls these with the old flat-record types from
// AnthropicAdminClient. They write into the new usage_snapshots schema by
// mapping field names:
//   input_tokens                → uncached_input_tokens
//   cache_creation_input_tokens → cache_write_1h_tokens  (single old TTL)
//   cache_read_input_tokens     → cache_read_tokens
//   cache_write_5m_tokens       → 0 (not present in old API)
// ---------------------------------------------------------------------------

export function insertUsageRecords(
  startTime: string,
  endTime: string,
  records: RawUsageRecord[],
): void {
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO usage_snapshots
      (recorded_at, bucket_starting_at, bucket_ending_at,
       model, workspace_id,
       uncached_input_tokens, output_tokens, cache_read_tokens,
       cache_write_1h_tokens, cache_write_5m_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction((recs: RawUsageRecord[]) => {
    for (const r of recs) {
      stmt.run(
        now, startTime, endTime,
        r.model, r.workspace_id,
        r.input_tokens,
        r.output_tokens,
        r.cache_read_input_tokens,
        r.cache_creation_input_tokens,
        0,
      );
    }
  })(records);
}

// ---------------------------------------------------------------------------
// cost_snapshots
// ---------------------------------------------------------------------------

export function insertCostRecords(
  startTime: string,
  endTime: string,
  records: RawCostRecord[],
): void {
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO cost_snapshots (recorded_at, start_time, end_time, workspace_id, amount_usd)
    VALUES (?, ?, ?, ?, ?)
  `);

  db.transaction((recs: RawCostRecord[]) => {
    for (const r of recs) {
      stmt.run(now, startTime, endTime, r.workspace_id, r.amount_usd);
    }
  })(records);
}

export function getTotalCostSince(since: string): number {
  const row = getDb()
    .prepare(`
      SELECT COALESCE(SUM(amount_usd), 0) AS total
      FROM   cost_snapshots
      WHERE  end_time >= ?
    `)
    .get(since) as { total: number };
  return row.total;
}

// ---------------------------------------------------------------------------
// alert_log — thin wrappers that delegate to db.ts
// ---------------------------------------------------------------------------

export function logAlert(
  thresholdUsd: number,
  period: string,
  actualUsd: number,
  channels: string[],
): void {
  recordAlert(thresholdUsd, period, actualUsd, channels);
}

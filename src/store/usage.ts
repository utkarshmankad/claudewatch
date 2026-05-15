import { getDb } from './db.js';

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

import type { Express } from 'express';
import { deleteMatching, readLedgerFile } from '../collectors/ledgerFile.js';
import { buildLedgerView, filteredRows, matches, parseFilter, toCsv } from '../ledger/view.js';

// Local-only ledger API for the dashboard. Reads and deletes the daemon's ledger file;
// nothing here leaves the machine. Rules: docs/LEDGER_UI.md.
export function registerLedgerRoutes(app: Express, getPath: () => string, now: () => number = Date.now): void {
  app.get('/api/ledger', (req, res) => {
    const parsed = parseFilter(req.query);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    const limit = Number.parseInt(String(req.query['limit'] ?? ''), 10);
    try {
      res.json(buildLedgerView(readLedgerFile(getPath()), parsed.filter, { now: now(), ...(Number.isFinite(limit) ? { limit } : {}) }));
    } catch (err) {
      console.error('[/api/ledger]', err);
      res.status(500).json({ error: 'ledger_unreadable' });
    }
  });

  // Export honours the same filters; it is never truncated.
  app.get('/api/ledger/export', (req, res) => {
    const parsed = parseFilter(req.query);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    const rows = filteredRows(readLedgerFile(getPath()), parsed.filter);
    if (req.query['format'] === 'csv') {
      res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="claudewatch-ledger.csv"').send(toCsv(rows));
      return;
    }
    res.setHeader('Content-Disposition', 'attachment; filename="claudewatch-ledger.json"');
    res.json({ exportedAt: new Date(now()).toISOString(), count: rows.length, filter: parsed.filter, rows });
  });

  // Hard delete of the records the filters select. With no filter it deletes everything,
  // so the caller must say so explicitly with confirm=all.
  app.delete('/api/ledger', (req, res) => {
    const parsed = parseFilter(req.query);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    const unfiltered = Object.keys(parsed.filter).length === 0;
    if (req.query['confirm'] !== (unfiltered ? 'all' : 'yes')) { res.status(400).json({ error: 'confirmation_required', hint: unfiltered ? 'confirm=all' : 'confirm=yes' }); return; }
    const deleted = deleteMatching(getPath(), r => matches(r, parsed.filter));
    res.json({ ok: true, deleted });
  });
}

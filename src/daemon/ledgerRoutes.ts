import type { Express } from 'express';
import { deleteMatching, readLedgerFile } from '../collectors/ledgerFile.js';
import { buildLedgerView, filteredRows, matches, parseFilter, toCsv } from '../ledger/view.js';
import { forecast } from '../forecast/engine.js';
import { PROVIDERS, WINDOW_TYPES } from '../ledger/types.js';
import type { Provider, WindowType } from '../ledger/types.js';

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

  // Forecast for one provider/account/window from stored snapshots. Read-only. Rules: docs/FORECASTS.md.
  app.get('/api/forecast', (req, res) => {
    const provider = String(req.query['provider'] ?? '');
    const window = String(req.query['window'] ?? 'five_hour');
    const accountAlias = String(req.query['account'] ?? '');
    const reserved = req.query['reserved'] === undefined ? 0 : Number(req.query['reserved']);
    if (!(PROVIDERS as readonly string[]).includes(provider)) { res.status(400).json({ error: 'invalid_provider' }); return; }
    if (!(WINDOW_TYPES as readonly string[]).includes(window)) { res.status(400).json({ error: 'invalid_window' }); return; }
    if (!accountAlias) { res.status(400).json({ error: 'account_required' }); return; }
    if (!Number.isFinite(reserved) || reserved < 0 || reserved > 100) { res.status(400).json({ error: 'invalid_reserved' }); return; }
    try {
      const f = forecast(readLedgerFile(getPath()), { now: now(), provider: provider as Provider, accountAlias, window: window as WindowType, reservedPercent: reserved });
      console.log(`[forecast] ${provider}/${window} state=${f.state} method=${f.method} reasons=${f.reasons.join(',') || '-'}`);
      res.json(f);
    } catch (err) {
      console.error('[/api/forecast]', err);
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

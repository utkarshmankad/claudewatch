import type { Express } from 'express';
import { readLedgerFile } from '../collectors/ledgerFile.js';
import { buildReport, listChoices, type ReportOptions } from '../wrapped/report.js';
import { exportReport, logLine, privacyPreview, renderHtml, renderSvg } from '../wrapped/render.js';

// Local-only Usage Wrapped API (Prompt 5.2, operation key 2026-10-10.1/prompt-5.2). Reads the ledger file,
// returns a report and a privacy preview, and exports only against that preview's token. Rules: docs/WRAPPED_REPORT.md.
const list = (v: unknown): string[] | undefined => (typeof v === 'string' && v ? v.split(',').filter(Boolean) : undefined);

function optionsOf(q: Record<string, unknown>, now: number): ReportOptions {
  const accounts = list(q['accounts']), providers = list(q['providers']), devices = list(q['devices']);
  return {
    now, ...(typeof q['tz'] === 'string' && q['tz'] ? { timeZone: q['tz'] } : {}), ...(typeof q['week'] === 'string' && q['week'] ? { week: q['week'] } : {}),
    ...(accounts ? { accounts } : {}), ...(providers ? { providers } : {}), ...(devices ? { devices } : {}), includeAccountNames: q['names'] === '1',
  };
}

export function registerWrappedRoutes(app: Express, getPath: () => string, now: () => number = Date.now): void {
  app.get('/api/wrapped/choices', (req, res) => {
    const c = listChoices(readLedgerFile(getPath()), { now: now(), ...(typeof req.query['tz'] === 'string' && req.query['tz'] ? { timeZone: req.query['tz'] } : {}), ...(typeof req.query['week'] === 'string' && req.query['week'] ? { week: req.query['week'] } : {}) });
    if ('error' in c) { res.status(400).json({ error: c.error }); return; }
    res.json(c);
  });

  app.get('/api/wrapped', (req, res) => {
    const built = buildReport(readLedgerFile(getPath()), optionsOf(req.query, now()));
    if (!built.ok) { res.status(400).json({ error: built.error }); return; }
    console.log(logLine('preview', built.report));
    res.json({ report: built.report, html: renderHtml(built.report), svg: renderSvg(built.report), preview: privacyPreview(built.report) });
  });

  app.get('/api/wrapped/export', (req, res) => {
    const built = buildReport(readLedgerFile(getPath()), optionsOf(req.query, now()));
    if (!built.ok) { res.status(400).json({ error: built.error }); return; }
    const format = String(req.query['format'] ?? '');
    const out = exportReport(built.report, format, typeof req.query['token'] === 'string' ? req.query['token'] : undefined);
    if (!out.ok) { console.log(logLine('export_refused', built.report, { format, error: out.error })); res.status(out.error === 'invalid_format' ? 400 : 409).json({ error: out.error }); return; }
    console.log(logLine('export', built.report, { format }));
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`).type(out.mime).send(out.body);
  });
}

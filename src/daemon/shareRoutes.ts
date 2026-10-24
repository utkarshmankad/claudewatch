import type { Express } from 'express';
import { readLedgerFile } from '../collectors/ledgerFile.js';
import type { ReportOptions } from '../wrapped/report.js';
import { buildCard, cardInputsFrom, cardPreview, CARD_TEMPLATES, exportCard, renderCardSvg } from '../wrapped/shareCards.js';
import { CLIENT_REPORTABLE_EVENTS, shareLogLine, type ShareEvent } from '../wrapped/shareLinks.js';

// Local-only share-card API (Prompt 5.3, operation key 2026-10-10.1/prompt-5.3). Returns a card with per-field toggles and a
// privacy preview, exports only against that preview's token, and logs share actions without a destination.
// There is no publishing route: public links are a contract only (src/wrapped/shareLinks.ts). Rules: docs/SHARE_CARDS.md.
const list = (v: unknown): string[] | undefined => (typeof v === 'string' && v ? v.split(',').filter(Boolean) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function registerShareRoutes(app: Express, getPath: () => string, now: () => number = Date.now, log: (line: string) => void = console.log): void {
  const build = (q: Record<string, unknown>) => {
    const accounts = list(q['accounts']), providers = list(q['providers']), devices = list(q['devices']), tz = str(q['tz']), week = str(q['week']);
    const prevented = Number(q['prevented']);
    const o: ReportOptions = {
      now: now(), ...(tz ? { timeZone: tz } : {}), ...(week ? { week } : {}), ...(accounts ? { accounts } : {}), ...(providers ? { providers } : {}), ...(devices ? { devices } : {}),
      ...(typeof q['prevented'] === 'string' && Number.isInteger(prevented) && prevented >= 0 ? { metrics: { confirmedPrevented: prevented } } : {}),
    };
    const src = cardInputsFrom(readLedgerFile(getPath()), o);
    if (!src.ok) return { error: src.error } as const;
    const hide = list(q['hide']), show = list(q['show']), referralCode = str(q['referral']);
    const card = buildCard(src.inputs, String(q['template'] ?? ''), { ...(hide ? { hide } : {}), ...(show ? { show } : {}), ...(referralCode ? { referralCode } : {}) });
    if (!card.ok) return { error: card.error } as const;
    return { card: card.card, sensitive: src.sensitive } as const;
  };
  const ctxOf = (c: { template: string; fields: Array<{ enabled: boolean }> }) => ({ template: c.template, fieldsOn: c.fields.filter(x => x.enabled).length, fieldsTotal: c.fields.length });

  app.get('/api/share/templates', (_req, res) => { res.json({ templates: CARD_TEMPLATES }); });

  app.get('/api/share/card', (req, res) => {
    const b = build(req.query);
    if ('error' in b) { res.status(400).json({ error: b.error }); return; }
    log(shareLogLine('preview', ctxOf(b.card)));
    res.json({ card: b.card, svg: renderCardSvg(b.card), preview: cardPreview(b.card) });
  });

  app.get('/api/share/export', (req, res) => {
    const b = build(req.query);
    if ('error' in b) { res.status(400).json({ error: b.error }); return; }
    const format = String(req.query['format'] ?? 'svg');
    const out = exportCard(b.card, format, str(req.query['token']), b.sensitive);
    if (!out.ok) { log(shareLogLine('export_refused', { ...ctxOf(b.card), format, error: out.error })); res.status(out.error === 'invalid_format' ? 400 : 409).json({ error: out.error }); return; }
    log(shareLogLine('export', { ...ctxOf(b.card), format: out.format }));
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`).type(out.mime).send(out.body);
  });

  // The browser reports its own share actions. Only the event name and template are read; a destination cannot be sent.
  app.post('/api/share/event', (req, res) => {
    const event = String(req.query['event'] ?? '') as ShareEvent;
    if (!CLIENT_REPORTABLE_EVENTS.includes(event)) { res.status(400).json({ error: 'invalid_event' }); return; }
    const template = str(req.query['template']);
    log(shareLogLine(event, template && (CARD_TEMPLATES as readonly string[]).includes(template) ? { template } : {}));
    res.status(204).end();
  });
}

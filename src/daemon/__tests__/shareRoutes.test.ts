import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendToLedgerFile } from '../../collectors/ledgerFile.js';
import type { LedgerInput } from '../../ledger/types.js';
import type { Card, CardPreview } from '../../wrapped/shareCards.js';
import { registerShareRoutes } from '../shareRoutes.js';

const W0 = Date.UTC(2026, 9, 5), DAY = 86_400_000, HOUR = 3_600_000;
const NOW = W0 + 8 * DAY;
const dir = mkdtempSync(join(tmpdir(), 'cw-share-'));
const path = join(dir, 'ledger.jsonl');
const base0 = { schemaVersion: 1, provider: 'claude', accountAlias: 'private-alias', devicePseudonym: 'a1b2c3d4e5f60718', confidence: 'medium' } as const;
const act = (at: number): LedgerInput => ({ ...base0, kind: 'local_activity', observedAt: at, ingestedAt: at + 1000, source: 'claude_code', measurementMethod: 'local_log_parse', measures: { estimatedTokens: 10, requestCount: 7777 } });
const snap = (at: number, pct: number): LedgerInput => ({ ...base0, kind: 'provider_snapshot', confidence: 'high', observedAt: at, ingestedAt: at + 1000, source: 'web', measurementMethod: 'provider_reported', measures: { quotaPercentUsed: pct }, window: { type: 'five_hour', resetAt: at + 3 * HOUR } });

const logs: string[] = [];
const app = express();
registerShareRoutes(app, () => path, () => NOW, l => logs.push(l));
let server: Server; let base = '';
const ready = new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; resolve(); }); });

beforeEach(async () => {
  await ready;
  logs.length = 0;
  rmSync(path, { force: true });
  appendToLedgerFile(path, Array.from({ length: 7 }, (_v, d) => [act(W0 + d * DAY + HOUR), snap(W0 + d * DAY + 2 * HOUR, 30)]).flat(), NOW);
});
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

describe('share routes', () => {
  it('lists templates and returns a card with toggles and a privacy preview', async () => {
    expect(await (await fetch(`${base}/api/share/templates`)).json()).toEqual({ templates: ['provider_mix', 'quota_streak', 'interruption_prevention', 'usage_patterns'] });
    const raw = await (await fetch(`${base}/api/share/card?template=quota_streak&week=2026-10-07`)).text();
    const r = JSON.parse(raw) as { card: Card; svg: string; preview: CardPreview };
    expect(r.card.fields.find(x => x.id === 'streak')?.text).toBe('7-day streak without hitting a limit');
    expect(r.preview.fields.length).toBe(r.card.fields.length);
    for (const s of ['private-alias', 'a1b2c3d4e5f60718', '7777', 'claude_code']) expect(raw).not.toContain(s);
    expect(logs).toEqual(['[share] event=preview template=quota_streak fields=4/4']);
  });

  it('exports only with the current token and respects toggles', async () => {
    const p = await (await fetch(`${base}/api/share/card?template=quota_streak&week=2026-10-07&hide=streak`)).json() as { preview: CardPreview };
    expect((await fetch(`${base}/api/share/export?template=quota_streak&week=2026-10-07&hide=streak`)).status).toBe(409);
    expect((await fetch(`${base}/api/share/export?template=quota_streak&week=2026-10-07&token=${p.preview.token}`)).status).toBe(409); // toggle differs
    expect((await fetch(`${base}/api/share/export?template=quota_streak&week=2026-10-07&hide=streak&format=png&token=${p.preview.token}`)).status).toBe(400);
    const ok = await fetch(`${base}/api/share/export?template=quota_streak&week=2026-10-07&hide=streak&token=${p.preview.token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('image/svg+xml');
    expect(ok.headers.get('content-disposition')).toBe('attachment; filename="usage-card-quota-streak.svg"');
    const body = await ok.text();
    expect(body).not.toContain('streak without');
    expect(body).not.toMatch(/<\?xml|<metadata|<!--/);
    expect(logs.some(l => l.startsWith('[share] event=export_refused') && l.includes('error=preview_required'))).toBe(true);
    expect(logs).toContain('[share] event=export template=quota_streak fields=3/4 format=svg');
    expect(logs.join('\n')).not.toContain('private-alias');
  });

  it('rejects bad input', async () => {
    expect((await fetch(`${base}/api/share/card?template=costs`)).status).toBe(400);
    expect((await fetch(`${base}/api/share/card?template=provider_mix&hide=account_name`)).status).toBe(400);
    expect((await fetch(`${base}/api/share/card?template=provider_mix&tz=Nope/Zone`)).status).toBe(400);
    expect((await fetch(`${base}/api/share/card?template=provider_mix&referral=me@example.com`)).status).toBe(400);
  });

  it('logs the user share actions the browser reports, without a destination', async () => {
    expect((await fetch(`${base}/api/share/event?event=native_share&template=provider_mix&destination=mail.example.com`, { method: 'POST' })).status).toBe(204);
    expect((await fetch(`${base}/api/share/event?event=link_copied`, { method: 'POST' })).status).toBe(204);
    expect((await fetch(`${base}/api/share/event?event=export`, { method: 'POST' })).status).toBe(400);
    expect((await fetch(`${base}/api/share/event`, { method: 'POST' })).status).toBe(400);
    expect(logs).toEqual(['[share] event=native_share template=provider_mix', '[share] event=link_copied']);
  });
});

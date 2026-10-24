import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendToLedgerFile } from '../../collectors/ledgerFile.js';
import type { LedgerInput } from '../../ledger/types.js';
import type { PrivacyPreview } from '../../wrapped/render.js';
import { registerWrappedRoutes } from '../wrappedRoutes.js';

const W0 = Date.UTC(2026, 9, 5), DAY = 86_400_000, HOUR = 3_600_000;
const NOW = W0 + 8 * DAY;
const dir = mkdtempSync(join(tmpdir(), 'cw-wrapped-'));
const path = join(dir, 'ledger.jsonl');
const act = (at: number, o: Partial<LedgerInput> = {}): LedgerInput => ({
  schemaVersion: 1, kind: 'local_activity', provider: 'claude', accountAlias: 'private-alias', devicePseudonym: 'a1b2c3d4e5f60718',
  observedAt: at, ingestedAt: at + 1000, source: 'claude_code', confidence: 'medium', measurementMethod: 'local_log_parse',
  measures: { estimatedTokens: 10, requestCount: 2 }, ...o,
});

const app = express();
registerWrappedRoutes(app, () => path, () => NOW);
let server: Server; let base = '';
const ready = new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; resolve(); }); });

beforeEach(async () => {
  await ready;
  rmSync(path, { force: true });
  appendToLedgerFile(path, Array.from({ length: 7 }, (_v, d) => act(W0 + d * DAY + HOUR)), NOW);
});
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

describe('wrapped routes', () => {
  it('lists choices and builds a report with a privacy preview', async () => {
    const c = await (await fetch(`${base}/api/wrapped/choices`)).json() as { accounts: string[]; timeZone: string };
    expect(c).toMatchObject({ accounts: ['private-alias'], timeZone: 'UTC' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = await (await fetch(`${base}/api/wrapped?tz=Europe/Berlin&week=2026-10-07&providers=claude`)).json() as { report: { timeZone: string; period: { label: string } }; html: string; svg: string; preview: PrivacyPreview };
    expect(r.report.timeZone).toBe('Europe/Berlin');
    expect(r.report.period.label).toBe('2026-10-05 to 2026-10-11');
    expect(r.html).toContain('href="#definition-provider_mix"');
    expect(r.preview.token).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toContain('private-alias');
    const lines = log.mock.calls.map(x => String(x[0]));
    expect(lines.some(l => l.startsWith('[wrapped] event=preview'))).toBe(true);
    expect(lines.join('\n')).not.toContain('private-alias');
    log.mockRestore();
  });

  it('exports only with the current preview token', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const p = await (await fetch(`${base}/api/wrapped?week=2026-10-07`)).json() as { preview: PrivacyPreview };
    expect((await fetch(`${base}/api/wrapped/export?week=2026-10-07&format=pdf`)).status).toBe(409);
    expect((await fetch(`${base}/api/wrapped/export?week=2026-10-07&format=pdf&token=deadbeef`)).status).toBe(409);
    expect((await fetch(`${base}/api/wrapped/export?week=2026-10-07&format=gif&token=${p.preview.token}`)).status).toBe(400);
    const ok = await fetch(`${base}/api/wrapped/export?week=2026-10-07&format=pdf&token=${p.preview.token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/pdf');
    expect(ok.headers.get('content-disposition')).toBe('attachment; filename="usage-wrapped-2026-10-05.pdf"');
    expect(Buffer.from(await ok.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    const svg = await fetch(`${base}/api/wrapped/export?week=2026-10-07&format=svg&token=${p.preview.token}`);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    // Changing the selection changes the content, so the old token is refused.
    expect((await fetch(`${base}/api/wrapped/export?week=2026-10-07&names=1&format=svg&token=${p.preview.token}`)).status).toBe(409);
    const lines = log.mock.calls.map(x => String(x[0]));
    expect(lines.some(l => l.includes('event=export_refused') && l.includes('error=preview_required'))).toBe(true);
    expect(lines.some(l => l.includes('event=export ') && l.includes('format=pdf'))).toBe(true);
    log.mockRestore();
  });

  it('rejects invalid choices and works on an empty ledger', async () => {
    expect((await fetch(`${base}/api/wrapped?tz=Nope/Zone`)).status).toBe(400);
    expect((await fetch(`${base}/api/wrapped/choices?week=bad`)).status).toBe(400);
    expect((await fetch(`${base}/api/wrapped/choices?tz=Nope/Zone`)).status).toBe(400);
    expect((await fetch(`${base}/api/wrapped/export?providers=zzz&format=pdf`)).status).toBe(400);
    rmSync(path, { force: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = await (await fetch(`${base}/api/wrapped`)).json() as { report: { notices: Array<{ id: string }> } };
    expect(r.report.notices.map(n => n.id)).toContain('no_activity');
    log.mockRestore();
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import { registerRadarRoutes } from '../radarRoutes.js';

const dir = mkdtempSync(join(tmpdir(), 'cw-radar-'));
const app = express();
registerRadarRoutes(app, { prefsPath: () => join(dir, 'sub', 'prefs.json'), now: () => 1000 });
let server: Server; let base = '';
const ready = new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r(); }); });
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

describe('radar routes', () => {
  it('serves an empty beta view with the disclaimer', async () => {
    await ready;
    const v = await (await fetch(`${base}/api/radar`)).json() as { state: string; beta: boolean; disclaimer: string };
    expect(v).toMatchObject({ state: 'empty', beta: true });
    expect(v.disclaimer).toMatch(/not provider announcements/);
  });

  it('defaults notifications off, persists valid prefs and rejects invalid ones', async () => {
    await ready;
    expect(await (await fetch(`${base}/api/radar/prefs`)).json()).toMatchObject({ enabled: false });
    const body = { enabled: true, minConfidence: 0.75, providers: ['claude'], kinds: [], notifyOnResolved: true };
    const put = await fetch(`${base}/api/radar/prefs`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(put.status).toBe(200);
    expect(await (await fetch(`${base}/api/radar/prefs`)).json()).toEqual(body);
    const bad = await fetch(`${base}/api/radar/prefs`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, extra: 1 }) });
    expect(bad.status).toBe(400);
  });

  it('previews the diagnostic report and only exports after review', async () => {
    await ready;
    const p = await (await fetch(`${base}/api/radar/diagnostics`)).json() as { requiresReview: boolean; json: string };
    expect(p.requiresReview).toBe(true);
    expect((await fetch(`${base}/api/radar/diagnostics/export`)).status).toBe(400);
    const ok = await fetch(`${base}/api/radar/diagnostics/export?reviewed=yes`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(await ok.text())).toMatchObject({ schemaVersion: 1 });
  });

  it('reports remote config unavailable for rollback when none is wired', async () => {
    await ready;
    expect((await fetch(`${base}/api/radar/config/rollback`, { method: 'POST' })).status).toBe(404);
  });
});

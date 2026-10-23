import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendToLedgerFile, readLedgerFile } from '../../collectors/ledgerFile.js';
import { registerLedgerRoutes } from '../ledgerRoutes.js';
import type { LedgerInput } from '../../ledger/types.js';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const dir = mkdtempSync(join(tmpdir(), 'cw-ledger-'));
const path = join(dir, 'ledger.jsonl');
const mk = (at: number, o: Partial<LedgerInput> = {}): LedgerInput => ({
  schemaVersion: 1, kind: 'local_activity', provider: 'claude', accountAlias: 'work', devicePseudonym: 'a1b2c3d4e5f60718',
  observedAt: at, ingestedAt: at + 1000, source: 'claude_code', confidence: 'medium', measurementMethod: 'local_log_parse',
  measures: { estimatedTokens: 10, requestCount: 1 }, ...o,
});

const app = express();
registerLedgerRoutes(app, () => path, () => T0 + 60_000);
let server: Server; let base = '';
const ready = new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; resolve(); }); });

beforeEach(async () => {
  await ready;
  rmSync(path, { force: true });
  appendToLedgerFile(path, [mk(T0), mk(T0 + 1000, { provider: 'chatgpt', source: 'codex' })], T0 + 5000);
});
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

describe('ledger routes', () => {
  it('returns a view and applies filters', async () => {
    const all = await (await fetch(`${base}/api/ledger`)).json() as { matched: number; state: string };
    expect(all.matched).toBe(2);
    const some = await (await fetch(`${base}/api/ledger?provider=chatgpt`)).json() as { matched: number };
    expect(some.matched).toBe(1);
  });

  it('reports an empty ledger rather than failing', async () => {
    rmSync(path, { force: true });
    const v = await (await fetch(`${base}/api/ledger`)).json() as { state: string };
    expect(v.state).toBe('empty');
  });

  it('rejects invalid filters', async () => {
    const res = await fetch(`${base}/api/ledger?provider=nope`);
    expect(res.status).toBe(400);
    expect((await fetch(`${base}/api/ledger/export?from=9&to=1`)).status).toBe(400);
    expect((await fetch(`${base}/api/ledger?device=zz`, { method: 'DELETE' })).status).toBe(400);
  });

  it('exports JSON and CSV with the filter', async () => {
    const json = await (await fetch(`${base}/api/ledger/export?client=codex`)).json() as { count: number; rows: unknown[] };
    expect(json.count).toBe(1);
    const res = await fetch(`${base}/api/ledger/export?format=csv`);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect((await res.text()).trim().split('\n')).toHaveLength(3);
  });

  it('requires confirmation and deletes only what the filter selects', async () => {
    expect((await fetch(`${base}/api/ledger?provider=chatgpt`, { method: 'DELETE' })).status).toBe(400);
    const res = await fetch(`${base}/api/ledger?provider=chatgpt&confirm=yes`, { method: 'DELETE' });
    expect(await res.json()).toEqual({ ok: true, deleted: 1 });
    expect(readLedgerFile(path)).toHaveLength(1);
  });

  it('deletes everything only with confirm=all', async () => {
    expect((await fetch(`${base}/api/ledger?confirm=yes`, { method: 'DELETE' })).status).toBe(400);
    expect(readLedgerFile(path)).toHaveLength(2);
    const res = await fetch(`${base}/api/ledger?confirm=all`, { method: 'DELETE' });
    expect(await res.json()).toEqual({ ok: true, deleted: 2 });
    expect(readLedgerFile(path)).toHaveLength(0);
  });
});

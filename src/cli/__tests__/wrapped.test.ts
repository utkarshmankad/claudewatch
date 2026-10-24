import { describe, expect, it } from 'vitest';
import { append } from '../../ledger/ledger.js';
import type { LedgerInput } from '../../ledger/types.js';
import { runWrapped, type WrappedCliIo } from '../commands/wrapped.js';

const W0 = Date.UTC(2026, 9, 5), DAY = 86_400_000;
const act = (at: number): LedgerInput => ({
  schemaVersion: 1, kind: 'local_activity', provider: 'claude', accountAlias: 'work-secret', devicePseudonym: 'a1b2c3d4e5f60718',
  observedAt: at, ingestedAt: at + 1000, source: 'claude_code', confidence: 'medium', measurementMethod: 'local_log_parse',
  measures: { estimatedTokens: 10, requestCount: 2 },
});
const records = append([], Array.from({ length: 7 }, (_v, d) => act(W0 + d * DAY + 3_600_000))).records;

function harness(answer = true) {
  const out: string[] = []; const written: Array<{ path: string; body: string | Buffer }> = [];
  const io: WrappedCliIo = { records, now: W0 + 8 * DAY, log: s => out.push(s), ask: async () => answer, write: (path, body) => { written.push({ path, body }); } };
  return { io, out, written };
}
const token = (out: string[]) => /Preview token: ([0-9a-f]{64})/.exec(out.join('\n'))?.[1];

describe('claudewatch wrapped', () => {
  it('prints the report with statuses and definitions and writes nothing without --out', async () => {
    const h = harness();
    expect(await runWrapped({ week: '2026-10-07' }, h.io)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('Provider mix: claude 100%');
    expect(text).toContain('[measured] (definition: provider_mix)');
    expect(text).toContain('[unavailable]');
    expect(text).not.toContain('work-secret');
    expect(h.written).toEqual([]);
  });

  it('shows the privacy preview and writes only after the user agrees', async () => {
    const yes = harness(true);
    expect(await runWrapped({ week: '2026-10-07', format: 'svg', out: 'r.svg' }, yes.io)).toBe(0);
    expect(yes.out.join('\n')).toContain('Privacy preview');
    expect(yes.written).toHaveLength(1);
    expect(String(yes.written[0].body)).toContain('<svg');
    const no = harness(false);
    expect(await runWrapped({ week: '2026-10-07', out: 'r.html' }, no.io)).toBe(1);
    expect(no.written).toEqual([]);
    expect(no.out.join('\n')).toContain('Nothing written.');
  });

  it('accepts a matching token and rejects a stale one', async () => {
    const first = harness();
    await runWrapped({ week: '2026-10-07' }, first.io);
    const t = token(first.out);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    const good = harness(false);
    expect(await runWrapped({ week: '2026-10-07', format: 'pdf', out: 'r.pdf', confirm: t as string }, good.io)).toBe(0);
    expect(good.written[0].path).toBe('r.pdf');
    const bad = harness(true);
    expect(await runWrapped({ week: '2026-10-07', out: 'r.html', confirm: 'nope' }, bad.io)).toBe(1);
    expect(bad.written).toEqual([]);
  });

  it('reports invalid input and unsupported formats without writing', async () => {
    const h = harness();
    expect(await runWrapped({ timeZone: 'Nope/Zone' }, h.io)).toBe(1);
    expect(h.out.join('\n')).toContain('invalid_time_zone');
    const f = harness();
    expect(await runWrapped({ week: '2026-10-07', format: 'gif', out: 'x' }, f.io)).toBe(1);
    expect(f.out.join('\n')).toContain('invalid_format');
    expect(f.written).toEqual([]);
  });
});

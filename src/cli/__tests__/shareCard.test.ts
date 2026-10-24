import { describe, expect, it } from 'vitest';
import { append } from '../../ledger/ledger.js';
import type { LedgerInput } from '../../ledger/types.js';
import { runShareCard, type ShareCardCliIo } from '../commands/shareCard.js';

const W0 = Date.UTC(2026, 9, 5), DAY = 86_400_000, HOUR = 3_600_000;
const base0 = { schemaVersion: 1, provider: 'claude', accountAlias: 'work-secret', devicePseudonym: 'a1b2c3d4e5f60718', confidence: 'medium' } as const;
const records = append([], Array.from({ length: 7 }, (_v, d): LedgerInput[] => [
  { ...base0, kind: 'local_activity', observedAt: W0 + d * DAY + HOUR, ingestedAt: W0 + d * DAY + 2 * HOUR, source: 'claude_code', measurementMethod: 'local_log_parse', measures: { estimatedTokens: 10, requestCount: 9876 } },
  { ...base0, kind: 'provider_snapshot', confidence: 'high', observedAt: W0 + d * DAY + 2 * HOUR, ingestedAt: W0 + d * DAY + 3 * HOUR, source: 'web', measurementMethod: 'provider_reported', measures: { quotaPercentUsed: 20 }, window: { type: 'five_hour', resetAt: W0 + d * DAY + 6 * HOUR } },
]).flat()).records;

function harness(answer = true) {
  const out: string[] = []; const written: Array<{ path: string; body: string }> = [];
  const io: ShareCardCliIo = { records, now: W0 + 8 * DAY, log: s => out.push(s), ask: async () => answer, write: (path, body) => { written.push({ path, body }); } };
  return { io, out, written };
}
const token = (out: string[]) => /Preview token: ([0-9a-f]{64})/.exec(out.join('\n'))?.[1];

describe('claudewatch share-card', () => {
  it('shows fields with toggles and the privacy preview, and writes nothing without --out', async () => {
    const h = harness();
    expect(await runShareCard({ template: 'quota_streak', week: '2026-10-07' }, h.io)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('[x] streak: 7-day streak without hitting a limit');
    expect(text).toContain('Privacy preview');
    expect(text).toContain('[share] event=preview template=quota_streak fields=4/4');
    for (const s of ['work-secret', 'a1b2c3d4e5f60718', '9876', 'claude_code']) expect(text).not.toContain(s);
    expect(h.written).toEqual([]);
  });

  it('writes only after the user agrees, and honours toggles', async () => {
    const yes = harness(true);
    expect(await runShareCard({ template: 'quota_streak', week: '2026-10-07', hide: ['streak'], out: 'c.svg' }, yes.io)).toBe(0);
    expect(yes.written).toHaveLength(1);
    expect(yes.written[0]?.body).toContain('<svg');
    expect(yes.written[0]?.body).not.toContain('streak without');
    expect(yes.out.join('\n')).toContain('[share] event=export template=quota_streak fields=3/4 format=svg');
    const no = harness(false);
    expect(await runShareCard({ template: 'quota_streak', week: '2026-10-07', out: 'c.svg' }, no.io)).toBe(1);
    expect(no.written).toEqual([]);
    expect(no.out.join('\n')).toContain('error=not_confirmed');
  });

  it('accepts a matching token only for the same toggles', async () => {
    const first = harness();
    await runShareCard({ template: 'provider_mix', week: '2026-10-07' }, first.io);
    const t = token(first.out) as string;
    const good = harness(false);
    expect(await runShareCard({ template: 'provider_mix', week: '2026-10-07', out: 'c.svg', confirm: t }, good.io)).toBe(0);
    const changed = harness(true);
    expect(await runShareCard({ template: 'provider_mix', week: '2026-10-07', show: ['providers_used'], out: 'c.svg', confirm: t }, changed.io)).toBe(1);
    expect(changed.written).toEqual([]);
  });

  it('keeps optional fields off until switched on and reports bad input', async () => {
    const h = harness();
    await runShareCard({ template: 'interruption_prevention', week: '2026-10-07', prevented: 2 }, h.io);
    expect(h.out.join('\n')).toContain('[ ] prevented_count: 2 interruptions avoided (off by default)');
    const r = harness();
    await runShareCard({ template: 'provider_mix', week: '2026-10-07', referralCode: 'K7M2P9QX4T' }, r.io);
    expect(r.out.join('\n')).toContain('[ ] referral: Referral code K7M2P9QX4T (off by default)');
    for (const [o, msg] of [[{}, 'Choose a template'], [{ template: 'costs' }, 'invalid_template'], [{ template: 'provider_mix', timeZone: 'Nope/Zone' }, 'invalid_time_zone'], [{ template: 'provider_mix', hide: ['nope'] }, 'unknown_field'], [{ template: 'provider_mix', referralCode: 'x@y' }, 'invalid_referral_code']] as const) {
      const b = harness();
      expect(await runShareCard({ week: '2026-10-07', ...o }, b.io)).toBe(1);
      expect(b.out.join('\n')).toContain(msg);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { ledgerLines, summarizeLedger } from '../popup/ledger-summary.mjs';

const t = (_key, subs, fallback) => fallback;
const fresh = { stale: false, ok: true };
const stats = (over = {}) => ({
  providerUsage: { claude: { pct5h: 42.4, pct7d: 10 } },
  providerHealth: { claude: fresh },
  ...over,
});

describe('summarizeLedger', () => {
  it('is an error state without stats', () => {
    expect(summarizeLedger({ stats: null }).state).toBe('error');
  });

  it('is empty with no readings and no activity', () => {
    expect(summarizeLedger({ stats: { providerUsage: {}, providerHealth: {} }, activity: { enabled: true, counts24h: {} } }).state).toBe('empty');
  });

  it('is partial when browser activity collection is off', () => {
    const s = summarizeLedger({ stats: stats(), activity: { enabled: false, counts24h: {} } });
    expect(s.state).toBe('partial');
    expect(s.activityEnabled).toBe(false);
    expect(s.rows[0].observedMessages24h).toBeNull();
  });

  it('is ok with a fresh provider reading and activity on', () => {
    expect(summarizeLedger({ stats: stats(), activity: { enabled: true, counts24h: { claude: 3 } } }).state).toBe('ok');
  });

  it('is stale when a shown provider is stale or failed', () => {
    const a = { enabled: true, counts24h: {} };
    expect(summarizeLedger({ stats: stats({ providerHealth: { claude: { stale: true } } }), activity: a }).state).toBe('stale');
    expect(summarizeLedger({ stats: stats({ providerHealth: { claude: { ok: false } } }), activity: a }).state).toBe('stale');
  });

  it('shows providers that only have local activity as partial', () => {
    const s = summarizeLedger({ stats: stats(), activity: { enabled: true, counts24h: { gemini: 2 } } });
    expect(s.rows.map((r) => r.key)).toEqual(['claude', 'gemini']);
    expect(s.state).toBe('partial');
  });
});

describe('ledgerLines', () => {
  it('labels every figure with where it came from and never claims exact billing', () => {
    const s = summarizeLedger({ stats: stats(), activity: { enabled: true, counts24h: { claude: 3 } } });
    const [line] = ledgerLines(s, t);
    expect(line.text).toBe('Provider-reported: 5h 42%, 7d 10% · Estimated from 3 message(s) seen here in 24h');
    expect(line.text.toLowerCase()).not.toMatch(/exact|billed|charged|invoice/);
  });

  it('formats tiny values without implying zero', () => {
    const s = summarizeLedger({ stats: stats({ providerUsage: { claude: { pct5h: 0.4, pct7d: null } } }), activity: { enabled: true, counts24h: {} } });
    expect(ledgerLines(s, t)[0].text).toBe('Provider-reported: 5h < 1%');
  });
});

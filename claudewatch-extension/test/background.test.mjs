import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Inline pure helpers from background.js (mirrored from lib/parsers.mjs) ──
// background.js is not an ES module, so we test its pure logic here.

function detectPlan(data) {
  const s = (typeof data === 'string' ? data : JSON.stringify(data)).toLowerCase();
  if (s.includes('max_20') || s.includes('max20'))         return 'max20x';
  if (s.includes('max_5')  || s.includes('max5'))          return 'max5x';
  if (s.includes('claude_max') || s.includes('"max"'))     return 'max';
  if (s.includes('claude_pro') || s.includes('"pro"')
      || s.includes("'pro'")   || s.includes('pro_plan'))  return 'pro';
  if (s.includes('claude_free')|| s.includes('"free"')
      || s.includes('free_plan'))                           return 'free';
  return null;
}

function extractRateLimitFromResponse(data) {
  if (!data || typeof data !== 'object') return null;

  function fromWindows(windows) {
    if (!windows || typeof windows !== 'object') return null;
    const win5h = windows['5h'];
    const win7d = windows['7d'];
    if (!win5h && !win7d) return null;
    return {
      resetsAt:      win5h?.resets_at ? new Date(win5h.resets_at * 1000).toISOString() : null,
      resetsAt7d:    win7d?.resets_at ? new Date(win7d.resets_at * 1000).toISOString() : null,
      utilization5h: win5h?.utilization ?? null,
      utilization7d: win7d?.utilization ?? null,
    };
  }

  const windowsSources = [
    data.windows,
    data.rate_limit?.windows,
    data.message_limit?.windows,
    data.limits?.windows,
    data.usage?.windows,
  ];
  for (const w of windowsSources) {
    const r = fromWindows(w);
    if (r && (r.resetsAt || r.utilization5h != null)) {
      return {
        type:      data.type ?? data.rate_limit?.type ?? data.message_limit?.type ?? null,
        remaining: data.remaining ?? data.rate_limit?.remaining
                   ?? data.message_limit?.remaining ?? null,
        ...r,
      };
    }
  }

  const candidates = [
    data.rate_limit, data.rateLimit, data.message_limit,
    data.account?.rate_limit, data.usage?.rate_limit,
    data.limits?.rate_limit, data.limits,
    data.current_period, data.window, data.usage_window,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const resetsAt = c.resetsAt ?? c.resets_at ?? c.reset_at
                   ?? c.windowResetsAt ?? c.window_resets_at
                   ?? c.period_end ?? c.current_period_end ?? null;
    if (resetsAt) {
      return { type: c.type ?? null, resetsAt, remaining: c.remaining ?? c.messages_remaining ?? null };
    }
  }
  return null;
}

function mergeRateLimitState(existing, newInfo, authoritative = false) {
  const merged = { ...existing };
  if (authoritative) {
    merged.type = newInfo.type ?? null;
    merged.remaining = newInfo.remaining ?? null;
  }
  for (const [key, value] of Object.entries(newInfo)) {
    if (value != null) merged[key] = value;
  }
  return merged;
}

// ── Per-site token aggregation (logic mirrored from background.getStats) ───

const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;

function computeSiteBreakdown(history, startMs, now) {
  const SITES = ['claude', 'chatgpt', 'gemini'];
  const breakdown = {};
  for (const s of SITES) {
    const sh = history.filter(e => (e.site ?? 'claude') === s);
    breakdown[s] = {
      tokens5h: sh.filter(e => e.ts >= startMs).reduce((acc, e) => acc + e.input + e.output, 0),
      tokens7d: sh.filter(e => e.ts >= now - WINDOW_7D_MS).reduce((acc, e) => acc + e.input + e.output, 0),
    };
  }
  return breakdown;
}

function getActiveSite(history) {
  if (!history.length) return null;
  return history[history.length - 1].site ?? 'claude';
}

// ── mergeTokenHistory dedup logic ───────────────────────────────────────────

function mergeTokenHistory(existing, newEvents) {
  const BUCKET = 10_000;
  const bucketSet = new Set(existing.map(e => Math.round(e.ts / BUCKET)));
  let added = 0;
  for (const ev of newEvents) {
    const b = Math.round(ev.ts / BUCKET);
    if (!bucketSet.has(b)) {
      existing.push(ev);
      bucketSet.add(b);
      added++;
    }
  }
  existing.sort((a, b) => a.ts - b.ts);
  return added;
}

// ── Allowed origin check ────────────────────────────────────────────────────

const ALLOWED_PREFIXES = [
  'https://claude.ai/',
  'https://chatgpt.com/',
  'https://chat.openai.com/',
  'https://gemini.google.com/',
];

function isFromAllowedSite(tabUrl) {
  return tabUrl ? ALLOWED_PREFIXES.some(p => tabUrl.startsWith(p)) : false;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('detectPlan', () => {
  it('detects max20x from string containing max_20', () => {
    expect(detectPlan('plan: max_20')).toBe('max20x');
    expect(detectPlan({ type: 'claude_max20' })).toBe('max20x');
  });
  it('detects pro from claude_pro', () => {
    expect(detectPlan({ plan: 'claude_pro' })).toBe('pro');
  });
  it('returns null for no match', () => {
    expect(detectPlan({ foo: 'bar' })).toBe(null);
  });
});

describe('extractRateLimitFromResponse', () => {
  it('handles nested windows', () => {
    const data = {
      type: 'approaching_limit',
      windows: { '5h': { resets_at: 1700000000, utilization: 0.85 } },
    };
    const r = extractRateLimitFromResponse(data);
    expect(r.type).toBe('approaching_limit');
    expect(r.utilization5h).toBe(0.85);
  });

  it('handles rate_limit flat object with resetsAt', () => {
    const data = { rate_limit: { resetsAt: '2024-06-01T00:00:00.000Z' } };
    const r = extractRateLimitFromResponse(data);
    expect(r.resetsAt).toBe('2024-06-01T00:00:00.000Z');
  });

  it('returns null for empty object', () => {
    expect(extractRateLimitFromResponse({})).toBe(null);
  });
});

describe('rate-limit state reconciliation', () => {
  it('clears a stale message warning when authoritative cloud usage no longer reports it', () => {
    const existing = { type: 'approaching_limit', remaining: 5, utilization5h: 92 };
    const cloud = { type: null, remaining: null, utilization5h: 15, resetsAt: '2026-10-06T12:00:00Z' };
    expect(mergeRateLimitState(existing, cloud, true)).toMatchObject({
      type: null,
      remaining: null,
      utilization5h: 15,
    });
  });

  it('preserves transient warning fields when merging a partial stream update', () => {
    const existing = { type: 'approaching_limit', remaining: 5, utilization5h: 85 };
    expect(mergeRateLimitState(existing, { resetsAt: '2026-10-06T12:00:00Z' })).toMatchObject({
      type: 'approaching_limit',
      remaining: 5,
      utilization5h: 85,
    });
  });
});

describe('computeSiteBreakdown', () => {
  const now = Date.now();
  const recent = now - 60_000;       // 1 min ago (within 5h window)
  const old    = now - 8 * 24 * 3600_000; // 8 days ago (outside 7d window)

  it('groups tokens by site', () => {
    const history = [
      { ts: recent, input: 100, output: 50, site: 'claude' },
      { ts: recent, input:  80, output: 40, site: 'chatgpt' },
      { ts: recent, input:  60, output: 30, site: 'gemini' },
    ];
    const bd = computeSiteBreakdown(history, now - WINDOW_5H_MS, now);
    expect(bd.claude.tokens5h).toBe(150);
    expect(bd.chatgpt.tokens5h).toBe(120);
    expect(bd.gemini.tokens5h).toBe(90);
  });

  it('old events outside 7d window are excluded from tokens7d', () => {
    const history = [
      { ts: old,    input: 200, output: 100, site: 'claude' },
      { ts: recent, input:  10, output:  5,  site: 'claude' },
    ];
    const bd = computeSiteBreakdown(history, now - WINDOW_5H_MS, now);
    expect(bd.claude.tokens7d).toBe(15);  // only the recent event
  });

  it('defaults missing site to claude', () => {
    const history = [
      { ts: recent, input: 50, output: 25 },  // no site field
    ];
    const bd = computeSiteBreakdown(history, now - WINDOW_5H_MS, now);
    expect(bd.claude.tokens5h).toBe(75);
    expect(bd.chatgpt.tokens5h).toBe(0);
  });

  it('returns zeros for sites with no data', () => {
    const bd = computeSiteBreakdown([], now - WINDOW_5H_MS, now);
    expect(bd.claude.tokens5h).toBe(0);
    expect(bd.chatgpt.tokens5h).toBe(0);
    expect(bd.gemini.tokens5h).toBe(0);
  });
});

describe('getActiveSite', () => {
  it('returns site of last event', () => {
    const history = [
      { ts: 1000, site: 'claude' },
      { ts: 2000, site: 'chatgpt' },
      { ts: 3000, site: 'gemini' },
    ];
    expect(getActiveSite(history)).toBe('gemini');
  });

  it('defaults to claude when site field is missing', () => {
    expect(getActiveSite([{ ts: 1000 }])).toBe('claude');
  });

  it('returns null for empty history', () => {
    expect(getActiveSite([])).toBe(null);
  });
});

// Bucket size = 10_000 ms, so events must be >10s apart to be distinct buckets
const T1 = 0;
const T2 = 15_000;  // 15s after T1 → different bucket
const T3 = 30_000;  // 15s after T2 → different bucket

describe('mergeTokenHistory (dedup)', () => {
  it('adds non-duplicate events', () => {
    const existing = [{ ts: T1, input: 10, output: 5 }];
    const added = mergeTokenHistory(existing, [
      { ts: T2, input: 20, output: 10 },
      { ts: T3, input: 30, output: 15 },
    ]);
    expect(added).toBe(2);
    expect(existing).toHaveLength(3);
  });

  it('deduplicates events within 10s bucket', () => {
    const existing = [{ ts: T1, input: 10, output: 5 }];
    const added = mergeTokenHistory(existing, [
      { ts: T1 + 1000, input: 20, output: 10 }, // same 10s bucket as T1
    ]);
    expect(added).toBe(0);
    expect(existing).toHaveLength(1);
  });

  it('sorts result by timestamp', () => {
    const existing = [{ ts: T3 }];
    mergeTokenHistory(existing, [{ ts: T1 }, { ts: T2 }]);
    expect(existing[0].ts).toBe(T1);
    expect(existing[1].ts).toBe(T2);
    expect(existing[2].ts).toBe(T3);
  });
});

describe('isFromAllowedSite', () => {
  it('allows claude.ai', () => {
    expect(isFromAllowedSite('https://claude.ai/chat/abc')).toBe(true);
  });
  it('allows chatgpt.com', () => {
    expect(isFromAllowedSite('https://chatgpt.com/c/abc')).toBe(true);
  });
  it('allows chat.openai.com', () => {
    expect(isFromAllowedSite('https://chat.openai.com/c/abc')).toBe(true);
  });
  it('allows gemini.google.com', () => {
    expect(isFromAllowedSite('https://gemini.google.com/app')).toBe(true);
  });
  it('rejects other origins', () => {
    expect(isFromAllowedSite('https://openai.com')).toBe(false);
    expect(isFromAllowedSite('https://google.com')).toBe(false);
    expect(isFromAllowedSite(null)).toBe(false);
    expect(isFromAllowedSite(undefined)).toBe(false);
  });
});

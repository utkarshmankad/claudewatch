import { describe, expect, it } from 'vitest';
import { append } from '../../ledger/ledger.js';
import type { LedgerInput, LedgerRecord } from '../../ledger/types.js';
import { METRIC_IDS } from '../definitions.js';
import type { PricingCatalog } from '../pricing.js';
import { EXPORT_FORMATS, exportReport, logLine, privacyPreview, renderHtml, renderPdf, renderSvg, reportLines, wrap } from '../render.js';
import { buildReport, isValidTimeZone, listChoices, resolveWeek, weekBounds, type ReportOptions, type WrappedReport } from '../report.js';

const DAY = 86_400_000, HOUR = 3_600_000;
const W0 = Date.UTC(2026, 9, 5); // Monday 2026-10-05, the reported week
const W1 = W0 + 7 * DAY;
const P0 = W0 - 7 * DAY; // previous week
const DEV = 'a1b2c3d4e5f60718', DEV2 = 'ffeeddccbbaa9988';
const NOW = W1 + 2 * HOUR; // the reported week has finished

const snap = (at: number, pct: number, resetAt: number, o: Partial<LedgerInput> = {}): LedgerInput => ({
  schemaVersion: 1, kind: 'provider_snapshot', provider: 'claude', accountAlias: 'work-secret', devicePseudonym: DEV,
  observedAt: at, ingestedAt: at + 1000, source: 'web', confidence: 'high', measurementMethod: 'provider_reported',
  measures: { quotaPercentUsed: pct }, window: { type: 'five_hour', resetAt }, ...o,
});
const act = (at: number, requests: number, o: Partial<LedgerInput> = {}): LedgerInput => ({
  schemaVersion: 1, kind: 'local_activity', provider: 'claude', accountAlias: 'work-secret', devicePseudonym: DEV,
  observedAt: at, ingestedAt: at + 1000, source: 'claude_code', confidence: 'medium', measurementMethod: 'local_log_parse',
  measures: { estimatedTokens: requests * 100, requestCount: requests }, ...o,
});
const ledger = (xs: LedgerInput[]): LedgerRecord[] => {
  const r = append([], xs);
  expect(r.rejected).toEqual([]);
  return r.records;
};
// Every day: activity plus a snapshot pair in one window, and a later pair in a new window (a reset).
const week = (start: number, days = 7, o: { peak?: number; src?: LedgerInput['source']; requests?: number } = {}): LedgerInput[] =>
  Array.from({ length: days }, (_v, d) => {
    const t = start + d * DAY;
    return [
      act(t + 2 * HOUR, o.requests ?? 5, { source: o.src ?? 'claude_code' }),
      snap(t + HOUR, 10, t + 5 * HOUR), snap(t + 4 * HOUR, o.peak ?? 40, t + 5 * HOUR),
      snap(t + 7 * HOUR, 5, t + 12 * HOUR), snap(t + 8 * HOUR, 20, t + 12 * HOUR),
    ];
  }).flat();

const catalog: PricingCatalog = {
  schemaVersion: 1,
  entries: [
    { provider: 'claude', planId: 'pro', currency: 'USD', region: 'US', amountMinor: 2000, billing: 'monthly', taxTreatment: 'excluded', sourceUrl: 'https://example.com/pricing', effectiveFrom: Date.UTC(2026, 0, 1) },
    { provider: 'claude', planId: 'max', currency: 'USD', region: 'US', amountMinor: 10000, billing: 'monthly', taxTreatment: 'excluded', sourceUrl: 'https://example.com/pricing', effectiveFrom: Date.UTC(2026, 0, 1) },
  ],
};

const build = (recs: LedgerRecord[], o: Partial<ReportOptions> = {}): WrappedReport => {
  const r = buildReport(recs, { now: NOW, week: '2026-10-07', ...o });
  if (!r.ok) throw new Error(r.error);
  return r.report;
};
const scenario = (r: WrappedReport) => ({ lines: reportLines(r), comparison: r.comparison, notices: r.notices.map(n => n.id), suggestions: r.suggestions.map(s => s.id), newUser: r.newUser, completeness: r.completeness });

describe('time zones and week selection', () => {
  it('finds Monday-start weeks in UTC and by local time', () => {
    expect(weekBounds(Date.UTC(2026, 9, 7, 12), 'UTC')).toEqual({ start: W0, end: W1 });
    // 23:30 UTC on Sunday is already Monday in Tokyo, so it belongs to the next week there.
    const sunLate = Date.UTC(2026, 9, 11, 23, 30);
    expect(weekBounds(sunLate, 'UTC').start).toBe(W0);
    expect(weekBounds(sunLate, 'Asia/Tokyo').start).toBe(Date.UTC(2026, 9, 11, 15)); // Mon 00:00 JST = Sun 15:00 UTC
  });
  it('handles daylight saving weeks with 167 and 169 hours', () => {
    const hours = (ts: number, tz: string) => { const w = weekBounds(ts, tz); return (w.end - w.start) / HOUR; };
    expect(hours(Date.UTC(2026, 9, 21), 'Europe/Berlin')).toBe(169); // clocks go back on Sunday 2026-10-25
    expect(hours(Date.UTC(2026, 9, 27), 'Europe/Berlin')).toBe(168);
    expect(hours(Date.UTC(2026, 2, 4), 'America/Los_Angeles')).toBe(167); // clocks go forward on Sunday 2026-03-08
    expect(hours(Date.UTC(2026, 2, 11), 'America/Los_Angeles')).toBe(168);
    expect(weekBounds(Date.UTC(2026, 2, 4), 'America/Los_Angeles').start).toBe(Date.UTC(2026, 2, 2, 8)); // Monday 00:00 PST
  });
  it('defaults to the last finished week and validates input', () => {
    expect(resolveWeek({ now: NOW, timeZone: 'UTC' })).toEqual({ ok: true, start: W0, end: W1 });
    expect(resolveWeek({ now: NOW, timeZone: 'UTC', week: '2026-02-30' })).toEqual({ ok: false, error: 'invalid_week' });
    expect(resolveWeek({ now: NOW, timeZone: 'UTC', week: 'yesterday' })).toEqual({ ok: false, error: 'invalid_week' });
    expect(resolveWeek({ now: NOW, timeZone: 'UTC', week: '2026-12-01' })).toEqual({ ok: false, error: 'week_in_future' });
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(buildReport([], { now: NOW, timeZone: 'Mars/Base' })).toEqual({ ok: false, error: 'invalid_time_zone' });
    expect(buildReport([], { now: NOW, providers: ['nope'] })).toEqual({ ok: false, error: 'invalid_provider' });
    expect(buildReport([], { now: NOW, week: 'x' })).toEqual({ ok: false, error: 'invalid_week' });
  });
  it('reports the chosen zone and week label', () => {
    const r = build([], { timeZone: 'Asia/Tokyo' });
    expect(r.timeZone).toBe('Asia/Tokyo');
    expect(r.period.label).toBe('2026-10-05 to 2026-10-11');
    expect(r.period.start).toBe(W0 - 9 * HOUR);
  });
});

describe('snapshots: report scenarios', () => {
  it('complete week with a complete previous week', () => {
    const r = build(ledger([...week(P0, 7, { peak: 30 }), ...week(W0, 7, { peak: 100 })]));
    expect(r.completeness.complete).toBe(true);
    expect(r.comparison.allowed).toBe(true);
    expect(scenario(r)).toMatchSnapshot();
  });
  it('partial week that has not finished', () => {
    const now = W0 + 3 * DAY + 2 * HOUR;
    const r = build(ledger([...week(P0), ...week(W0, 3)]), { now });
    expect(r.notices.map(n => n.id)).toContain('partial_week');
    expect(r.comparison).toEqual({ allowed: false, reasons: ['this_week_period_not_finished', 'this_week_sparse_data'] });
    expect(scenario(r)).toMatchSnapshot();
  });
  it('new user with a single week of data', () => {
    const r = build(ledger(week(W0)));
    expect(r.newUser).toBe(true);
    expect(r.comparison).toEqual({ allowed: false, reasons: ['no_earlier_data'] });
    expect(r.notices.map(n => n.id)).toContain('new_user');
    expect(scenario(r)).toMatchSnapshot();
  });
  it('high unattributed activity', () => {
    const r = build(ledger([...week(P0), ...week(W0, 7, { src: 'unattributed', requests: 8 }), ...Array.from({ length: 7 }, (_v, d) => act(W0 + d * DAY + 3 * HOUR, 1))]));
    expect(r.notices.map(n => n.id)).toContain('high_unattributed');
    expect(r.suggestions.map(s => s.id)).toContain('raise_attribution');
    expect(scenario(r)).toMatchSnapshot();
  });
  it('plan change during the week', () => {
    const planHistory = [
      { provider: 'claude' as const, accountAlias: 'work-secret', planId: 'pro', from: Date.UTC(2026, 0, 1) },
      { provider: 'claude' as const, accountAlias: 'work-secret', planId: 'max', from: W0 + 3 * DAY },
    ];
    const r = build(ledger([...week(P0), ...week(W0)]), { metrics: { catalog, planHistory, region: 'US' } });
    expect(r.notices.map(n => n.id)).toContain('plan_change');
    expect(scenario(r)).toMatchSnapshot();
  });
  it('week without any activity', () => {
    const r = build([]);
    expect(r.notices.map(n => n.id)).toContain('no_activity');
    for (const s of r.sections) for (const m of s.metrics) { expect(m.status).toBe('unavailable'); expect(m.valueText).toMatch(/^Unavailable/); }
    expect(scenario(r)).toMatchSnapshot();
  });
});

describe('weekly comparison gating', () => {
  it('refuses when the previous week is sparse, naming why', () => {
    const r = build(ledger([...week(P0, 2), ...week(W0)]));
    expect(r.comparison).toEqual({ allowed: false, reasons: ['previous_week_sparse_data'] });
  });
  it('refuses when the current week is sparse', () => {
    const r = build(ledger([...week(P0), ...week(W0, 2)]));
    expect(r.comparison.allowed).toBe(false);
    expect(r.comparison.allowed === false && r.comparison.reasons).toContain('this_week_sparse_data');
  });
  it('does not lower the coverage threshold: exactly below the default stays refused', () => {
    // 4 of 7 days is 0.571, under the 0.7 default
    expect(build(ledger([...week(P0), ...week(W0, 4)])).comparison.allowed).toBe(false);
    // 5 of 7 days is 0.714, which meets it
    expect(build(ledger([...week(P0), ...week(W0, 5)])).comparison.allowed).toBe(true);
  });
  it('computes deltas only for metrics available in both weeks', () => {
    const r = build(ledger([...week(P0, 7, { requests: 3, peak: 30 }), ...week(W0, 7, { requests: 5, peak: 100 })]));
    if (!r.comparison.allowed) throw new Error('expected comparison');
    const req = r.comparison.rows.find(x => x.label === 'Requests counted locally');
    expect(req).toMatchObject({ current: 35, previous: 21, delta: 14 });
    expect(r.comparison.rows.find(x => x.label === 'Windows at 100%')).toMatchObject({ current: 7, previous: 0, delta: 7 });
    expect(r.comparison.rows.every(x => x.label !== 'Forecast error' || Number.isFinite(x.delta))).toBe(true);
  });
});

describe('user choices', () => {
  const recs = ledger([
    ...week(W0), ...week(W0, 7, { requests: 2 }).map(x => ({ ...x, accountAlias: 'personal-secret', devicePseudonym: DEV2 })),
    ...Array.from({ length: 7 }, (_v, d) => act(W0 + d * DAY + 5 * HOUR, 4, { provider: 'chatgpt', source: 'codex' })),
  ]);
  it('lists the choices that exist', () => {
    const c = listChoices(recs, { now: NOW, week: '2026-10-07' });
    expect(c).toMatchObject({ accounts: ['personal-secret', 'work-secret'], providers: ['chatgpt', 'claude'], devices: [DEV, DEV2], timeZone: 'UTC' });
    expect(listChoices(recs, { now: NOW, timeZone: 'Nope/Zone' })).toEqual({ error: 'invalid_time_zone' });
    expect(listChoices(recs, { now: NOW, week: 'bad' })).toEqual({ error: 'invalid_week' });
  });
  it('filters by account, provider and device', () => {
    const all = build(recs);
    expect(all.selection).toMatchObject({ providers: ['chatgpt', 'claude'], devices: 2 });
    const mix = (r: WrappedReport) => r.sections[0].metrics[0].valueText;
    expect(mix(build(recs, { providers: ['chatgpt'] }))).toContain('chatgpt 100%');
    expect(mix(build(recs, { accounts: ['personal-secret'] }))).toContain('claude 100%');
    expect(mix(build(recs, { accounts: ['personal-secret'] }))).toContain('14 requests');
    expect(build(recs, { devices: [DEV2] }).selection.devices).toBe(1);
    expect(build(recs, { accounts: ['nobody'] }).notices.map(n => n.id)).toContain('no_activity');
  });
  it('hides account names unless asked', () => {
    const calibrated = { reconcile: { calibration: { low: 0.01, high: 0.03 } } };
    const hidden = build(recs, { metrics: calibrated });
    expect(JSON.stringify(hidden)).not.toContain('secret');
    expect(renderHtml(hidden) + renderSvg(hidden)).not.toContain('secret');
    const shown = build(recs, { includeAccountNames: true });
    expect(shown.selection.accounts).toEqual(['personal-secret', 'work-secret']);
    expect(privacyPreview(shown).warnings[0]).toMatch(/aliases/);
    expect(privacyPreview(hidden).warnings).toEqual([]);
  });
});

describe('metric transparency', () => {
  const r = build(ledger([...week(P0), ...week(W0)]), { metrics: { reconcile: { calibration: { low: 0.01, high: 0.03 } }, confirmedPrevented: 2 } });
  const html = renderHtml(r);
  it('shows every metric with a status label and a link to a definition that exists', () => {
    const metrics = r.sections.flatMap(s => s.metrics);
    expect(metrics.map(m => m.id).sort()).toEqual([...METRIC_IDS].sort());
    for (const m of metrics) {
      expect(['provider_reported', 'measured', 'estimated', 'unavailable']).toContain(m.status);
      expect(m.definitionHref).toBe(`#definition-${m.id}`);
      expect(html).toContain(`href="${m.definitionHref}"`);
      expect(html).toContain(`id="definition-${m.id}"`);
    }
    for (const label of ['Provider-reported', 'Measured locally', 'Unavailable']) expect(html).toContain(label);
    expect(r.sections.flatMap(s => s.metrics).find(m => m.id === 'prevented_interruptions')).toMatchObject({ status: 'measured', valueText: '2 confirmed by you' });
  });
  it('is accessible markup: language, landmarks, headings, table headers, captions', () => {
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<main>');
    expect(html).toContain('<h1>');
    expect(html).toContain('<caption');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect((html.match(/<h2 /g) ?? []).length).toBeGreaterThanOrEqual(7);
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).not.toMatch(/<script|<img|https?:\/\//);
  });
  it('escapes everything it prints', () => {
    const evil = build(ledger(week(W0)));
    evil.sections[0].metrics[0].valueText = '<img src=x onerror=alert(1)> & "q"';
    expect(renderHtml(evil)).not.toContain('<img');
    expect(renderHtml(evil)).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;');
    expect(renderSvg(evil)).not.toContain('<img');
  });
  it('never states a saving', () => {
    const shown = JSON.stringify({ s: r.sections, c: r.comparison, g: r.suggestions, n: r.notices }).toLowerCase();
    expect(shown).not.toMatch(/\bsav(e|ing)/);
  });
  it('suggestions are labelled as estimates and cite metrics', () => {
    const spare = build(ledger(week(W0, 7, { peak: 10 })));
    expect(html).not.toBe('');
    for (const s of spare.suggestions) expect(s.basedOn.length).toBeGreaterThan(0);
    expect(renderHtml(spare)).toContain('Estimated');
  });
  it('raises the spare-capacity suggestion only with enough resets and without recommending a plan change', () => {
    const s = build(ledger(week(W0, 7, { peak: 10 }))).suggestions.find(x => x.id === 'possible_spare_capacity');
    expect(s?.text).toMatch(/not a recommendation to change plan/);
  });
});

describe('export after privacy preview', () => {
  const r = build(ledger([...week(P0), ...week(W0)]));
  const p = privacyPreview(r);
  it('lists what is and is not included', () => {
    expect(p.includes.map(i => i.field)).toContain('Aggregated usage figures');
    expect(p.excludes.join(' ')).toMatch(/Device identifiers/);
    expect(p.token).toMatch(/^[0-9a-f]{64}$/);
  });
  it('refuses without a preview token and with a stale one', () => {
    expect(exportReport(r, 'pdf', undefined)).toEqual({ ok: false, error: 'preview_required' });
    expect(exportReport(r, 'pdf', 'abc')).toEqual({ ok: false, error: 'preview_stale' });
    expect(exportReport(r, 'gif', p.token)).toEqual({ ok: false, error: 'invalid_format' });
    const changed = build(ledger([...week(P0), ...week(W0, 6)]));
    expect(exportReport(changed, 'svg', p.token)).toEqual({ ok: false, error: 'preview_stale' });
  });
  it('exports html, svg and pdf from the previewed content', () => {
    for (const f of EXPORT_FORMATS) {
      const out = exportReport(r, f, p.token);
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      expect(out.filename).toBe(`usage-wrapped-2026-10-05.${f}`);
    }
  });
  it('writes a well-formed SVG image with a title and description', () => {
    const svg = renderSvg(r);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<title id="t">Usage Wrapped');
    expect(svg).toMatch(/definition:\s*<\/text>|definition: provider_mix|provider_mix\]/);
    expect(svg.trim().endsWith('</svg>')).toBe(true);
    expect((svg.match(/<text /g) ?? []).length).toBe((svg.match(/<\/text>/g) ?? []).length);
  });
  it('writes a structurally valid PDF with correct xref offsets', () => {
    const buf = renderPdf(r);
    const text = buf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trim().endsWith('%%EOF')).toBe(true);
    const start = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(start, start + 4)).toBe('xref');
    const entries = [...text.slice(start).matchAll(/(\d{10}) 00000 n /g)].map(m => Number(m[1]));
    entries.forEach((off, i) => expect(text.startsWith(`${i + 1} 0 obj\n`, off)).toBe(true));
    expect(entries.length).toBeGreaterThan(4);
    expect(text).toContain('Usage Wrapped, 2026-10-05 to 2026-10-11');
    expect(text).toContain('/Count ');
  });
  it('paginates long reports and neutralises PDF-special and non-Latin text', () => {
    const long = build(ledger(week(W0)), { includeAccountNames: true });
    long.notices.push({ id: 'x', text: 'paren ( ) back\\slash ünï 日本 ' + 'word '.repeat(2000) });
    const text = renderPdf(long).toString('latin1');
    expect(Number(/\/Count (\d+)/.exec(text)?.[1])).toBeGreaterThan(1);
    expect(text).toContain('paren \\( \\) back\\\\slash');
    expect(text).toContain('??');
  });
  it('never includes device identifiers in any format', () => {
    for (const f of EXPORT_FORMATS) {
      const out = exportReport(r, f, p.token);
      if (!out.ok) throw new Error('export failed');
      expect(out.body.toString('latin1')).not.toContain(DEV);
      expect(out.body.toString('latin1')).not.toContain('work-secret');
    }
  });
  it('wraps text without losing words', () => {
    expect(wrap('aa bb cc dd', 5)).toEqual(['aa bb', 'cc dd']);
    expect(wrap('', 5)).toEqual(['']);
    expect(wrap('longerthanwidth x', 5)).toEqual(['longerthanwidth', 'x']);
  });
});

describe('observability', () => {
  it('log lines carry states and counts only', () => {
    const r = build(ledger(week(W0)), { includeAccountNames: true });
    const line = logLine('export', r, { format: 'pdf' });
    expect(line).toMatch(/^\[wrapped\] event=export complete=true comparison=false newUser=true unavailable=\d+ notices=\S+ format=pdf$/);
    expect(line).not.toContain('work-secret');
    expect(line).not.toContain(DEV);
    expect(logLine('export_refused', r, { error: 'preview_stale' })).toContain('error=preview_stale');
  });
});

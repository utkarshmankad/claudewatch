import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { append } from '../../ledger/ledger.js';
import type { LedgerInput, LedgerRecord } from '../../ledger/types.js';
import { stripImageMetadata } from '../imageMetadata.js';
import type { ReportOptions } from '../report.js';
import {
  buildCard, cardInputsFrom, cardPreview, CARD_TEMPLATES, enabledFields, exportCard, leaks, prohibitedIn, renderCardSvg, stripSvgMetadata, svgText,
  type Card, type CardInputs,
} from '../shareCards.js';
import {
  attributeReferral, LocalShareLinkStore, MAX_LINK_TTL_MS, MIN_LINK_TTL_MS, newReferralCode, shareLogLine, SHARE_EVENTS,
} from '../shareLinks.js';

const DAY = 86_400_000, HOUR = 3_600_000;
const W0 = Date.UTC(2026, 9, 5); // Monday
const NOW = W0 + 7 * DAY + 2 * HOUR;

// Values that must never reach a card or its metadata.
const ALIAS = 'acme-corp-secret', DEVICE = 'a1b2c3d4e5f60718', RAW_COUNT = '4321';
const SENSITIVE = [ALIAS, DEVICE, 'claude_code', RAW_COUNT];

const snap = (at: number, pct: number, resetAt: number, o: Partial<LedgerInput> = {}): LedgerInput => ({
  schemaVersion: 1, kind: 'provider_snapshot', provider: 'claude', accountAlias: ALIAS, devicePseudonym: DEVICE,
  observedAt: at, ingestedAt: at + 1000, source: 'web', confidence: 'high', measurementMethod: 'provider_reported',
  measures: { quotaPercentUsed: pct }, window: { type: 'five_hour', resetAt }, ...o,
});
const act = (at: number, requests: number, o: Partial<LedgerInput> = {}): LedgerInput => ({
  schemaVersion: 1, kind: 'local_activity', provider: 'claude', accountAlias: ALIAS, devicePseudonym: DEVICE,
  observedAt: at, ingestedAt: at + 1000, source: 'claude_code', confidence: 'medium', measurementMethod: 'local_log_parse',
  measures: { estimatedTokens: requests * 100, requestCount: requests }, ...o,
});
const ledger = (xs: LedgerInput[]): LedgerRecord[] => { const r = append([], xs); expect(r.rejected).toEqual([]); return r.records; };
// peakOf(d) is the highest reading on day d. Each day has activity and two windows (the second after a reset).
const weekOf = (peakOf: (d: number) => number, days = 7, requests = 1000): LedgerInput[] => Array.from({ length: days }, (_v, d) => {
  const t = W0 + d * DAY;
  return [
    act(t + 2 * HOUR, requests), act(t + 3 * HOUR, 100, { provider: 'chatgpt', source: 'web' }),
    snap(t + HOUR, 10, t + 5 * HOUR), snap(t + 4 * HOUR, peakOf(d), t + 5 * HOUR),
    snap(t + 7 * HOUR, 5, t + 12 * HOUR), snap(t + 8 * HOUR, 20, t + 12 * HOUR),
  ];
}).flat();

const opts = (o: Partial<ReportOptions> = {}): ReportOptions => ({ now: NOW, week: '2026-10-07', ...o });
const inputsOf = (recs: LedgerRecord[], o: Partial<ReportOptions> = {}) => {
  const r = cardInputsFrom(recs, opts(o));
  if (!r.ok) throw new Error(r.error);
  return r;
};
const cardOf = (inputs: CardInputs, t: string, o = {}): Card => {
  const r = buildCard(inputs, t, o);
  if (!r.ok) throw new Error(`${r.error} ${r.detail ?? ''}`);
  return r.card;
};
const allOn = (c: Card): Card => ({ ...c, fields: c.fields.map(x => ({ ...x, enabled: true })) });

const calm = ledger(weekOf(() => 40, 7, 1000).concat([act(W0 + 5 * HOUR, Number(RAW_COUNT))]));

describe('inputs and defaults', () => {
  it('derives coarse values from the ledger', () => {
    const { inputs } = inputsOf(calm);
    expect(inputs.periodLabel).toBe('2026-10-05');
    expect(inputs.partial).toBe(false);
    expect(inputs.providerShares?.map(s => s.provider)).toEqual(['claude', 'chatgpt']);
    expect(inputs.providerShares?.reduce((a, s) => a + s.percent, 0)).toBeGreaterThanOrEqual(99);
    expect(inputs.streakDays).toBe(7);
    expect(inputs.daysUnderLimitPercent).toBe(100);
    expect(inputs.windowsAtLimit).toBe(0);
    expect(inputs.preventedConfirmed).toBeNull(); // unknown, not zero
    expect(inputs.headroomPercent).toBeGreaterThan(0);
  });

  it('computes the longest streak and the share of days under the limit', () => {
    const { inputs } = inputsOf(ledger(weekOf(d => (d === 2 ? 100 : 40))));
    expect(inputs.streakDays).toBe(4); // days 3..6
    expect(inputs.daysUnderLimitPercent).toBe(86);
    expect(inputs.windowsAtLimit).toBe(1);
  });

  it('marks a partial week and handles a missing week', () => {
    const partial = cardInputsFrom(ledger(weekOf(() => 40, 3)), { now: W0 + 3 * DAY, week: '2026-10-05' });
    expect(partial.ok && partial.inputs.partial).toBe(true);
    expect(cardInputsFrom(calm, opts({ timeZone: 'Not/AZone' }))).toEqual({ ok: false, error: 'invalid_time_zone' });
    expect(cardInputsFrom(calm, opts({ week: '2030-01-07' }))).toEqual({ ok: false, error: 'week_in_future' });
  });

  it('offers nothing for a template with no data instead of showing zeros', () => {
    const { inputs } = inputsOf(ledger([]));
    for (const t of CARD_TEMPLATES) expect(buildCard(inputs, t)).toEqual({ ok: false, error: 'nothing_to_share' });
    const noPrevented = inputsOf(calm).inputs;
    expect(cardOf(noPrevented, 'interruption_prevention').fields.map(x => x.id)).not.toContain('prevented_any');
  });

  it('rejects unknown templates and fields', () => {
    const { inputs } = inputsOf(calm);
    expect(buildCard(inputs, 'cost_summary')).toEqual({ ok: false, error: 'invalid_template' });
    expect(buildCard(inputs, 'provider_mix', { hide: ['account'] })).toEqual({ ok: false, error: 'unknown_field', detail: 'account' });
  });
});

describe('templates', () => {
  const { inputs } = inputsOf(calm);
  const confirmed = inputsOf(calm, { metrics: { confirmedPrevented: 3 } }).inputs;

  it('provider mix defaults to percentages only', () => {
    const c = cardOf(inputs, 'provider_mix');
    expect(enabledFields(c).map(x => x.text)).toEqual(['Week of 2026-10-05', expect.stringMatching(/^claude \d+%$/), expect.stringMatching(/^chatgpt \d+%$/)]);
    expect(c.fields.find(x => x.id === 'providers_used')?.enabled).toBe(false);
  });

  it('quota streak shows achievements', () => {
    const c = cardOf(inputs, 'quota_streak');
    expect(enabledFields(c).map(x => x.text)).toEqual(['Week of 2026-10-05', '7-day streak without hitting a limit', '100% of tracked days stayed under the limit', 'No quota window reached 100%']);
  });

  it('interruption prevention needs a confirmed count and keeps the number off by default', () => {
    const c = cardOf(confirmed, 'interruption_prevention');
    expect(enabledFields(c).map(x => x.id)).toContain('prevented_any');
    expect(c.fields.find(x => x.id === 'prevented_count')).toMatchObject({ enabled: false, defaultOn: false, text: '3 interruptions avoided' });
    expect(enabledFields(c).map(x => x.text).join(' ')).not.toMatch(/\b3\b/);
  });

  it('usage patterns keep the activity cadence off by default', () => {
    const c = cardOf(inputs, 'usage_patterns');
    expect(c.fields.find(x => x.id === 'active_days')).toMatchObject({ enabled: false });
    expect(enabledFields(c).every(x => x.kind === 'percent' || x.kind === 'achievement' || x.kind === 'period')).toBe(true);
  });

  it('a partial week says so', () => {
    expect(cardOf({ ...inputs, partial: true }, 'provider_mix').fields[0]?.text).toBe('Week so far, from 2026-10-05');
  });

  it('per-field toggles switch fields off and on', () => {
    const c = cardOf(inputs, 'quota_streak', { hide: ['streak'], show: [] });
    expect(enabledFields(c).map(x => x.id)).not.toContain('streak');
    expect(renderCardSvg(c)).not.toContain('streak without');
    const withCount = cardOf(confirmed, 'interruption_prevention', { show: ['prevented_count'] });
    expect(renderCardSvg(withCount)).toContain('3 interruptions avoided');
    expect(buildCard(inputs, 'quota_streak', { hide: ['period', 'streak', 'days_under_limit', 'no_limit_hit'] })).toEqual({ ok: false, error: 'nothing_to_share' });
  });
});

describe('prohibited fields never render or enter metadata', () => {
  const src = inputsOf(calm, { metrics: { confirmedPrevented: 3 } });
  const everything = CARD_TEMPLATES.map(t => allOn(cardOf(src.inputs, t, { referralCode: 'K7M2P9QX4T' })));

  it('keeps the sensitive fixture values out of every field, image and preview, with every toggle on', () => {
    expect(src.sensitive).toEqual(expect.arrayContaining(SENSITIVE.slice(0, 3)));
    for (const c of everything) {
      const svg = renderCardSvg(c);
      const exported = exportCard(c, 'svg', cardPreview(c).token, src.sensitive);
      expect(exported.ok).toBe(true);
      const pv = cardPreview(c);
      const hay = [JSON.stringify(c), svg, JSON.stringify({ f: pv.fields, i: pv.includes }), exported.ok ? exported.body : '', exported.ok ? exported.filename : ''].join('\n').toLowerCase();
      for (const s of [...SENSITIVE, 'project', 'cost', 'price', 'work hours', 'prompt']) expect(hay, `${c.template}: ${s}`).not.toContain(s.toLowerCase());
      expect(hay).not.toMatch(/[$€£¥]/);
      expect(hay).not.toMatch(/\b\d{1,2}:\d{2}\b/);
      expect(svgText(svg).join(' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, '').replace(/Referral code \w+/g, '')).not.toMatch(/\d{4,}/);
      expect(leaks(svg, src.sensitive)).toEqual([]);
    }
  });

  it('only percent, achievement, period and referral text appears, and no raw numbers above three digits except dates', () => {
    for (const c of everything) {
      for (const x of c.fields) {
        expect(['percent', 'achievement', 'period', 'referral']).toContain(x.kind);
        expect(prohibitedIn(x.text, x.kind), x.id).toBeNull();
      }
    }
  });

  it('refuses to build or export when prohibited content appears', () => {
    const { inputs } = src;
    expect(buildCard({ ...inputs, providerShares: [{ provider: 'claude $4.20', percent: 60 }] }, 'provider_mix')).toMatchObject({ ok: false, error: 'prohibited_content' });
    expect(buildCard({ ...inputs, providerShares: [{ provider: 'claude at 09:30', percent: 60 }] }, 'provider_mix')).toMatchObject({ ok: false, error: 'prohibited_content' });
    expect(buildCard({ ...inputs, providerShares: [{ provider: `claude ${RAW_COUNT}`, percent: 60 }] }, 'provider_mix')).toMatchObject({ ok: false, error: 'prohibited_content' });
    expect(buildCard({ ...inputs, providerShares: [{ provider: 'claude /home/me/project', percent: 60 }] }, 'provider_mix')).toMatchObject({ ok: false, error: 'prohibited_content' });
    expect(buildCard({ ...inputs, providerShares: [{ provider: 'claude 12 requests', percent: 60 }] }, 'provider_mix')).toMatchObject({ ok: false, error: 'prohibited_content' });
    // An alias that slips into text is caught by the final leak check even when the structure looks safe.
    const sneaky = cardOf({ ...inputs, providerShares: [{ provider: ALIAS, percent: 60 }] }, 'provider_mix');
    expect(exportCard(sneaky, 'svg', cardPreview(sneaky).token, src.sensitive)).toEqual({ ok: false, error: 'prohibited_content' });
  });

  it('allows provider names in the leak check but not account or device values', () => {
    const svg = renderCardSvg(cardOf(src.inputs, 'provider_mix'));
    expect(leaks(svg, ['claude', 'chatgpt'])).toEqual([]);
    expect(leaks(svg.replace('claude', DEVICE), [DEVICE])).toContain('sensitive_value');
  });

  it('writes no metadata into the image', () => {
    for (const c of everything) {
      const svg = exportCard(c, 'svg', cardPreview(c).token)
      expect(svg.ok).toBe(true);
      const body = svg.ok ? svg.body : '';
      expect(body).not.toMatch(/<\?xml|<!--|<metadata|<!DOCTYPE|rdf:|dc:|cc:|inkscape|sodipodi|xlink|<script|<image|href=|data-/i);
      expect(body.startsWith('<svg')).toBe(true);
      // Only title, desc, rect and text elements, and every text node comes from an enabled field or the fixed caption.
      expect([...new Set([...body.matchAll(/<([a-z]+)\b/g)].map(m => m[1]))].sort()).toEqual(['desc', 'g', 'rect', 'svg', 'text', 'title']);
      const allowed = new Set([c.title, ...enabledFields(c).map(x => x.text), 'Percentages and achievements only. Made locally with ClaudeWatch.']);
      for (const t of svgText(body)) {
        if (t === [c.title, ...enabledFields(c).map(x => x.text)].join('. ')) continue; // the accessible description
        expect(allowed.has(t), t).toBe(true);
      }
    }
  });

  it('removes injected metadata from SVG', () => {
    const dirty = '<?xml version="1.0"?><!DOCTYPE svg><!-- by me, /home/me --><svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="x" inkscape:version="1"><metadata><rdf:RDF><dc:creator>Me</dc:creator></rdf:RDF></metadata><text>ok</text></svg>';
    const clean = stripSvgMetadata(dirty);
    expect(clean).toBe('<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>');
    expect(stripSvgMetadata(clean)).toBe(clean);
  });
});

// --- raster metadata ---------------------------------------------------------------------------

const crcTable = Array.from({ length: 256 }, (_v, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const png = (extra: Array<[string, string]>) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    ...extra.map(([t, d]) => chunk(t, Buffer.from(d, 'latin1'))),
    chunk('IDAT', deflateSync(Buffer.from([0, 128]))), chunk('IEND', Buffer.alloc(0)),
  ]);
};
const pngTypes = (b: Buffer) => { const t: string[] = []; for (let p = 8; p < b.length; p += 12 + b.readUInt32BE(p)) t.push(b.toString('latin1', p + 4, p + 8)); return t; };

describe('image metadata stripping', () => {
  it('keeps only drawing chunks of a PNG', () => {
    const dirty = png([['tEXt', 'Author\0Utkarsh'], ['iTXt', 'XML:com.adobe.xmp\0secret'], ['eXIf', 'GPS 51.5N'], ['tIME', '\x07\xea\x0a\x0a\0\0\0'], ['pHYs', '\0\0\x0b\x13\0\0\x0b\x13\x01'], ['zTXt', 'Software\0x'], ['iCCP', 'profile\0\0x']]);
    expect(pngTypes(dirty)).toContain('tEXt');
    const r = stripImageMetadata(dirty);
    expect(r.ok && r.format).toBe('png');
    const body = r.ok ? r.body : Buffer.alloc(0);
    expect(pngTypes(body)).toEqual(['IHDR', 'IDAT', 'IEND']);
    for (const s of ['Author', 'Utkarsh', 'GPS', 'Software', 'XML:com', 'secret']) expect(body.toString('latin1')).not.toContain(s);
  });

  it('drops trailing data after IEND and rejects corrupt input', () => {
    const r = stripImageMetadata(Buffer.concat([png([]), Buffer.from('TRAILING-SECRET')]));
    expect(r.ok && r.body.toString('latin1')).not.toContain('TRAILING-SECRET');
    expect(stripImageMetadata(Buffer.from('not an image'))).toEqual({ ok: false, error: 'unsupported_or_corrupt' });
    expect(stripImageMetadata(png([]).subarray(0, 30))).toEqual({ ok: false, error: 'unsupported_or_corrupt' });
  });

  it('drops EXIF, XMP, ICC and comments from a JPEG but keeps the picture data', () => {
    const seg = (m: number, d: Buffer) => { const l = Buffer.alloc(2); l.writeUInt16BE(d.length + 2); return Buffer.concat([Buffer.from([0xff, m]), l, d]); };
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), seg(0xe1, Buffer.from('Exif\0\0GPS-SECRET')), seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0author')),
      seg(0xe2, Buffer.from('ICC_PROFILE\0')), seg(0xed, Buffer.from('Photoshop 3.0\0iptc')), seg(0xfe, Buffer.from('comment-secret')),
      seg(0xdb, Buffer.alloc(65, 1)), Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x00, 0x11, 0x22, 0x33, 0xff, 0xd9, 0x00, 0x00]),
    ]);
    const r = stripImageMetadata(jpeg);
    expect(r.ok && r.format).toBe('jpeg');
    const out = r.ok ? r.body.toString('latin1') : '';
    for (const s of ['GPS-SECRET', 'adobe', 'author', 'ICC_PROFILE', 'Photoshop', 'comment-secret']) expect(out).not.toContain(s);
    expect(out).toContain('JFIF');
    expect(r.ok && r.body.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00]))).toEqual({ ok: false, error: 'unsupported_or_corrupt' });
  });

  it('cleans SVG text input', () => {
    const r = stripImageMetadata('<?xml version="1.0"?><!-- secret --><svg xmlns="http://www.w3.org/2000/svg"><metadata>x</metadata></svg>');
    expect(r.ok && r.body.toString()).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(stripImageMetadata('<html></html>')).toEqual({ ok: false, error: 'unsupported_or_corrupt' });
  });
});

describe('preview gate', () => {
  const { inputs, sensitive } = inputsOf(calm);
  const card = cardOf(inputs, 'provider_mix');

  it('exports only against the current preview token', () => {
    expect(exportCard(card, 'svg', undefined)).toEqual({ ok: false, error: 'preview_required' });
    expect(exportCard(card, 'svg', 'deadbeef')).toEqual({ ok: false, error: 'preview_stale' });
    expect(exportCard(card, 'png', cardPreview(card).token)).toEqual({ ok: false, error: 'invalid_format' });
    const ok = exportCard(card, 'svg', cardPreview(card).token, sensitive);
    expect(ok).toMatchObject({ ok: true, mime: 'image/svg+xml', filename: 'usage-card-provider-mix.svg' });
  });

  it('a toggle changes the token, so an earlier preview cannot export the changed card', () => {
    const before = cardPreview(card).token;
    const changed = cardOf(inputs, 'provider_mix', { show: ['providers_used'] });
    expect(cardPreview(changed).token).not.toBe(before);
    expect(exportCard(changed, 'svg', before)).toEqual({ ok: false, error: 'preview_stale' });
  });

  it('lists every field with its toggle state, what is included and what is excluded', () => {
    const p = cardPreview(card);
    expect(p.fields.map(x => x.id)).toEqual(card.fields.map(x => x.id));
    expect(p.fields.find(x => x.id === 'providers_used')).toMatchObject({ enabled: false, defaultOn: false });
    expect(p.includes.map(x => x.detail)).toEqual(enabledFields(card).map(x => x.text));
    expect(p.excludes.join(' ')).toMatch(/request or token counts.*Account names.*Device names.*work hours.*Project names.*Costs.*Client or tool names.*metadata/s);
    expect(p.note).toContain('no link is created');
  });

  it('warns about the referral code, and keeps it off unless added and switched on', () => {
    expect(card.fields.some(x => x.id === 'referral')).toBe(false);
    const withCode = cardOf(inputs, 'provider_mix', { referralCode: 'K7M2P9QX4T' });
    expect(withCode.fields.find(x => x.id === 'referral')).toMatchObject({ enabled: false });
    expect(renderCardSvg(withCode)).not.toContain('K7M2P9QX4T');
    const on = cardOf(inputs, 'provider_mix', { referralCode: 'K7M2P9QX4T', show: ['referral'] });
    expect(renderCardSvg(on)).toContain('Referral code K7M2P9QX4T');
    expect(cardPreview(on).warnings.join(' ')).toContain('referral code');
    expect(buildCard(inputs, 'provider_mix', { referralCode: 'me@example.com' })).toEqual({ ok: false, error: 'invalid_referral_code' });
  });

  it('escapes text in the image', () => {
    const c = cardOf(inputs, 'provider_mix');
    c.fields[1] = { ...c.fields[1]!, text: 'a <b> & "c"' };
    expect(renderCardSvg(c)).toContain('a &lt;b&gt; &amp; &quot;c&quot;');
  });
});

describe('instrumentation, referral and links', () => {
  it('log lines carry names and counts only, never a destination or any extra property', () => {
    const line = shareLogLine('native_share', { template: 'provider_mix', fieldsOn: 3, fieldsTotal: 4, destination: 'mail.example.com', url: 'https://x.test', account: ALIAS } as never);
    expect(line).toBe('[share] event=native_share template=provider_mix fields=3/4');
    expect(shareLogLine('export', { format: 'svg', template: 'Bad Template;rm' })).toBe('[share] event=export format=svg');
    expect(shareLogLine('export_refused', { error: 'preview_stale' })).toBe('[share] event=export_refused error=preview_stale');
    expect(SHARE_EVENTS).toEqual(['preview', 'export', 'export_refused', 'native_share', 'link_created', 'link_copied', 'link_deleted', 'referral_attributed']);
  });

  it('referral codes are random, opaque and valid; attribution logs only validity', () => {
    const a = newReferralCode(), b = newReferralCode();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(a).not.toBe(b);
    const log = vi.fn();
    expect(attributeReferral(a, log)).toEqual({ valid: true });
    expect(attributeReferral('not a code', log)).toEqual({ valid: false });
    expect(log.mock.calls.map(c => c[0])).toEqual(['[share] event=referral_attributed referral=valid', '[share] event=referral_attributed referral=invalid']);
    expect(JSON.stringify(log.mock.calls)).not.toContain(a);
  });

  it('public links are off unless separately enabled, and need a reviewed card and an expiry', () => {
    const t = 1_000_000;
    const log = vi.fn();
    const off = new LocalShareLinkStore({ enabled: false, now: () => t, log });
    expect(off.create({ previewToken: 'tok', ttlMs: DAY })).toEqual({ ok: false, error: 'links_disabled' });
    const s = new LocalShareLinkStore({ enabled: true, now: () => t, log });
    expect(s.create({ previewToken: undefined, ttlMs: DAY })).toEqual({ ok: false, error: 'preview_required' });
    expect(s.create({ previewToken: 'tok', ttlMs: undefined })).toEqual({ ok: false, error: 'expiry_required' });
    expect(s.create({ previewToken: 'tok', ttlMs: MIN_LINK_TTL_MS - 1 })).toEqual({ ok: false, error: 'invalid_expiry' });
    expect(s.create({ previewToken: 'tok', ttlMs: MAX_LINK_TTL_MS + 1 })).toEqual({ ok: false, error: 'invalid_expiry' });
    expect(s.create({ previewToken: 'tok', ttlMs: Number.NaN })).toEqual({ ok: false, error: 'invalid_expiry' });
    const made = s.create({ previewToken: 'tok', ttlMs: DAY });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.link.url).toBeNull(); // no service exists; nothing is published
    expect(made.link.expiresAt).toBe(t + DAY);
    expect(JSON.stringify(made.link)).not.toContain('"tok"');
    expect(s.list()).toHaveLength(1);
    expect(s.delete(made.link.id)).toBe(true);
    expect(s.delete(made.link.id)).toBe(false);
    expect(s.list()).toEqual([]);
    expect(log.mock.calls.map(c => c[0])).toEqual(['[share] event=link_created', '[share] event=link_deleted']);
  });

  it('links expire', () => {
    let t = 0;
    const s = new LocalShareLinkStore({ enabled: true, now: () => t, log: () => undefined });
    s.create({ previewToken: 'a', ttlMs: MIN_LINK_TTL_MS });
    s.create({ previewToken: 'b', ttlMs: MAX_LINK_TTL_MS });
    t = MIN_LINK_TTL_MS;
    expect(s.list()).toHaveLength(1);
    expect(s.purge()).toBe(0);
  });
});

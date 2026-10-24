import { currentView } from '../ledger/ledger.js';
import type { LedgerRecord } from '../ledger/types.js';
import { computePeriodMetrics } from './metrics.js';
import { contentHash, isValidTimeZone, localDayStarts, resolveWeek, select, type ReportOptions } from './report.js';

// Opt-in, privacy-safe share cards (Prompt 5.3, operation key 2026-10-10.1/prompt-5.3).
// Pure: ledger records in, a card model, an SVG image and a privacy preview out. Nothing is sent anywhere.
// A card can only hold the field kinds below, so raw request counts, account names, device names, work times,
// project names, costs and client details have no place to live. Rules: docs/SHARE_CARDS.md.

export const CARD_VERSION = 1;
export const CARD_TEMPLATES = ['provider_mix', 'quota_streak', 'interruption_prevention', 'usage_patterns'] as const;
export type CardTemplate = (typeof CARD_TEMPLATES)[number];
export const CARD_EXPORT_FORMATS = ['svg'] as const; // PNG made in the browser must pass stripImageMetadata (imageMetadata.ts)

/** The only kinds of content a card field may hold. */
export type FieldKind = 'percent' | 'achievement' | 'period' | 'referral';

export interface CardField { id: string; label: string; kind: FieldKind; text: string; defaultOn: boolean; enabled: boolean }
export interface Card { version: number; template: CardTemplate; title: string; fields: CardField[] }

export const TEMPLATE_TITLES: Record<CardTemplate, string> = {
  provider_mix: 'My AI provider mix', quota_streak: 'My quota streak',
  interruption_prevention: 'Interruptions avoided', usage_patterns: 'My AI usage patterns',
};

/** What the card builder reads. Every value is already coarse: percentages, booleans or small achievement counts. */
export interface CardInputs {
  periodLabel: string; partial: boolean;
  providerShares: Array<{ provider: string; percent: number }> | null; // whole percent, largest first
  streakDays: number | null; daysUnderLimitPercent: number | null; windowsAtLimit: number | null;
  preventedConfirmed: number | null; headroomPercent: number | null; forecastWithinPoints: number | null; activeDaysPercent: number | null;
}

// --- inputs from the ledger -------------------------------------------------------------------

export function cardInputsFrom(all: LedgerRecord[], o: ReportOptions): { ok: true; inputs: CardInputs; sensitive: string[] } | { ok: false; error: string } {
  const timeZone = o.timeZone ?? 'UTC';
  if (!isValidTimeZone(timeZone)) return { ok: false, error: 'invalid_time_zone' };
  const w = resolveWeek({ now: o.now, timeZone, ...(o.week !== undefined ? { week: o.week } : {}) });
  if (!w.ok) return w;
  const records = select(all, o);
  const m = computePeriodMetrics(records, { ...(o.metrics ?? {}), start: w.start, end: w.end, now: o.now });

  const label = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(w.start));
  const shares = m.providerMix.value
    ? m.providerMix.value.map(s => ({ provider: s.key, percent: Math.round(s.share * 100) })).filter(s => s.percent > 0) : null;

  // Streak: consecutive local days that have provider readings and none reached 100%.
  const snaps = currentView(records).filter(r => r.kind === 'provider_snapshot' && r.measures.quotaPercentUsed !== undefined && r.effectiveObservedAt >= w.start && r.effectiveObservedAt < Math.min(w.end, o.now + 1));
  const days = localDayStarts(w.start, w.end, timeZone).map((s, i, a) => {
    const e = a[i + 1] ?? w.end;
    const day = snaps.filter(r => r.effectiveObservedAt >= s && r.effectiveObservedAt < e);
    return day.length === 0 ? 'none' : day.some(r => (r.measures.quotaPercentUsed as number) >= 100) ? 'hit' : 'ok';
  });
  let best = 0, run = 0;
  for (const d of days) { run = d === 'ok' ? run + 1 : 0; best = Math.max(best, run); }
  const tracked = days.filter(d => d !== 'none').length;
  const okDays = days.filter(d => d === 'ok').length;

  const inputs: CardInputs = {
    periodLabel: label, partial: m.completeness.reasons.includes('period_not_finished'),
    providerShares: shares && shares.length ? shares : null,
    streakDays: tracked > 0 ? best : null,
    daysUnderLimitPercent: tracked > 0 ? Math.round((okDays / tracked) * 100) : null,
    windowsAtLimit: m.quotaRiskEvents.value?.windowsAtLimit ?? null,
    preventedConfirmed: m.preventedInterruptions.value,
    headroomPercent: m.unusedQuota.value ? Math.round(m.unusedQuota.value.meanPercent) : null,
    forecastWithinPoints: m.forecastAccuracy.value ? Math.round(m.forecastAccuracy.value.maePoints) : null,
    activeDaysPercent: m.completeness.daysWithData > 0 ? Math.round(m.completeness.dayCoverage * 100) : null,
  };
  // Values that must never appear on a card; used as a last-line leak check on the final image.
  const sensitive = [...new Set([...all.map(r => r.accountAlias), ...all.map(r => r.devicePseudonym), ...all.map(r => r.source)])];
  return { ok: true, inputs, sensitive };
}

// --- building cards ---------------------------------------------------------------------------

const f = (id: string, label: string, kind: FieldKind, text: string, defaultOn = true): CardField => ({ id, label, kind, text, defaultOn, enabled: defaultOn });

function fieldsFor(t: CardTemplate, i: CardInputs): CardField[] {
  const out: CardField[] = [f('period', 'Week', 'period', `${i.partial ? 'Week so far, from' : 'Week of'} ${i.periodLabel}`)];
  if (t === 'provider_mix') {
    if (i.providerShares) {
      for (const s of i.providerShares) out.push(f(`provider_${s.provider}`, `Share for ${s.provider}`, 'percent', `${s.provider} ${s.percent}%`));
      out.push(f('providers_used', 'Number of providers used', 'achievement', `Used ${i.providerShares.length} AI provider${i.providerShares.length === 1 ? '' : 's'}`, false));
    }
  } else if (t === 'quota_streak') {
    if (i.streakDays !== null && i.streakDays >= 2) out.push(f('streak', 'Streak in days', 'achievement', `${i.streakDays}-day streak without hitting a limit`));
    if (i.daysUnderLimitPercent !== null) out.push(f('days_under_limit', 'Days under the limit', 'percent', `${i.daysUnderLimitPercent}% of tracked days stayed under the limit`));
    if (i.windowsAtLimit === 0 && i.streakDays !== null) out.push(f('no_limit_hit', 'No limit reached', 'achievement', 'No quota window reached 100%'));
  } else if (t === 'interruption_prevention') {
    if (i.preventedConfirmed !== null && i.preventedConfirmed >= 1) {
      out.push(f('prevented_any', 'Interruption avoided', 'achievement', 'Avoided an interruption (confirmed by me)'));
      out.push(f('prevented_count', 'Number avoided', 'achievement', `${i.preventedConfirmed} interruption${i.preventedConfirmed === 1 ? '' : 's'} avoided`, false));
    }
    if (i.headroomPercent !== null) out.push(f('headroom', 'Quota left at reset', 'percent', `About ${i.headroomPercent}% of quota left at reset`));
    if (i.windowsAtLimit === 0 && i.streakDays !== null) out.push(f('no_limit_hit', 'No limit reached', 'achievement', 'No quota window reached 100%'));
  } else {
    if (i.headroomPercent !== null) out.push(f('headroom', 'Quota left at reset', 'percent', `Typically ${i.headroomPercent}% of quota left at reset`));
    if (i.forecastWithinPoints !== null) out.push(f('forecast', 'Forecast accuracy', 'achievement', `Usage forecasts landed within ${i.forecastWithinPoints} quota points`));
    if (i.providerShares && i.providerShares.length > 1) out.push(f('multi_provider', 'Uses several providers', 'achievement', `Uses ${i.providerShares.length} AI providers`));
    if (i.activeDaysPercent !== null) out.push(f('active_days', 'Share of days with activity', 'percent', `Active on ${i.activeDaysPercent}% of days`, false));
  }
  return out;
}

export interface CardOptions {
  hide?: string[]; // field ids switched off
  show?: string[]; // field ids switched on (including default-off fields)
  referralCode?: string; // adds a default-off 'referral' field
}

export type CardResult = { ok: true; card: Card } | { ok: false; error: 'invalid_template' | 'unknown_field' | 'nothing_to_share' | 'invalid_referral_code' | 'prohibited_content'; detail?: string };

export function buildCard(inputs: CardInputs, template: string, o: CardOptions = {}): CardResult {
  if (!(CARD_TEMPLATES as readonly string[]).includes(template)) return { ok: false, error: 'invalid_template' };
  const t = template as CardTemplate;
  const fields = fieldsFor(t, inputs);
  if (fields.length <= 1) return { ok: false, error: 'nothing_to_share' }; // only the week line: no data for this template
  if (o.referralCode !== undefined) {
    if (!REFERRAL_RE.test(o.referralCode)) return { ok: false, error: 'invalid_referral_code' };
    fields.push(f('referral', 'Referral code', 'referral', `Referral code ${o.referralCode}`, false));
  }
  const ids = new Set(fields.map(x => x.id));
  const unknown = [...(o.hide ?? []), ...(o.show ?? [])].find(id => !ids.has(id));
  if (unknown !== undefined) return { ok: false, error: 'unknown_field', detail: unknown };
  for (const x of fields) {
    if (o.show?.includes(x.id)) x.enabled = true;
    if (o.hide?.includes(x.id)) x.enabled = false;
  }
  for (const x of fields) {
    const bad = prohibitedIn(x.text, x.kind);
    if (bad) return { ok: false, error: 'prohibited_content', detail: `${x.id}:${bad}` };
  }
  if (!fields.some(x => x.enabled && x.id !== 'period')) return { ok: false, error: 'nothing_to_share' };
  return { ok: true, card: { version: CARD_VERSION, template: t, title: TEMPLATE_TITLES[t], fields } };
}

export const REFERRAL_RE = /^[0-9A-HJKMNP-TV-Z]{8,12}$/; // opaque random code; never derived from an account (see shareLinks.ts)

/** Structural check on text that is about to be shown: no money, clock times, long numbers (raw counts) or paths. */
export function prohibitedIn(text: string, kind: FieldKind): string | null {
  if (/[$€£¥]|\b(usd|eur|gbp)\b/i.test(text)) return 'currency';
  if (/\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(am|pm)\b/i.test(text)) return 'clock_time';
  if (/[\\/]|@|https?:/i.test(text)) return 'path_or_address';
  if (kind !== 'period' && kind !== 'referral' && /\d{4,}/.test(text)) return 'long_number';
  if (/\b(requests?|tokens?|calls?|messages?|prompts?)\b/i.test(text) && /\d/.test(text)) return 'raw_count';
  return null;
}

export const enabledFields = (c: Card) => c.fields.filter(x => x.enabled);

// --- rendering --------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const W = 1200, H = 630;

/** A 1200x630 SVG. Contains only the title and enabled field text: no XML declaration, comments, metadata or generated ids. */
export function renderCardSvg(c: Card): string {
  const on = enabledFields(c);
  const period = on.find(x => x.kind === 'period');
  const body = on.filter(x => x.kind !== 'period');
  const size = body.length > 4 ? 44 : 56;
  const step = size + 34;
  const y0 = 250;
  const lines = body.map((x, i) => `<text x="80" y="${y0 + i * step}" font-size="${size}" font-weight="700">${esc(x.text)}</text>`).join('\n');
  const desc = [c.title, ...on.map(x => x.text)].join('. ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d" font-family="Helvetica, Arial, sans-serif">
<title id="t">${esc(c.title)}</title><desc id="d">${esc(desc)}</desc>
<rect width="100%" height="100%" fill="#14213d"/><g fill="#ffffff">
<text x="80" y="120" font-size="40" font-weight="700">${esc(c.title)}</text>
${period ? `<text x="80" y="170" font-size="26" fill="#c7d2fe">${esc(period.text)}</text>` : ''}
${lines}
<text x="80" y="${H - 40}" font-size="22" fill="#c7d2fe">Percentages and achievements only. Made locally with ClaudeWatch.</text>
</g></svg>
`;
}

/** Text a viewer would read from a finished SVG (title, desc and text elements). */
export function svgText(svg: string): string[] {
  return [...svg.matchAll(/<(?:text|title|desc)\b[^>]*>([^<]*)<\/(?:text|title|desc)>/g)].map(m => (m[1] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
}

// --- privacy preview and gated export ---------------------------------------------------------

export interface CardPreview {
  token: string; // hash of exactly the image that would be written; export requires it
  fields: Array<{ id: string; label: string; text: string; enabled: boolean; defaultOn: boolean }>; // per-field toggles
  includes: Array<{ field: string; detail: string }>;
  excludes: string[];
  warnings: string[];
  note: string;
}

export const CARD_EXCLUDES = [
  'Raw request or token counts', 'Account names and aliases', 'Device names and identifiers', 'Times of day or work hours of any activity',
  'Project names, prompts and file paths', 'Costs, prices and plan names', 'Client or tool names and any per-client breakdown',
  'Image metadata (author, software, timestamps, location, comments)',
];

export function cardPreview(c: Card): CardPreview {
  const on = enabledFields(c);
  const warnings: string[] = [];
  if (on.some(x => x.kind === 'referral')) warnings.push('The referral code is included. Anyone who sees the card can use it.');
  if (on.some(x => x.kind === 'achievement' && x.id === 'prevented_count')) warnings.push('The number of avoided interruptions is included.');
  return {
    token: contentHash({ v: CARD_VERSION, svg: renderCardSvg(c) }),
    fields: c.fields.map(x => ({ id: x.id, label: x.label, text: x.text, enabled: x.enabled, defaultOn: x.defaultOn })),
    includes: on.map(x => ({ field: x.label, detail: x.text })),
    excludes: CARD_EXCLUDES, warnings,
    note: 'Nothing is uploaded and no link is created. A public link is a separate, optional step with an expiry.',
  };
}

export type CardExport = { ok: true; format: 'svg'; mime: string; filename: string; body: string } | { ok: false; error: 'preview_required' | 'preview_stale' | 'invalid_format' | 'prohibited_content' };

export function exportCard(c: Card, format: string, previewToken: string | undefined, sensitive: readonly string[] = []): CardExport {
  if (!(CARD_EXPORT_FORMATS as readonly string[]).includes(format)) return { ok: false, error: 'invalid_format' };
  if (!previewToken) return { ok: false, error: 'preview_required' };
  if (previewToken !== cardPreview(c).token) return { ok: false, error: 'preview_stale' };
  const body = stripSvgMetadata(renderCardSvg(c));
  if (leaks(body, sensitive).length) return { ok: false, error: 'prohibited_content' };
  return { ok: true, format: 'svg', mime: 'image/svg+xml', filename: `usage-card-${c.template.replace(/_/g, '-')}.svg`, body };
}

/** Sensitive values (account aliases, device ids, client names) found as whole words in the image text. Provider names are allowed. */
export function leaks(svg: string, sensitive: readonly string[], allowed: readonly string[] = ['claude', 'chatgpt', 'gemini']): string[] {
  const text = svgText(svg).join('\n').toLowerCase();
  const re = (v: string) => new RegExp(`(^|[^a-z0-9])${v.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
  const bad = sensitive.filter(v => v.length >= 3 && !allowed.includes(v.toLowerCase()) && re(v).test(text));
  const structural = svgText(svg).map(t => prohibitedIn(t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, 'DATE').replace(/Referral code [0-9A-Z]+/g, 'Referral code'), 'percent')).filter((x): x is string => x !== null);
  return [...bad.map(() => 'sensitive_value'), ...structural];
}

/** Removes every `open`..`close` span with linear scans; an unterminated span drops the rest. Repeats so removal cannot splice a new `open` together. */
export function removeDelimited(input: string, open: string, close: string): string {
  let s = input;
  for (let i = s.indexOf(open); i !== -1; i = s.indexOf(open)) {
    const j = s.indexOf(close, i + open.length);
    s = j === -1 ? s.slice(0, i) : s.slice(0, i) + s.slice(j + close.length);
  }
  return s;
}

/** Removes anything from an SVG that is not drawing content: XML declaration, DOCTYPE, comments, processing instructions, metadata blocks and editor namespaces. */
export function stripSvgMetadata(svg: string): string {
  return removeDelimited(removeDelimited(svg, '<?', '?>'), '<!--', '-->')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<metadata\b[\s\S]*?<\/metadata>/gi, '')
    .replace(/<(rdf|cc|dc|sodipodi|inkscape):[a-z]+\b[\s\S]*?(?:\/>|<\/\1:[a-z]+>)/gi, '')
    .replace(/\s(?:xmlns:(?!xlink)[a-z]+|(?:inkscape|sodipodi|rdf|cc|dc):[a-z-]+)="[^"]*"/gi, '')
    .replace(/^\s+/, '');
}

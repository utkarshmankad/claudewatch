import { contentHash, type WrappedReport } from './report.js';
import type { MetricStatus } from './definitions.js';

// Renders a WrappedReport to accessible HTML, an SVG image and a PDF, and gates export behind a privacy preview
// (Prompt 5.2, operation key 2026-10-10.1/prompt-5.2). No dependencies; nothing is sent anywhere.

export const STATUS_TEXT: Record<MetricStatus, string> = {
  provider_reported: 'Provider-reported', measured: 'Measured locally', estimated: 'Estimated', unavailable: 'Unavailable',
};
export const EXPORT_FORMATS = ['html', 'svg', 'pdf'] as const; // PNG is made from the SVG in the browser panel
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// One line model feeds every format, so what the user previews is what every export contains.
export type Line =
  | { kind: 'title' | 'h2' | 'text' | 'note'; text: string }
  | { kind: 'metric'; label: string; text: string; status: MetricStatus; id: string };

const fmtDate = (ts: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));

export function reportLines(r: WrappedReport): Line[] {
  const L: Line[] = [{ kind: 'title', text: `Usage Wrapped, ${r.period.label}` }];
  L.push({ kind: 'text', text: `Time zone ${r.timeZone}. Generated on ${r.generatedOn} on this device. Providers: ${r.selection.providers.join(', ') || 'none'}. Accounts: ${r.selection.accounts.join(', ') || 'none'}. Devices: ${r.selection.devices}.` });
  for (const n of r.notices) L.push({ kind: 'note', text: n.text });
  for (const s of r.sections) {
    L.push({ kind: 'h2', text: s.title });
    for (const m of s.metrics) L.push({ kind: 'metric', label: m.label, text: m.valueText, status: m.status, id: m.id });
  }
  L.push({ kind: 'h2', text: 'Compared with the previous week' });
  if (r.comparison.allowed) {
    if (r.comparison.rows.length === 0) L.push({ kind: 'text', text: 'Both weeks are complete, but no metric is available in both.' });
    for (const c of r.comparison.rows) L.push({ kind: 'text', text: `${c.label}: ${c.current} now, ${c.previous} before (${c.delta >= 0 ? '+' : ''}${c.delta} ${c.unit}).` });
  } else L.push({ kind: 'text', text: `No comparison shown: ${r.comparison.reasons.map(x => x.replace(/_/g, ' ')).join('; ')}. Comparisons need both weeks to be complete.` });
  L.push({ kind: 'h2', text: 'Suggested changes' });
  if (r.suggestions.length === 0) L.push({ kind: 'text', text: 'No suggestions for this week.' });
  for (const s of r.suggestions) L.push({ kind: 'text', text: `${s.text} (Estimated, based on ${s.basedOn.join(', ')}.)` });
  L.push({ kind: 'h2', text: 'Definitions' });
  for (const g of r.glossary) L.push({ kind: 'text', text: `${g.name} (${g.id}): ${g.definition} ${g.caveat}${g.needsUserAction ? ' Needs your input.' : ''}` });
  return L;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function renderHtml(r: WrappedReport): string {
  const sec = r.sections.map(s => `<section aria-labelledby="s-${s.id}"><h2 id="s-${s.id}">${esc(s.title)}</h2>
<table><caption class="sr">${esc(s.title)} metrics</caption><thead><tr><th scope="col">Metric</th><th scope="col">Value</th><th scope="col">Status</th><th scope="col">Definition</th></tr></thead><tbody>
${s.metrics.map(m => `<tr><th scope="row">${esc(m.label)}</th><td>${esc(m.valueText)}</td><td><span class="st st-${m.status}">${STATUS_TEXT[m.status]}</span></td><td><a href="${m.definitionHref}">Definition of ${esc(m.label)}</a></td></tr>`).join('\n')}
</tbody></table></section>`).join('\n');
  const cmp = r.comparison.allowed
    ? `<ul>${r.comparison.rows.map(c => `<li>${esc(c.label)}: ${c.current} now, ${c.previous} before (${c.delta >= 0 ? '+' : ''}${c.delta} ${esc(c.unit)}). <a href="#definition-${c.metricId}">Definition</a></li>`).join('')}</ul>`
    : `<p>No comparison shown. Comparisons need both weeks to be complete: ${esc(r.comparison.reasons.map(x => x.replace(/_/g, ' ')).join('; '))}.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Usage Wrapped ${esc(r.period.label)}</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#555;--line:#c9c9c9;--acc:#0b57d0}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#f0f0f0;--mut:#b5b5b5;--line:#444;--acc:#8ab4f8}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;margin:0 auto;max-width:56rem;padding:1rem}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:.4rem;text-align:left;vertical-align:top}
a{color:var(--acc)}.st{border:1px solid var(--line);border-radius:.25rem;padding:0 .35rem;white-space:nowrap}
.sr{position:absolute;left:-9999px}.note{border-left:4px solid var(--acc);padding-left:.75rem}.mut{color:var(--mut)}
@media (max-width:40rem){table,thead,tbody,tr,th,td{display:block}thead{position:absolute;left:-9999px}}
</style></head><body><main>
<h1>Usage Wrapped, ${esc(r.period.label)}</h1>
<p class="mut">Time zone ${esc(r.timeZone)}. Generated on ${esc(r.generatedOn)} on this device from your local ledger. Accounts: ${esc(r.selection.accounts.join(', ') || 'none')}. Providers: ${esc(r.selection.providers.join(', ') || 'none')}.</p>
${r.notices.map(n => `<p class="note" role="note">${esc(n.text)}</p>`).join('\n')}
${sec}
<section aria-labelledby="s-cmp"><h2 id="s-cmp">Compared with the previous week</h2>${cmp}</section>
<section aria-labelledby="s-sug"><h2 id="s-sug">Suggested changes</h2>${r.suggestions.length ? `<ul>${r.suggestions.map(s => `<li>${esc(s.text)} <span class="st st-estimated">Estimated</span></li>`).join('')}</ul>` : '<p>No suggestions for this week.</p>'}</section>
<section aria-labelledby="s-def"><h2 id="s-def">Definitions</h2><dl>
${r.glossary.map(g => `<dt id="definition-${g.id}">${esc(g.name)}</dt><dd>${esc(g.definition)} <em>${esc(g.caveat)}</em>${g.needsUserAction ? ' Needs your input.' : ''}</dd>`).join('\n')}
</dl></section></main></body></html>
`;
}

// --- text wrapping shared by SVG and PDF ----------------------------------------------------

export function wrap(text: string, width: number): string[] {
  const out: string[] = []; let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + w.length > width) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}
const flat = (l: Line, width: number): Array<{ kind: Line['kind']; text: string }> =>
  l.kind === 'metric' ? wrap(`${l.label}: ${l.text} [${STATUS_TEXT[l.status]}; definition: ${l.id}]`, width).map(text => ({ kind: 'text' as const, text }))
    : wrap(l.text, width).map(text => ({ kind: l.kind, text }));

export function renderSvg(r: WrappedReport): string {
  const rows = reportLines(r).flatMap(l => flat(l, 96));
  const W = 800, pad = 24;
  let y = pad; const out: string[] = [];
  for (const row of rows) {
    const size = row.kind === 'title' ? 22 : row.kind === 'h2' ? 17 : 13;
    y += row.kind === 'h2' ? size + 12 : row.kind === 'title' ? size + 4 : size + 6;
    const weight = row.kind === 'title' || row.kind === 'h2' ? ' font-weight="700"' : '';
    out.push(`<text x="${pad}" y="${y}" font-size="${size}"${weight}>${esc(row.text)}</text>`);
  }
  const H = y + pad;
  const title = `Usage Wrapped, ${r.period.label}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d" font-family="Helvetica, Arial, sans-serif">
<title id="t">${esc(title)}</title><desc id="d">Private weekly usage report. Each figure is labelled provider-reported, measured, estimated or unavailable.</desc>
<rect width="100%" height="100%" fill="#ffffff"/><g fill="#1a1a1a">
${out.join('\n')}
</g></svg>
`;
}

// Minimal single-font PDF: Helvetica, WinAnsi text, A4 pages. Characters outside Latin-1 become '?'.
export function renderPdf(r: WrappedReport): Buffer {
  const rows = reportLines(r).flatMap(l => flat(l, 92));
  const pageH = 842, pageW = 595, margin = 50;
  const pages: string[][] = [[]]; let y = pageH - margin;
  const clean = (s: string) => [...s].map(c => (c.charCodeAt(0) < 256 && c.charCodeAt(0) >= 32 ? c : '?')).join('').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  for (const row of rows) {
    const size = row.kind === 'title' ? 18 : row.kind === 'h2' ? 13 : 10;
    const lead = size + (row.kind === 'h2' ? 8 : 4);
    if (y - lead < margin) { pages.push([]); y = pageH - margin; }
    y -= lead;
    pages[pages.length - 1].push(`BT /${row.kind === 'title' || row.kind === 'h2' ? 'F2' : 'F1'} ${size} Tf ${margin} ${y} Td (${clean(row.text)}) Tj ET`);
  }
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // pages, filled below
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const p of pages) {
    const body = p.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// --- privacy preview and gated export -------------------------------------------------------

export interface PrivacyPreview {
  token: string; // hash of exactly what will be written; export requires it
  includes: Array<{ field: string; detail: string }>;
  excludes: string[];
  warnings: string[];
}

export function privacyPreview(r: WrappedReport): PrivacyPreview {
  const includes = [
    { field: 'Week and time zone', detail: `${r.period.label}, ${r.timeZone}` },
    { field: 'Accounts', detail: r.selection.includeAccountNames ? `Your account aliases: ${r.selection.accounts.join(', ') || 'none'}` : `Generic labels only (${r.selection.accounts.length} account(s))` },
    { field: 'Providers', detail: r.selection.providers.join(', ') || 'none' },
    { field: 'Aggregated usage figures', detail: 'Shares, counts of windows and averages for the week; each with its status and definition' },
    { field: 'Suggestions and definitions', detail: `${r.suggestions.length} suggestion(s) and the metric definitions` },
  ];
  const excludes = ['Device identifiers and device names', 'Raw ledger records and timestamps of individual requests', 'Project names, prompts and file paths', 'Plan names (only prorated cost totals appear, and only when you entered a plan history)', ...(r.selection.includeAccountNames ? [] : ['Account names'])];
  const warnings = r.selection.includeAccountNames ? ['Account aliases are included. Anyone who receives the file can read them.'] : [];
  if (r.sections.some(s => s.metrics.some(m => m.id === 'subscription_cost' && m.status !== 'unavailable'))) warnings.push('Prorated plan cost is included.');
  return { token: contentHash({ v: r.reportVersion, lines: reportLines(r) }), includes, excludes, warnings };
}

export type ExportResult = { ok: true; format: ExportFormat; mime: string; filename: string; body: string | Buffer } | { ok: false; error: 'preview_required' | 'preview_stale' | 'invalid_format' };

export function exportReport(r: WrappedReport, format: string, previewToken: string | undefined): ExportResult {
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) return { ok: false, error: 'invalid_format' };
  if (!previewToken) return { ok: false, error: 'preview_required' };
  if (previewToken !== privacyPreview(r).token) return { ok: false, error: 'preview_stale' };
  const f = format as ExportFormat;
  const name = `usage-wrapped-${fmtDate(r.period.start, r.timeZone)}`;
  if (f === 'html') return { ok: true, format: f, mime: 'text/html; charset=utf-8', filename: `${name}.html`, body: renderHtml(r) };
  if (f === 'svg') return { ok: true, format: f, mime: 'image/svg+xml', filename: `${name}.svg`, body: renderSvg(r) };
  return { ok: true, format: f, mime: 'application/pdf', filename: `${name}.pdf`, body: renderPdf(r) };
}

// --- observability --------------------------------------------------------------------------

// Log lines carry counts and states only: never account names, device ids, values or file paths.
export function logLine(event: 'preview' | 'export' | 'export_refused', r: WrappedReport, extra: { format?: string; error?: string } = {}): string {
  const states = r.sections.flatMap(s => s.metrics).reduce<Record<string, number>>((a, m) => ({ ...a, [m.status]: (a[m.status] ?? 0) + 1 }), {});
  const kv = {
    event, complete: r.completeness.complete, comparison: r.comparison.allowed, newUser: r.newUser,
    unavailable: states['unavailable'] ?? 0, notices: r.notices.map(n => n.id).join(',') || '-', ...(extra.format ? { format: extra.format } : {}), ...(extra.error ? { error: extra.error } : {}),
  };
  return `[wrapped] ${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(' ')}`;
}

import { writeFileSync } from 'node:fs';
import type { LedgerRecord } from '../../ledger/types.js';
import { buildReport, type ReportOptions } from '../../wrapped/report.js';
import { exportReport, logLine, privacyPreview, reportLines } from '../../wrapped/render.js';

// `claudewatch wrapped`: prints the privacy preview, and writes a file only after the user confirms it
// (Prompt 5.2, operation key 2026-10-10.1/prompt-5.2). Rules: docs/WRAPPED_REPORT.md.
export interface WrappedCliOptions extends Omit<ReportOptions, 'now'> { format?: string; out?: string; confirm?: string }
export interface WrappedCliIo {
  records: LedgerRecord[]; now: number; log: (s: string) => void;
  ask: (question: string) => Promise<boolean>; write: (path: string, body: string | Buffer) => void;
}

export async function runWrapped(opts: WrappedCliOptions, io: WrappedCliIo): Promise<number> {
  const { format, out, confirm, ...ro } = opts;
  const built = buildReport(io.records, { ...ro, now: io.now });
  if (!built.ok) { io.log(`Cannot build the report: ${built.error}`); return 1; }
  const r = built.report;
  io.log(`Usage Wrapped ${r.period.label} (${r.timeZone}). Generated locally; nothing is uploaded.\n`);
  for (const l of reportLines(r)) {
    if (l.kind === 'title') continue;
    io.log(l.kind === 'h2' ? `\n${l.text}` : l.kind === 'metric' ? `  ${l.label}: ${l.text} [${l.status}] (definition: ${l.id})` : `  ${l.text}`);
  }
  const p = privacyPreview(r);
  io.log(logLine('preview', r));
  if (!out) { io.log(`\nTo export, add --format html|svg|pdf --out <file>. Preview token: ${p.token}`); return 0; }
  io.log('\nPrivacy preview. The file will include:');
  for (const i of p.includes) io.log(`  + ${i.field}: ${i.detail}`);
  io.log('It will not include:');
  for (const e of p.excludes) io.log(`  - ${e}`);
  for (const w of p.warnings) io.log(`  ! ${w}`);
  const ok = confirm !== undefined ? confirm === p.token : await io.ask('Write this file?');
  if (!ok) {
    io.log(confirm !== undefined ? 'Preview token does not match the current report; nothing written.' : 'Nothing written.');
    io.log(logLine('export_refused', r, { error: 'not_confirmed' }));
    return 1;
  }
  const res = exportReport(r, format ?? 'html', p.token);
  if (!res.ok) { io.log(`Export refused: ${res.error}`); return 1; }
  io.write(out, res.body);
  io.log(logLine('export', r, { format: res.format }));
  io.log(`Wrote ${out}`);
  return 0;
}

export const writeFileIo = (path: string, body: string | Buffer): void => writeFileSync(path, body, { mode: 0o600 });

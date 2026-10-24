import { writeFileSync } from 'node:fs';
import type { LedgerRecord } from '../../ledger/types.js';
import type { ReportOptions } from '../../wrapped/report.js';
import { buildCard, cardInputsFrom, cardPreview, CARD_TEMPLATES, exportCard } from '../../wrapped/shareCards.js';
import { shareLogLine } from '../../wrapped/shareLinks.js';

// `claudewatch share-card`: builds an opt-in share card, shows every field with its on/off state and the privacy
// preview, and writes the image only after the user confirms (Prompt 5.3, operation key 2026-10-10.1/prompt-5.3).
// Rules: docs/SHARE_CARDS.md.
export interface ShareCardCliOptions extends Omit<ReportOptions, 'now'> {
  template?: string; hide?: string[]; show?: string[]; referralCode?: string; prevented?: number; out?: string; confirm?: string;
}
export interface ShareCardCliIo {
  records: LedgerRecord[]; now: number; log: (s: string) => void;
  ask: (question: string) => Promise<boolean>; write: (path: string, body: string) => void;
}

export async function runShareCard(opts: ShareCardCliOptions, io: ShareCardCliIo): Promise<number> {
  const { template, hide, show, referralCode, prevented, out, confirm, ...ro } = opts;
  if (!template) { io.log(`Choose a template with --template: ${CARD_TEMPLATES.join(', ')}.`); return 1; }
  const ropts: ReportOptions = { ...ro, now: io.now, ...(prevented !== undefined ? { metrics: { confirmedPrevented: prevented } } : {}) };
  const src = cardInputsFrom(io.records, ropts);
  if (!src.ok) { io.log(`Cannot build the card: ${src.error}`); return 1; }
  const built = buildCard(src.inputs, template, { ...(hide ? { hide } : {}), ...(show ? { show } : {}), ...(referralCode ? { referralCode } : {}) });
  if (!built.ok) { io.log(`Cannot build the card: ${built.error}${built.detail ? ` (${built.detail})` : ''}`); return 1; }
  const card = built.card, p = cardPreview(card);
  const ctx = { template: card.template, fieldsOn: card.fields.filter(x => x.enabled).length, fieldsTotal: card.fields.length };
  io.log(`${card.title}. Built locally; nothing is uploaded and no link is created.\n`);
  io.log('Fields (switch with --hide <id> or --show <id>):');
  for (const x of p.fields) io.log(`  [${x.enabled ? 'x' : ' '}] ${x.id}: ${x.text}${x.defaultOn ? '' : ' (off by default)'}`);
  io.log('\nPrivacy preview. The image will include:');
  for (const i of p.includes) io.log(`  + ${i.field}: ${i.detail}`);
  io.log('It will not include:');
  for (const e of p.excludes) io.log(`  - ${e}`);
  for (const w of p.warnings) io.log(`  ! ${w}`);
  io.log(shareLogLine('preview', ctx));
  if (!out) { io.log(`\nTo export, add --out <file.svg>. Preview token: ${p.token}`); return 0; }
  const ok = confirm !== undefined ? confirm === p.token : await io.ask('Write this image?');
  if (!ok) {
    io.log(confirm !== undefined ? 'Preview token does not match the current card; nothing written.' : 'Nothing written.');
    io.log(shareLogLine('export_refused', { ...ctx, error: 'not_confirmed' }));
    return 1;
  }
  const res = exportCard(card, 'svg', p.token, src.sensitive);
  if (!res.ok) { io.log(`Export refused: ${res.error}`); io.log(shareLogLine('export_refused', { ...ctx, error: res.error })); return 1; }
  io.write(out, res.body);
  io.log(shareLogLine('export', { ...ctx, format: res.format }));
  io.log(`Wrote ${out}`);
  return 0;
}

export const writeCardFile = (path: string, body: string): void => writeFileSync(path, body, { mode: 0o600 });

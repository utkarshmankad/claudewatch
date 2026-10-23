#!/usr/bin/env node
// Usage: node scripts/soak-24h-report.mjs --export export.json --build-sha <sha> \
//   --start <ISO> --end <ISO> --restarted-at <ISO> --network-cut-at <ISO> --network-restored-at <ISO> \
//   [--out docs/product-hunt/gates/phase-0/soak-24h.md]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseExport, computeSoak, renderReport } from './soak-24h-lib.mjs';

const { values: v } = parseArgs({ options: {
  export: { type: 'string' }, 'build-sha': { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
  'restarted-at': { type: 'string' }, 'network-cut-at': { type: 'string' }, 'network-restored-at': { type: 'string' },
  out: { type: 'string', default: 'docs/product-hunt/gates/phase-0/soak-24h.md' },
} });
for (const k of ['export', 'build-sha', 'start', 'end']) if (!v[k]) { console.error(`missing --${k}`); process.exit(2); }
const t = s => (s ? Date.parse(s) : undefined);
const data = parseExport(readFileSync(v.export, 'utf8'));
const r = computeSoak(data, { startAt: t(v.start), endAt: t(v.end), restartedAt: t(v['restarted-at']), networkCutAt: t(v['network-cut-at']), networkRestoredAt: t(v['network-restored-at']) });
writeFileSync(v.out, renderReport(r, { buildSha: v['build-sha'], exportedAt: data.exportedAt }));
console.log(`wrote ${v.out}`);

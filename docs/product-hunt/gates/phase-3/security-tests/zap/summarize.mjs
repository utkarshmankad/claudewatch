// Reads zap-report.json and prints a Markdown summary; exits 1 when there is a High alert.
//   node summarize.mjs zap-out/zap-report.json
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const alerts = (report.site ?? []).flatMap((s) => (s.alerts ?? []).map((a) => ({ ...a, site: s['@name'] })));
const level = { 3: 'High', 2: 'Medium', 1: 'Low', 0: 'Informational' };
const rows = alerts.map((a) => ({ risk: Number(a.riskcode), name: a.name, count: Number(a.count ?? a.instances?.length ?? 0), sample: (a.instances?.[0]?.uri ?? '').replace(/https?:\/\/[^/]+/, '') }))
  .sort((x, y) => y.risk - x.risk || x.name.localeCompare(y.name));
const out = [`ZAP ${report['@version'] ?? ''} scanned ${alerts.length ? alerts[0].site : 'the service'}: ${rows.length} alert type(s).`, '', '| Risk | Alert | Instances | Example path |', '| --- | --- | --- | --- |',
  ...rows.map((r) => `| ${level[r.risk]} | ${r.name} | ${r.count} | \`${r.sample}\` |`)];
console.log(out.join('\n'));
process.exit(rows.some((r) => r.risk >= 3) ? 1 : 0);

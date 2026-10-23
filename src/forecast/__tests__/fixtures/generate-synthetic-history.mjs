import fs from 'fs';
let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0), H = 3600e3;
const out = [];
function gen(provider, win, winMs, days, ratePerH, stepMin) {
  for (let w = 0; T0 + w * winMs < T0 + days * 24 * H; w++) {
    const start = T0 + w * winMs, reset = start + winMs;
    const wr = ratePerH * (0.4 + 1.2 * rnd()); let pct = 0;
    for (let t = start + stepMin * 60e3; t <= reset; t += stepMin * 60e3) {
      const active = rnd() < 0.7; pct = Math.min(100, pct + (active ? wr * (stepMin / 60) * (0.5 + rnd()) : 0));
      out.push({ schemaVersion: 1, kind: 'provider_snapshot', provider, accountAlias: 'fixture', devicePseudonym: 'a1b2c3d4e5f60718', observedAt: t, ingestedAt: t + 1000, source: 'web', confidence: 'high', measurementMethod: 'provider_reported', measures: { quotaPercentUsed: Math.round(pct * 100) / 100 }, window: { type: win, resetAt: reset } });
      if (pct >= 100) break;
    }
  }
}
gen('claude', 'five_hour', 5 * H, 6, 24, 15);
gen('chatgpt', 'five_hour', 5 * H, 6, 12, 15);
gen('claude', 'weekly', 168 * H, 28, 1.1, 120);
fs.writeFileSync(process.argv[2], JSON.stringify(out));
console.log(out.length);

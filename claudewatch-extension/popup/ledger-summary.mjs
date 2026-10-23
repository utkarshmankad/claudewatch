// Compact usage-ledger summary for the popup (Prompt 1.5). Pure: takes the stats the popup
// already has plus a count of locally observed completed messages, and returns labelled rows.
// Wording rules (docs/LEDGER_UI.md): every figure carries a text label saying where it came
// from, and nothing here implies exact token billing.

export const PROVIDER_NAMES = Object.freeze({ claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' });
const PROVIDERS = Object.keys(PROVIDER_NAMES);

// state: 'error' | 'empty' | 'stale' | 'partial' | 'ok'. Precedence: error, empty, stale, partial.
export function summarizeLedger({ stats = null, activity = null } = {}) {
  if (!stats) return { state: 'error', rows: [], activityEnabled: false };
  const usage = stats.providerUsage ?? {};
  const health = stats.providerHealth ?? {};
  const counts = activity?.counts24h ?? {};
  const activityEnabled = activity?.enabled === true;

  const rows = PROVIDERS.map((key) => {
    const u = usage[key] ?? null;
    const h = health[key] ?? null;
    const reported = u && (u.pct5h != null || u.pct7d != null) ? { pct5h: u.pct5h ?? null, pct7d: u.pct7d ?? null } : null;
    const observed = activityEnabled ? (counts[key] ?? 0) : null;
    return { key, name: PROVIDER_NAMES[key], reported, stale: Boolean(reported && h?.stale), failed: Boolean(h && h.ok === false), observedMessages24h: observed };
  }).filter((r) => r.reported || (r.observedMessages24h ?? 0) > 0);

  let state = 'ok';
  if (rows.length === 0) state = 'empty';
  else if (rows.some((r) => r.stale || r.failed)) state = 'stale';
  else if (!activityEnabled || rows.some((r) => !r.reported)) state = 'partial';
  return { state, rows, activityEnabled };
}

const pct = (p) => (p == null ? null : p > 0 && p < 1 ? '< 1%' : `${Math.round(p)}%`);

// `t(key, subs, fallback)` is the popup's message lookup.
export function ledgerLines(summary, t) {
  return summary.rows.map((r) => {
    const parts = [];
    if (r.reported) {
      const windows = [['5h', pct(r.reported.pct5h)], ['7d', pct(r.reported.pct7d)]].filter(([, v]) => v).map(([w, v]) => `${w} ${v}`).join(', ');
      parts.push(t('popLedgerReported', [windows], `Provider-reported: ${windows}`));
    }
    if (r.observedMessages24h != null && r.observedMessages24h > 0) {
      const n = String(r.observedMessages24h);
      parts.push(t('popLedgerObserved', [n], `Estimated from ${n} message(s) seen here in 24h`));
    }
    return { key: r.key, name: r.name, text: parts.join(' · ') };
  });
}

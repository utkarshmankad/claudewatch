import type { AlertRecord } from '../store/db.js';

/** Mapped snapshot shape returned by /api/status and used for SSR. */
export interface DashboardSnapshot {
  polledAt: string;
  model: string | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface DashboardData {
  costs: {
    monthly: number | null;
    weekly: number | null;
    daily: number | null;
    updatedAt: string | null;
  };
  billingPeriod: {
    startingAt: string;
    endingAt: string;
  };
  spendLimitUsd: number | null;
  weeklySpendLimitUsd: number | null;
  weeklyTokenLimit: number | null;
  pollIntervalMinutes: number;
  lastPollAt: string | null;
  snapshot: DashboardSnapshot | null;
  alerts: AlertRecord[];
}

function fmt(n: number | null, decimals = 2): string {
  return n == null ? '—' : `$${n.toFixed(decimals)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function nextPollTime(lastPollAt: string | null, intervalMinutes: number): string {
  if (!lastPollAt) return '—';
  const next = new Date(new Date(lastPollAt).getTime() + intervalMinutes * 60 * 1000);
  return fmtTime(next.toISOString());
}


function alertsTable(alerts: AlertRecord[]): string {
  if (alerts.length === 0) {
    return `<p class="muted">No alerts fired yet.</p>`;
  }
  const rows = alerts.map(a => `
    <tr>
      <td>${fmtTime(a.firedAt)}</td>
      <td>${a.period}</td>
      <td>${fmt(a.thresholdUsd)}</td>
      <td>${fmt(a.actualUsd)}</td>
      <td>${a.channels.join(', ')}</td>
    </tr>`).join('');
  return `
    <table>
      <thead><tr><th>Fired At</th><th>Period</th><th>Threshold</th><th>Actual</th><th>Channels</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function weeklyProgressBar(current: number | null, limit: number | null): string {
  if (current == null || limit == null || limit <= 0) return '';
  const pct = Math.min(100, (current / limit) * 100);
  const color = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#22c55e';
  const warn = pct >= 80 ? ' ⚠️' : '';
  return `
    <div class="bar-track" style="margin-top:4px">
      <div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>
    </div>
    <span class="bar-label">${fmt(current)} / ${fmt(limit)} (${pct.toFixed(1)}%)${warn}</span>`;
}

export function generateDashboardHTML(data: DashboardData): string {
  const snap = data.snapshot;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ClaudeWatch</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f1117;
      --surface: #1a1d27;
      --border: #2d3148;
      --text: #e2e8f0;
      --muted: #64748b;
      --accent: #818cf8;
      --font: 'JetBrains Mono', 'Fira Mono', 'Cascadia Code', 'Consolas', monospace;
    }
    body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 13px; line-height: 1.6; padding: 24px; }
    h1 { font-size: 18px; color: var(--accent); letter-spacing: 0.05em; margin-bottom: 4px; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 12px; }
    .version { color: var(--muted); font-size: 11px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 20px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
    .stat-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border); }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { color: var(--muted); }
    .stat-value { color: var(--text); }
    .bar-track { background: var(--border); border-radius: 4px; height: 10px; overflow: hidden; margin: 8px 0 4px; }
    .bar-fill { height: 100%; border-radius: 4px; transition: width 0.4s ease; }
    .bar-label { color: var(--muted); font-size: 11px; }
    table { width: 100%; border-collapse: collapse; margin-top: 4px; }
    th { color: var(--muted); text-align: left; padding: 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid var(--border); }
    td { padding: 6px 8px; border-bottom: 1px solid var(--border); color: var(--text); }
    tr:last-child td { border-bottom: none; }
    .muted { color: var(--muted); }
    .refresh-note { margin-top: 24px; color: var(--muted); font-size: 11px; }
    #last-updated { color: var(--accent); }
  </style>
</head>
<body>
  <h1>ClaudeWatch</h1>
  <span class="version">v0.1.0</span> &nbsp;
  <span id="refresh-status" style="font-size:11px;color:var(--muted)"></span>

  <div class="grid">

    <div class="card">
      <h2>Spend</h2>
      <div class="stat-row">
        <span class="stat-label">Monthly</span>
        <span class="stat-value" id="spend-monthly">${fmt(data.costs.monthly)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Weekly</span>
        <span class="stat-value" id="spend-weekly">${fmt(data.costs.weekly)}</span>
      </div>
      <div id="weekly-progress-bar">${weeklyProgressBar(data.costs.weekly, data.weeklySpendLimitUsd)}</div>
      <div class="stat-row">
        <span class="stat-label">Daily</span>
        <span class="stat-value" id="spend-daily">${fmt(data.costs.daily)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Spend limit</span>
        <span class="stat-value">${fmt(data.spendLimitUsd)}</span>
      </div>
      <div class="bar-track" style="margin-top:8px">
        <div class="bar-fill" id="spend-bar" style="width:${data.spendLimitUsd && data.costs.monthly != null ? Math.min(100, (data.costs.monthly / data.spendLimitUsd) * 100).toFixed(1) : 0}%;background:#22c55e"></div>
      </div>
      <span class="bar-label" id="spend-used">${data.spendLimitUsd && data.costs.monthly != null ? `${fmt(data.costs.monthly, 6)} / ${fmt(data.spendLimitUsd)} (${Math.min(100, (data.costs.monthly / data.spendLimitUsd) * 100).toFixed(1)}%)` : 'No limit set'}</span>
    </div>

    <div class="card">
      <h2>Poll Status</h2>
      <div class="stat-row">
        <span class="stat-label">Last poll</span>
        <span class="stat-value" id="last-poll">${fmtTime(data.snapshot?.polledAt ?? data.lastPollAt)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Next poll</span>
        <span class="stat-value" id="next-poll">${nextPollTime(data.lastPollAt, data.pollIntervalMinutes)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Interval</span>
        <span class="stat-value">${data.pollIntervalMinutes}m</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Billing period</span>
        <span class="stat-value" id="billing-period">${data.billingPeriod.startingAt.slice(0, 10)} → ${data.billingPeriod.endingAt.slice(0, 10)}</span>
      </div>
    </div>

    <div class="card">
      <h2>Token Breakdown (latest poll)</h2>
      <div class="stat-row">
        <span class="stat-label">Model</span>
        <span class="stat-value" id="token-model">${snap?.model ?? '—'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Input (uncached)</span>
        <span class="stat-value" id="token-input">${fmtTokens(snap?.inputTokens ?? 0)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Cache hit</span>
        <span class="stat-value" id="token-cache-hit">${fmtTokens(snap?.cacheReadTokens ?? 0)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Cache write</span>
        <span class="stat-value" id="token-cache-write">${fmtTokens(snap?.cacheWriteTokens ?? 0)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Output</span>
        <span class="stat-value" id="token-output">${fmtTokens(snap?.outputTokens ?? 0)}</span>
      </div>
    </div>

  </div>

  <div class="card" style="margin-top:16px">
    <h2>Recent Alerts</h2>
    <div id="alerts-container">${alertsTable(data.alerts)}</div>
  </div>

  <p class="refresh-note">Auto-refreshes every 30s &nbsp;|&nbsp; Last updated: <span id="last-updated">${new Date().toLocaleTimeString()}</span></p>

  <script>
    function setText(id, val) {
      var el = document.getElementById(id);
      if (el) el.textContent = val;
    }
    function setWidth(id, val) {
      var el = document.getElementById(id);
      if (el) el.style.width = val;
    }
    function html(id, v) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = v;
    }
    function fmt(n, d) {
      return n != null ? '$' + Number(n).toFixed(d != null ? d : 6) : '—';
    }
    function num(n) {
      if (n == null) return '0';
      var v = Number(n);
      if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
      return v.toLocaleString();
    }
    function fmtTime(iso) {
      if (!iso) return '—';
      return new Date(iso).toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }
    function color(p) {
      return p >= 90 ? '#ef4444' : p >= 70 ? '#f59e0b' : '#22c55e';
    }

    async function refresh() {
      try {
        var statusRes = await fetch('/api/status');
        if (!statusRes.ok) throw new Error('HTTP ' + statusRes.status);
        var alertsRes = await fetch('/api/alerts?limit=20');
        if (!alertsRes.ok) throw new Error('HTTP ' + alertsRes.status);
        var data = await statusRes.json();
        var a    = await alertsRes.json();

        // Costs
        var costs = data.costs || {};
        setText('spend-monthly', fmt(costs.monthly));
        setText('spend-weekly',  fmt(costs.weekly));
        setText('spend-daily',   fmt(costs.daily));

        var limit = data.spendLimitUsd;
        var used  = costs.monthly || 0;
        var pct   = limit ? Math.min(100, (used / limit) * 100) : 0;
        setText('spend-used',
          limit ? (fmt(used) + ' / $' + Number(limit).toFixed(2) + ' (' + pct.toFixed(1) + '%)') : 'No limit set');
        setWidth('spend-bar', pct.toFixed(1) + '%');
        var barEl = document.getElementById('spend-bar');
        if (barEl) barEl.style.background = color(pct);

        // Poll status
        setText('last-poll', data.lastPollAt ? new Date(data.lastPollAt).toLocaleTimeString() : '—');
        if (data.lastPollAt) {
          var next = new Date(new Date(data.lastPollAt).getTime() + (data.pollIntervalMinutes || 5) * 60000);
          setText('next-poll', next > new Date() ? next.toLocaleTimeString() : 'overdue');
        }

        // Billing period
        var bp = data.billingPeriod || {};
        setText('billing-period',
          bp.startingAt ? (bp.startingAt.slice(0, 10) + ' → ' + bp.endingAt.slice(0, 10)) : '—');

        // Token breakdown
        var s = data.snapshot;
        setText('token-model',       s && s.model ? s.model : '—');
        setText('token-input',       num(s && s.inputTokens));
        setText('token-cache-hit',   num(s && s.cacheReadTokens));
        setText('token-cache-write', num(s && s.cacheWriteTokens));
        setText('token-output',      num(s && s.outputTokens));

        // Weekly limit bar
        var weeklyLimit = data.weeklySpendLimitUsd;
        var weeklyHtml = '';
        if (weeklyLimit != null) {
          var wp = Math.min(100, ((costs.weekly || 0) / weeklyLimit) * 100);
          var warn = wp >= 80 ? ' ⚠️' : '';
          weeklyHtml = '<div class="bar-track" style="margin-top:4px"><div class="bar-fill" style="width:' + wp.toFixed(1) + '%;background:' + color(wp) + '"></div></div>'
            + '<span class="bar-label">' + fmt(costs.weekly) + ' / $' + Number(weeklyLimit).toFixed(2) + ' (' + wp.toFixed(1) + '%)' + warn + '</span>';
        }
        html('weekly-progress-bar', weeklyHtml);

        // Alerts
        var alerts = (a.alerts || []);
        if (!alerts.length) {
          html('alerts-container', '<p class="muted">No alerts fired yet.</p>');
        } else {
          var rows = alerts.map(function(al) {
            return '<tr><td>' + fmtTime(al.firedAt) + '</td><td>' + al.period + '</td>'
              + '<td>' + fmt(al.thresholdUsd, 2) + '</td><td>' + fmt(al.actualUsd, 2) + '</td>'
              + '<td>' + (al.channels || []).join(', ') + '</td></tr>';
          }).join('');
          html('alerts-container',
            '<table><thead><tr><th>Fired At</th><th>Period</th><th>Threshold</th><th>Actual</th><th>Channels</th></tr></thead>'
            + '<tbody>' + rows + '</tbody></table>');
        }

        setText('last-updated', new Date().toLocaleTimeString());
        setText('refresh-status', 'Updated ' + new Date().toLocaleTimeString());
      } catch (err) {
        setText('refresh-status', 'Refresh failed: ' + (err && err.message ? err.message : String(err)));
        console.warn('ClaudeWatch refresh failed:', err);
      }
    }

    setInterval(refresh, 30000);
    refresh();
  </script>
</body>
</html>`;
}

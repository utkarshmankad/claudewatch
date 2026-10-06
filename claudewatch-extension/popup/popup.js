// popup.js — fetches stats from background service worker via GET_STATS,
// renders dual gauges (5h / 7d), site breakdown, plan comparison table, and SVG sparkline.

const REFRESH_MS = 15_000;
const TICK_MS    = 1_000;

// ── Module state ─────────────────────────────────────────────────────────────

let gResetMs5h = null;
let gResetMs7d = null;
let gLastTs    = null;
let gActiveWin = '5h';
let gHistory   = [];
let gUsageHistory = [];
let gSelectedSite = 'claude';
let gStats = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function setText(id, v) {
  const n = el(id);
  if (n) n.textContent = (v == null ? '—' : v);
}

function fmtK(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtPct(p) {
  if (p == null) return '—';
  if (p > 0 && p < 1) return '< 1%';
  return `${Math.round(p)}%`;
}

function windowLabel(seconds, fallback) {
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  if (seconds % 86400 === 0) return `${seconds / 86400}-Day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-Hour`;
  return fallback;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
}

function fmtAgo(epochMs) {
  if (!epochMs) return '—';
  const sec = Math.round((Date.now() - epochMs) / 1000);
  if (sec < 5)  return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function fmtDuration(ms) {
  if (ms == null || ms <= 0) return '< 1m';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function fmtCountdown(ms) {
  if (ms == null || ms <= 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fillBar(fillId, pct) {
  const fill = el(fillId);
  if (!fill) return;
  const p = pct ?? 0;
  fill.style.width = p > 0 ? `max(4px, ${Math.min(100, p)}%)` : '0%';
  fill.className = ['gc-fill', p >= 90 ? 'red' : p >= 70 ? 'amber' : ''].filter(Boolean).join(' ');
}

function renderAccountSelector(site, providerAccounts, providerSelections) {
  const select = el('account-select');
  if (!select) return;
  const accounts = Object.values(providerAccounts?.[site] ?? {});
  select.hidden = accounts.length < 2;
  select.innerHTML = accounts.map(account => {
    const label = account.accountName ?? account.email ?? account.accountId ?? 'Account';
    return `<option value="${escapeHtml(account.accountKey)}">${escapeHtml(label)}</option>`;
  }).join('');
  select.value = providerSelections?.[site] ?? accounts[0]?.accountKey ?? '';
}

function renderProviderHealth(health) {
  const node = el('provider-health');
  if (!node) return;
  if (!health) { node.hidden = true; return; }
  node.hidden = false;
  node.className = `provider-health${health.ok === false ? ' error' : health.stale ? ' stale' : ''}`;
  if (health.ok === false) {
    const status = health.status ? ` (HTTP ${health.status})` : '';
    node.textContent = `Update failed${status} · showing last known data${health.lastSuccessAt ? ` from ${fmtAgo(Date.parse(health.lastSuccessAt))}` : ''}`;
  } else if (health.stale) {
    node.textContent = health.hasData ? `Data is stale · last update ${fmtAgo(Date.now() - (health.ageMs ?? 0))}` : 'Open a signed-in tab to fetch usage';
  } else {
    node.textContent = `Provider-reported · updated ${fmtAgo(Date.now() - (health.ageMs ?? 0))}`;
  }
}

// ── Alert banner ──────────────────────────────────────────────────────────────

function showAlert(msg, isRed = false) {
  const alertEl = el('alert');
  const textEl  = el('alert-text');
  if (!alertEl || !textEl) return;
  if (!msg) { alertEl.hidden = true; return; }
  textEl.textContent = msg;
  alertEl.className = `alert ${isRed ? 'alert-red' : ''}`;
  alertEl.hidden = false;
}

// ── Site breakdown ────────────────────────────────────────────────────────────

const SITE_META = [
  { key: 'claude',  name: 'Claude',  icon: '◐' },
  { key: 'chatgpt', name: 'ChatGPT', icon: '◯' },
  { key: 'gemini',  name: 'Gemini',  icon: '◈' },
];

function renderSiteBreakdown(siteBreakdown, activeSite, providerUsage) {
  const container = el('site-list');
  if (!container) return;

  container.innerHTML = SITE_META.map(s => {
    const data   = siteBreakdown?.[s.key] ?? { tokens5h: 0, tokens7d: 0 };
    const quota = providerUsage?.[s.key] ?? null;
    const tokens = data.tokens5h ?? 0;
    const isActive = s.key === gSelectedSite;
    const isEmpty  = !quota && tokens === 0;
    const scoped = quota?.additionalLimits?.find(limit => /codex/i.test(`${limit.name} ${limit.feature ?? ''}`));
    const usageText = quota
      ? `5h ${fmtPct(quota.pct5h)} · 7d ${fmtPct(quota.pct7d)}`
      : (tokens > 0 ? `${fmtK(tokens)} local` : 'Open signed-in tab');
    const forecast = quota?.forecast7d != null ? ` → ${fmtPct(quota.forecast7d)}` : '';
    const scopedText = scoped ? ` · Codex ${fmtPct(scoped.pct)}` : '';
    const account = quota?.email ? `<span class="site-account">${escapeHtml(quota.email)}</span>` : '';

    return `<button class="site-row${isActive ? ' active' : ''}${isEmpty ? ' empty' : ''}" data-site="${s.key}">
      <span class="site-icon">${s.icon}</span>
      <span class="site-copy"><span class="site-name">${s.name}</span>${account}</span>
      <span class="site-tokens">${usageText}${forecast}${scopedText}</span>
      ${s.key === activeSite ? '<span class="site-active-dot"></span>' : ''}
    </button>`;
  }).join('');

  container.querySelectorAll('[data-site]').forEach(row => row.addEventListener('click', () => {
    gSelectedSite = row.dataset.site;
    render(gStats);
  }));
}

// ── Plan table ────────────────────────────────────────────────────────────────

function renderPlanTable(planTable) {
  const tbody = el('plan-tbody');
  if (!tbody) return;
  if (!planTable?.length) {
    tbody.innerHTML = '<tr class="skeleton"><td colspan="3">No data</td></tr>';
    return;
  }

  tbody.innerHTML = planTable.map(row => {
    const p5 = row.pct5h;
    const p7 = row.pct7d;
    const cls5 = p5 == null ? 'null' : p5 >= 100 ? 'over' : p5 >= 80 ? 'high' : '';
    const cls7 = p7 == null ? 'null' : p7 >= 100 ? 'over' : p7 >= 80 ? 'high' : '';
    const cur = row.isCurrent;
    const dot = cur ? '<span class="current-marker" title="Your plan"></span>' : '';

    return `<tr class="${cur ? 'current-plan' : ''}">
      <td><span class="plan-name">${dot}${row.name}</span></td>
      <td class="pct-cell ${cls5}">${fmtPct(p5)}</td>
      <td class="pct-cell ${cls7}">${fmtPct(p7)}</td>
    </tr>`;
  }).join('');
}

// ── Sparkline SVG ─────────────────────────────────────────────────────────────

function renderSparkline(history, windowKey) {
  const svgEl   = el('sparkline');
  const emptyEl = el('chart-empty-msg');
  if (!svgEl) return;

  const W = 300, H = 52;
  const now   = Date.now();
  const winMs = windowKey === '7d' ? 7 * 24 * 60 * 60 * 1000 : 5 * 60 * 60 * 1000;

  const pctKey = windowKey === '7d' ? 'pct7d' : 'pct5h';
  const accountId = gStats?.providerUsage?.[gSelectedSite]?.accountId;
  const filtered = (history ?? []).filter(e => e.ts >= now - winMs && e.site === gSelectedSite &&
    (!accountId || e.accountId === accountId) && e[pctKey] != null).sort((a, b) => a.ts - b.ts);
  svgEl.querySelectorAll('.spark-el').forEach(n => n.remove());

  if (filtered.length < 2) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  const values = filtered.map(e => e[pctKey]);
  const maxVal = Math.max(100, ...values);
  const minTs = now - winMs;
  const points = filtered.map(e => {
    const x = ((e.ts - minTs) / winMs) * W;
    const y = H - 3 - (e[pctKey] / maxVal) * (H - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.classList.add('spark-el');
  line.setAttribute('points', points);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#6366f1');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svgEl.appendChild(line);
}

// ── Countdown tick ────────────────────────────────────────────────────────────

function tickCountdown() {
  const now = Date.now();

  const el5h = el('countdown-5h');
  if (el5h && gResetMs5h != null) {
    const left = Math.max(0, gResetMs5h - now);
    el5h.textContent = fmtCountdown(left);
    el5h.className   = 'reset-clock' + (left < 5 * 60_000 ? ' urgent' : left < 30 * 60_000 ? ' warn' : '');
  }

  const el7d = el('countdown-7d');
  if (el7d && gResetMs7d != null) {
    const left = Math.max(0, gResetMs7d - now);
    el7d.textContent = fmtCountdown(left);
    el7d.className   = 'reset-clock';
  }

  setText('last-update', gLastTs ? fmtAgo(gLastTs) : '—');
}

// ── Full render ───────────────────────────────────────────────────────────────

function render(stats) {
  if (!stats) {
    el('empty-state').hidden  = false;
    el('main-content').hidden = true;
    return;
  }

  gStats = stats;
  const {
    tokens5h, tokens7d, pct5h, pct7d, limit5h, resetMs5h, timeLeft5h, timeLeft7d,
    plan, planName, planTable, history, lastTs,
    rlType, rlResetsAt, rlRemaining,
    siteBreakdown, activeSite, providerUsage, providerAccounts, providerSelections, providerHealth, usageHistory,
  } = stats;

  // Show main content as long as we have ANY data across all sites
  const totalTokens = Object.values(siteBreakdown ?? {}).reduce((a, s) => a + (s.tokens5h ?? 0), 0);
  const hasData = Object.keys(providerUsage ?? {}).length > 0 || totalTokens > 0 || tokens5h > 0 || tokens7d > 0 || rlResetsAt != null;

  el('empty-state').hidden  =  hasData;
  el('main-content').hidden = !hasData;

  if (!hasData) return;

  // Site breakdown
  if (!providerUsage?.[gSelectedSite]) gSelectedSite = providerUsage?.[activeSite] ? activeSite : (Object.keys(providerUsage ?? {})[0] ?? 'claude');
  renderSiteBreakdown(siteBreakdown, activeSite, providerUsage);

  const selected = providerUsage?.[gSelectedSite] ?? null;
  const selectedHealth = providerHealth?.[gSelectedSite] ?? null;
  renderAccountSelector(gSelectedSite, providerAccounts, providerSelections);
  renderProviderHealth(selectedHealth);
  const selectedPct5h = selected?.pct5h ?? (gSelectedSite === 'claude' ? pct5h : null);
  const selectedPct7d = selected?.pct7d ?? (gSelectedSite === 'claude' ? pct7d : null);
  const selectedName = SITE_META.find(s => s.key === gSelectedSite)?.name ?? gSelectedSite;
  const label5h = windowLabel(selected?.windowSeconds5h, '5-Hour');
  const label7d = windowLabel(selected?.windowSeconds7d, '7-Day');
  setText('provider-window-label', `${selectedName} Window`);
  setText('label-5h', label5h);
  setText('label-7d', `${label7d} Rolling`);
  setText('reset-label-5h', `${label5h.toLowerCase()} resets in`);
  setText('reset-label-7d', `${label7d.toLowerCase()} resets in`);
  const confidence5h = selected?.forecastMeta5h?.confidence ? ` · ${selected.forecastMeta5h.confidence}` : '';
  const confidence7d = selected?.forecastMeta7d?.confidence ? ` · ${selected.forecastMeta7d.confidence}` : '';
  setText('tokens-5h', selected?.forecast5h != null ? `Forecast ${fmtPct(selected.forecast5h)}${confidence5h}` : 'Account quota');
  setText('tokens-7d', selected?.forecast7d != null ? `Forecast ${fmtPct(selected.forecast7d)}${confidence7d}` : 'Account quota');
  setText('pct-5h', fmtPct(selectedPct5h));
  setText('pct-7d', fmtPct(selectedPct7d));
  fillBar('fill-5h', selectedPct5h);
  fillBar('fill-7d', selectedPct7d);

  // Countdown anchors
  gResetMs5h = selected?.resetsAt5h ? Date.parse(selected.resetsAt5h) : (rlResetsAt ? Date.parse(rlResetsAt) : (resetMs5h ?? null));
  gResetMs7d = selected?.resetsAt7d ? Date.parse(selected.resetsAt7d) : (stats.timeLeft7d != null ? Date.now() + stats.timeLeft7d : null);
  gLastTs    = selectedHealth?.lastUpdatedAt ?? selected?.ts ?? lastTs ?? null;

  // Alert (Claude rate-limit)
  if (gSelectedSite === 'claude' && rlType === 'over_limit') {
    showAlert('Claude rate limit reached — resets in ' + (gResetMs5h ? fmtDuration(Math.max(0, gResetMs5h - Date.now())) : '—'), true);
  } else if (gSelectedSite === 'claude' && rlType === 'approaching_limit') {
    const rem = rlRemaining != null ? ` (${rlRemaining} msgs left)` : '';
    showAlert(`Claude approaching limit${rem}`);
  } else if (selectedPct5h != null && selectedPct5h >= 90) {
    showAlert(`${selectedName} ${label5h.toLowerCase()} window ${Math.round(selectedPct5h)}% used`, selectedPct5h >= 100);
  } else {
    showAlert(null);
  }

  // Header
  const manifest = chrome.runtime.getManifest();
  setText('version', `v${manifest.version}`);
  setText('last-update', gLastTs ? fmtAgo(gLastTs) : '—');

  // Footer
  setText('plan-pill', selected?.plan ?? (gSelectedSite === 'claude' ? (planName ?? plan) : selectedName));
  el('claude-plan-section').hidden = gSelectedSite !== 'claude';

  // Plan table
  renderPlanTable(planTable);

  // Chart
  gHistory = history ?? [];
  gUsageHistory = usageHistory ?? [];
  renderSparkline(gUsageHistory, gActiveWin);
}

// ── Data loading ──────────────────────────────────────────────────────────────

function loadAndRender() {
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, (stats) => {
    if (chrome.runtime.lastError) {
      console.warn('[popup] sendMessage error:', chrome.runtime.lastError.message);
      render(null);
      return;
    }
    render(stats);
  });
}

// ── Chart tab switching ───────────────────────────────────────────────────────

function setupTabs() {
  ['tab-5h', 'tab-7d'].forEach(id => {
    const btn = el(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      el('tab-5h').classList.remove('active');
      el('tab-7d').classList.remove('active');
      btn.classList.add('active');
      gActiveWin = btn.dataset.win;
      renderSparkline(gUsageHistory, gActiveWin);
    });
  });
}

// ── Button wiring ─────────────────────────────────────────────────────────────

function setupButtons() {
  el('account-select')?.addEventListener('change', (event) => {
    chrome.runtime.sendMessage({ type: 'SELECT_PROVIDER_ACCOUNT', site: gSelectedSite, accountKey: event.target.value }, result => {
      if (!chrome.runtime.lastError && result?.ok) loadAndRender();
    });
  });
  el('btn-open-claude')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://claude.ai' });
    window.close();
  });
  el('btn-open-chatgpt')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://chatgpt.com' });
    window.close();
  });
  el('btn-open-gemini')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://gemini.google.com' });
    window.close();
  });
  el('btn-settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const manifest = chrome.runtime.getManifest();
  setText('version', `v${manifest.version}`);

  setupButtons();
  setupTabs();
  loadAndRender();
  setInterval(loadAndRender, REFRESH_MS);
  setInterval(tickCountdown, TICK_MS);
  tickCountdown();
});

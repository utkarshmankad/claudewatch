// popup.js — fetches stats from background service worker via GET_STATS,
// renders dual gauges (5h / 7d), plan comparison table, and SVG sparkline.

const REFRESH_MS    = 15_000;
const COUNTDOWN_MS  = 30_000;

// ── Module state ─────────────────────────────────────────────────────────────

let gResetMs  = null;   // epoch ms when 5h window resets
let gLastTs   = null;   // epoch ms of last token event
let gActiveWin = '5h';  // which chart window is shown
let gHistory   = [];    // [{ts, input, output}] from background

// ── Helpers ───────────────────────────────────────────────────────────────────

const numFmt = new Intl.NumberFormat('en-US');

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

function fillBar(fillId, pct) {
  const fill = el(fillId);
  if (!fill) return;
  const p = pct ?? 0;
  // Use max() so even tiny percentages leave a visible 4 px pip
  fill.style.width = p > 0 ? `max(4px, ${Math.min(100, p)}%)` : '0%';
  fill.className = ['gc-fill',
    p >= 90 ? 'red' : p >= 70 ? 'amber' : '',
  ].filter(Boolean).join(' ');
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
  const svgEl = el('sparkline');
  const emptyEl = el('chart-empty-msg');
  if (!svgEl) return;

  const W = 300, H = 52;
  const now = Date.now();
  const MS_5H = 5 * 60 * 60 * 1000;
  const MS_7D = 7 * 24 * 60 * 60 * 1000;
  const winMs = windowKey === '7d' ? MS_7D : MS_5H;

  const filtered = (history ?? []).filter(e => e.ts >= now - winMs);

  // Remove old drawn elements (keep the empty msg)
  svgEl.querySelectorAll('.spark-el').forEach(n => n.remove());

  if (filtered.length < 2) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  // Bucket into ~30 bars across the window
  const BUCKETS = 30;
  const bucketMs = winMs / BUCKETS;
  const counts = new Array(BUCKETS).fill(0);
  for (const e of filtered) {
    const idx = Math.min(BUCKETS - 1, Math.floor((e.ts - (now - winMs)) / bucketMs));
    counts[idx] += e.input + e.output;
  }

  const maxVal = Math.max(...counts, 1);
  const barW   = W / BUCKETS;
  const pad    = 2;

  // Draw bars
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.classList.add('spark-el');

  counts.forEach((v, i) => {
    if (v === 0) return;
    const barH  = Math.max(2, ((v / maxVal) * (H - pad * 2)));
    const x     = i * barW + 1;
    const y     = H - pad - barH;
    const rect  = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x',      x.toFixed(1));
    rect.setAttribute('y',      y.toFixed(1));
    rect.setAttribute('width',  Math.max(1, barW - 2).toFixed(1));
    rect.setAttribute('height', barH.toFixed(1));
    rect.setAttribute('rx',     '1');
    rect.setAttribute('fill',   '#e8620a');
    rect.setAttribute('opacity', '0.75');
    g.appendChild(rect);
  });

  svgEl.appendChild(g);
}

// ── Countdown (no re-fetch) ───────────────────────────────────────────────────

function tickCountdown() {
  if (gResetMs != null) {
    const left = Math.max(0, gResetMs - Date.now());
    setText('resets-in', `Resets in ${fmtDuration(left)}`);
  }
  setText('last-update', gLastTs ? fmtAgo(gLastTs) : '—');
}

// ── Full render ───────────────────────────────────────────────────────────────

function render(stats) {
  if (!stats) {
    el('empty-state').hidden    = false;
    el('main-content').hidden   = true;
    return;
  }

  const { tokens5h, tokens7d, pct5h, pct7d, limit5h, resetMs5h, timeLeft5h,
          plan, planName, planTable, history, lastTs, coreConnected,
          rlType, rlResetsAt, rlRemaining } = stats;

  // Show main content as long as we have ANY data (tokens OR rate-limit info)
  const hasData = tokens5h > 0 || tokens7d > 0 || rlResetsAt != null;

  el('empty-state').hidden  =  hasData;
  el('main-content').hidden = !hasData;

  if (!hasData) return;

  // Gauges
  setText('tokens-5h', fmtK(tokens5h));
  setText('tokens-7d', fmtK(tokens7d));
  setText('pct-5h', fmtPct(pct5h));
  setText('pct-7d', fmtPct(pct7d));
  fillBar('fill-5h', pct5h);
  fillBar('fill-7d', pct7d);

  // Use claude.ai's authoritative resetsAt if available, else fall back to estimated window
  const effectiveResetMs = rlResetsAt ? Date.parse(rlResetsAt) : (resetMs5h ?? null);
  gResetMs = effectiveResetMs;
  gLastTs  = lastTs ?? null;
  const left5h = effectiveResetMs ? Math.max(0, effectiveResetMs - Date.now()) : (timeLeft5h ?? null);
  setText('resets-in', left5h != null ? `Resets in ${fmtDuration(left5h)}` : '—');

  // Alert — use claude.ai's official rate-limit type if available
  if (rlType === 'over_limit') {
    showAlert('Rate limit reached — window resets ' + (rlResetsAt ? fmtDuration(Math.max(0, Date.parse(rlResetsAt) - Date.now())) : ''), true);
  } else if (rlType === 'approaching_limit') {
    const rem = rlRemaining != null ? ` (${rlRemaining} msgs left)` : '';
    showAlert(`Approaching limit${rem}`);
  } else if (pct5h != null && pct5h >= 90) {
    showAlert(`5-hour window ${Math.round(pct5h)}% used — limit approaching`, pct5h >= 100);
  } else {
    showAlert(null);
  }

  // Header
  const manifest = chrome.runtime.getManifest();
  setText('version', `v${manifest.version}`);
  setText('last-update', gLastTs ? fmtAgo(gLastTs) : '—');

  // Footer
  setText('plan-pill', planName ?? plan ?? '—');
  const dot = el('core-dot');
  if (dot) {
    dot.className = `core-dot ${coreConnected ? 'connected' : ''}`;
    dot.title     = coreConnected ? 'Core: connected' : 'Core: offline (standalone mode)';
  }

  // Plan table
  renderPlanTable(planTable);

  // Chart — keep whichever tab is active
  gHistory = history ?? [];
  renderSparkline(gHistory, gActiveWin);
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
      renderSparkline(gHistory, gActiveWin);
    });
  });
}

// ── Button wiring ─────────────────────────────────────────────────────────────

function setupButtons() {
  el('btn-open-claude')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://claude.ai' });
    window.close();
  });

  el('btn-settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Show version immediately
  const manifest = chrome.runtime.getManifest();
  setText('version', `v${manifest.version}`);

  setupButtons();
  setupTabs();
  loadAndRender();
  setInterval(loadAndRender, REFRESH_MS);
  setInterval(tickCountdown, COUNTDOWN_MS);
});

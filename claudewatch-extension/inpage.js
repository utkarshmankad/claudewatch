// Compact, isolated-world quota gauge shown on supported provider pages.
(async () => {
  const settings = await new Promise(resolve => chrome.storage.sync.get({ inPageGauges: true }, resolve));
  if (!settings.inPageGauges) return;
  const host = document.createElement('div');
  host.id = 'token-watcher-gauge-host';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host{all:initial}button{position:fixed;right:14px;bottom:14px;z-index:2147483647;border:1px solid #303044;border-radius:9px;background:#15151d;color:#eee;padding:8px 10px;font:11px ui-monospace,monospace;box-shadow:0 5px 18px #0005;cursor:pointer}button.stale{border-color:#b7791f}button.error{border-color:#dc2626}.muted{color:#8b8ba7}.bar{display:inline-block;width:42px;height:5px;margin:0 5px;background:#292938;border-radius:4px;overflow:hidden;vertical-align:1px}.fill{display:block;height:100%;background:#10b981}.warn{background:#f59e0b}.danger{background:#ef4444}</style>
    <button type="button" title="Open Token Watcher"><span id="name">TW</span> <span class="bar"><span id="fill" class="fill"></span></span><strong id="pct">—</strong> <span id="forecast" class="muted"></span></button>`;
  const button = root.querySelector('button');
  button.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_POPUP_CONTEXT' }));
  document.documentElement.appendChild(host);

  const site = location.hostname.includes('claude') ? 'claude' : location.hostname.includes('chatgpt') || location.hostname === 'chat.openai.com' ? 'chatgpt' : 'gemini';
  const names = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
  function refresh() {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, stats => {
      if (chrome.runtime.lastError || !stats) return;
      const usage = stats.providerUsage?.[site];
      const health = stats.providerHealth?.[site];
      const pct = usage?.pct5h;
      root.querySelector('#name').textContent = names[site];
      root.querySelector('#pct').textContent = pct == null ? '—' : `${Math.round(pct)}%`;
      const fill = root.querySelector('#fill');
      fill.style.width = `${Math.min(100, Math.max(0, pct ?? 0))}%`;
      fill.className = `fill${pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : ''}`;
      const meta = usage?.forecastMeta5h;
      root.querySelector('#forecast').textContent = meta ? `→${Math.round(meta.projectedPct)}% ${meta.confidence}` : '';
      button.className = health?.ok === false ? 'error' : health?.stale ? 'stale' : '';
      button.title = health?.ok === false ? 'Usage refresh failed; showing last known data' : 'Token Watcher provider quota';
    });
  }
  refresh();
  setInterval(refresh, 30_000);
})();

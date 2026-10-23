// Local analytics debug view. Reads the on-device event log and shows computed
// baseline metrics. Writes (delete) go through the service worker so it stays
// the only writer of the log.
(function () {
  const A = self.TokenWatcherAnalytics;
  const el = elementId => document.getElementById(elementId);

  function formatValue(m) {
    if (m.value === A.UNKNOWN) return 'unknown';
    if (typeof m.value === 'number' && !Number.isInteger(m.value)) return `${(m.value * 100).toFixed(1)}%`;
    return String(m.value);
  }

  function basis(m) {
    const counts = m.denominator != null ? `${m.numerator ?? '—'} / ${m.denominator}. ` : '';
    return `${counts}${m.note || m.formula}`;
  }

  async function render() {
    const store = A.createStore(A.chromeStorageAdapter());
    const [events, meta] = await Promise.all([store.list(), store.meta()]);
    el('analytics-schema').textContent = String(A.SCHEMA_VERSION);
    el('analytics-count').textContent = String(events.length);
    const body = el('analytics-metrics');
    body.replaceChildren(...A.computeMetrics(events, meta).map(m => {
      const row = document.createElement('tr');
      const label = document.createElement('th'); label.scope = 'row'; label.textContent = m.label;
      const value = document.createElement('td'); value.className = 'value'; value.textContent = formatValue(m);
      const why = document.createElement('td'); why.className = 'basis'; why.textContent = basis(m);
      row.append(label, value, why);
      return row;
    }));
    el('analytics-events').textContent = events.slice(-50).reverse()
      .map(e => `${new Date(e.ts).toISOString()}  ${e.name}  ${JSON.stringify(e.props)}`).join('\n') || 'No events recorded yet.';
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!A) return;
    chrome.runtime.sendMessage({ type: 'ANALYTICS_ACTIVE_DAY', surface: 'settings' }, () => void chrome.runtime.lastError);
    render();
    el('analytics-refresh').addEventListener('click', render);
    el('analytics-export').addEventListener('click', async () => {
      const json = await A.createStore(A.chromeStorageAdapter()).exportJson();
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: 'token-watcher-analytics.json' });
      link.click();
      URL.revokeObjectURL(url);
    });
    el('analytics-clear').addEventListener('click', () => {
      if (!confirm('Delete all local analytics events and metrics?')) return;
      chrome.runtime.sendMessage({ type: 'ANALYTICS_CLEAR' }, () => { void chrome.runtime.lastError; render(); });
    });
  });
})();

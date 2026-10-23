// Consent and deletion controls for the opt-in browser activity ledger.
// Writes go through the service worker so it stays the only writer.
(function () {
  const Act = self.TokenWatcherActivity;
  const el = id => document.getElementById(id);

  async function render() {
    const store = Act.createStore(Act.chromeStorageAdapter());
    const [enabled, events] = await Promise.all([store.isEnabled(), store.list()]);
    el('activity-enabled').checked = enabled;
    el('activity-count').textContent = enabled
      ? `${events.length} activity note${events.length === 1 ? '' : 's'} stored on this device.`
      : 'Recording is off. Nothing is being collected.';
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!Act) return;
    const list = (id, items) => el(id).replaceChildren(...items.map(text => Object.assign(document.createElement('li'), { textContent: text })));
    list('activity-recorded', Act.RECORDED_FIELDS);
    list('activity-never', Act.NEVER_RECORDED);
    render();
    el('activity-enabled').addEventListener('change', e => {
      chrome.runtime.sendMessage({ type: 'ACTIVITY_SET_ENABLED', enabled: e.target.checked }, () => { void chrome.runtime.lastError; render(); });
    });
    el('activity-delete').addEventListener('click', () => {
      if (!confirm('Delete all recorded browser activity from this device?')) return;
      chrome.runtime.sendMessage({ type: 'ACTIVITY_CLEAR' }, () => { void chrome.runtime.lastError; render(); });
    });
  });
})();

// content.js — isolated world, document_idle.
// Bridges postMessage events from interceptor.js (MAIN world) to the
// background service worker via chrome.runtime.sendMessage.

const TAG = '[TokenWatcher]';

// Detect which AI platform this tab is on
const SITE = (() => {
  const h = location.hostname;
  if (h === 'claude.ai' || h.endsWith('.claude.ai')) return 'claude';
  if (h === 'chatgpt.com' || h === 'chat.openai.com') return 'chatgpt';
  if (h === 'gemini.google.com') return 'gemini';
  return 'unknown';
})();

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.__tokenwatcher) return;

  const { type, site } = event.data;
  const resolvedSite = site ?? SITE;

  if (type === 'SSE_TOKENS') {
    const { inputTokens, outputTokens, rateLimit } = event.data;
    console.log(`${TAG} SSE_TOKENS [${resolvedSite}] — in:${inputTokens} out:${outputTokens}`, rateLimit);
    try {
      chrome.runtime.sendMessage(
        { type: 'SSE_TOKENS', inputTokens, outputTokens, rateLimit, site: resolvedSite, capturedAt: new Date().toISOString() },
        (r) => { if (!chrome.runtime.lastError) console.log(`${TAG} SSE ack`, r); }
      );
    } catch (e) { console.log(`${TAG} SSE send error:`, e.message); }
    return;
  }

  if (type === 'INTERCEPTED_API') {
    const { url, data } = event.data;
    try {
      chrome.runtime.sendMessage(
        { type: 'INTERCEPTED_API', url, data, site: resolvedSite },
        () => { chrome.runtime.lastError; }
      );
    } catch {}
    return;
  }

  if (type === 'PROVIDER_USAGE_RESPONSE') {
    const { requestId, ok, snapshot, error, status } = event.data;
    if (!pendingUsageRequests.has(requestId)) return;
    pendingUsageRequests.delete(requestId);
    try {
      chrome.runtime.sendMessage(
        { type: 'PROVIDER_USAGE_SNAPSHOT', site: resolvedSite, ok, snapshot, error, status, capturedAt: new Date().toISOString() },
        () => { chrome.runtime.lastError; }
      );
    } catch {}
    return;
  }
});

console.log(`${TAG} content script loaded on ${location.href} (site: ${SITE})`);

// Fetch authoritative quota utilization immediately and periodically. Unlike
// stream interception this needs no prompt and reflects the provider account,
// including usage produced by other clients where the provider aggregates it.
const pendingUsageRequests = new Set();
function requestProviderUsage() {
  if (SITE === 'unknown') return;
  const requestId = crypto.randomUUID();
  pendingUsageRequests.add(requestId);
  window.postMessage({ __tokenwatcherRequest: true, type: 'FETCH_PROVIDER_USAGE', requestId }, '*');
  setTimeout(() => pendingUsageRequests.delete(requestId), 30_000);
}

if (SITE !== 'unknown') {
  requestProviderUsage();
  setInterval(requestProviderUsage, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestProviderUsage();
  });
}

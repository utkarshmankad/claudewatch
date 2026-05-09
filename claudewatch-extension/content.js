// content.js — isolated world, document_idle.
// Bridges postMessage events from interceptor.js (MAIN world) to the
// background service worker via chrome.runtime.sendMessage.

const TAG = '[ClaudeWatch]';

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.__claudewatch) return;

  const { type } = event.data;

  if (type === 'SSE_TOKENS') {
    const { inputTokens, outputTokens, rateLimit } = event.data;
    console.log(`${TAG} SSE_TOKENS — in:${inputTokens} out:${outputTokens}`, rateLimit);
    try {
      chrome.runtime.sendMessage(
        { type: 'SSE_TOKENS', inputTokens, outputTokens, rateLimit, capturedAt: new Date().toISOString() },
        (r) => { if (!chrome.runtime.lastError) console.log(`${TAG} SSE ack`, r); }
      );
    } catch (e) { console.log(`${TAG} SSE send error:`, e.message); }
    return;
  }

  if (type === 'INTERCEPTED_API') {
    const { url, data } = event.data;
    try {
      chrome.runtime.sendMessage(
        { type: 'INTERCEPTED_API', url, data },
        () => { chrome.runtime.lastError; }
      );
    } catch {}
    return;
  }
});

console.log(`${TAG} content script loaded on ${location.href}`);

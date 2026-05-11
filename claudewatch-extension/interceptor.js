// interceptor.js — MAIN world, document_start.
// Wraps fetch/XHR to capture SSE token counts and API usage signals.

const TAG = '[ClaudeWatch]';

// ---------------------------------------------------------------------------
// URL matching
// ---------------------------------------------------------------------------

const USAGE_URL_PATTERNS = [
  '/api/usage',
  '/api/accounts',
  '/api/auth/session',
  '/api/bootstrap',
  '/api/user',
  '/api/me',
  '/api/entitlement',
  '/api/subscription',
  '/api/billing',
  '/api/organizations',
];

function isUsageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.includes('/experiences/')) return false; // UI experiment flags, not usage data
  if (url.includes('/completion'))   return false; // handled by SSE interceptor
  return USAGE_URL_PATTERNS.some(p => url.includes(p));
}

function isApiUrl(url) {
  return typeof url === 'string' && /\/api\//.test(url);
}

function bodyHasUsageSignal(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return false;
  const SIGNAL_KEYS = /token|limit|quota|usage|message|reset|plan|tier|entitlement|subscription|remaining|count|window/i;
  for (const k of Object.keys(obj)) {
    if (SIGNAL_KEYS.test(k)) return true;
    if (bodyHasUsageSignal(obj[k], depth + 1)) return true;
  }
  return false;
}

function extractUrl(args) {
  const input = args[0];
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return '';
}

// ---------------------------------------------------------------------------
// Bridge to isolated world
// ---------------------------------------------------------------------------

function postToIsolated(type, payload) {
  window.postMessage({ __claudewatch: true, type, ...payload }, window.location.origin);
}

// ---------------------------------------------------------------------------
// SSE token parser — handles Anthropic Messages API streaming format
// ---------------------------------------------------------------------------

// parseSseTokens returns token accumulators AND rate-limit info extracted from
// the claude.ai-specific "message_limit" event.
function parseSseTokens(buf, inputAcc, outputAcc, outCharsAcc, rateLimit) {
  const lines = buf.split('\n');
  const remaining = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const ev = JSON.parse(payload);

      // ── Public Messages API: message_start has usage ──────────────────────
      if (ev.type === 'message_start') {
        const u = ev.message?.usage;
        if (u) {
          // Log once so we can see the real field names
          console.log(`${TAG} message_start.usage:`, JSON.stringify(u));
          inputAcc  += u.input_tokens  ?? u.inputTokens  ?? 0;
          outputAcc += u.output_tokens ?? u.outputTokens ?? 0;
        }
      }

      // ── Public Messages API: message_delta may carry final output count ───
      if (ev.type === 'message_delta' && ev.usage) {
        outputAcc += ev.usage.output_tokens ?? ev.usage.outputTokens ?? 0;
      }

      // ── Approximate output tokens from streaming text chunks ──────────────
      // claude.ai internal format omits usage fields, so we count characters
      // in content_block_delta text events as a proxy (≈4 chars per token).
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        outCharsAcc += (ev.delta.text ?? '').length;
      }

      // ── claude.ai-specific: message_limit carries rate-limit metadata ─────
      if (ev.type === 'message_limit') {
        const ml = ev.message_limit ?? ev;  // some builds inline the fields directly
        console.log(`${TAG} message_limit raw:`, JSON.stringify(ev));
        rateLimit.type      = ml.type           ?? ev.type_of_limit     ?? null;
        rateLimit.resetsAt  = ml.resetsAt       ?? ml.resets_at         ??
                              ml.reset_at       ?? ml.windowResetsAt    ??
                              ml.window_resets_at ?? null;
        rateLimit.remaining = ml.remaining      ?? ml.messages_remaining ?? null;
      }

    } catch {}
  }
  return { remaining, inputAcc, outputAcc, outCharsAcc };
}

// ---------------------------------------------------------------------------
// Fetch interceptor
// ---------------------------------------------------------------------------

const _originalFetch = window.fetch;

window.fetch = async function (...args) {
  const response = await _originalFetch.apply(this, args);
  const url = extractUrl(args);

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json') || contentType.includes('text/json');
  const isSse  = contentType.includes('text/event-stream');

  // Log every SSE or /completion response so we know what URLs are streaming
  if (isSse || url.includes('/completion')) {
    console.log(`${TAG} [STREAM] ${url} | content-type: ${contentType}`);
  }

  // ── SSE completion stream ── intercept any SSE stream (text/event-stream)
  // or any URL ending with /completion, regardless of /api/ prefix
  const isCompletionUrl = isSse || url.includes('/completion');

  if (isCompletionUrl) {
    console.log(`${TAG} SSE tapping: ${url}`);

    if (response.body) {
      let [pageStream, ourStream] = response.body.tee();

      const reader  = ourStream.getReader();
      const decoder = new TextDecoder();
      let buf          = '';
      let inputTokens  = 0;
      let outputTokens = 0;
      let outCharsAcc  = 0;       // char count from text deltas for approximation
      const rateLimit  = { type: null, resetsAt: null, remaining: null };

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const r = parseSseTokens(buf, inputTokens, outputTokens, outCharsAcc, rateLimit);
            buf          = r.remaining;
            inputTokens  = r.inputAcc;
            outputTokens = r.outputAcc;
            outCharsAcc  = r.outCharsAcc;
          }

          // If the API didn't give us output tokens, approximate from char count
          if (outputTokens === 0 && outCharsAcc > 0) {
            outputTokens = Math.round(outCharsAcc / 4);
          }

          console.log(`${TAG} SSE done — in:${inputTokens} out:${outputTokens} (approx chars:${outCharsAcc}) rateLimit:`, JSON.stringify(rateLimit));

          if (inputTokens > 0 || outputTokens > 0 || rateLimit.resetsAt) {
            postToIsolated('SSE_TOKENS', { url, inputTokens, outputTokens, rateLimit });
          }
        } catch (err) {
          console.log(`${TAG} SSE read error:`, err.message);
        }
      };
      pump();

      // Build safe headers: drop Content-Encoding / Transfer-Encoding because
      // the browser already decoded the body before we called tee(); re-applying
      // those headers on a new Response would cause double-decompression.
      const safeHeaders = new Headers();
      response.headers.forEach((val, key) => {
        const k = key.toLowerCase();
        if (k === 'content-encoding' || k === 'transfer-encoding') return;
        safeHeaders.set(key, val);
      });

      return new Response(pageStream, {
        status:     response.status,
        statusText: response.statusText,
        headers:    safeHeaders,
      });
    }
    return response;
  }

  // ── Known JSON usage endpoints ──
  if (isUsageUrl(url) && isJson && !isSse) {
    console.log(`${TAG} API intercepted: ${url}`);
    const clone = response.clone();
    clone.json()
      .then(data => {
        postToIsolated('INTERCEPTED_API', { url, data });
      })
      .catch(() => {});
    return response;
  }

  // ── Discovery sweep ── (log any /api/ JSON that looks usage-related)
  if (isApiUrl(url) && isJson && !isSse && !url.includes('/experiences/')) {
    const clone = response.clone();
    clone.json()
      .then(data => {
        if (bodyHasUsageSignal(data)) {
          console.log(`${TAG} [DISCOVERY] ${url}`, JSON.stringify(data).slice(0, 500));
        }
      })
      .catch(() => {});
  }

  return response;
};

console.log(`${TAG} fetch interceptor installed`);

// ---------------------------------------------------------------------------
// XHR interceptor
// ---------------------------------------------------------------------------

const _xhrOpen = XMLHttpRequest.prototype.open;
const _xhrSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  this._cwUrl = typeof url === 'string' ? url : String(url);
  return _xhrOpen.apply(this, [method, url, ...rest]);
};

XMLHttpRequest.prototype.send = function (...args) {
  const url = this._cwUrl ?? '';
  if (isUsageUrl(url) || isApiUrl(url)) {
    this.addEventListener('load', function () {
      if (this.status < 200 || this.status >= 300) return;
      const ct = this.getResponseHeader('content-type') ?? '';
      if (!ct.includes('application/json') && !ct.includes('text/json')) return;
      try {
        const data = JSON.parse(this.responseText);
        if (isUsageUrl(url)) {
          postToIsolated('INTERCEPTED_API', { url, data });
        } else if (bodyHasUsageSignal(data)) {
          console.log(`${TAG} [DISCOVERY XHR] ${url}`, JSON.stringify(data).slice(0, 500));
        }
      } catch {}
    });
  }
  return _xhrSend.apply(this, args);
};

console.log(`${TAG} XHR interceptor installed`);

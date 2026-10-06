// interceptor.js — MAIN world, document_start.
// Wraps fetch/XHR to capture SSE token counts for Claude, ChatGPT, and Gemini.

const TAG = '[TokenWatcher]';

// ── Site detection ────────────────────────────────────────────────────────

const SITE = (function detectSite() {
  const h = location.hostname;
  if (h === 'claude.ai' || h.endsWith('.claude.ai')) return 'claude';
  if (h === 'chatgpt.com' || h === 'chat.openai.com') return 'chatgpt';
  if (h === 'gemini.google.com') return 'gemini';
  return 'unknown';
})();

// ── URL helpers ───────────────────────────────────────────────────────────

// Claude-specific usage REST endpoints to intercept for plan/rate-limit detection
const CLAUDE_USAGE_URL_PATTERNS = [
  '/api/usage', '/api/accounts', '/api/auth/session', '/api/bootstrap',
  '/api/user', '/api/me', '/api/entitlement', '/api/subscription',
  '/api/billing', '/api/organizations',
];

function isClaudeUsageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.includes('/experiences/')) return false;
  if (url.includes('/completion'))   return false;
  return CLAUDE_USAGE_URL_PATTERNS.some(p => url.includes(p));
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

// Returns true if a response URL + content-type pair represents a completion stream
function isCompletionStream(url, contentType) {
  const isSse = contentType.includes('text/event-stream');
  if (SITE === 'claude') {
    return isSse || url.includes('/completion');
  }
  if (SITE === 'chatgpt') {
    return isSse
      || url.includes('/backend-api/conversation')
      || url.includes('/backend-api/f/');
  }
  if (SITE === 'gemini') {
    return isSse
      || url.includes('StreamGenerate')
      || url.includes('BardChatUi')
      || url.includes('/generateContent')
      || url.includes('/streamGenerateContent');
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

// ── Bridge to isolated world ──────────────────────────────────────────────

function postToIsolated(type, payload) {
  window.postMessage({ __tokenwatcher: true, site: SITE, type, ...payload }, '*');
}

// ── Claude SSE parser ─────────────────────────────────────────────────────
// Handles Anthropic Messages API streaming format (message_start, message_delta,
// content_block_delta, message_limit).

function parseClaudeSse(buf, inputAcc, outputAcc, outCharsAcc, rateLimit) {
  const lines = buf.split('\n');
  const remaining = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const ev = JSON.parse(payload);

      if (ev.type === 'message_start') {
        const u = ev.message?.usage;
        if (u) {
          inputAcc  += u.input_tokens  ?? u.inputTokens  ?? 0;
          outputAcc += u.output_tokens ?? u.outputTokens ?? 0;
        }
      }

      if (ev.type === 'message_delta' && ev.usage) {
        outputAcc += ev.usage.output_tokens ?? ev.usage.outputTokens ?? 0;
      }

      // Approximate from text chars (≈4 chars/token) when API omits counts
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        outCharsAcc += (ev.delta.text ?? '').length;
      }

      if (ev.type === 'message_limit') {
        const ml = ev.message_limit ?? {};
        const win5h = ml.windows?.['5h'] ?? null;
        const win7d = ml.windows?.['7d'] ?? null;

        rateLimit.type      = ml.type      ?? null;
        rateLimit.remaining = ml.remaining ?? null;
        rateLimit.resetsAt  = win5h?.resets_at
          ? new Date(win5h.resets_at * 1000).toISOString()
          : (ml.resetsAt ?? ml.resets_at ?? null);
        rateLimit.resetsAt7d    = win7d?.resets_at ? new Date(win7d.resets_at * 1000).toISOString() : null;
        rateLimit.utilization5h = win5h?.utilization ?? null;
        rateLimit.utilization7d = win7d?.utilization ?? null;
      }
    } catch {}
  }
  return { remaining, inputAcc, outputAcc, outCharsAcc };
}

// ── ChatGPT SSE parser ────────────────────────────────────────────────────
// Handles OpenAI-format streaming: chat.completion.chunk events.
// The usage field appears in the final chunk when stream_options.include_usage=true.

function parseChatGptSse(buf, inputAcc, outputAcc, outCharsAcc) {
  const lines = buf.split('\n');
  const remaining = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const ev = JSON.parse(payload);
      if (ev.usage) {
        // Usage is authoritative — overwrite accumulated values
        inputAcc  = ev.usage.prompt_tokens     ?? ev.usage.input_tokens  ?? inputAcc;
        outputAcc = ev.usage.completion_tokens ?? ev.usage.output_tokens ?? outputAcc;
      }
      const text = ev.choices?.[0]?.delta?.content;
      if (text) outCharsAcc += text.length;
    } catch {}
  }
  return { remaining, inputAcc, outputAcc, outCharsAcc };
}

// ── Gemini chunk parser ───────────────────────────────────────────────────
// Handles gemini.google.com responses. Tries usageMetadata JSON extraction first;
// falls back to counting text chars from candidate parts.

function parseGeminiChunk(chunk, inputAcc, outputAcc, outCharsAcc) {
  const usageMatch = chunk.match(/"usageMetadata"\s*:\s*\{([^}]+)\}/);
  if (usageMatch) {
    try {
      const fields = usageMatch[1];
      const pm = fields.match(/"promptTokenCount"\s*:\s*(\d+)/);
      const cm = fields.match(/"candidatesTokenCount"\s*:\s*(\d+)/);
      if (pm) inputAcc  = parseInt(pm[1], 10);
      if (cm) outputAcc = parseInt(cm[1], 10);
    } catch {}
  }

  const textPattern = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = textPattern.exec(chunk)) !== null) {
    try {
      outCharsAcc += JSON.parse('"' + m[1] + '"').length;
    } catch {
      outCharsAcc += m[1].length;
    }
  }
  return { inputAcc, outputAcc, outCharsAcc };
}

// ── Fetch interceptor ─────────────────────────────────────────────────────

const _originalFetch = window.fetch;

window.fetch = async function (...args) {
  const response = await _originalFetch.apply(this, args);
  const url = extractUrl(args);

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json') || contentType.includes('text/json');
  const isSse  = contentType.includes('text/event-stream');

  if (isSse || url.includes('/completion') ||
      url.includes('/backend-api/conversation') ||
      url.includes('StreamGenerate') || url.includes('generateContent')) {
    console.log(`${TAG} [STREAM] ${SITE} ${url} | content-type: ${contentType}`);
  }

  // ── Completion stream interception ──
  if (isCompletionStream(url, contentType)) {
    console.log(`${TAG} tapping stream: ${url}`);

    if (response.body) {
      const [pageStream, ourStream] = response.body.tee();
      const reader  = ourStream.getReader();
      const decoder = new TextDecoder();

      let buf          = '';
      let inputTokens  = 0;
      let outputTokens = 0;
      let outCharsAcc  = 0;
      const rateLimit  = { type: null, resetsAt: null, remaining: null };

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            buf += chunk;

            if (SITE === 'claude') {
              const r = parseClaudeSse(buf, inputTokens, outputTokens, outCharsAcc, rateLimit);
              buf = r.remaining; inputTokens = r.inputAcc; outputTokens = r.outputAcc; outCharsAcc = r.outCharsAcc;
            } else if (SITE === 'chatgpt') {
              const r = parseChatGptSse(buf, inputTokens, outputTokens, outCharsAcc);
              buf = r.remaining; inputTokens = r.inputAcc; outputTokens = r.outputAcc; outCharsAcc = r.outCharsAcc;
            } else if (SITE === 'gemini') {
              const r = parseGeminiChunk(buf, inputTokens, outputTokens, outCharsAcc);
              buf = ''; inputTokens = r.inputAcc; outputTokens = r.outputAcc; outCharsAcc = r.outCharsAcc;
            }
          }

          if (outputTokens === 0 && outCharsAcc > 0) outputTokens = Math.round(outCharsAcc / 4);

          console.log(`${TAG} ${SITE} stream done — in:${inputTokens} out:${outputTokens} (chars:${outCharsAcc})`);

          if (inputTokens > 0 || outputTokens > 0 || rateLimit.resetsAt) {
            postToIsolated('SSE_TOKENS', {
              url, inputTokens, outputTokens,
              rateLimit: SITE === 'claude' ? rateLimit : null,
            });
          }
        } catch (err) {
          console.log(`${TAG} stream read error:`, err.message);
        }
      };
      pump();

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

  // ── Claude-specific: intercept known JSON usage endpoints ──
  if (SITE === 'claude' && isClaudeUsageUrl(url) && isJson && !isSse) {
    console.log(`${TAG} Claude API intercepted: ${url}`);
    const clone = response.clone();
    clone.json().then(data => postToIsolated('INTERCEPTED_API', { url, data })).catch(() => {});
    return response;
  }

  // Keep the quota snapshot even when ChatGPT itself initiated the request.
  // This is an important fallback when the session endpoint no longer exposes
  // an access token to a caller-created request.
  if (SITE === 'chatgpt' && url.includes('/backend-api/wham/usage') && isJson && !isSse) {
    const clone = response.clone();
    clone.json().then(data => postToIsolated('PROVIDER_USAGE_RESPONSE', {
      requestId: `intercepted-${Date.now()}`,
      ok: true,
      snapshot: { usage: data, email: data?.email ?? null },
    })).catch(() => {});
    return response;
  }

  // ── Discovery sweep (Claude only) ──
  if (SITE === 'claude' && isApiUrl(url) && isJson && !isSse && !url.includes('/experiences/')) {
    const clone = response.clone();
    clone.json().then(data => {
      if (bodyHasUsageSignal(data)) console.log(`${TAG} [DISCOVERY] ${url}`, JSON.stringify(data).slice(0, 500));
    }).catch(() => {});
  }

  return response;
};

console.log(`${TAG} fetch interceptor installed (site: ${SITE})`);

// ── XHR interceptor ───────────────────────────────────────────────────────

const _xhrOpen = XMLHttpRequest.prototype.open;
const _xhrSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  this._twUrl = typeof url === 'string' ? url : String(url);
  return _xhrOpen.apply(this, [method, url, ...rest]);
};

XMLHttpRequest.prototype.send = function (...args) {
  const url = this._twUrl ?? '';
  if (SITE === 'claude' && (isClaudeUsageUrl(url) || isApiUrl(url))) {
    this.addEventListener('load', function () {
      if (this.status < 200 || this.status >= 300) return;
      const ct = this.getResponseHeader('content-type') ?? '';
      if (!ct.includes('application/json') && !ct.includes('text/json')) return;
      try {
        const data = JSON.parse(this.responseText);
        if (isClaudeUsageUrl(url)) {
          postToIsolated('INTERCEPTED_API', { url, data });
        } else if (bodyHasUsageSignal(data)) {
          console.log(`${TAG} [DISCOVERY XHR] ${url}`, JSON.stringify(data).slice(0, 500));
        }
      } catch {}
    });
  }
  return _xhrSend.apply(this, args);
};

console.log(`${TAG} XHR interceptor installed (site: ${SITE})`);

// ── Authenticated usage bridge ───────────────────────────────────────────
// The isolated content script asks this MAIN-world script to call each site's
// authenticated quota endpoint. This works before a prompt is sent and avoids
// copying session credentials into extension storage.
window.addEventListener('message', async (event) => {
  const req = event.data;
  if (event.source !== window || !req?.__tokenwatcherRequest) return;
  if (req.type !== 'FETCH_PROVIDER_USAGE' || typeof req.requestId !== 'string') return;

  const respond = (payload) => postToIsolated('PROVIDER_USAGE_RESPONSE', {
    requestId: req.requestId,
    ...payload,
  });

  try {
    if (SITE === 'claude') {
      const orgResp = await _originalFetch.call(window, '/api/organizations', {
        credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' },
      });
      if (!orgResp.ok) return respond({ ok: false, status: orgResp.status, error: 'organizations_fetch_failed' });
      const orgBody = await orgResp.json();
      const orgs = Array.isArray(orgBody) ? orgBody : (orgBody.organizations ?? []);
      const results = [];
      for (const org of orgs) {
        const orgId = org?.uuid ?? org?.id;
        if (!orgId) continue;
        const usageResp = await _originalFetch.call(window, `/api/organizations/${orgId}/usage`, {
          credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' },
        });
        if (usageResp.ok) results.push({ orgId, org, usage: await usageResp.json() });
      }
      return respond({ ok: results.length > 0, snapshot: { organizations: results }, error: results.length ? null : 'usage_fetch_failed' });
    }

    if (SITE === 'chatgpt') {
      // Some ChatGPT sessions authorize this same-origin endpoint entirely by
      // cookie. Try that first; only require a session token if challenged.
      let usageResp = await _originalFetch.call(window, '/backend-api/wham/usage', {
        credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' },
      });
      let session = null;
      if (usageResp.status === 401 || usageResp.status === 403) {
      const sessionResp = await _originalFetch.call(window, '/api/auth/session', { credentials: 'include', cache: 'no-store' });
      if (!sessionResp.ok) return respond({ ok: false, status: sessionResp.status, error: 'session_fetch_failed' });
        session = await sessionResp.json();
        const accessToken = session?.accessToken ?? session?.access_token ?? null;
        if (!accessToken) return respond({ ok: false, status: 401, error: 'access_token_missing' });
        usageResp = await _originalFetch.call(window, '/backend-api/wham/usage', {
        credentials: 'include', cache: 'no-store',
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      }
      if (!usageResp.ok) return respond({ ok: false, status: usageResp.status, error: 'usage_fetch_failed' });
      const usage = await usageResp.json();
      return respond({ ok: true, snapshot: { usage, email: usage.email ?? session.user?.email ?? null } });
    }

    if (SITE === 'gemini') {
      let atToken = window.WIZ_global_data?.SNlM0e ?? '';
      if (!atToken) atToken = document.documentElement.innerHTML.match(/"SNlM0e":"([^"]+)"/)?.[1] ?? '';
      if (!atToken) return respond({ ok: false, status: 401, error: 'xsrf_token_missing' });
      const rpcId = 'jSf9Qc';
      const innerReq = JSON.stringify([[[rpcId, '[]', null, 'generic']]]);
      const body = `f.req=${encodeURIComponent(innerReq)}&at=${encodeURIComponent(atToken)}&`;
      const usageResp = await _originalFetch.call(window, `/_/BardChatUi/data/batchexecute?rpcids=${rpcId}&source-path=%2Fusage&rt=c`, {
        method: 'POST', credentials: 'include', cache: 'no-store', body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' },
      });
      if (!usageResp.ok) return respond({ ok: false, status: usageResp.status, error: 'usage_fetch_failed' });
      const wiz = window.WIZ_global_data ?? {};
      return respond({ ok: true, snapshot: {
        batchText: await usageResp.text(), rpcId,
        email: wiz.oPEP7c ?? null,
        accountId: wiz.S06Grb ?? wiz.FdrFJe ?? wiz.oPEP7c ?? null,
      } });
    }

    return respond({ ok: false, status: 400, error: 'unsupported_site' });
  } catch (err) {
    respond({ ok: false, status: 0, error: err?.message ?? 'usage_fetch_failed' });
  }
});

console.log(`${TAG} authenticated provider usage bridge installed`);

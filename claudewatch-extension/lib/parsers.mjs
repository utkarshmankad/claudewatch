// Pure parser functions shared between extension scripts and tests.
// No browser globals required — safe to import in Node.js.

// ── Site detection ─────────────────────────────────────────────────────────

/**
 * Map a hostname to an AI platform identifier.
 * @param {string} hostname
 * @returns {'claude'|'chatgpt'|'gemini'|'unknown'}
 */
export function detectSite(hostname) {
  const h = hostname || '';
  if (h === 'claude.ai' || h.endsWith('.claude.ai')) return 'claude';
  if (h === 'chatgpt.com' || h === 'chat.openai.com') return 'chatgpt';
  if (h === 'gemini.google.com') return 'gemini';
  return 'unknown';
}

// ── Claude SSE parser ──────────────────────────────────────────────────────

/**
 * Parse Anthropic Messages API SSE events from a buffer.
 * Mutates rateLimit in place.
 * @returns {{ remaining: string, inputAcc: number, outputAcc: number, outCharsAcc: number }}
 */
export function parseClaudeSse(buf, inputAcc, outputAcc, outCharsAcc, rateLimit) {
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
        rateLimit.resetsAt7d = win7d?.resets_at
          ? new Date(win7d.resets_at * 1000).toISOString()
          : null;
        rateLimit.utilization5h = win5h?.utilization ?? null;
        rateLimit.utilization7d = win7d?.utilization ?? null;
      }
    } catch {}
  }
  return { remaining, inputAcc, outputAcc, outCharsAcc };
}

// ── ChatGPT SSE parser ─────────────────────────────────────────────────────

/**
 * Parse OpenAI-format SSE events (chatgpt.com).
 * The usage field appears in the final chunk when stream_options.include_usage is set.
 * @returns {{ remaining: string, inputAcc: number, outputAcc: number, outCharsAcc: number }}
 */
export function parseChatGptSse(buf, inputAcc, outputAcc, outCharsAcc) {
  const lines = buf.split('\n');
  const remaining = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const ev = JSON.parse(payload);
      if (ev.usage) {
        // When present, usage is authoritative — overwrite accumulators
        inputAcc  = ev.usage.prompt_tokens     ?? ev.usage.input_tokens  ?? inputAcc;
        outputAcc = ev.usage.completion_tokens ?? ev.usage.output_tokens ?? outputAcc;
      }
      // Count text chars per delta for fallback approximation
      const text = ev.choices?.[0]?.delta?.content;
      if (text) outCharsAcc += text.length;
    } catch {}
  }
  return { remaining, inputAcc, outputAcc, outCharsAcc };
}

// ── Gemini chunk parser ────────────────────────────────────────────────────

/**
 * Parse a Gemini response chunk (gemini.google.com).
 * Tries usageMetadata first; falls back to counting text characters.
 * Processes the whole chunk rather than line-by-line.
 * @returns {{ inputAcc: number, outputAcc: number, outCharsAcc: number }}
 */
export function parseGeminiChunk(chunk, inputAcc, outputAcc, outCharsAcc) {
  // Try usageMetadata JSON extraction
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

  // Count text characters for approximation (≈4 chars per token)
  const textPattern = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = textPattern.exec(chunk)) !== null) {
    try {
      const text = JSON.parse('"' + m[1] + '"');
      outCharsAcc += text.length;
    } catch {
      outCharsAcc += m[1].length;
    }
  }

  return { inputAcc, outputAcc, outCharsAcc };
}

// ── Background helper functions ────────────────────────────────────────────

/**
 * Detect Claude subscription plan from any API response body.
 * @returns {string|null} plan key or null
 */
export function detectPlan(data) {
  const s = (typeof data === 'string' ? data : JSON.stringify(data)).toLowerCase();
  if (s.includes('max_20') || s.includes('max20'))           return 'max20x';
  if (s.includes('max_5')  || s.includes('max5'))            return 'max5x';
  if (s.includes('claude_max') || s.includes('"max"'))       return 'max';
  if (s.includes('claude_pro') || s.includes('"pro"')
      || s.includes("'pro'")  || s.includes('pro_plan'))     return 'pro';
  if (s.includes('claude_free') || s.includes('"free"')
      || s.includes('free_plan'))                             return 'free';
  return null;
}

/**
 * Extract rate-limit window info from any API response object.
 * @returns {{ type, resetsAt, remaining, utilization5h?, utilization7d? }|null}
 */
export function extractRateLimitFromResponse(data) {
  if (!data || typeof data !== 'object') return null;

  function fromWindows(windows) {
    if (!windows || typeof windows !== 'object') return null;
    const win5h = windows['5h'];
    const win7d = windows['7d'];
    if (!win5h && !win7d) return null;
    return {
      resetsAt:      win5h?.resets_at ? new Date(win5h.resets_at * 1000).toISOString() : null,
      resetsAt7d:    win7d?.resets_at ? new Date(win7d.resets_at * 1000).toISOString() : null,
      utilization5h: win5h?.utilization ?? null,
      utilization7d: win7d?.utilization ?? null,
    };
  }

  const windowsSources = [
    data.windows,
    data.rate_limit?.windows,
    data.message_limit?.windows,
    data.limits?.windows,
    data.usage?.windows,
  ];
  for (const w of windowsSources) {
    const r = fromWindows(w);
    if (r && (r.resetsAt || r.utilization5h != null)) {
      return {
        type:      data.type ?? data.rate_limit?.type ?? data.message_limit?.type ?? null,
        remaining: data.remaining ?? data.rate_limit?.remaining
                   ?? data.message_limit?.remaining ?? null,
        ...r,
      };
    }
  }

  const candidates = [
    data.rate_limit, data.rateLimit, data.message_limit,
    data.account?.rate_limit, data.usage?.rate_limit,
    data.limits?.rate_limit, data.limits,
    data.current_period, data.window, data.usage_window,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const resetsAt = c.resetsAt ?? c.resets_at ?? c.reset_at
                   ?? c.windowResetsAt ?? c.window_resets_at
                   ?? c.period_end ?? c.current_period_end ?? null;
    if (resetsAt) {
      return {
        type:      c.type ?? null,
        resetsAt,
        remaining: c.remaining ?? c.messages_remaining ?? null,
      };
    }
  }
  return null;
}

/**
 * Extract per-message token usage from a conversation response.
 * @returns {Array<{ts: number, input: number, output: number, src: string}>}
 */
export function extractConvTokens(data) {
  const events = [];
  const msgs = data?.chat_messages ?? data?.messages ?? null;
  if (!Array.isArray(msgs)) return events;

  for (const msg of msgs) {
    const createdAt = msg.created_at ?? msg.timestamp ?? null;
    if (!createdAt) continue;
    const ts = Date.parse(createdAt);
    if (!ts || isNaN(ts)) continue;

    const u = msg.usage ?? msg.token_usage ?? msg.tokens ?? null;
    if (!u) continue;

    const input  = u.input_tokens  ?? u.inputTokens  ?? u.prompt_tokens    ?? 0;
    const output = u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0;
    if (input === 0 && output === 0) continue;

    events.push({ ts, input, output, src: 'conv' });
  }
  return events;
}

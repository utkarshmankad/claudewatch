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

  if (data.five_hour || data.seven_day) {
    return {
      type: null,
      remaining: null,
      resetsAt: data.five_hour?.resets_at ?? null,
      resetsAt7d: data.seven_day?.resets_at ?? null,
      utilization5h: data.five_hour?.utilization ?? null,
      utilization7d: data.seven_day?.utilization ?? null,
    };
  }

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

// ── Provider quota normalization ─────────────────────────────────────────

export function classifyChatGptWindows(rateLimit) {
  const duration = window => window?.limit_window_seconds ?? window?.window_seconds ?? window?.window_size_seconds ?? null;
  const split = Math.sqrt(5 * 3600 * 7 * 24 * 3600);
  const primary = rateLimit?.primary_window ?? rateLimit?.session_window ?? rateLimit?.five_hour_window ?? null;
  const secondary = rateLimit?.secondary_window ?? rateLimit?.weekly_window ?? rateLimit?.seven_day_window ?? null;
  let w5h = null, w7d = null;
  for (const w of [primary, secondary]) {
    const seconds = duration(w);
    if (!w || !Number.isFinite(seconds)) continue;
    if (seconds < split) w5h = w; else w7d = w;
  }
  // The established wham contract uses primary=session and secondary=weekly.
  // Retain that fallback only when duration metadata is absent. The two slots
  // are short/long windows; consumers display the provider-reported duration.
  if (!w5h && primary && !Number.isFinite(duration(primary))) w5h = primary;
  if (!w7d && secondary && !Number.isFinite(duration(secondary))) w7d = secondary;
  return { w5h, w7d };
}

const chatGptPct = window => {
  if (!window) return null;
  const explicit = window.used_percent ?? window.utilization_percent ?? window.percent_used;
  if (Number.isFinite(explicit)) return Math.min(100, Math.max(0, explicit));
  const used = window.used ?? window.tokens_used;
  const limit = window.limit ?? window.token_limit;
  return Number.isFinite(used) && Number.isFinite(limit) && limit > 0
    ? Math.min(100, Math.max(0, used / limit * 100)) : null;
};

const chatGptReset = window => {
  const value = window?.reset_at ?? window?.reset_time ?? window?.resets_at;
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  if (Number.isFinite(value)) return new Date(value * (value < 1e12 ? 1000 : 1)).toISOString();
  if (Number.isFinite(window?.reset_after_seconds)) return new Date(Date.now() + window.reset_after_seconds * 1000).toISOString();
  return null;
};

export function normalizeChatGptUsage(raw, email = null) {
  const usage = raw?.usage?.rate_limit ? raw.usage : raw?.data?.rate_limit ? raw.data : raw?.usage ?? raw;
  if (!usage?.rate_limit) return null;
  const { w5h, w7d } = classifyChatGptWindows(usage.rate_limit);
  const duration = window => window?.limit_window_seconds ?? window?.window_seconds ?? window?.window_size_seconds ?? null;
  return {
    site: 'chatgpt', accountId: usage.account_id ?? usage.user_id ?? email ?? null, email,
    plan: usage.plan_type ?? usage.plan ?? null,
    pct5h: chatGptPct(w5h), pct7d: chatGptPct(w7d),
    resetsAt5h: chatGptReset(w5h), resetsAt7d: chatGptReset(w7d),
    windowSeconds5h: duration(w5h), windowSeconds7d: duration(w7d),
  };
}

export function parseBatchResponse(text, rpcId) {
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === ")]}'" || /^\d+$/.test(trimmed)) continue;
    try {
      const rows = JSON.parse(trimmed);
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.[0] === 'wrb.fr' && row?.[1] === rpcId && row[2]) return JSON.parse(row[2]);
      }
    } catch {}
  }
  return null;
}

export function forecastWindow(history, { site, accountId, key, currentPct, resetsAt, now = Date.now() }) {
  return forecastWindowDetails(history, { site, accountId, key, currentPct, resetsAt, now })?.projectedPct ?? null;
}

export function forecastWindowDetails(history, { site, accountId, key, currentPct, resetsAt, now = Date.now() }) {
  const resetMs = Date.parse(resetsAt ?? '');
  if (currentPct == null || !Number.isFinite(resetMs) || resetMs <= now) return null;
  const pctKey = key === '5h' ? 'pct5h' : 'pct7d';
  const resetKey = key === '5h' ? 'resetsAt5h' : 'resetsAt7d';
  const lookbackMs = key === '5h' ? 6 * 3600000 : 7 * 24 * 3600000;
  const targetResetMs = Date.parse(resetsAt);
  const samples = history.filter(h => {
    const sampleResetMs = Date.parse(h[resetKey] ?? '');
    return h.ts >= now - lookbackMs && h.ts <= now && h.site === site && h.accountId === accountId &&
      Number.isFinite(h[pctKey]) && Number.isFinite(sampleResetMs) && Math.abs(sampleResetMs - targetResetMs) < 60_000;
  })
    .sort((a, b) => a.ts - b.ts);
  if (samples.length < 2) return null;
  const spanHours = (samples.at(-1).ts - samples[0].ts) / 3600000;
  if (spanHours < 0.5) return null;
  const growth = Math.max(0, samples.at(-1)[pctKey] - samples[0][pctKey]);
  const ratePerHour = growth / spanHours;
  const horizonHours = (resetMs - now) / 3600000;
  const coverageTarget = key === '5h' ? 3 : 48;
  const confidenceScore = Math.min(1, samples.length / 12) * Math.min(1, spanHours / coverageTarget) * Math.min(1, 12 / Math.max(1, horizonHours));
  return {
    projectedPct: Math.min(100, Math.max(0, currentPct, currentPct + ratePerHour * horizonHours)),
    ratePerHour,
    sampleCount: samples.length,
    confidence: confidenceScore >= 0.67 ? 'high' : confidenceScore >= 0.34 ? 'medium' : 'low',
  };
}

export function stableAccountKey(snapshot) {
  const raw = snapshot?.organizationId ?? snapshot?.accountId ?? snapshot?.email;
  if (!snapshot?.site || !raw) return null;
  return `${snapshot.site}:${String(raw)}`;
}

export function validateProviderSnapshot(snapshot) {
  if (!snapshot || !['claude', 'chatgpt', 'gemini'].includes(snapshot.site)) return 'invalid_site';
  if (!stableAccountKey(snapshot)) return 'account_identity_missing';
  for (const key of ['pct5h', 'pct7d']) {
    const value = snapshot[key];
    if (value != null && (!Number.isFinite(value) || value < 0 || value > 1000)) return `invalid_${key}`;
  }
  for (const key of ['resetsAt5h', 'resetsAt7d']) {
    if (snapshot[key] != null && !Number.isFinite(Date.parse(snapshot[key]))) return `invalid_${key}`;
  }
  return null;
}

export function nextPollDelay({ ok, status, consecutiveFailures, baseMs = 300000, maxMs = 3600000, jitter = 1 }) {
  if (ok) return baseMs;
  const rateLimitedMultiplier = status === 429 ? 4 : 1;
  return Math.round(Math.min(maxMs, baseMs * (2 ** Math.min(Math.max(0, consecutiveFailures - 1), 4)) * rateLimitedMultiplier) * jitter);
}

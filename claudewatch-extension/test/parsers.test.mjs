import { describe, it, expect } from 'vitest';
import {
  detectSite,
  parseClaudeSse,
  parseChatGptSse,
  parseGeminiChunk,
  detectPlan,
  extractRateLimitFromResponse,
  extractConvTokens,
  classifyChatGptWindows,
  parseBatchResponse,
  forecastWindow,
} from '../lib/parsers.mjs';

// ── detectSite ──────────────────────────────────────────────────────────────

describe('detectSite', () => {
  it('returns claude for claude.ai', () => {
    expect(detectSite('claude.ai')).toBe('claude');
  });
  it('returns claude for subdomain of claude.ai', () => {
    expect(detectSite('api.claude.ai')).toBe('claude');
  });
  it('returns chatgpt for chatgpt.com', () => {
    expect(detectSite('chatgpt.com')).toBe('chatgpt');
  });
  it('returns chatgpt for chat.openai.com', () => {
    expect(detectSite('chat.openai.com')).toBe('chatgpt');
  });
  it('returns gemini for gemini.google.com', () => {
    expect(detectSite('gemini.google.com')).toBe('gemini');
  });
  it('returns unknown for other domains', () => {
    expect(detectSite('openai.com')).toBe('unknown');
    expect(detectSite('google.com')).toBe('unknown');
    expect(detectSite('')).toBe('unknown');
  });
});

// ── parseClaudeSse ──────────────────────────────────────────────────────────

describe('parseClaudeSse', () => {
  const rl = () => ({ type: null, resetsAt: null, remaining: null });

  it('extracts input and output tokens from message_start + message_delta', () => {
    const buf = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0}}}',
      'data: {"type":"message_delta","usage":{"output_tokens":50}}',
      '',
    ].join('\n');
    const r = parseClaudeSse(buf, 0, 0, 0, rl());
    expect(r.inputAcc).toBe(100);
    expect(r.outputAcc).toBe(50);
  });

  it('counts text chars from content_block_delta for approximation', () => {
    const buf = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello world"}}',
      '',
    ].join('\n');
    const r = parseClaudeSse(buf, 0, 0, 0, rl());
    expect(r.outCharsAcc).toBe(11);
  });

  it('extracts rate-limit info from message_limit event', () => {
    const rateLimitObj = rl();
    const epoch5h = 1700000000;
    const buf = [
      `data: {"type":"message_limit","message_limit":{"type":"approaching_limit","remaining":3,"windows":{"5h":{"resets_at":${epoch5h},"utilization":0.75}}}}`,
      '',
    ].join('\n');
    parseClaudeSse(buf, 0, 0, 0, rateLimitObj);
    expect(rateLimitObj.type).toBe('approaching_limit');
    expect(rateLimitObj.remaining).toBe(3);
    expect(rateLimitObj.resetsAt).toBe(new Date(epoch5h * 1000).toISOString());
    expect(rateLimitObj.utilization5h).toBe(0.75);
  });

  it('accumulates across multiple calls (incremental buffer)', () => {
    const rl1 = rl();
    const line1 = 'data: {"type":"message_start","message":{"usage":{"input_tokens":200,"output_tokens":0}}}';
    const r1 = parseClaudeSse(line1 + '\n', 0, 0, 0, rl1);
    expect(r1.inputAcc).toBe(200);

    const line2 = 'data: {"type":"message_delta","usage":{"output_tokens":75}}';
    const r2 = parseClaudeSse(line2 + '\n', r1.inputAcc, r1.outputAcc, r1.outCharsAcc, rl1);
    expect(r2.inputAcc).toBe(200);
    expect(r2.outputAcc).toBe(75);
  });

  it('ignores malformed JSON lines', () => {
    const buf = 'data: not-valid-json\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n';
    const r = parseClaudeSse(buf, 0, 0, 0, rl());
    expect(r.inputAcc).toBe(10);
  });

  it('leaves partial last line in remaining', () => {
    const buf = 'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\ndata: partial';
    const r = parseClaudeSse(buf, 0, 0, 0, rl());
    expect(r.remaining).toBe('data: partial');
    expect(r.inputAcc).toBe(5);
  });
});

// ── parseChatGptSse ─────────────────────────────────────────────────────────

describe('parseChatGptSse', () => {
  it('extracts usage from final chunk', () => {
    const buf = [
      'data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"},"finish_reason":null}],"usage":null}',
      'data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":40,"total_tokens":160}}',
      'data: [DONE]',
      '',
    ].join('\n');
    const r = parseChatGptSse(buf, 0, 0, 0);
    expect(r.inputAcc).toBe(120);
    expect(r.outputAcc).toBe(40);
  });

  it('counts text chars from delta content', () => {
    const buf = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      '',
    ].join('\n');
    const r = parseChatGptSse(buf, 0, 0, 0);
    expect(r.outCharsAcc).toBe(11);
  });

  it('usage field overwrites accumulator (not adds)', () => {
    // First partial call
    const buf1 = 'data: {"choices":[{"delta":{"content":"abc"}}]}\n';
    const r1 = parseChatGptSse(buf1, 0, 0, 0);
    expect(r1.outputAcc).toBe(0); // no usage yet
    expect(r1.outCharsAcc).toBe(3);

    // Final call with usage
    const buf2 = 'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":50,"completion_tokens":20}}\n';
    const r2 = parseChatGptSse(buf2, r1.inputAcc, r1.outputAcc, r1.outCharsAcc);
    expect(r2.inputAcc).toBe(50);
    expect(r2.outputAcc).toBe(20);
  });

  it('handles [DONE] gracefully', () => {
    const buf = 'data: [DONE]\n';
    const r = parseChatGptSse(buf, 5, 10, 0);
    expect(r.inputAcc).toBe(5);
    expect(r.outputAcc).toBe(10);
  });

  it('ignores malformed JSON', () => {
    const buf = 'data: {broken json}\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n';
    const r = parseChatGptSse(buf, 0, 0, 0);
    expect(r.outCharsAcc).toBe(2);
  });

  it('returns remaining partial line', () => {
    const buf = 'data: {"choices":[{"delta":{"content":"abc"}}]}\ndata: incomplete';
    const r = parseChatGptSse(buf, 0, 0, 0);
    expect(r.remaining).toBe('data: incomplete');
  });
});

// ── parseGeminiChunk ────────────────────────────────────────────────────────

describe('parseGeminiChunk', () => {
  it('extracts promptTokenCount and candidatesTokenCount from usageMetadata', () => {
    const chunk = `{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}],"usageMetadata":{"promptTokenCount":80,"candidatesTokenCount":30,"totalTokenCount":110}}`;
    const r = parseGeminiChunk(chunk, 0, 0, 0);
    expect(r.inputAcc).toBe(80);
    expect(r.outputAcc).toBe(30);
  });

  it('counts text chars when no usageMetadata present', () => {
    const chunk = `{"candidates":[{"content":{"parts":[{"text":"Hello world"}]}}]}`;
    const r = parseGeminiChunk(chunk, 0, 0, 0);
    expect(r.outCharsAcc).toBe(11);
    expect(r.inputAcc).toBe(0);
    expect(r.outputAcc).toBe(0);
  });

  it('accumulates outCharsAcc from multiple text fields', () => {
    const chunk = `[{"text":"foo"},{"text":"bar baz"}]`;
    const r = parseGeminiChunk(chunk, 0, 0, 0);
    expect(r.outCharsAcc).toBe(10); // 3 + 7
  });

  it('keeps existing accumulators if chunk has no useful data', () => {
    const r = parseGeminiChunk('{"status":"ok"}', 5, 10, 20);
    expect(r.inputAcc).toBe(5);
    expect(r.outputAcc).toBe(10);
    expect(r.outCharsAcc).toBe(20);
  });

  it('handles malformed usageMetadata gracefully', () => {
    const chunk = `{"usageMetadata":{"promptTokenCount":"not-a-number"}}`;
    const r = parseGeminiChunk(chunk, 0, 0, 0);
    // NaN from parseInt("not-a-number") — expect no meaningful value set
    expect(Number.isNaN(r.inputAcc) || r.inputAcc === 0).toBe(true);
  });
});

// ── detectPlan ──────────────────────────────────────────────────────────────

describe('detectPlan', () => {
  it('detects max20x plan', () => {
    expect(detectPlan({ plan: 'claude_max_20' })).toBe('max20x');
    expect(detectPlan('max20')).toBe('max20x');
  });
  it('detects max5x plan', () => {
    expect(detectPlan({ plan: 'claude_max_5' })).toBe('max5x');
  });
  it('detects max plan', () => {
    expect(detectPlan({ plan: 'claude_max' })).toBe('max');
  });
  it('detects pro plan', () => {
    expect(detectPlan({ subscription: 'claude_pro' })).toBe('pro');
    // JSON.stringify({plan:"pro"}) → '{"plan":"pro"}' which contains the substring "pro"
    expect(detectPlan({ plan: 'pro' })).toBe('pro');
    expect(detectPlan({ plan: 'pro_plan' })).toBe('pro');
  });
  it('detects free plan', () => {
    expect(detectPlan({ plan: 'claude_free' })).toBe('free');
  });
  it('returns null for unrecognized data', () => {
    expect(detectPlan({ foo: 'bar' })).toBe(null);
    expect(detectPlan({})).toBe(null);
  });
});

// ── extractRateLimitFromResponse ────────────────────────────────────────────

describe('extractRateLimitFromResponse', () => {
  it('returns null for non-objects', () => {
    expect(extractRateLimitFromResponse(null)).toBe(null);
    expect(extractRateLimitFromResponse('string')).toBe(null);
  });

  it('extracts from windows.5h.resets_at', () => {
    const data = {
      type: 'approaching_limit',
      remaining: 5,
      windows: {
        '5h': { resets_at: 1700000000, utilization: 0.8 },
        '7d': { resets_at: 1700100000, utilization: 0.3 },
      },
    };
    const r = extractRateLimitFromResponse(data);
    expect(r).not.toBe(null);
    expect(r.type).toBe('approaching_limit');
    expect(r.remaining).toBe(5);
    expect(r.resetsAt).toBe(new Date(1700000000 * 1000).toISOString());
    expect(r.utilization5h).toBe(0.8);
    expect(r.utilization7d).toBe(0.3);
  });

  it('extracts the authoritative claude.ai /usage response shape', () => {
    const data = {
      five_hour: { utilization: 42.5, resets_at: '2026-09-01T20:00:00Z' },
      seven_day: { utilization: 67.25, resets_at: '2026-09-05T00:00:00Z' },
    };
    expect(extractRateLimitFromResponse(data)).toMatchObject({
      utilization5h: 42.5,
      utilization7d: 67.25,
      resetsAt: '2026-09-01T20:00:00Z',
      resetsAt7d: '2026-09-05T00:00:00Z',
    });
  });

  it('extracts from nested rate_limit.windows', () => {
    const data = {
      account: { name: 'test' },
      rate_limit: {
        type: 'over_limit',
        remaining: 0,
        windows: { '5h': { resets_at: 1700000000, utilization: 1.0 } },
      },
    };
    const r = extractRateLimitFromResponse(data);
    expect(r).not.toBe(null);
    expect(r.type).toBe('over_limit');
    expect(r.utilization5h).toBe(1.0);
  });

  it('falls back to flat resetsAt field', () => {
    const data = { rate_limit: { resetsAt: '2024-01-01T00:00:00.000Z', remaining: 10 } };
    const r = extractRateLimitFromResponse(data);
    expect(r).not.toBe(null);
    expect(r.resetsAt).toBe('2024-01-01T00:00:00.000Z');
  });
});

// ── extractConvTokens ───────────────────────────────────────────────────────

describe('extractConvTokens', () => {
  it('returns empty array for missing/non-array messages', () => {
    expect(extractConvTokens({})).toEqual([]);
    expect(extractConvTokens({ chat_messages: 'not-array' })).toEqual([]);
    expect(extractConvTokens(null)).toEqual([]);
  });

  it('extracts token events from chat_messages array', () => {
    const data = {
      chat_messages: [
        { created_at: '2024-01-01T00:00:00.000Z', usage: { input_tokens: 50, output_tokens: 30 } },
        { created_at: '2024-01-01T00:01:00.000Z', usage: { input_tokens: 0,  output_tokens: 0  } }, // skip zeros
        { created_at: '2024-01-01T00:02:00.000Z', usage: { input_tokens: 80, output_tokens: 45 } },
      ],
    };
    const events = extractConvTokens(data);
    expect(events).toHaveLength(2);
    expect(events[0].input).toBe(50);
    expect(events[0].output).toBe(30);
    expect(events[0].src).toBe('conv');
    expect(events[1].input).toBe(80);
    expect(events[1].output).toBe(45);
  });

  it('handles messages array (alternate key)', () => {
    const data = {
      messages: [
        { timestamp: '2024-06-01T12:00:00.000Z', tokens: { input_tokens: 20, output_tokens: 10 } },
      ],
    };
    const events = extractConvTokens(data);
    expect(events).toHaveLength(1);
    expect(events[0].input).toBe(20);
  });

  it('skips messages with no created_at', () => {
    const data = {
      chat_messages: [
        { usage: { input_tokens: 10, output_tokens: 5 } }, // no timestamp
      ],
    };
    expect(extractConvTokens(data)).toEqual([]);
  });
});

describe('provider usage normalization', () => {
  it('classifies ChatGPT windows by reported duration rather than position', () => {
    const weekly = { used_percent: 40, limit_window_seconds: 604800 };
    const session = { used_percent: 20, limit_window_seconds: 18000 };
    expect(classifyChatGptWindows({ primary_window: weekly, secondary_window: session }))
      .toEqual({ w5h: session, w7d: weekly });
  });

  it('parses Gemini batchexecute envelopes', () => {
    const payload = [5, [[100, 0.25, 1, [[1900000000, 0]]]]];
    const text = `)]}'\n123\n${JSON.stringify([['wrb.fr', 'jSf9Qc', JSON.stringify(payload), null]])}`;
    expect(parseBatchResponse(text, 'jSf9Qc')).toEqual(payload);
  });

  it('forecasts within one account and treats a reset as a new window', () => {
    const now = Date.parse('2026-09-02T12:00:00Z');
    const oldReset = '2026-09-02T10:00:00Z';
    const reset = '2026-09-02T16:00:00Z';
    const history = [
      { ts: now - 2 * 3600000, site: 'chatgpt', accountId: 'u1', pct5h: 80, resetsAt5h: oldReset },
      { ts: now - 1 * 3600000, site: 'chatgpt', accountId: 'u1', pct5h: 10, resetsAt5h: reset },
      { ts: now, site: 'chatgpt', accountId: 'u1', pct5h: 20, resetsAt5h: reset },
      { ts: now, site: 'chatgpt', accountId: 'someone-else', pct5h: 99, resetsAt5h: reset },
    ];
    expect(forecastWindow(history, { site: 'chatgpt', accountId: 'u1', key: '5h', currentPct: 20, resetsAt: reset, now })).toBe(60);
  });
});

import type { CollectorAdapter, ParseOutcome } from '../types.js';
import { isObj, parseTime, safeModel, sessionKey, tokenCount } from '../hash.js';
import { join } from 'node:path';

// Format: ~/.claude/projects/**/*.jsonl, one JSON object per line. Assistant
// entries carry timestamp, sessionId and message.usage (input_tokens,
// output_tokens, cache_read_input_tokens, cache_creation_input_tokens).
// Only those numeric fields and the model id are read; message.content never is.
function parseLine(line: string): ParseOutcome {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return { kind: 'unsupported', reason: 'invalid json' }; }
  if (!isObj(o)) return { kind: 'unsupported', reason: 'line is not an object' };
  if (o.type !== 'assistant') return { kind: 'ignored' };
  const msg = o.message;
  if (!isObj(msg) || !isObj(msg.usage)) return { kind: 'ignored' }; // e.g. synthetic or error assistant entries
  const at = parseTime(o.timestamp);
  const input = tokenCount(msg.usage.input_tokens);
  const output = tokenCount(msg.usage.output_tokens);
  if (at === null || input === null || output === null || typeof o.sessionId !== 'string') {
    return { kind: 'unsupported', reason: 'assistant entry missing timestamp, sessionId or token counts' };
  }
  const cachedTokens = (tokenCount(msg.usage.cache_read_input_tokens) ?? 0) + (tokenCount(msg.usage.cache_creation_input_tokens) ?? 0);
  return { kind: 'observation', observation: { at, sessionKey: sessionKey(o.sessionId), model: safeModel(msg.model), inputTokens: input, outputTokens: output, cachedTokens } };
}

export const claudeCodeAdapter: CollectorAdapter = {
  id: 'claude_code', provider: 'claude', source: 'claude_code', label: 'Claude Code', format: 'jsonl',
  roots: (home, _p, env) => [join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')],
  matches: (n) => n.endsWith('.jsonl'),
  parseLine,
  supportedPlatforms: ['darwin', 'linux', 'win32'],
};

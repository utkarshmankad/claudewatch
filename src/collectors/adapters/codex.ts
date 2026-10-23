import type { CollectorAdapter, ParseOutcome } from '../types.js';
import { isObj, parseTime, safeModel, tokenCount } from '../hash.js';
import { join } from 'node:path';

// Format: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Each line is
// {timestamp, type, payload}. Usage comes from event_msg lines whose payload is
// {type:'token_count', info:{last_token_usage:{input_tokens,cached_input_tokens,output_tokens}}}.
// A line carries no session id, so sessionKey is left empty and the runner keys the
// observation by the rollout file (one file is one session).
function parseLine(line: string): ParseOutcome {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return { kind: 'unsupported', reason: 'invalid json' }; }
  if (!isObj(o) || typeof o.type !== 'string') return { kind: 'unsupported', reason: 'line has no type' };
  if (o.type !== 'event_msg') return { kind: 'ignored' };
  const p = o.payload;
  if (!isObj(p) || p.type !== 'token_count') return { kind: 'ignored' };
  if (p.info === null) return { kind: 'ignored' }; // rate-limit-only event before first turn
  if (!isObj(p.info) || !isObj(p.info.last_token_usage)) return { kind: 'unsupported', reason: 'token_count without last_token_usage' };
  const u = p.info.last_token_usage;
  const at = parseTime(o.timestamp);
  const input = tokenCount(u.input_tokens);
  const output = tokenCount(u.output_tokens);
  if (at === null || input === null || output === null) return { kind: 'unsupported', reason: 'token_count missing timestamp or counts' };
  return { kind: 'observation', observation: { at, sessionKey: '', model: safeModel(p.model), inputTokens: input, outputTokens: output, cachedTokens: tokenCount(u.cached_input_tokens) ?? 0 } };
}

export const codexAdapter: CollectorAdapter = {
  id: 'codex', provider: 'chatgpt', source: 'codex', label: 'Codex CLI', format: 'jsonl',
  roots: (home, _p, env) => [join(env.CODEX_HOME || join(home, '.codex'), 'sessions')],
  matches: (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
  parseLine,
  supportedPlatforms: ['darwin', 'linux'],
};

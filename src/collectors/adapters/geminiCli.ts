import type { CollectorAdapter, ParseOutcome } from '../types.js';
import { isObj, parseTime, safeModel, sessionKey, tokenCount } from '../hash.js';
import { join } from 'node:path';

// Format: ~/.gemini/tmp/<project-hash>/chats/session-*.json, one JSON document
// {sessionId, messages:[{type:'user'|'gemini', timestamp, model?, tokens?:{input,output,cached}}]}.
// Only gemini messages' tokens/timestamp/model are read; content and thoughts never are.
function parseFile(text: string): ParseOutcome[] {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return [{ kind: 'unsupported', reason: 'invalid json (possibly a partial write)' }]; }
  if (!isObj(doc) || typeof doc.sessionId !== 'string' || !Array.isArray(doc.messages)) return [{ kind: 'unsupported', reason: 'no sessionId/messages' }];
  const key = sessionKey(doc.sessionId);
  return doc.messages.map((m): ParseOutcome => {
    if (!isObj(m) || typeof m.type !== 'string') return { kind: 'unsupported', reason: 'message has no type' };
    if (m.type !== 'gemini' || !isObj(m.tokens)) return { kind: 'ignored' };
    const at = parseTime(m.timestamp);
    const input = tokenCount(m.tokens.input);
    const output = tokenCount(m.tokens.output);
    if (at === null || input === null || output === null) return { kind: 'unsupported', reason: 'gemini message missing timestamp or counts' };
    return { kind: 'observation', observation: { at, sessionKey: key, model: safeModel(m.model), inputTokens: input, outputTokens: output, cachedTokens: tokenCount(m.tokens.cached) ?? 0 } };
  });
}

export const geminiCliAdapter: CollectorAdapter = {
  id: 'gemini_cli', provider: 'gemini', source: 'gemini_cli', label: 'Gemini CLI', format: 'json',
  roots: (home, _p, env) => [join(env.GEMINI_CLI_HOME || home, '.gemini', 'tmp')],
  matches: (n) => n.startsWith('session-') && n.endsWith('.json'),
  parseLine: () => ({ kind: 'unsupported', reason: 'gemini_cli is a whole-file format' }),
  parseFile,
  supportedPlatforms: ['darwin', 'linux'],
};

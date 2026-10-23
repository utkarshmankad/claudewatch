// Local coding-assistant collectors (Prompt 1.3). See docs/CODING_COLLECTORS.md.
import type { LedgerSource, Provider } from '../ledger/types.js';

export const COLLECTOR_IDS = ['claude_code', 'codex', 'gemini_cli'] as const;
export type CollectorId = (typeof COLLECTOR_IDS)[number];

// The only data an adapter may emit. There is deliberately no free-text field:
// prompt and response content cannot leave an adapter.
export interface Observation {
  at: number; // epoch ms UTC, from the log entry
  sessionKey: string; // sha256 prefix of the tool's session id; never the raw id
  model?: string; // model identifier only
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export type ParseOutcome =
  | { kind: 'observation'; observation: Observation }
  | { kind: 'ignored' } // a well-formed line that carries no usage (user turn, tool call)
  | { kind: 'unsupported'; reason: string }; // shape changed: fail closed, count, never guess

export interface CollectorAdapter {
  id: CollectorId;
  provider: Provider;
  source: LedgerSource;
  label: string;
  format: 'jsonl' | 'json';
  /** Directories read, relative to home, per platform. Shown verbatim to the user. */
  roots(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[];
  matches(fileName: string): boolean;
  /** Pure: one JSONL line, or for format 'json' one array element already extracted by parseFile. */
  parseLine(line: string): ParseOutcome;
  /** Only for format 'json': whole file text. */
  parseFile?(text: string): ParseOutcome[];
  supportedPlatforms: readonly NodeJS.Platform[];
}

export type CollectorStatus = 'disabled' | 'ok' | 'idle' | 'not_found' | 'unsupported_format' | 'unsupported_platform' | 'error';

export interface CollectorHealth {
  id: CollectorId;
  label: string;
  enabled: boolean;
  status: CollectorStatus;
  paths: string[]; // exact local roots being read
  filesSeen: number;
  observationsAccepted: number;
  duplicatesSkipped: number;
  unsupportedLines: number;
  skewClamped: number;
  rotations: number;
  lastObservationAt: number | null;
  lastScanAt: number | null;
  compatibleVersion: string; // format revision this adapter was written and tested against
  detail?: string;
}

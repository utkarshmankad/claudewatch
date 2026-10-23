# Coding assistant collectors (Prompt 1.3)

Opt-in, local collectors for Claude Code, Codex CLI and Gemini CLI. They run inside the local daemon (the Core), never in the browser extension, so extension permissions do not change. They feed the usage ledger (`docs/LEDGER.md`) as `local_activity` records.

## What is written to the ledger
`kind: local_activity`, `measurementMethod: local_log_parse`, `confidence: medium`, `measures: { estimatedTokens: input + output, requestCount: 1 }`, source `claude_code` / `codex` / `gemini_cli`, provider `claude` / `chatgpt` / `gemini`. They never carry `quotaPercentUsed`. Token counts come from the tool's own usage fields but are not provider quota measurements; reconciliation (Prompt 1.4) decides how much quota movement they explain. Cached tokens are tracked on the observation but are not added to `estimatedTokens`.

Records are keyed by observation time, so two different calls with the same millisecond and identical token counts collapse to one ledger record. This is accepted: it can only undercount, never invent activity.

## What is read and what is never kept
Each adapter reads numeric usage fields, a timestamp, the model identifier (identifier characters only) and a session id that is immediately hashed (sha256, 16 hex chars). Prompt text, response text, tool output, file paths, working directories and raw session ids are never copied; adapters have no free-text output field and the ledger validator rejects unknown fields. Tests assert fixture secrets never appear in output.

## Paths read (shown by `claudewatch collectors status` and `GET /api/collectors`)
| Tool | Directory | Override | Files |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects` | `CLAUDE_CONFIG_DIR` | `**/*.jsonl` |
| Codex CLI | `~/.codex/sessions` | `CODEX_HOME` | `**/rollout-*.jsonl` |
| Gemini CLI | `~/.gemini/tmp` | `GEMINI_CLI_HOME` | `*/chats/session-*.json` |

Symbolic links are not followed. Directory depth is capped at 8 and single files over 256 MiB are skipped.

## Platform support
| Tool | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Claude Code | supported | supported | supported (paths use `os.homedir()`; not exercised in CI) |
| Codex CLI | supported | supported | **unsupported** (not verified; reported as `unsupported_platform`) |
| Gemini CLI | supported | supported | **unsupported** (not verified; reported as `unsupported_platform`) |

"Supported" means the adapter is tested against the fixtures in `src/collectors/__tests__/fixtures` using synthetic data. The fixtures are hand-written to the documented/observed shapes, not captured from a live install; the log formats are not a public contract and can change without notice.

## Format compatibility (fail closed)
Every adapter validates each entry. An entry that has the expected outer type but the wrong shape (renamed or non-numeric fields) is counted as `unsupportedLines` and recorded as nothing. If a scan finds unsupported entries and has never accepted any observation, status becomes `unsupported_format`. No version sniffing is done; compatibility is the shape described by `compatibleVersion` in the health output.

## Robustness
- Opt-in: `~/.claudewatch/collectors.json` (mode 0600). Missing or malformed means all off. `claudewatch collectors enable|disable <id>`; the daemon re-reads it each scan (5 minutes).
- Incremental: byte offsets per file; only complete lines are consumed, so partial writes are picked up once their newline lands. Whole-document Gemini files that fail to parse are retried next scan.
- Rotation: a smaller size or changed inode restarts the file from the top; duplicates are removed by (tool, session, time, tokens).
- Duplicate sessions: resumed or forked sessions replay history into new files; replayed calls count once.
- Clock skew: timestamps more than 5 minutes ahead are clamped to scan time and counted (`skewClamped`); timestamps before 2020 or older than the 30 day lookback are ignored.
- Deletion: `claudewatch collectors delete-data` hard-removes collector records from `~/.claudewatch/ledger.jsonl`. Turning a collector off stops reading but keeps existing records until deleted.

## Health
`GET /api/collectors` and `claudewatch collectors status` report per collector: enabled, status (`disabled`, `ok`, `idle`, `not_found`, `unsupported_format`, `unsupported_platform`, `error`), exact paths, files seen, observations accepted, duplicates skipped, unsupported entries, clock-skew clamps, rotations, last observation time, last scan time, compatible format revision.

## Not done here
Dashboard and extension display of collector health belong to Prompt 1.5. Real-install format verification and the beta attribution report are Phase 1 gate evidence (deferred to the final gate) and have not been collected.

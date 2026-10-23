# Universal usage ledger: model and rules (schema v1)

Code: `src/ledger/` (`types.ts`, `validate.ts`, `ledger.ts`). Tests: `src/ledger/__tests__/ledger.test.ts`. Prompt 1.1; nothing writes to the ledger yet (collectors arrive in 1.2 and 1.3, reconciliation in 1.4).

The ledger is append-only. It records what providers reported and what local clients observed, labelled by origin and confidence, so later work can compare them without blending them.

## Record

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Always 1 in this version. Newer versions are refused. |
| `kind` | `provider_snapshot`, `local_activity`, `reset`, `correction`, `reconciliation` |
| `provider` | `claude`, `chatgpt`, `gemini` |
| `accountAlias` | User-chosen label (letters, digits, space, `_ . -`, max 40). Never a raw account id or email; `@` is not allowed. |
| `devicePseudonym` | Random per-install hex (16-64 chars). Not derived from hardware. |
| `observedAt` / `ingestedAt` | Epoch ms UTC. When it happened vs when the ledger received it. |
| `source` | `web`, `claude_code`, `codex`, `gemini_cli`, `desktop`, `api`, `remote`, `unattributed` |
| `confidence` | `high`, `medium`, `low`, `unknown` |
| `measurementMethod` | `provider_reported`, `local_log_parse`, `local_estimate`, `derived`, `user_correction` |
| `measures` | Separate fields, see below. |
| `window` | `{ type: five_hour/weekly/daily/unknown, resetAt? }` on snapshot and reset records. |
| `supersedes`, `correctionReason` | Correction records only. |
| `reconciliation` | `{ attributedUnits, eligibleUnits }` on reconciliation records (`attributed <= eligible`). |

Stored additionally, computed by the ledger: `id`, `effectiveObservedAt`, `flags`. No other field is accepted, so free text such as prompts, page content or identifiers cannot enter a record.

## Facts and estimates

Measures are never converted into each other.

| Measure | Fact or estimate | Rules |
| --- | --- | --- |
| `quotaPercentUsed` (0-100) | Fact when `measurementMethod = provider_reported` | Only on provider snapshots. Rejected on `local_activity`. |
| `requestCount` | Fact when counted from local logs; otherwise unknown | Non-negative integer. |
| `estimatedTokens` | Estimate, always | Non-negative integer. |
| `costMicroUsd` | Estimate (derived from a price table) | Integer micro-USD, no floats. |
| `confidence` | Judgement about the record, not a measure | Provider snapshots are normally `high`; log parsing `medium`; heuristics `low`. |

A `provider_snapshot` must be `provider_reported`, carry `quotaPercentUsed` and a `window`. A `local_activity` record must not claim to be provider reported.

## Identity and deduplication

`id` = sha256 of kind, provider, alias, device, `observedAt`, source, method, window, supersedes/reason, all measures and reconciliation units. It excludes `ingestedAt`, confidence and flags, so a retry, a replay or a second collector reading the same observation produces the same id. A duplicate is ignored; the earliest-ingested copy is kept. Ingestion is idempotent and independent of arrival order.

## Ordering and clock skew

Total order: `effectiveObservedAt`, then `ingestedAt`, then `id`. `effectiveObservedAt` equals `observedAt` except when `observedAt` is more than 5 minutes after `ingestedAt` (a fast device clock): then it is clamped to `ingestedAt` and the record is flagged `skew_clamped`. Records ingested more than 30 days after observation are flagged `late_ingest` but kept. Invalid timestamps (non-integer, before 2020, after 2099) are rejected.

## Resets

Per provider, alias and window type, provider snapshots are split into segments. A new segment starts when `resetAt` moves by more than 60 s, or when `quotaPercentUsed` falls by more than 1 point. Quota movement is the sum of increases inside segments; the interval spanning a reset counts as neither usage nor negative usage. This matches the reset-interval exclusion in `docs/product-hunt/baseline/METRICS_CONTRACT.md`. `reset` records exist to log an observed reset explicitly (`window.resetAt` required).

## Corrections

A `correction` names the record it `supersedes` with a reason (`clock_skew`, `duplicate_session`, `parser_fix`, `user_edit`). Nothing is edited or deleted in place. `currentView()` omits superseded records; the full ledger keeps them for audit.

## Time zones

Storage is always UTC epoch ms. Daily rollups use `localDay(ts, ianaTimeZone)`; tests cover a UTC-vs-local midnight split and the 23 and 25 hour days at US DST changes. A DST change can never reorder records because ordering uses UTC.

## Retention and deletion

- Retention: 90 days of `effectiveObservedAt` (`prune`). A correction is kept or dropped together with the record it supersedes, so pruning never resurrects a replaced record.
- Deletion: `deleteWhere` hard-removes matching records and any corrections pointing at them. No tombstones are kept. Wiring this to user settings and to the on-disk store is future work.

## Migration and replay

`migrateRecord` upgrades stored records one version at a time from a registry (empty at v1). A stored version newer than the code, or one with no migration, is rejected rather than guessed. `replay(rawLines)` rebuilds the ledger from stored lines in any order and yields the same records.

## Not done in this prompt

- No persistence layer, collectors, API surface or UI.
- Retention and deletion are pure functions; scheduling and user-facing controls come with the store.
- Property-style tests use a seeded PRNG rather than a property-testing library (none is a dependency).

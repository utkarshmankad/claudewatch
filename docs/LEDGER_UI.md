# Usage ledger user experience

Prompt 1.5, operation key `2026-10-10.1/prompt-1.5`. The ledger model is in [LEDGER.md](LEDGER.md), collectors in [BROWSER_COLLECTORS.md](BROWSER_COLLECTORS.md) and [CODING_COLLECTORS.md](CODING_COLLECTORS.md), reconciliation in [RECONCILIATION.md](RECONCILIATION.md).

## What users can answer

| Question | Where |
| --- | --- |
| Where did my quota change? | Dashboard "When quota changed": one line per provider/account/window interval, from `reconcile()` |
| When? | Interval start and end (snapshot times) |
| What evidence supports it? | Local observation count per interval, the "Why" explanation, and the Records table |
| What is still unidentified? | "Unattributed (no local evidence)" range. Without a calibration (none ships) all provider movement is unattributed |

## Surfaces

- **Dashboard** (`src/web/components/LedgerPanel.tsx`): filters, summary, per-label totals, quota changes, records, export, delete.
- **Extension popup** (`popup/ledger-summary.mjs`): one compact line per provider: provider-reported percentages and, if the user opted in to browser activity, an estimate of messages seen in 24 hours. Unattributed use is not computed in the extension; it points to the dashboard.
- **API** (`src/daemon/ledgerRoutes.ts`, local only): `GET /api/ledger`, `GET /api/ledger/export`, `DELETE /api/ledger`.

## Filters

`provider`, `account` (alias), `device` (pseudonym), `client` (ledger `source`: web, claude_code, codex, ...), `source` (ledger `measurementMethod`: how the value was obtained), `confidence`, `from`/`to` (epoch ms). Filters narrow the Records table, totals and exports. Quota changes and the unattributed range are computed on provider, account and time filters only, because a device or client filter would remove the provider snapshots they depend on.

## Labels

Every row and total carries a text label. Color is never the only signal.

| Label | Meaning |
| --- | --- |
| Provider-reported | Quota percentage the provider returned |
| Measured on this device | Counted from local logs (requests, parsed tokens) |
| Estimated | Local estimate, e.g. browser message counts |
| Reconciled (range) | Result of reconciliation, always a range |
| Corrected by you | A user correction record |
| Unattributed | Movement or records with no identified source |

## States

Each is a text message plus a `role="status"` region: **loading**, **empty** (no ledger data, nothing recorded until opt-in), **no match** (filters exclude everything), **stale** (newest provider reading older than 30 minutes), **partial** (only local activity, snapshot gaps, or clock-skew/late-arrival flags), **error** (daemon or ledger unreadable). Stale and partial list their reasons.

## Export and delete

- Export honours the active filters, is never truncated (the table shows the newest 200 rows by default), and is available as CSV or JSON. CSV cells starting with `=`, `+`, `-`, `@` are prefixed so spreadsheets do not run them.
- Delete hard-removes the records the filters select plus corrections that point at them. It needs an in-page confirmation. Over the API an unfiltered delete requires `confirm=all`, a filtered one `confirm=yes`. Deleting never touches provider accounts. The extension's own activity data is cleared from its settings page.
- Delete is exposed on same-origin requests only: the daemon's CORS policy allows only `GET` and `POST` from other origins.

## Wording rules

1. Quota is shown as percentage points reported by the provider.
2. Token figures are prefixed `~` and labelled estimates. Cost is not shown in the ledger.
3. Banned in ledger copy: "exact", "billed", "charged", "invoice", "precise". `view.test.ts` and `ledger-summary.test.mjs` enforce this.
4. Unattributed is explained as "no local evidence held", not as another account's or someone's usage.

## Usability scenarios (to run with at least five representative users)

The plan requires usability tests. They need people, so **none have been run** and this PR does not claim results. Script for the sessions; record verbatim answers in `gates/phase-1/` when run.

1. "Your 5-hour quota jumped this afternoon. Find out roughly when and why." Success: finds the interval and reads the explanation.
2. "Is this number what Anthropic/OpenAI/Google will bill you?" Success: answers no, quotes the caveat. Failure on wording if the user reads `~5,000 tokens` as an invoice figure; revise the label.
3. "Show only what Claude Code did on this laptop last week, and download it." Success: sets filters and exports.
4. "You no longer want Codex activity stored. Remove it and check that it is gone." Success: filters by client, confirms deletion, sees the count.
5. "The page says Partial picture. What does it mean for the numbers you see?" Success: explains that unattributed may be off.
6. (Optional) "Open the extension popup. What does the line under Claude tell you?" Success: distinguishes provider-reported from estimated.

Wording to revise when users misread: replace "Estimated from N message(s)" and "Unattributed" first.

## Not in this change

Human usability sessions and their wording revisions; calibration fitting (so attributed ranges stay zero until real beta data exists); per-record manual corrections in the UI; multi-device ledger merge.

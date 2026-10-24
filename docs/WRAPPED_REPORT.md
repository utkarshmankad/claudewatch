# Private weekly Usage Wrapped report

Prompt 5.2, operation key `2026-10-10.1/prompt-5.2`. Code: `src/wrapped/report.ts` (report model), `src/wrapped/render.ts` (HTML, SVG, PDF, privacy preview, gated export, log lines), `src/daemon/wrappedRoutes.ts` (local API), `src/cli/commands/wrapped.ts` (`claudewatch wrapped`), `src/web/components/WrappedPanel.tsx` (dashboard panel). Metric meanings are in [WRAPPED_METRICS.md](WRAPPED_METRICS.md) (5.1).

The report is built on this device from the local ledger. Nothing is uploaded, no public URL is created, and sharing cards are a separate step (5.3).

## What it shows

Usage (provider mix), client attribution (supported-client mix, attributable activity), quota and interruptions (risk events, prevented interruptions, reset utilization, unused quota), forecast performance, the plan line, a comparison with the previous week, suggested changes, and a definitions section.

- Every metric row carries a status in words (**Provider-reported**, **Measured locally**, **Estimated**, **Unavailable**; never colour alone) and a link to its entry in the report's own definitions section. The definitions text comes from `src/wrapped/definitions.ts`, so an exported file stays self-explanatory offline.
- A missing input is **Unavailable** with the reason, never zero. Prevented interruptions stay unavailable until you confirm a count. The plan cost stays unavailable until you supply a plan history and the pricing catalog has a price; this change ships no prices and the daemon route and CLI do not yet read a plan history or calibration, so those two rows are normally unavailable there. The report model accepts them (`ReportOptions.metrics`) for callers that have them.
- No money is derived from tokens and no figure is called a saving.

## Choices

| Choice | Behaviour |
| --- | --- |
| Week | Any `YYYY-MM-DD` inside the wanted week (Monday start). Default is the last finished week. Future weeks are refused. |
| Time zone | IANA name, default UTC. The week runs from local Monday 00:00 to the next one, so DST weeks are 167 or 169 hours. Invalid names are refused. |
| Accounts, providers, devices | Records are filtered before any metric is computed. Empty means all. |
| Account names | Off by default: accounts appear as "Account 1", "Account 2". Device identifiers are never printed. |

Known limit: the 5.1 completeness check buckets days from the period start in 24 hour steps, so on a DST week the last day bucket can be an hour off. It cannot change whether a complete week passes by more than one day of coverage.

## Weekly comparison

A comparison is shown only when **both** weeks are complete under the 5.1 rules (finished, and day coverage at least 0.7) and the user has data before the reported week. Otherwise the report says why (`this_week_period_not_finished`, `this_week_sparse_data`, `previous_week_sparse_data`, `no_earlier_data`). The thresholds are not changed or lowered here. Rows are shown only for metrics available in both weeks, as current, previous and difference.

## Notices

`partial_week`, `sparse_data`, `no_activity`, `new_user`, `plan_change` and `high_unattributed` (at least 50 percent of counted requests unattributed; an adjustable default, not a measured target).

## Suggested changes

Rule based, each labelled Estimated and naming the metrics it rests on: raise attribution coverage, review windows that reached 100 percent, possible spare capacity (an upper bound from one week; explicitly not a plan recommendation, which is 5.4), add a calibration, add plan history, collect more days. Thresholds `UNUSED_QUOTA_HINT_PERCENT` (50) and `UNUSED_QUOTA_HINT_MIN_WINDOWS` (3) are adjustable defaults, not measured.

## Export after a privacy preview

Formats: HTML, SVG image, PDF (all dependency free), and PNG (drawn from the SVG in the browser panel). Export is refused until a preview exists:

1. The preview lists what the file includes and does not include (device identifiers, raw ledger records, request timestamps, project names, prompts, file paths, plan names; account names unless chosen), plus warnings.
2. Its token is a SHA-256 of the exact content that will be written. The export API and CLI recompute the report and refuse a missing (`preview_required`) or different (`preview_stale`) token, so new data or a changed choice forces a fresh preview.
3. The panel enables the export buttons only after the "I have reviewed what will be exported" box is ticked. The CLI asks, or accepts `--confirm <token>` copied from an earlier preview.

HTML exports contain no script, remote resource or image. The preview in the panel is a fully sandboxed iframe. PDF text outside Latin-1 is replaced with `?`.

## Use

```sh
claudewatch wrapped --tz Europe/Berlin --providers claude
claudewatch wrapped --week 2026-10-07 --format pdf --out wrapped.pdf   # shows the preview, then asks
```

Daemon API (local only): `GET /api/wrapped/choices`, `GET /api/wrapped?week&tz&accounts&providers&devices&names=1`, `GET /api/wrapped/export?...&format=html|svg|pdf&token=<preview token>`.

## Observability

Log lines `[wrapped] event=preview|export|export_refused complete=.. comparison=.. newUser=.. unavailable=<n> notices=<ids> [format=..] [error=..]` go to the daemon or CLI output. They carry states and counts only, never account names, device identifiers, values or paths. No telemetry is sent.

## Tests

`src/wrapped/__tests__/report.test.ts` has snapshot tests for complete, partial, new-user, high-unattributed, plan-change and no-activity weeks (`__snapshots__/report.test.ts.snap`; review any snapshot diff by hand), and tests for time zones and DST, comparison gating, filters, anonymised accounts, definition links and status labels, escaping, privacy-preview gating, SVG and PDF structure, and log content. Route and CLI tests are in `src/daemon/__tests__/wrappedRoutes.test.ts` and `src/cli/__tests__/wrapped.test.ts`; the panel is covered by `tests/browser/wrapped.spec.ts`. Report accuracy against real accounts, an accessibility audit with assistive technology, and the beta sharing funnel are Phase 5 gate evidence and are not claimed here.

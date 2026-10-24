# Weekly and monthly metrics and plan economics

Prompt 5.1, operation key `2026-10-10.1/prompt-5.1`. Code: `src/wrapped/definitions.ts` (what each metric means), `src/wrapped/metrics.ts` (pure calculator over the ledger), `src/wrapped/pricing.ts` (versioned pricing catalog). Nothing here writes data or calls a network. The Usage Wrapped report (5.2) and plan recommendations (5.4) consume it.

## Rules

- Every metric has a status: `provider_reported`, `measured`, `estimated` or `unavailable`. Missing input gives `unavailable` with `reasons[]`, never zero.
- Quota percent, request counts, estimated tokens and money stay separate measures (see [LEDGER.md](LEDGER.md)). **No savings are derived from tokens.** Money appears only as a prorated plan price the user can inspect.
- Claims that need a user action (`prevented_interruptions`, plan history for `subscription_cost`) are unavailable until the user supplies them. Alerts and forecasts never count as prevented interruptions.
- Periods are `[start, end)` in UTC epoch ms; `utcWeek` (Monday start) and `utcMonth` are helpers. Choosing a time zone belongs to the report (5.2). Records after `now` are ignored.

## Metrics

| Metric | Status when available | Source | Limits |
| --- | --- | --- | --- |
| Provider mix | measured | local `requestCount` by provider | other devices without a collector are missing; records without a count are ignored and flagged |
| Supported-client mix | measured | local `requestCount` by `source` | `unattributed` is reported separately, never assigned to a client |
| Quota risk events | provider_reported | windows whose peak snapshot reached the threshold (default 80%) or 100% | counts windows; unobserved peaks are missed |
| Prevented interruptions | measured, only if user-confirmed | user confirmations | otherwise unavailable |
| Reset utilization | provider_reported | last snapshot of each window that reset in the period | lower bound |
| Unused quota | provider_reported | 100 minus reset utilization | upper bound; a share of a window, not tokens or money |
| Forecast accuracy | estimated | one-hour backtest inside the period | needs at least 20 comparisons |
| Attributable activity | estimated | ledger reconciliation, as ranges per window | needs a calibration; windows are not summed |
| Subscription cost | estimated | pricing catalog + user plan history | see below |

A window "resets in the period" when a later segment of the same provider/account/window starts inside it, using the ledger's reset rules. A window that expired with no later snapshot is not counted.

## Completeness

`completeness` reports period days, elapsed days, days with data and day coverage. It is not complete if the period has not finished (`period_not_finished`) or day coverage is under `minDayCoverage` (`sparse_data`, default 0.7). The default is an adjustable starting point, not a measured target. 5.2 uses this to decide whether a week-over-week comparison is allowed.

## Pricing catalog (schema v1)

Each entry: provider, `planId`, ISO currency, region (`ZZ` = not region specific), integer minor-unit amount, billing period (`monthly` or `annual`), `taxTreatment` (`included`, `excluded`, `unknown`), https `sourceUrl`, `effectiveFrom` and optional exclusive `effectiveTo`. `validateCatalog` rejects malformed entries. **This change ships no prices**: the catalog is data the owner supplies from provider pages with a source URL and date; the pricing source audit is a Phase 5 gate artifact and is not claimed here.

- `resolvePrice` returns the one entry effective at the time for the region (exact region before `ZZ`). Zero matches is `no_price`, several is `ambiguous`; it never picks one.
- A manual override (provider and plan) replaces the catalog price and is labelled `override`.
- `planCost` prorates daily: monthly price x 12 / 365, annual price / 365, for the days each plan was active inside the period (plan changes split the period). Results are per currency and are never converted or added across currencies. Mixed tax treatments are flagged. Plans with no price are listed under `missing`.

## Tests

`src/wrapped/__tests__/metrics.test.ts` covers missing data, multiple currencies, plan changes, partial weeks, resets (including one straddling the period start), unattributed activity, calibration and user-confirmation gating, and catalog validation.

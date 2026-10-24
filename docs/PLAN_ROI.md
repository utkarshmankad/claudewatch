# Transparent plan comparison

Prompt 5.4, operation key `2026-10-10.1/prompt-5.4`. Code: `src/wrapped/planRoi.ts` (`comparePlans`, `renderExplanation`, `planRoiLogLine`). Tests: `src/wrapped/__tests__/planRoi.test.ts`. It is a pure function over ledger records and inputs you supply (see [WRAPPED_METRICS.md](WRAPPED_METRICS.md) for the pricing catalog and metric rules). It writes nothing and calls no network. There is no UI or CLI command in this change; the Wrapped report (5.2) and settings can call it.

## What it answers

For each subscription (provider + account alias + `personal` or `work`) it compares four scenarios over the same evidence interval: the current plan, a lower plan, a higher plan and no subscription. Nothing is a prediction or a guaranteed saving; every result says so, and `recommendation.verdict` is one of `favourable`, `inconclusive`, `unfavourable` (per scenario) or `insufficient_evidence`.

## Inputs you must supply

| Input | Source | Why |
| --- | --- | --- |
| Plan history per account | user | The actual current plan and when it changed. |
| Pricing catalog or manual override | owner / user | **The catalog ships no prices and this feature invents none.** Tests use fixtures only. |
| Region | user | Selects the price (exact region before `ZZ`). |
| Candidate lower/higher plan and its `relativeCapacity` | user | Capacity (candidate quota / current quota) is not in the catalog. Without it the scenario is not evaluated (`capacity_ratio_missing`). |
| No-subscription capacity ratio | user | Same reason. |
| Value of one avoided interruption, per context | user | Without it, fewer interruptions are not priced. Must be in the plan's currency (`value_currency_differs_from_price` otherwise). |

## Calculation (all steps are reproduced in `ScenarioResult.steps`)

1. **Evidence interval**: from the later of the period start and the latest plan change, to the earlier of period end and now. Usage before a plan change ran against a different quota and is excluded.
2. **Windows**: provider-reported quota windows (ledger segments) with a snapshot in the interval. Blocked = peak reached 100%. Reset utilization and unused quota use windows followed by a later window; both are bounds (lower and upper).
3. **Cost**: price resolved at the end of the interval; daily cost = monthly x 12 / 365 or annual / 365; times evidence days. An allocation, not a payment schedule.
4. **Blocking under a candidate** with capacity ratio `k`, per window peak `p`:
   - `k <= 1`: low = windows with `p >= 100` or `p / k >= 100`; high = same with `p + slack` (default 10 points, an adjustable assumption). 
   - `k > 1`: windows already at 100% were cut off, so true demand is unknown; the range is 0 to all of them. Other windows are assumed to stay unblocked.
5. **Net benefit vs current** = -(candidate cost - current cost) - (change in blocked windows x value per interruption), computed as a low..high range. Without a value: only when blocking cannot increase is the cost side shown, with an open upper end.
6. **Verdict**: `favourable` only if the whole range is above zero, `unfavourable` if wholly below, otherwise `inconclusive`. A recommendation is surfaced only for a `favourable` scenario and is worded as conditional.

## Insufficient evidence

The comparison refuses (verdict `insufficient_evidence`, with reasons) when: no plan history; fewer than 14 evidence days (`too_few_days`, or `too_few_days_since_plan_change`); fewer than 10 windows; day coverage under 0.7 (`sparse_data`); the current price is missing or ambiguous. The thresholds are adjustable starting points, not measured targets (`minEvidenceDays`, `minWindows`, `minDayCoverage`). A missing candidate price only disables that scenario.

## Mixed accounts, currencies, annual plans

- Totals are per context (`personal`/`work`) and per currency; currencies are never converted and work and personal are never merged. A value entered for one context is not applied to the other.
- Work accounts carry a caveat: the payer and the value of an interruption may differ.
- An annual current plan adds `annual_plan_switch_may_not_be_refundable_before_renewal`; renewal dates are not modelled.

## Explanation view and observability

`renderExplanation(result)` prints, per account: coverage, each scenario's price (amount, currency, region, tax treatment, effective date, source URL, catalog or override), every step with its formula and inputs, the net-benefit range, the recommendation, assumptions and caveats. The output includes account aliases because it is shown on the user's own device; do not log it.

`planRoiLogLine(result)` gives one line: version, account count, verdict counts and the sorted set of insufficiency reasons. It contains no aliases, prices or amounts.

## Known limits

Linear capacity scaling is a modelling assumption; real provider limits may not scale that way. One blocked window equals one interruption. Windows of different lengths are counted alike. Request-count and token data are not used for savings. No UI, CLI command or persistence of the user inputs exists yet.

# Account-wide reconciliation

`src/ledger/reconcile.ts` compares provider-reported quota snapshots with locally observed activity between those snapshots (Prompt 1.4, operation key `2026-10-10.1/prompt-1.4`). It is a pure function over the ledger (see [LEDGER.md](LEDGER.md)); it writes no records, so ledger totals are never forced to match the provider and no events are fabricated.

## Method

1. Snapshots are split into window segments with the ledger's reset rules, per provider, account alias and window type.
2. Each pair of consecutive snapshots in a segment is an interval. The provider delta (percentage points) is the only fact about quota movement.
3. Local activity from the same provider and account alias whose effective time falls inside the interval (shifted back by `providerDelayMs` when provider data lags) is evidence.
4. Evidence is converted to quota points only through an explicit `calibration` (`low`/`high` percentage points per estimated token). Calibration is an input that must come from measured data; the module has no default. Without it nothing is attributed and the interval says so.
5. Attributed points are capped at the provider delta. The remainder is classified remote or unattributed and carries a range: `[delta - attributed.high, delta - attributed.low]`.
6. Attribution within an interval is split across sources in proportion to estimated tokens.

## Edge cases

| Case | Behaviour |
| --- | --- |
| Reset between snapshots | Interval excluded (`reset`), not counted as usage or as negative usage |
| Provider value falls by no more than the reset threshold | Excluded as `negative_correction` |
| No provider movement | Excluded (`no_movement`); activity is noted as `activity_without_quota_movement` |
| Overlapping windows (5-hour and weekly) | Reconciled separately; coverage is reported per window and never summed |
| Delayed provider data | `providerDelayMs` shifts the activity span |
| Account switch | Activity under another alias is not attributed (`other_account_activity_ignored`) |
| Missing snapshots | Gaps longer than `maxGapMs` (60 min default) are flagged `missing_snapshots` |
| Simultaneous clients | Shared by tokens, flagged `simultaneous_clients` |
| Corrections | Superseded records are ignored (`currentView`) |

## Attribution coverage

`coverage = attributed quota movement / eligible provider quota movement`, over reconciled intervals only (reset and corrected intervals are excluded). It is reported as `{ low, point, high }` per provider/account/window, or `null` when nothing is eligible. Coverage depends on the calibration supplied, so a value computed with a synthetic calibration (as in the tests) is not a product measurement.

## Audit

Every interval carries an `explanation` string plus structured `notes`, evidence record ids, device pseudonyms and token totals, so a support engineer can reproduce the arithmetic from the ledger.

## Not in this change

Persisting results, calibration fitting from real beta data, CLI/API exposure and UI are out of scope (Prompt 1.5 and gate evidence). Sanitized real provider fixtures are not included; tests use synthetic timelines.

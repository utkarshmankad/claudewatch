# Phase 0 gate evidence index

Plan version `2026-10-10.1` (source sha256 `2bd804a354aad4639704572c4b37f9cfcb6492f614482468e2b3fb75e028a2d0`).
Prompts 0.1-0.4, PRs #38, #39, #40, #42 (all merged); #43 reconciled state.
Tested revision: `develop` @ `1da206c70534c5c76e31a63f049d98f2839b069b`.
Evidence collected: 2026-10-23, Node v22.22.0 (`.nvmrc` 22.22.3), Linux.

**Status: NOT PASSED.** Three of six evidence items are not yet available and
two of three exit criteria are `unknown`. See `decision.md`. Nothing here is
estimated; missing values are `unknown`.

## Exit criteria

| # | Criterion (quoted from DELIVERY_PLAN.md) | Result | Evidence |
| --- | --- | --- | --- |
| 1 | "Unexplained stale sessions are below 1 percent in the beta cohort" | unknown | No beta cohort has run. Simulation only (see below), which the soak doc says is not gate evidence. |
| 2 | "refresh recovery occurs within ten minutes of browser startup or network restoration" | unknown | Simulated policy logic only; not measured in a real browser. |
| 3 | "event definitions and dashboards are approved" | unknown | Definitions exist (`../../baseline/METRICS_CONTRACT.md`, `event-schema.v1.json`); no owner approval; no dashboard exists. |

## Evidence items

| Item | Status | Where |
| --- | --- | --- |
| CI results | Collected | develop @ `1da206c`: CI run https://github.com/utkarshmankad/claudewatch/actions/runs/39912776375 and CodeQL run https://github.com/utkarshmankad/claudewatch/actions/runs/39912776370, both `success`. Local results in `local-checks.md`. |
| Provider fixture tests | Collected | `claudewatch-extension/test/provider-contract.test.mjs`, `provider-adapters.test.mjs`, `test/fixtures/`; all pass within the 491-test run (`local-checks.md`). Contract: `docs/PROVIDER_CONTRACT.md`. |
| Telemetry schema documentation | Collected | `../../baseline/METRICS_CONTRACT.md`, `../../baseline/event-schema.v1.json`, `../../baseline/BASELINE_AUDIT.md`. |
| 24 hour soak report | **Missing** (real run) | Only the accelerated simulation `docs/reliability/refresh-soak.md` exists; it states it is not gate evidence. |
| Privacy review | **Missing** | Privacy page (`claudewatch-extension/privacy/`) and `docs/PERMISSIONS.md` exist as review inputs; no review has been done. |
| Baseline metrics dashboard | **Missing** | Baseline values are `unknown` in `BASELINE_AUDIT.md`; no dashboard or instrumented build has run. |

Accessibility: Prompt 0.4 made WCAG fixes, but no audit report with
screen-reader testing is stored. Not a listed Phase 0 evidence item; noted as
a limitation.

## Reproduce

See `local-checks.md`. The simulation is reproducible with `npm run soak:refresh`.

## Outstanding items and how to obtain them

1. **24 hour soak.** Load the built extension (`claudewatch-extension/`) unpacked in a real
   Chrome profile signed in to Claude, ChatGPT and Gemini. Enable the local analytics debug
   view, leave the browser running 24h including one browser restart and one
   offline/online cycle. Export the sanitized refresh log, then compute refresh success rate,
   max unexplained stale interval, and recovery time after startup/network restore against
   `METRICS_CONTRACT.md` definitions. Store the report as `soak-24h.md` here (UTC window,
   build SHA, denominators, exclusions).
2. **Beta cohort stale rate (criterion 1).** Recruit beta users, ship an instrumented build,
   collect the contract's stale-duration events for a stated window, report
   unexplained-stale sessions / active sessions with sample size. Store as `beta-stale-rate.md`.
3. **Privacy review.** Reviewer checks the privacy page, `docs/PERMISSIONS.md`, the event schema
   and the prohibited-field tests against the "no prompts, cookies, credentials, page contents,
   raw account identifiers" rule. Store as `privacy-review.md` with reviewer, date, findings,
   status. Also resolve the follow-up in `docs/PERMISSIONS.md` (optional ChatGPT/Gemini host
   permissions are not yet runtime requests).
4. **Dashboard and approval.** Build a baseline dashboard from real instrumented data (values
   unknown stay unknown), then the owner records approval of event definitions and the dashboard
   in `decision.md`. Store the dashboard export as `baseline-dashboard.md`.

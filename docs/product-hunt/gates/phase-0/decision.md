# Phase 0 gate decision

Decision: **PENDING. Gate not passed.** Phase 1 must not start.
Decision owner: repository owner. Decision time (UTC): not recorded. Prepared by the delivery agent; the agent does not decide gates.

| Criterion | Result | Evidence |
| --- | --- | --- |
| Unexplained stale sessions < 1% in beta cohort | unknown | none (README.md item 2) |
| Refresh recovery within 10 min of startup / network restoration | unknown | none (README.md item 1) |
| Event definitions and dashboards approved | unknown | definitions exist; no dashboard; no approval |

Required evidence: CI collected; fixture tests collected; telemetry schema collected;
24h soak missing; privacy review missing; baseline dashboard missing.

Unresolved risks: no real-browser measurement of refresh reliability; privacy review
outstanding; optional host permissions not yet runtime requests; accessibility audit
report not stored. Security/privacy status: unreviewed. Support impact: none assessed.

Options for the owner: proceed (after evidence), extend Phase 0, reduce scope, stop, or record an
`accepted_exception` for a launch-success criterion only (cannot waive tests, CI, security controls).

Owner sign-off: ______ (name, UTC time, outcome)

## History
- 2026-10-23: evidence index created; decision pending.

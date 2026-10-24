# ADR-0002: Move the Prompt 4.4 Radar beta gate to the Phase 6 release

Status: accepted (owner decision). Date: 2026-10-24. Operation key: `2026-10-10.1/prompt-4.4`.

## Context

Prompt 4.4 (controlled Radar beta) needs inputs that do not exist yet: a consented live cohort, a deployed ingestion endpoint and feed, signing-key custody, and a privacy review of real stored records. It was recorded as a human-gate blocker, which also held back the Phase 4 promotion to `main` and therefore Phases 5 and 6.

## Decision

The 4.4 human gate moves to **Phase 6 as the final requirement of the release**.

- Prompt 4.4 is `deferred_to_phase_6`, not `blocked`. It is not started and does not block Phase 4 promotion or Phase 5.
- The Phase 6 exit criteria require the 4.4 beta to have run and its internal launch decision (evidence and unresolved risks) to be published, or an explicit owner-approved exception.
- It is tracked in the final gate (`id: G`) alongside the other deferred gates.
- Radar stays labelled beta until it meets the agreed precision, privacy and rollback targets.

## Consequences

- Phases 4 and 5 can proceed and be promoted without live beta evidence. Defects found by the beta may force rework in Radar late, at release time.
- Radar behaviour (4.2 pipeline, 4.3 remote config) stays validated only by synthetic fixtures until then. Real-history backtest, privacy and legal review, and design open questions 1-5 in `PRIVACY_AND_ARCHITECTURE.md` remain open.
- Deferral is not a pass. No measurement may be fabricated, and CI, coverage and security controls are not waived.
- Phase 6 stays prohibited during the pilot; this decision does not authorize it.

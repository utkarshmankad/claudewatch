# Deferred phase gates and the final gate phase

**Owner directive, 2026-10-23:** the per-phase human gates for Phases 0-5 are skipped as blockers, and Phase 1 starts now. Every deferred gate is consolidated into a **Final gate phase** (`id: G` in `delivery-state.yaml`) that must pass before Phase 6 (Product Hunt release). Phase 6 stays prohibited during the pilot; this directive does not authorize it.

Deferral is not a pass. Nothing is marked `passed`; deferred phases carry `gate_status: deferred_to_final_gate`.

## What the final gate must contain

For each of Phases 0-5, the exit criteria and evidence exactly as written in [DELIVERY_PLAN.md](../DELIVERY_PLAN.md), recorded per [gates/README.md](README.md) (`phase-<n>/README.md` evidence index and `decision.md`), plus a final decision that is signed by the owner.

Phase 0 items still outstanding (previously the blocker):
- real 24 hour soak report (restart + network cut), see `phase-0/README.md`
- beta stale-rate measurement (< 1% unexplained stale, recovery <= 10 min)
- privacy review
- baseline metrics dashboard and approval of event definitions
- owner decision in `phase-0/decision.md`

Phases 1-5: evidence is collected as each phase's prompts land and listed in the final gate; design approvals inside phases (3.1, 4.1) are separate gates and remain in force.

## Consequences to be aware of

- Later phases build on Phase 0 measurement and reliability assumptions that are unverified. Defects found at the final gate may force rework in Phases 1-5.
- Prompts that depend on measured baselines or on an approved design still wait for those inputs.
- Waiving a gate does not waive tests, CI, coverage thresholds or security controls.

## Phase 3 independent security review (CLOSED by owner decision 2026-10-24)

Originally deferred on 2026-10-23: no independent reviewer was engaged, and Phase 3 relied on self-review. On 2026-10-24 the owner accepted the AI-assisted review ([phase-3/security-review.md](phase-3/security-review.md): code review, penetration test, fuzzing, load test, ZAP scan and the fixes they led to) as satisfying this item; see [phase-3/decision.md](phase-3/decision.md). The review is not a third-party audit and the sync feature must not be described as one.

## Prompt 4.4 Radar beta (moved to the Phase 6 release gate, owner decision 2026-10-24)

The 4.4 human gate is no longer a Phase 4 blocker. It is the **final requirement of the Phase 6 release**: the release must not proceed until the controlled Radar beta has run and its internal launch decision is published, or the owner records an explicit exception. Required inputs the owner must supply: a consented beta cohort, a deployed ingestion endpoint and feed, signing-key custody, and a privacy review of real stored records. Until then Radar stays labelled beta and no measurement may be fabricated. See [ADR-0002](../../radar/ADR-0002-radar-beta-release-gate.md).

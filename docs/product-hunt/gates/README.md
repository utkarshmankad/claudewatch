# Phase gate evidence

The seven phase gates, their entry and exit criteria, required evidence, launch metrics, and final release controls are preserved exactly in [DELIVERY_PLAN.md](../DELIVERY_PLAN.md). That plan is the acceptance authority; this directory defines how to record proof. [Operating rules](../AGENT_OPERATING_RULES.md) enforce the stricter pilot boundary.

No gate has been evaluated or passed during orchestration setup. Do not create success evidence from the setup validation, and do not start Phase 0 to fill these files.

## Evidence layout for later authorized work

For each phase, use `phase-<n>/README.md` as its evidence index and store supporting reports within that directory. Use `phase-<n>/decision.md` for its gate decision. These paths are conventions for future files, not claims that evidence exists. Link the actual files from `delivery-state.yaml` only after creating and checking them.

An evidence index must contain:

- Plan version and source hash, phase and prompt IDs, tested branch and full commit SHA, PR links, environment/runtime versions, and UTC measurement window.
- Each entry and exit criterion quoted exactly, mapped to concrete evidence files. Preserve all original thresholds and required evidence categories.
- Reproducible commands, exit codes, test counts, coverage and required CI run URLs for the tested revision. Archive essential results in files so external links are not the sole evidence.
- Measured metrics with definitions, sample size, denominator, time window, exclusions, confidence, and trend where required. Mark unavailable values unknown; do not replace them with estimates or zero.
- Required fixture, soak, beta, privacy, security, accessibility, deletion, rollback, and review reports as specified by that phase. Include unresolved risks, owners, support impact, and limitations.

Sanitize artifacts before storage. Do not include prompts, responses, cookies, credentials, raw account identifiers, or other prohibited content. A screenshot alone does not establish an operational metric or security approval.

## Decision procedure

1. Verify phase entry criteria and completion of the preceding phase gate before starting a phase. Respect design/privacy approvals inside phases as separate gates.
2. Verify all required evidence files exist, are readable, match the relevant revision and measurement window, and cover every criterion. Re-run invalidated checks after relevant changes; old passing CI is not proof for a new head.
3. Record each criterion as pass, fail, or unknown, with evidence links. Missing evidence or an undefined target blocks a pass. Obtain required design decisions before measuring source-defined targets whose numeric values are not yet specified.
4. Record the reviewer/decision owner, UTC decision time, measured outcome, unresolved risks, security/privacy status, support impact, and whether to proceed, extend, reduce scope, or stop. Keep previous decision history when revising a decision.
5. Set `gate_status: passed` only when every criterion passes and the required approvals exist. Update the phase state and checkpoint the evidence and decision paths before advancing. A completed prompt does not automatically pass a phase.

The source allows explicit owner-approved exceptions for launch success criteria. Record such an exception with its original criterion, failed or unknown measurement, owner, rationale, risk, and review date; use `accepted_exception`, not `passed`. It cannot waive required tests, CI, security controls, or the pilot publication prohibition. Do not extrapolate the launch exception policy into permission to waive other phase gates.

## Release boundary

Phase 6 and Prompts 6.1 through 6.6 remain in the plan unchanged, including store approval, launch readiness, main promotion, rollout, and post-launch requirements. They are outside this pilot. No evidence file or gate decision authorizes a release, store submission/publication, tag, or main change during the pilot. Keep `release_status: prohibited_during_pilot` and require separate post-pilot authorization before any of these operations.

## State validation

Validate that YAML parses with unique keys, lists exactly seven ordered phases and 32 unique ordered prompt IDs, and retains all required tracking fields. Check every recorded evidence path and every plan/source reference. Verify phase/prompt pointers and top-level status agree with the selected work item. Before resuming, reconcile recorded branches, commits, PRs, and CI with actual repository/GitHub state as described in the operating rules.

## Owner directive: deferred gates

On 2026-10-23 the owner deferred the Phase 0-5 gates to a consolidated final gate phase before Phase 6. See [DEFERRED_GATES.md](DEFERRED_GATES.md). The evidence and decision layout above still applies at that final gate.

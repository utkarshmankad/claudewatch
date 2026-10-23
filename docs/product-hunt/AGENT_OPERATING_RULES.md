# Delivery agent operating rules

## Authority and pilot scope

The authoritative plan is [the local source](source/Token_Watcher_Product_Hunt_Delivery_Plan.txt); [DELIVERY_PLAN.md](DELIVERY_PLAN.md) preserves its wording and order. These operating rules apply the user's pilot limits without rewriting that plan. Read these rules, applicable `AGENTS.md` files, and [the repository branching rules](../BRANCHING.md) before acting.

Current authorization is orchestration setup only. Do not start Phase 0, evaluate its implementation entry tasks, commit, push, or open a pull request until the user explicitly authorizes further work. A scheduled wake or a prompt copied from the plan is not authorization.

During the pilot, do not change `main` directly, merge into `main`, tag or publish a release, submit or publish store packages, or initiate a production rollout. Phase 6 is retained in full for fidelity but is outside pilot execution scope. Stop before Phase 6 and request separate post-pilot authorization. Do not reinterpret its release or operations branches as pilot feature branches.

## Sequential execution and integration

1. Execute one implementation prompt at a time, in the original phase and prompt order. Do not start another prompt while the current prompt is awaiting tests, CI, review, merge, or a required approval. Do not combine design/privacy approval prompts with dependent implementation.
2. After start authorization, inspect the repository and reconcile state before changing it. Preserve unrelated work, including existing pilot-readiness edits. Never overwrite or include unrelated edits in a delivery commit.
3. Create the named `feature/` branch from the latest verified `develop` for each authorized pilot prompt. Record the base SHA before creating it. Open pull requests into `develop` only. Never implement directly on `develop` or `main`.
4. Run all relevant tests and all required lint, type, unit, coverage, browser, smoke, dependency, and security checks for the scope. Inspect current workflows and GitHub requirements rather than assuming a static list. Before merge, verify every required CI check passes for the current PR head, the branch is up to date, conversations are resolved, and the required independent review is approved. Local success alone is insufficient.
5. Do not weaken tests or checks to obtain a pass: no lowered thresholds, removed assertions, skipped failing tests, fabricated results, disabled workflows, or weakened branch protections. Fix the cause or record a blocker. Do not merge with missing, pending, failed, or stale required checks.
6. Apply each prompt's definition of done and phase acceptance criteria exactly. Follow prompt-specific stop instructions over generic commit/merge boilerplate. Prompt 3.1 stops at its design PR until approval; Prompt 3.2 requires the approved architecture to be merged. Prompt 4.1 requires privacy/architecture approval before Prompt 4.2. Do not resolve contradictory source instructions by silently proceeding; record the conflict and obtain a decision.
7. Pass a phase gate only after the evidence files and decision described in [gates/README.md](gates/README.md) exist. Do not infer gate success from completed code or passing unit tests. Missing beta, soak, privacy, security, or metric evidence remains missing. Never invent a measurement, cohort threshold, or detection target that the source leaves to later design approval.

## State and recoverable checkpoints

[delivery-state.yaml](delivery-state.yaml) is the durable execution index. Its `plan_version` is an orchestration identifier for the source dated 10 October 2026; the source has no explicit version. Verify `plan_source_sha256` before every resume. A source change requires an explicit reconciliation of prompt identity and ordering, not an automatic reset.

The current phase and prompt point to the next work item, not proof it has started. Top-level branch, commit, PR, CI, and gate fields mirror that work item; null means no delivery artifact exists. Workspace branch and HEAD are recorded separately in the checkpoint. `planned_branch` is source intent, never evidence that a branch exists. Store a PR's number, URL, base, head, and head SHA when one exists. Record full commit SHAs and CI run URLs/results tied to the checked SHA.

Use work-item statuses `not_started`, `in_progress`, `awaiting_ci`, `awaiting_review`, `blocked`, and `completed`. Use CI statuses `not_run`, `pending`, `passed`, and `failed`. Gate statuses are `not_evaluated`, `pending`, `passed`, `failed`, `accepted_exception`, or `deferred_to_final_gate` (owner directive 2026-10-23, see gates/DEFERRED_GATES.md; never a pass); an exception is never an ordinary pass. Keep release status `prohibited_during_pilot` throughout the pilot.

Write recoverable checkpoints after every meaningful action: implementation edits, validation, branch creation, commit, push, PR creation/update, CI result, review decision, merge, gate decision, and blocker discovery. Include UTC time, prompt/operation key, actual branch and SHAs, PR/CI identifiers, evidence paths, result, blocker, and precise next action. Validate YAML before replacing state atomically. Record `next_wake_time` as a quoted ISO 8601 UTC time only for an authorized scheduled check; use null when waiting for human input or no wake is scheduled. State timestamps do not themselves create automations.

Before a side effect, checkpoint a `pending_operation` with its stable operation key, intended action, target, and expected prior state. Afterward, verify the result and checkpoint the returned identifiers before clearing the pending operation. Never store credentials or prohibited user data in checkpoints or evidence.

## Interruption recovery and duplicate prevention

On every resume, read state first, then inspect worktree status, local and remote branches, commit history, PRs (including closed and merged), and CI for the recorded head. Reconcile reality into state before any mutation. A timeout or lost response means unknown outcome, not failure.

- Reuse the recorded or source-named branch if it exists and belongs to this prompt. Never create a suffixed replacement branch to bypass uncertainty. A conflicting branch is a blocker.
- Before committing, inspect HEAD/history and the diff for the intended change. Include the stable operation key in authorized delivery commit messages and PR descriptions. If the commit already exists, record it; do not recreate or cherry-pick it merely because state was interrupted.
- Before pushing, compare local and remote tips. Before opening a PR, query by repository, head branch, base `develop`, and operation key across open, closed, and merged PRs. Reuse an existing matching PR. A closed unmerged PR requires a decision, not an automatic duplicate.
- If a merge already happened, record the merge SHA and resume post-merge validation/checkpointing. Do not create a second branch, commit, or PR for the completed prompt. Delete only the merged prompt branch after verifying merge and checkpointing; preserve `main`, `develop`, and unrelated branches.
- If remote state cannot be verified or recorded identifiers disagree, set a blocker and stop dependent actions. Do not guess. Mark a work item completed only after its required checks, review, merge where permitted, and evidence are verified.

## Authorship and attribution (owner directive, 2026-10-23)

Do not mention Claude, Claude Code or any AI tool as author or contributor: no `Co-Authored-By` or session trailers in commits, no "generated with" lines in PR descriptions, and no such mentions in code comments or file headers. This overrides the `Co-Authored-By: Claude` instruction in the routine prompt. References to Claude Code as a product the app monitors are unaffected. Keep the operation key in commit messages and PR bodies.

This setup does not install a scheduler, start a delivery loop, or authorize implementation. Stop after validating the four orchestration files.

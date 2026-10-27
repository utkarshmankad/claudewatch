# Delivery retro

Operation key: `2026-10-10.1/retro-sync-back-staleness`

## Sync-back PR goes stale (phases 4 and 5)

### What happened

- Phase 4: sync-back #78 (head `main`, base `develop`) was blocked as behind; #80 and then #81 replaced it.
- Phase 5: sync-back #91 (head `main`, base `develop`) was behind `develop` within minutes of opening. #94 (head `feature/p5-sync-main-into-develop`) replaced it, and #91 was closed.
- Along the way, three state-only PRs (#92, #93, and later #95, #96, #97) recorded the same transition, so most of them were no-ops or duplicates.

### Root cause

1. A sync-back PR with head `main` cannot be updated by the routine. Branch protection requires it to be up to date with `develop`, and the routine may not push to `main` or `develop`.
2. Every state-only PR merged into `develop` while the sync-back is open moves `develop` forward and makes the sync-back behind again.
3. The routine opens a state PR for each status flip (`open`, `merged`, `sync-back merged`). Each one races the others and the sync-back, and is often empty by the time it runs.

### Avoiding it

1. Open the sync-back from a feature branch, not from `main`: create `feature/pN-sync-main-into-develop` from latest `develop`, merge `origin/main` into it, push, and open that branch into `develop` (key `2026-10-10.1/sync-phase-N`). The routine owns this branch, so it can merge `develop` in again whenever it falls behind.
2. Do not open or merge any other PR into `develop` while the sync-back is open. State edits wait.
3. Record promotion and sync-back state in at most two state PRs per phase: one when the sync-back PR is opened (promotion `merged`, sync-back `open`), and one after the sync-back merges. Fold the first into the sync-back branch itself when possible.
4. Before opening any state PR, fetch `origin/develop` and diff `docs/product-hunt/delivery-state.yaml`. If the change is already there, do not open the PR.
5. Before opening any PR, search open and closed PRs for the same operation key and reuse a match, so duplicates such as #95/#96/#97 are not created.
6. On every run, if the sync-back is behind `develop`, merge `develop` into its branch first, before other maintenance.
7. The sync-back is merged by the owner with a merge commit. Notify only when it is green and up to date on the current `develop` head.

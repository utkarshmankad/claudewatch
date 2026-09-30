# ClaudeWatch workstream — 2026-10-01 IST

## Repository evidence

Default main and integration develop started at `0b16f914f186f6d9c2ee362327bfba811225ce73`. No open issues/PRs or GitHub releases existed at inspection. Existing `fix/provider-source-window-labels` was an empty branch at the same commit and is preserved. Latest develop CI [36773603746](https://github.com/utkarshmankad/claudewatch/actions/runs/36773603746) passed quality on Node 20/22 and coverage but failed high-severity production Nodemailer audit; CodeQL passed. Deployment history cannot be read through the available GET connector (endpoint rejected); do not infer deployment from CI.

## Prioritized roadmap

| Priority | GitHub issue | Evidence and next action |
|---|---|---|
| P0 | [#8](https://github.com/utkarshmankad/claudewatch/issues/8) | Nodemailer audit failure. Upgrade and regress SMTP message handling; this run's increment. |
| P1 | [#9](https://github.com/utkarshmankad/claudewatch/issues/9) | Architecture review provider API resilience/browser coverage gaps. Next product increment: reproduce stale snapshot feedback. |
| P1 | [#10](https://github.com/utkarshmankad/claudewatch/issues/10) | Release gates and reproducible distribution. Verify branch protections/release authorization before release branch. |
| P2 | [#11](https://github.com/utkarshmankad/claudewatch/issues/11) | README disagrees with opt-in sharing and implemented quota sources. Take a separate documentation increment. |

## Sprint #8

- [x] Upgrade Nodemailer 9.1.1 to 10.0.13 in lockfile; no unrelated dependency version changes.
- [x] Adopt bundled Transporter type and remove legacy @types/nodemailer.
- [x] Actual installed mail composer/address parser regression verifies quoted display name, multiple recipients, multipart alert and no SMTP password in message; existing SMTP/SendGrid transport and failure tests pass.
- [x] Local npm lint/build/typecheck and web build pass on Node 24.19.
- [x] `npm audit --omit=dev --audit-level=high`: zero vulnerabilities.
- [x] Targeted email + extension tests: 83/83 pass; extension manifest validates.
- [ ] Full local suite/coverage/CLI smoke: unavailable native better-sqlite3/keytar bindings in scratch Node24. 215/255 tests pass, 40 storage tests fail for missing native SQLite; CLI cannot load keytar. These are environment failures, not claimed successes. Node22 tar executable returns version but segfaults on script evaluation here. CI Node20/22 is authoritative for remaining gates.
- [ ] Draft fix PR into develop, green CI and CodeQL at final SHA.
- [ ] Independent approving review, resolved conversations and current branch required by docs/BRANCHING.md.

Supported runtime remains documented Node20+. Nodemailer10 requires Node20+ and supplies its own types. Extension/core remain independent and no extension runtime changes are included. Upstream references: https://github.com/nodemailer/nodemailer/security and https://github.com/advisories/GHSA-6vj9-mwq6-2f5v.

## Merge/release and next action

Do not merge until all documented gates pass. Both branches currently report protected=false; rulesets list is empty, classic protection reads return 403. No release-creation/deployment connector is exposed. Release must follow release/<version> from develop, merge to main and back to develop, and tag. Next action: review the fix PR, resolve any CI regression, obtain independent approval, then establish authorized release path under #10. Prepared announcements are in [LAUNCH_DRAFT.md](LAUNCH_DRAFT.md); nothing has been published.

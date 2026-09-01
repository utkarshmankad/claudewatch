# Branching and release strategy

ClaudeWatch uses a lightweight GitFlow model:

- `main` is production. Every commit must be releasable and is protected.
- `develop` is the integration branch for the next release and is protected.
- `feature/<topic>` and `fix/<topic>` branch from `develop` and return through a pull request.
- `release/<version>` branches from `develop`; stabilization fixes land there, then the branch is merged into both `main` and `develop` and tagged `vX.Y.Z`.
- `hotfix/<topic>` branches from `main` and is merged into both `main` and `develop`.

Require pull requests, successful CI and CodeQL checks, one approving review, resolved conversations, and an up-to-date branch on both protected branches. Disable force pushes and deletion. Prefer squash merges for feature/fix branches and merge commits for release/hotfix branches.

No workflow can create GitHub branch-protection rules from the repository itself. Configure the rules above in GitHub Settings → Branches after pushing `develop`.

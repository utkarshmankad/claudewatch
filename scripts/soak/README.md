# Cloud-browser soak

Runs the real extension (`claudewatch-extension/`) in a real Chromium for hours, against a fixture provider with injected faults, and reports whether readings stay fresh and recover. It is the Phase 6.1 "soak with a safe accelerated schedule" (release candidate: 72 hours), run on GitHub-hosted runners so nobody has to leave a browser open.

## What it does

- `browser-soak.mjs` launches Chromium under `xvfb` with the extension loaded and answers `https://chatgpt.com/**` itself (usage and session endpoints), so **no provider account, cookie or credential is involved**.
- A seeded plan injects faults: network offline, rate limiting, signed-out session, provider tab closed, changed response format, extension service worker stopped, and a full browser restart. The plan is dense (a fault every ~12 minutes by default) but the clock is real: this is wall-clock time, not simulated time.
- Every 30 seconds it reads the extension's persisted refresh state (without triggering a refresh) and records whether the reading is fresh, stale with a reason, or stale with none.
- `report.mjs` joins the legs into one report: fresh-time share, longest stale and unexplained stale intervals, and recovery time after each fault and restart (the Phase 0 criterion is 10 minutes after startup or network restoration).

## Running it

Short leg on your machine (needs `npx playwright install chromium` and `xvfb-run` on Linux):

```
SOAK_MINUTES=20 SOAK_TOTAL_MINUTES=20 SOAK_FAULT_EVERY_MIN=3 xvfb-run -a node scripts/soak/browser-soak.mjs
node scripts/soak/report.mjs soak-report.md soak-out
```

In the cloud, `.github/workflows/soak.yml`:

- **Pull requests** that touch the soak code run one 20-minute leg, so the harness is proven on a hosted runner before it is trusted for a long run.
- **Manual run** (`Actions > Browser soak > Run workflow`, or `gh workflow run soak.yml -f total_hours=72`): splits the run into legs of 5.5 hours (the hosted-runner job limit is 6 hours) and runs them one after another. Each leg uploads its browser profile and the next leg reopens it, so every leg boundary is also a real browser restart. A final job aggregates all legs into the `soak-report` artifact and the job summary. A workflow can only be started manually once the file is on the default branch.
- Cost: 72 hours is about 4,300 runner minutes. That is free on a public repository and counts against the plan's minutes on a private one.

## Why GitHub-hosted runners and not a browser-as-a-service

BrowserStack, LambdaTest, Sauce Labs and Browserbase would also give a cloud browser, but their sessions are capped at hours, they need an account and secrets, and they are built to drive a page, not to keep an installed extension's service worker alive for days. A GitHub runner needs no new account or secret, is already part of this repository's CI, and can load an unpacked extension.

## What it does not prove

- Real providers: the fixture proves the scheduling, recovery and persistence paths in a real browser, not that claude.ai, chatgpt.com or gemini.google.com behave the same way. The Phase 0 24-hour measurement with real signed-in accounts and a beta cohort is still needed and cannot be done in CI without handing provider credentials to a runner, which should not be done.
- Only the ChatGPT collector path (through a provider tab) is exercised.
- Chrome and Edge differences, other operating systems, sleep/wake and real network changes on a user's machine.

# Baseline audit (Prompt 0.1)

Operation key: `2026-10-10.1/prompt-0.1`. Audited commit: `origin/develop` at
`7fac23c`. Method: reading the code; no authenticated provider accounts were
available, so nothing below was observed against live Claude, ChatGPT or
Gemini. Values that need real usage are `unknown` (see end).

## Components

**Extension** (`claudewatch-extension`, MV3, v0.14.3). A service worker
(`background.js`) owns state; content scripts (`interceptor.js` in the MAIN
world, `content.js`, `inpage.js`) run on claude.ai, chatgpt.com,
chat.openai.com and gemini.google.com. UI: popup, options page, onboarding.

**Provider adapters.** `provider-collectors.js` fetches ChatGPT and Gemini
account usage, preferring a signed-in tab's MAIN world and falling back to a
credentialed service-worker request. Claude is polled by `backgroundPoll()`
via `fetch('https://claude.ai/api/organizations', {credentials:'include'})`.
Normalizers live in `background.js` (`normalizeChatGptUsage`,
`normalizeGeminiUsage`, Claude inline in `saveProviderUsageResult`) and parser
helpers in `lib/parsers.mjs`.

**Local Core** (`src/daemon`, Express on `localhost:7734`, SQLite via
`better-sqlite3`). The extension posts metadata events to `/api/events` only if
the user enabled "Share usage with local ClaudeWatch Core" and granted the
optional `http://localhost:7734/*` host permission.

**Storage** (`chrome.storage.local`): `token_history` (max 2000),
`usage_history` (7 days, max 7000), `provider_accounts` (10 per provider),
`provider_usage`, `provider_selections`, `last_usage_poll_<site>`,
`last_provider_refresh_attempt_<site>`, plan/window keys, `device_id`.
`chrome.storage.sync` holds settings, including optional user-typed
`analyticsUserId` / `analyticsTeamId`.

**Alarms.** `heartbeat` (every 1 min; badge update, alarm repair, watchdog
refresh if the last attempt is older than 7 min) and `poll` (every 5 min;
refresh all providers). Other refresh triggers: install, browser startup,
provider tab activation, tab load complete, window focus (5 min min age),
idle→active (5 min), popup `GET_STATS` (60 s min age).

**Permissions.** `storage, alarms, notifications, tabs, scripting, cookies,
idle`; host permissions for the four provider origins; optional host
permission for `localhost:7734`. `notifications` is declared but no code
calls `chrome.notifications`.

**Release workflow.** `.github/workflows/ci.yml` (Node 20/22 quality job:
runtime check, lint, typecheck, tests, build, web build, smoke; Chromium
browser job) and `codeql.yml`. `npm run validate:extension` checks the
manifest and expected files. There is no extension packaging/release workflow
in CI; `npm --prefix claudewatch-extension run zip` is manual.

## Existing analytics before this change

- No product analytics existed. The only event path was `sendCoreEvent`
  (opt-in, localhost only) carrying quota readings.
- **Finding:** that payload includes `accountId`/`organizationId` (raw
  provider identifiers), a `deviceId`, and the optional user/team labels.
  It stays on the user's machine and is opt-in, so it was not changed here, but
  it would violate this contract if ever uploaded. Phase 3/4 must not reuse it.
- The Core's `/api/analytics` and `docs/USAGE_INTELLIGENCE.md` are
  usage-attribution features for the daemon, not product metrics.

## Current user journey: install → first trustworthy quota reading

1. User installs the extension. `onInstalled` creates alarms, opens the
   onboarding tab and starts a refresh of all providers.
2. Onboarding explains the product and links to settings.
3. The user must be signed in to a provider in the same browser profile. If
   no tab is open, ChatGPT/Gemini collectors fall back to a credentialed
   service-worker request; if that fails the refresh fails with
   `provider_tab_missing`-class errors and nothing is shown.
4. A successful fetch is normalized and validated
   (`validateProviderSnapshot`: known site, a stable account identity, percent
   ranges, parseable reset times), saved, and the badge shows the 5-hour %.
5. The popup shows provider-reported values with a freshness line; data older
   than 15 minutes is labeled stale.

The first *trustworthy* reading is the first snapshot that passes step 4.
There is no recommendation step in the current journey.

## Reliability and gap findings (inputs for later prompts)

| # | Finding | Evidence | Addressed by |
| --- | --- | --- | --- |
| 1 | The Claude path swallows failures: non-OK responses and exceptions in `backgroundPoll` only `console.log`; `last_usage_poll_claude` is written only on success, so Claude staleness has no recorded cause. | `background.js` `backgroundPoll` | 0.2 |
| 2 | Refresh scheduling is timer/event driven with a 60 s per-provider throttle and no jitter or bounded retry; a failed refresh waits for the next 5 min alarm. | `requestProviderRefresh`, alarms | 0.2 |
| 3 | The popup `stale` flag is a fixed 15 min threshold and does not tell the user why. | `getStats`, `popup.js` | 0.2 |
| 4 | Provider-reported percentages and locally estimated token counts share one stats object. | `getStats` | 0.3 |
| 5 | Broad permissions (`cookies`, `tabs`, `scripting`, all provider hosts) are required up front; optional providers are not runtime requests. | `manifest.json` | 0.4 |
| 6 | Naming is mixed (ClaudeWatch / Token Watcher) across package, manifest, Core. | repo-wide | 0.4 |
| 7 | `notifications` permission unused. | `manifest.json` | 0.4 |
| 8 | No packaged-extension build or release check in CI. | workflows | Phase 6 |

This PR instruments findings 1-3 (every refresh outcome, error category and
stale interval is now recorded) but does not change refresh behavior.

## Baseline measurements

Measured in this run (Node 22.22.0):

| Check | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck` | pass |
| `npm test` (root + extension) | 23 files, 322 tests pass (136 in `claudewatch-extension/test`, 5 files) |
| `npm run test:coverage` | statements 63.19%, branches 51.05%, functions 79.31%, lines 64.26% (thresholds 60/45/75/60 pass; the extension is not in the coverage `include` list, so these figures do not cover it) |
| `npm run smoke` (build, CLI `--help`, `validate:extension`) | pass |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `npm run test:browser` | 2 of 2 pass in this environment only with the preinstalled Chromium 1194 supplied via a temporary config, because Playwright 1.64 wants build 1248 and `playwright install` could not fetch it here; CI installs it normally |

Product metrics, all **unknown** because no instrumented build has run in a
beta cohort: activation, time to first useful reading, time to first
recommendation, provider connection rate, refresh success rate, stale
duration, unexplained stale rate, attribution coverage (also needs the Phase 1
ledger), alert action rate (no alert feature), report sharing (no sharing
feature), week-four retention (needs 35 days). They will be filled from
real debug-view exports at the Phase 0 gate; they were not estimated here.

Static facts (from code, not usage): 3 supported providers; refresh alarm 5
minutes; stale threshold 15 minutes.

# Autopilot user experience

Prompt 2.3, operation key `2026-10-10.1/prompt-2.3`. Code: `claudewatch-extension/autopilot/` (logic) and `popup/popup.js`, `settings/autopilot-settings.mjs` (UI). Tests: `claudewatch-extension/test/autopilot.test.mjs` (unit and engine parity), `tests/browser/autopilot-popup.spec.ts` (real popup and settings page in Chromium with a stubbed `chrome.*`).

## What the user sees

The popup shows one Autopilot card above the usage gauges.

| State | Shown when | Content |
| --- | --- | --- |
| Loading | first paint, `aria-busy` | "Checking your quota…" |
| Ready | a usable provider exists | "Use X next", expected benefit (quota left after the reserve), confidence as a word, reset context, **Open X**, Dismiss, "Why this?" |
| Stale | the pick rests on stale data | the same card plus a warning that it is a guess, confidence forced to low |
| Insufficient data | no provider has a reading, or none is signed in and reachable | what to do next; no recommendation, no impression event |
| All providers limited | every eligible provider is capped | earliest reset and provider, **I'll wait**, Dismiss |
| Off | the user disabled Autopilot | "Turn on" control |

Alternatives are an alphabetical, unranked "Also available" list with their own Open buttons, not a leaderboard. The explanation always says the comparison is of remaining quota and risk, not model quality. **Open** only opens the provider's home page; no prompt or conversation content is read or sent.

"Changed from A: reason" appears when the recommendation differs from the last one shown and names the cause: preferences changed, the previous provider reached its limit / looks signed out / went stale, the new provider reset / signed in / refreshed, or every provider is limited. The cause list is in `view-model.mjs` (`explainChange`); the first matching cause wins and the fallback is "quota readings changed".

## Controls (settings page, saved immediately)

Task type, reserved quota (0 to 90 percent), working hours (local time zone, offset re-read at each popup open so daylight saving applies), notification frequency, preferred provider, and never-recommend providers (exclusion beats preference). Preferences live in `chrome.storage.sync` (`autopilotPrefs`); the last recommendation summary (provider names, flags, percentages) in `chrome.storage.local`. Notification frequency decides which Autopilot alerts may fire; see [AUTOPILOT_ALERTS.md](AUTOPILOT_ALERTS.md).

## Engine and data

The popup cannot import the daemon's TypeScript, so `autopilot/policy.mjs` is a port of `src/recommend/policy.ts`. The parity test runs both on every simulation scenario and on pin, exclusion, reserve, disable and working-hours variants and requires identical action, provider, confidence, alternatives, warnings and wait time. If you change one engine, change the other.

Inputs come from the stats the popup already has (`inputs.mjs`): the latest provider-reported percentages, reset times, refresh health, and the 7-day snapshot history. There is no ledger in the extension, so forecasts are coarse: a straight-line burn over at least four readings spanning 20 minutes (five-hour window) or six hours (weekly), mapped to three probability buckets (0.85, 0.4, 0.05) with confidence capped at medium. With less history the forecast is `insufficient_data` with low confidence and no risk number. These buckets are **not calibrated**; real-history evaluation remains final-gate evidence (see FORECASTS.md). A provider with no reading, or whose refresh reports `auth_expired`, is treated as signed out and is never recommended, whatever the user prefers.

## Instrumentation

All events go through the existing local-only, allow-listed analytics store (schema v1, never leaves the browser). Props are closed enums, so no content, URL or identifier can be recorded.

| Event | Props |
| --- | --- |
| `recommendation_impression` | action, provider, confidence, state; at most one per distinct recommendation per six hours |
| `first_recommendation` | kind (`provider_switch` or `wait`); emitted with the first impression |
| `explanation_viewed` | action |
| `provider_opened` | provider, source (`primary` or `alternative`) |
| `wait_chosen` | provider |
| `recommendation_dismissed` | action |
| `preference_changed` | setting name only, never the value |
| `autopilot_toggled` | enabled |

`docs/product-hunt/baseline/event-schema.v1.json` and METRICS_CONTRACT.md list them. A dismissed recommendation stays hidden until its action, provider or confidence changes.

## Accessibility and localization

The card is a labelled region with a polite live region; state and confidence are words, not colour; buttons are native and keyboard focusable with a visible focus ring; "Why this?" is a native `<details>`. All text is in the message catalog (`ap*` keys, pseudo-locale regenerated).

## Known limits

Not validated on real usage history. Forecasts in the popup are coarser than the daemon's. Alerts and the experiment are described in AUTOPILOT_ALERTS.md. The explanation is built from structured codes, so it can differ in wording from the English `explanation` of the TypeScript engine.

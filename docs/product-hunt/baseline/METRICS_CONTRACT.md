# Token Watcher metrics contract (schema v1)

Operation key: `2026-10-10.1/prompt-0.1`. Machine-readable schema:
[`event-schema.v1.json`](event-schema.v1.json), generated from
`claudewatch-extension/analytics.js` and kept in sync by a test.

## Principles

- **Local only.** Events are written to `chrome.storage.local` under
  `analytics_events_v1`. This change adds no network calls and no new
  permissions. Nothing is uploaded; the debug view and JSON export are the only
  ways to read the log.
- **Allow-list schema.** Every event name and property is declared. Properties
  are closed enums, booleans or bounded integers, so free-form text cannot be
  expressed. Unknown events or properties are rejected and never stored.
- **Defence in depth.** Independently of the schema, property names matching
  prompt/response/content/cookie/token/session/credential/email/account/org/
  user/device/title/url/dom/page/attachment/conversation patterns are
  rejected, as are values shaped like e-mail addresses, URLs, UUIDs, JWTs,
  API keys or long opaque blobs. Tests cover each.
- **Unknown is not zero.** A metric with no evidence is `unknown`; values are
  never estimated or defaulted.

## Prohibited data

Prompt or response text, conversation titles, attachments, page contents or
DOM, full URLs, cookies, session keys or tokens, credentials, e-mail
addresses, provider account/organization IDs, device IDs and user-supplied
labels are never recorded in analytics events.

## Data retention

| Item | Rule |
| --- | --- |
| Event log | Kept at most 90 days and 5000 events; pruned on every write (oldest first). 90 days covers the week-four retention window (days 28-34) with margin. |
| Install anchor (`analytics_meta_v1.installedAt`) | Kept until the user deletes analytics data; needed to compute time-to-value and retention. |
| Stale-state bookkeeping (`analytics_stale_state`) | Holds at most one open stale interval per provider; removed when the provider refreshes or data is deleted. |
| Deletion | Settings → "Delete all analytics data" removes the log, anchor and stale state. Uninstalling removes everything. |
| Export | Settings → "Download JSON" saves the log on the user's device. |

## Events

See the schema file for exact property types. Summary:

| Event | Emitted by | Status in this PR |
| --- | --- | --- |
| `installed` | `onInstalled` (reason `install`) | emitted |
| `onboarding_completed` | onboarding "close" button | emitted |
| `provider_connected` | first successful refresh per provider | emitted |
| `first_useful_reading` | first successful provider-reported refresh after install | emitted |
| `refresh_result` | every provider refresh attempt | emitted |
| `stale_started` / `stale_ended` | heartbeat / next successful refresh | emitted |
| `active_day` | popup, settings or onboarding opened, once per local day per surface | emitted |
| `first_recommendation` | first Autopilot recommendation shown in the popup (`kind` is `wait` when every provider was limited, else `provider_switch`) | emitted (Prompt 2.3) |
| `recommendation_impression` | Autopilot recommendation shown; at most one per distinct recommendation per six hours | emitted (Prompt 2.3) |
| `explanation_viewed` / `provider_opened` / `wait_chosen` / `recommendation_dismissed` | user interactions with the Autopilot card | emitted (Prompt 2.3) |
| `preference_changed` / `autopilot_toggled` | Autopilot setting changed (which setting only, never its value) / recommendations turned on or off | emitted (Prompt 2.3) |
| `attribution_measured` | needs the Phase 1 ledger/reconciliation | **defined, no emitter yet** (Phase 1.4) |
| `alert_shown` / `alert_action` | the extension has the `notifications` permission but no alert code | **defined, no emitter yet** (Phase 2) |
| `report_shared` | no sharing feature exists | **defined, no emitter yet** (Phase 5) |

## Metric formulas

| Metric | Formula | Unit |
| --- | --- | --- |
| Activation | 1 if a `first_useful_reading` exists for an install, else 0. Cohort activation = activated installs / installs. | rate |
| First useful reading | `first_useful_reading.secondsSinceInstall`. A *useful* reading is a provider-reported (not locally estimated) snapshot that passed snapshot validation. | seconds |
| First recommendation | `first_recommendation.ts - installed.ts` | seconds |
| Provider connection rate | distinct providers with `provider_connected` / 3 supported providers | rate |
| Refresh success rate | `refresh_result.ok` / all `refresh_result`, excluding `errorCategory = provider_tab_missing` (provider not open is not a failure of Token Watcher) | rate |
| Stale duration | `stale_ended.staleSeconds` (p50 and max). Stale = last successful refresh older than 15 minutes (`PROVIDER_STALE_MS`) for a connected provider. | seconds |
| Unexplained stale rate | `stale_ended` with `explained = false` / all `stale_ended`. Explained = a categorized error other than `other` was recorded. | rate |
| Attribution coverage | sum(`attributedUnits`) / sum(`eligibleUnits`) = attributable quota movement / eligible provider quota movement, reset intervals excluded | rate |
| Alert action rate | `alert_action` (excluding `dismiss`) / `alert_shown` | rate |
| Report sharing | count of `report_shared` | count |
| Week-four retention | 1 if any `active_day` falls 28-34 days after `installed`, else 0; unknown until 35 days of history exist. Cohort retention = mean over installs. | rate |

Because storage is on-device, these are per-install values shown in the debug
view. Cohort aggregation requires a consented upload path, which does not
exist and is out of scope for Phase 0 (no cloud sync in this phase).

## Changing the schema

Bump `SCHEMA_VERSION`, regenerate `event-schema.v1.json` (rename for the new
version), and keep the validator rejecting the old shape. A property that can
hold free text must not be added.

# Provider refresh scheduling

Operation key: 2026-10-10.1/prompt-0.2. Policy code: `claudewatch-extension/refresh-policy.js` (pure, no `chrome.*`); wiring: `claudewatch-extension/background.js`.

## Triggers

Every trigger funnels through `requestProviderRefresh(trigger, site)`, which asks `TokenWatcherRefresh.evaluate` whether to run. The decision uses persisted per-provider state (`refresh_state_<site>` in `chrome.storage.local`), so it survives service worker restarts, and an in-flight refresh per provider is never duplicated.

| Trigger | Source | Minimum age of last attempt |
| --- | --- | --- |
| `install`, `startup` | `runtime.onInstalled`, `runtime.onStartup` (forced for all providers) | none |
| `worker_restart` | service worker script start | none (state decides) |
| `tab_created`, `navigation` | `tabs.onCreated`, `tabs.onUpdated` (status `complete`) on provider sites | none |
| `tab_activated` | `tabs.onActivated` | 15 s |
| `wake`, `focus` | `idle.onStateChanged`, `windows.onFocusChanged` | 5 min |
| `alarm` | `poll` alarm (5 min) | 4 min 45 s |
| `watchdog` | 1 min `heartbeat` alarm | 7 min |
| `retry` | one-shot `retry_<site>` alarm set after a retryable failure | none |
| `network_restored` | `online` event | none (resumes network failures) |
| `auth_recovery` | provider cookie set while state is `auth_expired` | none (resumes auth failures) |
| `manual` | popup "Retry now" (`REFRESH_NOW`) | none, bypasses backoff |
| `stats_read` | popup/page `GET_STATS` | 1 min |

## Failures

| Category | Behaviour |
| --- | --- |
| `network`, `timeout`, `provider_tab_timeout`, `other` | Exponential backoff (15-30 s base, 5-10 min cap), 50-100% jitter, retry alarm. |
| `rate_limited` | Same, 2 min base, 30 min cap. Tab events do not bypass the backoff. |
| `auth_expired`, `provider_tab_missing` | No timed retry. Resumes at once on a tab/navigation/sign-in signal; otherwise probed at the 5 min poll cadence. |
| `provider_schema_changed` | No timed retry, no recovery trigger; probed at the poll cadence. Needs an extension update. |

`getStats().providerHealth[site]` exposes `lastFetchAt` (last successful provider fetch) separately from `lastRenderAt` (when the popup data was built), plus `lastAttemptAt`, `staleReason`, `staleMessage`, `retryable`, `nextRetryAt`, and `consecutiveFailures`. The popup shows the reason, the fetch age, and a "Retry now" button.

Observability: `refresh_result` analytics events still carry the closed trigger and error category enums (fine-grained triggers map onto them), so the baseline metrics contract is unchanged.

## Soak

`npm run soak:refresh` regenerates [refresh-soak.md](refresh-soak.md): an accelerated, deterministic simulation of the policy, not a real-browser 24 h run.

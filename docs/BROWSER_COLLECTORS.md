# Browser activity collectors (Prompt 1.2)

Opt-in, metadata-only observations of Claude, ChatGPT and Gemini web use. They feed the usage ledger (`docs/LEDGER.md`) as `local_activity` records with `source: web`, `confidence: low`, `measurementMethod: local_estimate` and a single `requestCount` measure. They are evidence of local use. They are never treated as quota measurements and never carry `quotaPercentUsed`.

## What is recorded
Provider, event time, a random local session identifier (reset on browser restart, no account, URL or conversation data), the model only when reliably available (currently never populated), and a coarse activity type (`message_completed` or `message_failed`).

## Never recorded
Prompt or response text, attachments, conversation titles, full URLs, DOM contents, cookies, tokens. The page-side signal (`STREAM_ACTIVITY`) carries only the coarse type. `validateActivity` rejects any unknown field.

## Behaviour
- Off by default. Settings page lists exactly what is recorded and offers a toggle and "Delete recorded activity now". Turning the toggle off also deletes stored activity.
- Private windows are excluded in the service worker (`tab.incognito`).
- Events are stored in `chrome.storage.local`, keyed by a random event id. Writes are serialized and idempotent, so service worker restarts and retried messages never duplicate. Retention is 30 days / 5000 events.
- Multiple tabs get separate session ids. Navigating between conversations does not create events or read conversation identity.
- Failed requests are stored as `message_failed` but are not forwarded to the ledger as usage.
- Multiple signed-in accounts: the collector cannot tell accounts apart, so the caller supplies one `accountAlias`. Attribution by account is left to reconciliation (Prompt 1.4).
- `toLedgerInputs` converts completed events into ledger inputs; the ledger's own validator and dedupe apply.

## Not yet done
Wiring `toLedgerInputs` output into a persisted ledger store is deferred to Prompts 1.4/1.5, which own the extension-side ledger consumer. Page redesign resilience rests on the existing stream detection in `interceptor.js`; a redesign that changes stream endpoints yields no events (fail closed) rather than wrong ones.

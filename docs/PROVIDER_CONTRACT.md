# Provider usage contract (v1)

Prompt 0.3 (`2026-10-10.1/prompt-0.3`). One contract describes quota data for Claude, ChatGPT and Gemini. Code: `claudewatch-extension/provider-contract.js` (contract, validation, forecast) and `provider-adapters.js` (raw provider response to snapshot). Both are plain scripts shared by the service worker, the popup and the tests.

## Reading

One reading is one quota window of one account.

| Field | Meaning |
| --- | --- |
| `provider` | `claude`, `chatgpt` or `gemini` |
| `windowType` | `5h` (short window) or `7d` (long window); `windowSeconds` carries the provider's own duration when it gives one |
| `usedPct`, `remainingPct` | 0 to 100, and they must sum to 100 |
| `resetsAt` | ISO reset time, or null when the provider omits it |
| `sourceTimestamp` | The provider's own timestamp for the value. **Null today for all three providers**: none of them supply one, and the fetch time is not substituted for it |
| `fetchTimestamp` | When the extension fetched it |
| `provenance` | `provider_reported`, `local_estimate` or `forecast` |
| `confidence` | `authoritative`, `estimated`, `high`, `medium` or `low` |
| `error` | `{ category, message }` when the window has no usable value; `usedPct`/`remainingPct` are then null |

Provider-reported quotas are stored on the snapshot's `readings`. Locally estimated token counts are never written into a reading: they live in the history and token totals and reach the popup only through `pct5hSource`/`pct7dSource` (`provider_reported` or `local_estimate`), so the two cannot be confused.

## Validation

`validateReading` and `validateSnapshot` reject (not clamp) percentages outside 0 to 100, remaining that does not complement used, unparseable timestamps, a fetch time more than 5 minutes in the future, a source time after the fetch time, and a reset more than one window length (plus 1 hour) away. Before this change, snapshots accepted up to 1000 percent. A rejected snapshot is not stored; if nothing usable remains the refresh is recorded as `provider_schema_changed`.

A window the provider did not report becomes an explicit error reading (`window_unavailable`), not a zero.

## Forecasts

`projectUsage` projects current usage forward at the observed rate. It never forecasts below the current value, ignores negative rates, and returns no forecast when usage is already at 100 or the inputs are not finite. When the projection reaches the limit it reports `saturated: true` with `hoursToLimit` and `exhaustsAt`; the popup shows "may reach limit" rather than a repeated "100%".

## Adapter contract tests

`test/provider-adapters.test.mjs` runs the same checks over every provider and every fixture kind in `test/fixtures/providers/`: normal, partial, missing (no provider tab), expired (401/403), changed-schema, rate-limited (429) and impossible (out-of-range value). A new adapter must supply all seven fixtures and pass unchanged.

**The fixtures are synthetic.** They are shaped like each provider's response as the adapters parse it, with fake identities and fixed dates. They are not captures of live accounts, and passing them does not prove the live providers still match. Replacing them with sanitized live captures needs authenticated provider accounts and is tracked as an open item in the Phase 0 gate evidence.

## User-visible copy

Gauge captions state the source: "Provider-reported", "Estimate from local tokens, not provider-reported", a forecast with its confidence, or the reason no reading is available (for example "Signed out or session expired. Sign in to the provider, then retry."). Strings are still inline; externalising them is Prompt 0.4.

## Observability

The per-provider poll record now includes `errorCategory` (the refresh-policy vocabulary). No analytics event schema changed.

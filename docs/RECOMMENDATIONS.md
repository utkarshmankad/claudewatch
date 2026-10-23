# Recommendation policy engine

Code: `src/recommend/policy.ts` (engine), `src/recommend/simulate.ts` (scenario harness). Tests: `src/recommend/__tests__/policy.test.ts`. Prompt 2.2, operation key `2026-10-10.1/prompt-2.2`. The engine is pure and deterministic: the same inputs always give the same answer. The extension popup uses a JavaScript port of it (see [AUTOPILOT.md](AUTOPILOT.md), Prompt 2.3); no daemon route is added. A UI assembles `ProviderInput[]` from [forecasts](FORECASTS.md) and its own sign-in and health state.

**It ranks remaining quota and risk. It does not rank model quality**, and every explanation says so.

## Inputs

| Input | Source |
| --- | --- |
| Remaining quota, reset time, forecast risk | `Forecast[]` per provider window (2.1) |
| Provider health | `ok`, `degraded` (score penalty, confidence capped at medium), `offline` (ineligible) |
| Authenticated | A signed-out provider is ineligible, always |
| Privacy restriction | A restricted provider is ineligible for the task |
| Task profile | `coding`, `research`, `writing`, `analysis`, `general` |
| Reserved quota | Percent kept back; reduces headroom |
| Working hours | Outside them, five-hour window risk is not counted (it resets before the next session) |
| Pin, exclusions, disable | User preferences (`parsePreferences` validates stored values; exclusion beats pin) |

## Task profiles

Profiles do not carry a built-in model preference. The user may declare `affinity[task] = [providers...]`; it is used **only as a tie-break** between candidates with equal score, never to override quota.

## Scoring

For each eligible provider: headroom is the minimum over its windows of `100 - reserved - used`. Penalties: `40 x exhaustion probability` per open window (uncalibrated, see FORECASTS.md, so it is only a bounded nudge), 25 per stale window, 10 per window without enough history, 15 for degraded health. Any window the provider reports at its limit blocks the provider (score 0). Order: unblocked, score, user affinity, provider name.

## Output

`action` is `use`, `wait` or `none`; plus `provider`, `alternatives` (usable, ranked), `considered` (ineligible providers and why), `confidence`, `inputsUsed`, `warnings` and a plain-language `explanation`.

- **use**: best usable provider. A pin wins when the pinned provider is usable; otherwise the pin is reported (`pinned_blocked`, `pinned_ineligible`, `pinned_unavailable`) and the best alternative is used.
- **wait**: every eligible provider is at a limit. `waitUntil` is the earliest time any provider is fully available (all of its capped windows must have reset). Unknown reset gives `waitUntil: null` and `wait_until_unknown`.
- **none**: recommendations disabled, or no eligible provider.

## Graceful degradation and confidence

- Stale or missing data never yields high confidence and is always flagged (`stale_data`, `no_history`).
- A close call (scores within 5) or a single candidate caps confidence at medium.
- Conflicting windows (one capped, one open) block the provider and are flagged.
- The engine never selects an unauthenticated, offline, excluded or privacy-restricted provider, whatever the pin.

## Simulation harness

`runScenarios()` runs nine named scenarios through the real policy with synthetic forecasts: abundant quota, imminent block, stale data, provider offline, conflicting windows, no history, privacy restriction, all providers limited, unauthenticated provider. They are synthetic and demonstrate behaviour, not accuracy.

## Observability

`decisionLogLine(rec)` produces one line (action, provider, confidence, counts, ineligibility reasons, warnings). It never includes account aliases, prompts or conversation content.

## Not done here

Decision alerts (2.4); real-history evaluation of recommendations (final gate evidence).

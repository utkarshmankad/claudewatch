# Limit Change Radar: aggregate ingestion and anomaly detection

Operation key: `2026-10-10.1/prompt-4.2`. Builds to the approved design in `PRIVACY_AND_ARCHITECTURE.md` (PR #70). Library code only: no endpoint is deployed, nothing is wired into the extension or daemon, and no real contribution exists. `src/radar/`: `ingest.ts`, `aggregate.ts`, `detect.ts`, `pipeline.ts`, `simulate.ts`.

## Flow

`ingest` -> raw rows (7 days) -> close bucket (6 h + 1 h grace) -> `aggregateBucket` (distinct contributors, quarantine) -> `suppress` (cohort >= 20, complementary) -> `publish` (Laplace noise, privacy budget) -> `detectIncidents` -> incident feed (band, scope, confidence).

## Ingestion

- Envelope: `{ token, pseudonym, contribution }`. The contribution is validated by the 4.1 strict allowlist; anything else is rejected.
- Authenticated but unlinkable: the token is verified by an injected `verifyToken` (blind-signature verification in a real deployment) and is single use. Only a hash of a spent token is kept, for the raw-retention period. The pseudonym (rotates weekly on the client) is stored hashed and used only to count distinct contributors. The weaker fallback from design open question 2 (pseudonym only) is what `verifyToken: () => true` degrades to; it is not chosen here.
- Rate limits: per source, per UTC day, keyed by a hash with a salt that rotates daily and is held in memory. The source address is never stored.
- Callers only see `rejected` or `rate_limited`. The real reason (schema, token_invalid, token_spent, pseudonym, time_window, duplicate, rate_limited) goes to counters (`counters.rejected`) with no content.
- Raw rows have no read accessor for operators; only aggregate jobs reach them through `withRows`. `purge` deletes rows, spent-token hashes and dedupe memory after 7 days.

## Aggregation and privacy

- Cohort = provider x planType x regionBucket x windowType x 6-hour bucket. A pseudonym counts once per cohort.
- Quarantine: if a cohort exceeds 5x the median of its series' last 8 published buckets (needs at least 3), it is dropped and counted in `cohortsQuarantined`. A genuinely fast-growing user base is quarantined too until reviewed; there is no review tool yet.
- Suppression: cohorts under 20 are dropped. If exactly one sibling (same provider, plan, region, bucket) is suppressed, the smallest published sibling is also suppressed.
- Noise: rates get Laplace noise of scale `1 / (n * epsilonPerView)`, with epsilon 1.0 per cohort spread over at most 3 views (1/3 each). Each cohort is released once and cached, so re-reading it costs nothing. Budget accounting is per cohort-bucket. A person present in several buckets of a day is not composed across buckets; this is a known gap for the owner's review (design question 4).
- Exact `n` is kept in the in-process published row for the detector. Incidents expose only a band (`20-49`, `50-199`, `200+`), the scope, a confidence and a plain-language evidence line. `schemaSignature` is validated but not yet aggregated; no 4.2 rule uses it.

## Detection rules (transparent, no model)

Per series, per rate (`schemaMismatch`, `missingFields`, `error`, `resetDeviation`): baseline = median of up to 8 recent normal buckets (at least 4 needed). A bucket is elevated when the rate exceeds the baseline by at least `max(0.2, 4 x noise scale)`. Two elevated buckets open an incident; two normal buckets close it. The noise term means small cohorts need a bigger change before they can alert.

| Signal | Incident kind |
| --- | --- |
| schemaMismatch | `parser_failure` |
| missingFields | `missing_fields` |
| error | `provider_error_spike` |
| resetDeviation | `reset_pattern_change` |
| a window type's share of a provider/plan/region moves by >= 0.3 | `quota_window_change` (uses exact n, not noised) |
| any of the above confined to one region or one plan when others are observed | `plan_region_anomaly` |

Series alerts of the same provider and signal that start within two buckets are merged into one incident. Confidence = 0.35 x cohort size (n/200, capped) + 0.30 x consistency (size of the rise relative to twice the threshold) + 0.15 x recency (half-life 24 h) + 0.20 x data quality (`dataQuality`, default 1; not yet fed from real counters).

## Measured results (synthetic, replayable)

`runSimulation` drives the real ingest/aggregate/detect path with a seeded PRNG. Setup: 2 providers x 2 plans x 2 regions, 100 contributors per series per bucket, 80 buckets (20 days), five scenarios per run (schema removal, provider outage, reset-window change, single-region missing fields, quota correction). Measured over seeds 1-20 (100 scenarios):

| Metric | Result |
| --- | --- |
| Incidents raised / true / false | 113 / 100 / 13 |
| Precision | 0.885 |
| Recall (scenarios detected) | 0.98 |
| Time to detection | 6 h (one bucket after onset) in every detected scenario |
| False alerts | 0.41 per 100 series-days |
| Quiet traffic, no scenarios, 20 runs x 20 days | 1 false alert |

Reproduce with `runSimulation({ seed, ticks: 80, contributorsPerSeries: 100, scenarios })`; see `src/radar/__tests__/pipeline.test.ts` for the scenarios and asserted floors (precision and recall >= 0.8 over 3 seeds, time to detection <= 12 h).

Limits: the traffic is synthetic and independent across contributors, rates are drawn from assumed baselines (96% parser ok), and the five scenarios were written alongside the rules. The numbers say the rules work on that model, not that they will on real provider behavior. Failures seen: noise on a small daily cohort occasionally starts a run early, which both creates a false alert and shifts the real incident's first-observed time earlier than onset (seed 3 in early tuning). No real-history backtest, no privacy review and no legal review has happened.

## Observability

`RadarIngest.counters` (accepted and rejected by reason), `RadarPipeline.metrics` (buckets and cohorts published, suppressed, quarantined, withheld by budget). They hold no content or identifiers. Nothing exports them yet; 4.3 decides where they surface.

## Rollback

Nothing is deployed. Reverting this PR removes `src/radar/{ingest,aggregate,detect,pipeline,simulate}.ts`, their test and this document.

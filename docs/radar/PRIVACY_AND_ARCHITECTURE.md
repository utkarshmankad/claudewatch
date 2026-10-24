# Limit Change Radar: contribution privacy rules and architecture

Status: proposed (needs owner approval; this is a human gate). Date: 2026-10-24. Operation key: `2026-10-10.1/prompt-4.1`.

Prompt 4.2 (pipeline) must not start until this document is approved and merged. Nothing here is deployed; no endpoint exists.

## 1. Purpose and non-goals

Radar detects provider limit changes and parser breakage from aggregate observations. It does not measure how much anyone uses a provider, does not identify users, and does not run unless the user opts in. Radar is separate from encrypted sync (ADR-0001): sync is per-user ciphertext; Radar is a separate, aggregate-only path with its own consent and endpoint.

## 2. Contribution fields (exhaustive allowlist)

Implemented in `src/radar/contribution.ts`. Any other field is rejected.

| Field | Allowed values | Why it is needed | Privacy treatment |
| --- | --- | --- | --- |
| schemaVersion | `1` | Evolve the format | Constant |
| provider | `claude, chatgpt, gemini, copilot, cursor, other` | Which service changed | Closed set |
| planType | `free, individual_paid, team, enterprise, api, unknown` | Plan-specific anomalies | Coarse category; no plan names, seat counts or price |
| regionBucket | `americas, emea, apac, other` | Regional rollouts | Continent-scale; derived from the browser locale/timezone on device, never from IP |
| windowType | `rolling_5h, daily, weekly, monthly, other` | Window changes | Closed set |
| schemaSignature | 16 hex chars | Detect removed/renamed fields | Hash of sorted field names only, never values |
| parserResult | `ok, partial, missing_fields, schema_mismatch, error` | Parser degradation | Closed set |
| resetBehavior | `as_expected, earlier, later, absent, unknown` | Reset-pattern changes | Closed set; no timestamps of resets |
| extensionVersion | `major.minor.patch` | Version-specific faults | Suffixes stripped |
| timeBucket | UTC, 6-hour bucket | Recency | Rounded down; no finer time |

### Never collected

Prompts, responses, conversation titles or content, cookies, tokens, credentials, page URLs, email, account or organization identifiers, device or install identifiers, IP-derived identity, usage amounts or counts, and minute-level activity. Free text is not accepted anywhere in the schema. The fields are all closed sets or fixed-format strings, so a bug in a collector cannot leak content through them. A test asserts that no allowlisted field name matches a prohibited pattern.

## 3. Consent

- Off by default. Opt-in is a dedicated step, separate from install, sync and any other setting; no bundling and no dark patterns.
- Before opt-in the user sees the contribution preview (`previewContribution`): the exact JSON that would be sent, each field explained, and the "never sent" list. Before the first send, and in settings at any time, the preview shows the user's most recent real payload, byte-for-byte what is transmitted.
- Opt-out is one toggle, takes effect immediately, and stops all queued sends. Withdrawal also offers deletion (section 6).
- Consent record is stored locally: version of this policy, timestamp, region bucket at consent. A policy change that adds a field or purpose requires fresh consent.
- Regional controls: the beta is limited to buckets the owner enables. Where law requires opt-in, explicit consent or a minimum age, the bucket stays disabled until counsel confirms. EEA/UK/Switzerland users get the same consent flow plus a plain-language notice of controller, purpose, retention and rights. The owner needs to decide legal basis and controller identity (open question 1).

## 4. Aggregation rules

- **Minimum cohort:** a group (provider x planType x regionBucket x windowType x time bucket) is analyzed and displayed only when it has at least **20 distinct contributors** in the period (`MIN_COHORT_SIZE`). Below that it is dropped from output, not displayed as zero or "few".
- **Distinctness without identity:** each contributor holds a rotating pseudonymous token (section 5), at most one contribution per cohort per bucket counts.
- **Complementary suppression:** if a published cohort total minus a suppressed cohort could reveal the suppressed one, the next-smallest sibling is also suppressed. Radar never publishes totals across suppressed siblings.
- **Banded counts:** the UI shows bands (`20-49`, `50-199`, `200+`), not exact counts (`sampleBand`).
- **Noise (privacy budget):** published rates (for example share of contributors reporting `schema_mismatch`) get Laplace noise, epsilon = 1.0 per cohort per day, with a daily cap of 3 published views per cohort; stored per-period budget is tracked and publishing stops when exhausted. The owner and 4.2 may tighten these values but not loosen them without a new approval. Detection thresholds in 4.2 must work on noised or thresholded data, so noise is part of the measured precision/recall.
- **No single-contribution exposure:** raw contributions are not queryable by any operator interface; only aggregate jobs read them.

## 5. Ingestion and abuse prevention (design only)

- Transport: HTTPS to a Radar-only origin per region, distinct from the sync origin. Requests carry no cookies, no Authorization identity tied to sync accounts, and no referrer.
- No IP storage: the ingestion edge discards the source address after rate limiting; access logs omit it. Rate limiting uses a short-lived in-memory counter keyed by a salted hash that rotates daily and is never persisted.
- Authenticated but unlinkable: contributors obtain blind-signed, single-use tokens (Privacy Pass style) from an issuance endpoint that rate limits per device and sees no contribution content; the ingestion endpoint sees contributions and tokens but not the device. Token issuance and ingestion must not be joined in logs. Fallback if blind tokens slip schedule: a per-install rotating pseudonym, reset weekly, with the weaker guarantee stated openly (open question 2).
- Abuse: one valid token = one contribution; per-token and per-bucket caps; schema validation rejects anything else with a generic error; contributions from a cohort that suddenly grows more than 5x its trailing median are quarantined, not counted, until reviewed (poisoning defence). Anomalies need independent contributors, so a handful of fake submitters cannot trigger an incident.
- Timing: sends are batched and jittered by up to 30 minutes so arrival time does not narrow the 6-hour bucket.

## 6. Retention and deletion

| Data | Retention |
| --- | --- |
| Raw contributions | 7 days, then deleted (`RETENTION_DAYS.rawContribution`) |
| Aggregates (cohort >= 20, noised) | 90 days |
| Ingestion logs | 7 days, no addresses, no tokens |
| Local consent record and preview history | Until the user clears it |

Deletion: because contributions are unlinkable by design, the server cannot find "your" rows. Deletion therefore means: (a) opt-out stops all future sends and discards the local queue immediately; (b) already-sent raw rows expire in at most 7 days and are never used for anything else; (c) aggregates contain no per-user data and cannot be un-aggregated, which the consent text says. Users who want earlier removal can request deletion of rows by showing the deletion receipt code the extension keeps locally for each batch (a random per-batch value stored with the row; open question 3 asks the owner whether to ship this, since it weakens unlinkability slightly).

## 7. Architecture (for 4.2 and 4.3)

```
extension (on device)                         Radar edge (per region)               aggregate store
collectors -> normalize -> build contribution -> blind token -> POST /v1/contribute -> validate -> raw (7d)
                 |                                                                       |
         preview + consent gate                                                 cohort job: >=20, noise, suppression
                                                                                         |
                                        extension <- signed incident feed (aggregates only) <- anomaly rules (4.2)
```

- Collection happens only after consent, on device, from the already-normalized provider contract. The schema signature is computed locally over field names.
- The incident feed is aggregate-only, public and cacheable; clients pull it, so the server never learns who reads it.
- Remote parser configuration (4.3) is a separate signed artifact and cannot add fields to a contribution; the schema allowlist is compiled into the extension.
- Extension host permissions: the Radar origin is added only in 4.2/4.3 behind `optional_host_permissions` and a permissions doc update.

## 8. Observability

Aggregate counters only: contributions accepted, rejected by reason, suppressed cohorts, budget exhaustion, quarantined cohorts. No counter is labelled by token, address or contributor.

## 9. Risks

| Risk | Mitigation | Residual |
| --- | --- | --- |
| Re-identification through rare combinations (small plan x region) | Cohort >= 20, complementary suppression, bands, noise | Low, but needs a privacy review before the 4.4 beta |
| Timing correlation at the edge | 6h buckets, jitter, no address storage, no join of issuance and ingestion logs | Edge operator trust; stated in methodology |
| Poisoned contributions faking an incident | Single-use tokens, growth quarantine, independent-contributor thresholds | Coordinated attackers with many tokens; confidence score reflects it |
| Schema drift leaks a field | Strict allowlist, unexpected fields rejected, prohibited-name test | Review needed on any schema change |
| Region law gaps | Regions disabled until counsel signs off | Owner decision |
| Consent fatigue / dark patterns | Separate, off-by-default, previewed consent | None known |

## 10. Open questions for the owner

1. Controller identity and legal basis for EEA/UK users, and which region buckets to enable for the beta.
2. Accept blind-token issuance (preferred) or the weekly-rotating pseudonym fallback?
3. Ship the optional deletion receipt code, or rely on 7-day expiry only?
4. Confirm cohort minimum 20 and epsilon 1.0, or choose stricter values.
5. Hosting vendor and region list for the Radar origin (also unresolved for sync).

## 11. Test evidence in this PR

`src/radar/__tests__/contribution.test.ts`: unknown fields rejected (prompt, cookie, email, ip, account, url, usage), missing and malformed values rejected without echoing input, allowlist names screened against the prohibited pattern, timestamp and version coarsening, preview equals the transmitted payload, cohort suppression and banding. No production behavior changes; the module is not yet wired into the extension or daemon. Not verified: no privacy review has taken place, no legal review, no user research on the consent copy.

## 12. Rollback

Nothing is deployed. Reverting this PR removes `src/radar/` and this document. Future rollout is gated by 4.3's remote kill switch.

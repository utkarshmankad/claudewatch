# Growth experiment: validating the acquisition loop

Prompt 5.5, operation key `2026-10-10.1/prompt-5.5`. Code: `src/wrapped/growthExperiment.ts` (assignment, referral codes, event validation, aggregation), tests in `src/wrapped/__tests__/growthExperiment.test.ts`. It builds on the private report ([WRAPPED_REPORT.md](WRAPPED_REPORT.md)), the metric definitions ([WRAPPED_METRICS.md](WRAPPED_METRICS.md)) and the share cards ([SHARE_CARDS.md](SHARE_CARDS.md)).

## Status: framework only, no results

This change ships the experiment framework and the protocol. **The live beta has not been run.** It needs a consented cohort and deployed endpoints (an event receiver and a referral landing path) that do not exist. Therefore:

- There are no measurements in this repository. Every number in the tests is synthetic and exists only to check arithmetic and privacy rules; none may be quoted as a result.
- **Deferred as gate evidence:** running the beta, selecting the winning variant, and removing the losing variants and their instrumentation. Until then all variants and all event types stay in the code, because removing any of them before data exists would be a guess.
- The Phase 5 gate stays `deferred_to_final_gate` (see `docs/product-hunt/gates/`). The report and the code never pick a winner.
- No thresholds are set here. The plan leaves the minimum sample, the success margins and the week-four retention target to the approved experiment design, so `minSample` has no default and `sampleSufficient` is `null` until the owner supplies one. The 25 percent week-four retention and 10 percent report export or share figures belong to Prompt 6.4 launch criteria and are not tested against here.

## Question

Does showing the weekly report with an opt-in factual share card change retention or referred activation, compared with showing the report with no share option, without any dark pattern?

## Participation: opt-in only

Nobody is enrolled by default. `assignVariant` returns `not_opted_in` unless the user has switched the experiment on in a clearly worded setting that says what is recorded (the table below), that it can be turned off at any time, and that turning it off stops all recording. Opt-out is honored from the day it is made: events after the opt-out day are ignored by the aggregation. Declining or leaving has no effect on any feature. A reason for leaving may be given from a fixed list and is optional.

## Variants

| Variant | Report | Share control | Card |
| --- | --- | --- | --- |
| `card_provider_mix` | Same private report | Passive button | `provider_mix`: share per provider, whole percent |
| `card_quota_streak` | Same private report | Passive button | `quota_streak`: streak, share of days under the limit |
| `control_no_share` | Same private report | None | None |

Both card formats are factual (percentages and achievements, nothing invented or comparative) and use the privacy rules, mandatory preview and per-field toggles of Prompt 5.3. The control receives no card and no code.

**Assignment** is deterministic and local: `sha256(experimentId, installSecret)` modulo three. The install secret is random, stays on the device and is never sent, so the server cannot recompute or look up a user's variant, and nothing needs to be stored. The split is close to even (tested on synthetic secrets). Changing the experiment id re-randomizes.

## No dark patterns

`offerPolicy` fixes these for every variant, and tests assert them:

- No automatic prompt, popup or nag: the share control is a button inside the report that the user must press.
- No incentive, reward, discount, streak-loss or guilt message, countdown or social-pressure counter.
- Nothing pre-checked; sharing always goes through the preview and field toggles, and the referral code is a default-off card field.
- The control group loses nothing else and is not shown a worse report.
- Leaving the experiment is as easy as joining it.

## Funnel

| Stage | Event | Definition |
| --- | --- | --- |
| Report viewed | `participant_stage: report_viewed` | The participant opened their weekly report |
| Previewed | `card_previewed` | The share preview was shown |
| Exported | `card_exported` | An image was exported after preview |
| Shared | `card_shared` | The user reported a native share or copied a link (never the destination) |
| Referred install | `install_stage: referred_install` | An install presented a valid referral code |
| Activated install | `install_stage: activated_install` | The referred install recorded its first provider reading in its ledger. This definition is proposed here and needs owner approval before the run |
| Retained install | derived | A referred, activated install with an `install_active` event in days 21 to 27 after its first day |

Counts are distinct subjects, so repeated events count once. Stages are not required to be sequential in the data; a missing earlier stage is reported as it is.

## Metrics

All come from `aggregateExperiment`, per variant, with 95 percent Wilson intervals and the numerator and denominator shown.

| Metric | Definition |
| --- | --- |
| Export rate | Participants who exported / participants who viewed a report. Null for the control |
| Share rate | Participants who shared / participants who viewed a report. Null for the control |
| Referred activation | Activated referred installs / referred installs, attributed to the card format by the code. Null when there are none |
| Referred retention | Retained referred installs / activated referred installs whose week four has ended |
| Week-four retention | Participants with an `install_active` event in days 21 to 27 after opting in / participants whose day 28 has passed. Opt-outs before the window count as not retained. Activity after an opt-out is ignored. Participants whose window has not ended are excluded and counted as `week4Immature`, not as lost |
| Opt-out feedback | Distinct participants who opted out / participants, plus counts by reason (`not_useful`, `privacy_concern`, `too_many_prompts`, `other`) |
| Support issues | Count and count per 100 participants, by category (`card_content`, `privacy_concern`, `export_failed`, `referral_problem`, `other`) |

The control has no card, so export, share and referred metrics do not apply to it; it is compared on week-four retention, opt-out and support issues. Referred installs come only from shared cards, so a cohort-level comparison of referred activation across arms is descriptive: small counts will give wide intervals, which the report shows. The report ranks nothing.

Known measurement limits: week-four retention measures the participant's own activity, which can be affected by who agrees to opt in (self-selection), so results describe the opted-in cohort only. Referral codes are attributed at install time; an install that never enters a code is unobserved. Week four is counted in whole UTC days. Small cohorts cannot support a conclusion, and no statistical test of differences is implemented.

## Referral code

`newExperimentReferralCode(variant)` makes a new 10 symbol Crockford base32 code for every share action. It is accepted by the 5.3 card builder (`REFERRAL_RE`). The generator's only input is the card format.

- Position 0 encodes the card format (which of the two formats produced the share) so referred installs can be compared by format. This is the one deliberate disclosure: it reveals the format, not the sharer. The other nine symbols come from `crypto.randomBytes` with rejection sampling.
- No account, device, participant id, time, counter or hash of any of these goes into a code, so no sharer id can be derived from it, there is no sharer table to leak, and two codes from the same sharer cannot be linked to each other. The server never learns which participant created a code, and a participant's local record does not need to store codes.
- Consequently the experiment cannot tell which sharer produced an install, cannot reward or rank sharers, and cannot compute referrals per sharer. That is intentional.
- Residual risk: a code is a bearer value. If someone posts it publicly with their own identity, that is their choice; the product does not link it. Code reuse by many people is possible and counts each install separately.

## Minimum instrumentation

Everything recorded is in `ExperimentEvent`, and `sanitizeEvents` rebuilds events from an allow-list and discards the rest:

| Field | Content |
| --- | --- |
| `type`, `stage` | One of a fixed list |
| `subject` | A random id for this experiment (participant) or for one install; unrelated to any account |
| `day` | A whole UTC day number, never a timestamp |
| `referralCode` | The opaque code, on install events only |
| `reason`, `category` | A fixed enum value; no free text |

Not recorded: usage values, providers, accounts, devices, plan, cost, card contents, share destination, URLs, IP-derived data or the install secret. Transport is not built; when the receiver is deployed it must not store network addresses with events. Any event type that the final selected experience does not need is removed at the gate (see below).

## Gate procedure (deferred)

Required, in order, once a consented cohort and endpoints exist:

1. The owner approves the activation definition, the minimum sample per variant, and the decision rule, before data is collected, and records them in the gate evidence.
2. Run the beta for at least the owner-approved period, which must cover a full week four for the cohort being judged.
3. Produce the report with `aggregateExperiment` from real events; store it under `docs/product-hunt/gates/` as Phase 5 evidence with the sample size, measurement window, exclusions and rejected-event counts.
4. A person selects the experience. Remove the losing card variant, the control scaffolding and every event type the selected experience does not need, in a separate reviewed change, and update this document.
5. If the data cannot justify keeping sharing, remove the share path rather than keep instrumentation "just in case".

None of these steps has happened.

## Not claimed here

No live run, no measurement, no cohort, no deployed event receiver or referral landing path, no variant selection, no removal of losing variants, no statistical test, and no user research on whether the cards or consent wording are understood.

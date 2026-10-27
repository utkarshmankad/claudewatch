# Phase 3 security review: encrypted sync and companion

Operation key: `2026-10-10.1/phase-3-security-review`. Review base `da98520` (before prompt 3.2), reviewed at `042568` (head of `develop`). Round 1 fixes are in PRs #99 and #100; round 2 (open findings, ZAP, cloud-browser soak) is in PR #101. **Owner decision of 2026-10-24: this review is accepted for the deferred independent-review item, which is closed; see [decision.md](decision.md).**

## Read this first: what this is and is not

**This is an AI-assisted self-review, not an independent audit.** It was produced by the `security-review` and `code-review` skills of Claude Code, plus a manual read of the code by the same agent that works in this repository. It does not satisfy the "independent reviewer" item in [DEFERRED_GATES.md](../DEFERRED_GATES.md) unless the owner decides it does. Penetration testing, fuzzing and load testing were added on 2026-10-24 (next section); they are scripted and local, not a substitute for an independent test. The sync feature must still be described as **"not independently audited"**. The owner's decision belongs in `decision.md`, which this change does not write.

## Scope

`src/sync/**`, `src/companion/**`, `companion/**` (about 2.1k lines of source plus tests), checked against the threat table in [docs/sync/ARCHITECTURE.md](../../../sync/ARCHITECTURE.md) and the earlier self-review in [docs/sync/SECURITY_REVIEW.md](../../../sync/SECURITY_REVIEW.md). Threat model used: T1, a service operator or compromised service that is **active** (rewrites responses), not just curious.

## Method

1. Branch `security/p3-sync-review` from `develop`; `origin/HEAD` pointed at the commit before 3.2 so the merged Phase 3 code showed as the change under review.
2. `security-review` skill over the Phase 3 files, with a manual read of `handler.ts`, `crypto.ts`, `envelope.ts`, `push.ts`, `client.ts`, `companion/app.js`, `companion/sw.js`, `render.ts`.
3. `code-review` skill (high) over the same files for correctness bugs in enrollment, rotation, convergence.
4. `npm audit --omit=dev --audit-level=high`, lint, typecheck, unit, coverage.
5. Each fix has a regression test that was run against the unfixed code first (the first 11 tests all failed there; a 12th, on revoked-device keys, was added after the re-review).
6. The `security-review` skill was re-run on the fixes (no new high-confidence finding; two residual risks recorded below).

## Results (measured)

| Check | Result |
| --- | --- |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `npm run lint`, `npm run typecheck`, `npm run build` | pass |
| `npm test` | 59 files, 1113 tests passed |
| `npm run test:coverage` | pass (statements 92.55%, branches 86.86%, functions 95.45%, lines 95.07%); thresholds met |
| `npm run validate:extension` | pass |
| New regression tests (`src/sync/__tests__/securityReview.test.ts`) | 12 tests; 11 failed on the unfixed code, all pass now |
| Pentest, fuzz, load (see section below), re-run on the round 2 code | 29/29 checks; 18 properties, 732,100 cases, 0 failing; no errors in any load scenario |
| Cloud-browser soak (round 2), runs A, B and C (3 hours, every fault kind) | 99.3% of fault-free samples fresh; longest unexplained stale 1.5 min; recovery within 2.1 min except one rate-limit backoff at 13.1 min; see the soak section |
| OWASP ZAP active scan in CI (round 2) | ZAP 2.17.0, about 8,300 requests; 2 informational alerts, no Low, Medium or High |
| `npm run smoke` | **not run here**: this sandbox lacks `libsecret-1.so.0` (keytar fails to load). CI is the check of record. |
| CodeQL | runs on the PR; its result is on the PR, not asserted here |
| `npm run test:browser`, extension tests | not run in this review (extension unchanged) |

## Findings

Severity: High/Critical = remote compromise of data or authority, or a bypass of a stated guarantee; Medium = bounded integrity/availability/privacy impact or needs specific conditions.

| ID | Sev | Finding | Status |
| --- | --- | --- | --- |
| SR-1 | High | **Enrollment MITM by grinding the SAS.** The 6 digit SAS is 20 bits and the service sees both public keys. A service can generate key pairs (about 10^6, seconds to minutes) until a substitute for the joining device's key shows the same digits, then receive the account key. | Fixed |
| SR-2 | High | **Key rotation wraps to keys the service supplies.** `distribute()` wrapped each new account key to the `encPublic` in `GET /v1/devices`. A service could substitute a device's key or invent a device and receive every later key. | Fixed |
| SR-3 | High | **Unauthenticated key wraps.** `collectKeys()` accepted any wrap that opened with the device's own public key and adopted any higher epoch. A service could inject a key it knew for a future epoch and read everything written afterwards. | Fixed |
| SR-4 | Medium | **Approve fetched the joining key twice.** The SAS was checked on one response and the wrap made for a second response. | Fixed |
| SR-5 | Medium | `/v1/enrollments/approve` registered an active device before validating the body; a malformed body left an orphan active device on every retry. | Fixed |
| CR-1 | Medium | `sync()` uploaded before learning a rotation, so a device with queued items got `409 stale_epoch` and never pulled the new key. | Fixed |
| CR-2 | Medium | Objects whose epoch key had not arrived were skipped and the cursor moved past them, so they were lost on that device for good. | Fixed |
| CR-6 | Low | Two pending writes to one preference from one device tied; the second lost. | Fixed |
| FZ-1 | Medium | A malformed service reply (non-array key-wrap list, non-object body) crashed the client with a `TypeError`. Found by fuzzing. | Fixed |
| FZ-2 | Low | An object with a non-integer sequence would corrupt the pull cursor and hide later objects. Found while fixing FZ-1. | Fixed |
| LT-1 | Medium | Audit events grew without bound under unauthenticated, rate-limited and write traffic. Found by load testing. | Fixed |
| LT-2 | Low | The rate-limit table grows per distinct client address until the hourly clean-up. | Fixed (round 2) |
| CR-3 | Medium | `/enrollments/status` deleted the enrollment on the first approved read; if that response was lost the new device was registered but could not finish. Also, the approver's wrap used its own epoch while the service stamped its own. | Fixed (round 2) |
| CR-4 | Medium | Rotation bumps the server epoch before every wrap is distributed; a crash midway leaves the epoch ahead of the keys and a retry is refused. | Fixed (round 2) |
| CR-5 | Low | A retried upload whose first attempt succeeded records a different ciphertext hash, so receivers warn `chain_fork` falsely. | Fixed (round 2) |
| CR-7 | Medium | A device enrolled after a rotation holds only the current key, so earlier history is undecryptable on it. | Fixed (round 2) |
| CR-8 | Low | Records pulled from peers were not checked for content-derived ids (`strictIds` existed but was off). Needs an enrolled hostile device (T7). | Fixed (round 2) |

### What the fixes do

- **SR-1, SR-4, SR-5** (`client.ts`, `crypto.ts`, `handler.ts`): the enrollment code now carries a random confirmation secret that is never sent to the service. The joining device sends a MAC of its keys under it; the approving device refuses keys whose MAC does not verify, and wraps for exactly the key it verified. The account-key wrap is bound to a tag derived from the secret, so the joiner rejects a wrap the service made. The SAS stays as a user-visible second check. Codes from older clients (two parts) are refused. The server validates the approve body before registering the device and prunes expired enrollments.
- **SR-2** (`distribute`): wraps go only to pinned keys: the other side's key from enrollment, keys published inside the encrypted device list (`DeviceEntry.encPublic`, written by `nameDevice`), and nothing else. Other devices are skipped and listed by `unverifiedDevices()`. A device this client revoked is unpinned and never re-pinned, even if the service lists it as active.
- **SR-3** (`collectKeys`): a wrap opens only with a tag derived from the previous epoch's key, so only an account-key holder can make one. Wraps are applied in epoch order; a wrap with no previous key is refused.
- **CR-1, CR-2, CR-6:** `sync()` collects keys before uploading; skipped objects are remembered with their epoch and applied when the key arrives; the later of two pending writes from one device wins.

### Round 2: how the open findings were closed

- **CR-3:** the enrollment survives status reads until it expires, so finishing again after a lost reply works; the approver sends the epoch it wrapped for and the service stores that. A second `startJoin` with the same code is still refused.
- **CR-4:** a rotation is saved (`pendingRotation`) before the epoch is bumped. The next `sync`, `rotateKey` or `revokeDevice` finishes it: it checks the server epoch, bumps it only if needed, adopts the key and hands it out. A rotation another device beat to the next epoch is dropped with an error.
- **CR-5:** an upload is sealed once and stored with its outbox entry; a retry resends the same bytes. A `stale_epoch` refusal throws the sealed copy away, learns the new key and seals again.
- **CR-7:** an approving device wraps its whole key ring, so a new device can read history from before it joined (the service limit on a wrap grew from 512 to 16,384 characters).
- **CR-8:** records from peers must carry the id derived from their content; others count as corrupt.
- **LT-2:** expired rate-limit windows and sessions are swept once the tables pass `sweepAbove` (default 20,000), and the rate-limit table is capped at 500,000 entries (the oldest quarter is dropped if still over). A flood of distinct addresses is still held for the length of the window (1 minute for sessions, 1 hour for account creation and enrollment guesses), but no longer without bound. The per-address limits are now configurable (defaults unchanged).
- **R8:** key wraps are signed by the sender's device key and the recipient accepts a wrap only if the sender's key was pinned. A revoked device's key is unpinned, so its wrap is refused even with a valid tag.
- **R9:** the revoking device publishes the revoked key inside the encrypted log under the old epoch, before it rotates; peers pull, unpin it, and then take key wraps (the order inside `pull` is objects first, then wraps). A service that says the device is not revoked changes nothing.
- **R10:** every upload carries the sender's public keys inside the encrypted envelope, so a device is pinned by its peers as soon as it has uploaded anything.

Each has a regression test in `securityReview.test.ts` that fails on the code before the fix.

## Residual risks and limits (not fixed; the owner closed the review item but has not individually accepted these)

| ID | Risk |
| --- | --- |
| R8 | **Closed in round 2**, with this remainder: pins are added by any holder of the account key (a device's keys are pinned from its first upload). A compromised enrolled device (threat T7, out of scope) can pin a key of its own and receive later keys. |
| R9 | **Closed in round 2** for devices that pull the revocation before a rotation reaches them. A device that has been offline learns of the revocation on its next pull, which is processed before key wraps. |
| R10 | **Narrowed in round 2**: a device that has never uploaded anything is not pinned by peers other than its approver, so a rotation by another peer skips it (`unverifiedDevices()` lists it) until it uploads. |
| R12 | Two devices rotating at the same moment to the same epoch number can produce two different keys for that epoch; the loser detects only a *higher* server epoch. Needs a server-side compare-and-set on the key, not done. |
| R11 | Earlier accepted risks R1-R7 in [docs/sync/SECURITY_REVIEW.md](../../../sync/SECURITY_REVIEW.md) still stand, including R4 (push transport and VAPID custody are outside this repo) and R7 (the in-memory store is not the production store). |

## Penetration test, fuzzing and load test (added 2026-10-24)

All three ran against this repository's code on one 4 vCPU / 16 GB sandbox (Node 22), never against a deployed service. Scripts, seeds and raw results are in [security-tests/](security-tests/README.md).

### Skills and tools chosen

| Test | Claude skill | Tool used | Why |
| --- | --- | --- | --- |
| Penetration test | None available. The skill search (`SearchSkills`) found no pentest, fuzz or load-test skill, and the built-in skills offer only `security-review` and `code-review`. | A scripted black-box attack suite (`pentest.ts`, 29 checks written for this API from the OWASP API Security Top 10: broken authentication, object-level authorization, input handling, SSRF, rate limits, error disclosure, deletion) run over HTTP against the dev server | The API is small and bespoke, so targeted attacks give more signal than a generic scanner. |
| Fuzzing | None available | **fast-check** 4.x (property-based testing), 18 properties, fixed seed `20261024` | Runs in-process on the real code with invariants, finds minimal counterexamples. A coverage-guided fuzzer (Jazzer.js, AFL-style) was not used. |
| ZAP scan | None available | **OWASP ZAP** (official container image, run by `.github/workflows/security-zap.yml` on a GitHub-hosted runner) | The standard external web-security scanner; run in CI because it could not be installed and verified in the sandbox. |
| Load test | None available | **autocannon** 8.x | Scriptable HTTP load generator, reports latency percentiles and status counts. k6 is the usual alternative. |

**OWASP ZAP was first not run, then run in the cloud (round 2).** A 234 MB release tarball downloaded in the sandbox could not be verified: its core jar did not match the checksum Maven Central publishes for the same version (45 class files differ, so it is a different build), and the project's site was unreachable. It was deleted and not executed. The scan below uses the official container image on a GitHub-hosted runner instead. Burp was not run.

### Penetration test: 29 of 29 checks passed on the final code

No exploitable weakness was found by the script. Covered:

- **Authentication (6):** all 18 authenticated routes refuse a missing token; malformed and tampered bearer values; session replay with a reused nonce; stale and future timestamps; signatures from another account or device; bit-flipped, truncated and empty signatures.
- **Authorization (6):** account B cannot read, revoke, remove, overwrite or key-wrap anything of account A; cannot use A's enrollment token; a revoked device's token and new sessions both fail; push notify cannot reach another account; an unsigned key wrap is refused and a device only ever receives wraps addressed to it.
- **Enrollment (4):** guessing tokens is locked out after 3 wrong tries; a token cannot be joined twice; status reveals nothing for unknown tokens; a malformed approval adds no device.
- **Input (5):** 2 MB body, bad JSON, non-object JSON and 50,000-deep nesting all give 413/400; `__proto__` and `constructor` keys did not pollute the prototype; path traversal and injection in ids; method override; out-of-range epochs and versions, and 20 parallel uploads of one object id stored once.
- **Push endpoint / SSRF (2):** 20 hostile endpoint URLs (plain http, IP literals in decimal, hex and IPv6 form, metadata address, lookalike hosts, userinfo, ports, `file:`, `gopher:`) were refused. One spelling using full-width dots is accepted because URL parsing turns it into the real push host, and the stored value is the normalised one, so it is harmless. Read-back and export never return the endpoint or keys.
- **Abuse limits, headers, disclosure, deletion (6):** spoofed `X-Forwarded-For` does not dodge the limiter; the per-device limit engages at 60 requests a minute; security headers are present on success and error responses, with no CORS header; errors carry codes only (no stack, path or banner); an unknown account and a wrong signature are indistinguishable; after deletion every old token and new session fails.

The round 2 run (after the fixes above) also passed 29 of 29. One earlier run showed ENR-1 failing. The cause was a leftover dev server from a previous run whose limiter bucket was already used, not the service; a clean server passed 28 of 28.

Not tested: TLS and the hosting layer, the push transport, timing side channels, business-logic abuse that needs a human, and anything on the browser extension.

### Fuzzing: 18 properties, 732,100 generated cases, 0 failing on the final code

| Target | Cases | Property |
| --- | --- | --- |
| HTTP handler, 21 routes, caller authenticated or not | 200,000 | Never a 500; always JSON; no stack text; Object.prototype unchanged; the shared caller is still authenticated afterwards. Status mix reached 200, 201, 400, 401, 404, 409 and 429 (about 34k successes and 6k creations). |
| Allow-list and envelope validators (4 properties) | 160,000 | Only return or throw `AllowListError`; mutated valid records; label check never accepts URLs, e-mail, credentials, IPv4 or control characters. |
| Crypto (7 properties) | 140,600 | Seal/open round trip; any change to ciphertext, nonce, bound ids or key fails to open; `unpad` is bounds-safe; `verify` never throws; bad backup blobs are rejected; wrap/unwrap binding; enrollment tags differ with the secret. Backup and wrap properties ran 300 cases each because the key derivation is slow. |
| Push validators | 140,000 | Anything accepted is https, has no credentials or port, and a host that is an allowed push host or subdomain. |
| Sync client against a hostile service | 10,000 | `sync`, `pull`, `listDevices` and `rotateKey` fail only with known error types; stored state stays loadable. |
| Ledger merge | 1,500 | Same effective ledger for any order of the same records, and when applied twice. |
| Companion renderer and service worker | 80,000 | Only allowed tags and attributes; any push payload (including `__proto__` and markup) shows one of two fixed notifications. |

**Fuzzing found two real defects, both fixed:** FZ-1, a malformed service reply (for example a key-wrap list that is not an array) crashed the client with a `TypeError`; FZ-2, an object whose sequence number is not a positive integer would set the pull cursor to a bad value and hide every later object. Replies are now validated and reported as ordinary failures, with regression tests. Limits: the generators are mostly shape-level, so deep protocol-state bugs are not excluded; the validators were not run under a coverage-guided fuzzer.

### OWASP ZAP (round 2)

`.github/workflows/security-zap.yml` starts the service on a GitHub-hosted runner (in memory, per-address limits lifted, 60 minute sessions), mints a bearer token for a throw-away account, and runs the official ZAP container with an Automation Framework plan: import of the OpenAPI description in `security-tests/zap/openapi.yaml` (14 paths, 18 URLs), a rule that adds the token to every request, passive scan, then an active scan with the default policy. Destructive routes (account and device deletion, revocation, epoch bump) are left out of the description so the scan keeps a working account. The job fails on any High alert.

| Run | ZAP | Requests the service received | Alerts |
| --- | --- | --- | --- |
| 1 (limits as shipped) | 2.16.1 | not counted | Low: ZAP is out of date (about the scanner, not the service); Informational: session management response identified; user agent fuzzer |
| 2 (limits lifted so `/accounts`, `/session` and `/enrollments/join` are reachable) | 2.16.1 | 8,341: 200 x1,117, 201 x621, 400 x1,563, 401 x750, 404 x3,856, 503 x434 (433 accounts created) | the same three |
| 3 (image `stable`) | **2.17.0** | 8,339: 200 x1,077, 201 x808, 400 x1,536, 401 x724, 404 x3,775, 503 x419 (419 accounts created) | Informational only: session management response identified (the `/v1/enrollments` token reply, expected); user agent fuzzer |

**No Low, Medium or High finding about the service.** The 503s are `push/notify`, which the test service answers with "push unavailable" because no sender is configured.

Limits: the active scan took under a minute (small JSON API, default rules), ZAP does not understand this API's signed-challenge login so it never creates a session by itself (it uses the minted token), business-logic and cryptographic flaws are outside what a scanner finds (the fuzzing and pentest sections cover some of that), and the HTML report artifact could not be downloaded to the sandbox because the artifact host is blocked, so the figures above come from the job log and summary. The workflow keeps the full report as an artifact for 30 days.

### Load test (final code)

Single Node process, in-memory store, the load generator on the same machine (it competes for the same 4 CPUs), no network latency, 15 seconds per scenario, a 60 second soak. Numbers describe this code on this machine, not production capacity.

| Scenario | Requests/s | p50 | p99 | Result |
| --- | --- | --- | --- | --- |
| L1 shipped limits, one device, 50 connections | 8,961 | 5 ms | 11 ms | 60 accepted, 134,341 refused with 429; no errors |
| L2a read: 100 objects (about 140 KB) per call, 5 accounts | 1,789 | 26 ms | 39 ms | all 200 |
| L2b write: 1 KiB objects, 20 accounts | 7,841 | 5 ms | 11 ms | all 201 |
| L2c session: valid ECDSA signature per request | 5,890 | 3 ms | 9 ms | 40,000 sessions created; the rest were replays and correctly refused |
| L2d unauthenticated requests | 12,267 | 3 ms | 6 ms | all 401 |
| L3 soak: mixed read/write/list, 25 connections, 60 s | 2,671 | 9 ms | 17 ms | 160,214 requests, no errors or timeouts |

**Findings from the load test:**

- **LT-1 (Medium, fixed).** Every rejected, unauthenticated or write request added a permanent audit event: 137,077 after 15 seconds of one device being rate-limited, 367,652 by the end of the run, with a 30 day retention. Traffic anyone can send could therefore grow memory and, in the real store, writes without bound. Repeats of one event for one account within a minute are now folded into a counted entry, and the log is capped at 50,000. After the fix the same run holds 3 to 82 audit events. Regression tests added.
- **LT-2 (Low, open).** The rate-limit table keeps one entry per client address until the hourly clean-up: 88,419 entries after about 88,000 distinct addresses, and sessions live until their 15 minute expiry. Memory stayed near 376 MB RSS in that run, so this is bounded but real; an attacker with many addresses could grow it between clean-ups.
- Memory in the soak rose from 178 MB to 235 MB RSS while 40,050 objects (about 56 MB of ciphertext) were stored, then levelled; this matches stored data, not a leak, but 60 seconds cannot rule out a slow leak. The 72 hour soak that Phase 6 requires has not been run.
- The shipped limit of 60 requests a minute per device is far below what the process can serve; it works as designed. The limit is also well below what a busy client would need if a sync flush sent many batches, which is a product tuning question, not a security one.

Not tested: production hosting (Workers/D1), multi-instance behaviour (limits are per process), real networks, a realistic user population, and anything beyond 60 seconds.

## Soak test in a cloud browser (round 2)

The Phase 6.1 release candidate needs a 72 hour soak. [scripts/soak/](../../../../scripts/soak/README.md) runs the real extension in a real Chromium on GitHub-hosted runners (`.github/workflows/soak.yml`), against a fixture provider with seeded, injected faults: network offline, rate limiting, signed-out session, provider tab closed, changed response format, extension service worker stopped, and full browser restarts. Every 30 seconds it reads the extension's stored refresh state (without triggering a refresh) and records whether the reading is fresh, stale with a reason, or stale with none. A long run is chained in legs of up to 5.5 hours (the hosted-runner limit is 6); each leg reopens the previous leg's browser profile, so a leg boundary is also a browser restart.

**Why GitHub-hosted runners:** no new account or secret, already part of this repository's CI, loads an unpacked extension. Browser-as-a-service products (BrowserStack, LambdaTest, Sauce Labs, Browserbase) cap sessions at hours, need accounts and secrets, and are built to drive pages rather than keep an installed extension's service worker alive.

**What it proves and what it does not.** It proves the extension's scheduling, recovery and persistence paths in a real browser over real elapsed time. It does not use real providers, so it is not the Phase 0 beta-cohort measurement (real signed-in accounts cannot be put on a CI runner and should not be). Only the ChatGPT collector path is exercised.

| Run | Shape | Faults injected | Fresh (all / no fault) | Longest stale | Unexplained stale | Slowest recovery |
| --- | --- | --- | --- | --- | --- | --- |
| A: PR check, run 6 | 1 leg, 39.6 min, 80 samples, 21 provider requests | tab closed x2, browser restart x1 | 98.8% / 97.8% | 0.5 min | 0 | 0.1 min after a fault; 0 min after the restart |
| B: manual run, 3 legs x 20 min | 64.9 min, 120 samples, 3 browser starts, 40 provider requests | tab closed x4, browser restart x1 | 99.2% / 98.5% | 0.5 min | 0 | 2 min after a fault; 0 min after the restart |
| C: manual run, 3 legs x 60 min, all seven fault kinds | 183.5 min, 360 samples, 3 browser starts, 98 provider requests | 15: offline x3; tab closed, browser restart, signed out, worker stopped, rate limited, schema changed x2 each | 95.3% / 99.3% | 10.5 min | 1.5 min (none outside a fault window) | 0.1 min after restarts and worker stops; 0.1 to 2.1 min after offline, tab closed, signed out and schema change; **13.1 min after one rate-limit window** |

Run B proves the hand-over: legs 1 and 2 restored the previous leg's profile and carried on, and the aggregate job joined all three. Run C covered every fault kind twice or more across three browser starts and two worker stops. What it showed: restarts and worker stops recovered within 0.1 minute; network restoration within 1.1 minutes; the longest stale interval (10.5 minutes) fell inside a rate-limit window and was explained; and no stale interval without a recorded cause lasted longer than 1.5 minutes. **One recovery was slow: 13.1 minutes after a rate-limit window ended.** That is the documented backoff for `rate_limited` (2 minute base, 30 minute cap, and tab events do not bypass it), so it is by design and not a breach of the Phase 0 criterion, which is about startup and network restoration (both well inside 10 minutes); it is worth the extension owner's attention because a provider that stops rate limiting can still leave the user with an old reading for up to 30 minutes. The first stale sample in runs A and B is the very first one, at install: the first refresh runs before the provider tab exists and is recorded as `auth_expired` (not `provider_tab_missing`), then recovers on the tab's first navigation. Cosmetic, noted for the extension owner.

Harness bugs found by the first cloud runs and fixed: the browser profile directory was hidden and so not uploaded; a single downloaded artifact lands directly in the target directory while several land in sub-directories (the report job now finds legs either way); the report step hid failures behind a pipe; sampling had no timeout. A local sandbox run also showed `stats_read` refreshes about once a minute while a provider page is open, which is how the real extension behaves with a page open.

**The 72 hour run was not started.** It costs about 4,300 runner minutes (free on a public repository, billable on a private one) and runs for three days. To run it, open Actions, choose "Browser soak", Run workflow, with `total_hours` 72, or `gh workflow run soak.yml -f total_hours=72` (it can be started from any branch that contains the workflow; the multi-leg runs above were started from this PR's branch). The result is the `soak-report` artifact and the job summary. Pass criteria to apply: no unexplained stale interval above 15 minutes and recovery within 10 minutes of a restart or network restoration.

## Not covered

External review, a manual penetration test or a Burp run of a deployed service, coverage-guided fuzzing, load and soak tests on the production stack, the 72 hour soak (harness proven, run not started), the Phase 0 real-provider soak, the push transport, the production service and storage, hosting account security, the browser extension's sync UI, and real-device companion behaviour. Timing side channels in the client were not examined.

## For the owner

1. Decide whether this AI-assisted review is accepted for the Phase 3 item, or an external reviewer is still engaged. Record it in `decision.md` (not created here).
2. Decide on the open items CR-3, CR-4, CR-5, CR-7, CR-8 and R8-R10 (fix before release, or accept with a date).
3. Merge the PR. It is a human-gate PR (it adds gate evidence), so auto-merge is off.

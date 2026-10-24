# Phase 3 security review: encrypted sync and companion

Operation key: `2026-10-10.1/phase-3-security-review`. Branch: `security/p3-sync-review`. Review base `da98520` (before prompt 3.2), reviewed at `042568` (head of `develop`), fixes at the head of this branch.

## Read this first: what this is and is not

**This is an AI-assisted self-review, not an independent audit.** It was produced by the `security-review` and `code-review` skills of Claude Code, plus a manual read of the code by the same agent that works in this repository. It does not satisfy the "independent reviewer" item in [DEFERRED_GATES.md](../DEFERRED_GATES.md) unless the owner decides it does. No penetration test, fuzzing, or live-service test was run. The sync feature must still be described as **"not independently audited"**. The owner's decision belongs in `decision.md`, which this change does not write.

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
| CR-3 | Medium | `/enrollments/status` deletes the enrollment on the first approved read; if that response is lost the new device is registered but cannot finish. (The epoch mismatch part is fixed: the approver now sends the epoch it wrapped for.) | **Open** |
| CR-4 | Medium | Rotation bumps the server epoch before every wrap is distributed; a crash midway leaves the epoch ahead of the keys and a retry is refused. | **Open** |
| CR-5 | Low | A retried upload whose first attempt succeeded records a different ciphertext hash, so receivers warn `chain_fork` falsely. | **Open** |
| CR-7 | Medium | A device enrolled after a rotation holds only the current key, so earlier history is undecryptable on it. | **Open** |
| CR-8 | Low | Records pulled from peers are not checked for content-derived ids (`strictIds` exists but is off). Needs an enrolled hostile device (T7). Turning it on breaks the existing test data, which uses arbitrary ids. | **Open** |

### What the fixes do

- **SR-1, SR-4, SR-5** (`client.ts`, `crypto.ts`, `handler.ts`): the enrollment code now carries a random confirmation secret that is never sent to the service. The joining device sends a MAC of its keys under it; the approving device refuses keys whose MAC does not verify, and wraps for exactly the key it verified. The account-key wrap is bound to a tag derived from the secret, so the joiner rejects a wrap the service made. The SAS stays as a user-visible second check. Codes from older clients (two parts) are refused. The server validates the approve body before registering the device and prunes expired enrollments.
- **SR-2** (`distribute`): wraps go only to pinned keys: the other side's key from enrollment, keys published inside the encrypted device list (`DeviceEntry.encPublic`, written by `nameDevice`), and nothing else. Other devices are skipped and listed by `unverifiedDevices()`. A device this client revoked is unpinned and never re-pinned, even if the service lists it as active.
- **SR-3** (`collectKeys`): a wrap opens only with a tag derived from the previous epoch's key, so only an account-key holder can make one. Wraps are applied in epoch order; a wrap with no previous key is refused.
- **CR-1, CR-2, CR-6:** `sync()` collects keys before uploading; skipped objects are remembered with their epoch and applied when the key arrives; the later of two pending writes from one device wins.

## Residual risks and limits (accepted by this review, owner to confirm)

| ID | Risk |
| --- | --- |
| R8 | A **revoked device together with the service** can still forge a wrap for the next epoch, because the tag proves only that the maker held the previous key, which the revoked device did. Closing it needs per-device signatures on wraps. Applies to a stolen device whose holder also controls the service. |
| R9 | Devices other than the one that performed a revocation learn it from the service's `revoked` flag. A lying service can make them wrap a new key to a revoked device. |
| R10 | A device not yet pinned (third device that has not run `nameDevice`) is skipped at rotation until it publishes its key; it must publish or re-enroll. There is no automatic publish at enrollment. |
| R11 | Earlier accepted risks R1-R7 in [docs/sync/SECURITY_REVIEW.md](../../../sync/SECURITY_REVIEW.md) still stand, including R4 (push transport and VAPID custody are outside this repo) and R7 (the in-memory store is not the production store). |

## Not covered

External review, penetration test, fuzzing, load test, the push transport, the production service and storage, hosting account security, the browser extension's sync UI, and real-device companion behaviour. Timing side channels in the client were not examined.

## For the owner

1. Decide whether this AI-assisted review is accepted for the Phase 3 item, or an external reviewer is still engaged. Record it in `decision.md` (not created here).
2. Decide on the open items CR-3, CR-4, CR-5, CR-7, CR-8 and R8-R10 (fix before release, or accept with a date).
3. Merge the PR. It is a human-gate PR (it adds gate evidence), so auto-merge is off.

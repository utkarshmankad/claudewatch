# Sync test plan (design; tests are written in 3.2-3.4)

Operation key: `2026-10-10.1/prompt-3.1`. Each line names the prompt that must add the test. A test is not claimed to exist until it is in the repo.

## Privacy and schema (3.2)
- Allow-list validator rejects: prompt/response text, cookies, tokens, full URLs, emails, unknown keys, oversized strings. Fuzz with seeded PRNG (as in `src/ledger/__tests__`).
- Local-only mode: no network API is called (spy on `fetch`).
- Plaintext metadata contains only the visible-to-server fields; snapshot test of a captured request.

## Cryptography (3.2)
- Round-trip; wrong key; wrong AAD (account, object id, seq, epoch); truncated and bit-flipped ciphertext; nonce uniqueness over 100k objects; HKDF subkey separation.
- Key rotation: old epoch objects still readable by holders; revoked device cannot read epoch+1 objects.
- Recovery phrase: wrap/unwrap, wrong word, checksum failure.

## Two-device integration (3.2)
- Offline queue then flush; duplicated and reordered messages; expired session; revoked device; server unavailable with retry/backoff; incremental download with `after=seq`.
- Rollback detection: server serves shorter chain -> warning, no state loss.
- Enrollment: SAS mismatch aborts; token single-use; expiry at 10 min; lockout after 3 failures.

## Service (3.2)
- Rate limits, storage cap, retention job, audit events contain no usage content (assert on serialized events), account deletion removes all rows/objects and returns a receipt, export.

## Convergence (3.3)
- Concurrent edits, long offline periods, reset-boundary events, schema upgrade v1->v2 across mixed clients, account switch, revoked device, deletion propagation. Server sequence, not device clocks, decides order (skewed-clock fixtures). Convergence time and failure rate recorded as enum/number metrics only.
- Implemented in `src/sync/__tests__/convergence.test.ts`; rules and limits in [CONVERGENCE.md](CONVERGENCE.md).

## Companion and security validation (3.4)
- Push subscription lifecycle, quiet hours, expiry, revocation, duplicate suppression; payloads contain no usage values.
- Implemented in `src/sync/__tests__/push.test.ts` and `src/companion/__tests__/companion.test.ts`; result and accepted risks in [SECURITY_REVIEW.md](SECURITY_REVIEW.md). The review is a self-review; the independent one is deferred.
- Independent security review (authentication, encryption, storage, notification payloads, APIs, dependencies, headers, abuse limits, deletion). Critical/high findings fixed before merge; accepted lower risks listed with owner and review date.

## Evidence for the Phase 3 gate
Threat model (this PR), data-flow diagram (above), cryptographic design review (external), conflict tests (3.3), penetration-test report (external), deletion proof (3.2 receipt + test), recovery exercise (manual, owner), privacy policy update (owner). Items marked external or manual cannot be produced by this routine.

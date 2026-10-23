# ADR-0001: Cross-device sync architecture

Status: proposed (needs owner approval). Date: 2026-10-23. Operation key: `2026-10-10.1/prompt-3.1`.

## Context

Phase 3 needs opted-in users to share ledger history, preferences and alert state across devices without the operator being able to read usage, and without prompts, cookies, provider tokens, full URLs or raw account identifiers leaving a device. Recovery after device loss must exist. The extension is Manifest V3, the repo has no server code today, and adding runtime dependencies has a supply-chain cost.

## Options

| | A. Client-side E2EE with a thin ciphertext log service (recommended) | B. Server-side encryption with managed keys | C. Peer-to-peer / device-to-device only (no service) |
| --- | --- | --- | --- |
| Security | Operator and a server breach see ciphertext + metadata only. Client bugs are the main risk. | Server holds keys: a breach or insider reads everything. Fails the stated goal. | No central target. Strong. NAT/WebRTC signalling still needs a relay; offline devices cannot sync. |
| Operational cost | Small stateless API + object store per region. No key custody. | Same infra plus KMS, key policy, more compliance scope. | Lowest infra, but support burden for connectivity failures. |
| Recovery | User-held recovery phrase or encrypted backup file; operator cannot help. Loss of all devices and phrase = cloud copy lost (local ledgers re-seed). | Easiest: operator resets access. Also what makes it insecure. | If the other device is lost, nothing remains. |
| Companion alerts (3.4) when the browser is closed | Possible: service stores ciphertext and sends generic push; client decrypts on wake. | Possible, server can compute alerts. | Not possible without an always-on peer. |
| Fit with deletion | Straightforward: delete objects, rotate nothing. | Straightforward. | Per-device only; no cloud copy to delete. |
| Implementation effort | Highest of A/B (crypto, enrollment UX, rotation). | Medium. | High (WebRTC), flaky. |

## Decision

Adopt **Option A**: end-to-end encryption with client-held keys and an append-only ciphertext log service, per-region hosting, device-key authentication, a user-held recovery phrase with an optional encrypted backup file, and local-only as the default.

Sub-decisions:

1. **AEAD:** AES-256-GCM via WebCrypto, random 96-bit nonce per object, HKDF subkeys, key epoch in AAD. Rationale: no new dependency, native in extension and service worker contexts. Message count per epoch is capped well below GCM limits; rotation is forced earlier.
2. **Authentication:** per-device signing keys, no passwords.
3. **Ordering:** server-assigned sequence numbers; no device clock authority.
4. **Server shape:** stateless HTTP API over an object store; no server-side processing of payloads. Technology/vendor deferred to the owner.
5. **No server escrow, ever.**
6. **Sync is a separate module** loaded only after opt-in. Extension host permissions are added per regional origin only in 3.2, with a permissions doc update.

## Consequences

- Users who lose every device and the recovery phrase lose cloud history. This is accepted and must be explained at opt-in.
- Metadata leakage (timing, size buckets) remains and is documented.
- 3.2-3.4 carry real crypto and enrollment work and need an independent security review before the Phase 3 gate can pass.
- Server-side features that need plaintext (analytics, cross-user views) are impossible by design. Phase 4 Radar must use a separate, aggregate-only path.

## Not decided here

Hosting vendor, regions, quotas, who runs the security review. See open questions in [ARCHITECTURE.md](ARCHITECTURE.md).

# Cross-device sync: architecture and threat model (prompt 3.1)

Status: **proposed, awaiting owner approval.** Nothing in this document is implemented. Prompt 3.2 may start only after this PR is approved and merged. Operation key: `2026-10-10.1/prompt-3.1`.

Decision record: [ADR-0001](ADR-0001-sync-architecture.md). Tests to write in 3.2-3.4: [TEST_PLAN.md](TEST_PLAN.md).

## Goals and non-goals

Goals: opted-in users see consistent ledger history, preferences and quota-risk alerts across their own devices; the server can never read usage contents; local-only mode makes zero network calls.

Non-goals: sharing between users, server-side analytics on usage, syncing anything the ledger does not already hold, a recovery path that lets the operator read data.

## What may leave a device

Only the fields of ledger schema v1 ([../LEDGER.md](../LEDGER.md)) and the preference keys listed below, always inside an encrypted envelope.

| Synced (inside ciphertext) | Notes |
| --- | --- |
| Ledger records: `kind`, `provider`, `accountAlias`, `devicePseudonym`, `observedAt`, `source`, `confidence`, `measurementMethod`, `measures`, `window`, `supersedes`, `correctionReason`, `reconciliation`, `id` | `accountAlias` is the user's label, never a raw identifier. |
| Preferences: alert frequency, per-provider mute, quiet hours, experiment opt-in, plan label | Enumerated allow-list; unknown keys are rejected on both ends. |
| Device list entry: device pseudonym, user-chosen device name, created/last-seen coarse time | Name is user text, encrypted. |

| Visible to the server (plaintext metadata) | Why |
| --- | --- |
| Opaque account id (random 128-bit, server-issued) | Routing, rate limits, deletion |
| Opaque device id (random), enrollment time, revoked flag | Revocation, session binding |
| Object id (random), sequence number, schema version, ciphertext length bucket, server receive time | Incremental download, rollback detection |
| Push endpoint, push keys, alert kinds, optional quiet hours with UTC offset (3.4, opt-in) | Delivery and suppression while clients sleep. Payload is generic; the client fetches content after wake. See [COMPANION.md](COMPANION.md). |

**Prohibited, enforced by an allow-list validator before encryption and by a CI test:** prompts, responses, conversation titles, cookies, session or provider tokens, API keys, full URLs (host-only is not synced either), raw account identifiers or emails, IP addresses stored with records, and any free-text field not listed above.

## Components

```
 Device A (extension)          Sync service (stateless API + object store)        Device B
 ledger -> allow-list -> AEAD  --- PUT /v1/objects (ciphertext, seq) --->  store   <--- GET ?after=seq ---  AEAD -> merge
 keys in chrome.storage.local  <-- GET /v1/objects?after=seq ----------
 (wrapped by recovery key)     auth: per-device Ed25519 signed requests, short-lived session token
```

- **Client** owns all cryptography, allow-listing and merging. The service is a dumb, append-only ciphertext log per account.
- **Service** authenticates devices, enforces quotas and retention, stores ciphertext, emits audit events with no usage content. Hosted per region (see Regional hosting).
- **Local-only mode** is the default. The sync module is not imported until the user opts in, and a unit test asserts no `fetch`/`WebSocket` call occurs in local-only mode.

## Keys

- **Account key (AK):** 256-bit random, generated on the first device with WebCrypto. Never leaves devices in plaintext. Derives per-purpose subkeys with HKDF-SHA-256 (`payload`, `metadata-mac`, `device-list`).
- **Payload encryption:** XChaCha20-Poly1305 or AES-256-GCM with random 96/192-bit nonces; additional authenticated data = account id, object id, sequence number, schema version. Decision in the ADR picks AES-256-GCM (WebCrypto native, no new dependency) with a per-object random nonce and a message limit per key epoch.
- **Device keys:** each device generates an Ed25519 (or ECDSA P-256 fallback) signing key; the private key is non-extractable where WebCrypto allows. The public key is registered at enrollment.
- **Key epochs:** AK changes only on rotation or device revocation. Each object records its epoch number (plaintext metadata). Old epochs stay decryptable by devices that hold them.
- **Storage:** `chrome.storage.local` holds wrapped keys. It is not encrypted at rest by the browser; the threat model treats a malware-compromised device as out of scope (see below). Keys are never in `chrome.storage.sync` (it replicates through the browser vendor).

## Enrollment

1. Device A opts in, generates AK and its device key, and creates an account (server issues random account id; proof of device key possession).
2. Device A shows an enrollment code: a one-time, 10-minute, single-use token, Device A's public key and a random confirmation secret, presented as a QR code or typed code. The secret never goes to the service; the code travels out of band.
3. Device B scans or types it, generates its device key and an ephemeral X25519 key, and sends its public keys to the service bound to the token, with a MAC of those keys under the confirmation secret. Device A refuses keys whose MAC does not verify, so a service cannot swap them (a 6 digit SAS alone can be ground down in about 2^20 key generations).
4. Both devices display a short authentication string derived from both public keys; the user confirms they match (blocks a server or network MITM).
5. Device A wraps AK to Device B's key, binding the wrap to a tag derived from the secret, and posts the ciphertext; the service deletes the token. Device B opens it only if the tag matches, stores AK, registers, and pins Device A's key. Device A pins Device B's key.
6. Later key rotations are wrapped only to pinned keys (or keys a device published inside the encrypted device list), and a wrap opens only if it was made by a holder of the previous epoch's key. The service-supplied device list is never trusted on its own.

Rate limit: 5 enrollment attempts per account per hour; a token is invalidated after 3 wrong attempts.

## Authentication

Per-device signed requests (method, path, body hash, timestamp, nonce) exchanged for a 15-minute session token. Tokens are bound to the device id. Revocation sets a flag checked on every request. There is no password. Account takeover therefore requires a device key or a recovery key (below).

## Recovery

A first-class feature because losing the last device otherwise loses the history.

- **Recovery key:** 24-word phrase (or 256-bit base32) derived from AK; shown once at opt-in, user must re-enter 3 random words to confirm. It can re-wrap AK onto a new device and re-register it.
- **No server escrow.** The operator cannot recover data. Losing all devices and the recovery key means the cloud copy is unreadable; local ledgers on surviving devices re-seed a new account.
- **Optional device-held backup:** exported encrypted file (user passphrase, Argon2id or PBKDF2-600k as WebCrypto allows) for users who will not keep the phrase.

## Conflicts and ordering (summary; implementation is 3.3)

Server assigns a per-account monotonic sequence number, so device clocks never decide order. Ledger records are append-only and content-addressed (`id`), so merge is set union plus the existing correction rules. Preferences use per-key last-writer-wins on `(sequence, device pseudonym)`. Irreconcilable preference conflicts are surfaced to the user, not dropped.

## Threat model

Assumed attacker capabilities listed per threat. "Out of scope" items are stated, not ignored.

| # | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| T1 | **Server compromise / curious operator** reads data | Everything sensitive is client-side AEAD; server holds only ciphertext and the metadata table above. Keys never sent. | Metadata (sizes, timing, object counts, account lifetime) visible. Length bucketing (pad to 1 KiB multiples) reduces size leakage. |
| T2 | **Metadata leakage** (activity timing reveals usage patterns) | Batched, jittered uploads (default 15 min); length padding; no per-record objects; audit events exclude contents. | Coarse activity cadence still observable. Documented to users. |
| T3 | **Replay** of old ciphertext or requests | AAD binds account, object id, sequence, epoch; request nonce + timestamp window (±2 min) rejected if seen; objects with already-applied ids are ignored (ledger ids are idempotent). | None expected. |
| T4 | **Rollback / withholding** (server hides recent objects or serves an old state) | Clients keep the highest sequence seen and a hash chain (`prev_hash` inside ciphertext of each batch); a shorter or forked chain raises a visible warning. | Server can still delay delivery; detection requires another device to have seen later state. |
| T5 | **Device loss/theft** | User revokes the device from another device or via recovery key; revocation bumps the key epoch and rotates AK for remaining devices; session tokens die within 15 min. | Data already on the lost device stays readable to whoever unlocks the browser profile. |
| T6 | **Account takeover** | No passwords to phish. Needs a device key or recovery key. Enrollment needs the SAS confirmation. New-device enrollment notifies all existing devices. | Social-engineering the user into confirming a SAS or revealing the phrase. |
| T7 | **Malicious/compromised device** | Out of scope for confidentiality of that user's data; revocation and rotation limit future exposure. Allow-list validator limits what a buggy client can upload. | Accepted. |
| T8 | **Ciphertext tampering** | AEAD authentication; invalid objects are skipped, counted and surfaced, never partially applied. | DoS by corrupting own account is possible only with a device key. |
| T9 | **Abuse** (storage fill, enumeration, flood) | Per-account storage cap (default 25 MB), per-device rate limits (60 req/min, 1 MB body), account ids are random so no enumeration; enrollment limits above; free-tier account cap per IP /24 hashed with a rotating salt, not stored. | IP-derived signals are kept in memory only for the rate-limit window. |
| T10 | **Phishing of a fake sync service** | Service origin pinned in the extension build; a config change requires a new release; no remote URL override. | Self-hosting needs a rebuilt extension. |
| T11 | **Supply chain** | No new runtime dependency unless the ADR names it; lockfile audit in CI (`npm audit --omit=dev --audit-level=high`). | Existing risk. |
| T12 | **Deletion not honoured** | See Deletion. | Backups (below) expire within a bounded window. |

## Deletion and retention

- **Account deletion** (from any device): signed request deletes all objects, device records, tokens, push subscriptions; the service returns a deletion receipt (account id hash, timestamp, object count). Backups are encrypted with a service key and expire within **35 days**; the receipt states this. Deletion propagates to other devices (they see a `deleted` response, wipe cloud state, and fall back to local-only after a prompt).
- **Local-only switch:** turning sync off keeps the local ledger and asks whether to delete the cloud copy.
- **Retention:** objects older than the ledger's 90-day window are dropped by the service on a daily job; clients also prune. Inactive accounts (no device contact for 180 days) are warned at 150 days, then deleted.
- **Audit events:** `account_created`, `device_enrolled`, `device_revoked`, `objects_written(count, bytes bucket)`, `account_deleted`, `auth_failed`, `rate_limited`. They contain opaque ids and counts only, retained 30 days.
- **Export:** an authenticated device can download its ciphertext plus a locally decrypted JSON.

## Regional hosting

Accounts are pinned to a region (EU, US) at creation; the choice is stored with the account and cannot silently change. Data never replicates across regions. Default region is chosen from the user's explicit selection, not from IP. Extension host permissions list each regional API origin explicitly; no wildcard. Availability targets and the hosting vendor are **open questions for the owner** (below), because they involve accounts and spend that this routine cannot decide.

## Minimum synchronized schema

Defined as the allow-list tables above. Versioned as `sync-envelope.v1`: `{ v, epoch, seq, kind: 'ledger_batch'|'prefs'|'devices', prev_hash, items[] }` encrypted as one blob; metadata outside the blob is limited to the visible table. A schema change bumps `v`; clients refuse newer-than-known versions, mirroring `migrateRecord`.

## Observability (without content)

Client: sync state, last successful sync time, failure counts by enum reason, convergence time. Server: request counts, error codes, queue age, storage per account bucket. None of these carry usage values.

## Owner decisions (2026-10-23)

Answers to the former open questions, chosen for least cost while keeping a hosted server. Item 3 is a placeholder ceiling, not a measured number.

1. **Hosting:** a single free-tier serverless provider (Cloudflare Workers with D1/R2 as the default), in an account held by the owner. The routine holds no production secrets; deployment is an owner step. Regional pinning (EU, US) stays as designed, using whatever jurisdiction controls the free tier offers; if the free tier cannot pin a region, launch with one region and say so.
2. **Recovery:** the exported-backup alternative is required; no recovery phrase. Losing the key loses cloud data but never local data, and the UI says so plainly.
3. **Storage budget:** 5 MB per account ceiling (placeholder until measured against the free-tier limits).
4. **Security review:** self-review against a public checklist plus the automated CodeQL and `npm audit` checks. Releases are labelled "not independently audited". This is recorded as a deferred item in `gates/DEFERRED_GATES.md`, not a gate pass.
5. **Host permissions:** none at install. The sync origin is requested as an optional permission only when the user turns sync on.

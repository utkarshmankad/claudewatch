# Sync service: local development and production configuration (prompt 3.2)

Operation key: `2026-10-10.1/prompt-3.2`. Design: [ARCHITECTURE.md](ARCHITECTURE.md). Not independently audited.

## What exists in the repo

| Piece | Path |
| --- | --- |
| Crypto, allow-list, envelope (client side) | `src/sync/e2ee/` |
| Sync client (opt-in, enrollment, queue, retry, rotation, backup) | `src/sync/client/client.ts` |
| Ciphertext-log service as a `Request -> Response` handler | `src/sync/service/handler.ts` |
| In-memory store and local dev server | `src/sync/service/store.ts`, `devServer.ts` |
| Tests | `src/sync/__tests__/` |

The older `src/sync/cloudSync.ts` (env-var driven single-event push) is untouched and unrelated to this design.

## Local development

```
npm run sync:dev          # http://127.0.0.1:8787, in-memory, lost on restart
SYNC_DEV_PORT=9000 npm run sync:dev
```

Loopback only; never expose it. Integration tests run the handler in process and need no server.

## Implementation notes that differ from the design text

- AEAD additional data binds account id, object id, key epoch and schema version. The server sequence number is assigned after upload so it cannot be in the AAD; ordering and rollback are covered by the server sequence plus a per-device hash chain (`sender`, `deviceSeq`, `prev_hash`) inside the ciphertext.
- Device keys are ECDSA P-256 (signing) and ECDH P-256 (key wrapping). Node 20 and extension contexts both support them; the design allowed this fallback.
- Recovery is the encrypted backup file only (PBKDF2-SHA-256, 600k iterations, passphrase of at least 12 characters), per the owner decision of 2026-10-23. There is no recovery phrase.
- Private keys sit in the client's storage as JWK. The extension must keep them in `chrome.storage.local`, never `chrome.storage.sync`.
- Per-account ceiling is 5 MB (placeholder, not measured). Rate limits: 60 requests/min per device, 1 MB body, 5 enrollments/hour/account, 3 wrong enrollment tokens/hour per caller.
- Rate-limit keys are salted hashes held in memory only. Audit events hold opaque ids, counts and size buckets, and are pruned after 30 days.

## Production configuration (owner steps)

The routine holds no production secrets and does not deploy. Default target: Cloudflare Workers with D1 (account, device, object index) and R2 (ciphertext), in an account held by the owner.

1. Wrap `createSyncService(...).fetch` as the Worker `fetch` handler and replace `MemoryStore` with a D1/R2-backed store with the same shapes (`src/sync/service/store.ts`). **This adapter is not written yet.**
2. Region pinning: use D1 location hints/jurisdictions where the free tier offers them. If it cannot pin a region, launch with one region and say so in the UI and privacy text.
3. Schedule `runRetention()` daily (Cron Trigger).
4. Set `cf-connecting-ip` handling as the Worker default; do not log request bodies or headers.
5. Pin the service origin in the extension build and request it as an optional host permission only when the user turns sync on (owner decision 5). **Extension wiring is not done yet.**
6. Backups of the database must expire within 35 days; the deletion receipt states this.

## Honest limits

- Not independently audited; the deferred review is recorded in `gates/DEFERRED_GATES.md`.
- Metadata (timing, size buckets, object counts) is visible to the operator.
- A compromised device can read everything it holds.

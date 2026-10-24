# Multi-device identity and convergence (prompt 3.3)

Implements the "Conflicts and ordering" section of [ARCHITECTURE.md](ARCHITECTURE.md). Code: `src/sync/convergence/`, wired into `src/sync/client/client.ts`.

## Rules

| Data | Merge rule | Who decides |
| --- | --- | --- |
| Ledger records | Set union keyed by `id`. Append-only; commutative, associative, idempotent. | Nobody; order of arrival does not matter. |
| Event ids | `sha256(canonical JSON of the record without id)`, first 32 hex characters. A record queued without an id gets this id. | Content. |
| Id collision (same id, different content) | The lower content hash is kept on every device; the collision is listed in `conflicts().ledger`. | Content hash, then the user. |
| Corrections (`supersedes`) | One correction replaces its target. Two different corrections of one record keep all three visible and list a `competing_correction`. | The user. |
| Preferences | Last-writer-wins register per key, ordered by the server's object sequence. | Server sequence. |
| Concurrent preference writes | Each write carries `baseSeq`, the highest sequence its device had applied. Two writes by different devices, each unaware of the other, with different values, are a conflict. The later-sequenced value is shown; the other is kept in `conflicts().prefs`. | Server sequence shows a value; the user settles it. |
| Resolution | `resolvePrefConflict(key, 'winner' or 'loser')` writes a new value with `baseSeq` at or above both sides, which closes the conflict on every device. | The user. |
| Reset boundaries | Reset reports for the same provider, alias and window type within 5 minutes form one boundary (`resetBoundaries`). Records stay append-only; boundaries are a view. | Earliest report anchors the cluster. |
| Device names | Each device publishes its own entry (`devices` envelope). Merge: highest sequence wins the name, earliest `createdDay`, latest `lastSeenDay`. | Server sequence. |

Device clocks are never compared to decide which value wins. `observedAt` and `lastSeenDay` are labels. The service additionally rejects session requests more than 2 minutes off its own clock, so skew beyond that stops the device before it can write.

## Identities

- **Device identity:** the service's opaque random `deviceId` (envelope `sender`) and a random per-device `devicePseudonym` generated at enrollment. Records carry only the pseudonym.
- **Account alias:** `acct-` plus 12 hex characters of `sha256(provider | lowercased account id)`. Identical on every device, so one provider account never splits in two, and the raw identifier is neither stored nor uploaded. The alias travels only inside the encrypted payload. A low-entropy raw identifier (an email address) could be guessed by someone who already holds the account key, which is outside the threat model.
- **Account switch:** `disable()` wipes sync state; enabling again creates a new cloud account, and nothing from the previous account is pulled or pushed.

## Device management (client API)

`nameDevice(name)` (own device only, checked by the allow-list), `inspectDevices()` (service list joined with published names), `revokeDevice(id)` (rotates the key), `removeDevice(id)` (new `DELETE /v1/devices/:id`; only after revocation, never the caller), `freshness()`.

`freshness()` keeps two ideas apart: `localChangeAt` (this device last changed something) and `cloudSyncedAt` (last successful exchange), plus a state of `local_only`, `never_synced`, `pending_upload` or `in_sync`.

## Schema upgrades

An envelope with `v` greater than 1 is not corrupt. The client counts it (`held`, `heldForUpgrade`), adds the `newer_schema` warning, remembers its sequence, and keeps processing later objects. After an upgrade, `replayHeld()` fetches and applies those objects. `baseSeq` is an optional envelope field: 3.2 senders omit it and their writes are treated as sequential (no spurious conflicts). A 3.2 receiver would reject an envelope carrying `baseSeq` as having an unknown key; nothing is deployed yet (`SYNC_ORIGIN` is null), so both ship together. State saved by 3.2 loads with the new fields defaulted.

## Deletion

Account deletion by any device makes the next request on every other device return 410; that device wipes its sync state and falls back to local-only (covered by a test).

## Metrics (numbers only)

`metrics()` returns `syncAttempts`, `syncFailures`, `uploads`, `lastUploadLatencyMs` (queued to accepted), `lastConvergenceMs` (oldest queued change to caught up with the log) and `heldForUpgrade`. No content, ids or names. Failure counts by reason are in `status().failures`. Failure rate is `syncFailures / syncAttempts`.

## Measured in tests

Three devices with clocks skewed by plus and minus 90 seconds, random offline edits over six rounds, then two sync passes: identical record sets, identical preferences, identical open-conflict keys. See `src/sync/__tests__/convergence.test.ts`.

## Not done

- No extension UI for device management or the freshness display. The sync client is still not bundled into the extension (no build step; see [DEPLOYMENT.md](DEPLOYMENT.md)), so a screen would have nothing to call. Needs the bundling decision first.
- Convergence time and failure rate are measured on an in-memory service in tests. Real-network figures need a deployed service and beta devices (final gate).
- Renaming another device's entry is not supported; each device names itself.
- Deletion propagation is tested end to end only against the in-memory service.

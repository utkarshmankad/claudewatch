# Sync and companion security review (prompt 3.4)

Operation key: `2026-10-10.1/prompt-3.4`. Review date: 2026-10-24. Scope: `src/sync/**`, `src/companion/**`, `companion/**` at the head of branch `feature/p3-companion-alerts`.

**This is a self-review, not an independent audit.** Owner decision 4 (2026-10-23) replaced the independent review with a public checklist plus CodeQL and `npm audit`; the independent review stays a deferred item in [gates/DEFERRED_GATES.md](../product-hunt/gates/DEFERRED_GATES.md) and is not claimed here. Releases must say "not independently audited". No penetration test was run. The review read the code and ran the automated checks below; it cannot find what it did not think to look for.

**Update 2026-10-24:** a second, broader review of the merged Phase 3 code (an active-service threat model) found and fixed enrollment and key-distribution flaws this review missed. See [gates/phase-3/security-review.md](../product-hunt/gates/phase-3/security-review.md). Still not independently audited.

## Method

- Walked the threat table in [ARCHITECTURE.md](ARCHITECTURE.md) against the implementation, area by area (table below).
- Wrote a failing test for each finding before the fix where the behaviour was testable.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities at review time. CodeQL runs in CI on the PR; its result is on the PR, not asserted here.
- Severity scale: critical/high = remote or cross-account compromise of data or authority, or a bypass of a stated guarantee; medium = bounded availability or privacy weakness; low = hardening.

## Result

**Critical: 0. High: 0.** Three medium/low findings were found and fixed in this PR. Seven lower-severity risks are accepted below.

## Checklist by area

| Area | Checked | Outcome |
| --- | --- | --- |
| Authentication | Every `/v1/push/*` route sits behind the device-session check; unauthenticated calls return 401 (test). Revoked devices lose their subscription and session. A caller cannot subscribe or revoke on behalf of another device (routes act on the session's device only). | OK |
| Encryption | Push payload contains a kind only, no usage values (test asserts on the exact string). The sync payload encryption is unchanged from 3.2. The push transport must apply RFC 8291 encryption; the repo ships no transport. | OK in scope; transport is an owner step (R4) |
| Storage | Service: endpoint, keys and plaintext quiet hours per device, removed on revoke, remove, expiry, account deletion. Companion: view model in IndexedDB on the user's own device, plaintext (R3). No `localStorage`, cookies or credentials in page or worker (test). | OK with R3 |
| Notification payloads | Fixed text per kind in the worker; unknown, malformed and prototype-key payloads fall back to generic text (test); payload fields are never echoed. | OK |
| APIs | Input validation on every push field (host allow-list, https only, no userinfo/port/IP literal, key charset and length, quiet-hour ranges, kind enum, hex-only dedupe key). Endpoint is stored in normalised form. Outbound calls go only to allow-listed push hosts (SSRF control). | OK |
| Dependencies | No new runtime dependency. `npm audit` clean. Service worker and page use no third-party code. | OK |
| Headers | API: CSP `default-src 'none'; frame-ancestors 'none'`, HSTS, nosniff, no-store, no-referrer, CORP same-origin (F2). Companion: meta CSP plus `companion/_headers` (frame-ancestors, HSTS, Permissions-Policy, COOP); the two CSPs are asserted equal in a test. | OK after F2 |
| Abuse limits | Notify 30/hour/account, 12 pushes/hour/device, 6 hour duplicate window, 1 MB bodies, existing per-device and per-IP limits. Rate-limit memory is bounded (F1). Client-chosen IP buckets are closed (F3). | OK after F1, F3 |
| Deletion | Account deletion removes subscriptions; the receipt reports `pushSubscriptionCount` (test). Audit events hold no endpoints or keys (test). Backups expire within 35 days (unchanged). | OK |

## Findings fixed in this PR

| ID | Severity | Finding | Fix | Test |
| --- | --- | --- | --- | --- |
| F1 | Medium | The in-memory rate-limit table was never pruned. An attacker rotating `X-Forwarded-For` could grow it for the life of a long-running Node process (availability). | `runRetention()` drops windows older than an hour; `rateLimitEntries()` exposes the size. | `prunes expired rate-limit windows` |
| F2 | Low | API responses lacked HSTS, `frame-ancestors` and CORP. | Headers added to every response. | `sends strict transport and framing headers` |
| F3 | Low | `X-Forwarded-For` was trusted when `cf-connecting-ip` was absent, so a client behind no proxy could choose its own rate-limit bucket and dodge the 3-wrong-token and account-creation limits. | Ignored unless `trustForwardedFor` is set for a proxy that overwrites the header. | `does not let a client choose its rate-limit bucket` |

## Accepted lower-severity risks

Owner for every item: the repository owner (`utkarshmankad`). Next review date: **2027-01-24**, or before any public release, whichever is first.

| ID | Risk | Why accepted | Review |
| --- | --- | --- | --- |
| R1 | A compromised enrolled device can call `notify` to spam the account's other devices (12/hour/device, 30/hour/account, generic text only). | Needs a device key; impact is annoyance; limits bound it. | 2027-01-24 |
| R2 | Quiet hours and a UTC offset are visible to the service (coarse sleep pattern). | Needed so the service can suppress while clients are asleep; devices can omit it and lose suppression only. Disclosed in COMPANION.md. | 2027-01-24 |
| R3 | The companion's view model is plaintext in IndexedDB on the user's device. | A malware-compromised or unlocked device is out of scope (threat T7). No "forget this device" button yet; disabling alerts removes the subscription but not the cached view. Should be added before release. | 2027-01-24 |
| R4 | The push transport is not in the repo, so redirect handling, payload encryption and VAPID key custody are unreviewed. | Owner supplies it with secrets this routine does not hold. **Must be reviewed before enabling push in production.** | Before deploy |
| R5 | A push endpoint is a capability URL held by the service; a service compromise lets an attacker send generic wake-ups to those devices. | Payload is generic and carries no data; the attacker already holds the ciphertext log in that scenario (threat T1). | 2027-01-24 |
| R6 | Allow-listed push hosts include whole suffixes (for example `notify.windows.com`); a takeover of a subdomain under a suffix would be a valid target. | Those domains are operated by the browser vendors; the alternative is a brittle exact list. | 2027-01-24 |
| R7 | The in-memory store and sessions are per process. A Worker deployment needs a durable store and shared rate-limit state, which are not written. | Known gap from 3.2 (DEPLOYMENT.md). Per-instance limits are weaker than global ones. | Before deploy |

## Not covered

No external review, penetration test, fuzzing of the service beyond unit tests, load test, real push-service delivery, browser-level test of the companion page against a live service, or review of the hosting account. Those remain for the final gate.

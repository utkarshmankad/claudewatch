# Companion alerts (prompt 3.4)

Operation key: `2026-10-10.1/prompt-3.4`. Design: [ARCHITECTURE.md](ARCHITECTURE.md). Security review: [SECURITY_REVIEW.md](SECURITY_REVIEW.md). Not independently audited.

The companion is an installable, static, platform-neutral web page (PWA). It shows current quotas, reset times, a recommendation summary, device health and notification settings, and it receives quota-risk and reset notifications while the browser that collects usage is closed. It never receives or shows prompt or conversation content, cookies, tokens, URLs or raw account identifiers.

## What exists

| Piece | Path |
| --- | --- |
| Push subscription lifecycle, quiet hours, duplicate suppression (service) | `src/sync/service/push.ts`, routes in `src/sync/service/handler.ts` |
| Client calls (`registerPush`, `pushStatus`, `renewPush`, `revokePush`, `notifyOthers`) | `src/sync/client/client.ts` |
| View model built only from the synced allow-list | `src/companion/viewModel.ts` |
| Which alerts a device raises, opaque dedupe keys | `src/companion/alerts.ts` |
| Renderer (view model to a text-only node tree) | `src/companion/render.ts` |
| Static shell: page, service worker, manifest, host headers | `companion/` |
| Site assembly (`dist/companion-site`) | `npm run build:companion` (part of `npm run smoke`) |
| Tests | `src/sync/__tests__/push.test.ts`, `src/companion/__tests__/companion.test.ts` |

## How an alert travels

1. A collecting device computes forecasts, calls `alertsFor()` and, for a new or materially changed risk or a reset, calls `notifyOthers({ kind, dedupeKey })`. `dedupeKey` is a truncated SHA-256 of kind, provider, account alias, window, reset time and a cooldown bucket; it is opaque to the service.
2. The service skips the caller, skips devices whose subscription is missing, expired, for another kind, inside quiet hours, or already notified for that key within 6 hours, and caps each device at 12 pushes per hour.
3. For the rest it hands `{ endpoint, keys, payload }` to the configured `PushSender`. The payload is exactly `{"v":1,"k":"quota_risk"|"reset"}`.
4. The companion service worker shows fixed text for that kind (`tag` collapses repeats). The user opens the page to see numbers, which come from the decrypted synced state, not from the push.

A 404 or 410 from the push service removes the subscription. A device revoke or remove, account deletion, and 30 days without renewal also remove it.

## Metadata the service now holds (additions to the ARCHITECTURE table)

Per subscribed device: push endpoint and keys, expiry, alert kinds, and **quiet hours with a UTC offset in plaintext**. Quiet hours must be readable by the service because it decides at send time while every client is asleep. A device that does not want the service to learn its quiet hours simply does not send them; the service then cannot suppress for it, and the companion still shows the notification. Audit events record counts only (`push_subscribed`, `push_revoked`, `push_expired`, `push_sent`, `push_suppressed`), never endpoints, keys, dedupe keys or kinds.

## Owner steps and honest limits

- **No push transport ships.** `createSyncService({ pushSender })` takes a function; without one `/v1/push/notify` answers 503. A production sender must implement Web Push (RFC 8030, VAPID RFC 8292, payload encryption RFC 8291) and **must not follow redirects**. The repo adds no dependency for this. VAPID keys are an owner secret; this routine holds none.
- **The companion page is not wired to the sync client.** Bundling `src/sync/client` for the browser needs a build step the repo does not have (same limit as the extension, see DEPLOYMENT.md). Until then the page reads its view model and `applicationServerKey` from IndexedDB, shows "Not connected" when they are absent, and offers alerts only when they exist. The view model, alert logic and service are tested in Node; the page itself is covered by static checks and the service-worker tests, not by a browser run against real push.
- **Not tested against a real push service**: delivery, quotas and iOS/Android behaviour are unmeasured. iOS requires the PWA to be installed to the home screen before push works.
- **No CORS headers** are sent by the sync API. If the companion is hosted on a different origin than the API, the owner must add an exact-origin allow list; a wildcard is not acceptable.
- **Hosting headers** in `companion/_headers` use the Cloudflare Pages/Netlify format. Another host must reproduce them.
- The companion has no separate login. Its authority is the device key held by the bundled sync client of the device it is installed on; installing it elsewhere means enrolling that device through the normal SAS flow.
- The `quiet hours` preference synced between devices (`SyncPrefs.quietHours`) has no timezone, so the client converts it to the service's `{startMinute, endMinute, utcOffsetMinutes}` form and re-registers when the offset changes. That conversion lives in the not-yet-bundled client wiring.

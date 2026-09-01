# Usage intelligence, attribution, and private sync

## Attribution model

ClaudeWatch stores metadata-only usage events in `usage_events`. An event identifies the provider, client, device, optional pseudonymous user/team, token counts, source, and confidence. Prompt and response text are not accepted by the ingestion API.

Confidence values are:

- `authoritative`: provider quota or local assistant ledger supplied the value.
- `observed`: the browser directly observed provider token fields.
- `estimated`: token counts were derived from response size.
- `inferred`: a remainder was calculated from an aggregate.

Account aggregate quota events deliberately have no fictional token count. They cannot be subtracted from observed events unless the provider supplies an authoritative token total for the same scope.

## Extension to local Core

Local sharing is disabled by default. Enable **Settings → Privacy & analytics → Share usage with local ClaudeWatch Core**. The extension posts sanitized events to `http://localhost:7734/api/events`. Optional user and team labels should be pseudonymous identifiers, not email addresses.

## Encrypted cloud sync

Cloud sync is also disabled by default and is configured only in the daemon environment:

```bash
export CLAUDEWATCH_SYNC_URL='https://your-relay.example/v1/events'
export CLAUDEWATCH_SYNC_TOKEN='receiver-auth-token'
export CLAUDEWATCH_SYNC_KEY="$(openssl rand -base64 32)"
```

The daemon removes event metadata and encrypts the remaining event client-side with AES-256-GCM. The receiver gets an envelope containing only `version`, `iv`, `tag`, and `ciphertext`. On each polling interval, the daemon also performs an authenticated `GET` and imports unseen encrypted events from an `{ "events": [...] }` response. Event IDs make cross-device imports idempotent. The encryption key must not be sent to the relay. Authentication, membership, retention, deletion, and key recovery remain responsibilities of the chosen relay deployment.

## Analytics and reports

- `GET /api/analytics?days=30&teamId=...` returns attribution, hourly activity, team rankings, reconciliation, and plan-fit guidance.
- `GET /api/report?days=30&format=csv` exports the attribution report.
- The local dashboard shows the same attribution and plan-fit summary.

These endpoints bind to localhost with the rest of ClaudeWatch Core. They are not a public team service and should not be exposed directly to the internet.

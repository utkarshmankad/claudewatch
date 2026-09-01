# Architecture review and product gap analysis

## What is implemented

### Browser extension

- Manifest V3 extension for Claude, ChatGPT, and Gemini.
- MAIN-world fetch/XHR interception and SSE parsing.
- Local per-response token estimates and 5-hour/7-day history.
- Claude plan detection, limit/reset parsing, plan comparison, popup gauges, badge, onboarding, and settings.
- Periodic authenticated Claude `/usage` snapshots from the logged-in page context. These snapshots are the authoritative quota source and include account usage from other clients and devices.
- Conversation backfill scaffolding and storage for multiple Claude organization snapshots.

### Core daemon and CLI

- Anthropic Admin Usage and Cost API clients with pagination and aggregation.
- Personal API probe mode, Claude Code JSONL watcher, and claude.ai session polling.
- SQLite schema/migrations for usage, cost, alert, personal, and session snapshots.
- Desktop/email threshold alerts, cost cache, scheduled polling, Express API, React dashboard, and CLI lifecycle/setup/health commands.
- macOS/Linux daemon installation scripts and packaged binary scaffolding.

## Critical issue and resolution

The extension previously depended on a Claude response stream or on Claude's UI making a useful API request. Its service-worker poll was not a dependable authenticated context. Therefore a fresh install could remain empty until the user sent a prompt, and locally accumulated tokens could never represent desktop or other-device activity.

The extension now makes an immediate and five-minute authenticated request from Claude's MAIN page context to:

1. `GET /api/organizations`
2. `GET /api/organizations/{orgId}/usage`

It stores the returned 5-hour/7-day utilization and reset timestamps and uses them ahead of local token estimates. A visible, signed-in Claude tab is still required because this is an undocumented first-party web API and the extension intentionally does not extract or persist browser session cookies.

This fixes cross-client **quota utilization**. It cannot recover exact per-message token counts, model attribution, or conversation provenance from another device; Anthropic does not expose that data for a personal Claude subscription. Organization API usage is a separate billing system and must not be presented as personal Claude subscription usage.

## Remaining gaps, ordered by product risk

1. **Undocumented API resilience:** add schema fixtures from sanitized live responses, response-version telemetry without personal data, exponential backoff, explicit stale/error UI, and a fallback strategy when Claude changes `/usage`.
2. **Multi-organization UX:** snapshots are retained per organization, but the popup still renders the first organization. Add active-org detection, selection, namespaced histories, and per-org badges.
3. **Browserless refresh:** a closed browser cannot refresh a browser session safely. A backend requires explicit account linking and an approved authentication design; copying session cookies is fragile and high risk.
4. **Data model clarity:** separate authoritative utilization snapshots from estimated local token events. Do not convert utilization into fictional token totals using community-estimated limits.
5. **ChatGPT/Gemini accuracy:** current stream parsing estimates local tokens but does not actively query their authoritative quota endpoints or model multiple accounts.
6. **Extension integration tests:** add Playwright/Chromium tests with mocked Claude endpoints and a loaded unpacked extension. The current smoke test validates packaging and the CLI entry point, not a real Claude login.
7. **Security hardening:** minimize broad permissions, validate all MAIN-world bridge payloads, add a strict extension CSP, redact logs, document retention, and threat-model any future sync backend.
8. **Backend/product capabilities:** account authentication, encrypted cross-device snapshot sync, retention/deletion controls, teams/RBAC, exports, forecasts, notifications, audit logs, billing, and observability are not implemented.
9. **Release engineering:** add signed extension builds, reproducible zip verification, release notes, provenance/SBOM, and Chrome Web Store deployment after CI stabilizes.

## CI and branching

CI now covers linting, strict TypeScript, unit/integration tests on Node 20 and 22, coverage floors, CLI/manifest smoke tests, web and core builds, production dependency auditing, dependency review, CodeQL, artifact retention, and Dependabot. See `docs/BRANCHING.md` for the `develop`/`main` workflow and required branch protection.

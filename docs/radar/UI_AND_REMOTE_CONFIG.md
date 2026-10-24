# Limit Change Radar: experience, notifications, remote parser config, diagnostics

Operation key: `2026-10-10.1/prompt-4.3`. Builds on `PRIVACY_AND_ARCHITECTURE.md` and `PIPELINE.md`. Nothing is deployed: there is no incident feed, no config distribution endpoint, and no contribution is sent. The dashboard panel therefore shows its empty state until a feed exists. Radar is labelled Beta.

## Radar view (`src/radar/view.ts`, `src/web/components/RadarPanel.tsx`, `GET /api/radar`)

Shows, per incident: provider, kind, affected plans and regions, first observed time, confidence (label and percent), sample band (`20-49`, `50-199`, `200+`), workaround, and resolution status (ongoing or resolved with last-observed time). A fixed disclaimer states these are aggregated observations from opted-in users, not provider announcements. Workaround text is generic per incident kind and makes no claim about cause or fix dates. Active incidents sort before resolved ones. Exact cohort sizes never reach the view.

## Notification controls (`src/radar/notify.ts`, `GET/PUT /api/radar/prefs`)

Off by default. Options: master switch, minimum confidence, providers, incident kinds, notify-on-resolved. Each incident notifies once when active and once on resolution (if enabled). Preferences are stored in `~/.claudewatch/radar-prefs.json` (mode 0600), validated by a strict allowlist. Nothing here sends data off the device. This change adds the selection logic and the settings UI; it does not yet deliver desktop notifications from a feed, because no feed exists.

## Signed remote parser configuration (`src/radar/remoteConfig.ts`)

- Content is limited to three entry kinds: `selector` (CSS over a closed character set), `field_mapping` (dotted JSON path), and `kill_switch` (`radar_contribution`, `remote_config`, `parser`, optionally per provider). Targets are a closed list (`usage_percent`, `usage_used`, `usage_limit`, `reset_time`, `plan_label`).
- The schema is closed: any unknown key is rejected. There is no field for host permissions, code, URLs or new collected fields, so a config cannot expand what the extension collects or where it can reach. The contribution allowlist stays compiled into the extension.
- Authenticity: Ed25519 signature over the exact canonical payload; trusted public keys are compiled in; keys can be revoked; payload must be canonical and at most 16 KB, 50 entries.
- Freshness: expiry required (at most 14 days), issue time cannot be in the future, version must be strictly newer than any seen (anti-rollback), and a rolled-back version can never be applied again.
- Staged rollout: `rolloutPercent` 0..100 against a stable per-install bucket (hash of a random local install id that is never sent). Raising the percentage only adds installs.
- Audit history: every apply, rejection, staged skip, rollback and expiry is recorded (time, action, version, short reason, no payload content), capped at 200.
- Instant rollback: `rollback()` works offline and immediately, returning to the previous good config or the bundled defaults. `POST /api/radar/config/rollback` exposes it.
- Not built here: the signing service, key ceremony, distribution endpoint and extension-side consumption. The extension does not read this config yet, so no behavior changes. Those need the owner's decisions (key custody, hosting) and the optional host permission described in the 4.1 design.

## Diagnostic report (`src/radar/diagnostics.ts`, `GET /api/radar/diagnostics`)

Built only from versions, boolean settings, counts of config events, and counts of parser results per provider. Every string is validated (versions must be `x.y.z`); unknown providers and results are dropped. The user sees the full JSON first and the export endpoint refuses (`400`) unless called with `reviewed=yes` after the user ticks the confirmation. Parser counts are not wired to a local source yet and are empty.

## Observability

Config audit history and the 4.2 counters hold no content or identifiers. The diagnostic report includes event counts only.

## Measured and unmeasured

Unit and route tests cover validation, signature failure modes, anti-rollback, rollout monotonicity, expiry, rollback, and report redaction. No rollback exercise, staged rollout on real installs, or notification usefulness measurement has happened; those are Phase 4 gate evidence (4.4).

## Rollback of this change

Reverting removes `src/radar/{view,notify,remoteConfig,diagnostics}.ts`, `src/daemon/radarRoutes.ts`, the dashboard panel, their tests and this document.

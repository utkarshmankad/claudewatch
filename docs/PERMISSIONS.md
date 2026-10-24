# Token Watcher extension permissions

Operation key: 2026-10-10.1/prompt-0.4

| Permission | Why it is needed | First-run explanation |
| --- | --- | --- |
| `storage` | Settings and local usage history | `permStorage*` |
| `alarms` | Scheduled refresh | `permAlarms*` |
| `notifications` | Autopilot decision alerts and the experiment's threshold alerts | `permNotifications*` |
| `tabs`, `scripting` | Find signed-in provider tabs and inject the gauge | `permTabs*` |
| `cookies` | Read the provider session cookie to call the provider's own usage endpoint | `permCookies*` |
| `idle` | Pause polling while the machine is idle | `permAlarms*` |
| Host access to claude.ai, chatgpt.com, chat.openai.com, gemini.google.com | Content scripts and usage requests | `permHosts*` |
| Optional host `http://localhost:7734/*` | Opt-in sync to local Token Watcher Core; requested at runtime from Settings | `permLocalhost*` |
| Optional host: pinned sync origin | Opt-in end-to-end encrypted sync (prompt 3.2). Requested at runtime from Settings only when the user turns sync on; no wildcard. **Not declared yet**: `SYNC_ORIGIN` in `sync-settings.js` is `null` until the owner deploys the service, so the toggle is disabled and the extension stays local-only. | `setCloudLabel`, `setCloudHint` |

Sync device keys must be kept in `chrome.storage.local`, never `chrome.storage.sync`. When `SYNC_ORIGIN` is set, add the same origin to `optional_host_permissions` in `manifest.json`.

## Optional providers (ChatGPT, Gemini)

Not moved to runtime permission requests in this change. The provider hosts are
declared both as `host_permissions` and static `content_scripts` matches, and the
background worker uses them for cookie and fetch access. Making them optional
requires replacing the static content scripts with
`chrome.scripting.registerContentScripts` after a grant, plus a grant/revoke UI and
browser-level tests of the grant flow. That cannot be verified without a real
browser profile with signed-in provider accounts, so it is left as a follow-up
rather than shipped untested. Claude hosts remain required.

## Accessibility audit notes (WCAG 2.1 AA)

- Contrast: `--text-muted` was `#44445a` (about 2.0:1 on `#0f0f12`); now `#8888a6`
  (at least 4.8:1 on every surface). Enforced by `claudewatch-extension/test/i18n.test.mjs`.
- Keyboard focus: popup and settings now have a visible `:focus-visible` ring on all
  controls (onboarding and privacy already had one).
- Screen reader: popup alert and provider-health regions are `aria-live="polite"`;
  chart tabs expose `aria-pressed`; the sparkline has an accessible name; decorative
  icons are `aria-hidden`.
- Motion: `prefers-reduced-motion` disables animations and transitions.
- Not audited: real screen-reader sessions (NVDA/VoiceOver) and brand-colour (`#6366f1`)
  text on dark surfaces (4.0 to 4.3:1); both need human review.

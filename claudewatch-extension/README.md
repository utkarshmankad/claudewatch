# Token Watcher — Browser Extension

A Chrome extension that tracks your AI token usage in real-time across **Claude**, **ChatGPT**, and **Gemini**. Automatically detects which platform you're on and monitors usage without any configuration.

## Features

- **Multi-platform support** — Claude (claude.ai), ChatGPT (chatgpt.com), and Gemini (gemini.google.com)
- **Auto site detection** — extension identifies the active AI platform and applies the right parser
- **Live usage gauge** — token count, percentage, and reset countdown for Claude's 5h window
- **Per-site breakdown** — popup shows token usage split by Claude / ChatGPT / Gemini
- **Badge on icon** — shows Claude's current window usage percentage at a glance
- **Desktop notifications** at 80%, 90%, and 95% usage (configurable)
- **Syncs with ClaudeWatch Core** for Claude history, cost tracking, and email alerts

## Loading in Chrome (Developer Mode)

1. Open **`chrome://extensions`** in Chrome.
2. Enable **Developer mode** (toggle, top-right corner).
3. Click **Load unpacked**.
4. Select this folder: `claudewatch-extension/`
5. The **TW** icon appears in the toolbar.

> **Brave / Edge:** The same steps apply. Open `brave://extensions` or `edge://extensions`.

## Supported Platforms

| Platform | URL | Token Detection |
|----------|-----|-----------------|
| Claude   | claude.ai | Exact (SSE `message_start` / `message_limit`) |
| ChatGPT  | chatgpt.com | Exact (OpenAI usage field in final SSE chunk) |
| Gemini   | gemini.google.com | Best-effort (`usageMetadata` or character approximation) |

## Usage

1. Open any of the supported AI chat sites in a tab.
2. The extension automatically starts capturing token data.
3. Click the **TW** icon in the toolbar to see the popup.
4. The **Sources** section shows per-platform token usage.
5. The **Claude Window** section shows Claude's 5h/7d gauges and plan comparison.

No API key or configuration needed for basic monitoring.

### With ClaudeWatch Core (Claude users)

Core unlocks Claude usage history, cost reports, email alerts, and the web dashboard.

```bash
# Install ClaudeWatch CLI (from the repo root)
pnpm install && pnpm build

# Start the daemon
claudewatch start
# Core listens on http://localhost:7734 by default
```

## Settings

Click **Settings ⚙** in the popup footer, or go to `chrome://extensions` → Token Watcher → Extension options.

| Setting | Default | Description |
|---------|---------|-------------|
| Enable alerts | On | Toggle all desktop notifications |
| 80% threshold | On | Early warning notification |
| 90% threshold | On | High usage notification |
| 95% threshold | On | Critical notification |

Settings sync across Chrome profiles via `chrome.storage.sync`.

## Privacy

**All data stays on your device.** The extension:

- Intercepts streaming responses only to extract token counts — it never reads message content
- Never contacts any external server or third-party analytics service
- Optionally syncs usage data to `http://localhost:7734` (your own machine, ClaudeWatch Core)
- Requires host permissions for claude.ai, chatgpt.com, and gemini.google.com only

## Supported Browsers

| Browser | Status |
|---------|--------|
| Chrome 111+ | ✅ Fully supported |
| Brave | ✅ Fully supported |
| Microsoft Edge | ✅ Fully supported |
| Firefox | ❌ Not supported (Manifest V3 differences) |
| Safari | ❌ Not supported |

Chrome 111+ is required for the `"world": "MAIN"` content script feature used by the fetch/XHR interceptor.

## Packaging for Distribution

```bash
# From the claudewatch-extension/ directory:

# Validate manifest and check all files exist
npm run validate

# Create a zip ready for Chrome Web Store upload
npm run zip
# → produces ../claudewatch-extension.zip
```

## File Structure

```
claudewatch-extension/
├── manifest.json          MV3 manifest (multi-platform host_permissions)
├── background.js          Service worker — storage, alarms, badge, Claude polling
├── interceptor.js         MAIN-world fetch/XHR interceptor (all three platforms)
├── content.js             Isolated-world postMessage bridge (document_idle)
├── lib/
│   └── parsers.mjs        Pure parser functions (testable ESM module)
├── test/
│   ├── parsers.test.mjs   Parser and site-detection unit tests
│   └── background.test.mjs Background logic unit tests
├── icons/
│   ├── icon16.png         Toolbar icon (16×16)
│   ├── icon32.png         Toolbar icon (32×32)
│   ├── icon48.png         Extensions page icon (48×48)
│   ├── icon128.png        Chrome Web Store icon (128×128)
│   └── icon128.svg        Source SVG for icon regeneration
├── popup/
│   ├── popup.html         Action popup structure
│   ├── popup.css          Dark-theme styles
│   └── popup.js           Popup logic — site breakdown, gauges, timers
├── settings/
│   ├── settings.html      Options page
│   ├── settings.css       Options page styles
│   └── settings.js        Options page logic
└── onboarding/
    ├── onboarding.html    First-install guide
    ├── onboarding.css     Onboarding styles
    └── onboarding.js      Onboarding interactions
```

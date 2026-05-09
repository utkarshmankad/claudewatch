# ClaudeWatch Browser Extension

A Chrome extension that tracks your Claude.ai session usage in real-time and syncs it to the [ClaudeWatch Core](../README.md) background daemon.

## Features

- Live session usage gauge — token count, percentage, and reset countdown
- Desktop notifications at 80%, 90%, and 95% usage (configurable)
- Badge on the extension icon shows current percentage at a glance
- Syncs usage data to ClaudeWatch Core for history, cost tracking, and email alerts
- Works without Core — monitoring continues even when Core is offline

## Loading in Chrome (Developer Mode)

1. Open **`chrome://extensions`** in Chrome.
2. Enable **Developer mode** (toggle, top-right corner).
3. Click **Load unpacked**.
4. Select this folder: `claudewatch-extension/`
5. The ClaudeWatch icon appears in the toolbar.

> **Brave / Edge:** The same steps apply. Open `brave://extensions` or `edge://extensions`.

## Usage

### Standalone (extension only)

1. Open [claude.ai](https://claude.ai) in any tab.
2. The extension reads session usage from the page automatically.
3. Click the CW icon in the toolbar to see the popup.
4. Notifications fire when your configured thresholds are crossed.

No API key or configuration needed for basic monitoring.

### With ClaudeWatch Core

Core unlocks usage history, cost reports, email alerts, and the web dashboard.

```bash
# Install ClaudeWatch CLI (from the repo root)
pnpm install && pnpm build

# Start the daemon
claudewatch start
# Core listens on http://localhost:7734 by default
```

Once Core is running, the extension syncs every 30 seconds and the popup footer shows **"Core: connected ✓"**.

The Core URL can be changed in **Extension Settings → ClaudeWatch Core**.

## Settings

Click **Settings ⚙** in the popup footer, or go to `chrome://extensions` → ClaudeWatch → Extension options.

| Setting | Default | Description |
|---------|---------|-------------|
| Enable alerts | On | Toggle all desktop notifications |
| 80% threshold | On | Early warning notification |
| 90% threshold | On | High usage notification |
| 95% threshold | On | Critical notification |
| Core URL | `http://localhost:7734` | Address of the local Core daemon |

Settings sync across Chrome profiles via `chrome.storage.sync`.

## Privacy

**All data stays on your device.** The extension:

- Reads session usage data directly from the claude.ai page (no Anthropic API calls)
- Sends usage data only to `http://localhost:7734` (your own machine, ClaudeWatch Core)
- Never contacts any external server, analytics service, or third party
- Never reads message content — only the session usage counters visible in the UI

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

The zip excludes `package.json`, `validate-manifest.js`, and any `.git` files.

## File Structure

```
claudewatch-extension/
├── manifest.json          MV3 manifest
├── background.js          Service worker — storage, Core sync, alarms, notifications
├── interceptor.js         MAIN-world fetch/XHR interceptor (runs at document_start)
├── content.js             Isolated-world DOM scraper + postMessage bridge (document_idle)
├── icons/
│   ├── icon16.png         Toolbar icon (16×16)
│   ├── icon32.png         Toolbar icon (32×32)
│   ├── icon48.png         Extensions page icon (48×48)
│   ├── icon128.png        Chrome Web Store icon (128×128)
│   └── icon128.svg        Source SVG for icon regeneration
├── popup/
│   ├── popup.html         Action popup structure
│   ├── popup.css          Dark-theme styles
│   └── popup.js           Popup logic — status rendering, timers
├── settings/
│   ├── settings.html      Options page
│   ├── settings.css       Options page styles
│   └── settings.js        Options page logic
└── onboarding/
    ├── onboarding.html    First-install guide (3 steps)
    ├── onboarding.css     Onboarding styles
    └── onboarding.js      Onboarding interactions
```

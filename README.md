# ClaudeWatch

> Know exactly how much of Claude you're using — before you hit a wall.

ClaudeWatch is a standalone Chrome extension that monitors your Claude usage in real time. No account, no API key, no backend — install it and start chatting.

---

## What it shows

**Dual usage gauges** — 5-hour window and 7-day rolling total displayed as `used / limit` (e.g. `15.4k / 44k`), colour-coded green → amber → red as you approach your plan's limit.

**Authoritative reset countdown** — the extension reads the `message_limit` event claude.ai sends after every response. That event carries the exact reset timestamp and your current utilization directly from Claude, so the countdown and percentages are always in sync with what claude.ai itself shows.

**Plan comparison table** — your current consumption mapped against Free, Pro, Max, Max 5×, and Max 20× limits side by side.

**Token history sparkline** — a mini bar chart of activity over the last 5 hours or 7 days, switchable with a tab.

**Alert banner** — surfaces automatically when claude.ai reports you are approaching or over your limit, with the reset countdown.

---

## How it works

The extension injects a small script into claude.ai's MAIN execution context. When you send a message, the script intercepts the outgoing `fetch` call and uses the browser's native `ReadableStream.tee()` to split the SSE response into two identical streams — one returned unchanged to the page, one read silently in the background.

The background reader parses claude.ai's streaming format to extract:

- **`message_limit`** — claude.ai-specific event carrying `windows["5h"].utilization`, `windows["5h"].resets_at`, and the same for `7d`. These are the authoritative values; the extension uses them directly rather than counting tokens.
- **`content_block_delta`** — text chunks used to approximate token counts when the API omits explicit usage fields.

All data stays local in `chrome.storage.local`. Nothing is sent anywhere.

---

## Installation

Works in Chrome, Brave, Edge, or any Chromium-based browser:

1. Clone this repo
2. Go to `chrome://extensions` → enable **Developer mode**
3. Click **Load unpacked** → select the `claudewatch-extension/` folder
4. Open [claude.ai](https://claude.ai) and send any message

The extension icon badge shows your 5-hour window usage percentage in real time.

---

## Stack

| Layer | Technology |
|---|---|
| Extension | MV3, vanilla JS |
| Data source | claude.ai SSE stream (`message_limit` event) |
| Storage | `chrome.storage.local` |
| Permissions | `https://claude.ai/*` only |

---

## Contributing

Contributions are welcome — bug reports, feature ideas, and pull requests alike.

### Setup

```bash
git clone https://github.com/utkarshmankad/claudewatch.git
```

No build step — edit files in `claudewatch-extension/` and reload the extension in `chrome://extensions` after each change.

### Guidelines

- Keep pull requests focused — one feature or fix per PR
- Test against a live claude.ai session before opening a PR
- Do not commit `.env` files or API keys

### Reporting issues

Open an issue on GitHub with the relevant console logs. For extension bugs, include the `[ClaudeWatch]` log lines from the claude.ai DevTools console (service worker logs are at `chrome://extensions` → ClaudeWatch → **Inspect views: service worker**).

---

## License

MIT © Utkarsh Mankad

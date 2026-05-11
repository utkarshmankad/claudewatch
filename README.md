# ClaudeWatch

> Know exactly how much of Claude you're using — before you hit a wall.

ClaudeWatch ships as two independent tools that serve different purposes. Use one or both.

| | ClaudeWatch Extension | ClaudeWatch Core |
|---|---|---|
| **What it is** | Chrome extension | Local daemon + CLI + dashboard |
| **Data source** | claude.ai live SSE stream | Anthropic Admin Usage API |
| **Requires** | Nothing — just install | Node.js 20+, Admin API key |
| **Use when** | You want instant in-browser usage visibility | You want historical analytics, spend alerts, and email notifications |

---

## ClaudeWatch Extension

A standalone Chrome extension that reads your token usage directly from claude.ai's response stream. No account, no API key, no backend — install it and it works immediately.

### What it shows

**Usage gauges** — 5-hour window and 7-day rolling total as `used / limit` (e.g. `15.4k / 44k`), colour-coded green → amber → red.

**Authoritative reset countdown** — claude.ai's `message_limit` SSE event carries your exact window reset time and current utilization. The extension reads this directly, so the countdown and percentages match what claude.ai itself shows.

**Plan comparison table** — your consumption mapped against Free, Pro, Max, Max 5×, and Max 20× limits side by side.

**Token history sparkline** — bar chart of activity over the last 5 hours or 7 days, switchable with a tab.

**Alert banner** — surfaces automatically when claude.ai reports you are approaching or over your limit.

### How it works

The extension injects a small script into claude.ai's MAIN execution context. When you send a message, it intercepts the outgoing `fetch` call and uses `ReadableStream.tee()` to split the SSE response into two identical streams — one returned unchanged to the page, one read silently in the background.

The background reader parses the stream for:
- **`message_limit`** — claude.ai event carrying `windows["5h"].utilization`, `windows["5h"].resets_at`, and the equivalent for `7d`. These are the authoritative values used for the gauges.
- **`content_block_delta`** — text chunks used to approximate token counts when the API omits explicit usage fields.

All data stays local in `chrome.storage.local`. Nothing leaves the browser.

### Installation

Chrome, Brave, Edge, or any Chromium-based browser:

1. Clone this repo
2. Go to `chrome://extensions` → enable **Developer mode**
3. Click **Load unpacked** → select the `claudewatch-extension/` folder
4. Open [claude.ai](https://claude.ai) and send any message

The extension badge shows your 5-hour usage percentage in real time.

---

## ClaudeWatch Core

A local background daemon that polls the Anthropic Admin Usage API, stores history in SQLite, fires spend alerts, and serves a web dashboard. It operates independently of the extension — useful if you want long-term tracking, threshold notifications, or programmatic access to your usage data.

### Features

- Polls the **Anthropic Admin Usage & Cost APIs** every 5 minutes
- Stores full history in a local **SQLite** database — your data never leaves your machine
- **Desktop and email alerts** when configurable spend thresholds are crossed
- **Web dashboard** on `localhost:7734` built with React + Recharts
- **CLI** (`claudewatch`) for setup, status queries, and manual inspection
- Secure API key storage via system keychain (`keytar`)

### Requirements

- Node.js 20+
- An **Anthropic Admin API key** (requires admin access on your Anthropic account)

### Getting started

```bash
git clone https://github.com/utkarshmankad/claudewatch.git
cd claudewatch
npm install
npm run build

# Store your Admin API key securely in the system keychain
npx claudewatch setup

# Start the daemon — polls every 5 min, serves dashboard on :7734
npm run daemon
```

Open `http://localhost:7734` for the web dashboard.

### Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20, TypeScript (strict) |
| CLI | Commander, Ink |
| Daemon | Express 5, node-cron |
| Storage | better-sqlite3 |
| Alerts | nodemailer, node-notifier |
| Dashboard | Vite, React 18, Recharts |
| Keychain | keytar |

---

## Contributing

Contributions are welcome — bug reports, feature ideas, and pull requests alike.

**Extension** — edit files in `claudewatch-extension/` and reload at `chrome://extensions`. No build step. Test against a live claude.ai session.

**Core** — standard Node.js workflow:

```bash
npm run dev        # watch mode
npm run web        # Vite dev server for the dashboard
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm test           # Vitest
```

### Guidelines

- Keep pull requests focused — one feature or fix per PR
- Extension changes must not introduce a Core dependency — the extension is standalone
- Run `npm run lint && npm run build` before opening a Core PR
- Do not commit `.env` files or API keys

### Reporting issues

Open an issue on GitHub with the relevant logs. For extension bugs, include the `[ClaudeWatch]` lines from the claude.ai DevTools console (service worker logs at `chrome://extensions` → ClaudeWatch → **Inspect views: service worker**).

---

## License

MIT © Utkarsh Mankad

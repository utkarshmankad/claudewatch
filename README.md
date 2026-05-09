# ClaudeWatch

> Know exactly how much of Claude you're using — before you hit a wall.

ClaudeWatch is an open-source token usage monitor for Anthropic's Claude. It ships as two complementary pieces: a **standalone Chrome extension** that works the moment you install it, and an optional **local daemon** with a CLI and web dashboard for power users who want deeper analytics, spend alerts, and email notifications.

---

## Chrome Extension

The extension requires no account, no API key, and no backend. Install it, open [claude.ai](https://claude.ai), and start chatting — that's it.

### What it shows

**Dual usage gauges** — a 5-hour rolling window and a 7-day rolling total, both colour-coded green → amber → red as you approach your plan's limit.

**Plan comparison table** — your current token consumption mapped against Free, Pro, Max, Max 5×, and Max 20× thresholds at a glance, so you can see which tier you're actually using.

**Token history sparkline** — a mini bar chart of your usage over the last 5 hours or 7 days, switchable with a tab.

**Alert banner** — appears automatically when claude.ai reports you are approaching or over your limit, with the exact reset countdown pulled from the live response stream.

**Live reset countdown** — the extension reads the `message_limit` event claude.ai sends at the end of every response, which carries the authoritative reset timestamp for your window.

### How it works

The extension injects a tiny script into claude.ai's MAIN execution context. When you send a message, the script intercepts the outgoing `fetch` call and uses the browser's native `ReadableStream.tee()` to split the response into two identical streams — one returned unchanged to the page, one read in the background. The background reader parses the Anthropic Messages streaming format (`message_start`, `content_block_delta`, `message_delta`, `message_limit`) to extract token counts and rate-limit metadata without affecting your chat experience in any way.

### Installation

Chrome, Brave, Edge, or any Chromium-based browser:

1. Clone this repo and navigate to `claudewatch-extension/`
2. Go to `chrome://extensions` → enable **Developer mode**
3. Click **Load unpacked** → select the `claudewatch-extension/` folder
4. Open [claude.ai](https://claude.ai) and send any message

The extension icon badge shows your 5-hour window usage percentage in real time.

---

## Local Daemon & CLI

For users who want spend tracking, threshold alerts, and a persistent web dashboard.

### Features

- Polls the **Anthropic Admin Usage API** every 5 minutes (respects rate limits)
- Stores usage history in a local **SQLite** database — your data never leaves your machine
- **Spend alerts** via desktop notification and/or email when configurable thresholds are crossed
- **Web dashboard** on `localhost:7734` built with React + Recharts
- **CLI** (`claudewatch`) for setup, status, and manual queries
- Secure API key storage via system keychain (`keytar`)

### Requirements

- Node.js 20+
- An **Anthropic Admin API key** (requires an Anthropic account with admin access)

### Getting started

```bash
git clone https://github.com/utkarshmankad/claudewatch.git
cd claudewatch
npm install
npm run build

# Store your Admin API key securely
npx claudewatch setup

# Start the daemon (polls usage every 5 min, serves dashboard on :7734)
npm run daemon
```

Open `http://localhost:7734` for the web dashboard.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20, TypeScript (strict) |
| CLI | Commander, Ink |
| Daemon | Express 5, node-cron |
| Storage | better-sqlite3 |
| Alerts | nodemailer, node-notifier |
| Dashboard | Vite, React 18, Recharts |
| Keychain | keytar |
| Extension | MV3, vanilla JS |

---

## Contributing

Contributions are welcome — bug reports, feature ideas, and pull requests alike.

### Setup

```bash
git clone https://github.com/utkarshmankad/claudewatch.git
cd claudewatch
npm install
```

### Development

```bash
npm run dev        # watch mode for the CLI/daemon
npm run web        # Vite dev server for the dashboard
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm test           # Vitest
```

For the extension, edit files in `claudewatch-extension/` and reload the extension in `chrome://extensions` after each change.

### Guidelines

- Keep pull requests focused — one feature or fix per PR
- Run `npm run lint && npm run build` before opening a PR; CI will fail otherwise
- Extension changes should not require the daemon — the extension must remain independently useful
- Do not commit `.env` files or API keys

### Reporting issues

Open an issue on GitHub with the relevant console logs. For extension bugs, include the output of the `[ClaudeWatch]` log lines from the claude.ai DevTools console.

---

## License

MIT © Utkarsh Mankad

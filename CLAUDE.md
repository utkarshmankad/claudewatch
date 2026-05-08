# ClaudeWatch — Anthropic Token Usage Monitor

## What this is
A local background daemon + CLI that monitors Claude API token usage
using the Anthropic Admin Usage/Cost API. Notifies users via email and 
desktop notifications when configurable spend thresholds are crossed.

## Stack
Node.js 20, TypeScript strict, commander, ink, better-sqlite3, 
node-cron, nodemailer, node-notifier, keytar, Vite+React (web dashboard)

## Key API facts
- Usage API: GET /v1/organizations/usage_report/messages (Admin key required)
- Cost API: GET /v1/organizations/cost_report (Admin key required)
- SDK: @anthropic-ai/sdk
- Usage data has ~5 min delay
- Poll rate: max once per minute, recommended 5 min

## File layout
src/cli, src/daemon, src/api, src/store, src/alerts, src/config, src/web

## Always run
pnpm lint && pnpm build before finishing any task
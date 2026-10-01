# Announcement drafts — pending verified release

Status: unpublished. This run produces a security dependency candidate, not a verified public release. Recheck current Show HN rules and existing ClaudeWatch posts immediately before any launch; a dependency-only patch may not justify a new Show HN post. Prefer the next meaningful installable product release.

## GitHub release note draft for reviewed security patch

ClaudeWatch Core updates Nodemailer from 9.1.1 to 10.0.13 to address the dependency audit findings. It uses Nodemailer's bundled types and adds a real message-composition regression covering quoted recipient display names, multiple recipients, and alert formatting. No browser-extension behavior changes are included. Node20+ remains required.

Candidate: https://github.com/utkarshmankad/claudewatch/tree/fix/nodemailer-security
Tracking: https://github.com/utkarshmankad/claudewatch/issues/8

Before publishing: replace candidate link with verified release URL and include final CI evidence. Do not describe scratch-native checks as passed.

## Show HN draft for the next meaningful verified product release

Title: Show HN: ClaudeWatch – Local AI quota visibility and Claude API spend alerts
URL: https://github.com/utkarshmankad/claudewatch

I built ClaudeWatch as two independent tools: a standalone browser extension that shows provider-reported Claude, ChatGPT and Gemini quota snapshots when a signed-in provider tab is open, and an optional local Core daemon for Anthropic Admin API usage history and spend alerts. Local browser token events are estimates; subscription quota percentages are not an exact cross-device token ledger. Core is not required for the extension.

The release includes [insert only verified meaningful release changes and verified download link]. The default is local storage; optional sharing and encrypted relay sync are documented separately. Provider web endpoints are undocumented and can change. I would welcome feedback on stale quota handling and clearer attribution between account quotas and local estimates.

Publication gate: meaningful verified release, installable download, factual documentation (#11), no duplicate announcement, permitted destination and signed-in account. No public post URL exists yet.

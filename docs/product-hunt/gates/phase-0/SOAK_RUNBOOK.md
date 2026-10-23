# 24 hour real-browser soak: runbook

Needs a human-operated Chrome with real signed-in provider tabs; it cannot be run from a CI or cloud sandbox.

1. Load `claudewatch-extension/` unpacked (note `git rev-parse HEAD` as the build SHA). Sign in to Claude, ChatGPT, Gemini and keep one tab of each open.
2. Settings -> open the local analytics debug view; confirm events are recording. Note the UTC start time.
3. Leave Chrome running. At some point record UTC times for: browser restart, network cut, network restore (airplane mode or disable adapter for >= 15 min so a stale interval occurs).
4. After 24 h: debug view -> Export JSON; note the UTC end time.
5. `npm run soak:report -- --export export.json --build-sha <sha> --start <ISO> --end <ISO> --restarted-at <ISO> --network-cut-at <ISO> --network-restored-at <ISO>` writes `soak-24h.md` here.
6. Review it (no account identifiers should appear; the export holds only schema-validated metadata), then commit via PR.

Criterion: recovery <= 600 s after restart and after network restore. Do not use the simulated `docs/reliability/refresh-soak.md` as a substitute.

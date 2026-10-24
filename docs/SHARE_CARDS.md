# Privacy-safe share cards

Prompt 5.3, operation key `2026-10-10.1/prompt-5.3`. Code: `src/wrapped/shareCards.ts` (card model, SVG, privacy preview, gated export), `src/wrapped/imageMetadata.ts` (metadata stripping), `src/wrapped/shareLinks.ts` (instrumentation, referral codes, public-link contract), `src/daemon/shareRoutes.ts` (local API), `src/cli/commands/shareCard.ts` (`claudewatch share-card`). Metrics come from the 5.1 calculator ([WRAPPED_METRICS.md](WRAPPED_METRICS.md)); the private report is [WRAPPED_REPORT.md](WRAPPED_REPORT.md).

Sharing is opt-in and separate from the private report. A card is built on this device, nothing is uploaded, and no link is created unless a separate setting (below) is turned on.

## Templates

| Template | Default fields (percentages and achievements) | Off by default |
| --- | --- | --- |
| `provider_mix` | Week, share per provider (whole percent) | Number of providers used |
| `quota_streak` | Week, streak in days (shown from 2 days), share of tracked days under the limit, "no window reached 100%" | none |
| `interruption_prevention` | Week, "avoided an interruption (confirmed by me)", quota left at reset (percent), "no window reached 100%" | Number of interruptions avoided |
| `usage_patterns` | Week, quota left at reset, forecast accuracy in quota points, "uses N providers" | Share of days with activity |

A field appears only when its data exists; a missing input is omitted, never shown as zero. A template with no data returns `nothing_to_share`. Prevented interruptions need your confirmation (`--prevented <n>`), as in 5.1. The streak counts consecutive local days that have provider readings and none at 100%, within the chosen week and time zone.

## What can never appear

A card field can only be a `percent`, `achievement`, `period` (the week's start date) or `referral` text. There is no field type for raw request or token counts, account names or aliases, device names or identifiers, times of day or work hours, project names, prompts, file paths, costs, prices, plan names, or client (tool) breakdowns, so the builder cannot be handed them. Three further guards run on the final text:

1. `prohibitedIn` rejects text with currency symbols or codes, clock times, paths, addresses, numbers of four or more digits (dates and referral codes excepted), and a number next to "requests", "tokens", "calls", "messages" or "prompts". A failing field makes the build return `prohibited_content`.
2. `leaks` checks the finished image text for any account alias, device pseudonym or client name found in the ledger (whole-word match; provider names are allowed) and runs the same structural check. Export is refused with `prohibited_content`.
3. Percentages are whole numbers, so exact shares are not reconstructable from the image.

`src/wrapped/__tests__/shareCards.test.ts` proves this with a ledger whose alias, device id, client name and a distinctive request count (`4321`) are searched for in every field, preview, SVG, filename and exported body with every toggle switched on, and tests the guards with deliberately bad inputs. These tests do not prove that a future field added to a template is safe; a new field needs its own test.

## Preview and per-field toggles

Every field has an id and an on/off state. Switch with `--hide <ids>` / `--show <ids>` (CLI) or `hide=` / `show=` (API); unknown ids are refused. The preview lists all fields with their state, what the image includes, what it never includes, and warnings. Export needs the preview token, a SHA-256 of the exact image; a changed toggle, week or data gives a different token and `preview_stale`. The CLI asks for confirmation (or takes `--confirm <token>` from an earlier preview). There is no way to export without a preview token.

```sh
claudewatch share-card --template quota_streak --week 2026-10-07
claudewatch share-card --template provider_mix --hide providers_used --out card.svg
claudewatch share-card --template interruption_prevention --prevented 2 --show prevented_count --out card.svg
```

API (local daemon only): `GET /api/share/templates`, `GET /api/share/card?template&week&tz&providers&hide&show&referral&prevented`, `GET /api/share/export?...&format=svg&token=<preview token>`, `POST /api/share/event?event=native_share|link_copied&template=`.

## Image format and metadata

The image is a 1200 by 630 SVG with a title, the enabled fields and a fixed caption. It contains only `svg`, `g`, `rect`, `title`, `desc` and `text` elements: no XML declaration, DOCTYPE, comments, `metadata`, editor namespaces, scripts, images, links or generated ids. The `title` and `desc` carry the visible text for screen readers and nothing else. `stripSvgMetadata` runs on every export as well.

For raster images (the browser can draw a PNG from the SVG), `stripImageMetadata` copies an allow-list: PNG keeps `IHDR`, `PLTE`, `tRNS`, `IDAT`, `IEND` (so `tEXt`, `iTXt`, `zTXt`, `eXIf`, `tIME`, `pHYs`, `iCCP` and anything after `IEND` are dropped); JPEG drops APP1 to APP15 (EXIF, XMP, ICC, IPTC) and comments and keeps JFIF. Corrupt input is refused. Known limits: this change ships no PNG export button or dashboard panel, so no code path calls `stripImageMetadata` yet except its tests; a panel must pass any raster through it before saving. Dropping the color profile can shift colors slightly. Text rendered in a raster is not re-checked, so the raster must be drawn from the exported SVG only.

## Public links (contract only)

No hosting service exists and none is built; there is no network code. `LocalShareLinkStore` is the contract a future service must meet:

- Off unless `enabled` is set by its own explicit setting, which nothing turns on today (`links_disabled`).
- Needs a previewed card (its token) and an expiry between 1 hour and 30 days (`expiry_required`, `invalid_expiry`).
- Expired links disappear; `list()` and `delete(id)` give deletion control. It keeps a hash of the token, never the card.
- `url` is `null` until a service is configured and separately approved. The in-memory store does not persist across restarts and is not wired into the daemon.

## Instrumentation (log only)

Log lines `[share] event=<event> [template=..] [fields=<on>/<total>] [format=..] [error=..] [referral=valid|invalid]` for `preview`, `export`, `export_refused`, `native_share`, `link_created`, `link_copied`, `link_deleted`, `referral_attributed`. Lines are built from an allow-list of keys, so a destination, URL, account or value cannot be added. Native share and copied-link actions happen in the browser; it reports them with `POST /api/share/event`, which accepts only those two events and reads only the event and template. No telemetry is sent anywhere and no destination is recorded.

## Referral attribution

`newReferralCode()` makes a random 10 character Crockford base32 code from `crypto.randomBytes`; it is not derived from an account, device or time, so it does not identify the sharer. A card shows a code only if you supply one (`--referral-code`) and switch the `referral` field on; the preview warns when it is included. `attributeReferral(code)` logs only whether a code was valid; the code itself is never logged. Nothing stores codes or links installs to sharers: the referral funnel and its privacy review belong to Prompt 5.5.

## Not claimed here

No dashboard panel, no PNG export in this change, no hosted links, no real referral flow, and no accessibility audit with assistive technology or user testing of the cards.

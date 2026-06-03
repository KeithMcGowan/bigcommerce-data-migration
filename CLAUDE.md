# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Node.js scripts for transferring data between BigCommerce stores or channels. Each migration type lives in its own subfolder (e.g., `widgets/`). The intent is to grow this into a library of reusable migration scripts.

## Commands

```bash
npm install                      # install dependencies (dotenv only)
npm run migrate:widgets:dry      # preview widget template migration (no writes)
npm run migrate:widgets          # copy custom widget templates to DEST_CHANNEL_ID
npm run migrate:pages:dry        # preview web page migration (no writes)
npm run migrate:pages            # copy web pages + Page Builder layouts to DEST_CHANNEL_ID
```

Always do a dry run first to see what will be created/updated before running live.

If migrating pages that contain Page Builder widgets, run `migrate:widgets` first so the widget templates exist on the destination channel before the UUID translation map is built.

## Setup

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `STORE_HASH` | Store hash from the BC control panel URL |
| `AUTH_TOKEN` | X-Auth-Token from a Store-Level API Account (needs content read/write) |
| `SOURCE_CHANNEL_ID` | Channel ID to copy data *from* (main storefront = 1) |
| `DEST_CHANNEL_ID` | Channel ID to copy data *into* |

## Architecture

- **Runtime**: Node.js ≥ 18 (uses native `fetch`; no extra HTTP library needed)
- **Config**: `dotenv` loads `.env` at the top of each script
- **Structure**: one subfolder per resource type (`widgets/`, `web-pages/`, future: `products/`, `customers/`, etc.), each containing standalone migration scripts
- **Shared client**: `lib/api.js` exports `createApiClient({ storeHash, authToken })` which returns `{ apiFetch, BASE_URL }`. All rate limiting (1 call/sec via `lastCallTime`) and retry logic (once after 60 s on 429/5xx) live here. Each migration script creates its own client instance.

### Widget template migration (`widgets/migrate-widget-templates.js`)

1. GETs all templates with `widget_template_kind=custom` (API-level filter — excludes BigCommerce-native templates)
2. Optionally narrows to a manual `WIDGET_ALLOWLIST` array by name (edit in-file; empty = migrate all)
3. Pre-checks the destination channel (`channel_id:in`) and builds a name→template map
4. For each source template: **PUT** if a name match exists on destination, **POST** if not
5. Rate-limited to 1 call/sec via a global `lastCallTime` tracker inside `apiFetch`; retries once after 60 s on HTTP 429 or 5xx
6. One failure doesn't abort the batch — errors are logged and the loop continues
7. Dry-run mode (`--dry-run` flag or `migrate:widgets:dry` script) logs intended actions without making write calls

### Web page migration (`web-pages/migrate-web-pages.js`)

1. Builds a widget template UUID translation map upfront: fetches templates from both channels and matches by name → `Map<sourceUUID, destUUID>`
2. Fetches all source pages filtered by `SOURCE_CHANNEL_ID` (includes `body` field); sorts by `sort_order` to preserve navigation ordering; skips `blog` type pages
3. Pre-fetches destination pages into a name→page map
4. For each source page: **PUT** if a name match exists, **POST** if not; tracks `source_id → dest_id` for parent hierarchy translation
5. For each page, fetches the Page Builder widget snapshot (`GET /content/page-widgets?channel_id&entity_id=<page_id>&template_file=<file>`), rewrites `widget_template_uuid` values using the translation map, then publishes to the destination page (`POST /content/page-widgets` → 204)
6. Widget layout copy failures are non-fatal — the page shell is already saved; errors are logged and the loop continues

#### Known limitations / TODO

- **Parent–child ordering**: Pages are processed in `sort_order` order, but in some stores children have a lower `sort_order` than their parent. When a child is processed before its parent has been mapped, `parent_id` is set to `0`. Re-running the script after the first pass resolves most cases, but a proper fix would require topological sorting before the upsert loop.
- **Navigation order on destination**: Even when `sort_order` values are copied correctly, the destination channel may display pages in a different order in the control panel navigation. Manual reordering in the BC control panel may be needed after migration.
- **`PAGE_TEMPLATE_FILE` constant**: The page-widgets API requires a `template_file` parameter, but the Pages API does not expose this field in its response. The constant is hardcoded to `pages/page` (the Cornerstone default). If the store uses a different Stencil theme, this value may need to be changed — look for it near the top of the script.
- **Template-level fallback for page-widgets**: If the specified `template_file` does not support entity targeting, the script retries the snapshot fetch without `entity_id` (template-level content, shared across all pages using that template). This is logged as a warning. Page-specific widget content will not be copied in this case.
- **Blog pages**: Skipped entirely — the BigCommerce API does not support creating blog pages programmatically. These must be manually recreated on the destination channel.
- **`link` type pages**: Require a `link` field (external URL) in the payload rather than `url`. This is handled in `buildPagePayload` but has had limited testing — verify these pages after migration.

## BigCommerce API Notes

- All requests go to `https://api.bigcommerce.com/stores/{STORE_HASH}/v3`
- Auth header: `X-Auth-Token`
- Widget templates: `GET /content/widget-templates`, `POST /content/widget-templates`, `PUT /content/widget-templates/{uuid}`
- Web pages: `GET /content/pages`, `POST /content/pages`, `PUT /content/pages/{id}`; use `include=body` on GET to receive HTML body content
- Page Builder layout: `GET /content/page-widgets?channel_id&template_file=<file>&entity_id=<page_id>` returns `{ data: { regions: [...] } }`; `POST /content/page-widgets` with `{ channel_id, template_file, entity_id: String(id), regions }` returns 204 on success — note `entity_id` must be a **string**, not a number, on POST
- `widget_template_kind=custom` is the query param that filters to user-created templates only
- Pagination: responses include `meta.pagination.total_pages`; scripts loop with `page` counter until all pages are consumed (50 items/page)

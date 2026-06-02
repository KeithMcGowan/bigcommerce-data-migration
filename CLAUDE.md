# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Node.js scripts for transferring data between BigCommerce stores or channels. Each migration type lives in its own subfolder (e.g., `widgets/`). The intent is to grow this into a library of reusable migration scripts.

## Commands

```bash
npm install                  # install dependencies (dotenv only)
npm run migrate:widgets      # copy custom widget templates to DEST_CHANNEL_ID
```

## Setup

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `STORE_HASH` | Store hash from the BC control panel URL |
| `AUTH_TOKEN` | X-Auth-Token from a Store-Level API Account (needs content read/write) |
| `DEST_CHANNEL_ID` | Channel ID to copy data *into* |

## Architecture

- **Runtime**: Node.js ≥ 18 (uses native `fetch`; no extra HTTP library needed)
- **Config**: `dotenv` loads `.env` at the top of each script
- **Structure**: one subfolder per resource type (`widgets/`, future: `products/`, `customers/`, etc.), each containing standalone migration scripts

### Widget template migration (`widgets/migrate-widget-templates.js`)

1. GETs all templates with `widget_template_kind=custom` (API-level filter — excludes BigCommerce-native templates)
2. Optionally narrows to a manual `WIDGET_ALLOWLIST` array by name
3. Pre-checks the destination channel (`channel_id:in`) and builds a name→template map
4. For each source template: **PUT** if a name match exists on destination, **POST** if not
5. Rate-limited to 1 call/sec; retries once after 60 s on HTTP 429 or 5xx
6. One failure doesn't abort the batch — errors are logged and the loop continues

## BigCommerce API Notes

- All requests go to `https://api.bigcommerce.com/stores/{STORE_HASH}/v3`
- Auth header: `X-Auth-Token`
- Widget templates: `GET /content/widget-templates`, `POST /content/widget-templates`
- `widget_template_kind=custom` is the query param that filters to user-created templates only
- Pagination: responses include `meta.pagination.total_pages`; scripts loop until all pages are consumed

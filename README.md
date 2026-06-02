# BigCommerce Data Migration

A growing collection of Node.js scripts for migrating data between BigCommerce stores and channels. Built to be run on demand whenever data needs to be moved — each migration type lives in its own subfolder so the repo stays organised as it expands.

> This project was built with the assistance of [Claude](https://claude.ai) by Anthropic.

---

## Prerequisites

- **Node.js 18 or higher** — scripts use the native `fetch` API introduced in Node 18, so no HTTP library is required.
- A BigCommerce **Store-Level API Account** with at minimum **Content → Read/Write** scope. Create one under _Settings → API Accounts_ in your store's control panel.

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

This only needs to be done once (or again after pulling new changes).

### 2. Set up your environment file

Copy `.env.example` to a new file named `.env` at the project root:

```bash
cp .env.example .env
```

Then fill in your values:

| Variable | Description |
|---|---|
| `STORE_HASH` | Your store's unique hash — visible in the control panel URL (`mystore.mybigcommerce.com/manage`) |
| `AUTH_TOKEN` | The `X-Auth-Token` from your Store-Level API Account |
| `SOURCE_CHANNEL_ID` | Channel ID you want to copy data **from** (your main channel is typically `1`) |
| `DEST_CHANNEL_ID` | Channel ID you want to copy data **into** |

> **Important:** `.env` is listed in `.gitignore` and must never be committed to source control. It contains credentials that grant write access to your store.

Channel IDs can be found under _Channel Manager_ in the control panel, or by calling `GET /v3/channels` with your auth token.

---

## Usage

### Always do a dry run first

Before running any live migration, use the dry-run command to preview exactly what will be created or updated — without touching the API:

```bash
npm run migrate:widgets:dry
```

The output will show every template that _would_ be created (`+`) or updated (`↻`), along with a final count. Only proceed to the live run once you are satisfied with the list.

### Run the live migration

```bash
npm run migrate:widgets
```

---

## Migration Flow

```mermaid
flowchart TD
    A([Start]) --> B[Validate env vars]
    B --> C[Fetch custom templates\nfrom source channel]

    subgraph optFilter ["Optional — entire block skipped if WIDGET_ALLOWLIST is empty"]
        D{Allowlist\ndefined?}
        E[Filter to\nallowlist names]
        F[Use all\ncustom templates]
    end

    C --> D
    D -- Yes --> E
    D -- No --> F
    E & F --> G[Fetch existing templates\nfrom destination channel]
    G --> H{More templates\nto process?}
    H -- No --> Z([Print summary and exit])
    H -- Yes --> I{Exists on\ndestination?}
    I -- Yes --> J[PUT — update]
    I -- No --> K[POST — create]
    J & K --> L

    subgraph retryBlock ["One attempt max — triggered only on HTTP 429 or 5xx"]
        L{HTTP 429\nor 5xx?}
        N[Wait 60s\nand retry]
        O{Retry\nsucceeded?}
    end

    L -- No --> M[Log success ✓]
    L -- Yes --> N
    N --> O
    O -- Yes --> M
    O -- No --> P[Log failure ✗\nand continue]
    M --> H
    P --> H
```

---

## Rate Limiting and Retries

BigCommerce enforces API rate limits, and in practice high-volume transfers can result in bounced calls even when technically within the published limits.

To handle this, all API calls in these scripts are routed through a central `apiFetch` wrapper that does two things:

**Rate limiting** — a minimum of one second is enforced between every API call. If a call completes faster than that, the script pauses for the remainder before proceeding. This keeps the request rate predictable and well within BigCommerce's thresholds.

**Automatic retry** — if a call returns HTTP `429` (Too Many Requests) or any `5xx` server error, the script logs a warning, waits 60 seconds, and retries the call once automatically. If the retry also fails, the error is logged and the script moves on to the next item rather than aborting the entire run.

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run migrate:widgets:dry` | Preview widget template migration (no changes made) |
| `npm run migrate:widgets` | Run widget template migration live |

---

## Project Structure

```
bigcommerce-data-transfer/
├── .env.example              # Template for required environment variables
├── .env                      # Your local credentials (gitignored)
├── package.json
└── widgets/
    └── migrate-widget-templates.js
```

New migration types (products, customers, etc.) follow the same pattern: add a subfolder named after the resource and a corresponding `npm run migrate:<type>` script in `package.json`.

---

## API Documentation

- [Widgets](https://docs.bigcommerce.com/developer/api-reference/rest/admin/content/widgets)

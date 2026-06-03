/**
 * Copies web pages from one BigCommerce channel to another on the same store.
 * For each source page:
 *   - If a page with the same name already exists on the destination channel → UPDATE it
 *   - If no match is found → CREATE it
 *
 * After upserting each page shell (metadata, URL, visibility), the script copies
 * the full Page Builder widget layout by:
 *   1. Fetching the widget snapshot from the source page
 *   2. Translating all widget_template_uuid values from source UUIDs to their
 *      destination equivalents (matched by template name)
 *   3. Publishing the translated layout to the destination page
 *
 * Pages are processed in sort_order to preserve navigation/footer ordering.
 * Parent–child relationships are preserved using a running source→dest ID map.
 * Blog pages (type: blog) are skipped — they cannot be created via the API.
 *
 * Usage:
 *   npm run migrate:pages          — live run
 *   npm run migrate:pages:dry      — preview without making any changes
 *
 * Required env vars (see .env.example):
 *   STORE_HASH, AUTH_TOKEN, SOURCE_CHANNEL_ID, DEST_CHANNEL_ID
 */

require('dotenv').config();

const { createApiClient } = require('../lib/api.js');

const STORE_HASH        = process.env.STORE_HASH;
const AUTH_TOKEN        = process.env.AUTH_TOKEN;
const SOURCE_CHANNEL_ID = parseInt(process.env.SOURCE_CHANNEL_ID, 10);
const DEST_CHANNEL_ID   = parseInt(process.env.DEST_CHANNEL_ID, 10);

const { apiFetch, BASE_URL } = createApiClient({ storeHash: STORE_HASH, authToken: AUTH_TOKEN });

// Run with --dry-run to preview what would be created/updated without writing anything.
const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Optional allowlist
//
// To migrate only specific pages by name, add them here. When non-empty,
// this takes precedence over channel-based filtering.
//
// Example:
//   const PAGE_ALLOWLIST = ['About Us', 'Contact'];
// ---------------------------------------------------------------------------
const PAGE_ALLOWLIST = [];

// ---------------------------------------------------------------------------
// Widget template UUID translation
//
// Page Builder widget instances reference their template by UUID. Because the
// widget migration creates new templates on the destination with different UUIDs,
// we must translate source UUIDs → destination UUIDs before publishing the layout.
// Templates are matched by name across channels.
// ---------------------------------------------------------------------------

/**
 * Fetches all custom widget templates for a given channel.
 * Returns an array of { uuid, name } objects.
 */
async function fetchWidgetTemplates(channelId) {
  const templates = [];
  let page = 1;
  let totalPages = 1;

  do {
    const params = new URLSearchParams({
      widget_template_kind: 'custom',
      'channel_id:in':      channelId,
      page,
      limit: 50,
    });

    const res = await apiFetch(`${BASE_URL}/content/widget-templates?${params}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`GET /widget-templates (channel ${channelId}) failed: ${JSON.stringify(err)}`);
    }

    const { data, meta } = await res.json();
    templates.push(...data);
    totalPages = meta.pagination.total_pages;
    page++;
  } while (page <= totalPages);

  return templates;
}

/**
 * Builds a translator function that maps source widget template UUIDs to
 * destination UUIDs. Templates are matched by name.
 *
 * If a source UUID has no matching destination template, the original UUID is
 * returned unchanged and a warning is logged.
 *
 * @returns {Promise<(sourceUuid: string) => string>}
 */
async function buildUuidTranslator() {
  console.log('Building widget template UUID translation map...');

  const sourceTemplates = await fetchWidgetTemplates(SOURCE_CHANNEL_ID);
  const destTemplates   = await fetchWidgetTemplates(DEST_CHANNEL_ID);

  // source uuid → template name
  const sourceByUuid = new Map(sourceTemplates.map((t) => [t.uuid, t.name]));
  // template name → dest uuid
  const destByName   = new Map(destTemplates.map((t) => [t.name, t.uuid]));

  const uuidMap = new Map();
  let unmatched = 0;

  for (const [sourceUuid, name] of sourceByUuid) {
    const destUuid = destByName.get(name);
    if (destUuid) {
      uuidMap.set(sourceUuid, destUuid);
    } else {
      console.warn(`  ⚠  No destination widget template found for "${name}" — UUID will be kept as-is.`);
      unmatched++;
    }
  }

  console.log(
    `  Mapped ${uuidMap.size} template UUID(s)` +
    (unmatched > 0 ? `, ${unmatched} unmatched.` : '.') +
    '\n'
  );

  return (sourceUuid) => uuidMap.get(sourceUuid) ?? sourceUuid;
}

/**
 * Recursively walks a page-widgets snapshot and replaces every
 * widget_template_uuid string value using the provided translator.
 *
 * All other fields are passed through unchanged.
 */
function translateUuids(node, translateUuid) {
  if (Array.isArray(node)) {
    return node.map((item) => translateUuids(item, translateUuid));
  }
  if (node !== null && typeof node === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = (key === 'widget_template_uuid' && typeof value === 'string')
        ? translateUuid(value)
        : translateUuids(value, translateUuid);
    }
    return result;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * Fetches all web pages from the source channel, sorted by sort_order.
 * Requests the body field so HTML content is included for non-Page-Builder pages.
 *
 * @returns {Promise<Object[]>}
 */
async function getSourcePages() {
  const pages = [];
  let page = 1;
  let totalPages = 1;

  do {
    const params = new URLSearchParams({
      channel_id: SOURCE_CHANNEL_ID,
      include:    'body',
      page,
      limit:      50,
    });

    const res = await apiFetch(`${BASE_URL}/content/pages?${params}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`GET /pages (source) failed (page ${page}): ${JSON.stringify(err)}`);
    }

    const { data, meta } = await res.json();
    pages.push(...data);
    totalPages = meta.pagination.total_pages;
    page++;
  } while (page <= totalPages);

  // Preserve navigation/footer ordering.
  pages.sort((a, b) => a.sort_order - b.sort_order);

  return pages;
}

/**
 * Fetches all pages already on the destination channel.
 * Returns a Map of { name → page object } for O(1) lookup during upsert.
 *
 * @returns {Promise<Map<string, Object>>}
 */
async function getDestinationPages() {
  const byName = new Map();
  let page = 1;
  let totalPages = 1;

  do {
    const params = new URLSearchParams({
      channel_id: DEST_CHANNEL_ID,
      page,
      limit:      50,
    });

    const res = await apiFetch(`${BASE_URL}/content/pages?${params}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`GET /pages (destination) failed (page ${page}): ${JSON.stringify(err)}`);
    }

    const { data, meta } = await res.json();
    for (const p of data) byName.set(p.name, p);
    totalPages = meta.pagination.total_pages;
    page++;
  } while (page <= totalPages);

  return byName;
}

/**
 * Builds the POST/PUT payload for a page on the destination channel.
 * Translates parent_id using the running source→dest ID map so page hierarchy
 * is preserved. Falls back to 0 (no parent) if the parent hasn't been
 * migrated yet.
 *
 * is_homepage is intentionally excluded — the destination already has a
 * homepage and we should not silently reassign it.
 *
 * @param {Object}            sourcePage
 * @param {Map<number,number>} sourceToDestId
 */
function buildPagePayload(sourcePage, sourceToDestId) {
  const payload = {
    type:              sourcePage.type,
    name:              sourcePage.name,
    url:               sourcePage.url,
    is_visible:        sourcePage.is_visible,
    is_customers_only: sourcePage.is_customers_only,
    sort_order:        sourcePage.sort_order,
    meta_title:        sourcePage.meta_title,
    meta_description:  sourcePage.meta_description,
    meta_keywords:     sourcePage.meta_keywords,
    search_keywords:   sourcePage.search_keywords,
    channel_id:        DEST_CHANNEL_ID,
  };

  // Translate parent_id if the source page belongs to a hierarchy.
  if (sourcePage.parent_id && sourcePage.parent_id > 0) {
    payload.parent_id = sourceToDestId.get(sourcePage.parent_id) ?? 0;
    if (!sourceToDestId.has(sourcePage.parent_id)) {
      console.warn(
        `  ⚠  Parent page (id ${sourcePage.parent_id}) for "${sourcePage.name}" ` +
        `has not been migrated yet — setting parent_id to 0.`
      );
    }
  }

  // Link pages require the external URL in a `link` field, not `url`.
  if (sourcePage.type === 'link' && sourcePage.link != null) {
    payload.link = sourcePage.link;
  }

  // Include body for pages that carry HTML content (not Page Builder pages,
  // but present it anyway so it isn't lost if a page uses the classic editor).
  if (sourcePage.body != null) {
    payload.body = sourcePage.body;
  }

  return payload;
}

/**
 * Creates a new page on the destination channel.
 * Returns the created page object (needed for its id).
 */
async function createPage(sourcePage, sourceToDestId) {
  const res = await apiFetch(`${BASE_URL}/content/pages`, {
    method: 'POST',
    body:   JSON.stringify(buildPagePayload(sourcePage, sourceToDestId)),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(JSON.stringify(err));
  }

  const json = await res.json();
  return Array.isArray(json.data) ? json.data[0] : json.data;
}

/**
 * Updates an existing page on the destination channel.
 * Returns the updated page object (needed for its id).
 */
async function updatePage(destPageId, sourcePage, sourceToDestId) {
  const res = await apiFetch(`${BASE_URL}/content/pages/${destPageId}`, {
    method: 'PUT',
    body:   JSON.stringify(buildPagePayload(sourcePage, sourceToDestId)),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(JSON.stringify(err));
  }

  const json = await res.json();
  return Array.isArray(json.data) ? json.data[0] : json.data;
}

// ---------------------------------------------------------------------------
// Page Builder widget layout
// ---------------------------------------------------------------------------

/**
 * Returns the Stencil template_file for a page.
 * The Pages API does not expose this field, so we fall back to per-type defaults.
 * 'pages/page' is the standard template for custom pages in Cornerstone-based themes.
 * Override the PAGE_TEMPLATE_FILE constant below if your theme uses a different name.
 */
const PAGE_TEMPLATE_FILE = 'pages/page';

function resolveTemplateFile(page) {
  if (page.template_file) return page.template_file;
  const defaults = { page: PAGE_TEMPLATE_FILE, raw: PAGE_TEMPLATE_FILE, contact_form: 'pages/contact-us' };
  return defaults[page.type] ?? PAGE_TEMPLATE_FILE;
}

/**
 * Fetches the Page Builder widget snapshot for a page on the source channel.
 *
 * First attempts with entity_id (page-specific content). If the template does
 * not support entity targeting, retries with just template_file (template-level
 * content, shared across all pages using that template).
 *
 * @param {number} sourcePageId
 * @param {string} templateFile
 * @returns {Promise<Object>} The full response JSON ({ data: { regions: [...] } })
 */
async function getPageWidgetSnapshot(sourcePageId, templateFile) {
  const entityParams = new URLSearchParams({
    channel_id:    SOURCE_CHANNEL_ID,
    entity_id:     sourcePageId,
    template_file: templateFile,
  });

  const res = await apiFetch(`${BASE_URL}/content/page-widgets?${entityParams}`);

  if (res.ok) return res.json();

  const errBody = await res.json().catch(() => ({}));

  // If entity targeting is unsupported, retry at the template level.
  if (res.status === 422 && errBody?.errors?.entity_id) {
    console.warn(`     ↳ entity_id not supported for "${templateFile}" — retrying without entity_id (template-level).`);
    const tmplParams = new URLSearchParams({
      channel_id:    SOURCE_CHANNEL_ID,
      template_file: templateFile,
    });
    const res2 = await apiFetch(`${BASE_URL}/content/page-widgets?${tmplParams}`);
    if (res2.ok) return res2.json();
    const errBody2 = await res2.json().catch(() => ({}));
    throw new Error(`GET /page-widgets (template-level) failed: ${JSON.stringify(errBody2)}`);
  }

  throw new Error(`GET /page-widgets failed: ${JSON.stringify(errBody)}`);
}

/**
 * Publishes the translated widget layout to a page on the destination channel.
 * A 204 No Content response indicates success.
 *
 * @param {number}   destPageId
 * @param {Object[]} regions     Translated regions array from the source snapshot.
 * @param {string}   templateFile
 */
async function publishPageWidgets(destPageId, regions, templateFile) {
  const res = await apiFetch(`${BASE_URL}/content/page-widgets`, {
    method: 'POST',
    body:   JSON.stringify({
      channel_id:    DEST_CHANNEL_ID,
      entity_id:     String(destPageId),
      template_file: templateFile,
      regions,
    }),
  });

  // 204 No Content is the success response for this endpoint.
  if (res.status !== 204 && !res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`POST /page-widgets failed: ${JSON.stringify(body)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const missingOrInvalid = [
    !STORE_HASH                                    && 'STORE_HASH',
    !AUTH_TOKEN                                    && 'AUTH_TOKEN',
    (!SOURCE_CHANNEL_ID || SOURCE_CHANNEL_ID < 1)  && 'SOURCE_CHANNEL_ID',
    (!DEST_CHANNEL_ID   || DEST_CHANNEL_ID   < 1)  && 'DEST_CHANNEL_ID',
  ].filter(Boolean);

  if (missingOrInvalid.length > 0) {
    console.error(
      `Error: Missing or invalid environment variable(s): ${missingOrInvalid.join(', ')}\n` +
      'Copy .env.example to .env and ensure all four values are set correctly.'
    );
    process.exit(1);
  }

  if (DRY_RUN) console.log('--- DRY RUN — no changes will be made ---\n');

  // -- Step 1: Build UUID translation map --------------------------------------
  // Fetches widget templates from both channels and maps source UUIDs → dest UUIDs.
  // Run this even in dry-run mode so we can warn about unmatched templates.
  const translateUuid = await buildUuidTranslator();

  // -- Step 2: Fetch source pages ----------------------------------------------
  console.log(`Fetching web pages from channel ${SOURCE_CHANNEL_ID}...`);
  let sourcePages = await getSourcePages();

  const blogPages = sourcePages.filter((p) => p.type === 'blog');
  if (blogPages.length > 0) {
    console.log(`  Skipping ${blogPages.length} blog page(s) — cannot be created via API.`);
    sourcePages = sourcePages.filter((p) => p.type !== 'blog');
  }

  if (PAGE_ALLOWLIST.length > 0) {
    sourcePages = sourcePages.filter((p) => PAGE_ALLOWLIST.includes(p.name));
    console.log(`Allowlist active — ${sourcePages.length} page(s) matched.`);
  } else {
    console.log(`Found ${sourcePages.length} page(s) to migrate.`);
  }

  if (sourcePages.length === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  // -- Step 3: Pre-check destination channel -----------------------------------
  console.log(`\nChecking existing pages on channel ${DEST_CHANNEL_ID}...`);
  const destMap = await getDestinationPages();
  console.log(`${destMap.size} existing page(s) found on destination channel.\n`);

  // -- Step 4: Upsert pages + copy widget layouts ------------------------------
  let created = 0;
  let updated = 0;
  let failed  = 0;

  // Tracks source page id → destination page id for parent_id translation.
  const sourceToDestId = new Map();

  for (const sourcePage of sourcePages) {
    const existing = destMap.get(sourcePage.name);

    if (DRY_RUN) {
      if (existing) {
        console.log(`  ↻  Would update:  ${sourcePage.name}`);
        updated++;
      } else {
        console.log(`  +  Would create:  ${sourcePage.name}`);
        created++;
      }
      continue;
    }

    try {
      let destPage;

      if (existing) {
        destPage = await updatePage(existing.id, sourcePage, sourceToDestId);
        console.log(`  ↻  Updated:  ${sourcePage.name}`);
        updated++;
      } else {
        destPage = await createPage(sourcePage, sourceToDestId);
        console.log(`  +  Created:  ${sourcePage.name}`);
        created++;
      }

      // Record the mapping so subsequent pages can resolve parent_id correctly.
      sourceToDestId.set(sourcePage.id, destPage.id);

      // Copy the Page Builder widget layout for this page.
      try {
        const templateFile = resolveTemplateFile(sourcePage);
        const snapshot     = await getPageWidgetSnapshot(sourcePage.id, templateFile);
        const regions      = snapshot?.data?.regions ?? [];

        if (regions.length > 0) {
          const translated = translateUuids(regions, translateUuid);
          await publishPageWidgets(destPage.id, translated, templateFile);
          console.log(`     ↳ Widget layout copied.`);
        } else {
          console.log(`     ↳ No widget layout found on source page.`);
        }
      } catch (widgetErr) {
        // Widget layout failure is non-fatal — the page shell was already saved.
        console.warn(`     ↳ Widget layout copy failed: ${widgetErr.message}`);
      }
    } catch (err) {
      console.error(`  ✗  Failed:   ${sourcePage.name}: ${err.message}`);
      failed++;
    }
  }

  const suffix = DRY_RUN ? ' (dry run — no changes made)' : '';
  console.log(
    `\nDone — ${created} ${DRY_RUN ? 'to create' : 'created'}, ` +
    `${updated} ${DRY_RUN ? 'to update' : 'updated'}, ` +
    `${failed} failed${suffix}.`
  );
}

run();

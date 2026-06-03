/**
 * Copies custom-built widget templates from one BigCommerce channel to another
 * on the same store. For each source template:
 *   - If a template with the same name already exists on the destination channel → UPDATE it
 *   - If no match is found → CREATE it
 *
 * Rate limiting and retry logic are handled by the shared lib/api.js client.
 *
 * Usage:
 *   npm run migrate:widgets          — live run
 *   npm run migrate:widgets:dry      — preview without making any changes
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
// To migrate only specific templates by name, add them here. When non-empty,
// this takes precedence over the kind-based API filter.
//
// Example:
//   const WIDGET_ALLOWLIST = ['Hero Banner', 'Product Spotlight'];
// ---------------------------------------------------------------------------
const WIDGET_ALLOWLIST = [];

// ---------------------------------------------------------------------------

/**
 * Fetches every custom widget template on the source channel, paginated.
 * Scoping by both widget_template_kind and channel_id:in ensures we only pull
 * templates that belong to the source channel, not every custom template on
 * the entire store.
 *
 * @returns {Promise<Object[]>}
 */
async function getSourceWidgetTemplates() {
  const templates = [];
  let page = 1;
  let totalPages = 1;

  do {
    const params = new URLSearchParams({
      widget_template_kind: 'custom',
      'channel_id:in': SOURCE_CHANNEL_ID,
      page,
      limit: 50,
    });

    const res = await apiFetch(`${BASE_URL}/content/widget-templates?${params}`);

    if (!res.ok) {
      const err = await res.json();
      throw new Error(`GET /widget-templates failed (page ${page}): ${JSON.stringify(err)}`);
    }

    const { data, meta } = await res.json();
    templates.push(...data);
    totalPages = meta.pagination.total_pages;
    page++;
  } while (page <= totalPages);

  return templates;
}

/**
 * Fetches all widget templates that already exist on the destination channel.
 * Returns a Map of { name → template object } for O(1) lookup during upsert.
 *
 * @returns {Promise<Map<string, Object>>}
 */
async function getDestinationTemplates() {
  const byName = new Map();
  let page = 1;
  let totalPages = 1;

  do {
    const params = new URLSearchParams({ 'channel_id:in': DEST_CHANNEL_ID, page, limit: 50 });
    const res = await apiFetch(`${BASE_URL}/content/widget-templates?${params}`);

    if (!res.ok) {
      const err = await res.json();
      throw new Error(`GET destination templates failed (page ${page}): ${JSON.stringify(err)}`);
    }

    const { data, meta } = await res.json();
    for (const t of data) byName.set(t.name, t);
    totalPages = meta.pagination.total_pages;
    page++;
  } while (page <= totalPages);

  return byName;
}

/**
 * Creates a new widget template on the destination channel.
 *
 * @param {Object} template - Source template object (name, schema, template).
 */
async function createWidgetTemplate(template) {
  const res = await apiFetch(`${BASE_URL}/content/widget-templates`, {
    method: 'POST',
    body: JSON.stringify({
      name:       template.name,
      schema:     template.schema,
      template:   template.template,
      channel_id: DEST_CHANNEL_ID,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(JSON.stringify(err));
  }

  return res.json();
}

/**
 * Updates an existing widget template on the destination channel.
 * The UUID comes from the destination pre-check, not the source template —
 * source and destination UUIDs are different even for the same logical widget.
 *
 * @param {string} uuid     - UUID of the existing destination template.
 * @param {Object} template - Source template object (name, schema, template).
 */
async function updateWidgetTemplate(uuid, template) {
  const res = await apiFetch(`${BASE_URL}/content/widget-templates/${uuid}`, {
    method: 'PUT',
    body: JSON.stringify({
      name:     template.name,
      schema:   template.schema,
      template: template.template,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(JSON.stringify(err));
  }

  return res.json();
}

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

  if (DRY_RUN) {
    console.log('--- DRY RUN — no changes will be made ---\n');
  }

  // -- Step 1: Fetch source templates ------------------------------------------
  console.log(`Fetching custom widget templates from channel ${SOURCE_CHANNEL_ID}...`);
  let sourceTemplates = await getSourceWidgetTemplates();

  if (WIDGET_ALLOWLIST.length > 0) {
    sourceTemplates = sourceTemplates.filter((t) => WIDGET_ALLOWLIST.includes(t.name));
    console.log(`Allowlist active — ${sourceTemplates.length} template(s) matched.`);
  } else {
    console.log(`Found ${sourceTemplates.length} custom template(s).`);
  }

  if (sourceTemplates.length === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  // -- Step 2: Pre-check destination channel -----------------------------------
  console.log(`\nChecking existing templates on channel ${DEST_CHANNEL_ID}...`);
  const destMap = await getDestinationTemplates();
  console.log(`${destMap.size} existing template(s) found on destination channel.\n`);

  // -- Step 3: Upsert each template --------------------------------------------
  let created = 0;
  let updated = 0;
  let failed  = 0;

  for (const template of sourceTemplates) {
    const existing = destMap.get(template.name);

    if (DRY_RUN) {
      // In dry-run mode, log the intended action without touching the API.
      if (existing) {
        console.log(`  ↻  Would update:  ${template.name}`);
        updated++;
      } else {
        console.log(`  +  Would create:  ${template.name}`);
        created++;
      }
      continue;
    }

    try {
      if (existing) {
        // Template with this name already exists — update it in place.
        await updateWidgetTemplate(existing.uuid, template);
        console.log(`  ↻  Updated:  ${template.name}`);
        updated++;
      } else {
        await createWidgetTemplate(template);
        console.log(`  +  Created:  ${template.name}`);
        created++;
      }
    } catch (err) {
      // Log the failure but continue — one bad template shouldn't stop the rest.
      console.error(`  ✗  Failed:   ${template.name}: ${err.message}`);
      failed++;
    }
  }

  const suffix = DRY_RUN ? ' (dry run — no changes made)' : '';
  console.log(`\nDone — ${created} ${DRY_RUN ? 'to create' : 'created'}, ${updated} ${DRY_RUN ? 'to update' : 'updated'}, ${failed} failed${suffix}.`);
}

run();

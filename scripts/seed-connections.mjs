#!/usr/bin/env node
/**
 * seed-connections.mjs — One-shot bootstrap: reads config/linkedin-connections.json
 * and uploads all contacts to an Airtable "Connections" table.
 *
 * If the table doesn't exist, this script will attempt to create it via the
 * Airtable Metadata API (requires schema.bases:write scope on your PAT).
 * If that scope is unavailable, it prints clear instructions for manual creation.
 *
 * Run ONCE to bootstrap. After that, Airtable is the source of truth.
 * Use `node scripts/sync-connections.mjs` to pull updates back down.
 *
 * Usage:
 *   node scripts/seed-connections.mjs              # upload all contacts
 *   node scripts/seed-connections.mjs --dry-run    # print plan only
 *
 * Exit codes:
 *   0 = success
 *   1 = fatal (missing PAT, unreadable connections file)
 *   2 = table not found and auto-creation failed (manual setup needed)
 */

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_ID, PAT_MISSING_MSG } from './airtable-sync.mjs';
import { CONNECTIONS_TABLE } from './sync-connections.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..');

// ── Airtable helpers ──────────────────────────────────────────────────────────

/** POST records in batches of 10 (Airtable limit). */
async function createBatch({ pat, baseId, tableName, records, fetchImpl = fetch }) {
  const created = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const res = await fetchImpl(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ records: batch }),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`Airtable POST "${tableName}" failed: ${res.status} ${res.statusText}${body ? ' — ' + body : ''}`);
    }
    const json = await res.json();
    created.push(...(json.records || []));
  }
  return created;
}

/**
 * Check if the Connections table exists by listing tables via the Metadata API.
 * Returns null if the table exists, or an error string if not found or API is unavailable.
 */
async function checkTableExists({ pat, baseId, tableName, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
    headers: { Authorization: `Bearer ${pat}` },
  });
  if (!res.ok) {
    // If 403, the PAT lacks schema.bases:read — we can't tell if table exists.
    return { unknown: true, status: res.status };
  }
  const json = await res.json();
  const tables = json.tables || [];
  const found = tables.some((t) => t.name === tableName);
  return { found };
}

/**
 * Create the Connections table via the Metadata API.
 * Returns { ok, error } — ok=false if schema.bases:write scope is missing.
 */
async function createTable({ pat, baseId, tableName, fetchImpl = fetch }) {
  const body = {
    name: tableName,
    fields: [
      { name: 'Company',      type: 'singleLineText' },
      { name: 'Name',         type: 'singleLineText' },
      { name: 'Position',     type: 'singleLineText' },
      { name: 'LinkedIn URL', type: 'url' },
    ],
  };
  const res = await fetchImpl(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    let errBody = '';
    try { errBody = await res.text(); } catch { /* ignore */ }
    return { ok: false, status: res.status, error: `${res.status} ${res.statusText}${errBody ? ' — ' + errBody : ''}` };
  }
  return { ok: true };
}

function printManualSetupInstructions() {
  console.error(`
[seed-connections] MANUAL SETUP REQUIRED
─────────────────────────────────────────
The PAT does not have schema.bases:write scope to create tables automatically.

1. Open Airtable base appYRJX5x9iVXpbbg in your browser.
2. Create a new table named exactly: Connections
3. Add these fields (the order shown becomes column order):
     • Company      — Single line text  ← make this the primary field
     • Name         — Single line text
     • Position     — Single line text
     • LinkedIn URL — URL
4. Re-run: node scripts/seed-connections.mjs
─────────────────────────────────────────`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  try { (await import('dotenv')).config(); } catch { /* optional */ }

  const dryRun  = process.argv.includes('--dry-run');
  const pat     = process.env.AIRTABLE_PAT || null;

  if (!pat) {
    console.error(`[seed-connections] FATAL: ${PAT_MISSING_MSG}`);
    process.exit(1);
  }

  // 1. Read source data.
  const connPath = join(ROOT, 'config', 'linkedin-connections.json');
  let connections;
  try {
    connections = JSON.parse(readFileSync(connPath, 'utf8'));
  } catch (e) {
    console.error(`[seed-connections] FATAL: cannot read ${connPath}: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(connections) || connections.length === 0) {
    console.error(`[seed-connections] FATAL: ${connPath} is empty or not an array`);
    process.exit(1);
  }

  console.log(`[seed-connections] ${connections.length} connection(s) loaded from ${connPath}`);

  if (dryRun) {
    console.log(`[seed-connections] DRY-RUN — would upload ${connections.length} record(s) to Airtable "${CONNECTIONS_TABLE}" table`);
    console.log(`[seed-connections] Sample (first 3):`);
    for (const c of connections.slice(0, 3)) {
      console.log(`  ${c.company} | ${c.name} | ${c.position}`);
    }
    process.exit(0);
  }

  // 2. Ensure the table exists.
  console.log(`[seed-connections] checking if "${CONNECTIONS_TABLE}" table exists…`);
  let tableCheck;
  try {
    tableCheck = await checkTableExists({ pat, baseId: BASE_ID, tableName: CONNECTIONS_TABLE });
  } catch (e) {
    console.warn(`[seed-connections] WARN: could not check table existence: ${e.message} — attempting to upload anyway`);
    tableCheck = { unknown: true };
  }

  if (!tableCheck.found && !tableCheck.unknown) {
    console.log(`[seed-connections] table "${CONNECTIONS_TABLE}" not found — attempting to create via Metadata API…`);
    let created;
    try {
      created = await createTable({ pat, baseId: BASE_ID, tableName: CONNECTIONS_TABLE });
    } catch (e) {
      created = { ok: false, error: e.message };
    }
    if (!created.ok) {
      console.error(`[seed-connections] Auto-create failed: ${created.error}`);
      printManualSetupInstructions();
      process.exit(2);
    }
    console.log(`[seed-connections] table "${CONNECTIONS_TABLE}" created`);
  } else if (tableCheck.found) {
    console.log(`[seed-connections] table "${CONNECTIONS_TABLE}" exists — uploading records`);
  } else {
    console.log(`[seed-connections] table existence unknown (limited PAT scope) — attempting upload`);
  }

  // 3. Build Airtable records.
  const records = connections.map((c) => ({
    fields: {
      'Company':      (c.company  || '').trim(),
      'Name':         (c.name     || '').trim(),
      'Position':     (c.position || '').trim(),
      'LinkedIn URL': (c.url      || '').trim(),
    },
  })).filter((r) => r.fields['Company'] && r.fields['Name']);

  console.log(`[seed-connections] uploading ${records.length} record(s) in batches of 10…`);

  // 4. Upload in batches, showing progress every 100 records.
  let uploaded = 0;
  const batchSize = 10;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    try {
      await createBatch({ pat, baseId: BASE_ID, tableName: CONNECTIONS_TABLE, records: batch });
      uploaded += batch.length;
      if (uploaded % 100 === 0 || uploaded === records.length) {
        console.log(`[seed-connections] uploaded ${uploaded}/${records.length}`);
      }
    } catch (e) {
      console.error(`[seed-connections] FATAL at batch ${i}–${i + batchSize}: ${e.message}`);
      console.error(`[seed-connections] ${uploaded} record(s) were uploaded before the failure.`);
      process.exit(1);
    }
  }

  console.log(`[seed-connections] done — ${uploaded} connection(s) seeded into "${CONNECTIONS_TABLE}" table`);
  console.log(`[seed-connections] Airtable is now the source of truth. Use:`);
  console.log(`[seed-connections]   node scripts/sync-connections.mjs   (pull updates → config/linkedin-connections.json)`);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (IS_CLI) {
  main().catch((e) => {
    console.error('[seed-connections] FATAL:', e.message);
    process.exit(1);
  });
}

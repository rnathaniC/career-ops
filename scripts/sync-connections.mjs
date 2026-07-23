#!/usr/bin/env node
/**
 * sync-connections.mjs — Pull the Airtable "Connections" table into
 * config/linkedin-connections.json so kanban-inject can use it for
 * warm-referral detection.
 *
 * Runs as Step -0.55 in pulse-refresh.mjs (before the Active Pipeline pull).
 *
 * Usage:
 *   node scripts/sync-connections.mjs
 *   node scripts/sync-connections.mjs --dry-run   (count only, write nothing)
 *
 * Requires: AIRTABLE_PAT with data.records:read scope on base appYRJX5x9iVXpbbg.
 *
 * If the "Connections" table does not yet exist, exit code 2 + instructions.
 * Bootstrap it by running: node scripts/seed-connections.mjs
 *
 * Field names expected in the Airtable table:
 *   Company, Name, Position, LinkedIn URL
 *
 * Output: config/linkedin-connections.json
 *   [{company, name, position, url}, ...]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_ID, PAT_MISSING_MSG } from './airtable-sync.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const CONNECTIONS_TABLE = 'Connections';

// ── REST helpers ──────────────────────────────────────────────────────────────

/**
 * GET all records from a named table, paginating via offset.
 * Fields are returned by name (no returnFieldsByFieldId).
 */
export async function listAllByName({ pat, baseId, tableName, fetchImpl = fetch }) {
  const all = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${pat}` } });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      const err = new Error(`Airtable GET "${tableName}" failed: ${res.status} ${res.statusText}${body ? ' — ' + body : ''}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    const json = await res.json();
    all.push(...(json.records || []));
    offset = json.offset;
  } while (offset);
  return all;
}

// ── core sync logic ───────────────────────────────────────────────────────────

/**
 * Pull the Airtable Connections table and write config/linkedin-connections.json.
 *
 * @param {object} opts
 * @param {string}   opts.pat         Airtable PAT
 * @param {string}   [opts.configDir] Directory to write linkedin-connections.json (default: ROOT/config)
 * @param {boolean}  [opts.dryRun]    If true, count records but don't write the file
 * @param {Function} [opts.fetchImpl] Injectable fetch (for tests)
 * @returns {Promise<{ok, count?, error?, notFound?}>}
 */
export async function syncConnections({
  pat,
  configDir = join(ROOT, 'config'),
  dryRun = false,
  fetchImpl = fetch,
} = {}) {
  if (!pat) return { ok: false, error: PAT_MISSING_MSG };

  let records;
  try {
    records = await listAllByName({ pat, baseId: BASE_ID, tableName: CONNECTIONS_TABLE, fetchImpl });
  } catch (e) {
    // 404 = table not found (may be "NOT_FOUND" in Airtable's error body)
    if (e.status === 404 || (e.body && e.body.includes('NOT_FOUND'))) {
      return {
        ok: false,
        notFound: true,
        error: `Airtable table "${CONNECTIONS_TABLE}" not found in base ${BASE_ID}. ` +
          'Bootstrap it by running: node scripts/seed-connections.mjs',
      };
    }
    return { ok: false, error: e.message };
  }

  const connections = records
    .map((r) => {
      const f = r.fields || {};
      return {
        company:  (f['Company']      || '').trim(),
        name:     (f['Name']         || '').trim(),
        position: (f['Position']     || '').trim(),
        url:      (f['LinkedIn URL'] || '').trim(),
      };
    })
    .filter((c) => c.company && c.name);

  if (!dryRun) {
    mkdirSync(configDir, { recursive: true });
    const outPath = join(configDir, 'linkedin-connections.json');
    writeFileSync(outPath, JSON.stringify(connections, null, 1) + '\n');
  }

  return { ok: true, count: connections.length };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

if (IS_CLI) {
  (async () => {
    try { (await import('dotenv')).config(); } catch { /* optional */ }

    const dryRun = process.argv.includes('--dry-run');
    const pat = process.env.AIRTABLE_PAT || null;

    if (!pat) {
      console.error(`[sync-connections] FATAL: ${PAT_MISSING_MSG}`);
      process.exit(1);
    }

    console.log(`[sync-connections] pulling Airtable "${CONNECTIONS_TABLE}" table${dryRun ? ' (dry-run)' : ''}…`);

    const result = await syncConnections({ pat, dryRun });

    if (!result.ok) {
      console.error(`[sync-connections] FAILED: ${result.error}`);
      process.exit(result.notFound ? 2 : 1);
    }

    if (dryRun) {
      console.log(`[sync-connections] dry-run — would write ${result.count} connection(s)`);
    } else {
      const outPath = join(ROOT, 'config', 'linkedin-connections.json');
      console.log(`[sync-connections] wrote ${result.count} connection(s) → ${outPath}`);
    }

    process.exit(0);
  })().catch((e) => {
    console.error('[sync-connections] FATAL:', e.message);
    process.exit(1);
  });
}

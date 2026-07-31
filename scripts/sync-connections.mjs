#!/usr/bin/env node
/**
 * sync-connections.mjs — Keep config/linkedin-connections.json canonical for
 * kanban-inject's warm-referral detection.
 *
 * LOCAL-FIRST (default): config/linkedin-connections.json is the source of
 * truth. This script reads it (falling back to the newest
 * data/airtable-backup-Connections-*.json if the config file is missing or
 * empty), normalizes it, and rewrites it in canonical shape. It does NOT touch
 * Airtable. This is what pulse-refresh.mjs (Step -0.55) runs every night, so
 * the pipeline no longer depends on the Airtable "Connections" table — which
 * was retired to free base record space (error TOO_MANY_RECORDS_IN_BASE).
 *
 * OPT-IN AIRTABLE RE-IMPORT: `node scripts/sync-connections.mjs --from-airtable`
 * pulls the Airtable "Connections" table (if it still exists) and writes it to
 * the local file. Use this only if you deliberately repopulate that table.
 *
 * Usage:
 *   node scripts/sync-connections.mjs                 # local-first (default)
 *   node scripts/sync-connections.mjs --dry-run       # count only, write nothing
 *   node scripts/sync-connections.mjs --from-airtable # legacy Airtable pull
 *
 * Output shape (unchanged): config/linkedin-connections.json
 *   [{company, name, position, url}, ...]
 *
 * Exit codes: 0 = success, 1 = fatal, 2 = Airtable table not found (--from-airtable only)
 */

import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_ID, PAT_MISSING_MSG } from './airtable-sync.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const CONNECTIONS_TABLE = 'Connections';
export const CONNECTIONS_FILE = 'linkedin-connections.json';

// ── normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize one connection into the canonical {company, name, position, url}
 * shape. Accepts either the local shape ({company, name, position, url}) or an
 * Airtable record shape ({fields: {Company, Name, Position, 'LinkedIn URL'}}).
 */
export function normalizeConnection(input) {
  const f = input && input.fields ? input.fields : (input || {});
  return {
    company:  String(f.company  ?? f['Company']      ?? '').trim(),
    name:     String(f.name     ?? f['Name']         ?? '').trim(),
    position: String(f.position ?? f['Position']     ?? '').trim(),
    url:      String(f.url      ?? f['LinkedIn URL'] ?? '').trim(),
  };
}

/** Map + filter a list of raw records into valid canonical connections. */
export function normalizeConnections(list) {
  return (Array.isArray(list) ? list : [])
    .map(normalizeConnection)
    .filter((c) => c.company && c.name);
}

// ── local loaders ─────────────────────────────────────────────────────────────

/** Return the absolute path of the newest data/airtable-backup-Connections-*.json, or null. */
export function newestConnectionsBackup(dataDir = join(ROOT, 'data')) {
  if (!existsSync(dataDir)) return null;
  const files = readdirSync(dataDir)
    .filter((f) => /^airtable-backup-Connections-.*\.json$/.test(f))
    .sort();
  return files.length ? join(dataDir, files[files.length - 1]) : null;
}

/**
 * Load connections local-first: prefer config/<CONNECTIONS_FILE>, and if it is
 * missing / empty / unreadable, fall back to the newest Connections backup in
 * data/. Returns { connections, from } where `from` is 'config' | 'backup' | 'none'.
 */
export function loadLocalConnections({
  configDir = join(ROOT, 'config'),
  dataDir = join(ROOT, 'data'),
} = {}) {
  const configPath = join(configDir, CONNECTIONS_FILE);

  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      const connections = normalizeConnections(parsed);
      if (connections.length) return { connections, from: 'config' };
    } catch { /* fall through to backup */ }
  }

  const backupPath = newestConnectionsBackup(dataDir);
  if (backupPath) {
    try {
      const parsed = JSON.parse(readFileSync(backupPath, 'utf-8'));
      // Backups wrap records under `records`; also tolerate a bare array.
      const raw = Array.isArray(parsed) ? parsed : (parsed.records || parsed.connections || []);
      const connections = normalizeConnections(raw);
      if (connections.length) return { connections, from: 'backup', backupPath };
    } catch { /* fall through */ }
  }

  return { connections: [], from: 'none' };
}

// ── Airtable REST helpers (opt-in re-import path only) ─────────────────────────

/**
 * GET all records from a named table, paginating via offset.
 * Retained for the opt-in `--from-airtable` re-import path and for tests.
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

/**
 * Legacy path: pull the Airtable Connections table and write the local file.
 * Only used when the caller explicitly opts in (--from-airtable).
 */
export async function syncConnectionsFromAirtable({
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
    if (e.status === 404 || (e.body && e.body.includes('NOT_FOUND'))) {
      return {
        ok: false,
        notFound: true,
        error: `Airtable table "${CONNECTIONS_TABLE}" not found in base ${BASE_ID}. ` +
          'Connections are now local-first — run without --from-airtable to use ' +
          'config/linkedin-connections.json, or re-seed with node scripts/seed-connections.mjs.',
      };
    }
    return { ok: false, error: e.message };
  }

  const connections = normalizeConnections(records);

  if (!dryRun) writeConnections(connections, configDir);
  return { ok: true, count: connections.length, source: 'airtable' };
}

// ── writer ────────────────────────────────────────────────────────────────────

/** Write connections to config/<CONNECTIONS_FILE> in the canonical format. */
export function writeConnections(connections, configDir = join(ROOT, 'config')) {
  mkdirSync(configDir, { recursive: true });
  const outPath = join(configDir, CONNECTIONS_FILE);
  writeFileSync(outPath, JSON.stringify(connections, null, 1) + '\n');
  return outPath;
}

// ── core sync (local-first default) ────────────────────────────────────────────

/**
 * Keep config/linkedin-connections.json canonical.
 *
 * @param {object}   opts
 * @param {'local'|'airtable'} [opts.source]  'local' (default) or 'airtable' (opt-in re-import)
 * @param {string}   [opts.pat]        Airtable PAT (only for source='airtable')
 * @param {string}   [opts.configDir]  Directory holding linkedin-connections.json
 * @param {string}   [opts.dataDir]    Directory holding data/ backups
 * @param {boolean}  [opts.dryRun]     If true, don't write the file
 * @param {Function} [opts.fetchImpl]  Injectable fetch (source='airtable' / tests)
 * @returns {Promise<{ok, count?, source?, from?, error?, notFound?}>}
 */
export async function syncConnections({
  source = 'local',
  pat,
  configDir = join(ROOT, 'config'),
  dataDir = join(ROOT, 'data'),
  dryRun = false,
  fetchImpl = fetch,
} = {}) {
  if (source === 'airtable') {
    return syncConnectionsFromAirtable({ pat, configDir, dryRun, fetchImpl });
  }

  const { connections, from } = loadLocalConnections({ configDir, dataDir });
  if (!connections.length) {
    return {
      ok: false,
      from,
      error: `No local connections found in ${join(configDir, CONNECTIONS_FILE)} ` +
        `or any data/airtable-backup-Connections-*.json. ` +
        `Re-import with LinkedIn export or run: node scripts/sync-connections.mjs --from-airtable`,
    };
  }

  if (!dryRun) writeConnections(connections, configDir);
  return { ok: true, count: connections.length, source: 'local', from };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

if (IS_CLI) {
  (async () => {
    try { (await import('dotenv')).config(); } catch { /* optional */ }

    const dryRun = process.argv.includes('--dry-run');
    const fromAirtable = process.argv.includes('--from-airtable');
    const source = fromAirtable ? 'airtable' : 'local';
    const pat = process.env.AIRTABLE_PAT || null;

    if (source === 'airtable' && !pat) {
      console.error(`[sync-connections] FATAL: ${PAT_MISSING_MSG}`);
      process.exit(1);
    }

    console.log(`[sync-connections] source=${source}${dryRun ? ' (dry-run)' : ''}…`);

    const result = await syncConnections({ source, pat, dryRun });

    if (!result.ok) {
      console.error(`[sync-connections] FAILED: ${result.error}`);
      process.exit(result.notFound ? 2 : 1);
    }

    const via = result.from && result.from !== 'config' ? ` (via ${result.from})` : '';
    if (dryRun) {
      console.log(`[sync-connections] dry-run — ${result.count} connection(s) from ${result.source}${via}`);
    } else {
      const outPath = join(ROOT, 'config', CONNECTIONS_FILE);
      console.log(`[sync-connections] wrote ${result.count} connection(s) from ${result.source}${via} → ${outPath}`);
    }

    process.exit(0);
  })().catch((e) => {
    console.error('[sync-connections] FATAL:', e.message);
    process.exit(1);
  });
}

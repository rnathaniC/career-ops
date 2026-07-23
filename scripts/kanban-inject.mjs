#!/usr/bin/env node
/**
 * kanban-inject.mjs — Create Airtable Active Pipeline records for new graded jobs.
 *
 * Reads the newest data/graded-jobs-*.json (worker-grader output), deduplicates
 * against the current kanban-import snapshot + previous inject runs, then POSTs
 * new records to Airtable. Also appends new cards to the local kanban-import file
 * so ingest-runner picks them up in the same pulse-refresh run.
 *
 * Usage:
 *   node scripts/kanban-inject.mjs              # apply mode (creates records)
 *   node scripts/kanban-inject.mjs --dry-run    # print plan only, write nothing
 *   node scripts/kanban-inject.mjs --graded <path>  # override graded-jobs input
 *   node scripts/kanban-inject.mjs --data <dir>     # override data dir (tests)
 *
 * npm aliases (in package.json):
 *   kanban:inject:apply    → node scripts/kanban-inject.mjs
 *   kanban:inject:dry-run  → node scripts/kanban-inject.mjs --dry-run
 *
 * Airtable schema: base appYRJX5x9iVXpbbg, table tbldVU2pHhQjOHjzh (Active Pipeline)
 * Card ID format: live-{date}-{seq}  (e.g. live-2026-06-16-001)
 * Lane: New-Fresh (no referral) — all scan-injected cards start here.
 *
 * Output: data/inject-run-{date}.json
 *   { injected, skipped_dupe, skipped_grade_d, errors, cards_injected[] }
 *
 * Exit codes:
 *   0 = ok (including zero injected — nothing to do)
 *   1 = fatal (missing AIRTABLE_PAT in non-dry-run, unreadable graded file)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASE_ID, ACTIVE_TABLE_ID, ACTIVE_FIELD_IDS, PAT_MISSING_MSG,
} from './airtable-sync.mjs';
import { generateOutreachMessage } from './referral-queue.mjs';

// ── connection matching helpers ───────────────────────────────────────────────

const CORP_SUFFIX_RE = /,?\s+(Inc\.?|LLC\.?|Ltd\.?|Corp\.?|Corporation|Co\.|Company|Incorporated)\.?$/i;

/**
 * Normalise a company name for fuzzy matching: strip common legal suffixes,
 * trim, lowercase.
 * @param {string} name
 * @returns {string}
 */
export function normalizeCompany(name) {
  return (name || '').replace(CORP_SUFFIX_RE, '').trim().toLowerCase();
}

/**
 * Build a Map<normalizedCompanyName, entry[]> from config/linkedin-connections.json.
 * Returns an empty Map if the file is missing or unreadable.
 * @param {string} connectionsPath  Absolute path to linkedin-connections.json
 * @returns {Map<string, object[]>}
 */
export function buildConnectionsMap(connectionsPath) {
  const map = new Map();
  try {
    const conns = JSON.parse(readFileSync(connectionsPath, 'utf8'));
    for (const e of conns) {
      if (!e?.company) continue;
      const key = normalizeCompany(e.company);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
  } catch { /* file missing or invalid JSON — return empty map */ }
  return map;
}

/**
 * Look up all LinkedIn connections for a company and return the full match list.
 * @param {string} company
 * @param {Map<string, object[]>} connByCompany
 * @returns {{
 *   hasConnection: boolean, isWarmReferral: boolean,
 *   connectionName: string, connectionLinkedinUrl: string,
 *   connectionCount: number, connections: Array<{name:string, position:string, url:string}>
 * }}
 */
export function resolveCardConnection(company, connByCompany) {
  const key = normalizeCompany(company);
  const matches = connByCompany.get(key) || [];
  if (!matches.length) {
    return { hasConnection: false, isWarmReferral: false, connectionName: '', connectionLinkedinUrl: '', connectionCount: 0, connections: [] };
  }
  const [first] = matches;
  return {
    hasConnection: true,
    isWarmReferral: true,
    connectionName: first.name || '',
    connectionLinkedinUrl: first.url || '',
    connectionCount: matches.length,
    connections: matches.map((m) => ({ name: m.name || '', position: m.position || '', url: m.url || '' })),
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..');

// ── arg parsing ───────────────────────────────────────────────────────────────

function argVal(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

// ── exported pure / file-I/O helpers (injectable for tests) ───────────────────

/**
 * Find the newest file matching a glob prefix in a directory.
 * @param {string} dataDir
 * @param {RegExp} pattern
 * @returns {string|null}  Full path or null
 */
export function newestMatching(dataDir, pattern) {
  if (!existsSync(dataDir)) return null;
  const files = readdirSync(dataDir)
    .filter((f) => pattern.test(f))
    .map((f) => ({ f, m: statSync(join(dataDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? join(dataDir, files[0].f) : null;
}

/**
 * Build a Set of URLs already known to the pipeline — dedup source for inject.
 * Scans: data/kanban-import-*.json and data/inject-run-*.json.
 * @param {string} dataDir
 * @returns {Set<string>}
 */
export function buildSeenUrls(dataDir) {
  const seen = new Set();

  const kanbanFiles = existsSync(dataDir)
    ? readdirSync(dataDir).filter((f) => /^kanban-import-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    : [];
  for (const f of kanbanFiles) {
    try {
      const cards = JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
      const pool  = Array.isArray(cards) ? cards : [];
      for (const c of pool) { if (c?.url) seen.add(c.url); }
    } catch { /* skip malformed */ }
  }

  const injectFiles = existsSync(dataDir)
    ? readdirSync(dataDir).filter((f) => /^inject-run-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    : [];
  for (const f of injectFiles) {
    try {
      const run = JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
      const injected = Array.isArray(run?.cards_injected) ? run.cards_injected : [];
      for (const c of injected) { if (c?.url) seen.add(c.url); }
    } catch { /* skip malformed */ }
  }

  return seen;
}

/**
 * Find the highest existing card ID sequence number for a given date prefix.
 * Scans kanban-import and inject-run files.
 * @param {string} dataDir
 * @param {string} date   YYYY-MM-DD
 * @returns {number}  Current max seq (0 if none)
 */
export function maxCardSeq(dataDir, date) {
  const prefix = `live-${date}-`;
  let max = 0;

  const sources = existsSync(dataDir)
    ? readdirSync(dataDir)
        .filter((f) => /^(kanban-import|inject-run)-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    : [];

  for (const f of sources) {
    try {
      const raw  = JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
      const cards = Array.isArray(raw) ? raw
        : Array.isArray(raw?.cards_injected) ? raw.cards_injected
        : [];
      for (const c of cards) {
        const id = String(c?.id || '');
        if (id.startsWith(prefix)) {
          const seq = parseInt(id.slice(prefix.length), 10);
          if (!isNaN(seq) && seq > max) max = seq;
        }
      }
    } catch { /* skip */ }
  }
  return max;
}

/**
 * Build an Airtable fields object for a new card (keyed by field ID).
 * @param {object} params
 * @param {string} params.cardId
 * @param {string} params.company
 * @param {string} params.role
 * @param {string} params.grade
 * @param {string} params.platform
 * @param {string} params.url
 * @param {string[]} params.keywords
 * @param {string} params.nowIso
 * @param {boolean} [params.hasConnection=false]
 * @param {boolean} [params.isWarmReferral=false]
 * @param {string}  [params.connectionName='']
 * @param {string}  [params.connectionLinkedinUrl='']
 * @param {number}  [params.connectionCount=0]
 * @param {string}  [params.connectionOptions='']  JSON string of picker payload
 * @returns {object}
 */
export function buildFields({
  cardId, company, role, grade, platform, url, keywords, nowIso,
  hasConnection = false, isWarmReferral = false,
  connectionName = '', connectionLinkedinUrl = '',
  connectionCount = 0, connectionOptions = '',
}) {
  const fields = {
    [ACTIVE_FIELD_IDS['Card ID']]:              cardId,
    [ACTIVE_FIELD_IDS['Company']]:              company || '',
    [ACTIVE_FIELD_IDS['Role']]:                 role    || '',
    [ACTIVE_FIELD_IDS['Grade']]:                grade   || '',
    [ACTIVE_FIELD_IDS['Lane']]:                 hasConnection ? 'New-Hot' : 'New-Fresh',
    [ACTIVE_FIELD_IDS['Platform']]:             platform || '',
    [ACTIVE_FIELD_IDS['URL']]:                  url     || '',
    [ACTIVE_FIELD_IDS['Keywords']]:             Array.isArray(keywords) ? keywords.join(', ') : (keywords || ''),
    [ACTIVE_FIELD_IDS['Created At']]:           nowIso,
    [ACTIVE_FIELD_IDS['Last Refreshed']]:       nowIso,
    [ACTIVE_FIELD_IDS['Has Connection']]:       hasConnection,
    [ACTIVE_FIELD_IDS['Warm Referral']]:        isWarmReferral,
    [ACTIVE_FIELD_IDS['Connection Name']]:      connectionName,
    [ACTIVE_FIELD_IDS['Connection LinkedIn']]:  connectionLinkedinUrl,
  };
  // Only set these when field IDs have been provisioned in Airtable (null = not yet created).
  if (ACTIVE_FIELD_IDS['Connection Count'] != null)
    fields[ACTIVE_FIELD_IDS['Connection Count']] = connectionCount;
  if (ACTIVE_FIELD_IDS['Connection Options'] != null && connectionOptions)
    fields[ACTIVE_FIELD_IDS['Connection Options']] = connectionOptions;
  return fields;
}

/**
 * POST records to Airtable in batches of 10 (API limit).
 * @param {{ pat, baseId, tableId, records, fetchImpl }} opts
 * @returns {Promise<object[]>}  Created Airtable record objects
 */
export async function airtableCreateBatch({ pat, baseId, tableId, records, fetchImpl = fetch }) {
  const created = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const res = await fetchImpl(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ records: batch, returnFieldsByFieldId: true }),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`Airtable POST ${tableId} failed: ${res.status} ${res.statusText}${body ? ' — ' + body : ''}`);
    }
    const json = await res.json();
    created.push(...(json.records || []));
  }
  return created;
}

/**
 * Append new cards to the local kanban-import file so ingest-runner picks them
 * up in the same pipeline run without waiting for the next pull.
 * @param {string}   kanbanImportPath  Path to kanban-import-{date}.json
 * @param {object[]} newCards          Cards to append
 */
export function appendToKanbanImport(kanbanImportPath, newCards) {
  if (!kanbanImportPath || newCards.length === 0) return;
  let existing = [];
  if (existsSync(kanbanImportPath)) {
    try { existing = JSON.parse(readFileSync(kanbanImportPath, 'utf8')); } catch { /* start fresh */ }
    if (!Array.isArray(existing)) existing = [];
  }
  const updated = [...existing, ...newCards];
  writeFileSync(kanbanImportPath, JSON.stringify(updated, null, 2) + '\n');
}

// ── core injection logic ──────────────────────────────────────────────────────

/**
 * Inject graded jobs into Airtable + local kanban-import.
 *
 * @param {object}   opts
 * @param {object[]} opts.gradedJobs      From graded-jobs-*.json
 * @param {Set}      opts.seenUrls        URLs already known (dedup set)
 * @param {string|null} opts.pat          Airtable PAT (null → dry-run only)
 * @param {string}   opts.dataDir         data/ directory
 * @param {string}   opts.date            YYYY-MM-DD
 * @param {boolean}  opts.dryRun          If true, don't write anything
 * @param {Function} opts.fetchImpl       Fetch implementation (injectable for tests)
 * @param {string|null} opts.kanbanImportPath  Path to update (null = skip local update)
 * @param {Map|null} opts.connByCompany   Connection map (injectable for tests; null = load from config)
 * @returns {Promise<{injected, skipped_dupe, skipped_grade_d, errors, cards_injected}>}
 */
export async function injectCards({
  gradedJobs, seenUrls, pat, dataDir, date,
  dryRun = false, fetchImpl = fetch, kanbanImportPath = null,
  connByCompany = null,
}) {
  // Load connections map for warm-referral lane routing.
  let _connByCompany = connByCompany;
  if (_connByCompany == null) {
    const connPath = join(ROOT, 'config', 'linkedin-connections.json');
    _connByCompany = buildConnectionsMap(connPath);
  }

  let seq = maxCardSeq(dataDir, date);
  const nowIso = new Date().toISOString();

  const toInject       = [];
  let skipped_dupe     = 0;
  let skipped_grade_d  = 0;

  for (const job of gradedJobs) {
    if (!job?.url || !job?.company || !job?.role) continue;
    if (job.grade === 'D') { skipped_grade_d++; continue; }
    if (seenUrls.has(job.url)) { skipped_dupe++; continue; }
    seenUrls.add(job.url);
    seq++;
    const cardId = `live-${date}-${String(seq).padStart(3, '0')}`;
    const conn = resolveCardConnection(job.company, _connByCompany);
    const connectionOptions = conn.connections.map((c) => ({
      name:     c.name,
      position: c.position,
      url:      c.url,
      message:  generateOutreachMessage(c.name, job.company, job.role, c.position),
    }));
    const connectionOptionsJson = connectionOptions.length ? JSON.stringify(connectionOptions) : '';
    toInject.push({
      cardId,
      company:  job.company,
      role:     job.role,
      grade:    job.grade,
      platform: job.platform || '',
      url:      job.url,
      keywords: job.keywords_matched || [],
      nowIso,
      ...conn,
      connectionOptions: connectionOptionsJson,
    });
  }

  if (dryRun) {
    console.log(`[kanban-inject] DRY-RUN — would inject ${toInject.length}, skipped ${skipped_dupe} dupe, ${skipped_grade_d} grade-D`);
    for (const c of toInject) {
      console.log(`  [${c.grade}] ${c.company} — ${c.role}  (${c.platform}) → ${c.cardId}`);
    }
    return { injected: 0, skipped_dupe, skipped_grade_d, errors: [], cards_injected: [], dry_run: true };
  }

  if (toInject.length === 0) {
    return { injected: 0, skipped_dupe, skipped_grade_d, errors: [], cards_injected: [] };
  }

  if (!pat) {
    throw new Error(PAT_MISSING_MSG);
  }

  // Build Airtable record payloads.
  const records = toInject.map((c) => ({ fields: buildFields(c) }));

  let created = [];
  const errors = [];
  try {
    created = await airtableCreateBatch({ pat, baseId: BASE_ID, tableId: ACTIVE_TABLE_ID, records, fetchImpl });
  } catch (e) {
    errors.push(e.message);
    return { injected: 0, skipped_dupe, skipped_grade_d, errors, cards_injected: [] };
  }

  // Map created cards into local kanban-import card shape for board-state/ingest.
  const cards_injected = toInject.map((c) => ({
    id:                    c.cardId,
    company:               c.company,
    role:                  c.role,
    grade:                 c.grade,
    platform:              c.platform || '',
    columnId:              c.isWarmReferral ? 'new-hot' : 'new-fresh',
    url:                   c.url,
    keywords:              Array.isArray(c.keywords) ? c.keywords : [],
    jobDescText:           '',
    connectionName:        c.connectionName || '',
    connectionLinkedinUrl: c.connectionLinkedinUrl || '',
    hasConnection:         !!c.hasConnection,
    isWarmReferral:        !!c.isWarmReferral,
    connectionCount:       c.connectionCount || 0,
    connectionOptions:     c.connectionOptions || '',
    createdAt:             c.nowIso,
    lastRefreshed:         c.nowIso,
    closedAt:              null,
  }));

  // Persist new cards into the newest local kanban-import file.
  appendToKanbanImport(kanbanImportPath, cards_injected);

  return {
    injected: cards_injected.length,
    skipped_dupe,
    skipped_grade_d,
    errors,
    cards_injected,
  };
}

async function main() {
  // Bootstrap .env
  try { (await import('dotenv')).config(); } catch { /* optional */ }

  const dryRun    = process.argv.includes('--dry-run');
  const dataArg   = argVal('--data');
  const gradedArg = argVal('--graded');
  const date      = new Date().toISOString().slice(0, 10);
  const dataDir   = dataArg ? resolve(ROOT, dataArg) : join(ROOT, 'data');

  console.log(`[kanban-inject] mode=${dryRun ? 'dry-run' : 'apply'}`);

  // 1. Find graded-jobs file.
  const gradedPath = gradedArg
    ? resolve(ROOT, gradedArg)
    : newestMatching(dataDir, /^graded-jobs-\d{4}-\d{2}-\d{2}\.json$/);

  if (!gradedPath || !existsSync(gradedPath)) {
    console.log('[kanban-inject] no graded-jobs file found — nothing to inject (exit 0)');
    process.exit(0);
  }
  console.log(`[kanban-inject] source: ${gradedPath}`);

  let gradedJobs;
  try {
    gradedJobs = JSON.parse(readFileSync(gradedPath, 'utf8'));
  } catch (e) {
    console.error(`[kanban-inject] FATAL: cannot parse ${gradedPath}: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(gradedJobs)) {
    console.error('[kanban-inject] FATAL: graded-jobs file is not a JSON array');
    process.exit(1);
  }
  console.log(`[kanban-inject] ${gradedJobs.length} graded job(s) to consider`);

  // 2. Build dedup set.
  const seenUrls = buildSeenUrls(dataDir);
  console.log(`[kanban-inject] dedup set: ${seenUrls.size} known URL(s)`);

  // 3. Find current kanban-import to update locally.
  const kanbanImportPath = newestMatching(dataDir, /^kanban-import-\d{4}-\d{2}-\d{2}\.json$/);

  // 4. PAT (not needed for dry-run).
  const pat = process.env.AIRTABLE_PAT || null;
  if (!dryRun && !pat) {
    console.error(`[kanban-inject] FATAL: ${PAT_MISSING_MSG}`);
    process.exit(1);
  }

  // 5. Inject.
  let result;
  try {
    result = await injectCards({
      gradedJobs, seenUrls, pat, dataDir, date, dryRun,
      kanbanImportPath,
    });
  } catch (e) {
    console.error(`[kanban-inject] FATAL: ${e.message}`);
    process.exit(1);
  }

  // 6. Print summary.
  if (!dryRun) {
    console.log(`[kanban-inject] injected=${result.injected} skipped_dupe=${result.skipped_dupe} skipped_grade_d=${result.skipped_grade_d} errors=${result.errors.length}`);
    if (result.errors.length) {
      for (const e of result.errors) console.error(`  ERROR: ${e}`);
    }
  }

  // 7. Write inject-run output (even on dry-run, for observability).
  mkdirSync(dataDir, { recursive: true });
  const outPath = join(dataDir, `inject-run-${date}.json`);
  writeFileSync(outPath, JSON.stringify({
    ran_at: new Date().toISOString(),
    dry_run: dryRun,
    source:  gradedPath,
    ...result,
  }, null, 2) + '\n');
  console.log(`[kanban-inject] written → ${outPath}`);

  if (result.errors.length > 0) process.exit(1);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (IS_CLI) {
  main().catch((e) => { console.error('[kanban-inject] FATAL:', e.message); process.exit(1); });
}

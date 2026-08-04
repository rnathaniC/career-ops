#!/usr/bin/env node
/**
 * airtable-sync.mjs — Two-way sync between local Pulse Engine data and the
 * Airtable "Active Pipeline" base. Closes TODO(Airtable-Sync) in
 * pulse-refresh.mjs (risk r12 — see sync contract below).
 *
 * r12 RESOLVED 2026-07-06: conflict detection now diffs the FULL pushable
 * field set (snapshotFields/diffSnapshot), not just "Last Refreshed" — see
 * BUGS.md r12 for the full writeup of the last-write-wins bug this closes.
 *
 * MODES:
 *   --pull   GET all Active Pipeline records → data/kanban-import-{date}.json
 *            (same array-of-cards shape ingest-runner.mjs / referral-queue.mjs /
 *            airtable-map.mjs already consume) + data/airtable-sync-state.json
 *            (per-card "Last Refreshed" baseline — the conflict clock used on push).
 *
 *   --push   Diff local card state (the newest data/kanban-import-*.json — see
 *            DATA SOURCE NOTE below) against the pull baseline. PATCH only the
 *            cards whose local Last Refreshed is newer than the baseline AND
 *            whose Airtable-side Last Refreshed has NOT also changed since the
 *            pull. If both sides changed, Rahil's Airtable edit wins: the
 *            conflict is logged and that card's local change is skipped, never
 *            overwritten. Push is PATCH-only — it never creates new Active
 *            Pipeline rows, so a card that no longer exists there (moved to
 *            Archive, table tblxzlwcG0hVwvo17) is simply skipped and reported,
 *            never re-created.
 *
 * DATA SOURCE NOTE: push has no dedicated "engine output" file to read yet —
 * none of the orchestrator steps mutate kanban-import-*.json in place today
 * (TODO(Kanban-Update) in pulse-refresh.mjs is still unimplemented). Until that
 * lands, push reads the newest data/kanban-import-*.json (same file --pull just
 * wrote, same selection helper referral-queue.mjs already uses) as the best
 * available mirror of "local card state". Once Kanban-Update writes lane/status
 * changes back into that file with a bumped lastRefreshed, this diff picks them
 * up automatically — no changes needed here.
 *
 * AUTH: AIRTABLE_PAT in .env (personal access token). Missing token exits
 * cleanly (code 1) with a setup hint — this never throws/crashes on a missing key.
 *
 * SCHEMA ASSUMPTION: "Created At" (fldMTpTyX9CzIhazo) is treated as pull-only —
 * it is deliberately omitted from push payloads. If it is a plain editable text
 * field in Airtable (not a Created-Time/formula field) and Rahil wants the
 * engine to set it, add it to cardToFields() below.
 *
 * Usage:
 *   node scripts/airtable-sync.mjs --pull
 *   node scripts/airtable-sync.mjs --push
 *   node scripts/airtable-sync.mjs --pull --data data   (override data dir, mainly for tests)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newestKanbanImport } from './referral-queue.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── Airtable schema (base appYRJX5x9iVXpbbg) — sync contract risk r12 ────────

export const BASE_ID = 'appYRJX5x9iVXpbbg';
export const ACTIVE_TABLE_ID = 'tbldVU2pHhQjOHjzh';
export const ARCHIVE_TABLE_ID = 'tblxzlwcG0hVwvo17'; // not queried directly — see push() comment

// name -> field ID (Active Pipeline). Mirrors ACTIVE_FIELD_IDS in airtable-map.mjs.
export const ACTIVE_FIELD_IDS = {
  'Card ID': 'fldtRjBnJk7fsH6VX', 'Company': 'fldaAdo3CyQX1yttd', 'Role': 'fldtDd16kgRxSoU0N',
  'Grade': 'fldEu8xXUx0QLlQAG', 'Lane': 'fldxDdSwovNaHtaCL', 'Platform': 'fldlKMfzFGo12RSw1',
  'URL': 'fldPp4nDoFldT2ZKc', 'Job Description': 'fld0MDcXVWGtInqnL', 'Keywords': 'fldyDJNWfldoMDVqt',
  'Connection Name': 'fldEpnNHzAkWkGNhb', 'Connection LinkedIn': 'fldFk5zF7iOdDhNXW',
  'Has Connection': 'fld3E2xL0wG1yKxAq', 'Warm Referral': 'fldi1rAwieHmASoax',
  'Created At': 'fldMTpTyX9CzIhazo', 'Last Refreshed': 'fld4hdyB6a8qjzeSZ', 'Notes': 'fldGkJ4cqoLE3yFCa',
  // Multi-connection referral picker. Create fields then replace null with the returned IDs:
  //   curl -X POST https://api.airtable.com/v0/meta/bases/appYRJX5x9iVXpbbg/tables/tbldVU2pHhQjOHjzh/fields \
  //     -H "Authorization: Bearer $AIRTABLE_PAT" -H "Content-Type: application/json" \
  //     -d '{"name":"Connection Count","type":"number","options":{"precision":0}}'
  //   curl -X POST https://api.airtable.com/v0/meta/bases/appYRJX5x9iVXpbbg/tables/tbldVU2pHhQjOHjzh/fields \
  //     -H "Authorization: Bearer $AIRTABLE_PAT" -H "Content-Type: application/json" \
  //     -d '{"name":"Connection Options","type":"multilineText"}'
  'Connection Count': 'flddqet5ZZSumFns4',    // TODO: replace with field ID after Airtable field creation
  'Connection Options': 'fldJu7vzBJaawmMDD',  // TODO: replace with field ID after Airtable field creation
};
export const CARD_ID_FIELD = ACTIVE_FIELD_IDS['Card ID'];
export const LAST_REFRESHED_FIELD = ACTIVE_FIELD_IDS['Last Refreshed'];

// Field names checked for remote drift on push (everything pushable except
// "Created At", which cardToFields() never writes — see SCHEMA ASSUMPTION
// above). r12 FIX (2026-07-06): conflict detection used to compare ONLY the
// hand-maintained "Last Refreshed" field, which is a plain text/date field
// that only OUR OWN pull/push code ever writes. Rahil editing a card directly
// in the Airtable UI (Notes, Lane, Company, whatever) never bumps that field,
// so the old check saw remote == baseline, called it "unchanged", and pushed
// stale local data straight over his edit — a silent last-write-wins loss.
// The fix: snapshot every pushable field at pull time and diff the FULL set
// at push time, so drift on ANY field (not just Last Refreshed) is caught.
export const CONFLICT_CHECK_FIELD_NAMES = Object.keys(ACTIVE_FIELD_IDS).filter((name) => name !== 'Created At');

// Lane singleSelect choice IDs — informational only. Values are read/written by
// *name* (e.g. "New-Hot"): Airtable's REST API represents singleSelect field
// values as the option name string in both directions, not the option ID.
export const LANE_CHOICE_IDS = {
  'New-Hot': 'selxxpMgvOd53LfMM', 'New-Fresh': 'selrDS5gcvgundDFs',
  'Blocked': 'seld0VnKtx0QfPKU1', 'Submit Ready': 'sel4EsHp3vQIYyKTh', 'Applied': 'seldP0DjSPBNtLQ3V',
};
// "Submit Ready" (added 2026-08-02): auto-fill-to-submit-ready lane. The engine
// fills the application completely (real resume attached) and parks the card here;
// Rahil makes the final human Submit click (passes the reCAPTCHA gate that blocks
// automated clicks), after which the card moves to Applied.
export const COLUMN_TO_LANE_NAME = { 'new-hot': 'New-Hot', 'new-fresh': 'New-Fresh', 'blocked': 'Blocked', 'submit-ready': 'Submit Ready', 'applied': 'Applied' };
export const LANE_NAME_TO_COLUMN = Object.fromEntries(Object.entries(COLUMN_TO_LANE_NAME).map(([k, v]) => [v, k]));

export const PAT_MISSING_MSG =
  'AIRTABLE_PAT not set. Add it to .env (see .env.example) — create a personal access ' +
  `token at https://airtable.com/create/tokens with data.records:read + data.records:write ` +
  `scopes on base ${BASE_ID}.`;

// ─── mapping: Airtable record <-> local card (kanban-import shape) ───────────

/**
 * Map one Airtable record (fields keyed by field ID — i.e. fetched with
 * returnFieldsByFieldId=true) to the local card shape consumed by
 * referral-queue.mjs / ingest-runner.mjs / airtable-map.mjs.
 * @param {{id: string, fields: object}} record
 * @returns {object} card
 */
export function recordToCard(record) {
  const f = record.fields || {};
  const get = (name) => f[ACTIVE_FIELD_IDS[name]];
  const laneName = get('Lane') || 'New-Fresh';
  const keywordsRaw = get('Keywords');
  return {
    id: get('Card ID') || null,
    company: get('Company') || '',
    role: get('Role') || '',
    grade: get('Grade') || '',
    columnId: LANE_NAME_TO_COLUMN[laneName] || 'new-fresh',
    platform: get('Platform') || '',
    url: get('URL') || '',
    jobDescText: get('Job Description') || '',
    keywords: typeof keywordsRaw === 'string'
      ? keywordsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : Array.isArray(keywordsRaw) ? keywordsRaw : [],
    connectionName: get('Connection Name') || '',
    connectionLinkedinUrl: get('Connection LinkedIn') || '',
    hasConnection: !!get('Has Connection'),
    isWarmReferral: !!get('Warm Referral'),
    createdAt: get('Created At') || '',
    lastRefreshed: get('Last Refreshed') || '',
    notes: get('Notes') || '',
    closedAt: null,
    _airtableRecordId: record.id,
  };
}

/**
 * Map a local card to an Airtable fields object (keyed by field ID), ready for
 * a PATCH body. "Created At" is intentionally omitted — see SCHEMA ASSUMPTION
 * in the file header.
 * @param {object} card
 * @returns {object} fields keyed by field ID
 */
export function cardToFields(card) {
  const laneName = COLUMN_TO_LANE_NAME[card.columnId] || 'New-Fresh';
  return {
    [ACTIVE_FIELD_IDS['Card ID']]: card.id,
    [ACTIVE_FIELD_IDS['Company']]: card.company || '',
    [ACTIVE_FIELD_IDS['Role']]: card.role || '',
    [ACTIVE_FIELD_IDS['Grade']]: card.grade || '',
    [ACTIVE_FIELD_IDS['Lane']]: laneName,
    [ACTIVE_FIELD_IDS['Platform']]: card.platform || '',
    [ACTIVE_FIELD_IDS['URL']]: card.url || '',
    [ACTIVE_FIELD_IDS['Job Description']]: (card.jobDescText || '').slice(0, 2000),
    [ACTIVE_FIELD_IDS['Keywords']]: Array.isArray(card.keywords) ? card.keywords.join(', ') : (card.keywords || ''),
    [ACTIVE_FIELD_IDS['Connection Name']]: card.connectionName || '',
    [ACTIVE_FIELD_IDS['Connection LinkedIn']]: card.connectionLinkedinUrl || '',
    [ACTIVE_FIELD_IDS['Has Connection']]: !!card.hasConnection,
    [ACTIVE_FIELD_IDS['Warm Referral']]: !!card.isWarmReferral,
    [ACTIVE_FIELD_IDS['Last Refreshed']]: card.lastRefreshed || '',
    [ACTIVE_FIELD_IDS['Notes']]: card.notes || '',
  };
}

// ─── timestamp helpers (conflict clock) ───────────────────────────────────────

export function isNewer(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta > tb;
}

export function sameTimestamp(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
}

/**
 * Snapshot the pushable fields of a record (fields keyed by field ID) for
 * conflict-drift comparison. Missing values normalize to null so "field
 * absent" and "field explicitly empty" compare equal.
 * @param {object} fields - record.fields, keyed by Airtable field ID
 * @returns {object} snapshot keyed by field ID
 */
export function snapshotFields(fields = {}) {
  const out = {};
  for (const name of CONFLICT_CHECK_FIELD_NAMES) {
    const fieldId = ACTIVE_FIELD_IDS[name];
    out[fieldId] = fields?.[fieldId] ?? null;
  }
  return out;
}

/**
 * Compare two field snapshots (same shape as snapshotFields()) and return the
 * list of field IDs whose value differs.
 * @returns {string[]} field IDs that drifted
 */
export function diffSnapshot(a, b) {
  if (!a || !b) return [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const k of keys) {
    const av = a[k] ?? null;
    const bv = b[k] ?? null;
    if (JSON.stringify(av) !== JSON.stringify(bv)) changed.push(k);
  }
  return changed;
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Airtable REST client (fetchImpl injectable for tests) ───────────────────

/**
 * GET all records from a table, paginating via `offset`. Always requests
 * returnFieldsByFieldId=true so callers can key off ACTIVE_FIELD_IDS.
 */
export async function airtableListAll({ pat, baseId, tableId, fetchImpl = fetch, filterByFormula = null } = {}) {
  const all = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${tableId}`);
    url.searchParams.set('returnFieldsByFieldId', 'true');
    url.searchParams.set('pageSize', '100');
    if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${pat}` } });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`Airtable GET ${tableId} failed: ${res.status} ${res.statusText}${body ? ' — ' + body : ''}`);
    }
    const json = await res.json();
    all.push(...(json.records || []));
    offset = json.offset;
  } while (offset);
  return all;
}

/** PATCH records in batches of 10 (Airtable's per-request limit). */
export async function airtablePatchBatch({ pat, baseId, tableId, records, fetchImpl = fetch }) {
  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const res = await fetchImpl(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch, returnFieldsByFieldId: true }),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`Airtable PATCH ${tableId} failed: ${res.status} ${res.statusText}${body ? ' — ' + body : ''}`);
    }
    const json = await res.json();
    results.push(...(json.records || []));
  }
  return results;
}

// ─── local card state ──────────────────────────────────────────────────────

/** Read the newest data/kanban-import-*.json — see DATA SOURCE NOTE above. */
export function readLocalCards(dataDir) {
  const source = newestKanbanImport(dataDir);
  if (!source) return [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(source, 'utf8'));
  } catch {
    return [];
  }
  const pool = Array.isArray(raw) ? raw
    : Array.isArray(raw.cards) ? raw.cards
    : raw.cards && typeof raw.cards === 'object' ? Object.values(raw.cards)
    : Object.values(raw);
  return pool.filter((c) => c && typeof c === 'object');
}

// ─── --pull ────────────────────────────────────────────────────────────────

/**
 * Pull all Active Pipeline records into data/kanban-import-{dateStr}.json and
 * write data/airtable-sync-state.json (the conflict-clock baseline for push).
 */
export async function pull({
  pat, dataDir, dateStr = todayStamp(), fetchImpl = fetch, baseId = BASE_ID, tableId = ACTIVE_TABLE_ID,
} = {}) {
  if (!pat) return { ok: false, error: PAT_MISSING_MSG };

  let records;
  try {
    records = await airtableListAll({ pat, baseId, tableId, fetchImpl });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const withCardId = records.filter((r) => r.fields && r.fields[CARD_ID_FIELD]);
  const skipped = records.length - withCardId.length;
  const cards = withCardId.map(recordToCard);

  const outPath = join(dataDir, `kanban-import-${dateStr}.json`);
  const statePath = join(dataDir, 'airtable-sync-state.json');

  const cardsForFile = cards.map(({ _airtableRecordId, ...rest }) => rest);
  writeFileSync(outPath, JSON.stringify(cardsForFile, null, 2) + '\n');

  const state = {
    synced_at_utc: new Date().toISOString(),
    base: baseId,
    table: tableId,
    cards: Object.fromEntries(
      cards.map((c, i) => [c.id, {
        lastRefreshed: c.lastRefreshed,
        recordId: c._airtableRecordId,
        // r12 FIX: full-field snapshot, not just Last Refreshed — see
        // CONFLICT_CHECK_FIELD_NAMES comment above for why.
        fieldsSnapshot: snapshotFields(withCardId[i].fields),
      }])
    ),
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

  return { ok: true, count: cards.length, skipped, outPath, statePath };
}

// ─── --push ────────────────────────────────────────────────────────────────

/**
 * Diff local card state against the pull baseline and PATCH only cards that
 * changed locally and have not also drifted on the Airtable side. See file
 * header for the full conflict-resolution contract.
 */
export async function push({
  pat, dataDir, fetchImpl = fetch, baseId = BASE_ID, tableId = ACTIVE_TABLE_ID, localCards = null,
} = {}) {
  if (!pat) return { ok: false, error: PAT_MISSING_MSG };

  const statePath = join(dataDir, 'airtable-sync-state.json');
  if (!existsSync(statePath)) {
    return { ok: false, error: `No airtable-sync-state.json in ${dataDir} — run --pull first so push has a conflict baseline.` };
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `Could not parse ${statePath}: ${e.message}` };
  }
  const baseline = state.cards || {};

  const local = localCards || readLocalCards(dataDir);
  const candidates = local.filter(
    (c) => c && c.id && baseline[c.id] && isNewer(c.lastRefreshed, baseline[c.id].lastRefreshed)
  );

  if (candidates.length === 0) {
    return { ok: true, pushed: 0, conflicts: [], archived: [], message: 'nothing to push — no local card changed since last pull' };
  }

  // Re-fetch current Active Pipeline state for just these candidates: this is
  // how we detect (a) a card Rahil also edited in Airtable since the pull
  // (conflict — his edit wins) and (b) a card that's been archived (moved off
  // Active Pipeline) since the pull — push never re-creates those.
  const formula = 'OR(' + candidates.map((c) => `{Card ID}='${String(c.id).replace(/'/g, "\\'")}'`).join(',') + ')';
  let currentRecords;
  try {
    currentRecords = await airtableListAll({ pat, baseId, tableId, fetchImpl, filterByFormula: formula });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const currentByCardId = new Map();
  for (const r of currentRecords) {
    const cid = r.fields?.[CARD_ID_FIELD];
    if (cid) currentByCardId.set(cid, r);
  }

  const toPush = [];
  const conflicts = [];
  const archived = [];
  for (const c of candidates) {
    const current = currentByCardId.get(c.id);
    if (!current) {
      archived.push(c.id);
      continue;
    }
    const remoteFields = current.fields || {};
    const remoteLastRefreshed = remoteFields[LAST_REFRESHED_FIELD];
    const baselineEntry = baseline[c.id];
    const baselineLastRefreshed = baselineEntry.lastRefreshed;

    // r12 FIX: prefer full-field drift detection over the old Last-Refreshed-only
    // check, since a manual Airtable edit (or any direct-PATCH call site, e.g.
    // archive-stale.mjs's flow-tag write) can change a field WITHOUT bumping
    // Last Refreshed, which used to slip past conflict detection entirely.
    // Fall back to the legacy timestamp-only check for baselines written before
    // this fix (no fieldsSnapshot yet) so an old sync-state.json doesn't crash.
    let conflicted;
    let driftedFields = [];
    if (baselineEntry.fieldsSnapshot) {
      driftedFields = diffSnapshot(baselineEntry.fieldsSnapshot, snapshotFields(remoteFields));
      conflicted = driftedFields.length > 0;
    } else {
      conflicted = !sameTimestamp(remoteLastRefreshed, baselineLastRefreshed);
    }

    if (conflicted) {
      conflicts.push({ id: c.id, baseline: baselineLastRefreshed, remote: remoteLastRefreshed, driftedFields });
      continue;
    }
    toPush.push({ id: current.id, fields: cardToFields(c) });
  }

  let pushedRecords = [];
  if (toPush.length) {
    try {
      pushedRecords = await airtablePatchBatch({ pat, baseId, tableId, records: toPush, fetchImpl });
    } catch (e) {
      return { ok: false, error: e.message, conflicts, archived };
    }
    // Roll the baseline forward for cards we just pushed, so a second push in
    // the same run (no intervening pull) doesn't re-diff them as "changed".
    for (const r of pushedRecords) {
      const cid = r.fields?.[CARD_ID_FIELD];
      if (cid && state.cards[cid]) {
        state.cards[cid].lastRefreshed = r.fields?.[LAST_REFRESHED_FIELD] ?? state.cards[cid].lastRefreshed;
        state.cards[cid].recordId = r.id;
        // r12 FIX: refresh the drift-check snapshot to the just-pushed truth too,
        // so a same-run second push doesn't re-diff these fields as changed.
        state.cards[cid].fieldsSnapshot = snapshotFields(r.fields || {});
      }
    }
    state.synced_at_utc = new Date().toISOString();
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  }

  return { ok: true, pushed: pushedRecords.length, conflicts, archived };
}

// ── CLI guard (prevents main() from running on import) ────────────────────────

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function main() {
  // Bootstrap .env (optional dependency, mirrors gemini-eval.mjs).
  try {
    const { config } = await import('dotenv');
    config();
  } catch { /* dotenv optional */ }

  const doPull = process.argv.includes('--pull');
  const doPush = process.argv.includes('--push');
  if (!doPull && !doPush) {
    console.error('[airtable-sync] Usage: node scripts/airtable-sync.mjs --pull | --push');
    process.exit(2);
  }

  const dataDir = resolve(ROOT, arg('--data', 'data'));
  const pat = process.env.AIRTABLE_PAT || null;
  if (!pat) {
    console.error(`[airtable-sync] FATAL: ${PAT_MISSING_MSG}`);
    process.exit(1);
  }

  if (doPull) {
    const res = await pull({ pat, dataDir });
    if (!res.ok) {
      console.error(`[airtable-sync] PULL FAILED: ${res.error}`);
      process.exit(1);
    }
    console.log(`[airtable-sync] PULL ok — ${res.count} card(s) → ${res.outPath} (skipped ${res.skipped} record(s) with no Card ID)`);
    console.log(`[airtable-sync] sync-state → ${res.statePath}`);
  }

  if (doPush) {
    const res = await push({ pat, dataDir });
    if (!res.ok) {
      console.error(`[airtable-sync] PUSH FAILED: ${res.error}`);
      process.exit(1);
    }
    console.log(`[airtable-sync] PUSH ok — ${res.pushed} card(s) updated${res.message ? ' (' + res.message + ')' : ''}`);
    if (res.conflicts?.length) {
      console.warn(`[airtable-sync] WARN ${res.conflicts.length} conflict(s) — Airtable side changed since pull, local push skipped for: ${res.conflicts.map((c) => c.id).join(', ')}`);
    }
    if (res.archived?.length) {
      console.log(`[airtable-sync] ${res.archived.length} card(s) not found in Active Pipeline (likely archived) — not re-created: ${res.archived.join(', ')}`);
    }
  }

  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (IS_CLI) {
  main().catch((e) => {
    console.error(`[airtable-sync] FATAL: ${e.message}`);
    process.exit(1);
  });
}

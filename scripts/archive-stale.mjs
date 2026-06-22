#!/usr/bin/env node
/**
 * archive-stale.mjs — Staleness/auto-archive engine for the Active Pipeline
 *
 * Two intake lanes age out on their own clock:
 *   New-Fresh  archived after 33h
 *   New-Hot    archived after 99h
 * "Archived" = create the row in the Archive table (tblxzlwcG0hVwvo17, base
 * appYRJX5x9iVXpbbg), then delete it from Active Pipeline (tbldVU2pHhQjOHjzh) —
 * create-then-delete, never the reverse, so a failed create never loses data.
 *
 * FLOW TAG: if a card leaves New-Fresh/New-Hot for any other lane (Applied,
 * Blocked, or anything else — including New-Fresh <-> New-Hot) before its
 * threshold fires, a `[flow:{from}→{to} {date}]` line is prepended to Notes
 * (fldGkJ4cqoLE3yFCa) — never overwriting the rest of Notes. Lane transitions
 * are detected by diffing today's live Active Pipeline state against
 * data/kanban-import-{yesterday}.json (the previous day's pulled snapshot).
 * No snapshot for yesterday → flow-tag detection is skipped this run (logged
 * in summary.notes), but staleness/archiving still runs normally.
 *
 * STALENESS CLOCK: uses Created At (fldMTpTyX9CzIhazo) as the lane-entry time,
 * since that's when the card entered the system (and its intake lane). This is
 * an approximation — a card that moved New-Fresh -> New-Hot -> back to
 * New-Fresh keeps its original Created At, not the time of its latest lane
 * entry. A dedicated "Lane Entered At" field (set on every lane change) would
 * be the accurate fix; until that exists, Created At is the best available
 * signal.
 *
 * ARCHIVE TABLE SCHEMA: field IDs on the Archive table are NOT assumed to
 * match Active Pipeline's. fetchArchiveFieldMap() calls
 * GET /v0/meta/bases/{baseId}/tables once per --apply run, matches Archive
 * fields to Active Pipeline fields BY NAME, and logs (to summary.errors) any
 * Active Pipeline field name with no same-named counterpart on Archive — those
 * columns are simply left blank on the archived row rather than failing the
 * whole run.
 *
 * AUTH: AIRTABLE_PAT in .env. Missing token exits cleanly (code 1), never throws.
 *
 * Usage:
 *   node scripts/archive-stale.mjs --dry-run     (default — prints, writes nothing)
 *   node scripts/archive-stale.mjs --apply       (executes archive + tag writes)
 *   node scripts/archive-stale.mjs --apply --data data --date 2026-06-16  (mainly for tests/manual reruns)
 *
 * Always writes data/archive-run-{date}.json: { archived, tagged_flow, dry_run, errors }.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_ID, ACTIVE_TABLE_ID, ARCHIVE_TABLE_ID, ACTIVE_FIELD_IDS, CARD_ID_FIELD,
  COLUMN_TO_LANE_NAME, PAT_MISSING_MSG, airtableListAll, airtablePatchBatch,
} from './airtable-sync.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── staleness rules ──────────────────────────────────────────────────────

export const ARCHIVE_THRESHOLD_HOURS = { 'New-Fresh': 33, 'New-Hot': 99 };

/** Hours between createdAt and now. Returns null if createdAt can't be parsed. */
export function hoursSince(createdAt, now = new Date()) {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return null;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (Number.isNaN(nowMs)) return null;
  return (nowMs - t) / (1000 * 60 * 60);
}

/** Is this card past its lane's archive threshold? Lanes with no threshold (Applied, Blocked, …) never auto-archive. */
export function isStale(laneName, createdAt, now = new Date()) {
  const threshold = ARCHIVE_THRESHOLD_HOURS[laneName];
  if (threshold == null) return false;
  const hrs = hoursSince(createdAt, now);
  if (hrs == null) return false; // unparseable Created At — fail safe, don't archive
  return hrs >= threshold;
}

// ─── flow tag ─────────────────────────────────────────────────────────────

export function buildFlowTag(fromLane, toLane, dateStr) {
  return `[flow:${fromLane}→${toLane} ${dateStr}]`;
}

/** Prepend tag as its own line, never touching the rest of Notes. Idempotent — a tag already present is left alone. */
export function prependFlowTag(notes, tag) {
  const existing = notes || '';
  if (existing.split('\n').includes(tag)) return existing;
  return existing ? `${tag}\n${existing}` : tag;
}

// ─── yesterday's snapshot (flow-transition diff source) ────────────────────

function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** cardId -> columnId map from data/kanban-import-{dateStr}.json, or null if the file doesn't exist / can't be parsed. */
export function loadPreviousLaneMap(dataDir, dateStr) {
  const file = join(dataDir, `kanban-import-${dateStr}.json`);
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const pool = Array.isArray(raw) ? raw : Array.isArray(raw.cards) ? raw.cards : [];
  const map = new Map();
  for (const c of pool) {
    if (c && c.id) map.set(c.id, c.columnId || null);
  }
  return map;
}

// ─── Archive table schema discovery ─────────────────────────────────────────

/**
 * Match Archive table fields to Active Pipeline fields by name via the meta
 * API. Returns { ok, fieldMap (Active field name -> Archive field id), unmapped }
 * or { ok: false, error }.
 */
export async function fetchArchiveFieldMap({ pat, baseId = BASE_ID, archiveTableId = ARCHIVE_TABLE_ID, fetchImpl = fetch }) {
  const url = `https://api.airtable.com/v0/meta/bases/${baseId}/tables`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${pat}` } });
  } catch (e) {
    return { ok: false, error: `Airtable meta/tables request failed: ${e.message}` };
  }
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    return { ok: false, error: `Airtable meta/tables failed: ${res.status} ${res.statusText}${body ? ' — ' + body : ''}` };
  }
  const json = await res.json();
  const table = (json.tables || []).find((t) => t.id === archiveTableId);
  if (!table) return { ok: false, error: `Archive table ${archiveTableId} not found in meta/tables response` };

  const archiveByName = new Map((table.fields || []).map((f) => [f.name, f.id]));
  const fieldMap = {};
  const unmapped = [];
  for (const name of Object.keys(ACTIVE_FIELD_IDS)) {
    if (archiveByName.has(name)) fieldMap[name] = archiveByName.get(name);
    else unmapped.push(name);
  }
  return { ok: true, fieldMap, unmapped };
}

/** Map one Active Pipeline record's fields (keyed by Active field ID) to an Archive fields object (keyed by Archive field ID), using the name-matched map above. Unmapped names are skipped (left blank on the archived row). */
export function mapActiveFieldsToArchive(activeFields, fieldMap) {
  const out = {};
  for (const [name, activeFieldId] of Object.entries(ACTIVE_FIELD_IDS)) {
    const archiveFieldId = fieldMap[name];
    if (!archiveFieldId) continue;
    out[archiveFieldId] = activeFields[activeFieldId];
  }
  return out;
}

// ─── Airtable REST helpers (create + delete batches; PATCH reused from airtable-sync.mjs) ──

/** POST records to a table in batches of 10 (Airtable's per-request limit). */
export async function airtableCreateBatch({ pat, baseId, tableId, records, fetchImpl = fetch }) {
  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const res = await fetchImpl(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch.map((fields) => ({ fields })), returnFieldsByFieldId: true }),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`Airtable POST ${tableId} failed: ${res.status} ${res.statusText}${body ? ' — ' + body : ''}`);
    }
    const json = await res.json();
    results.push(...(json.records || []));
  }
  return results;
}

/** DELETE records from a table in batches of 10. */
export async function airtableDeleteBatch({ pat, baseId, tableId, recordIds, fetchImpl = fetch }) {
  const results = [];
  for (let i = 0; i < recordIds.length; i += 10) {
    const batch = recordIds.slice(i, i + 10);
    const params = batch.map((id) => `records[]=${encodeURIComponent(id)}`).join('&');
    const res = await fetchImpl(`https://api.airtable.com/v0/${baseId}/${tableId}?${params}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${pat}` },
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`Airtable DELETE ${tableId} failed: ${res.status} ${res.statusText}${body ? ' — ' + body : ''}`);
    }
    const json = await res.json();
    results.push(...(json.records || []));
  }
  return results;
}

// ─── engine ──────────────────────────────────────────────────────────────

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Run one archive/flow-tag pass against the live Active Pipeline.
 * @returns {Promise<object>} { ok, archived, tagged_flow, dry_run, errors, notes, outPath } or { ok: false, error }
 */
export async function run({
  pat, dataDir, dateStr = todayStamp(), now = new Date(), fetchImpl = fetch,
  baseId = BASE_ID, activeTableId = ACTIVE_TABLE_ID, archiveTableId = ARCHIVE_TABLE_ID,
  apply = false,
} = {}) {
  if (!pat) return { ok: false, error: PAT_MISSING_MSG };

  let records;
  try {
    records = await airtableListAll({ pat, baseId, tableId: activeTableId, fetchImpl });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const yesterdayStr = shiftDate(dateStr, -1);
  const prevLaneMap = loadPreviousLaneMap(dataDir, yesterdayStr);
  const hadPrevSnapshot = prevLaneMap !== null;

  const notes = [];
  if (!hadPrevSnapshot) {
    notes.push(`No previous-day snapshot (data/kanban-import-${yesterdayStr}.json) — flow-tag detection skipped this run.`);
  }

  const errors = [];
  const toArchive = [];
  const toTag = [];

  for (const record of records) {
    const fields = record.fields || {};
    const cardId = fields[CARD_ID_FIELD];
    const laneName = fields[ACTIVE_FIELD_IDS['Lane']] || 'New-Fresh';
    const createdAt = fields[ACTIVE_FIELD_IDS['Created At']];

    if (!cardId) continue; // no upsert key, nothing we can safely act on

    if (laneName === 'New-Fresh' || laneName === 'New-Hot') {
      if (ARCHIVE_THRESHOLD_HOURS[laneName] != null && hoursSince(createdAt, now) == null) {
        errors.push(`Card ${cardId} in ${laneName} has unparseable Created At ("${createdAt}") — skipped staleness check.`);
        continue;
      }
      if (isStale(laneName, createdAt, now)) {
        toArchive.push({ record, cardId, laneName, createdAt });
      }
      continue;
    }

    // Card is in some other lane now (Applied, Blocked, …) — did it just flow
    // out of a threshold lane since yesterday's snapshot?
    if (!hadPrevSnapshot) continue;
    const prevColumnId = prevLaneMap.get(cardId);
    if (!prevColumnId) continue;
    const prevLaneName = COLUMN_TO_LANE_NAME[prevColumnId] || prevColumnId;
    if ((prevLaneName === 'New-Fresh' || prevLaneName === 'New-Hot') && prevLaneName !== laneName) {
      toTag.push({ record, cardId, fromLane: prevLaneName, toLane: laneName });
    }
  }

  // ── flow tags ──
  const taggedFlow = [];
  const tagPatches = [];
  for (const t of toTag) {
    const tag = buildFlowTag(t.fromLane, t.toLane, dateStr);
    const currentNotes = t.record.fields?.[ACTIVE_FIELD_IDS['Notes']] || '';
    const newNotes = prependFlowTag(currentNotes, tag);
    if (newNotes === currentNotes) continue; // already tagged for this transition — idempotent skip
    tagPatches.push({ id: t.record.id, fields: { [ACTIVE_FIELD_IDS['Notes']]: newNotes } });
    taggedFlow.push({ cardId: t.cardId, tag });
  }

  if (apply && tagPatches.length) {
    try {
      await airtablePatchBatch({ pat, baseId, tableId: activeTableId, records: tagPatches, fetchImpl });
    } catch (e) {
      errors.push(`Flow tag PATCH failed: ${e.message}`);
    }
  }

  // ── archiving ──
  const archived = [];
  if (toArchive.length) {
    if (!apply) {
      for (const a of toArchive) archived.push({ cardId: a.cardId, lane: a.laneName, createdAt: a.createdAt });
    } else {
      const fieldMapRes = await fetchArchiveFieldMap({ pat, baseId, archiveTableId, fetchImpl });
      if (!fieldMapRes.ok) {
        errors.push(`Archive field mapping failed — archiving skipped this run: ${fieldMapRes.error}`);
      } else {
        if (fieldMapRes.unmapped.length) {
          errors.push(`Archive table has no field matching Active Pipeline name(s): ${fieldMapRes.unmapped.join(', ')} — those columns will be blank on archived rows.`);
        }
        for (let i = 0; i < toArchive.length; i += 10) {
          const batch = toArchive.slice(i, i + 10);
          const archiveFieldsBatch = batch.map((a) => mapActiveFieldsToArchive(a.record.fields, fieldMapRes.fieldMap));
          let created;
          try {
            created = await airtableCreateBatch({ pat, baseId, tableId: archiveTableId, records: archiveFieldsBatch, fetchImpl });
          } catch (e) {
            errors.push(`Archive create failed for batch starting at card ${batch[0].cardId}: ${e.message}`);
            continue;
          }
          if (created.length !== batch.length) {
            errors.push(`Archive create returned ${created.length} record(s) for a batch of ${batch.length} starting at card ${batch[0].cardId} — skipping delete for this batch as a precaution.`);
            continue;
          }
          const activeIds = batch.map((a) => a.record.id);
          try {
            await airtableDeleteBatch({ pat, baseId, tableId: activeTableId, recordIds: activeIds, fetchImpl });
            for (const a of batch) archived.push({ cardId: a.cardId, lane: a.laneName, createdAt: a.createdAt });
          } catch (e) {
            errors.push(`Archive create succeeded but delete from Active Pipeline failed for batch starting at card ${batch[0].cardId}: ${e.message} — these card(s) now exist in BOTH tables, needs manual cleanup.`);
          }
        }
      }
    }
  }

  const summary = { archived, tagged_flow: taggedFlow, dry_run: !apply, errors, notes };
  const outPath = join(dataDir, `archive-run-${dateStr}.json`);
  try {
    writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  } catch (e) {
    errors.push(`Could not write ${outPath}: ${e.message}`);
  }

  return { ok: true, ...summary, outPath };
}

// ── CLI guard (prevents main() from running on import) ────────────────────────

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function main() {
  try {
    const { config } = await import('dotenv');
    config();
  } catch { /* dotenv optional */ }

  const apply = process.argv.includes('--apply');
  const dataDir = resolve(ROOT, arg('--data', 'data'));
  const dateStr = typeof arg('--date') === 'string' ? arg('--date') : todayStamp();
  const pat = process.env.AIRTABLE_PAT || null;
  if (!pat) {
    console.error(`[archive-stale] FATAL: ${PAT_MISSING_MSG}`);
    process.exit(1);
  }

  const res = await run({ pat, dataDir, dateStr, apply });
  if (!res.ok) {
    console.error(`[archive-stale] FAILED: ${res.error}`);
    process.exit(1);
  }

  console.log(`[archive-stale] ${apply ? 'APPLY' : 'DRY-RUN'} — archived ${res.archived.length}, tagged ${res.tagged_flow.length} flow transition(s)${res.errors.length ? `, ${res.errors.length} error(s)` : ''}`);
  for (const a of res.archived) console.log(`  archived: ${a.cardId} (${a.lane}, created ${a.createdAt})`);
  for (const t of res.tagged_flow) console.log(`  flow: ${t.cardId} ${t.tag}`);
  for (const n of res.notes) console.log(`  note: ${n}`);
  for (const e of res.errors) console.warn(`[archive-stale] WARN ${e}`);
  console.log(`[archive-stale] summary written → ${res.outPath}`);

  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (IS_CLI) {
  main().catch((e) => {
    console.error(`[archive-stale] FATAL: ${e.message}`);
    process.exit(1);
  });
}

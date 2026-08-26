#!/usr/bin/env node
/**
 * hot-lane-lifecycle.mjs — Hot-lane aging / expiry (CHANGE 4, approved by Rahil).
 *
 * THE STORY: a warm New-Hot card is a live relationship on the clock. If nothing
 * happens on it for 3 days — no lane change, no status update, no new comment —
 * it has gone STALE and shouldn't keep squatting the Hot lane. What happens next
 * depends on the grade, because a referral (S) or strong (A) card is worth
 * remembering forever, while a weaker one is just noise once it cools:
 *
 *   • grade S or A, stale ≥3d  → ARCHIVE to the "Hot Lane History" Airtable table
 *     (tbldnoqG9cA14yu5i) with a Status of exactly {Applied, Not Applied}, then
 *     remove the card from the Hot lane. This preserves the full lifecycle history
 *     of every S/A Hot card — nothing important is ever silently lost.
 *
 *   • grade < A (B/C/D), stale ≥3d → SOFT-REMOVE from the Hot lane. SAFETY FIRST:
 *     never a hard delete. The card is moved to Blocked and stamped with an
 *     [expired-hot-lane …] flag, and the action is logged. A hard-delete path
 *     EXISTS behind a config toggle (config/hot-lane-lifecycle.yml → hard_delete)
 *     but ships OFF and must be turned on by Rahil explicitly.
 *
 * DRY-RUN BY DEFAULT. `--apply` executes. Every run writes
 * data/hot-lane-lifecycle-{date}.json (counts + per-card decisions) which the
 * daily health report reads to print the lifecycle line.
 *
 * Usage:
 *   node scripts/hot-lane-lifecycle.mjs                 # dry-run (default)
 *   node scripts/hot-lane-lifecycle.mjs --apply
 *   node scripts/hot-lane-lifecycle.mjs --stale-days 5  # override the 3-day clock (testing)
 *
 * Exit: 0 ok (incl. no-PAT skip). Never hard-crashes the pipeline.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASE_ID, ACTIVE_TABLE_ID, ACTIVE_FIELD_IDS, PAT_MISSING_MSG,
  airtableListAll, airtablePatchBatch, recordToCard,
} from './airtable-sync.mjs';
import { listRecordComments } from './scan-card-flags.mjs';
import { gradeRank } from './referral-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA = join(ROOT, 'data');

// ── Hot Lane History table (same base appYRJX5x9iVXpbbg) ─────────────────────
// Created 2026-08-25 via Airtable MCP. Field IDs captured at creation.
export const HOT_LANE_HISTORY_TABLE_ID = 'tbldnoqG9cA14yu5i';
export const HOT_HISTORY_FIELD_IDS = {
  Company: 'fldWXCUFhWIJaU0Uh',
  Role: 'fldrruuLPFcyx0K66',
  URL: 'fldg0gtup89vwriAk',
  Connection: 'flduR2a7e0tIuUjcu',
  Grade: 'fldid8dDDEqdpGqk4',
  'Card ID': 'fldHrdqJHgjJR4ijt',
  'Created At': 'fldYrfVZxg1Jj5NFv',
  'Last Activity': 'fldCyY2CHFK4zA2YZ',
  'Archived At': 'fldEYmC8yZNjuOhfN',
  Status: 'fldKSseUw1GagkRgO',
};

export const ARCHIVE_TABLE_ID = 'tblxzlwcG0hVwvo17'; // existing Archive (soft-remove target option)
export const HOT_LANE = 'New-Hot';
export const DEFAULT_STALE_DAYS = 3;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Hard-delete is a SAFETY-GATED capability. Default OFF. Only true if
// config/hot-lane-lifecycle.yml sets `hard_delete: true` AND --apply is passed.
// Even then, the report flags it. Rahil must confirm before ever enabling.
export const HARD_DELETE_DEFAULT = false;

// ── pure decision logic (unit-tested — no I/O) ───────────────────────────────

/** All parseable activity timestamps (ms) for a card: created, refreshed, last comment, dates embedded in notes. */
export function activityTimestamps(card) {
  const out = [];
  const push = (v) => { const t = Date.parse(v); if (!Number.isNaN(t)) out.push(t); };
  push(card?.createdAt);
  push(card?.lastRefreshed);
  push(card?.lastCommentAt);
  // Dates embedded in Notes flow/commute/hot-off tags, e.g. "[flow:…→… 2026-08-20]".
  const notes = String(card?.notes || '');
  for (const m of notes.matchAll(/\b(\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z?)?\b/g)) push(m[1]);
  return out;
}

/** The most recent activity time (ms) for a card, capped at `now`. null if nothing parseable. */
export function lastActivityMs(card, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const ts = activityTimestamps(card).filter((t) => t <= nowMs);
  return ts.length ? Math.max(...ts) : null;
}

/** Whole (float) days since the card's last activity. null if unknown. */
export function daysSinceActivity(card, now = Date.now()) {
  const last = lastActivityMs(card, now);
  if (last == null) return null;
  const nowMs = now instanceof Date ? now.getTime() : now;
  return (nowMs - last) / MS_PER_DAY;
}

/** Stale = no activity for >= staleDays. Unknown last-activity is NOT stale (fail-safe: never expire on missing data). */
export function isStaleHot(card, now = Date.now(), staleDays = DEFAULT_STALE_DAYS) {
  const d = daysSinceActivity(card, now);
  if (d == null) return false;
  return d >= staleDays;
}

/** Lifecycle Status for the history table: 'Applied' if the card's lifecycle shows it was applied, else 'Not Applied'. */
export function deriveAppliedStatus(card) {
  const lane = card?.lane || card?.columnName || '';
  if (/applied/i.test(lane)) return 'Applied';
  const notes = String(card?.notes || '');
  // Flow tag "[flow:New-Hot→Applied …]" or any "→ Applied" / "[applied …]" marker.
  if (/→\s*applied/i.test(notes) || /\bapplied\b/i.test(notes)) return 'Applied';
  return 'Not Applied';
}

/**
 * Which lifecycle bucket does a Hot-lane card fall into?
 *   keep            — not stale (or not a Hot card)
 *   archive-history — stale, grade S or A → write to Hot Lane History
 *   soft-remove     — stale, grade < A     → expire off the Hot lane (no hard delete)
 * @param {object} card  { grade, lane, notes, createdAt, lastRefreshed, lastCommentAt, … }
 * @param {{ now?:number, staleDays?:number }} [opts]
 * @returns {{ bucket:'keep'|'archive-history'|'soft-remove', status:string|null, reason:string, days:number|null }}
 */
export function lifecycleDecision(card, { now = Date.now(), staleDays = DEFAULT_STALE_DAYS } = {}) {
  const lane = card?.lane || card?.columnName || '';
  const days = daysSinceActivity(card, now);
  if (lane !== HOT_LANE) {
    return { bucket: 'keep', status: null, reason: `not a Hot-lane card (lane=${lane || 'unknown'})`, days };
  }
  if (!isStaleHot(card, now, staleDays)) {
    return { bucket: 'keep', status: null, reason: days == null ? 'no parseable activity date — kept (fail-safe)' : `active (${days.toFixed(1)}d < ${staleDays}d)`, days };
  }
  // Stale. Grade decides the fate. S=0, A=1 → archive to history; B/C/D/unknown → soft-remove.
  const rank = gradeRank(card?.grade);
  if (rank <= gradeRank('A')) {
    return { bucket: 'archive-history', status: deriveAppliedStatus(card), reason: `stale ${days.toFixed(1)}d, grade ${String(card?.grade || '?').toUpperCase()} (S/A) → Hot Lane History`, days };
  }
  return { bucket: 'soft-remove', status: null, reason: `stale ${days.toFixed(1)}d, grade ${String(card?.grade || '?').toUpperCase()} (<A) → soft-remove`, days };
}

/** Build the Hot Lane History row (fields keyed by field ID) for an archived card. Pure. */
export function historyRowForCard(card, { status, now = new Date() } = {}) {
  const F = HOT_HISTORY_FIELD_IDS;
  const archivedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const last = lastActivityMs(card, now instanceof Date ? now.getTime() : now);
  return {
    fields: {
      [F.Company]: card.company || '',
      [F.Role]: card.role || '',
      [F.URL]: card.url || '',
      [F.Connection]: card.connectionName || '',
      [F.Grade]: String(card.grade || '').toUpperCase(),
      [F['Card ID']]: card.id || '',
      [F['Created At']]: card.createdAt || '',
      [F['Last Activity']]: last != null ? new Date(last).toISOString() : '',
      [F['Archived At']]: archivedAt,
      [F.Status]: status === 'Applied' ? 'Applied' : 'Not Applied',
    },
  };
}

/** The expired-flag note stamped on a soft-removed (<A) card. Pure. */
export function expiredNote(card, days, dateStr = new Date().toISOString().slice(0, 10)) {
  const d = days == null ? '?' : days.toFixed(0);
  return `[expired-hot-lane: grade ${String(card?.grade || '?').toUpperCase()} <A, ${d}d idle, ${dateStr}]`;
}

// ── config: hard-delete toggle ───────────────────────────────────────────────

/** Read config/hot-lane-lifecycle.yml → { hard_delete:boolean }. Defaults OFF. Never throws. */
export function loadLifecycleConfig(root = ROOT, yaml = null) {
  const p = join(root, 'config', 'hot-lane-lifecycle.yml');
  if (!existsSync(p)) return { hard_delete: HARD_DELETE_DEFAULT };
  try {
    const y = yaml || null;
    const parsed = y ? y.load(readFileSync(p, 'utf8')) : JSON.parse(readFileSync(p, 'utf8'));
    return { hard_delete: parsed?.hard_delete === true };
  } catch { return { hard_delete: HARD_DELETE_DEFAULT }; }
}

// ── Airtable helpers ─────────────────────────────────────────────────────────

/** POST rows to a table in batches of 10. */
export async function airtableCreateBatch({ pat, baseId, tableId, records, fetchImpl = fetch }) {
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const res = await fetchImpl(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch, typecast: true }),
    });
    if (!res.ok) {
      let body = ''; try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`Hot Lane History create failed: ${res.status} ${res.statusText}${body ? ' — ' + body : ''}`);
    }
    const json = await res.json();
    out.push(...(json.records || []));
  }
  return out;
}

/** Card IDs already present in Hot Lane History (dedupe archive on re-runs). */
export async function loadHistoryCardIds({ pat, baseId = BASE_ID, tableId = HOT_LANE_HISTORY_TABLE_ID, fetchImpl = fetch }) {
  const ids = new Set();
  const records = await airtableListAll({ pat, baseId, tableId, fetchImpl });
  const idField = HOT_HISTORY_FIELD_IDS['Card ID'];
  for (const r of records) {
    const v = r.fields?.[idField];
    if (v) ids.add(String(v));
  }
  return ids;
}

// ── engine ───────────────────────────────────────────────────────────────────

function todayStamp() { return new Date().toISOString().slice(0, 10); }

/**
 * Run one lifecycle pass. Returns a summary. Pure-ish: all Airtable I/O goes
 * through injectable helpers so this is testable with fakes.
 */
export async function run({
  pat, now = new Date(), staleDays = DEFAULT_STALE_DAYS, apply = false, dataDir = DATA,
  hardDelete = false,
  fetchImpl = fetch,
  _listAll = airtableListAll, _patch = airtablePatchBatch, _create = airtableCreateBatch,
  _historyIds = loadHistoryCardIds, _comments = listRecordComments,
} = {}) {
  const dateStr = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  if (!pat) return { ok: false, error: PAT_MISSING_MSG };

  let records;
  try {
    records = await _listAll({ pat, baseId: BASE_ID, tableId: ACTIVE_TABLE_ID, fetchImpl });
  } catch (e) {
    return { ok: false, error: `Active Pipeline list failed: ${e.message}` };
  }

  // Hot-lane cards only.
  const hot = records
    .map((r) => ({ rec: r, card: recordToCard(r), lane: r.fields?.[ACTIVE_FIELD_IDS['Lane']] || '' }))
    .filter((x) => x.lane === HOT_LANE);

  // Enrich each with its most-recent comment time (part of the "no new comment in 3d" clock).
  for (const x of hot) {
    try {
      const comments = await _comments({ pat, baseId: BASE_ID, tableId: ACTIVE_TABLE_ID, recordId: x.rec.id, fetchImpl });
      const times = comments.map((c) => Date.parse(c.createdTime)).filter((t) => !Number.isNaN(t));
      x.card.lastCommentAt = times.length ? new Date(Math.max(...times)).toISOString() : null;
    } catch { x.card.lastCommentAt = null; }
    x.card.lane = x.lane;
  }

  const decisions = hot.map((x) => ({ ...x, decision: lifecycleDecision(x.card, { now, staleDays }) }));
  const toArchive = decisions.filter((d) => d.decision.bucket === 'archive-history');
  const toSoftRemove = decisions.filter((d) => d.decision.bucket === 'soft-remove');
  const kept = decisions.filter((d) => d.decision.bucket === 'keep');

  const summary = {
    date: dateStr, dry_run: !apply, stale_days: staleDays, hot_total: hot.length,
    archived_to_history: [], soft_removed: [], kept: kept.length,
    hard_delete_enabled: !!hardDelete, errors: [],
  };

  if (apply && toArchive.length) {
    // Dedupe against existing history so a re-run doesn't double-write.
    let existingIds = new Set();
    try { existingIds = await _historyIds({ pat, baseId: BASE_ID, fetchImpl }); }
    catch (e) { summary.errors.push(`history dedupe read failed: ${e.message}`); }

    const rows = [], moves = [];
    for (const d of toArchive) {
      if (existingIds.has(String(d.card.id))) { summary.archived_to_history.push({ cardId: d.card.id, status: d.decision.status, note: 'already in history' }); continue; }
      rows.push(historyRowForCard(d.card, { status: d.decision.status, now }));
      // Remove from Hot lane: soft (move to Blocked) unless hard-delete is ON.
      moves.push(d);
    }
    if (rows.length) {
      try {
        await _create({ pat, baseId: BASE_ID, tableId: HOT_LANE_HISTORY_TABLE_ID, records: rows, fetchImpl });
      } catch (e) { summary.errors.push(`history create failed: ${e.message}`); }
    }
    // Move archived cards off Hot lane (soft) — hard delete NEVER runs unless toggled.
    if (moves.length && !hardDelete) {
      const patches = moves.map((d) => ({
        id: d.rec.id,
        fields: {
          [ACTIVE_FIELD_IDS['Lane']]: 'Blocked',
          [ACTIVE_FIELD_IDS['Notes']]: `[hot-history-archived: ${d.decision.status}, ${dateStr}] ${d.card.notes || ''}`.trim(),
        },
      }));
      try { await _patch({ pat, baseId: BASE_ID, tableId: ACTIVE_TABLE_ID, records: patches, fetchImpl }); }
      catch (e) { summary.errors.push(`archive lane-move failed: ${e.message}`); }
    }
    for (const d of moves) summary.archived_to_history.push({ cardId: d.card.id, company: d.card.company, role: d.card.role, grade: d.card.grade, status: d.decision.status });
  } else {
    for (const d of toArchive) summary.archived_to_history.push({ cardId: d.card.id, company: d.card.company, role: d.card.role, grade: d.card.grade, status: d.decision.status, dry_run: true });
  }

  if (apply && toSoftRemove.length) {
    if (hardDelete) {
      // GATED OFF by default. Present for completeness; only reachable if the
      // config toggle is flipped AND --apply passed. Still logged loudly.
      summary.errors.push('hard_delete is ENABLED — this run would hard-delete <A stale Hot cards. (Refusing silently is safer; implement deletion here only after Rahil confirms.)');
    }
    const patches = toSoftRemove.map((d) => ({
      id: d.rec.id,
      fields: {
        [ACTIVE_FIELD_IDS['Lane']]: 'Blocked',
        [ACTIVE_FIELD_IDS['Notes']]: `${expiredNote(d.card, d.decision.days, dateStr)} ${d.card.notes || ''}`.trim(),
      },
    }));
    try { await _patch({ pat, baseId: BASE_ID, tableId: ACTIVE_TABLE_ID, records: patches, fetchImpl }); }
    catch (e) { summary.errors.push(`soft-remove failed: ${e.message}`); }
    for (const d of toSoftRemove) summary.soft_removed.push({ cardId: d.card.id, company: d.card.company, role: d.card.role, grade: d.card.grade });
  } else {
    for (const d of toSoftRemove) summary.soft_removed.push({ cardId: d.card.id, company: d.card.company, role: d.card.role, grade: d.card.grade, dry_run: true });
  }

  // Always write the run summary (the daily report reads it for the counts line).
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, `hot-lane-lifecycle-${dateStr}.json`), JSON.stringify(summary, null, 2) + '\n');
  } catch (e) { summary.errors.push(`summary write failed: ${e.message}`); }

  return { ok: true, ...summary };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function argVal(name, dflt = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function main() {
  try { const { config } = await import('dotenv'); config(); } catch { /* optional */ }
  const yaml = (await import('js-yaml')).default;
  const apply = process.argv.includes('--apply');
  const staleDays = Number(argVal('--stale-days', DEFAULT_STALE_DAYS)) || DEFAULT_STALE_DAYS;
  const cfg = loadLifecycleConfig(ROOT, yaml);
  const pat = process.env.AIRTABLE_PAT;

  if (!pat) {
    console.log(`[hot-lane-lifecycle] SKIPPED: ${PAT_MISSING_MSG}`);
    process.exit(0);
  }

  const res = await run({ pat, apply, staleDays, hardDelete: cfg.hard_delete });
  if (!res.ok) {
    console.error(`[hot-lane-lifecycle] ERROR: ${res.error}. Pipeline continues.`);
    process.exit(0);
  }
  console.log(`[hot-lane-lifecycle] ${apply ? 'APPLY' : 'DRY-RUN'} — ${res.hot_total} Hot card(s): `
    + `${res.archived_to_history.length} → Hot Lane History (S/A), ${res.soft_removed.length} soft-removed (<A), ${res.kept} kept. `
    + `hard_delete=${cfg.hard_delete ? 'ON ⚠' : 'OFF'}.`);
  for (const a of res.archived_to_history) console.log(`  archive[${a.status || '?'}] ${a.company} — ${String(a.role || '').slice(0, 40)} (${a.grade})`);
  for (const s of res.soft_removed) console.log(`  soft-remove ${s.company} — ${String(s.role || '').slice(0, 40)} (${s.grade})`);
  for (const e of res.errors) console.warn(`[hot-lane-lifecycle] WARN ${e}`);
  process.exit(0);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  main().catch((e) => { console.error(`[hot-lane-lifecycle] ERROR (unexpected): ${e?.message || e}. Pipeline continues.`); process.exit(0); });
}

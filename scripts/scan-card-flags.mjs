#!/usr/bin/env node
/**
 * scan-card-flags.mjs — turn Rahil's Airtable card COMMENTS into tuning signal.
 *
 * THE STORY: Rahil reviews the Active Pipeline board and leaves short code words
 * in a card's COMMENTS to flag it — #OFF ("this card shouldn't be here", with an
 * optional reason) and #GOOD ("strong match"). Those comments are gold: they are
 * the ground-truth labels that tell the grader/commute/dedupe logic where it is
 * wrong. But a comment left on a card does nothing on its own — it just sits
 * there. This step scans every card's comments each run, parses the code words,
 * and (a) writes them to data/card-flags-{date}.json as a machine-readable label
 * set, and (b) files each NEW #OFF onto the Bug Triage board so a mis-routed card
 * becomes a tracked defect instead of a note that scrolls away.
 *
 * CONVENTION (case-insensitive on the tag). "#" is the documented primary — the
 * "@" form is accepted as a fallback because "@" triggers a person-mention in
 * Airtable's comment box, so an autocomplete quirk shouldn't lose a flag. Both
 * prefixes normalize to the "#" form in the output.
 *   #OFF            card shouldn't be here.       (fallback: @OFF)
 *   #OFF:REASON     REASON ∈ {LOC, FIT, STALE, DUPE, LEVEL}. Free text may follow.
 *   #GOOD           strong match (positive signal). (fallback: @GOOD)
 *
 * DEGRADES LOUDLY, NEVER CRASHES THE PIPELINE:
 *   - Missing AIRTABLE_PAT → prints SKIPPED and exits 0 (pulse-refresh continues).
 *   - Any network/list error → prints ERROR, still exits 0 (best-effort step).
 *   - Idempotent: re-running the same day re-writes the same card-flags file and
 *     never double-posts the same card+comment to Bug Triage (dedupe by hash).
 *
 * Usage:
 *   node scripts/scan-card-flags.mjs
 *   npm run flags:scan
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASE_ID, ACTIVE_TABLE_ID, ACTIVE_FIELD_IDS,
  airtableListAll, recordToCard,
} from './airtable-sync.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── Bug Triage table (same base appYRJX5x9iVXpbbg) ──────────────────────────
// Confirmed live via list_tables_for_base 2026-08-25.
export const BUG_TRIAGE_TABLE_ID = 'tbluPDZXxXo47QWTx';
export const BUG_TRIAGE_FIELD_IDS = {
  Title: 'fldq50xNlVIxwJo4y',
  Description: 'fldaDy0wbU4hhq8nq',
  Status: 'fldVwaJjpsVseRDy2',
  Source: 'fldZGIm7SBtKJI5mJ',
  Severity: 'fldnSUbr97o8jcJk6',
  Notes: 'fldx65tfObw6Nrcch',
};
export const BUG_TRIAGE_SOURCE = 'card-flag-scanner';

// Valid #OFF reason codes. The parser only consumes a ":REASON" suffix when it is
// one of these — "#OFF:XYZ" is treated as a bare #OFF whose free text is ":XYZ …",
// never a bogus reason.
export const OFF_REASONS = ['LOC', 'FIT', 'STALE', 'DUPE', 'LEVEL'];

// ─── PURE PARSER (unit-tested — see test/card-flags.test.mjs) ─────────────────

/**
 * Parse every #OFF / #GOOD flag out of a single comment string. The "#" prefix is
 * the documented primary; the "@" prefix is accepted as a fallback and normalized
 * to "#" in the output. Case-insensitive on the tag.
 * @param {string} comment
 * @returns {Array<{tag:'#OFF'|'#GOOD', reason:string|null, text:string}>}
 *   tag    — normalized uppercase, "#" form ('#OFF' | '#GOOD')
 *   reason — one of OFF_REASONS (uppercased) for #OFF, else null
 *   text   — the free-text remainder after the tag, up to the next tag or end
 */
export function parseFlags(comment) {
  const s = String(comment ?? '');
  // [#@] accepts the primary "#" and the fallback "@" prefix. \b after (OFF|GOOD)
  // prevents matching inside words like "#OFFICE" / "@OFFICE".
  const re = new RegExp(`[#@](OFF|GOOD)\\b(?::(${OFF_REASONS.join('|')}))?`, 'gi');
  const matches = [...s.matchAll(re)];
  const hits = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const tag = `#${m[1].toUpperCase()}`;
    const reason = tag === '#OFF' && m[2] ? m[2].toUpperCase() : null;
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : s.length;
    const text = s.slice(start, end).trim();
    hits.push({ tag, reason, text });
  }
  return hits;
}

/**
 * Convenience: the FIRST flag in a comment, or null if none. This is the pure
 * function the unit test drives.
 * @param {string} comment
 * @returns {{tag:string, reason:string|null, text:string}|null}
 */
export function parseFlag(comment) {
  return parseFlags(comment)[0] ?? null;
}

/** Stable dedupe key for a flagged card+comment (recordId + comment text). */
export function flagKey(recordId, commentText) {
  return createHash('sha256').update(`${recordId}|${commentText}`).digest('hex').slice(0, 16);
}

/** Build the Bug Triage row payload for one #OFF hit. Pure — no I/O. */
export function bugTriageRowForHit(hit) {
  const reasonLabel = hit.reason || 'NONE';
  const title = `[card-flag] ${hit.company || 'Unknown'} ${hit.role || ''}`.trim() + ` - #OFF:${reasonLabel}`;
  const description = [
    `Card: ${hit.company || 'Unknown'} — ${hit.role || ''}`.trim(),
    `Lane: ${hit.lane || '(unknown)'}`,
    `URL: ${hit.url || '(none)'}`,
    `Flag: #OFF${hit.reason ? ':' + hit.reason : ''}`,
    `Comment: "${hit.text || '(no free text)'}"`,
  ].join('\n');
  const notes = [
    `Filed by ${BUG_TRIAGE_SOURCE} from an Airtable card comment` +
      (hit.commenter ? ` left by ${hit.commenter}` : '') +
      (hit.commentedAt ? ` at ${hit.commentedAt}` : '') + '.',
    `[flag-key: ${hit.key}]`,
  ].join('\n');
  return {
    fields: {
      [BUG_TRIAGE_FIELD_IDS.Title]: title.slice(0, 255),
      [BUG_TRIAGE_FIELD_IDS.Description]: description,
      [BUG_TRIAGE_FIELD_IDS.Status]: 'Open',
      [BUG_TRIAGE_FIELD_IDS.Source]: BUG_TRIAGE_SOURCE,
      [BUG_TRIAGE_FIELD_IDS.Notes]: notes,
    },
  };
}

// ─── Airtable REST helpers (comments + create) ───────────────────────────────

/** GET all comments for one record, paginating via offset. */
export async function listRecordComments({ pat, baseId, tableId, recordId, fetchImpl = fetch }) {
  const out = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}/comments`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${pat}` } });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`comments GET ${recordId} failed: ${res.status} ${res.statusText}${body ? ' — ' + body : ''}`);
    }
    const json = await res.json();
    out.push(...(json.comments || []));
    offset = json.offset;
  } while (offset);
  return out;
}

/** POST records to a table in batches of 10 (Airtable's per-request limit). */
export async function airtableCreateBatch({ pat, baseId, tableId, records, fetchImpl = fetch }) {
  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const res = await fetchImpl(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch, typecast: true }),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      throw new Error(`create ${tableId} failed: ${res.status} ${res.statusText}${body ? ' — ' + body : ''}`);
    }
    const json = await res.json();
    results.push(...(json.records || []));
  }
  return results;
}

/** Set of already-filed flag-keys, read from existing Bug Triage Notes fields. */
export async function loadExistingFlagKeys({ pat, baseId, tableId = BUG_TRIAGE_TABLE_ID, fetchImpl = fetch }) {
  const keys = new Set();
  const records = await airtableListAll({ pat, baseId, tableId, fetchImpl });
  const notesId = BUG_TRIAGE_FIELD_IDS.Notes;
  for (const r of records) {
    const notes = String(r.fields?.[notesId] || '');
    const m = notes.match(/\[flag-key:\s*([0-9a-f]+)\]/i);
    if (m) keys.add(m[1].toLowerCase());
  }
  return keys;
}

// ─── main scan (side effects isolated here) ──────────────────────────────────

function todayStamp() { return new Date().toISOString().slice(0, 10); }

/** Concise counts-by-tag/reason summary line, plus a per-tag breakdown. */
export function summarize(hits) {
  const byTag = { '#OFF': 0, '#GOOD': 0 };
  const byReason = {};
  for (const h of hits) {
    byTag[h.tag] = (byTag[h.tag] || 0) + 1;
    if (h.tag === '#OFF') {
      const r = h.reason || 'NONE';
      byReason[r] = (byReason[r] || 0) + 1;
    }
  }
  return { total: hits.length, byTag, byReason };
}

async function main() {
  try { const { config } = await import('dotenv'); config(); } catch { /* optional */ }
  const pat = process.env.AIRTABLE_PAT;
  const dataDir = join(ROOT, 'data');
  const date = todayStamp();
  const outPath = join(dataDir, `card-flags-${date}.json`);

  if (!pat) {
    console.log('[scan-card-flags] SKIPPED: AIRTABLE_PAT not set — no card comments scanned this run.');
    process.exit(0);
  }

  // 1) List Active Pipeline records.
  let records;
  try {
    records = await airtableListAll({ pat, baseId: BASE_ID, tableId: ACTIVE_TABLE_ID });
  } catch (e) {
    console.error(`[scan-card-flags] ERROR: could not list Active Pipeline — ${e.message}. Nothing written; pipeline continues.`);
    process.exit(0);
  }
  console.log(`[scan-card-flags] scanning comments on ${records.length} Active Pipeline card(s)…`);

  // 2) Read + parse each card's comments.
  const hits = [];
  let commentsRead = 0;
  for (const rec of records) {
    const card = recordToCard(rec);
    const lane = rec.fields?.[ACTIVE_FIELD_IDS['Lane']] || '';
    let comments = [];
    try {
      comments = await listRecordComments({ pat, baseId: BASE_ID, tableId: ACTIVE_TABLE_ID, recordId: rec.id });
    } catch (e) {
      console.warn(`[scan-card-flags] WARN: comments unreadable for ${rec.id} (${card.company}) — ${e.message}`);
      continue;
    }
    for (const c of comments) {
      commentsRead++;
      const text = c.text || '';
      for (const f of parseFlags(text)) {
        const key = flagKey(rec.id, text);
        hits.push({
          recordId: rec.id,
          cardId: card.id,
          company: card.company,
          role: card.role,
          url: card.url,
          lane,
          tag: f.tag,
          reason: f.reason,
          text: f.text,
          comment: text,
          commenter: c.author?.name || c.author?.email || null,
          commentedAt: c.createdTime || null,
          commentId: c.id || null,
          key,
        });
      }
    }
  }

  // 3) Always write the card-flags file (even empty → non-destructive, explicit).
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(hits, null, 2) + '\n');
  const sum = summarize(hits);
  const reasonStr = Object.entries(sum.byReason).map(([r, n]) => `${r}:${n}`).join(', ') || 'none';
  console.log(`[scan-card-flags] ${commentsRead} comment(s) read → ${sum.total} flag(s): #OFF ${sum.byTag['#OFF']} (${reasonStr}), #GOOD ${sum.byTag['#GOOD']}.`);
  console.log(`[scan-card-flags] wrote ${outPath}`);

  // 4) File each NEW #OFF onto Bug Triage (dedupe by flag-key).
  const offHits = hits.filter((h) => h.tag === '#OFF');
  if (offHits.length === 0) {
    console.log('[scan-card-flags] no #OFF flags — nothing to log to Bug Triage.');
    process.exit(0);
  }

  let existingKeys;
  try {
    existingKeys = await loadExistingFlagKeys({ pat, baseId: BASE_ID });
  } catch (e) {
    console.error(`[scan-card-flags] ERROR: could not read Bug Triage for dedupe — ${e.message}. Skipping Bug Triage log this run (card-flags file already written).`);
    process.exit(0);
  }

  // Dedupe against Bug Triage AND within this run (same card+comment once).
  const seen = new Set();
  const toFile = [];
  for (const h of offHits) {
    if (existingKeys.has(h.key) || seen.has(h.key)) continue;
    seen.add(h.key);
    toFile.push(bugTriageRowForHit(h));
  }

  if (toFile.length === 0) {
    console.log(`[scan-card-flags] all ${offHits.length} #OFF flag(s) already on Bug Triage — nothing new to file.`);
    process.exit(0);
  }

  try {
    const created = await airtableCreateBatch({ pat, baseId: BASE_ID, tableId: BUG_TRIAGE_TABLE_ID, records: toFile });
    console.log(`[scan-card-flags] filed ${created.length} new #OFF flag(s) to Bug Triage.`);
  } catch (e) {
    console.error(`[scan-card-flags] ERROR: Bug Triage create failed — ${e.message}. card-flags file already written; pipeline continues.`);
    process.exit(0);
  }
  process.exit(0);
}

// ── CLI guard (prevents main() from running on import for the unit test) ──────
const __filename = fileURLToPath(import.meta.url);
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (IS_CLI) {
  main().catch((e) => {
    // Last-resort catch — degrade loudly but never crash the pipeline.
    console.error(`[scan-card-flags] ERROR (unexpected): ${e?.message || e}. Pipeline continues.`);
    process.exit(0);
  });
}

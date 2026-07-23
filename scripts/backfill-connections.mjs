#!/usr/bin/env node
/**
 * backfill-connections.mjs — One-shot backfill of Connection Count + Connection Options
 * for New-Hot cards injected before the multi-connection fields landed.
 *
 * Flow:
 *   1. Load .env / AIRTABLE_PAT
 *   2. Check ACTIVE_FIELD_IDS for null Connection Count / Connection Options
 *      → auto-create via Airtable Fields API if null; patch IDs into both source files
 *   3. Load config/linkedin-connections.json (1,709 contacts)
 *   4. Read newest data/kanban-import-*.json, filter columnId === 'new-hot'
 *   5. For each hot card: resolveCardConnection + generateOutreachMessage per contact
 *   6. GET matching Airtable record IDs (rec...) by Card ID
 *   7. PATCH Connection Count + Connection Options (JSON) via Airtable REST
 *   8. Print summary
 *
 * Usage: node scripts/backfill-connections.mjs
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConnectionsMap, resolveCardConnection } from './kanban-inject.mjs';
import { generateOutreachMessage } from './referral-queue.mjs';
import { BASE_ID, ACTIVE_TABLE_ID, ACTIVE_FIELD_IDS } from './airtable-sync.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Patch a null field-ID stub in airtable-map.mjs and airtable-sync.mjs.
 * Replaces the first occurrence of `'<fieldName>': null` with the real ID.
 */
function patchFieldId(fieldName, fieldId) {
  const targets = [
    join(ROOT, 'scripts', 'airtable-map.mjs'),
    join(ROOT, 'scripts', 'airtable-sync.mjs'),
  ];
  const re = new RegExp(`('${fieldName}':\\s*)null`);
  for (const fpath of targets) {
    if (!existsSync(fpath)) continue;
    const before = readFileSync(fpath, 'utf8');
    const after  = before.replace(re, `$1'${fieldId}'`);
    if (after !== before) {
      writeFileSync(fpath, after);
      console.log(`  [patched] ${fpath.replace(ROOT + '\\', '').replace(ROOT + '/', '')} — '${fieldName}' = '${fieldId}'`);
    }
  }
}

function printManualInstructions() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  MANUAL STEPS — create the two fields, then re-run this script ║
╚═══════════════════════════════════════════════════════════════╝

Option A — Airtable UI:
  1. Open base appYRJX5x9iVXpbbg → Active Pipeline (tbldVU2pHhQjOHjzh)
  2. Add field  "Connection Count"   type: Number (precision 0)
  3. Add field  "Connection Options" type: Long text
  4. Click each field header → "Field info" → copy the field ID (fld...)
  5. In scripts/airtable-map.mjs AND scripts/airtable-sync.mjs replace:
       'Connection Count':  null   →  '<fld... from step 4>'
       'Connection Options': null  →  '<fld... from step 4>'
  6. node scripts/backfill-connections.mjs

Option B — curl (source .env or export AIRTABLE_PAT first):
  curl -X POST https://api.airtable.com/v0/meta/bases/appYRJX5x9iVXpbbg/tables/tbldVU2pHhQjOHjzh/fields \\
    -H "Authorization: Bearer $AIRTABLE_PAT" -H "Content-Type: application/json" \\
    -d '{"name":"Connection Count","type":"number","options":{"precision":0}}'

  curl -X POST https://api.airtable.com/v0/meta/bases/appYRJX5x9iVXpbbg/tables/tbldVU2pHhQjOHjzh/fields \\
    -H "Authorization: Bearer $AIRTABLE_PAT" -H "Content-Type: application/json" \\
    -d '{"name":"Connection Options","type":"multilineText"}'

  Each response has an "id" key (fld...). Paste both into airtable-map.mjs + airtable-sync.mjs,
  then re-run: node scripts/backfill-connections.mjs
`);
}

/** Fetch all field definitions for the Active Pipeline table. */
async function listFields(pat) {
  const res = await fetch(
    `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`,
    { headers: { Authorization: `Bearer ${pat}` } }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`listFields ${res.status} ${text}`);
  }
  const json = await res.json();
  const table = (json.tables || []).find(t => t.id === ACTIVE_TABLE_ID);
  return table ? (table.fields || []) : [];
}

/**
 * Create a field; if it already exists (DUPLICATE_OR_EMPTY_FIELD_NAME) fall back
 * to finding the existing field by name in listFields().
 */
async function createField(pat, name, type, options = null) {
  const body = { name, type };
  if (options) body.options = options;
  const res = await fetch(
    `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables/${ACTIVE_TABLE_ID}/fields`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }
  );
  if (res.ok) return (await res.json()).id;

  const text = await res.text();
  // Already exists — look it up by name
  if (res.status === 422 && text.includes('DUPLICATE_OR_EMPTY_FIELD_NAME')) {
    console.log(`  [info] "${name}" already exists — fetching its field ID...`);
    const fields = await listFields(pat);
    const match = fields.find(f => f.name === name);
    if (match) return match.id;
    throw new Error(`Field "${name}" reported as duplicate but not found in listFields`);
  }
  throw new Error(`${res.status} ${text}`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Load .env
  try { (await import('dotenv')).config(); } catch { /* optional */ }

  const pat = process.env.AIRTABLE_PAT;
  if (!pat) {
    console.error('FATAL: AIRTABLE_PAT not set in .env');
    process.exit(1);
  }

  // 2. Build a mutable field-ID map (copy so we can fill in nulls without mutating the import)
  const FIELDS = { ...ACTIVE_FIELD_IDS };

  const countNull = FIELDS['Connection Count'] == null;
  const optsNull  = FIELDS['Connection Options'] == null;

  if (countNull || optsNull) {
    console.log('[backfill] Null field IDs detected — auto-creating via Airtable Fields API...');
    try {
      if (countNull) {
        const id = await createField(pat, 'Connection Count', 'number', { precision: 0 });
        FIELDS['Connection Count'] = id;
        patchFieldId('Connection Count', id);
        console.log(`[backfill] Created "Connection Count" → ${id}`);
      }
      if (optsNull) {
        const id = await createField(pat, 'Connection Options', 'multilineText');
        FIELDS['Connection Options'] = id;
        patchFieldId('Connection Options', id);
        console.log(`[backfill] Created "Connection Options" → ${id}`);
      }
    } catch (err) {
      console.error(`[backfill] Field auto-create failed: ${err.message}`);
      printManualInstructions();
      process.exit(1);
    }
  } else {
    console.log('[backfill] Field IDs present — skipping field creation.');
    console.log(`  Connection Count:   ${FIELDS['Connection Count']}`);
    console.log(`  Connection Options: ${FIELDS['Connection Options']}`);
  }

  // 3. Load connections map
  const connPath = join(ROOT, 'config', 'linkedin-connections.json');
  const connByCompany = buildConnectionsMap(connPath);
  console.log(`[backfill] Loaded ${connByCompany.size} company keys from linkedin-connections.json`);

  // 4. Find newest kanban-import, filter New-Hot cards
  const dataDir = join(ROOT, 'data');
  const importFiles = readdirSync(dataDir)
    .filter(f => /^kanban-import-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (!importFiles.length) { console.error('[backfill] No kanban-import-*.json found.'); process.exit(1); }

  const latestImport = join(dataDir, importFiles.at(-1));
  const allCards = JSON.parse(readFileSync(latestImport, 'utf8'));
  const pool      = Array.isArray(allCards) ? allCards
    : Array.isArray(allCards?.cards) ? allCards.cards
    : Object.values(allCards);

  const hotCards = pool.filter(c => c?.columnId === 'new-hot');
  console.log(`[backfill] Source: ${importFiles.at(-1)} — ${hotCards.length} New-Hot card(s)`);

  if (!hotCards.length) {
    console.log('[backfill] Nothing to backfill. Done.');
    process.exit(0);
  }

  // 5. Resolve connections + build Connection Options payload for each card
  const enriched = hotCards.map(card => {
    const conn = resolveCardConnection(card.company, connByCompany);
    const connectionOptions = conn.connections.map(c => ({
      name:     c.name     || '',
      position: c.position || '',
      url:      c.url      || '',
      message:  generateOutreachMessage(c.name, card.company, card.role, c.position || ''),
    }));
    return { ...card, ...conn, connectionOptions };
  });

  // 6. Fetch Airtable record IDs (rec...) for the hot cards via GET + filterByFormula
  const CARD_ID_FIELD = FIELDS['Card ID'];
  const cardIds = hotCards.map(c => c.id);
  const formula = `OR(${cardIds.map(id => `{Card ID}="${id}"`).join(',')})`;
  const getUrl  = `https://api.airtable.com/v0/${BASE_ID}/${ACTIVE_TABLE_ID}`
    + `?filterByFormula=${encodeURIComponent(formula)}`
    + `&returnFieldsByFieldId=true`
    + `&fields[]=${encodeURIComponent(CARD_ID_FIELD)}`;

  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${pat}` } });
  if (!getRes.ok) {
    const body = await getRes.text();
    console.error(`[backfill] FATAL: Airtable GET failed: ${getRes.status} ${body}`);
    process.exit(1);
  }
  const getJson = await getRes.json();
  const airtableRecs = getJson.records || [];

  // cardId → Airtable rec...
  const recIdByCardId = new Map(
    airtableRecs.map(r => [r.fields[CARD_ID_FIELD], r.id])
  );
  console.log(`[backfill] Matched ${recIdByCardId.size}/${hotCards.length} cards in Airtable`);

  // 7. Build PATCH records and send in batches of 10
  const COUNT_FIELD = FIELDS['Connection Count'];
  const OPTS_FIELD  = FIELDS['Connection Options'];

  const patchRecords = enriched
    .map(card => {
      const recId = recIdByCardId.get(card.id);
      if (!recId) {
        console.warn(`  [warn] No Airtable record found for card ${card.id} (${card.company}) — skipping`);
        return null;
      }
      const fields = {};
      if (COUNT_FIELD != null) fields[COUNT_FIELD] = card.connectionCount || 0;
      if (OPTS_FIELD  != null && card.connectionOptions.length) {
        fields[OPTS_FIELD] = JSON.stringify(card.connectionOptions);
      }
      return { id: recId, fields };
    })
    .filter(Boolean);

  if (!patchRecords.length) {
    console.log('[backfill] No records to patch (no Airtable matches). Done.');
    process.exit(0);
  }

  let patched = 0;
  const errors = [];
  for (let i = 0; i < patchRecords.length; i += 10) {
    const batch = patchRecords.slice(i, i + 10);
    const patchRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${ACTIVE_TABLE_ID}`, {
      method:  'PATCH',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ records: batch, returnFieldsByFieldId: true }),
    });
    if (!patchRes.ok) {
      const body = await patchRes.text();
      errors.push(`batch ${i}–${i + batch.length}: ${patchRes.status} ${body}`);
    } else {
      patched += batch.length;
    }
  }

  // 8. Summary
  console.log(`\nPatched ${patched} card(s):`);
  for (const card of enriched) {
    const count = card.connectionCount || 0;
    console.log(`  ${card.company} — ${card.role}: ${count} connection(s)`);
    for (const c of card.connectionOptions) {
      console.log(`    • ${c.name}${c.position ? ` (${c.position})` : ''}`);
      console.log(`      ${c.url}`);
    }
  }

  if (errors.length) {
    console.error(`\nErrors (${errors.length}):`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('[backfill] FATAL:', e.message); process.exit(1); });

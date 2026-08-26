#!/usr/bin/env node
/**
 * commute-sweep.mjs — One-time cleanup: apply the commute gate to cards already
 * on the Active Pipeline board and move the non-local, non-remote ones off the
 * active pursuit lanes.
 *
 * The commute gate (locations.mjs) runs at grade time for NEW jobs, but cards
 * injected before it existed were never gated. This sweeps the active lanes
 * (New-Hot, New-Fresh, Submit Ready), re-fetches each card's description to read
 * its location / remote wording, and for onsite roles outside ~24 mi of 75067 it
 * moves the card to the Blocked lane with a note. NON-DESTRUCTIVE — nothing is
 * deleted; Blocked is the holding bin, so your active lanes end up local/remote only.
 *
 * Usage:
 *   node scripts/commute-sweep.mjs             # dry-run (default): prints what it would move
 *   node scripts/commute-sweep.mjs --apply     # execute the moves
 *
 * Exit codes: 0 = ok, 1 = fatal (no PAT / Airtable list failed).
 */

import {
  BASE_ID, ACTIVE_TABLE_ID, ACTIVE_FIELD_IDS, CARD_ID_FIELD,
  PAT_MISSING_MSG, airtableListAll, airtablePatchBatch, recordToCard,
} from './airtable-sync.mjs';
import { passesCommuteGate } from './locations.mjs';
import { fetchJd } from './substance-grader.mjs';

const DEFAULT_LANES = ['New-Hot', 'New-Fresh', 'Submit Ready'];

// K-0816-3 (2026-08-16): lane scoping. A full sweep of all three active lanes
// moves 8 of 18 cards, four of them New-Hot warm referrals — a materially wider
// blast radius than the 3-card Submit Ready table Rahil approved. Warm referrals
// are the scarcest resource in this system (each one spends a real relationship
// exactly once), so they get a separate, explicit decision rather than riding
// along on an approval given for something narrower.
//
//   node scripts/commute-sweep.mjs --lanes "Submit Ready" --apply
//   node scripts/commute-sweep.mjs --lanes "Submit Ready,New-Fresh" --apply
//
// Omitting --lanes sweeps all three, as before.
function parseLanes(argv) {
  const i = argv.indexOf('--lanes');
  if (i === -1 || !argv[i + 1]) return DEFAULT_LANES;
  return argv[i + 1].split(',').map((l) => l.trim()).filter(Boolean);
}
const ACTIVE_LANES = new Set(parseLanes(process.argv));

// Reason-aware Blocked note. The commute gate (locations.mjs) now drops cards for
// MORE than one reason — onsite-outside-24mi AND remote-out-of-state (B-0825-1) —
// so a single hardcoded "onsite >24mi" string mislabels every state-restricted
// remote card it moves. Build the note from the gate's returned reason instead.
// Exported + pure so the mapping is unit-testable.
export function noteForReason(reason, dateStr = new Date().toISOString().slice(0, 10)) {
  switch (reason) {
    case 'onsite-outside-24mi':
      return `[commute-filtered: onsite >24mi of 75067, ${dateStr}]`;
    case 'remote-out-of-state':
      return `[commute-filtered: remote restricted to non-TX state, ${dateStr}]`;
    default:
      // Any other (future) drop reason still gets a sensible, honest note rather
      // than silently claiming "onsite".
      return `[commute-filtered: ${reason}, ${dateStr}]`;
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  try { const { config } = await import('dotenv'); config(); } catch { /* optional */ }
  const pat = process.env.AIRTABLE_PAT;
  if (!pat) { console.error(`[commute-sweep] FATAL: ${PAT_MISSING_MSG}`); process.exit(1); }

  let records;
  try {
    records = await airtableListAll({ pat, baseId: BASE_ID, tableId: ACTIVE_TABLE_ID });
  } catch (e) { console.error(`[commute-sweep] FATAL: Airtable list failed: ${e.message}`); process.exit(1); }

  const cards = records.map(recordToCard)
    .map((c, i) => ({ ...c, _recId: records[i].id, _lane: records[i].fields?.[ACTIVE_FIELD_IDS['Lane']] || '' }))
    .filter((c) => ACTIVE_LANES.has(c._lane));
  console.log(`[commute-sweep] ${records.length} total cards; ${cards.length} in scoped lanes (${[...ACTIVE_LANES].join('/')})`);

  const toBlock = [];
  let kept = 0;
  for (const c of cards) {
    const jd = await fetchJd(c.url, c.platform).catch(() => '');
    const gate = passesCommuteGate(c.location, `${c.role}\n${jd}\n${c.location}`);
    if (gate.keep) { kept++; continue; }
    toBlock.push({ ...c, _reason: gate.reason });
    console.log(`  FILTER [${c._lane}] ${c.company} — ${String(c.role).slice(0, 48)} (${gate.reason})`);
  }

  console.log(`\n[commute-sweep] keep ${kept} (local/remote/unknown), move ${toBlock.length} to Blocked.`);
  if (!apply) {
    console.log('[commute-sweep] DRY-RUN — nothing written. Re-run with --apply to move them.');
    process.exit(0);
  }
  if (toBlock.length === 0) { console.log('[commute-sweep] nothing to move.'); process.exit(0); }

  const patch = toBlock.map((c) => ({
    id: c._recId,
    fields: {
      [ACTIVE_FIELD_IDS['Lane']]: 'Blocked',
      [ACTIVE_FIELD_IDS['Notes']]: `${noteForReason(c._reason)} ${c.notes || ''}`.trim(),
    },
  }));
  try {
    await airtablePatchBatch({ pat, baseId: BASE_ID, tableId: ACTIVE_TABLE_ID, records: patch });
    console.log(`[commute-sweep] moved ${patch.length} card(s) to Blocked.`);
  } catch (e) {
    console.error(`[commute-sweep] FATAL: PATCH failed: ${e.message}`); process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error(`[commute-sweep] FATAL: ${e.message}`); process.exit(1); });

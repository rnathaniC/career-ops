#!/usr/bin/env node
/**
 * export-board-state.mjs — R1 fix: bridge the localStorage funnel break.
 *
 * THE STORY (for humans and future bots):
 *   The Kanban board lives in the browser's localStorage. The sandbox/automation
 *   can't read a browser's memory, so every morning `auto-submit` opened the static
 *   HTML, found zero card data, and reported "0 eligible" — 27 days of silence.
 *   This script is the disconnected battery cable reconnected: it reconstructs a
 *   sandbox-READABLE snapshot of the board (data/board-state.json) from files we
 *   CAN see — the freshly injected kanban-import, overlaid with applications.md so
 *   already-actioned jobs never get re-submitted.
 *
 * OUTPUT: data/board-state.json in K2 shape { version, cards: { [id]: card } }.
 *   Each card carries BOTH naming conventions on purpose (belt + suspenders):
 *     role/title, columnId/state, isWarmReferral/is_warm_referral, hasConnection/
 *     has_connection — so any reader (auto-submit's pulseJobToCard, airtable-map,
 *     humans) resolves the right value regardless of which key it reaches for.
 *
 * ELIGIBILITY MAPPING (auto-submit isEligible = state in ready-set + grade A/B +
 *   not warm referral):
 *     - graded A/B, not referral, not already-actioned  -> state 'evaluated'  (ELIGIBLE)
 *       Rationale: ingest grading IS the evaluation step in this pipeline.
 *     - warm referral                                    -> state 'new'  (human channel)
 *     - grade C                                          -> state 'new'  (kept, never auto)
 *     - already Applied/Blocked/etc in applications.md   -> that status (excluded)
 *
 * Usage: node scripts/export-board-state.mjs [--data data] [--out data/board-state.json]
 * Exit:  0 ok, 1 no kanban-import found.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argVal = (f) => process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : null;
const DATA = argVal('--data') || 'data';
const OUT  = argVal('--out')  || join(DATA, 'board-state.json');
const APPS = 'data/applications.md';

// Statuses that mean "do not auto-submit again" — overlaid from applications.md.
const ACTIONED = new Map([
  ['applied', 'applied'], ['blocked', 'blocked'], ['discarded', 'discarded'],
  ['rejected', 'rejected'], ['interview', 'interview'], ['offer', 'offer'],
  ['responded', 'responded'], ['skip', 'skip'],
]);

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// --- 1. Load newest kanban-import-*.json (the cards injected this run) ---
const imports = readdirSync(DATA)
  .filter((f) => /^kanban-import-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();
if (!imports.length) {
  console.error('[board-state] FATAL: no kanban-import-*.json found — run scan/refresh first.');
  process.exit(1);
}
const importPath = join(DATA, imports.at(-1));
const raw = JSON.parse(readFileSync(importPath, 'utf8'));
const pool = Array.isArray(raw) ? raw
  : Array.isArray(raw.cards) ? raw.cards
  : raw.cards && typeof raw.cards === 'object' ? Object.values(raw.cards)
  : Object.values(raw);
const cards = pool.filter((v) => v && typeof v === 'object' && v.id);

// --- 2. Build company|role -> status overlay from applications.md ---
const actionedByKey = new Map();
if (existsSync(APPS)) {
  for (const line of readFileSync(APPS, 'utf8').split('\n')) {
    if (!/^\|\s*\d/.test(line)) continue;              // data rows only
    const cols = line.split('|').map((c) => c.trim());
    // | num | date | company | role | grade/score | status | pdf | report | notes |
    const company = cols[3], role = cols[4], status = (cols[6] || '').toLowerCase();
    const canon = ACTIONED.get(status);
    if (canon) actionedByKey.set(`${norm(company)}|${norm(role)}`, canon);
  }
}

// --- 3. Emit board-state cards (dual field names) ---
const out = { version: 'k2', exported_at: new Date().toISOString(),
  source: importPath, generated_by: 'export-board-state.mjs (R1)', cards: {} };

let eligible = 0, actioned = 0, referral = 0, cgrade = 0;
for (const c of cards) {
  const key = `${norm(c.company)}|${norm(c.role)}`;
  const prior = actionedByKey.get(key);
  const isAB = c.grade === 'A' || c.grade === 'B';
  const isRef = !!c.isWarmReferral;

  let state;
  if (prior)            { state = prior;       actioned++; }
  else if (isRef)       { state = 'new';       referral++; }
  else if (isAB)        { state = 'evaluated'; eligible++; }
  else                  { state = 'new';       cgrade++;  }

  out.cards[c.id] = {
    id: c.id,
    company: c.company || '',
    role: c.role || '', title: c.role || '',
    url: c.url || '',
    grade: c.grade || 'C',
    platform: c.platform || '',
    columnId: state, state,
    isWarmReferral: isRef, is_warm_referral: isRef,
    hasConnection: !!c.hasConnection, has_connection: !!c.hasConnection,
    keywords: Array.isArray(c.keywords) ? c.keywords : [],
    jobDescText: c.jobDescText || '',
    source_import: importPath,
  };
}

writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`[board-state] wrote ${OUT} from ${importPath}`);
console.log(`[board-state] cards=${cards.length} eligible(A/B->evaluated)=${eligible} referral=${referral} cGrade=${cgrade} alreadyActioned=${actioned}`);

#!/usr/bin/env node
/**
 * render-board-snapshot.mjs — Renders a PNG snapshot of the current job-pulse
 * pipeline board, for attaching to the daily email alongside the text report.
 *
 * Reads the freshest data/kanban-import-YYYY-MM-DD.json (the Airtable pull's
 * local mirror: an array of cards with columnId / company / role / grade /
 * connectionName) and paints the lanes as a clean board, then screenshots it
 * with Playwright (already a dependency; chromium is installed via postinstall).
 *
 * Output: reports/pulse-board-YYYY-MM-DD.png
 *
 * CLI:
 *   node scripts/render-board-snapshot.mjs                 # newest board mirror
 *   node scripts/render-board-snapshot.mjs --input <path>  # a specific mirror json
 *   node scripts/render-board-snapshot.mjs --out <path>    # a specific png path
 *
 * Degrades loudly, never fatally: if there is no board data or Playwright/chromium
 * is unavailable, it prints a clear SKIPPED line and exits 0 so the report + email
 * still go out (just without the image).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeRank } from './referral-registry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const REPORTS = path.join(ROOT, 'reports');
const DATE_STAMP = new Date().toISOString().slice(0, 10);

// Lane order + colors mirror the Airtable Active Pipeline Kanban.
const LANES = [
  { id: 'new-hot', name: 'New-Hot', color: '#e8554e' },
  { id: 'new-fresh', name: 'New-Fresh', color: '#3b82f6' },
  { id: 'submit-ready', name: 'Submit Ready', color: '#f59e0b' },
  { id: 'blocked', name: 'Blocked', color: '#9ca3af' },
  { id: 'applied', name: 'Applied', color: '#22c55e' },
];
const MAX_CARDS_PER_LANE = 8;

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? (process.argv[i + 1] ?? null) : null;
}

export function findLatestBoardMirror(dir = DATA) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => /^kanban-import-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function gradeColor(grade) {
  const g = String(grade || '').toUpperCase()[0];
  // Grade S (referral, above A) gets a DISTINCT gold→purple gradient so it never
  // reads as "just a green A" on the board. (CSS gradient is valid as background.)
  if (g === 'S') return 'linear-gradient(135deg,#d4af37 0%,#7c3aed 100%)';
  return { A: '#16a34a', B: '#65a30d', C: '#d97706', D: '#dc2626', E: '#dc2626', F: '#dc2626' }[g] || '#6b7280';
}

// ── card ordering within a lane (CHANGE 1 + CHANGE 3) ───────────────────────────
// #REF-flagged cards jump to the TOP of their lane (Rahil named a referral path
// worth acting on first), then grade order puts S above A above B… Everything is
// a STABLE sort, so cards that tie keep their original board order.

/** A card is #REF-priority when scan-card-flags marked it (priority:'ref') or its Notes carry the [#REF] marker. */
export function isRefPriority(card) {
  if (!card) return false;
  if (card.priority === 'ref' || card.refPriority === true) return true;
  return /\[#REF\b/i.test(String(card.notes || ''));
}

/** Sort key honored by BOTH the board and the daily report: #REF first, then S>A>B>C>D. Lower sorts higher. */
export function laneSortKey(card) {
  return [isRefPriority(card) ? 0 : 1, gradeRank(card && card.grade)];
}

/** Stable sort of a lane's cards by laneSortKey (does not mutate the input). */
export function sortLaneCards(cards) {
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ka = laneSortKey(a.c), kb = laneSortKey(b.c);
      return (ka[0] - kb[0]) || (ka[1] - kb[1]) || (a.i - b.i);
    })
    .map((x) => x.c);
}

/** Pure: build the board HTML from a card array. Exported for testing (no browser). */
export function buildBoardHtml(cards, date = DATE_STAMP) {
  const byLane = new Map(LANES.map((l) => [l.id, []]));
  for (const c of cards) {
    const lane = byLane.has(c.columnId) ? c.columnId : 'new-fresh';
    byLane.get(lane).push(c);
  }

  const columns = LANES.map((lane) => {
    // Sort every lane so #REF-flagged cards and grade-S referrals surface first.
    const list = sortLaneCards(byLane.get(lane.id) || []);
    const shown = list.slice(0, MAX_CARDS_PER_LANE);
    const cardsHtml = shown.map((c) => {
      const conn = c.connectionName
        ? `<div class="conn">&#8627; ${esc(c.connectionName)}</div>` : '';
      const loc = c.location
        ? `<div class="loc"><i>&#128205;</i> ${esc(String(c.location).slice(0, 42))}</div>` : '';
      return `<div class="card">
        <div class="row"><span class="co">${esc(c.company)}</span><span class="grade" style="background:${gradeColor(c.grade)}">${esc(String(c.grade || '?').toUpperCase())}</span></div>
        <div class="role">${esc(String(c.role || '').slice(0, 60))}</div>
        ${loc}
        ${conn}
      </div>`;
    }).join('');
    const more = list.length > MAX_CARDS_PER_LANE
      ? `<div class="more">+${list.length - MAX_CARDS_PER_LANE} more</div>` : '';
    return `<div class="lane">
      <div class="lane-head" style="background:${lane.color}">${esc(lane.name)} <span class="count">${list.length}</span></div>
      <div class="lane-body">${cardsHtml || '<div class="empty">—</div>'}${more}</div>
    </div>`;
  }).join('');

  const total = cards.length;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #f4f5f7; padding: 20px; width: 1240px; }
    .title { font-size: 20px; font-weight: 700; color: #111; margin-bottom: 2px; }
    .sub { font-size: 12px; color: #6b7280; margin-bottom: 14px; }
    .board { display: flex; gap: 12px; align-items: flex-start; }
    .lane { flex: 1; background: #ebecf0; border-radius: 8px; overflow: hidden; min-width: 0; }
    .lane-head { color: #fff; font-weight: 700; font-size: 13px; padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; }
    .count { background: rgba(255,255,255,.3); border-radius: 10px; padding: 1px 8px; font-size: 12px; }
    .lane-body { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
    .card { background: #fff; border-radius: 6px; padding: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
    .co { font-weight: 700; font-size: 12.5px; color: #172b4d; }
    .grade { color: #fff; font-size: 10px; font-weight: 700; border-radius: 4px; padding: 1px 6px; }
    .role { font-size: 11px; color: #42526e; margin-top: 2px; line-height: 1.3; }
    .loc { font-size: 10.5px; color: #6b7280; margin-top: 3px; }
    .conn { font-size: 10.5px; color: #6554c0; margin-top: 3px; }
    .more { font-size: 11px; color: #6b7280; text-align: center; padding: 4px; }
    .empty { color: #9ca3af; text-align: center; font-size: 12px; padding: 6px; }
  </style></head><body>
    <div class="title">Job Pulse Board &mdash; ${esc(date)}</div>
    <div class="sub">${total} active card(s) &middot; lanes mirror your Airtable Active Pipeline</div>
    <div class="board">${columns}</div>
  </body></html>`;
}

async function main() {
  const inputPath = argVal('--input') || findLatestBoardMirror();
  const outPath = argVal('--out') || path.join(REPORTS, `pulse-board-${DATE_STAMP}.png`);

  if (!inputPath || !fs.existsSync(inputPath)) {
    console.log('[board-snapshot] SKIPPED — no data/kanban-import-*.json board mirror found. Run the Airtable pull first. Report/email unaffected.');
    process.exit(0);
  }

  let cards;
  try {
    const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    cards = Array.isArray(parsed) ? parsed : (parsed.cards ? Object.values(parsed.cards) : []);
  } catch (e) {
    console.log(`[board-snapshot] SKIPPED — could not parse ${path.relative(ROOT, inputPath)}: ${e.message}. Report/email unaffected.`);
    process.exit(0);
  }

  const html = buildBoardHtml(cards);

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('[board-snapshot] SKIPPED — Playwright not installed. Report/email unaffected.');
    process.exit(0);
  }

  fs.mkdirSync(REPORTS, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const board = await page.$('body');
    await board.screenshot({ path: outPath });
    await browser.close();
    console.log(`[board-snapshot] WROTE ${path.relative(ROOT, outPath)} (${cards.length} cards)`);
    process.exit(0);
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    console.log(`[board-snapshot] SKIPPED — render failed: ${e.message.split('\n')[0]}. Report/email unaffected.`);
    process.exit(0);
  }
}

const IS_CLI = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (IS_CLI) {
  main().catch((e) => {
    console.log(`[board-snapshot] SKIPPED — ${e.message}. Report/email unaffected.`);
    process.exit(0);
  });
}

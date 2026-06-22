#!/usr/bin/env node
/**
 * referral-queue.mjs — Lane-Branch reporting for New-Hot (warm-referral) cards
 *
 * Standing automation law (2026-06-15): the Active Pipeline has two intake lanes.
 *
 *   New-Fresh  No referral. Fully automated end-to-end — no human gate.
 *   New-Hot    Referral wired in (Connection Name / LinkedIn / Has Connection /
 *              Warm Referral). Human-in-the-loop ONLY. This script's job is to
 *              surface those cards for Rahil to review and send himself — it never
 *              sends anything and never feeds New-Hot cards into auto-submit.
 *
 * DATA SOURCE NOTE: there is no Airtable REST client or API token anywhere in this
 * repo (checked: no AIRTABLE_* env var, no fetch-based client — only airtable-map.mjs,
 * which is a one-way PUSH payload builder for the Airtable MCP, not a pull). The
 * Active Pipeline's Lane signal (isWarmReferral / hasConnection / connectionName)
 * already lives locally in the newest data/kanban-import-*.json — the same file
 * airtable-map.mjs reads to build the Airtable push. Reading it here is the real,
 * currently-working equivalent of "pulling Active Pipeline records" until a genuine
 * two-way Airtable sync exists (see TODO(Airtable-Sync) in pulse-refresh.mjs).
 *
 * USAGE:
 *   node scripts/referral-queue.mjs                          # newest kanban-import in data/
 *   node scripts/referral-queue.mjs --input data/kanban-import-2026-06-12.json
 *   node scripts/referral-queue.mjs --data data --out data/referral-queue-2026-06-15.json
 *
 * OUTPUT:
 *   stdout   — "REFERRAL QUEUE — review and send" block per New-Hot card (human-readable)
 *   data/referral-queue-{date}.json — { hot: [...], hot_count, fresh_ids, fresh_count }
 *              consumed by pulse-refresh.mjs to scope auto-submit:live --card-ids.
 *
 * Exit codes: 0 = ok (incl. zero cards either lane) · 2 = no source file found.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const DATA_DIR        = resolve(ROOT, arg('--data', 'data'));
const INPUT_OVERRIDE  = typeof arg('--input') === 'string' ? arg('--input') : null;
const DATE_STAMP      = new Date().toISOString().slice(0, 10);
const OUT_PATH        = typeof arg('--out') === 'string' ? arg('--out') : join(DATA_DIR, `referral-queue-${DATE_STAMP}.json`);
const PREVIEW_LEN     = 100;

/**
 * Pick the newest data/kanban-import-*.json by mtime (same convention as ingest-runner.mjs).
 * @param {string} dataDir
 * @returns {string|null}
 */
export function newestKanbanImport(dataDir) {
  if (!existsSync(dataDir)) return null;
  const files = readdirSync(dataDir)
    .filter((f) => /^kanban-import-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => ({ f, m: statSync(join(dataDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? join(dataDir, files[0].f) : null;
}

/**
 * Best-available outreach message preview for a card. There is no dedicated outreach
 * "Notes" field in the local kanban-import shape yet (that field — fldGkJ4cqoLE3yFCa —
 * currently only exists in Airtable, hand-maintained, and isn't pulled). Falls back to
 * the auto-generated jobDescText, and flags clearly when neither is present so an empty
 * Notes field is never silently treated as "ready to send".
 * @param {object} card
 * @returns {{ text: string, drafted: boolean }}
 */
export function messagePreview(card) {
  const raw = (card.notes || card.jobDescText || '').trim();
  if (!raw) return { text: '⚠ no outreach message drafted yet', drafted: false };
  return { text: raw.slice(0, PREVIEW_LEN), drafted: true };
}

/**
 * Split graded candidates into New-Hot (warm referral, human-in-the-loop) and
 * New-Fresh (no referral, automation-eligible) lanes.
 * @param {object[]} cards
 * @returns {{ hot: object[], fresh: object[] }}
 */
export function splitByLane(cards) {
  const pool = Array.isArray(cards) ? cards.filter((c) => c && typeof c === 'object') : [];
  const hot   = pool.filter((c) => !!c.isWarmReferral);
  const fresh = pool.filter((c) => !c.isWarmReferral);
  return { hot, fresh };
}

/**
 * Render the human-readable "REFERRAL QUEUE" block for one New-Hot card.
 * @param {object} card
 * @returns {string}
 */
export function formatReferralBlock(card) {
  const { text, drafted } = messagePreview(card);
  const lines = [
    '── REFERRAL QUEUE — review and send ──────────────────────────',
    `Company:    ${card.company || '(unknown)'}`,
    `Role:       ${card.role || '(unknown)'}`,
    `Connection: ${card.connectionName || '(none on file — hasConnection but no name?)'}`,
    `URL:        ${card.url || '(none)'}`,
    `Message:    ${text}`,
  ];
  if (!drafted) lines.push('  NOTE: draft an outreach message before sending — nothing is ready yet.');
  return lines.join('\n');
}

function main() {
  const source = INPUT_OVERRIDE ? resolve(ROOT, INPUT_OVERRIDE) : newestKanbanImport(DATA_DIR);
  if (!source || !existsSync(source)) {
    console.error('[referral-queue] No kanban-import file found (run scan/worker first, or pass --input).');
    process.exit(2);
  }
  console.log(`[referral-queue] source: ${source.replace(ROOT + '/', '').replace(ROOT + '\\', '')}`);

  let raw;
  try {
    raw = JSON.parse(readFileSync(source, 'utf8'));
  } catch (e) {
    console.error(`[referral-queue] FATAL: could not parse ${source}: ${e.message}`);
    process.exit(2);
  }
  const pool = Array.isArray(raw) ? raw
    : Array.isArray(raw.cards) ? raw.cards
    : raw.cards && typeof raw.cards === 'object' ? Object.values(raw.cards)
    : Object.values(raw);

  // Skip cards already closed out (applied/dead) — they're not part of today's branch.
  const open = pool.filter((c) => c && typeof c === 'object' && !c.closedAt);
  const { hot, fresh } = splitByLane(open);

  console.log(`[referral-queue] ${open.length} open cards — ${hot.length} New-Hot, ${fresh.length} New-Fresh`);

  if (hot.length === 0) {
    console.log('[referral-queue] No New-Hot cards this run.');
  } else {
    for (const card of hot) {
      console.log('\n' + formatReferralBlock(card));
    }
    console.log(`\n[referral-queue] ${hot.length} card(s) waiting on Rahil — see blocks above. None will be auto-submitted.`);
  }

  const summary = {
    generated_at_utc: new Date().toISOString(),
    source: source.replace(ROOT + '/', '').replace(ROOT + '\\', ''),
    hot_count:   hot.length,
    fresh_count: fresh.length,
    hot: hot.map((c) => ({
      id:             c.id || null,
      company:        c.company || '',
      role:           c.role || '',
      url:            c.url || '',
      connectionName: c.connectionName || '',
      message_preview: messagePreview(c).text,
      message_drafted: messagePreview(c).drafted,
    })),
    fresh_ids: fresh.map((c) => c.id).filter(Boolean),
  };
  writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2) + '\n');
  console.log(`[referral-queue] Summary written → ${OUT_PATH.replace(ROOT + '/', '').replace(ROOT + '\\', '')}`);
  process.exit(0);
}

// ── CLI guard (prevents main() from running on import) ────────────────────────
const __filename = fileURLToPath(import.meta.url);
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (IS_CLI) {
  main();
}

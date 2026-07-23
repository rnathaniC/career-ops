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
 * Generate a personalized LinkedIn outreach message for a referral contact.
 * Director / VP / C-level positions get a formal opener; IC / Manager get a casual one.
 * @param {string} name      Full name of the connection
 * @param {string} company   Company name
 * @param {string} role      Job title being applied for
 * @param {string} position  Connection's current position/title
 * @returns {string}
 */
export function generateOutreachMessage(name, company, role, position) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const pos = (position || '').toLowerCase();
  const isSenior = /\b(director|vp|vice\s+president|chief|cto|coo|cpo|cmo|head of|president|svp|evp)\b/.test(pos);

  if (isSenior) {
    return `Hi ${firstName}, I hope you're well. I came across the ${role || 'open'} role at ${company || 'your company'} and, given your leadership there, wanted to reach out directly. I'd welcome the opportunity to connect if you have a few minutes — or a warm introduction to the hiring team if that's easier.`;
  }
  return `Hey ${firstName}, I noticed you're at ${company || 'your company'} as ${position || 'a team member'}. I'm exploring the ${role || 'open'} opportunity there and thought I'd reach out — would love a quick chat or a warm intro if you're open to it.`;
}

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
 * B-9 fix (2026-07-05): card IDs archived earlier in the SAME run.
 * The kanban-import pull (Step -0.5) happens BEFORE archive-stale (Step -0.4),
 * so cards archived this run still appear "open" in the import file. Without
 * this filter, fresh_ids could include just-archived cards and auto-submit
 * would fire on dead cards (observed live 2026-07-04 and 2026-07-05).
 * Reads data/archive-run-{today}.json; missing/unparsable file = empty set (fail-open on
 * the filter, but archive-stale always writes it before this step in pulse-refresh).
 * @param {string} dataDir
 * @param {string} dateStamp YYYY-MM-DD
 * @returns {Set<string>}
 */
export function sameRunArchivedIds(dataDir, dateStamp) {
  const p = join(dataDir, `archive-run-${dateStamp}.json`);
  if (!existsSync(p)) return new Set();
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const rows = Array.isArray(j.archived) ? j.archived : [];
    return new Set(rows.map((r) => r && (r.cardId || r.id)).filter(Boolean));
  } catch {
    return new Set();
  }
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
 * Shows all connections with auto-generated outreach messages.
 * @param {object} card
 * @returns {string}
 */
export function formatReferralBlock(card) {
  const company = card.company || '(unknown)';
  const role    = card.role    || '(unknown)';
  // Prefer structured connections[]; fall back to legacy connectionName scalar.
  const connections = card.connections
    || (card.connectionName ? [{ name: card.connectionName, position: '', url: card.connectionLinkedinUrl || '' }] : []);
  const count = card.connectionCount != null ? card.connectionCount : connections.length;

  const lines = [
    '── REFERRAL QUEUE — review and send ──────────────────────────',
    `Company:     ${company}`,
    `Role:        ${role}`,
    `Connections: ${count} 1st-degree match(es) at this company`,
    `URL:         ${card.url || '(none)'}`,
  ];

  if (connections.length === 0) {
    lines.push('  (no connection details on file)');
  } else if (connections.length === 1) {
    const c = connections[0];
    const msg = generateOutreachMessage(c.name, company, role, c.position || '');
    lines.push(`Contact:     ${c.name}${c.position ? ` (${c.position})` : ''}`);
    lines.push(`LinkedIn:    ${c.url || '(none)'}`);
    lines.push(`Message:     "${msg}"`);
  } else {
    const [first, ...rest] = connections;
    lines.push(`Top match:   ${first.name}${first.position ? ` (${first.position})` : ''} + ${rest.length} more — see card for all options`);
    for (const c of connections) {
      const msg = generateOutreachMessage(c.name, company, role, c.position || '');
      lines.push('');
      lines.push(`  Contact:  ${c.name}${c.position ? ` (${c.position})` : ''}`);
      lines.push(`  LinkedIn: ${c.url || '(none)'}`);
      lines.push(`  Message:  "${msg}"`);
    }
  }
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
  const { hot: hotRaw, fresh: freshRaw } = splitByLane(open);

  // B-9 fix: drop cards archived earlier in this same run (pull happens pre-archive).
  // B-13 fix (2026-07-06): apply the SAME filter to the Hot lane — without it the
  // "REFERRAL QUEUE — review and send" blocks can ask Rahil to send outreach for a
  // card archive-stale just retired this run (observed: live-2026-07-01-002 on 7/06).
  const archivedToday = sameRunArchivedIds(DATA_DIR, DATE_STAMP);
  const hot = hotRaw.filter((c) => !archivedToday.has(c.id));
  const droppedArchivedHot = hotRaw.length - hot.length;
  if (droppedArchivedHot > 0) {
    console.log(`[referral-queue] B-13 filter: dropped ${droppedArchivedHot} New-Hot card(s) archived earlier this run (archive-run-${DATE_STAMP}.json).`);
  }
  const fresh = freshRaw.filter((c) => !archivedToday.has(c.id));
  const droppedArchived = freshRaw.length - fresh.length;
  if (droppedArchived > 0) {
    console.log(`[referral-queue] B-9 filter: dropped ${droppedArchived} New-Fresh card(s) archived earlier this run (archive-run-${DATE_STAMP}.json).`);
  }

  console.log(`[referral-queue] ${open.length} open cards — ${hot.length} New-Hot, ${fresh.length} New-Fresh (submittable)`);

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

#!/usr/bin/env node
/**
 * worker-grader.mjs — Grade raw scan output (scan-history.tsv) for Airtable injection.
 *
 * Reads today's entries from data/scan-history.tsv (filtering to the most recent
 * first_seen date), scores each job title against a keyword list, and emits
 * data/graded-jobs-{date}.json. Grade D = skip; A/B/C = eligible for kanban-inject.
 *
 * Usage:
 *   node scripts/worker-grader.mjs
 *   node scripts/worker-grader.mjs --date 2026-06-16   # override date (testing)
 *   node scripts/worker-grader.mjs --history <path>    # override scan-history path
 *   node scripts/worker-grader.mjs --out <path>        # override output path
 *
 * Grading (by keyword match count):
 *   3+ matches → A   2 → B   1 → C   0 → D (excluded from injection)
 *
 * Exit codes:
 *   0 = ok (including "no scan output found" — pipeline continues cleanly)
 *   1 = fatal (config parse error, unwritable data dir)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..');
const DATA       = join(ROOT, 'data');

// ── arg parsing ───────────────────────────────────────────────────────────────

function argVal(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

// ── exported pure functions (no I/O — testable in isolation) ──────────────────

/**
 * Normalize a portal column value to a clean ATS platform name.
 * "greenhouse-api" → "greenhouse", "ashby-api" → "ashby", etc.
 * @param {string} portal
 * @returns {string}
 */
export function normalizePlatform(portal) {
  return String(portal || 'unknown').toLowerCase().replace(/-api$/, '');
}

/**
 * Grade a job title by counting keyword matches (case-insensitive substring).
 * @param {string}   title     Job title to grade
 * @param {string[]} keywords  Keyword list to match against
 * @returns {{ grade: 'A'|'B'|'C'|'D', keywords_matched: string[] }}
 */
export function gradeJob(title, keywords) {
  const lower   = String(title || '').toLowerCase();
  const matched = keywords.filter((k) => lower.includes(String(k).toLowerCase()));
  let grade;
  if      (matched.length === 0) grade = 'D';
  else if (matched.length === 1) grade = 'C';
  else if (matched.length === 2) grade = 'B';
  else                           grade = 'A';
  return { grade, keywords_matched: matched };
}

/**
 * Parse data/scan-history.tsv into entry objects.
 * TSV header: url\tfirst_seen\tportal\ttitle\tcompany\tstatus
 * @param {string} filePath
 * @returns {Array<{url, first_seen, portal, title, company, status}>}
 */
export function parseScanHistory(filePath) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const [url, first_seen, portal, title, company, status] = line.split('\t');
    return {
      url:        (url        || '').trim(),
      first_seen: (first_seen || '').trim(),
      portal:     (portal     || '').trim(),
      title:      (title      || '').trim(),
      company:    (company    || '').trim(),
      status:     (status     || '').trim(),
    };
  }).filter((e) => e.url && e.title);
}

/**
 * Find the most recent first_seen date among history entries.
 * @param {Array} entries
 * @returns {string|null}  YYYY-MM-DD or null
 */
export function latestScanDate(entries) {
  const dates = [...new Set(entries.map((e) => e.first_seen).filter(Boolean))].sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/**
 * Load the keyword list for grading.
 * Priority: config/sources.yml defaults.target_titles → portals.yml title_filter.positive
 *           → hardcoded fallback for PM/Scrum/TPM roles.
 * @param {string} root   Project root path
 * @param {object} yaml   js-yaml module (already imported by caller)
 * @returns {string[]}
 */
export function loadKeywords(root, yaml) {
  const sourcesPath = join(root, 'config', 'sources.yml');
  if (existsSync(sourcesPath)) {
    try {
      const yml    = yaml.load(readFileSync(sourcesPath, 'utf8'));
      const titles = yml?.defaults?.target_titles;
      if (Array.isArray(titles) && titles.length > 0) return titles;
    } catch { /* fall through */ }
  }

  const portalsPath = join(root, 'portals.yml');
  if (existsSync(portalsPath)) {
    try {
      const yml      = yaml.load(readFileSync(portalsPath, 'utf8'));
      const positive = yml?.title_filter?.positive;
      if (Array.isArray(positive) && positive.length > 0) return positive;
    } catch { /* fall through */ }
  }

  return [
    'Product Manager', 'Program Manager', 'Technical Program Manager',
    'Scrum Master', 'Agile Coach', 'Project Manager', 'Delivery Manager',
    'Chief of Staff', 'PMO', 'TPM', 'Agile', 'PMP', 'SAFe',
  ];
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dateOverride    = argVal('--date');
  const historyOverride = argVal('--history');
  const outOverride     = argVal('--out');
  const date            = dateOverride || new Date().toISOString().slice(0, 10);
  const historyPath     = historyOverride
    ? resolve(ROOT, historyOverride)
    : join(DATA, 'scan-history.tsv');

  console.log('[worker-grader] start');

  const yaml = (await import('js-yaml')).default;
  const keywords = loadKeywords(ROOT, yaml);
  console.log(`[worker-grader] keywords: ${keywords.length} (${keywords.slice(0, 3).join(', ')}${keywords.length > 3 ? '…' : ''})`);

  const entries = parseScanHistory(historyPath);
  if (entries.length === 0) {
    console.log('[worker-grader] no scan-history.tsv or empty — skipping (exit 0)');
    process.exit(0);
  }

  const targetDate = dateOverride || latestScanDate(entries);
  const recent     = entries.filter((e) => e.first_seen === targetDate && e.status === 'added');
  console.log(`[worker-grader] history: ${entries.length} total; ${recent.length} new from ${targetDate}`);

  if (recent.length === 0) {
    console.log('[worker-grader] no new entries for this date — nothing to grade (exit 0)');
    process.exit(0);
  }

  const graded = recent.map((e) => {
    const { grade, keywords_matched } = gradeJob(e.title, keywords);
    return {
      company:          e.company,
      role:             e.title,
      grade,
      platform:         normalizePlatform(e.portal),
      url:              e.url,
      jd_snippet:       null,
      keywords_matched,
    };
  });

  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const g of graded) counts[g.grade]++;
  console.log(`[worker-grader] graded ${graded.length}: A=${counts.A} B=${counts.B} C=${counts.C} D=${counts.D}`);

  mkdirSync(DATA, { recursive: true });
  const outPath = outOverride ? resolve(ROOT, outOverride) : join(DATA, `graded-jobs-${date}.json`);
  writeFileSync(outPath, JSON.stringify(graded, null, 2) + '\n');
  console.log(`[worker-grader] written → ${outPath}`);
  console.log('[worker-grader] next: npm run kanban:inject:apply');
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (IS_CLI) {
  main().catch((e) => { console.error('[worker-grader] FATAL:', e.message); process.exit(1); });
}

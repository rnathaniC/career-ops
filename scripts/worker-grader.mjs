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
import { passesCommuteGate } from './locations.mjs';

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
 * @returns {{ grade: 'A'|'B'|'C'|'D', keywords_matched: string[], disqualifiers?: string[] }}
 */

// B-17 (2026-07-10): hard-requirement screen. A title that itself declares a
// non-US residency or non-English language requirement can never be a fit for
// the Dallas/Remote-US target — force grade D regardless of keyword matches.
// Conservative on purpose: only fires on explicit title-level phrases.
const US_LOCATION_OK = /\b(us|usa|u\.s|united states|dallas|texas|tx|remote)\b/i;
// B-17b (2026-07-14): bare foreign locations in titles ('Senior PM, Brazil') bypassed
// RESIDENCY_RE which requires 'based/located in' phrasing. Standalone foreign
// country/city tokens in a title are a hard geographic disqualifier.
// 'New Mexico' is stripped first so the US state never trips the 'mexico' token.
const FOREIGN_TITLE_RE = /\b(brazil|brasil|belo horizonte|sao paulo|são paulo|rio de janeiro|porto alegre|curitiba|campinas|recife|florianopolis|florianópolis|salvador|fortaleza|brasilia|brasília|mexico|argentina|colombia|chile|peru|canada|toronto|vancouver|ireland|dublin|london|england|united kingdom|germany|berlin|munich|france|paris|spain|madrid|barcelona|portugal|lisbon|poland|warsaw|krakow|netherlands|amsterdam|belgium|brussels|italy|milan|rome|india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|japan|tokyo|china|shanghai|beijing|singapore|australia|sydney|melbourne|philippines|manila|vietnam|indonesia|jakarta|israel|tel aviv|dubai|egypt|cairo|nigeria|lagos|kenya|nairobi|south africa|romania|bucharest|prague|hungary|budapest|ukraine|kyiv|turkey|istanbul|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|switzerland|zurich|austria|vienna|greece|athens|costa rica|guatemala|uruguay|montevideo|ecuador|bolivia|paraguay)\b/i;

// B-17c (2026-07-16): Brazilian city/STATE suffix pattern (e.g. "Belo Horizonte/MG").
const BR_STATE_SUFFIX_RE = /\/(mg|sp|rj|rs|pr|sc|ba|pe|ce|df|go|es|am|pa)\b/i;

const RESIDENCY_RE   = /\b(living|based|located|residing|resident|must live|must reside)\s+(in|near)\s+([a-z][a-z\s,]{1,40}?)(?:[)\]\|+,]|$)/i;
const LANGUAGE_RE    = /\b(advanced|fluent|native|proficient|business[- ]level)\s+(german|portuguese|spanish|french|japanese|mandarin|chinese|korean|italian|dutch|polish|hindi|arabic|hebrew|turkish|swedish|norwegian|danish|finnish)\b/i;

/**
 * Return the list of title-level hard disqualifiers found (empty = clean).
 * @param {string} title
 * @returns {string[]}
 */
export function titleDisqualifiers(title) {
  const t = String(title || '');
  const out = [];
  const res = t.match(RESIDENCY_RE);
  if (res && !US_LOCATION_OK.test(res[3])) out.push(`residency:${res[3].trim()}`);
  const lang = t.match(LANGUAGE_RE);
  if (lang) out.push(`language:${lang[2].toLowerCase()}`);
  const foreign = t.replace(/new mexico/ig, '').match(FOREIGN_TITLE_RE);
  if (foreign) out.push(`foreign-location:${foreign[1].toLowerCase()}`);
  if (BR_STATE_SUFFIX_RE.test(t)) out.push(`foreign-location:br-state-suffix`);
  return out;
}

/**
 * B-17d fix (2026-08-02, K-0724-1): screen the posting's LOCATION field, not just
 * its title. Recurrences of B-17 all shared one shape — the title was clean and
 * the geography lived only in the location ("Coupa | TPM, Security & GRC |
 * Bogota, Colombia" graded B twice, once as Pune on 2026-07-24). Title-only
 * screening is structurally blind to those, so they reached auto-submit
 * eligibility and had to be hand-downgraded every time.
 *
 * Deliberately asymmetric: a foreign token disqualifies ONLY when the location
 * carries no US/remote token. Multi-site postings like "New York; London" keep
 * their grade, because a US-based option genuinely exists — hard-D'ing those
 * would trade a false positive for a false negative and quietly shrink the funnel.
 *
 * @param {string} location Raw location string from scan-history.tsv (may be '')
 * @returns {string[]} disqualifiers found (empty = clean or unknown)
 */
export function locationDisqualifiers(location) {
  const loc = String(location || '').trim();
  if (!loc) return []; // pre-B-17d history rows: unknown, never disqualify
  if (US_LOCATION_OK.test(loc)) return []; // a US/remote option exists
  const out = [];
  const foreign = loc.replace(/new mexico/ig, '').match(FOREIGN_TITLE_RE);
  if (foreign) out.push(`foreign-location-field:${foreign[1].toLowerCase()}`);
  if (BR_STATE_SUFFIX_RE.test(loc)) out.push('foreign-location-field:br-state-suffix');
  return out;
}

export function gradeJob(title, keywords, location = '') {
  const lower   = String(title || '').toLowerCase();
  const matched = keywords.filter((k) => lower.includes(String(k).toLowerCase()));
  const disqualifiers = [...titleDisqualifiers(title), ...locationDisqualifiers(location)];
  if (disqualifiers.length > 0) {
    return { grade: 'D', keywords_matched: matched, disqualifiers };
  }
  let grade;
  if      (matched.length === 0) grade = 'D';
  else if (matched.length === 1) grade = 'C';
  else if (matched.length === 2) grade = 'B';
  else                           grade = 'A';
  return { grade, keywords_matched: matched };
}

/**
 * Parse data/scan-history.tsv into entry objects.
 * TSV header: url\tfirst_seen\tportal\ttitle\tcompany\tstatus[\tlocation]
 *
 * B-17d (2026-08-02): `location` is a 7th column added by scan.mjs. Rows written
 * before that change have only 6 columns and yield location === '', which is
 * treated as "unknown" and disqualifies nothing — so old history stays valid.
 * @param {string} filePath
 * @returns {Array<{url, first_seen, portal, title, company, status, location}>}
 */
export function parseScanHistory(filePath) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const [url, first_seen, portal, title, company, status, location] = line.split('\t');
    return {
      url:        (url        || '').trim(),
      first_seen: (first_seen || '').trim(),
      portal:     (portal     || '').trim(),
      title:      (title      || '').trim(),
      company:    (company    || '').trim(),
      status:     (status     || '').trim(),
      location:   (location   || '').trim(),
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

  // Grading mode toggle (config/profile.yml grading.mode): "substance" grades on
  // JD fit vs the value prop; "title" reverts to the keyword-count matcher.
  let gradeMode = 'title';
  try {
    const prof = yaml.load(readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf8'));
    if (prof?.grading?.mode === 'substance') gradeMode = 'substance';
  } catch { /* default to title */ }
  console.log(`[worker-grader] mode: ${gradeMode}`);
  const { scoreSubstance, fetchJd } = gradeMode === 'substance'
    ? await import('./substance-grader.mjs')
    : { scoreSubstance: null, fetchJd: null };

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

  const gradeEntry = async (e) => {
    const base = {
      company: e.company, role: e.title, location: e.location || '',
      platform: normalizePlatform(e.portal), url: e.url,
    };
    // Geographic hard-disqualifiers (foreign locations) apply in both modes.
    const disqualifiers = [...titleDisqualifiers(e.title), ...locationDisqualifiers(e.location)];
    if (disqualifiers.length > 0) {
      return { ...base, grade: 'D', jd_snippet: null, keywords_matched: [], disqualifiers };
    }
    // JD (substance mode) is also used to detect remote/hybrid wording for the gate.
    const jd = gradeMode === 'substance' ? await fetchJd(e.url, base.platform).catch(() => '') : '';
    // Commute gate: keep remote/hybrid and local (~24 mi of 75067); drop onsite
    // roles outside the local radius. Unknown location is kept (no drop on missing data).
    const gate = passesCommuteGate(e.location, `${e.title}\n${jd}`);
    if (!gate.keep) {
      return { ...base, grade: 'D', jd_snippet: null, keywords_matched: [], disqualifiers: [`commute:${gate.reason}`] };
    }
    if (gradeMode === 'substance') {
      const { grade, score, matched, penalized } = scoreSubstance(`${e.title}\n${jd}\n${e.location}`);
      return {
        ...base, grade,
        jd_snippet: jd ? jd.slice(0, 220) : null,
        fit_score: score, matched_terms: matched,
        ...(penalized.length ? { penalized_terms: penalized } : {}),
        jd_used: Boolean(jd), commute: gate.reason,
      };
    }
    const { grade, keywords_matched } = gradeJob(e.title, keywords, e.location);
    return { ...base, grade, jd_snippet: null, keywords_matched, commute: gate.reason };
  };
  const graded = await Promise.all(recent.map(gradeEntry));

  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const g of graded) counts[g.grade]++;
  const dq = graded.filter((g) => g.disqualifiers).length;
  console.log(`[worker-grader] graded ${graded.length}: A=${counts.A} B=${counts.B} C=${counts.C} D=${counts.D}${dq ? ` (B-17 disqualified: ${dq})` : ''}`);

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

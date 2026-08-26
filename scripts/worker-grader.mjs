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
import { passesCommuteGate, isUnresolvedMultiLocation } from './locations.mjs';
import { loadRegistry, gradeWithReferral } from './referral-registry.mjs';

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
const FOREIGN_TITLE_RE = /\b(brazil|brasil|belo horizonte|sao paulo|são paulo|rio de janeiro|porto alegre|curitiba|campinas|recife|florianopolis|florianópolis|salvador|fortaleza|brasilia|brasília|mexico|argentina|colombia|chile|peru|canada|toronto|vancouver|ireland|dublin|london|england|united kingdom|scotland|wales|northern ireland|edinburgh|glasgow|glenrothes|fife|belfast|cardiff|slough|swindon|harlow|milton keynes|nagpur|chennai|kolkata|ahmedabad|noida|gurgaon|gurugram|coimbatore|indore|jaipur|kochi|thiruvananthapuram|trivandrum|mysore|chandigarh|bhubaneswar|vadodara|nashik|gandhinagar|bogota|bogotá|medellin|medellín|guadalajara|monterrey|queretaro|querétaro|heredia|cebu|davao|hanoi|ho chi minh|saigon|bangkok|thailand|kuala lumpur|malaysia|taipei|taiwan|seoul|south korea|hong kong|osaka|kyoto|shenzhen|guangzhou|hangzhou|casablanca|morocco|tunis|tunisia|dhaka|bangladesh|karachi|lahore|islamabad|pakistan|colombo|sri lanka|yokneam|haifa|herzliya|jerusalem|riyadh|saudi arabia|doha|qatar|abu dhabi|germany|berlin|munich|france|paris|spain|madrid|barcelona|portugal|lisbon|poland|warsaw|krakow|netherlands|amsterdam|belgium|brussels|italy|milan|rome|india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|japan|tokyo|china|shanghai|beijing|singapore|australia|sydney|melbourne|philippines|manila|vietnam|indonesia|jakarta|israel|tel aviv|dubai|egypt|cairo|nigeria|lagos|kenya|nairobi|south africa|romania|bucharest|prague|hungary|budapest|ukraine|kyiv|turkey|istanbul|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|switzerland|zurich|austria|vienna|greece|athens|costa rica|guatemala|uruguay|montevideo|ecuador|bolivia|paraguay|estonia|tallinn|latvia|riga|lithuania|vilnius|slovakia|bratislava|slovenia|ljubljana|croatia|zagreb|serbia|belgrade|bulgaria|sofia|luxembourg|iceland|reykjavik|malta|cyprus|new zealand|auckland|wellington|uganda|kampala|ghana|accra|tanzania|ethiopia|addis ababa|armenia|yerevan|georgia \(country\)|tbilisi|kazakhstan|almaty|uzbekistan|tashkent|azerbaijan|baku)\b/i;

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
// B-0821-2 (2026-08-21): the "a US option exists" escape hatch tested
// US_LOCATION_OK, which includes the bare token `remote`. So ANY location
// containing the word "remote" was accepted as proof of a US option and
// returned early — never reaching the foreign screen below:
//
//   "Remote - Estonia"  → matches /remote/ → return []  → graded A → APPLIED
//   "Remote - India"    → same short-circuit
//
// "Remote" says nothing about WHERE; a remote role in Estonia still requires
// Estonian work authorisation. The early-return must key on an actual US
// token. Dropping `remote` from THIS test is safe precisely because the
// early-return only changes an outcome when a foreign token is also present:
// a plain "Remote"/"Remote Nationwide" still matches no foreign token and
// still returns clean. Genuinely dual-sited postings keep the asymmetry —
// "Remote within Canada or United States" hits `united states` and passes.
//
// B-0816-3 (logged 2026-08-16, closed 2026-08-21): the US token set recognised
// only us/usa/united states/dallas/texas/tx, so a genuinely dual-sited posting
// like "New York; London" or "Chicago, Illinois; Berlin" matched NO US token,
// fell through to the foreign screen and was hard-D'd — the exact false
// negative the asymmetry above exists to prevent. Extended to the 50 states
// (names + postal codes) and the larger US metros.
//
// Deliberately EXCLUDED as ambiguous with foreign places already on the
// foreign list — adding these would let a foreign posting pass:
//   georgia (Tbilisi), ohio→none, "la" (too short/ambiguous), "in" (India),
//   "or" (conjunction), "me" (pronoun), "hi", "ok", "de", "pa" as bare codes.
// Postal codes are therefore matched only in an upper-case, comma-preceded or
// hyphen-delimited context via US_STATE_CODE_RE below.
const US_STATE_NAME_RE = new RegExp('\\b(' + [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','idaho','illinois','indiana','iowa','kansas','kentucky',
  'louisiana','maine','maryland','massachusetts','michigan','minnesota',
  'mississippi','missouri','montana','nebraska','nevada','new hampshire',
  'new jersey','new mexico','new york','north carolina','north dakota','ohio',
  'oklahoma','oregon','pennsylvania','rhode island','south carolina',
  'south dakota','tennessee','utah','vermont','virginia','washington',
  'west virginia','wisconsin','wyoming','district of columbia',
  // major metros that often appear without a state
  'new york city','nyc','chicago','los angeles','san francisco','seattle',
  'boston','atlanta','denver','phoenix','houston','austin','san diego',
  'san jose','philadelphia','charlotte','minneapolis','detroit','tampa',
  'orlando','miami','portland','pittsburgh','baltimore','st louis',
  'salt lake city','kansas city','las vegas','nashville','columbus',
  'indianapolis','milwaukee','sacramento','raleigh','richmond','cincinnati',
  'cleveland','bellevue','redmond','sunnyvale','santa clara','mountain view',
  'palo alto','fort worth','plano','frisco','irving','arlington','mckinney',
].join('|') + ')\\b', 'i');

// Two-letter postal codes only in an unambiguous delimited context:
// "US-TX-PLANO", "Charlotte, NC", "NJ - Work from home", "CA, US".
const US_STATE_CODE_RE = /(?:^|[,\-\/(\s])(A[LKZR]|C[AOT]|DE|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY]|DC)(?:[,\-\/)\s]|$)/;

const US_OPTION_EXISTS_BASE = /\b(us|usa|u\.s|united states|dallas|texas|tx)\b/i;

/** True when the location names a genuine US option (state, metro, or code). */
function hasUsOption(loc) {
  return US_OPTION_EXISTS_BASE.test(loc)
      || US_STATE_NAME_RE.test(loc)
      || US_STATE_CODE_RE.test(loc);
}

export function locationDisqualifiers(location) {
  const loc = String(location || '').trim();
  if (!loc) return []; // pre-B-17d history rows: unknown, never disqualify
  if (hasUsOption(loc)) return []; // a genuine US option exists
  const out = [];
  const foreign = loc.replace(/new mexico/ig, '').match(FOREIGN_TITLE_RE);
  if (foreign) out.push(`foreign-location-field:${foreign[1].toLowerCase()}`);
  if (BR_STATE_SUFFIX_RE.test(loc)) out.push('foreign-location-field:br-state-suffix');
  return out;
}

/**
 * B-0816-1 (2026-08-16): board cards carry `location: null` — the scan-time
 * location never survives into Airtable, so locationDisqualifiers() sees '' and
 * returns "unknown, never disqualify" at every downstream gate. On 2026-08-16
 * that let a Glenrothes-Fife (Scotland) RTX role reach the Submit Ready lane
 * graded A.
 *
 * Workday/Greenhouse/Lever all embed the posting location in the URL path
 * (".../job/Glenrothes-Fife/Transformation-...", ".../job/TX---Work-from-home/...").
 * Recovering it costs zero network calls and zero tokens — pure string work on
 * data already in hand.
 *
 * Conservative by design: returns '' when no location segment is recognised, so
 * an unparsed URL degrades to today's behaviour (unknown => no disqualifier)
 * rather than inventing a reason to drop a card.
 *
 * @param {string} url ATS posting URL
 * @returns {string} human-readable location, or '' when undeterminable
 */
export function locationFromAtsUrl(url) {
  const u = String(url || '');
  if (!u) return '';
  const m = u.match(/\/job\/([^/?#]+)/i);
  if (!m) return '';
  return decodeURIComponent(m[1])
    .replace(/-{2,}/g, ' ')      // Workday encodes ', ' and ' - ' as '---'
    .replace(/[-_+]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Effective location for gating: the explicit field when present, else recovered
 * from the URL. Keeps every caller on one definition (B-0816-1).
 * @param {{location?: string|null, url?: string}} card
 * @returns {string}
 */
// B-0821-1 (2026-08-21): an unresolved Workday aggregate ("2 Locations",
// "61 Locations", "Multiple Locations") is TRUTHY, so it short-circuited the
// URL-derivation fallback and was handed to the commute gate verbatim. The gate
// can't read geography out of it, so it took the deliberate KEEP branch added by
// B-0817-1 — meaning a placeholder location fared BETTER than a blank one:
//
//   location ""            → derive "Basildon Endeavour Drive" from URL → DROP  ✅
//   location "2 Locations" → gate sees "2 Locations"                   → KEEP  ❌
//
// Measured effect: 21 of 34 A-grades in the week of 2026-08-15 rode the
// `location-unresolved` fail-open, including Fiserv "Payment Relations Manager
// EMEA Acquiring" in Basildon, UK — graded A and injected into the HOT lane.
// B-0817-1's own reasoning says the placeholder means *unknown*; unknown must
// therefore take the same recovery path a blank takes, and only fail open when
// the URL yields nothing either.
export function effectiveLocation(card) {
  const explicit = String(card?.location || '').trim();
  if (explicit && !isUnresolvedMultiLocation(explicit)) return explicit;
  // Unknown (blank OR unresolved placeholder): recover from the ATS URL path.
  // Fall back to the original placeholder so the gate still sees "unknown"
  // rather than "" — both KEEP, but the reason code stays truthful.
  return locationFromAtsUrl(card?.url) || explicit;
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

  // Referral registry (CHANGE 3): a company where Rahil has a live referral path
  // overlays grade S (above A) on the otherwise-computed grade. Loaded ONCE;
  // degrades to an empty registry (no S) if the file is missing/broken.
  const registry = loadRegistry(undefined, yaml);
  if (registry.entries.length) {
    console.log(`[worker-grader] referral registry: ${registry.entries.length} entr(y|ies) loaded — S-grade overlay active`);
  } else if (registry.error) {
    console.warn(`[worker-grader] referral registry unreadable (${registry.error}) — no S overlay this run`);
  }

  // Overlay S on a non-D base grade when the company has a referral match. D
  // (hard-disqualified: foreign location, commute, anti-fit) is never rescued.
  const overlayS = (result) => {
    const { grade, referral } = gradeWithReferral(result.grade, result.company, registry);
    if (grade === 'S') {
      return { ...result, grade: 'S', referral_via: referral.via, referral_person: referral.entry.person || null };
    }
    return result;
  };

  const gradeEntry = async (e) => {
    // B-0816-1 / K-0816-4 (2026-08-16): scan-history's location column is BLANK
    // on 70.7% of rows (1,349 of 1,909), so every geo check below has been
    // running on an empty string for roughly 7 of every 10 postings since the
    // gate was built — silently taking the "unknown, never disqualify" branch.
    // Recovering the location from the ATS URL path back-fills 464 of those
    // rows at zero network and zero token cost. A sweep of history under the
    // recovered values finds 276 geo-disqualified postings that previously
    // graded as if their location were unknown.
    const effLoc = effectiveLocation({ location: e.location, url: e.url });
    const base = {
      company: e.company, role: e.title, location: effLoc,
      location_source: e.location ? 'scan' : (effLoc ? 'url-derived' : 'none'),
      platform: normalizePlatform(e.portal), url: e.url,
    };
    // Geographic hard-disqualifiers (foreign locations) apply in both modes.
    const disqualifiers = [...titleDisqualifiers(e.title), ...locationDisqualifiers(effLoc)];
    if (disqualifiers.length > 0) {
      return { ...base, grade: 'D', jd_snippet: null, keywords_matched: [], disqualifiers };
    }
    // JD (substance mode) is also used to detect remote/hybrid wording for the gate.
    const jd = gradeMode === 'substance' ? await fetchJd(e.url, base.platform).catch(() => '') : '';
    // Commute gate: keep remote/hybrid and local (~24 mi of 75067); drop onsite
    // roles outside the local radius. Unknown location is kept (no drop on missing data).
    const gate = passesCommuteGate(effLoc, `${e.title}\n${jd}`);
    if (!gate.keep) {
      return { ...base, grade: 'D', jd_snippet: null, keywords_matched: [], disqualifiers: [`commute:${gate.reason}`] };
    }
    if (gradeMode === 'substance') {
      const { grade, score, matched, penalized } = scoreSubstance(`${e.title}\n${jd}\n${effLoc}`);
      return overlayS({
        ...base, grade,
        jd_snippet: jd ? jd.slice(0, 220) : null,
        fit_score: score, matched_terms: matched,
        ...(penalized.length ? { penalized_terms: penalized } : {}),
        jd_used: Boolean(jd), commute: gate.reason,
      });
    }
    const { grade, keywords_matched } = gradeJob(e.title, keywords, effLoc);
    return overlayS({ ...base, grade, jd_snippet: null, keywords_matched, commute: gate.reason });
  };
  const graded = await Promise.all(recent.map(gradeEntry));

  const counts = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const g of graded) counts[g.grade] = (counts[g.grade] || 0) + 1;
  const dq = graded.filter((g) => g.disqualifiers).length;
  console.log(`[worker-grader] graded ${graded.length}: S=${counts.S} A=${counts.A} B=${counts.B} C=${counts.C} D=${counts.D}${dq ? ` (B-17 disqualified: ${dq})` : ''}${counts.S ? ' — S = referral (human-hold)' : ''}`);

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

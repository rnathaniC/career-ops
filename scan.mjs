#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;
// Freshness gate: a posting older than this (by the employer's posted date, not
// when we found it) is dropped at scan time so the Fresh lane only holds newly
// posted roles. Override with portals.yml `fresh_max_posting_days`. Postings with
// no determinable date are kept (never dropped on missing data).
const DEFAULT_FRESH_MAX_POSTING_DAYS = 3;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  // Workday CXS API. Entries carry an explicit `api` field pointing at the
  // /wday/cxs/{tenant}/{site}/jobs endpoint (see portals.yml). `base` is the
  // public careers URL used to turn each posting's externalPath into a real
  // apply URL; derive it from the api endpoint if careers_url is absent.
  const wdApi = company.api && /myworkdayjobs\.com\/wday\/cxs\//.test(company.api) ? company.api : null;
  const wdFromCareers = /myworkdayjobs\.com/.test(url) ? url : null;
  if (wdApi || wdFromCareers) {
    const api = wdApi || deriveWorkdayApi(url);
    return { type: 'workday', url: api, base: company.careers_url || deriveWorkdayBase(api) };
  }

  return null;
}

/** From a CXS api url, derive the public careers base (origin + /{site}). */
function deriveWorkdayBase(apiUrl) {
  const m = apiUrl.match(/^(https:\/\/[^/]+)\/wday\/cxs\/[^/]+\/([^/]+)\/jobs/);
  return m ? `${m[1]}/${m[2]}` : apiUrl;
}

/** From a public careers url ({origin}/{site}), derive the CXS jobs endpoint. */
function deriveWorkdayApi(careersUrl) {
  const m = careersUrl.match(/^(https:\/\/([^.]+)\.[^/]+)\/([^/?#]+)/);
  if (!m) return careersUrl;
  const [, origin, tenant, site] = m;
  return `${origin}/wday/cxs/${tenant}/${site}/jobs`;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    postedAt: j.first_published || j.updated_at || null,
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
    postedAt: j.publishedAt || j.publishedDate || j.updatedAt || null,
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    postedAt: j.createdAt || null,
  }));
}

function parseWorkday(json, companyName, base) {
  const jobs = json.jobPostings || [];
  const origin = (base || '').replace(/\/+$/, '');
  return jobs.map(j => ({
    title: j.title || '',
    url: j.externalPath ? origin + j.externalPath : '',
    company: companyName,
    location: j.locationsText || '',
    postedAt: j.postedOn || null, // Workday returns fuzzy text e.g. "Posted 5 Days Ago"
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// Workday's CXS endpoint is a POST search API (unlike the GET boards above).
// Query it once per positive title term so we pull only relevant postings
// server-side instead of paging the entire tenant (RTX alone has ~1,100 jobs).
async function fetchWorkday(apiUrl, searchText = '', limit = 20, offset = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function scanWorkdaySite(apiUrl, base, companyName, searchTerms) {
  const terms = (searchTerms && searchTerms.length) ? searchTerms : [''];
  const seen = new Set();
  const out = [];
  for (const term of terms) {
    let json;
    try {
      json = await fetchWorkday(apiUrl, term);
    } catch {
      continue; // one bad term shouldn't sink the whole site
    }
    for (const job of parseWorkday(json, companyName, base)) {
      if (job.url && !seen.has(job.url)) {
        seen.add(job.url);
        out.push(job);
      }
    }
  }
  return out;
}

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Posting freshness ───────────────────────────────────────────────────────

/**
 * Age of a job posting in days, from the employer's posted date.
 * Handles ISO strings / epoch ms (Greenhouse/Ashby/Lever) and Workday's fuzzy
 * text ("Posted Today", "Posted 5 Days Ago", "Posted 30+ Days Ago").
 * Returns null when no date can be determined — callers KEEP those (no drop on
 * missing data).
 * @returns {number|null}
 */
export function postingAgeDays(postedAt, now = Date.now()) {
  if (postedAt == null || postedAt === '') return null;
  if (typeof postedAt === 'string') {
    const s = postedAt.trim().toLowerCase();
    // Workday-style relative text
    if (/posted\s+(just\s+)?today|^today$/.test(s)) return 0;
    if (/posted\s+yesterday|^yesterday$/.test(s)) return 1;
    const rel = s.match(/posted\s+(\d+)\+?\s*days?\s*ago|(\d+)\+?\s*days?\s*ago/);
    if (rel) return Number(rel[1] ?? rel[2]);
    if (/30\+?\s*days?/.test(s)) return 30;
  }
  // Numeric epoch (ms) or ISO/parseable date string
  const t = typeof postedAt === 'number'
    ? postedAt
    : Date.parse(postedAt);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

/** True if the posting is fresh enough for the Fresh lane (age <= max, or unknown age). */
export function isFreshPosting(postedAt, maxDays, now = Date.now()) {
  const age = postingAgeDays(postedAt, now);
  return age === null || age <= maxDays;
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // B-17d fix (2026-08-02, K-0724-1): persist `location` as a 7th column.
  // The scanner has always known each posting's location (it prints it in the
  // "New offers" block) but never wrote it down, so worker-grader.mjs could only
  // screen the TITLE for geography. That let postings whose foreign location
  // lives ONLY in the location field — "Coupa | TPM Security & GRC | Bogota,
  // Colombia" — grade B and become auto-submit eligible. Writing the column here
  // is the upstream half of the fix; the grader reads it downstream.
  //
  // Backward compatible: rows written before this change have 6 columns and the
  // parser yields location === '' for them, which disqualifies nothing.
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }

  // Tabs/newlines inside a location string would shift every downstream column.
  const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded\t${clean(o.location)}`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  // Positive title terms double as Workday server-side search queries.
  const workdaySearchTerms = config.title_filter?.positive || [];
  const freshMaxDays = Number.isFinite(config.fresh_max_posting_days)
    ? config.fresh_max_posting_days
    : DEFAULT_FRESH_MAX_POSTING_DAYS;

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalStale = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url, base } = company._api;
    try {
      const jobs = type === 'workday'
        ? await scanWorkdaySite(url, base, company.name, workdaySearchTerms)
        : PARSERS[type](await fetchJson(url), company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        // Freshness gate: drop postings older than the cutoff so the Fresh lane
        // only surfaces newly posted roles (unknown-date postings are kept).
        if (!isFreshPosting(job.postedAt, freshMaxDays)) {
          totalStale++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Stale (>${freshMaxDays}d posted):   ${totalStale} dropped`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

// CLI guard — only run the scan when invoked directly (allows importing the
// exported helpers, e.g. postingAgeDays, in tests without triggering a scan).
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_CLI) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

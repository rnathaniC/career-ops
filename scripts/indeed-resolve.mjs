#!/usr/bin/env node
/**
 * indeed-resolve.mjs — turn Indeed click-tracking shortlinks into real ATS URLs.
 *
 * WHY (Rahil approved 2026-08-10): Indeed's search_jobs returns opaque
 * shortlinks — `https://to.indeed.com/aa9v9k7f7vtm` — not employer URLs. Every
 * downstream decision we make is keyed off the ATS detected from the URL
 * (detectATS → fillForm → getAtsSubmitSelectors), so an unresolved Indeed card
 * routes as "unknown" and falls to fillGenericForm — the same path that produced
 * the B-16 empty-form click. Resolving the redirect FIRST lets Indeed-sourced
 * jobs flow into the lanes and fillers that already exist, correctly routed,
 * with no exclusive lane and no new submit mechanism.
 *
 * This is the hard prerequisite for ANY Indeed pipeline flow.
 *
 * Resolution is cached in data/indeed-url-cache.json — shortlinks are stable, so
 * a resolved link never needs a second network call. That keeps the nightly run
 * cheap and means a rate-limited or offline resolve degrades to "leave the card
 * alone" rather than mis-routing it.
 *
 * NOTE ON VALIDATION: the network path is deliberately behind an injectable
 * `fetchImpl` seam and the unit tests drive it with mocks. Live resolution is
 * intentionally NOT exercised from the sandbox — that IP is already CAPTCHA-
 * walled (see K-0723-1), and hammering Indeed's redirect service from it would
 * risk the reputation of an IP we still need. Validate live on Windows.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = pathResolve(__dirname, '..');
const DATA       = join(ROOT, 'data');

export const URL_CACHE_PATH = join(DATA, 'indeed-url-cache.json');

/** Hosts whose links are click-trackers rather than real destinations. */
export const SHORTLINK_HOSTS = [/(^|\.)to\.indeed\.com$/i, /(^|\.)indeed\.com$/i];

const MAX_REDIRECTS = 8;
const TIMEOUT_MS    = 12_000;

/**
 * Is this a link that needs resolving before we can route it?
 * @param {string} url
 * @returns {boolean}
 */
export function isIndeedShortlink(url) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return SHORTLINK_HOSTS.some((re) => re.test(h));
  } catch { return false; }
}

/**
 * Detect the ATS behind a resolved URL. Mirrors auto-submit.mjs ATS_PATTERNS so
 * the resolver and the submitter can never disagree about what a URL is.
 * Kept as its own copy rather than imported: auto-submit.mjs pulls in Playwright
 * at module load, and the resolver must stay dependency-light enough to run in
 * the scan phase.
 * @param {string} url
 * @returns {string}
 */
export function detectAtsFromUrl(url) {
  if (!url) return 'unknown';
  const pats = [
    ['greenhouse', /greenhouse\.io|boards\.greenhouse\.io/i],
    ['lever',      /lever\.co/i],
    ['ashby',      /ashbyhq\.com/i],
    ['workday',    /myworkdayjobs\.com|wd\d+\.myworkdayjobs/i],
    ['icims',      /icims\.com/i],
    ['smartrecruiters', /smartrecruiters\.com/i],
    ['taleo',      /taleo\.net/i],
    ['successfactors', /successfactors\.com|jobs\.sap\.com/i],
    ['bamboohr',   /bamboohr\.com/i],
    ['jobvite',    /jobvite\.com/i],
    ['workable',   /workable\.com/i],
    ['indeed',     /indeed\.com/i],
    ['linkedin',   /linkedin\.com\/jobs/i],
  ];
  for (const [name, re] of pats) if (re.test(url)) return name;
  return 'unknown';
}

/**
 * Strip Indeed's tracking parameters from a resolved URL so two cards pointing
 * at the same req dedupe against each other instead of looking distinct.
 * @param {string} url
 * @returns {string}
 */
export function stripTrackingParams(url) {
  try {
    const u = new URL(url);
    const junk = [/^utm_/i, /^gh_src$/i, /^src$/i, /^from$/i, /^indeed/i, /^iis$/i, /^cmpid$/i];
    for (const key of [...u.searchParams.keys()]) {
      if (junk.some((re) => re.test(key))) u.searchParams.delete(key);
    }
    u.hash = '';
    return u.toString();
  } catch { return url; }
}

/**
 * Default network resolver: follow redirects and report the final URL.
 * Uses GET (not HEAD) — Indeed's tracker has been observed to answer HEAD with
 * 405 on some links, and a 405 would look like a hard failure rather than a
 * redirect we simply did not follow.
 * @param {string} url
 * @returns {Promise<{ok:boolean, finalUrl:string|null, status:number|null}>}
 */
export async function defaultFetchImpl(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    return { ok: res.ok, finalUrl: res.url || null, status: res.status };
  } catch {
    return { ok: false, finalUrl: null, status: null };
  } finally { clearTimeout(timer); }
}

/**
 * Resolve one shortlink to its destination.
 *
 * Returns a result object rather than throwing: an unresolvable link must leave
 * the card untouched, never mis-route it.
 *
 * @param {string} url
 * @param {{fetchImpl?:Function, cache?:object}} [opts]
 * @returns {Promise<{url:string, resolved:string|null, ats:string, ok:boolean, reason:string}>}
 */
export async function resolveOne(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? defaultFetchImpl;
  if (!url) return { url, resolved: null, ats: 'unknown', ok: false, reason: 'empty-url' };

  if (!isIndeedShortlink(url)) {
    // Already a real URL — nothing to resolve, but still report its ATS.
    return { url, resolved: url, ats: detectAtsFromUrl(url), ok: true, reason: 'not-a-shortlink' };
  }

  const cached = opts.cache?.entries?.[url];
  if (cached?.resolved) {
    return { url, resolved: cached.resolved, ats: cached.ats ?? detectAtsFromUrl(cached.resolved), ok: true, reason: 'cache' };
  }

  const res = await fetchImpl(url);
  if (!res?.finalUrl) {
    return { url, resolved: null, ats: 'unknown', ok: false, reason: `unresolved${res?.status ? `:${res.status}` : ''}` };
  }
  const clean = stripTrackingParams(res.finalUrl);
  const ats   = detectAtsFromUrl(clean);
  // A shortlink that lands back on indeed.com is Indeed-hosted apply, not a
  // company ATS. Flag it distinctly — we have no filler for that surface, so it
  // must NOT be quietly treated as a resolved, routable card.
  const hosted = isIndeedShortlink(clean);
  return {
    url,
    resolved: clean,
    ats: hosted ? 'indeed-hosted' : ats,
    ok: true,
    reason: hosted ? 'indeed-hosted-apply' : 'resolved',
  };
}

/**
 * Resolve many links, sequentially and politely.
 * Sequential on purpose: a redirect service is exactly the kind of endpoint that
 * rate-limits a burst, and we are never in a hurry here.
 * @param {string[]} urls
 * @param {{fetchImpl?:Function, cache?:object, delayMs?:number, sleep?:Function}} [opts]
 * @returns {Promise<object[]>}
 */
export async function resolveMany(urls, opts = {}) {
  const delayMs = opts.delayMs ?? 250;
  const sleep   = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const out = [];
  const seen = new Set();
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    const r = await resolveOne(u, opts);
    out.push(r);
    if (r.reason !== 'cache' && r.reason !== 'not-a-shortlink' && delayMs > 0) await sleep(delayMs);
  }
  return out;
}

// ── cache I/O ─────────────────────────────────────────────────────────────────

export function loadUrlCache(p = URL_CACHE_PATH) {
  if (!existsSync(p)) return { version: 1, entries: {} };
  try {
    const c = JSON.parse(readFileSync(p, 'utf8'));
    return c?.entries ? c : { version: 1, entries: {} };
  } catch { return { version: 1, entries: {} }; }
}

export function saveUrlCache(cache, p = URL_CACHE_PATH) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cache, null, 2) + '\n');
}

/**
 * Fold resolution results back into a card list, rewriting url + platform.
 * The original shortlink is preserved as `source_url` so the audit trail from
 * "what Indeed told us" to "where we actually applied" is never lost.
 * @param {object[]} cards
 * @param {object[]} results
 * @returns {{cards:object[], stats:object}}
 */
export function applyResolutions(cards, results) {
  const byUrl = new Map(results.map((r) => [r.url, r]));
  const stats = { resolved: 0, unresolved: 0, hosted: 0, untouched: 0 };
  const out = cards.map((c) => {
    const r = byUrl.get(c.url);
    if (!r || !r.ok || !r.resolved || r.reason === 'not-a-shortlink') {
      if (r && !r.ok) stats.unresolved++; else stats.untouched++;
      return c;
    }
    if (r.ats === 'indeed-hosted') {
      stats.hosted++;
      return { ...c, source_url: c.url, url: r.resolved, platform: 'indeed-hosted', needs_human_apply: true };
    }
    stats.resolved++;
    return { ...c, source_url: c.url, url: r.resolved, platform: r.ats };
  });
  return { cards: out, stats };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function argVal(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

async function main() {
  const date    = argVal('--date', new Date().toISOString().slice(0, 10));
  const inPath  = pathResolve(ROOT, argVal('--in', join(DATA, `graded-jobs-${date}.json`)));
  const outPath = pathResolve(ROOT, argVal('--out', inPath));
  const cachePath = pathResolve(ROOT, argVal('--cache', URL_CACHE_PATH));

  if (!existsSync(inPath)) {
    console.log(`[indeed-resolve] no graded file at ${inPath} — nothing to do (exit 0)`);
    process.exit(0);
  }
  const cards = JSON.parse(readFileSync(inPath, 'utf8'));
  const cache = loadUrlCache(cachePath);

  const targets = cards.filter((c) => isIndeedShortlink(c.url)).map((c) => c.url);
  if (targets.length === 0) {
    console.log(`[indeed-resolve] 0 Indeed shortlinks in ${cards.length} card(s) — nothing to resolve (exit 0)`);
    process.exit(0);
  }
  console.log(`[indeed-resolve] resolving ${targets.length} shortlink(s)…`);
  const results = await resolveMany(targets, { cache });

  for (const r of results) {
    if (r.ok && r.resolved) cache.entries[r.url] = { resolved: r.resolved, ats: r.ats, at: date };
  }
  saveUrlCache(cache, cachePath);

  const { cards: next, stats } = applyResolutions(cards, results);
  writeFileSync(outPath, JSON.stringify(next, null, 2) + '\n');
  console.log(`[indeed-resolve] ${stats.resolved} routed, ${stats.hosted} Indeed-hosted (human apply), ${stats.unresolved} unresolved`);
  for (const r of results.filter((x) => x.ok && x.resolved)) {
    console.log(`[indeed-resolve]   ${r.ats.padEnd(16)} ${r.resolved.slice(0, 90)}`);
  }
  console.log(`[indeed-resolve] written → ${outPath}`);
}

const IS_CLI = process.argv[1] && pathResolve(process.argv[1]) === pathResolve(__filename);
if (IS_CLI) {
  main().catch((e) => { console.error('[indeed-resolve] FATAL:', e.message); process.exit(1); });
}

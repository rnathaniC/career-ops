#!/usr/bin/env node
/**
 * auto-submit.mjs — Automated job application assistant
 *
 * MODES (mutually exclusive, default = dry-run):
 *   --dry-run     Analysis only. No browser, no submissions.
 *   --semi-auto   Fills form in visible Chromium, stops before submit. YOU click.
 *   --park-ready  No browser. Gates eligible cards on readiness, then moves each
 *                 passing card to the Airtable "Submit Ready" lane for Rahil's
 *                 manual final Submit click. This is the auto-fill-to-submit-ready
 *                 model — the honest answer to the reCAPTCHA submit-gate ceiling.
 *   --live        Full automation. ALL THREE safety locks required.
 *
 * SAFETY LOCKS FOR --live (BOTH REQUIRED to arm live mode):
 *   (a) --allow-tier <tier>                            CLI flag
 *   (b) config/lower-tier-test-companies.yml           enabled: true  (global kill-switch)
 * Per-card gates then apply to EVERY submission: grade A/B/C eligibility +
 * readiness band (>=60) + 5/day cap. Per-company allowlist removed 2026-06-18.
 *
 * CLI:
 *   node scripts/auto-submit.mjs [--kanban <path>] [--limit N] [options]
 *
 * Flags:
 *   --kanban <path>          Kanban HTML path (default: dashboard/job-pulse-kanban.html)
 *   --kanban-json <path>     K2 exportState() JSON path (mutually exclusive with --kanban)
 *   --limit N                Max cards per run (default: 5; live hard cap 5/day overrides)
 *   --card <id>              Single-card mode for targeted testing
 *   --card-ids <id,id,...>   Comma-separated allowlist of card IDs to process (e.g. the
 *                            New-Fresh subset from `npm run referral-queue`). Filters the
 *                            already-eligible set further — never expands it, so warm-
 *                            referral cards stay excluded even if their ID is passed by
 *                            mistake. IDs not present in the eligible set are skipped with
 *                            a log line, not a fatal error (unlike --card).
 *   --dry-run                Explicit dry-run (default if no mode flag)
 *   --report                 With --dry-run: pretty-print results as markdown table to stdout
 *   --semi-auto              Visible Chromium, form prepped, human clicks submit
 *   --live                   Full automation (requires --allow-tier + YAML config)
 *   --allow-tier <tier>      Required with --live (e.g. --allow-tier lower)
 *   --ready-states <states>  Comma-separated canonical state IDs eligible for submission
 *                            (default: evaluated). Example: --ready-states evaluated,responded
 *                            Valid IDs come from gen/states.js (VALID_IDS). 'new' is allowed
 *                            but not in gen/states.js — use only for testing fresh ingest.
 *   --use-extension-autofill Force browser-extension autofill (skip built-in form fill)
 *   --no-extension-autofill  Disable extension autofill (use built-in Greenhouse/Lever/Workday fill)
 *   --browser-mode <mode>    connect = CDP attach to a running debug browser (default when profile set)
 *                            launch  = persistent context or fresh Chromium launch
 *   --debug-port <n>         Remote debugging port for CDP attach (default 9222)
 *
 * Output:
 *   data/auto-submit-dry-run-{date}.json
 *   data/semi-auto-{date}.json
 *   data/live-runs-{date}.json
 *   data/dead-listings-{date}.json
 *   data/screenshots/{date}/
 *   data/live-daily-count-{date}.json
 *
 * Exit codes:
 *   0 = all processed cards handled cleanly
 *   1 = fatal (kanban missing, safety lock failed, Playwright unavailable)
 *   2 = partial: some cards CAPTCHA-blocked or requires-human
 *   3 = partial: some cards form-blocked (no submit button, dead listing)
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLiveness } from './check-job-liveness.mjs';
import { loadPersonalInfo, PersonalInfoError } from './load-personal-info.mjs';
import { loadBrowserConfig, BrowserConfigError } from './load-browser-config.mjs';
import { ensureDebugBrowser } from './ensure-debug-browser.mjs';
import { getValidSessionPath as getValidWorkdaySessionPath } from './workday-login.mjs';
import { fillForm, formatUploadDetails } from './form-fill.mjs';
import { VALID_IDS as CANONICAL_STATE_IDS } from '../gen/states.js';
import { scoreCard, saveReadinessScore } from './readiness-scorer.mjs';
import {
  BASE_ID, ACTIVE_TABLE_ID, ACTIVE_FIELD_IDS, CARD_ID_FIELD, LAST_REFRESHED_FIELD,
  PAT_MISSING_MSG, airtableListAll, airtablePatchBatch,
} from './airtable-sync.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');

let yaml;
try {
  ({ default: yaml } = await import('js-yaml'));
} catch { /* yaml only needed for --live YAML safety check */ }

// ── Arg parsing ───────────────────────────────────────────────────────────────

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? (process.argv[i + 1] ?? null) : null;
}

const KANBAN_PATH       = argVal('--kanban') || path.join(ROOT, 'dashboard', 'job-pulse-kanban.html');
// Default source: the live K2 board export (data/board-state.json). The HTML
// kanban on disk is an empty shell — real cards live in browser localStorage —
// so reading it always yields "0 eligible". board-state.json is the bridge:
// the morning refresh exports the live board to it. Explicit --kanban-json or
// --kanban still win. Falls back to HTML only if the export is missing.
const DEFAULT_BOARD_JSON = path.join(ROOT, 'data', 'board-state.json');
const KANBAN_JSON       = argVal('--kanban-json')
  || (!argVal('--kanban') && fs.existsSync(DEFAULT_BOARD_JSON) ? DEFAULT_BOARD_JSON : null);
const CL_DIR_ARG        = argVal('--cl-dir')   || path.join(ROOT, 'cover-letters');
const CL_INDEX_ARG      = argVal('--cl-index') || path.join(CL_DIR_ARG, 'index.yml');
const READY_STATES_ARG  = argVal('--ready-states') || null;
const CARD_ID           = argVal('--card');
const CARD_IDS_ARG      = argVal('--card-ids');
const CARD_IDS          = CARD_IDS_ARG
  ? new Set(CARD_IDS_ARG.split(',').map((s) => s.trim()).filter(Boolean))
  : null;
const SEMI_AUTO         = process.argv.includes('--semi-auto');
// --park-ready (2026-08-02): non-browser staging mode. Applies the SAME eligibility
// + readiness gates as live, then moves each passing card's Airtable Lane to
// "Submit Ready" instead of attempting an automated submit click (which reCAPTCHA
// bot-detection silently blocks — the confirmed 0% ceiling). Rahil does the final
// human Submit click from the Submit Ready lane. Warm-referral/New-Hot cards are
// never in the eligible set, so they are untouched.
const PARK_READY        = process.argv.includes('--park-ready') && !SEMI_AUTO;
const LIVE              = process.argv.includes('--live') && !SEMI_AUTO && !PARK_READY;
const DRY_RUN           = !LIVE && !SEMI_AUTO && !PARK_READY;
// null = auto-determine from browser config (firefox → true, chromium → false)
const USE_EXTENSION_ARG = process.argv.includes('--no-extension-autofill') ? false
  : process.argv.includes('--use-extension-autofill') ? true
  : null;
const BROWSER_MODE_ARG  = argVal('--browser-mode');   // 'connect' | 'launch' | null
const DEBUG_PORT_ARG    = argVal('--debug-port');
const REPORT            = process.argv.includes('--report');
const ALLOW_TIER        = argVal('--allow-tier');
const RAW_LIMIT         = parseInt(argVal('--limit') ?? '5', 10);
const LIMIT             = isNaN(RAW_LIMIT) ? 5 : RAW_LIMIT;
// B-24 fix (2026-08-02): the post-click confirmation wait was hardcoded to 60s,
// but the sandbox executor kills any command at 45s. The browser was therefore
// torn down mid-wait on EVERY successful click, so a real submission could never
// report anything but UNCONFIRMED — manufacturing confirmation debt that then had
// to be reconciled by hand from Rahil's inbox. Making it configurable lets a
// sandbox run pass --confirm-timeout 25000 and finish inside its own window.
// Default stays 60000 so Windows/host runs are unchanged.
const RAW_CONFIRM_MS    = parseInt(argVal('--confirm-timeout') ?? '60000', 10);
const CONFIRM_TIMEOUT_MS = isNaN(RAW_CONFIRM_MS) || RAW_CONFIRM_MS < 1000 ? 60000 : RAW_CONFIRM_MS;
const DATE_STAMP        = new Date().toISOString().slice(0, 10);
const LIVE_DAILY_CAP    = 5;

// ── Submit-ready state resolution (reads gen/states.js) ───────────────────────

/**
 * Parse a comma-separated ready-states string into a validated Set.
 * Unknown states emit a warning but are still accepted (allows 'new' for testing).
 * @param {string|null} arg  e.g. "evaluated,responded" or null (→ default)
 * @returns {Set<string>}
 */
export function parseReadyStates(arg) {
  if (!arg) return new Set(['new', 'evaluated']);
  const parsed = arg.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  for (const s of parsed) {
    if (!CANONICAL_STATE_IDS.includes(s) && s !== 'new') {
      // 'new' is a valid K2 kanban state not in gen/states.js — exempt from warning
      console.warn(`[auto-submit] warn: "${s}" is not a recognized state in gen/states.js`);
    }
  }
  return new Set(parsed);
}

/**
 * Determine effective browser launch mode.
 * - 'connect' → CDP attach to a separately-launched debug browser (extensions active)
 * - 'launch'  → persistent context or fresh Chromium via Playwright
 *
 * Default: 'connect' when a chromium profile is configured; 'launch' otherwise.
 *
 * @param {string|null} arg          Value of --browser-mode flag (or null)
 * @param {object}      browserCfg   Result of loadBrowserConfig()
 * @returns {'connect'|'launch'}
 */
export function parseBrowserMode(arg, browserCfg) {
  if (arg === 'connect') return 'connect';
  if (arg === 'launch')  return 'launch';
  if (browserCfg?.preferred === 'firefox') return 'launch';
  // Chromium: connect when a profile is configured (implies SpeedyApply use case)
  return browserCfg?.chromium?.profile_path ? 'connect' : 'launch';
}

/**
 * Parse --debug-port argument. Returns 9222 for invalid/absent values.
 * @param {string|null} arg
 * @returns {number}
 */
export function parseDebugPort(arg) {
  const n = parseInt(arg ?? '9222', 10);
  return (!isNaN(n) && n >= 1 && n <= 65535) ? n : 9222;
}

/**
 * Canonical set of states whose cards are eligible for auto-submission.
 * Default: ['new', 'evaluated'] — freshly fetched or user-scored, not yet actioned.
 * Override: --ready-states evaluated,responded
 */
export const SUBMIT_READY_STATES = parseReadyStates(READY_STATES_ARG);

/**
 * Single source of truth for card eligibility.
 * Used by both extractEligibleCards (HTML path) and extractEligibleCardsFromJson (JSON path).
 * @param {{ columnId: string, grade: string|null, isWarmReferral: boolean }} card
 * @returns {boolean}
 */
export function isEligible(card) {
  return (
    SUBMIT_READY_STATES.has(card.columnId) &&
    (card.grade === 'A' || card.grade === 'B') &&
    !card.isWarmReferral
  );
}

/**
 * Three-band readiness rule for eligible cards (already grade A/B/C):
 *   total < 60        -> skip
 *   60 <= total <= 88 -> submit WITHOUT cover letter
 *   total >= 89       -> submit WITH cover letter (requires one; hold if missing)
 * @param {number} total  readiness total (0-100)
 * @param {boolean} hasCl whether a cover-letter file was matched
 * @returns {{ action:'skip'|'submit', attachCl:boolean, band:string, reason:string }}
 */
export function readinessGate(total, hasCl) {
  if (total < 60) return { action: 'skip',   attachCl: false, band: '<60',   reason: `below 60 (${total})` };
  if (total < 89) return { action: 'submit', attachCl: false, band: '60-88', reason: `mid band (${total}) -- submit without CL` };
  if (!hasCl)     return { action: 'skip',   attachCl: false, band: '89+',   reason: `89+ (${total}) requires a CL but none found` };
  return            { action: 'submit', attachCl: true,  band: '89+',   reason: `high band (${total}) -- submit with CL` };
}

// ── ATS detection ─────────────────────────────────────────────────────────────

const ATS_PATTERNS = [
  { name: 'greenhouse', re: /greenhouse\.io|boards\.greenhouse\.io/i },
  { name: 'lever',      re: /lever\.co/i },
  { name: 'ashby',      re: /ashbyhq\.com/i },
  { name: 'workday',    re: /myworkdayjobs\.com|wd\d+\.myworkdayjobs/i },
  { name: 'icims',      re: /icims\.com/i },
  { name: 'indeed',     re: /indeed\.com/i },
  { name: 'linkedin',   re: /linkedin\.com\/jobs/i },
];

export function detectATS(url) {
  if (!url) return 'unknown';
  for (const { name, re } of ATS_PATTERNS) {
    if (re.test(url)) return name;
  }
  // B-ATS-DETECT: company careers pages embed ATS widgets and carry the ATS's
  // job-id as a query param even when the domain is the company's own. These
  // markers are authoritative — e.g. careers.datadoghq.com/...?gh_jid=123 is a
  // Greenhouse-hosted role; SpeedyApply / built-in fill can then handle it.
  if (/[?&](gh_jid|gh_src)=/i.test(url)) return 'greenhouse';
  if (/[?&]ashby_jid=/i.test(url))       return 'ashby';
  if (/[?&]lever-(origin|source)=/i.test(url)) return 'lever';
  return 'unknown';
}

// ── Submit button selectors by ATS ────────────────────────────────────────────

const ATS_SUBMIT_SELECTORS = {
  greenhouse: ['button[aria-label="Submit"]', 'button:has-text("Submit Application")'],
  lever:      ['button#btn-submit', 'button:has-text("Submit application")'],
  // B-0716-ASHBY: Ashby renders a form-less React page — no <form>, no
  // button[type=submit] — so the generic fallback never matched. Its submit
  // control is a plain <button> labeled "Submit Application".
  ashby:      ['button:has-text("Submit Application")', 'button:has-text("Submit application")'],
  workday:    ['button[data-automation-id="submitButton"]', '[data-automation-id="bottom-navigation-next-button"]'],
};
const FALLBACK_SUBMIT_SELECTORS = ['button[type="submit"]:not([aria-hidden]):not([disabled])'];

export function getAtsSubmitSelectors(ats) {
  return [...(ATS_SUBMIT_SELECTORS[ats] || []), ...FALLBACK_SUBMIT_SELECTORS];
}

// ── CAPTCHA / intermediate step detection ─────────────────────────────────────

export const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '[id^="cf-challenge"]',
  '.g-recaptcha',
  '[data-sitekey]',
];

export const INTERMEDIATE_PATTERNS = [
  /review your application/i,
  /confirm submission/i,
  /verify your information/i,
];

export function isIntermediateStepText(text) {
  return INTERMEDIATE_PATTERNS.some((re) => re.test(text));
}

export async function detectCaptchaOnPage(page) {
  for (const sel of CAPTCHA_SELECTORS) {
    if (await page.$(sel).catch(() => null)) return true;
  }
  return false;
}

/**
 * K-DEFECT-2026-07-21 (CI&T / Lever): poll for a CAPTCHA immediately before the
 * submit click, not just once early. Some Lever-hosted ATS embeds attach an
 * invisible hCaptcha widget to the DOM after the page's initial settle wait —
 * late enough that a single early check (right after page.goto) sees nothing,
 * but early enough that it's fully present by the time submit is attempted.
 * Polls detectCaptchaOnPage at `intervalMs` until `timeoutMs` elapses or a
 * captcha is found, whichever comes first. Injectable `waiter` and `now` make
 * this unit-testable without a real Playwright page or real elapsed time.
 * @param {object} page
 * @param {{ timeoutMs?: number, intervalMs?: number, waiter?: (ms:number)=>Promise<void>, now?: () => number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function pollForCaptcha(page, opts = {}) {
  const {
    timeoutMs  = 3000,
    intervalMs = 500,
    waiter     = (ms) => new Promise((r) => setTimeout(r, ms)),
    now        = () => Date.now(),
  } = opts;

  let found = await detectCaptchaOnPage(page);
  if (found) return true;

  const deadline = now() + timeoutMs;
  while (!found && now() < deadline) {
    await waiter(intervalMs);
    found = await detectCaptchaOnPage(page);
  }
  return found;
}

async function detectIntermediateStepOnPage(page) {
  const text = await page.textContent('body').catch(() => '');
  return isIntermediateStepText(text);
}

// K-DEFECT-2026-07-07: some ATS embeds (confirmed live on careerpuck.com, Lyft's
// careers site — 2 real postings blocked today) wrap the actual Greenhouse form in
// an <iframe src="https://job-boards.greenhouse.io/embed/job_app?...">. page.$()
// only searches the MAIN frame — it never pierces into child frames — so the real
// submit button (`<button type="submit">Submit application</button>`, confirmed via
// live Playwright inspection) was invisible to findSubmitOnPage even though the
// existing selectors (incl. the type="submit" fallback) would have matched it fine
// once inside the right frame. Root cause is the frame boundary, not the selector
// text or scroll position. Fix: search the main frame first (existing behavior,
// zero regression risk for non-iframe ATSes), then fall back to every child frame.
// The embed can also lazy-load past the caller's short fixed wait (observed:
// present at ~3.5s/networkidle, absent at ~2s/domcontentloaded on the same URL) —
// so poll briefly for a same-origin-ATS-ish frame to attach before giving up.
async function findSubmitOnPage(page, ats) {
  const selectors = getAtsSubmitSelectors(ats);

  const searchFrame = async (frame) => {
    for (const sel of selectors) {
      try {
        const el = await frame.$(sel);
        if (el) return el;
      } catch { /* selector syntax error or frame navigated away — skip */ }
    }
    return null;
  };

  // 1) Main frame (covers the common non-iframe case — unchanged behavior).
  const mainHit = await searchFrame(page.mainFrame());
  if (mainHit) return mainHit;

  // 2) Re-check ALL frames on every tick for up to ~8s. A frame can attach
  //    before its document finishes loading, and SPA main frames (Ashby)
  //    hydrate their submit button seconds after domcontentloaded — so the
  //    main frame gets re-checked in the loop too (B-0716-ASHBY).
  const deadline = Date.now() + 8000;
  do {
    for (const frame of page.frames()) {
      const hit = await searchFrame(frame);
      if (hit) return hit;
    }
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);

  return null;
}

// K-DEFECT-2026-07-07: cookie/privacy consent overlays (e.g. company careers
// pages like pinterestcareers.com) sit on top of the real submit button and
// make Playwright's actionability check report "element is outside of the
// viewport" forever, even after repeated auto-scroll retries — because the
// element is fully covered, not off-screen. Dismiss common consent banners
// right after page load, before any submit-button search, so they never
// have a chance to block a click. Best-effort: absence of a banner is fine.
const CONSENT_BUTTON_SELECTORS = [
  'button:has-text("Accept All")',
  'button:has-text("Accept all")',
  'button:has-text("Accept Cookies")',
  'button:has-text("I Accept")',
  'button:has-text("Essential Only")',
  '#onetrust-accept-btn-handler',
  '[data-testid="cookie-accept"]',
  '[aria-label="Accept cookies"]',
];

async function dismissConsentBanners(page) {
  for (const sel of CONSENT_BUTTON_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
      }
    } catch { /* best-effort — no banner present or selector not applicable */ }
  }
}

// ── Kanban card extraction ────────────────────────────────────────────────────

/**
 * Reads a static kanban HTML file, extracts cards eligible for submission.
 * Eligible = columnId in SUBMIT_READY_STATES + grade A/B (C/D excluded — matches
 * generate-cl.mjs's eligibleFromBoard() gate) + not warm referral.
 * SUBMIT_READY_STATES defaults to ['evaluated']; override via --ready-states flag.
 */
export function extractEligibleCards(kanbanPath) {
  if (!fs.existsSync(kanbanPath)) {
    throw new Error(`Kanban not found: ${kanbanPath}`);
  }
  const html  = fs.readFileSync(kanbanPath, 'utf8');
  const cards = [];

  const cardRe = /\{[^{}]*id\s*:\s*'(live-\d+|worker-[^']+)'[^{}]*\}/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    try {
      const block = m[0];
      const get = (key) => {
        const r = new RegExp(key + `\\s*:\\s*['"]([^'"]*?)['"]`);
        return block.match(r)?.[1] ?? null;
      };
      const getBool = (key) => {
        const r = new RegExp(key + `\\s*:\\s*(true|false)`);
        return block.match(r)?.[1] === 'true';
      };
      const card = {
        id:             get('id'),
        company:        get('company'),
        role:           get('role'),
        url:            get('url'),
        grade:          get('grade'),
        columnId:       get('columnId'),
        hasConnection:  getBool('hasConnection'),
        isWarmReferral: getBool('isWarmReferral'),
      };
      if (card.id && card.url) cards.push(card);
    } catch { /* skip malformed */ }
  }

  return cards.filter(isEligible);
}

// ── Kanban JSON ingestion ─────────────────────────────────────────────────────

/**
 * Contract with dashboard/job-pulse-kanban.html exportState():
 *   Shape: { cards: { [id: string]: PulseJob }, version: number }
 *   PulseJob: { id, state, title, company, url, grade, has_connection,
 *               source, external_id, location, remote, verified, posted_at, ... }
 *
 * Eligible states are controlled by SUBMIT_READY_STATES (default: evaluated).
 * 'new' (freshly ingested, not evaluated) is NOT eligible by default — use
 * --ready-states new,evaluated to include it.
 */

/**
 * Maps a PulseJob (K2 kanban card) to the internal card shape used by auto-submit.
 * Preserves extra fields so downstream code (liveness, CL lookup) can use them.
 */
export function pulseJobToCard(job) {
  return {
    id:             job.id,
    company:        job.company   || '',
    role:           job.title     || '',
    url:            job.url       || '',
    grade:          job.grade     || null,
    columnId:       job.state     || 'new',
    hasConnection:  job.has_connection   || false,
    isWarmReferral: job.is_warm_referral || false,
    // Extra K2 fields — not used by existing filters but useful for logging
    source:         job.source    || null,
    location:       job.location  || null,
    verified:       job.verified  || false,
    posted_at:      job.posted_at || null,
  };
}

/**
 * Reads a K2 kanban JSON export and returns eligible cards in the same shape
 * as extractEligibleCards(). Safe: throws only on missing file or malformed JSON.
 *
 * @param {string} jsonPath  Path to the exported JSON file
 * @returns {object[]}  Array of mapped card objects
 * @throws {Error}  If file is missing or top-level .cards is absent
 */
export function extractEligibleCardsFromJson(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Kanban JSON not found: ${jsonPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    throw new Error(`Kanban JSON parse error: ${e.message}`);
  }

  // B10 (2026-07-22): kanban-import-{date}.json has shipped in two shapes with
  // DIFFERENT per-card field names, not just different wrapping:
  //   06-09-style { version, cards: { [id]: PulseJob } } — object-keyed, real
  //     K2 PulseJob fields (title, state, external_id, posted_at, ...) that
  //     pulseJobToCard() translates into the internal card shape.
  //   06-10-style { seedVersion, generatedAt, cards: [ card, ... ] } — array
  //     of cards ALREADY in the internal shape (role, columnId, hasConnection,
  //     isWarmReferral, ...) that kanban-inject.mjs itself writes out — no
  //     translation needed, and running them through pulseJobToCard would
  //     blank the role (reads job.title, which doesn't exist on this shape)
  //     and force columnId back to its 'new' default.
  // This used to hard-reject the array shape outright, so any day's export
  // using it silently never reached auto-submit's eligibility pass at all.
  if (Array.isArray(parsed?.cards)) {
    return parsed.cards.filter(isEligible);
  }
  if (parsed && typeof parsed.cards === 'object' && parsed.cards !== null) {
    return Object.values(parsed.cards).map(pulseJobToCard).filter(isEligible);
  }
  throw new Error('Kanban JSON must have shape { cards: { [id]: PulseJob } | card[], ... }');
}

// ── Cover letter lookup ───────────────────────────────────────────────────────

export function findCoverLetter(card) {
  const clDir = path.join(ROOT, 'cover-letters');
  if (!fs.existsSync(clDir)) return null;
  const slug  = (card.company || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const files = fs.readdirSync(clDir).filter((f) => f.includes(slug) && f.endsWith('.txt'));
  return files.length > 0 ? path.join('cover-letters', files[0]) : null;
}

// ── Index-based CL matching ───────────────────────────────────────────────────

export function slugifyCompany(name) {
  return (name || '').toLowerCase()
    .replace(/[()°™®]+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function extractRoleFamily(roleTitle) {
  const text = (roleTitle || '').toLowerCase();
  const families = [];
  if (/scrum master/.test(text))                                families.push('scrum master');
  if (/agile delivery|delivery manager/.test(text))             families.push('agile coach');
  if (/technical program manager|staff tpm|sr\. technical/.test(text)) families.push('technical program manager');
  if (/program manager/.test(text))                             families.push('program manager');
  if (/product manager/.test(text))                             families.push('product manager');
  if (/agile coach/.test(text))                                 families.push('agile coach');
  return families;
}

export function loadClIndex(indexPath) {
  if (!yaml) return null;
  if (!indexPath || !fs.existsSync(indexPath)) return null;
  try {
    return yaml.load(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Find the best matching cover letter for a kanban card using the index.
 * Priority: exact company slug → role family → tier fallback → null.
 * @param {object} card   Kanban card with at minimum { company, role }
 * @param {object} index  Parsed index.yml (yaml.load output)
 * @returns {string|null} Relative file path or null
 */
export function findCoverLetterForCard(card, index) {
  const companySlug = slugifyCompany(card.company || '');

  // 1. Exact company match in the index (cover-letters/*.md)
  if (index && Array.isArray(index.templates)) {
    const exact = index.templates.find((t) => t.company === companySlug);
    if (exact) return path.join('cover-letters', exact.file);
  }

  // 2. Company-specific generated letter on disk (cl_{slug}_*.txt in output/ or cover-letters/).
  //    Generated CLs land in output/ as .txt and may not be in index.yml yet, so an exact-index
  //    miss does NOT mean we have no letter. Find the company's OWN most-recent letter by slug
  //    before any fallback — this is what stops e.g. Figma from borrowing Samsara's letter.
  if (companySlug) {
    const prefix = 'cl_' + companySlug + '_';
    const roleTokens = new Set(slugifyCompany(card.role || '').split('-').filter(Boolean));
    for (const dir of ['output', 'cover-letters']) {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      const ranked = fs.readdirSync(abs)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.txt'))
        .map((f) => {
          const date = (f.match(/(\d{4}-\d{2}-\d{2})\.txt$/) || [, '0000-00-00'])[1];
          const mid  = f.slice(prefix.length).replace(/_\d{4}-\d{2}-\d{2}\.txt$/, '');
          const overlap = mid.split('-').filter((t) => roleTokens.has(t)).length;
          return { f, date, overlap };
        })
        // best role-slug match first, then most recent letter
        .sort((a, b) => (b.overlap - a.overlap) || b.date.localeCompare(a.date));
      if (ranked.length > 0) return path.join(dir, ranked[0].f);
    }
  }

  // 3. GENERIC fallback only. Never hand back another company's tailored letter: a role-family
  //    or tier match from a company-specific template mis-presents (e.g. Samsara's letter for
  //    Figma) and fails the company-name readiness check. Returning null flags the card for
  //    cover-letter generation instead, which is the correct outcome.
  if (index && Array.isArray(index.templates)) {
    const isGeneric = (t) => !t.company || t.company === 'generic';
    const roleFamilies = extractRoleFamily(card.role || '');
    if (roleFamilies.length > 0) {
      const roleMatch = index.templates.find((t) =>
        isGeneric(t) && Array.isArray(t.roles) &&
        t.roles.some((r) => roleFamilies.some((f) => r.toLowerCase().includes(f))),
      );
      if (roleMatch) return path.join('cover-letters', roleMatch.file);
    }
    const cardTier = card.tier || null;
    if (cardTier) {
      const tierMatch = index.templates.find((t) => isGeneric(t) && t.tier === cardTier);
      if (tierMatch) return path.join('cover-letters', tierMatch.file);
    }
  }

  return null;
}

// ── Dry-run analysis ──────────────────────────────────────────────────────────

export function dryRunCard(card, clIndex = null) {
  const ats = detectATS(card.url);
  const cl  = clIndex ? findCoverLetterForCard(card, clIndex) : findCoverLetter(card);

  let fillable;
  let notes;

  if (ats === 'unknown') {
    fillable = false;
    notes    = 'ATS not recognized — manual submission required';
  } else if (['greenhouse', 'lever', 'ashby'].includes(ats)) {
    fillable = true;
    notes    = `${ats} form fill supported via Playwright`;
  } else if (ats === 'workday') {
    fillable = 'partial';
    notes    = 'Workday: auth wall likely; pre-auth session required (data/workday-sessions/)';
  } else if (ats === 'linkedin') {
    fillable = 'partial';
    notes    = 'LinkedIn Easy Apply: may work if logged in via session cookie';
  } else {
    fillable = 'partial';
    notes    = `${ats}: form fill attempted but not guaranteed`;
  }

  return {
    id:           card.id,
    company:      card.company,
    role:         card.role,
    url:          card.url,
    ats,
    grade:        card.grade,
    column:       card.columnId,
    has_cl:       !!cl,
    cl_path:      cl ?? null,
    fillable,
    notes,
    would_submit: fillable === true,
  };
}

// ── Markdown report formatter ─────────────────────────────────────────────────

/**
 * Formats dry-run results as a GitHub-flavored markdown table.
 * @param {object[]} results  Array of dryRunCard() outputs
 * @returns {string}
 */
export function formatMarkdownReport(results) {
  const lines = [
    '## Auto-Submit Dry-Run Report',
    '',
    '| # | Grade | Company | Role | ATS | CL | Fillable | Notes |',
    '|---|-------|---------|------|-----|----|----------|-------|',
  ];

  results.forEach((r, i) => {
    const grade    = r.grade    ?? '-';
    const company  = (r.company ?? '-').replace(/\|/g, '∣');
    const role     = ((r.role ?? '-').slice(0, 45)).replace(/\|/g, '∣');
    const ats      = r.ats ?? '-';
    const cl       = r.has_cl ? '✅' : '❌';
    const fillIcon = r.fillable === true ? '✅' : r.fillable === 'partial' ? '⚠️' : '❌';
    const notes    = (r.notes ?? '').replace(/\|/g, '∣');
    lines.push(`| ${i + 1} | ${grade} | ${company} | ${role} | ${ats} | ${cl} | ${fillIcon} | ${notes} |`);
  });

  const wouldSubmit = results.filter((r) => r.would_submit).length;
  const partial     = results.filter((r) => r.fillable === 'partial').length;
  const blocked     = results.filter((r) => r.fillable === false).length;

  lines.push('');
  lines.push(`**Summary:** ${wouldSubmit} would submit ✅ · ${partial} partial ⚠️ · ${blocked} blocked ❌`);

  return lines.join('\n');
}

// ── Lower-tier safety guard ───────────────────────────────────────────────────

export function loadLowerTierConfig() {
  if (!yaml) return null;
  const cfgPath = path.join(ROOT, 'config', 'lower-tier-test-companies.yml');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    return yaml.load(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Validates the live-mode arming locks. Per-company allowlist was removed
 * 2026-06-18 — live now trusts the per-card gates (grade A/B + readiness band
 * >=60 + 5/day cap) that apply to every submission.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateLiveSafety(card, allowTier) {
  // Lock (a): --allow-tier flag — explicit intent to run live
  if (!allowTier) {
    return { ok: false, reason: 'Missing --allow-tier flag. Add: --allow-tier lower' };
  }

  // Lock (b): YAML exists and enabled: true — GLOBAL kill-switch for all live submits
  const cfg = loadLowerTierConfig();
  if (!cfg) {
    return { ok: false, reason: 'config/lower-tier-test-companies.yml not found. Create it from the template first.' };
  }
  if (!cfg.enabled) {
    return { ok: false, reason: 'lower-tier-test-companies.yml has enabled: false. Set enabled: true to activate live mode.' };
  }

  // Per-company allowlist removed: any eligible A/B card that clears the readiness
  // band (>=60) may submit, capped at 5/day. Set enabled: false to halt everything.
  return { ok: true };
}

// ── Daily cap ─────────────────────────────────────────────────────────────────

export function checkDailyCap() {
  const capPath = path.join(ROOT, 'data', `live-daily-count-${DATE_STAMP}.json`);
  if (!fs.existsSync(capPath)) return { count: 0, capPath };
  try {
    const data = JSON.parse(fs.readFileSync(capPath, 'utf8'));
    return { count: data.count ?? 0, capPath };
  } catch {
    return { count: 0, capPath };
  }
}

export function incrementDailyCap(capPath, currentCount) {
  const tmp = capPath + '.tmp';
  fs.mkdirSync(path.dirname(capPath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ date: DATE_STAMP, count: currentCount + 1 }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, capPath);
}

// ── Readiness helpers ─────────────────────────────────────────────────────────

function readClFileText(relPath) {
  if (!relPath) return null;
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) return null;
  try { return fs.readFileSync(full, 'utf8'); } catch { return null; }
}

function loadCvTextForScoring() {
  const p = path.join(ROOT, 'cv.md');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return null;
}

// ── Atomic JSON writer ────────────────────────────────────────────────────────

function writeJSON(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

// ── Screenshot helper ─────────────────────────────────────────────────────────

function screenshotSlug(card) {
  const company = (card.company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  const id      = card.id || 'noid';
  return `${company}-${id}`;
}

async function screenshot(page, card, prefix) {
  const slug   = typeof card === 'string' ? card : screenshotSlug(card);
  const ssDir  = path.join(ROOT, 'data', 'screenshots', DATE_STAMP);
  const ssPath = path.join(ssDir, `${prefix}-${slug}.png`);
  fs.mkdirSync(ssDir, { recursive: true });
  await page.screenshot({ path: ssPath, fullPage: false });
  return path.relative(ROOT, ssPath);
}

// ── Dead listing logger ───────────────────────────────────────────────────────

function logDeadListing(card, liveness) {
  const logPath = path.join(ROOT, 'data', `dead-listings-${DATE_STAMP}.json`);
  let existing  = [];
  if (fs.existsSync(logPath)) {
    try { existing = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { existing = []; }
  }
  existing.push({
    id:          card.id,
    company:     card.company,
    url:         card.url,
    status:      liveness.status,
    reason:      liveness.reason,
    redirect:    liveness.redirect ?? null,
    checked_at:  new Date().toISOString(),
  });
  writeJSON(logPath, existing);
}

// ── K-15: Listing-page → application form navigation ─────────────────────────

const APPLY_BUTTON_SELECTORS = [
  'button:has-text("Apply for this job")',
  'button:has-text("Apply Now")',
  'button:has-text("Apply now")',
  'a:has-text("Apply for this job")',
  'a:has-text("Apply Now")',
  'a:has-text("Apply now")',
  'button[aria-label*="apply" i]',
  'a[aria-label*="apply" i]',
];

/**
 * K-15: If the page looks like a job listing (no submit button), look for an
 * "Apply for this job" / "Apply Now" button and click it. Waits for navigation,
 * then returns the new ATS from the resulting URL.
 * Returns null if no apply button found.
 * @returns {{ ats: string } | null}
 */
export async function navigateToApplicationForm(page, currentAts) {
  // B-0716-ASHBY: Ashby overview pages (jobs.ashbyhq.com/{org}/{jobId}) render
  // the form on a client-side "Application" tab that our selector list misses
  // when the SPA hasn't hydrated yet. The form has a stable direct route at
  // {jobUrl}/application — navigate there deterministically before falling
  // back to apply-button hunting. (Lambda ×3 + Delinea 2026-07-12 no-button.)
  if (currentAts === 'ashby') {
    try {
      const u = new URL(page.url());
      if (/^jobs\.ashbyhq\.com$/i.test(u.hostname) && !/\/application\/?$/i.test(u.pathname)) {
        const target = `${u.origin}${u.pathname.replace(/\/$/, '')}/application${u.search}`;
        await page.goto(target, { timeout: 15000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        return { ats: 'ashby' };
      }
    } catch { /* fall through to selector hunt */ }
  }
  for (const sel of APPLY_BUTTON_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el) {
        await Promise.all([
          page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => {}),
          el.click(),
        ]);
        const newUrl = page.url();
        const { detectATS: _detect } = await import('./auto-submit.mjs').catch(() => ({ detectATS: () => currentAts }));
        // Re-detect ATS from the new URL
        const newAts = _detectATS(newUrl);
        return { ats: newAts !== 'unknown' ? newAts : currentAts };
      }
    } catch { /* selector not found or click failed — try next */ }
  }
  return null;
}

function _detectATS(url) {
  // Delegate to the authoritative detectATS (incl. B-ATS-DETECT query-param markers).
  return detectATS(url);
}

// ── Browser launch ────────────────────────────────────────────────────────────

/**
 * Launch or attach to a browser context appropriate for the configured mode.
 *
 * Returns { context, browser, isAttached, contextWasCreatedByUs } where:
 *   isAttached=true  → CDP attach: do NOT close browser on cleanup (user owns it)
 *   isAttached=false → Playwright launch: close browser (or context) on cleanup
 *   contextWasCreatedByUs → only relevant when isAttached=true; close context if true
 *
 * @param {object} pw          Full playwright module (await import('playwright'))
 * @param {object} browserCfg  Result of loadBrowserConfig()
 * @param {{ headless?: boolean, browserMode?: string, debugPort?: number, url?: string }} [opts]
 *   `url` (2026-07-06, r7/B5 rebuild): the card URL about to be submitted. When
 *   it's a Workday listing with a fresh pre-auth session saved by
 *   workday-login.mjs, that tenant-specific storageState is used instead of
 *   the generic data/auth-state.json in the default launch branch below —
 *   see workday-login.mjs's getValidSessionPath() for the freshness contract.
 */
export async function launchBrowserForMode(pw, browserCfg, { headless = false, browserMode = null, debugPort = 9222, url = null, ensureBrowser = ensureDebugBrowser } = {}) {
  const preferred      = browserCfg?.preferred || 'chromium';
  const effectiveMode  = parseBrowserMode(browserMode, browserCfg);

  // ── CDP attach — extensions stay live (SpeedyApply use case) ─────────────────
  if (preferred === 'chromium' && effectiveMode === 'connect') {
    // Auto-launch the debug browser if the CDP endpoint isn't already up, so the
    // non-interactive 1am orchestrator (pulse-refresh.mjs) no longer depends on a
    // human-opened "Terminal A". ensureDebugBrowser reuses the SAME launcher
    // (scripts/launch-debug-browser.mjs → configured chromium.profile_path), so the
    // existing logged-in session is preserved. Idempotent: subsequent per-card calls
    // find the endpoint already up and skip re-launching. (auto-launch fix 2026-07-28)
    try {
      await ensureBrowser(debugPort, { log: (m) => console.log(m) });
    } catch (e) {
      throw new Error(
        `Could not auto-launch debug browser on port ${debugPort}.\n` +
        `  ${e.message}`,
      );
    }
    let browser;
    try {
      browser = await pw.chromium.connectOverCDP(`http://localhost:${debugPort}`);
    } catch (e) {
      throw new Error(
        `Could not connect to debug browser on port ${debugPort}.\n` +
        `  Auto-launch ran but the CDP attach still failed. Try manually:\n` +
        `  Run in Terminal A: node scripts/launch-debug-browser.mjs\n` +
        `  Then re-run auto-submit in Terminal B.`,
      );
    }
    const contexts             = browser.contexts();
    const contextWasCreatedByUs = contexts.length === 0;
    const context = contextWasCreatedByUs
      ? await browser.newContext({ viewport: { width: 1280, height: 900 } })
      : contexts[0];
    return { context, browser, isAttached: true, contextWasCreatedByUs };
  }

  // ── Firefox persistent context ────────────────────────────────────────────────
  if (preferred === 'firefox') {
    const context = await pw.firefox.launchPersistentContext(
      browserCfg.firefox.profile_path,
      {
        executablePath: browserCfg.firefox.executable_path,
        headless: false, // extensions only work in headed mode
        viewport: { width: 1280, height: 900 },
      },
    );
    return { context, browser: null, isAttached: false, contextWasCreatedByUs: false };
  }

  // ── Chromium persistent profile (--browser-mode launch explicit) ──────────────
  const chromiumProfile = browserCfg?.chromium?.profile_path;
  const chromiumExe     = browserCfg?.chromium?.executable_path || undefined;
  if (chromiumProfile && fs.existsSync(chromiumProfile)) {
    const context = await pw.chromium.launchPersistentContext(chromiumProfile, {
      executablePath: chromiumExe,
      headless,
      viewport: { width: 1280, height: 900 },
    });
    return { context, browser: null, isAttached: false, contextWasCreatedByUs: false };
  }

  // ── Default: fresh bundled Chromium context ───────────────────────────────────
  // Load exported auth sessions if present (populated by scripts/export-auth-state.mjs).
  // This allows headless runs in the Cowork sandbox to submit with real authenticated sessions.
  //
  // B5/r7 rebuild (2026-07-06): for a Workday listing, prefer the tenant-specific
  // session workday-login.mjs saved (data/workday-sessions/{tenant}.json) over the
  // generic auth-state.json — it's the actual pre-auth this dryRunCard() note has
  // been promising ("Workday: auth wall likely; pre-auth session required") since
  // B5 was first closed. Falls through to auth-state.json when no URL is given or
  // no fresh Workday session exists for that tenant yet.
  const workdaySessionPath = url ? getValidWorkdaySessionPath(url) : null;
  const authStatePath = path.join(ROOT, 'data', 'auth-state.json');
  const storageState  = workdaySessionPath || (fs.existsSync(authStatePath) ? authStatePath : undefined);
  if (workdaySessionPath) {
    console.log(`[browser] Loading Workday pre-auth session: ${path.relative(ROOT, workdaySessionPath)}`);
  } else if (storageState) {
    console.log('[browser] Loading auth state from data/auth-state.json');
  } else if (url && /myworkdayjobs\.com|wd\d+\.myworkdayjobs/i.test(url)) {
    console.warn('[browser] Workday listing, no pre-auth session found — run: node scripts/workday-login.mjs --url "<job url>"');
  } else {
    console.warn('[browser] No auth-state.json found — browser will be unauthenticated. Run: node scripts/export-auth-state.mjs');
  }
  const browser  = await pw.chromium.launch({ headless });
  const context  = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState });
  return { context, browser, isAttached: false, contextWasCreatedByUs: true };
}

// ── Semi-auto mode ────────────────────────────────────────────────────────────

async function runSemiAuto(cards, pw, personal, browserCfg, useExtension, browserMode, debugPort, clIndex = null) {
  const results = [];
  const cvText  = loadCvTextForScoring();

  for (const card of cards) {
    let ats = detectATS(card.url);
    const cl  = clIndex ? findCoverLetterForCard(card, clIndex) : findCoverLetter(card);

    console.log(`\n[semi-auto] [${card.grade}] ${card.company} — ${card.role?.slice(0, 50)}`);
    console.log(`  ATS: ${ats} | CL: ${cl ?? 'none'}`);

    // B7 liveness check
    process.stdout.write('  Liveness check... ');
    const liveness = process.env.PULSE_SKIP_LIVENESS === "1" ? { alive: true, reason: "env-skip" } : await checkLiveness(card.url);
    if (!liveness.alive) {
      console.log(`DEAD (${liveness.reason}) — skipping`);
      results.push({ id: card.id, status: 'dead-listing', reason: liveness.reason, url: card.url });
      logDeadListing(card, liveness);
      continue;
    }
    console.log('OK');

    // Readiness check
    process.stdout.write('  Readiness check... ');
    const clText       = readClFileText(cl);
    const readiness    = await scoreCard(card, { resumeText: cvText, clText });
    let clForSubmit = cl;
    if (readiness.score_skipped) {
      console.log(`SKIPPED (${readiness.reason}) — proceeding anyway`);
    } else {
      saveReadinessScore(card.id, readiness.total, readiness.grade);
      const gate = readinessGate(readiness.total, Boolean(cl));
      if (gate.action === 'skip') {
        console.log(`SKIP ${readiness.total}/100 (${readiness.grade}) — ${gate.reason}`);
        for (const flag of readiness.flags.slice(0, 3)) console.log(`    • ${flag}`);
        results.push({ id: card.id, status: gate.band === '89+' ? 'cl-required' : 'readiness-fail', readiness, url: card.url });
        continue;
      }
      clForSubmit = gate.attachCl ? cl : null;
      console.log(`OK ${readiness.total}/100 (${readiness.grade}) — ${gate.reason}`);
    }

    let browser              = null;
    let context              = null;
    let page                 = null;
    let isAttached           = false;
    let contextWasCreatedByUs = false;
    let aborted              = false;
    let clicked              = false;
    let fillReport           = null;

    const sigintHandler = () => { aborted = true; };
    process.on('SIGINT', sigintHandler);

    try {
      ({ context, browser, isAttached, contextWasCreatedByUs } =
        await launchBrowserForMode(pw, browserCfg, { headless: false, browserMode, debugPort, url: card.url }));
      page = await context.newPage();

      console.log(`  Opening browser → ${card.url}`);
      await page.goto(card.url, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await dismissConsentBanners(page);

      // K-15: If no submit button on listing page, look for "Apply for this job" button
      let submitBtn = await findSubmitOnPage(page, ats);
      if (!submitBtn) {
        process.stdout.write('  No submit on landing page — checking for Apply button (K-15)... ');
        const applyNav = await navigateToApplicationForm(page, ats);
        if (applyNav) {
          ats = applyNav.ats;
          await page.waitForTimeout(1500);
          submitBtn = await findSubmitOnPage(page, ats);
          console.log(submitBtn ? `navigated to form (ATS: ${ats})` : 'navigated but still no submit button');
        } else {
          console.log('no Apply button found');
        }
      }

      // Form fill — extension autofill or built-in selectors
      if (useExtension) {
        const attachLabel = isAttached ? 'attached CDP' : 'persistent context';
        process.stdout.write(`  Waiting 5s for SpeedyApply to autofill (${attachLabel})...`);
        await page.waitForTimeout(Number(process.env.PULSE_AUTOFILL_WAIT_MS ?? 5000));
        console.log(' done.');
        fillReport = { extension: true, note: `deferred to SpeedyApply extension (${attachLabel}, waited 5s)` };
      } else if (personal) {
        process.stdout.write('  Filling form fields... ');
        try {
          fillReport = await fillForm(ats, page, personal, clForSubmit);
          console.log(`${fillReport.filled}/${fillReport.total} fields filled. Missing: [${fillReport.missing_fields.join(', ') || 'none'}]`);
          for (const line of formatUploadDetails(fillReport.upload_details || {})) console.log(line);
        } catch (e) {
          console.log(`fill error: ${e.message}`);
        }
      }

      // Highlight submit button with red overlay
      if (submitBtn) {
        await page.addStyleTag({
          content: `
            button[type="submit"],
            button#btn-submit,
            button[aria-label="Submit"],
            button[data-automation-id="submitButton"],
            [data-automation-id="bottom-navigation-next-button"] {
              outline: 3px solid #ff2d2d !important;
              outline-offset: 3px !important;
              box-shadow: 0 0 10px 3px rgba(255,45,45,0.6) !important;
            }
          `,
        });
        console.log('  Submit button highlighted (red border).');
      } else {
        console.log('  ⚠  No submit button detected — check the page manually.');
      }

      const ssPath = await screenshot(page, card, 'semi-auto-before');
      console.log(`  Screenshot: ${ssPath}`);

      console.log('\n  ═══════════════════════════════════════════════════════════════');
      console.log('  Form prepped. Review the browser, then click Submit yourself.');
      console.log('  Press Ctrl+C to abort this card without submitting.');
      console.log('  ═══════════════════════════════════════════════════════════════\n');

      try {
        await Promise.race([
          page.waitForNavigation({ timeout: 0, waitUntil: 'domcontentloaded' }),
          new Promise((_, reject) => {
            const poll = setInterval(() => {
              if (aborted) { clearInterval(poll); reject(new Error('user-aborted')); }
            }, 250);
          }),
        ]);
        clicked = true;
        const ssAfter = await screenshot(page, card, 'semi-auto-after').catch(() => null);
        console.log(`  Navigation detected — submission likely completed. Screenshot: ${ssAfter ?? 'error'}`);
      } catch (e) {
        if (e.message === 'user-aborted') {
          console.log('  Aborted by user (Ctrl+C).');
        } else {
          console.log(`  Wait ended (${e.message}).`);
        }
      }

    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
    } finally {
      if (isAttached) {
        // Don't close the browser — the user owns it in Terminal A
        if (page) await page.close().catch(() => {});
        if (contextWasCreatedByUs && context) await context.close().catch(() => {});
      } else if (browser) {
        await browser.close().catch(() => {});
      } else if (context) {
        await context.close().catch(() => {});
      }
      process.removeListener('SIGINT', sigintHandler);
    }

    const outcome = clicked ? 'user-submitted' : (aborted ? 'aborted' : 'unknown');
    results.push({
      id:          card.id,
      company:     card.company,
      role:        card.role,
      url:         card.url,
      ats,
      cl_path:     cl ?? null,
      fill_report: fillReport,
      outcome,
      timestamp:   new Date().toISOString(),
    });
    console.log(`  Outcome: ${outcome}`);
  }

  const outPath = path.join(ROOT, 'data', `semi-auto-${DATE_STAMP}.json`);
  writeJSON(outPath, { ran_at: new Date().toISOString(), mode: 'semi-auto', results });
  console.log(`\n[semi-auto] Written → ${path.relative(ROOT, outPath)}`);
  return results;
}

// ── Park-ready mode (auto-fill-to-submit-ready staging) ───────────────────────
// Moves eligible, readiness-passing cards into the Airtable "Submit Ready" lane so
// Rahil can run an interactive fill+submit and click the final button himself. No
// browser, no submit click — this is the honest answer to the reCAPTCHA ceiling:
// the engine stages, the human fires the last shot. Exported for unit testing.
export async function parkCardsToSubmitReady(cards, {
  patImpl = process.env.AIRTABLE_PAT,
  listImpl = airtableListAll,
  patchImpl = airtablePatchBatch,
  cvText = null,
  scoreImpl = scoreCard,
  gateImpl = readinessGate,
  now = () => new Date().toISOString(),
} = {}) {
  const results = [];
  if (!patImpl) {
    console.error(`[park-ready] AIRTABLE_PAT not set — cannot stage cards. ${PAT_MISSING_MSG}`);
    return { parked: 0, skipped: cards.length, results: cards.map((c) => ({ id: c.id, status: 'skipped', reason: 'no-pat' })) };
  }

  let records = [];
  try {
    records = await listImpl({ pat: patImpl, baseId: BASE_ID, tableId: ACTIVE_TABLE_ID });
  } catch (e) {
    console.error(`[park-ready] Airtable list failed: ${e.message}`);
    return { parked: 0, skipped: cards.length, results: cards.map((c) => ({ id: c.id, status: 'skipped', reason: 'airtable-list-failed' })) };
  }
  const recIdByCardId = new Map(records.map((r) => [r.fields?.[CARD_ID_FIELD], r.id]));

  const toPatch = [];
  for (const card of cards) {
    // Readiness gate — identical band rule to live (>=60 or CL-gated). No CL here
    // (staging only), so the readinessGate CL branch never attaches one.
    const readiness = await scoreImpl(card, { resumeText: cvText, clText: null });
    if (!readiness.score_skipped) {
      saveReadinessScore(card.id, readiness.total, readiness.grade);
      const gate = gateImpl(readiness.total, false);
      if (gate.action === 'skip') {
        console.log(`[park-ready] SKIP ${card.company} — ${readiness.total}/100 (${gate.reason})`);
        results.push({ id: card.id, company: card.company, status: 'skipped', reason: gate.reason, readiness_total: readiness.total });
        continue;
      }
    }
    const recId = recIdByCardId.get(card.id);
    if (!recId) {
      console.log(`[park-ready] SKIP ${card.company} — no Airtable record for card id ${card.id}`);
      results.push({ id: card.id, company: card.company, status: 'skipped', reason: 'no-airtable-record' });
      continue;
    }
    toPatch.push({
      id: recId,
      fields: {
        [ACTIVE_FIELD_IDS['Lane']]: 'Submit Ready',
        [LAST_REFRESHED_FIELD]: now(),
      },
    });
    console.log(`[park-ready] → Submit Ready: ${card.company} — ${String(card.role).slice(0, 50)}`);
    results.push({ id: card.id, company: card.company, role: card.role, status: 'submit-ready' });
  }

  if (toPatch.length) {
    try {
      await patchImpl({ pat: patImpl, baseId: BASE_ID, tableId: ACTIVE_TABLE_ID, records: toPatch });
    } catch (e) {
      console.error(`[park-ready] Airtable PATCH failed: ${e.message}`);
      return { parked: 0, skipped: cards.length, error: e.message, results };
    }
  }
  return { parked: toPatch.length, skipped: results.filter((r) => r.status === 'skipped').length, results };
}

// ── Live mode ─────────────────────────────────────────────────────────────────

function appendSubmitQueue(card, ats, ssPath) {
  const qPath = path.join(ROOT, 'data', 'submit-queue.json');
  let queue   = [];
  if (fs.existsSync(qPath)) {
    try { queue = JSON.parse(fs.readFileSync(qPath, 'utf8')); } catch { queue = []; }
  }
  queue.push({
    id:           card.id,
    company:      card.company,
    role:         card.role,
    url:          card.url,
    ats,
    status:       'applied',
    submitted_at: new Date().toISOString(),
    screenshot:   ssPath ?? null,
  });
  writeJSON(qPath, queue);
}

function writeTSVEntry(card, ats) {
  const dir = path.join(ROOT, 'batch', 'tracker-additions');
  fs.mkdirSync(dir, { recursive: true });
  const slug    = (card.company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const num     = card.id.replace(/\D/g, '') || '0';
  const columns = [num, DATE_STAMP, card.company, card.role ?? '', 'Applied', '-/5', '❌',
    `[${num}](data/live-runs-${DATE_STAMP}.json)`, `live-submit via ${ats}`];
  const outPath = path.join(dir, `${num}-${slug}-live.tsv`);
  fs.writeFileSync(outPath, columns.join('\t') + '\n', 'utf8');
}

async function runLive(cards, pw, allowTier, personal, browserCfg, useExtension, browserMode, debugPort, clIndex = null) {
  let captchaBlocked = 0;
  let formBlocked    = 0;
  let confirmed      = 0;
  let unconfirmed    = 0;
  const results      = [];
  const cvText       = loadCvTextForScoring();

  let { count: dailyCount, capPath } = checkDailyCap();

  // B-0717-3 dup-guard (2026-07-17): never live-attempt a card that already has a
  // pre-click journal entry from ANY day (see click-journal-*.jsonl). A journaled
  // click means a submit MAY have landed; re-attempting risks a duplicate
  // application until the entry is reconciled against a confirmation email.
  const journaledIds = new Set();
  try {
    for (const jf of fs.readdirSync(path.join(ROOT, 'data')).filter((f) => /^click-journal-.*\.jsonl$/.test(f))) {
      for (const line of fs.readFileSync(path.join(ROOT, 'data', jf), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const rec = JSON.parse(line); if (rec.phase === 'pre-click' && rec.id) journaledIds.add(rec.id); } catch { /* skip bad line */ }
      }
    }
  } catch { /* no journals yet */ }

  for (const card of cards) {
    if (journaledIds.has(card.id)) {
      console.log(`\n[live] SKIP ${card.id} (${card.company}) — click-journal dup-guard: prior submit click recorded, awaiting email reconciliation`);
      results.push({ id: card.id, status: 'skipped', reason: 'journal-dup-guard', url: card.url });
      continue;
    }

    if (dailyCount >= LIVE_DAILY_CAP) {
      console.log(`\n[live] Hard cap reached (${LIVE_DAILY_CAP}/day). Stopping.`);
      break;
    }

    // Per-card safety lock (company must be in YAML)
    const safety = validateLiveSafety(card, allowTier);
    if (!safety.ok) {
      console.log(`\n[live] SAFETY BLOCKED [${card.company}]: ${safety.reason}`);
      results.push({ id: card.id, status: 'safety-blocked', reason: safety.reason, url: card.url });
      continue;
    }

    let ats = detectATS(card.url);
    const cl  = clIndex ? findCoverLetterForCard(card, clIndex) : findCoverLetter(card);

    console.log(`\n[live] [${card.grade}] ${card.company} — ${card.role?.slice(0, 50)}`);
    console.log(`  ATS: ${ats} | CL: ${cl ?? 'none'}`);

    // B7 liveness check
    process.stdout.write('  Liveness check... ');
    const liveness = process.env.PULSE_SKIP_LIVENESS === "1" ? { alive: true, reason: "env-skip" } : await checkLiveness(card.url);
    if (!liveness.alive) {
      console.log(`DEAD (${liveness.reason}) — skipping`);
      results.push({ id: card.id, status: 'dead-listing', reason: liveness.reason, url: card.url });
      logDeadListing(card, liveness);
      continue;
    }
    console.log('OK');

    // Readiness check — gate before launching browser
    process.stdout.write('  Readiness check... ');
    const liveClText  = readClFileText(cl);
    const readiness   = await scoreCard(card, { resumeText: cvText, clText: liveClText });
    let clForSubmit = cl;
    if (readiness.score_skipped) {
      console.log(`SKIPPED (${readiness.reason}) — proceeding anyway`);
    } else {
      saveReadinessScore(card.id, readiness.total, readiness.grade);
      const gate = readinessGate(readiness.total, Boolean(cl));
      if (gate.action === 'skip') {
        console.log(`SKIP ${readiness.total}/100 (${readiness.grade}) — ${gate.reason}`);
        for (const flag of readiness.flags.slice(0, 3)) console.log(`    • ${flag}`);
        results.push({ id: card.id, status: gate.band === '89+' ? 'cl-required' : 'readiness-fail', readiness, url: card.url });
        continue;
      }
      clForSubmit = gate.attachCl ? cl : null;
      console.log(`OK ${readiness.total}/100 (${readiness.grade}) — ${gate.reason}`);
    }

    let browser              = null;
    let context              = null;
    let page                 = null;
    let isAttached           = false;
    let contextWasCreatedByUs = false;
    let ssPath               = null;
    let fillReport           = null;

    try {
      ({ context, browser, isAttached, contextWasCreatedByUs } =
        await launchBrowserForMode(pw, browserCfg, { headless: !useExtension, browserMode, debugPort, url: card.url }));
      page = await context.newPage();

      await page.goto(card.url, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await dismissConsentBanners(page);

      // CAPTCHA check — mark and skip this card
      if (await detectCaptchaOnPage(page)) {
        console.log('  → CAPTCHA detected — marking requires-human, skipping card');
        ssPath = await screenshot(page, card, 'captcha').catch(() => null);
        results.push({ id: card.id, status: 'requires-human', reason: 'captcha-detected', url: card.url, screenshot: ssPath });
        captchaBlocked++;
        continue;
      }

      // Intermediate step — CRITICAL: STOP entire run, do NOT move on
      if (await detectIntermediateStepOnPage(page)) {
        ssPath = await screenshot(page, card, 'intermediate').catch(() => null);
        results.push({ id: card.id, status: 'intermediate-step', reason: 'intermediate-step-detected', url: card.url, screenshot: ssPath });
        if (isAttached) {
          if (page) await page.close().catch(() => {});
          page = null;
        } else {
          if (browser) await browser.close().catch(() => {});
          else if (context) await context.close().catch(() => {});
          browser = null; context = null;
        }
        console.log('  → INTERMEDIATE STEP detected — application flow has changed. Stopping run for manual review.');
        break;
      }

      // K-15: listing page → look for "Apply for this job" button before giving up
      let submitBtn = await findSubmitOnPage(page, ats);
      if (!submitBtn) {
        const applyNav = await navigateToApplicationForm(page, ats);
        if (applyNav) {
          ats = applyNav.ats;
          await page.waitForTimeout(1500);
          submitBtn = await findSubmitOnPage(page, ats);
        }
      }

      if (!submitBtn) {
        console.log('  → BLOCKED: no submit button found');
        ssPath = await screenshot(page, card, 'no-submit').catch(() => null);
        results.push({ id: card.id, status: 'blocked', reason: 'no-submit-button', url: card.url, screenshot: ssPath });
        formBlocked++;
        continue;
      }

      // Form fill — extension autofill or built-in selectors
      if (useExtension) {
        const attachLabel = isAttached ? 'attached CDP' : 'persistent context';
        const ssWaitMs = Math.max(2000, parseInt(process.env.SPEEDYAPPLY_WAIT_MS || '5000', 10) || 5000);
        process.stdout.write(`  Waiting ${ssWaitMs}ms for SpeedyApply to autofill (${attachLabel})...`);
        await page.waitForTimeout(ssWaitMs);
        console.log(' done.');
        fillReport = { extension: true, note: `deferred to SpeedyApply (${attachLabel}, ${ssWaitMs}ms wait)` };
      } else if (personal) {
        try {
          fillReport = await fillForm(ats, page, personal, clForSubmit);
          console.log(`  Filled ${fillReport.filled}/${fillReport.total} fields. Missing: [${fillReport.missing_fields.join(', ') || 'none'}]`);
          for (const line of formatUploadDetails(fillReport.upload_details || {})) console.log(line);
        } catch (e) {
          console.log(`  Form fill error: ${e.message} — continuing`);
          // B-0717-1 fix: a thrown fillForm left fillReport undefined, which
          // BYPASSED the B-16 empty-form guard below (guard requires truthy
          // fillReport). Synthesize a zero-fill report so the guard applies.
          fillReport = { extension: false, filled: 0, total: 0, missing_fields: [], upload_details: {}, fill_error: e.message };
        }
      }

      // B-16 guard (2026-07-10): never click submit on a form we demonstrably did
      // not fill. An empty submit either bounces off client validation (wasted
      // attempt, misleading UNCONFIRMED) or - worse - files a blank application.
      // Only applies to built-in fill (extension path reports no per-field counts).
      if (fillReport && fillReport.extension !== true
          && Number(fillReport.filled) === 0
          && !(fillReport.upload_details && fillReport.upload_details.resume && fillReport.upload_details.resume.uploaded === true)) {
        console.log('  B-16 guard: 0 fields filled and no resume uploaded - NOT clicking submit (form-blocked)');
        ssPath = await screenshot(page, card, 'empty-form-guard').catch(() => null);
        results.push({ id: card.id, status: 'blocked', reason: 'empty-form-guard', url: card.url, screenshot: ssPath, fill: fillReport });
        formBlocked++;
        continue;
      }

      // Pre-submit screenshot
      ssPath = await screenshot(page, card, 'pre-submit');
      console.log(`  Pre-submit screenshot: ${ssPath}`);

      // K-DEFECT-2026-07-21 (CI&T / Lever): the early CAPTCHA check above runs
      // right after page.goto + a short settle wait. That's enough for most
      // ATSes, but on at least one Lever-hosted posting (CI&T) an invisible
      // hCaptcha widget attaches to the DOM AFTER that early check already ran
      // clean — so the stale "no captcha" result stood, submitBtn.click() fired
      // anyway, and the card silently fell through to 'unconfirmed' instead of
      // being cleanly flagged 'requires-human' the way Samsara's captcha (which
      // was already present at the early check) is handled. Re-run the same
      // detector immediately before the click via pollForCaptcha, which polls
      // briefly (up to 3s) since a late-loading widget can still be a beat
      // away from attaching.
      const captchaJustAppeared = await pollForCaptcha(page);
      if (captchaJustAppeared) {
        console.log('  → CAPTCHA appeared just before submit — marking requires-human, skipping card');
        ssPath = await screenshot(page, card, 'captcha').catch(() => null);
        results.push({ id: card.id, status: 'requires-human', reason: 'captcha-detected-pre-submit', url: card.url, screenshot: ssPath });
        captchaBlocked++;
        continue;
      }

      // B-0717-2 fix (2026-07-17): journal-first click record. The sandbox bash
      // cap can kill this process between click and results-write, silently losing
      // the fact that a live submit was attempted. Append a crash-safe JSONL line
      // BEFORE clicking so no click can ever go unrecorded.
      try {
        const journalPath = path.join(ROOT, 'data', `click-journal-${DATE_STAMP}.jsonl`);
        fs.appendFileSync(journalPath, JSON.stringify({ at: new Date().toISOString(), id: card.id, company: card.company, role: card.role, url: card.url, ats, fill: fillReport ? { filled: fillReport.filled, total: fillReport.total, extension: fillReport.extension === true } : null, screenshot: ssPath, phase: 'pre-click' }) + '\n');
      } catch (jErr) { console.log(`  (click-journal write failed: ${jErr.message})`); }

      // Click submit — B-14 fix: viewport-safe fallback (scrollIntoView → force → DOM click)
      try {
        await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
        await submitBtn.click({ timeout: 30000 });
      } catch (clickErr) {
        if (/outside of the viewport|Timeout/i.test(clickErr.message)) {
          console.log('  Click blocked (' + clickErr.message.split('\n')[0] + ') — B-14 fallback: force/DOM click');
          await submitBtn.click({ force: true, timeout: 5000 }).catch(async () => {
            await submitBtn.evaluate((el) => el.click());
          });
        } else { throw clickErr; }
      }
      console.log(`  Clicked submit. Waiting for confirmation (${Math.round(CONFIRM_TIMEOUT_MS / 1000)}s)...`);

      // "Last push" confirmation. SpeedyApply fills to the 1-yard line; the engine
      // clicks submit and only counts it APPLIED on a real success signal — either an
      // on-page confirmation (text or confirmation-style URL) or, failing that, an ATS
      // confirmation email reconciled downstream (see unconfirmed result fields below).
      let confirmed_flag = false;
      const CONFIRM_TEXT = /thank you for applying|application (submitted|received|complete)|we (received|have received) your application|thanks for applying|successfully submitted|your application has been (submitted|received)|submission (confirmed|received)|application confirmation/i;
      const CONFIRM_URL  = /confirmation|thank[-_ ]?you|submitted|success|applied|complete/i;
      try {
        await Promise.race([
          page.waitForURL((url) => String(url) !== card.url && CONFIRM_URL.test(String(url)), { timeout: CONFIRM_TIMEOUT_MS }),
          page.getByText(CONFIRM_TEXT).first().waitFor({ state: 'visible', timeout: CONFIRM_TIMEOUT_MS }),
        ]);
        confirmed_flag = true;
      } catch (e) {
        // B-6 diagnostics (2026-07-16): this catch used to swallow the reason.
        // Ashby runs "waited 60s" in <10s wall-clock, meaning waitForFunction
        // THREW (context destroyed / strict-mode violation), not timed out —
        // log it so the next run can tell a real timeout from a broken wait.
        console.log(`  (confirmation wait ended early: ${String(e?.message || e).split('\n')[0].slice(0, 140)})`);
      }

      const ssAfter = await screenshot(page, card,confirmed_flag ? 'confirmed' : 'unconfirmed').catch(() => null);

      if (confirmed_flag) {
        console.log('  → CONFIRMED: application submitted');
        confirmed++;
        incrementDailyCap(capPath, dailyCount);
        dailyCount++;
        appendSubmitQueue(card, ats, ssAfter);
        writeTSVEntry(card, ats);
        results.push({ id: card.id, status: 'applied', url: card.url, ats, screenshot: ssAfter, fill_report: fillReport, note: 'confirmed' });
      } else {
        console.log('  → UNCONFIRMED: no confirmation within 60s — NOT marking as applied');
        unconfirmed++;
        results.push({ id: card.id, company: card.company, role: card.role, status: 'unconfirmed', url: card.url, ats, screenshot: ssAfter, fill_report: fillReport, note: 'no-confirmation-60s', clicked_submit_at: new Date().toISOString(), needs_email_confirmation: true });
      }

    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
      results.push({ id: card.id, status: 'error', error: e.message, url: card.url });
    } finally {
      if (isAttached) {
        if (page) await page.close().catch(() => {});
        if (contextWasCreatedByUs && context) await context.close().catch(() => {});
      } else if (browser) {
        await browser.close().catch(() => {});
      } else if (context) {
        await context.close().catch(() => {});
      }
    }
  }

  const outPath = path.join(ROOT, 'data', `live-runs-${DATE_STAMP}.json`);
  // B-4 fix (K-4, 2026-07-03): append-mode — merge with any earlier run today
  // instead of overwriting, so per-card invocations accumulate in one file.
  let prevRun = null;
  try { prevRun = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { /* first run today */ }
  writeJSON(outPath, {
    ran_at:          new Date().toISOString(),
    mode:            'live',
    allow_tier:      allowTier,
    confirmed:       confirmed      + (Number(prevRun?.confirmed)       || 0),
    unconfirmed:     unconfirmed    + (Number(prevRun?.unconfirmed)     || 0),
    captcha_blocked: captchaBlocked + (Number(prevRun?.captcha_blocked) || 0),
    form_blocked:    formBlocked    + (Number(prevRun?.form_blocked)    || 0),
    results:         [...(Array.isArray(prevRun?.results) ? prevRun.results : []), ...results],
  });
  console.log(`\n[live] Written → ${path.relative(ROOT, outPath)}`);

  return { confirmed, unconfirmed, captchaBlocked, formBlocked, results };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const modeLabel = LIVE ? 'LIVE' : SEMI_AUTO ? 'SEMI-AUTO' : PARK_READY ? 'PARK-READY' : 'DRY-RUN';
  console.log(`[auto-submit] mode=${modeLabel} limit=${LIMIT}`);

  // Load eligible cards — JSON path takes priority over HTML kanban
  let eligible;
  try {
    if (KANBAN_JSON) {
      console.log(`[auto-submit] source=kanban-json path=${KANBAN_JSON}`);
      eligible = extractEligibleCardsFromJson(KANBAN_JSON);
    } else {
      console.log(`[auto-submit] source=kanban-html path=${path.relative(ROOT, KANBAN_PATH)}`);
      eligible = extractEligibleCards(KANBAN_PATH);
    }
  } catch (e) {
    console.error(`[auto-submit] FATAL: ${e.message}`);
    process.exit(1);
  }
  console.log(`[auto-submit] ${eligible.length} eligible cards found`);

  if (CARD_ID) {
    eligible = eligible.filter((c) => c.id === CARD_ID);
    if (eligible.length === 0) {
      console.error(`[auto-submit] Card "${CARD_ID}" not found in eligible set`);
      process.exit(1);
    }
  }

  if (CARD_IDS) {
    const before = eligible.length;
    eligible = eligible.filter((c) => CARD_IDS.has(c.id));
    const matchedIds = new Set(eligible.map((c) => c.id));
    const missing = [...CARD_IDS].filter((id) => !matchedIds.has(id));
    console.log(`[auto-submit] --card-ids filter: ${before} eligible → ${eligible.length} (requested ${CARD_IDS.size})`);
    if (missing.length) {
      console.log(`[auto-submit] --card-ids not in eligible set (already submitted, wrong state, or not yet injected): ${missing.join(', ')}`);
    }
    if (eligible.length === 0) {
      console.log('[auto-submit] Nothing to process after --card-ids filter — exiting cleanly.');
      process.exit(0);
    }
  }

  // Fail-fast checks for --live before launching any browser
  if (LIVE) {
    if (!ALLOW_TIER) {
      console.error('[auto-submit] FATAL: --live requires --allow-tier <tier>. Example: --allow-tier lower');
      process.exit(1);
    }
    const cfg = loadLowerTierConfig();
    if (!cfg) {
      console.error('[auto-submit] FATAL: config/lower-tier-test-companies.yml not found. Create it from the template.');
      process.exit(1);
    }
    if (!cfg.enabled) {
      console.error('[auto-submit] FATAL: lower-tier-test-companies.yml has enabled: false. Set enabled: true to activate.');
      process.exit(1);
    }
    const { count } = checkDailyCap();
    if (count >= LIVE_DAILY_CAP) {
      console.error(`[auto-submit] FATAL: Daily live cap of ${LIVE_DAILY_CAP} already reached today.`);
      process.exit(1);
    }
  }

  const toProcess = eligible.slice(0, LIMIT);

  // ── Park-ready ───────────────────────────────────────────────────────────────
  // Non-browser staging: gate on readiness, then move passing cards to the Airtable
  // "Submit Ready" lane. Runs before any browser/Playwright setup.
  if (PARK_READY) {
    const cvText = loadCvTextForScoring();
    const { parked, skipped, results } = await parkCardsToSubmitReady(toProcess, { cvText });
    const outPath = path.join(ROOT, 'data', `park-ready-${DATE_STAMP}.json`);
    writeJSON(outPath, { ran_at: new Date().toISOString(), mode: 'park-ready', parked, skipped, results });
    console.log(`\n[auto-submit] PARK-READY: ${parked} card(s) → Submit Ready, ${skipped} skipped. Written → ${path.relative(ROOT, outPath)}`);
    process.exit(0);
  }

  // Load CL index once (warnings only — missing index is not fatal)
  const clIdx = loadClIndex(CL_INDEX_ARG);
  if (!clIdx) {
    console.log('[auto-submit] CL index not found — falling back to filename matching');
  } else {
    console.log(`[auto-submit] CL index loaded: ${clIdx.templates?.length ?? 0} templates`);
  }

  // ── Dry-run ─────────────────────────────────────────────────────────────────
  if (DRY_RUN) {
    const cvText  = loadCvTextForScoring();
    const results = [];
    for (const card of toProcess) {
      const dry      = dryRunCard(card, clIdx);
      const clText   = readClFileText(dry.cl_path);
      dry.readiness  = await scoreCard(card, { resumeText: cvText, clText });
      if (!dry.readiness.score_skipped) {
        saveReadinessScore(card.id, dry.readiness.total, dry.readiness.grade);
      }
      results.push(dry);
    }

    const wouldSubmit = results.filter((r) => r.would_submit).length;
    const partial     = results.filter((r) => r.fillable === 'partial').length;
    const blocked     = results.filter((r) => r.fillable === false).length;

    console.log('\n[auto-submit] DRY-RUN RESULTS:');
    results.forEach((r) => {
      const icon = r.would_submit ? '✓' : r.fillable === 'partial' ? '~' : '✗';
      const rs   = r.readiness;
      const rsTag = rs?.score_skipped ? 'skip' : `${rs?.total}/${rs?.grade}`;
      console.log(`  ${icon} [${r.grade}] ${r.company} — ${r.role?.slice(0, 50)}`);
      console.log(`      ATS: ${r.ats} | CL: ${r.has_cl ? r.cl_path : 'none'} | readiness: ${rsTag} | ${r.notes}`);
      if (rs && !rs.score_skipped && !rs.passed) {
        console.log(`      ⚠ Readiness FAIL (${rs.total}/100): ${rs.flags.slice(0, 2).join(' · ')}`);
      }
    });
    console.log(`\n[auto-submit] Summary: ${wouldSubmit} would submit, ${partial} partial, ${blocked} blocked`);

    if (REPORT) {
      console.log('\n' + formatMarkdownReport(results) + '\n');
    } else {
      console.log('[auto-submit] Add --report to see a markdown table. Run with --semi-auto to inspect form fill.');
    }

    const output = {
      ran_at:         new Date().toISOString(),
      mode:           'dry-run',
      kanban:         path.relative(ROOT, KANBAN_PATH),
      eligible_total: eligible.length,
      processed:      toProcess.length,
      would_submit:   wouldSubmit,
      partial,
      blocked,
      results,
    };
    const outPath = path.join(ROOT, 'data', `auto-submit-dry-run-${DATE_STAMP}.json`);
    writeJSON(outPath, output);
    console.log(`[auto-submit] Written → ${path.relative(ROOT, outPath)}`);
    return;
  }

  // ── Browser config ───────────────────────────────────────────────────────────
  let browserCfg;
  try {
    browserCfg = await loadBrowserConfig();
    if (browserCfg.preferred !== 'chromium') {
      console.log(`[auto-submit] Browser: ${browserCfg.preferred} | extension_autofill: ${browserCfg.extension_autofill}`);
    }
  } catch (e) {
    if (e instanceof BrowserConfigError) {
      console.error(`[auto-submit] FATAL: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const useExtension = USE_EXTENSION_ARG !== null
    ? USE_EXTENSION_ARG
    : browserCfg.extension_autofill === true;

  const browserMode = parseBrowserMode(BROWSER_MODE_ARG, browserCfg);
  const debugPort   = parseDebugPort(DEBUG_PORT_ARG);

  if (useExtension) {
    console.log('[auto-submit] Extension autofill: ON — SpeedyApply fills form (5s wait after navigation)');
  }
  if (browserMode === 'connect') {
    console.log(`[auto-submit] Browser mode: CDP attach (port ${debugPort}) — run launch-debug-browser.mjs first`);
  }

  // ── Personal info (required unless extension autofill handles form fill) ──────
  let personal = null;
  try {
    personal = await loadPersonalInfo();
    console.log(`[auto-submit] Personal info loaded: ${personal.name.full} <${personal.contact.email}>`);
  } catch (e) {
    if (e instanceof PersonalInfoError) {
      if (!useExtension) {
        console.error(`[auto-submit] FATAL: ${e.message}`);
        process.exit(1);
      }
           console.log('[auto-submit] personal-info.yml not found — SpeedyApply will handle form fill');
    } else {
      throw e;
    }
  }

  // ── Playwright ───────────────────────────────────────────────────────────────
  let pw;
  try {
    pw = await import('playwright');
  } catch {
    const hint = browserCfg.preferred === 'firefox'
      ? 'npx playwright install firefox'
      : 'npx playwright install chromium';
    console.error(`[auto-submit] FATAL: Playwright not available. Run: ${hint}`);
    process.exit(1);
  }

  if (SEMI_AUTO) {
    await runSemiAuto(toProcess, pw, personal, browserCfg, useExtension, browserMode, debugPort, clIdx);
    return;
  }

  // LIVE
  const { captchaBlocked, formBlocked } = await runLive(toProcess, pw, ALLOW_TIER, personal, browserCfg, useExtension, browserMode, debugPort, clIdx);
  if (captchaBlocked > 0) process.exit(2);
  if (formBlocked > 0)    process.exit(3);
  process.exit(0);
}

// ── CLI guard (prevents main() from running on import) ────────────────────────
const IS_CLI = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (IS_CLI) {
  main().catch((e) => { console.error('[auto-submit] FATAL:', e.message); process.exit(1); });
}

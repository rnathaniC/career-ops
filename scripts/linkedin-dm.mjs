#!/usr/bin/env node
/**
 * linkedin-dm.mjs — Send a LinkedIn connection/DM message for a New-Hot
 * (warm-referral) card, after Rahil has reviewed it.
 *
 * REBUILT 2026-07-06 — lost to the r7 OneDrive truncation incident (see
 * BUGS.md r7) and never rebuilt until now. Original design recovered from git
 * history (commit 4664285): a fully-autonomous bot that scraped LinkedIn
 * notifications (new jobs, promotions, anniversaries, birthdays...) and
 * auto-DM'd matches up to a random daily cap, PLUS a warm-referral path that
 * pulled cards straight from the Kanban HTML and sent immediately with no
 * per-card human confirmation.
 *
 * INTENTIONAL DEVIATION FROM THE ORIGINAL: the standing engine law formalized
 * 2026-06-15 (see pulse-refresh.mjs DESIGN NOTE, referral-queue.mjs header) is
 * that New-Hot cards are human-in-the-loop ONLY — nothing sends on Rahil's
 * behalf without his review. The original's autonomous notification-scraping
 * send loop and immediate-send referral path both predate that law and would
 * violate it if resurrected as-is. This rebuild keeps the recovered messaging
 * craft (message templates, dedup log, atomic log writes, 2FA-wait login) but
 * changes the trigger model:
 *
 *   - Source of truth for WHAT to send is now the SAME data referral-queue.mjs
 *     already surfaces (New-Hot cards from the newest kanban-import, plus the
 *     Notes field as "ready-to-send message" per [[project_pulse_lanes]]) —
 *     not a separately-scraped notifications feed.
 *   - Nothing sends without an explicit, per-run human command:
 *       --list                        (default-safe: show what's pending, no browser)
 *       --send <cardId> --confirm     (send ONE card's message)
 *       --send-all --confirm          (send all pending, still capped — see dailyCap)
 *     There is no npm script wiring this into pulse-refresh.mjs's automated
 *     1am run — referral-queue.mjs runs automatically and prints the queue;
 *     actually sending is always a separate, manual, --confirm'd invocation.
 *   - The autonomous notification-scraping mode from the original (new_job /
 *     promotion / work_anniversary / certification / article / departure /
 *     birthday detection) is NOT reinstated. If Rahil wants that mode back,
 *     it should be a deliberate, separately-reviewed feature decision — not
 *     something a rebuild silently restores.
 *
 * IMPORTANT — NOT LIVE-TESTED: this script has NOT been run against real
 * LinkedIn from this sandbox. Automating a real login/send attempt from an
 * unfamiliar sandbox IP risks tripping LinkedIn's bot/security flags against
 * Rahil's real account. All Playwright interaction is unit-tested via an
 * injectable `pwModule` (fake chromium/page/context double) — see
 * test/linkedin-dm.test.mjs. Rahil must run this for real on his own
 * machine/session before it's used for live outreach.
 *
 * Usage:
 *   node scripts/linkedin-dm.mjs --list
 *   node scripts/linkedin-dm.mjs --send live-2026-07-01-002 --confirm
 *   node scripts/linkedin-dm.mjs --send-all --confirm
 *   node scripts/linkedin-dm.mjs --send live-2026-07-01-002 --dry-run   (rehearse, no send)
 *
 * Exit codes: 0 = done (sent >=1, or --list with candidates) ·
 *             1 = fatal error · 2 = 2FA/manual-verification timed out ·
 *             3 = nothing to do (no candidates / already messaged within 30d)
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newestKanbanImport } from './referral-queue.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

export const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
export const DM_LOG_PATH  = join(ROOT, 'data', 'linkedin-dm-log.json');
export const SESSION_DIR  = join(ROOT, 'data', 'linkedin-session');
export const DEDUP_WINDOW_DAYS = 30;

export class LinkedInDmError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LinkedInDmError';
  }
}

// ─── credentials (env password + profile.yml email — never hardcoded) ────────

/**
 * Password comes ONLY from LINKEDIN_PASSWORD (.env / process.env) — never
 * hardcoded, never logged. Email is not a secret and lives in
 * config/profile.yml under linkedin.email.
 * @returns {Promise<{email: string, password: string}>}
 */
export async function loadLinkedInCredentials() {
  const password = process.env.LINKEDIN_PASSWORD || '';
  let email = '';
  if (existsSync(PROFILE_PATH)) {
    try {
      const { default: yaml } = await import('js-yaml');
      const doc = yaml.load(readFileSync(PROFILE_PATH, 'utf8')) || {};
      email = doc?.linkedin?.email || '';
    } catch {
      // js-yaml missing or profile.yml malformed — fall through with empty email.
    }
  }
  return { email, password };
}

// ─── dedup log (atomic write, same shape as the original) ────────────────────

export function loadLog() {
  if (!existsSync(DM_LOG_PATH)) return { version: '1.0', entries: [], messaged: [] };
  try {
    const parsed = JSON.parse(readFileSync(DM_LOG_PATH, 'utf8'));
    if (!Array.isArray(parsed.messaged)) parsed.messaged = [];
    if (!Array.isArray(parsed.entries)) parsed.entries = [];
    return parsed;
  } catch {
    return { version: '1.0', entries: [], messaged: [] };
  }
}

export function saveLog(log) {
  mkdirSync(dirname(DM_LOG_PATH), { recursive: true });
  const tmp = DM_LOG_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(log, null, 2), 'utf8');
  renameSync(tmp, DM_LOG_PATH);
}

/** @returns {boolean} true if profileUrl was already messaged for this card within DEDUP_WINDOW_DAYS */
export function alreadyMessaged(log, profileUrl, cardId) {
  const cutoff = Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return log.messaged.some((m) =>
    m.profileUrl === profileUrl &&
    m.cardId === cardId &&
    new Date(m.messaged_at).getTime() > cutoff
  );
}

// ─── source of truth: New-Hot cards from the newest kanban-import ────────────
// Same source referral-queue.mjs reads — see that file's DATA SOURCE NOTE for
// why this (not a separate Airtable pull) is the current real source.

/**
 * Load open New-Hot cards with at least one connection carrying a LinkedIn
 * profile URL. Mirrors referral-queue.mjs's splitByLane()/pool-normalizing
 * logic so both scripts see the same candidate set.
 * @param {string} dataDir
 * @returns {object[]} cards
 */
export function loadHotCards(dataDir) {
  const source = newestKanbanImport(dataDir);
  if (!source) return [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(source, 'utf8'));
  } catch {
    return [];
  }
  const pool = Array.isArray(raw) ? raw
    : Array.isArray(raw.cards) ? raw.cards
    : raw.cards && typeof raw.cards === 'object' ? Object.values(raw.cards)
    : Object.values(raw);
  return pool.filter((c) => c && typeof c === 'object' && !c.closedAt && c.isWarmReferral);
}

/**
 * Connections for a card, normalized to [{name, position, url}], filtered to
 * ones with a usable LinkedIn profile URL. Prefers the structured
 * connections[] array; falls back to the legacy connectionName/
 * connectionLinkedinUrl scalar pair (same fallback referral-queue.mjs uses).
 * @param {object} card
 * @returns {{name: string, position: string, url: string}[]}
 */
export function connectionsForCard(card) {
  const list = Array.isArray(card.connections) && card.connections.length
    ? card.connections
    : (card.connectionName
        ? [{ name: card.connectionName, position: '', url: card.connectionLinkedinUrl || '' }]
        : []);
  return list.filter((c) => c && c.url && c.url.includes('linkedin.com/in/'));
}

/**
 * The message to send for a card+connection. Per [[project_pulse_lanes]], the
 * Notes field holds a ready-to-send, human-reviewed message — that always
 * wins when present. Falls back to referral-queue.mjs's auto-generated
 * template (same voice, so a card without a hand-written Notes message still
 * gets something reasonable, clearly marked as auto-generated in --list output).
 * @param {object} card
 * @param {{name: string, position: string, url: string}} connection
 * @returns {{text: string, drafted: boolean}}
 */
export function messageForCard(card, connection) {
  const notes = (card.notes || '').trim();
  if (notes) return { text: notes, drafted: true };
  const firstName = (connection.name || '').split(/\s+/)[0] || 'there';
  const company = card.company || 'the company';
  const role = card.role || 'the role';
  return {
    text: `Hey ${firstName}, noticed ${company} has a ${role} opening — would love to get your perspective on the team before I apply. Happy to keep it brief!`,
    drafted: false,
  };
}

/**
 * Build the full list of pending send candidates: one entry per
 * (card, connection) pair not already messaged within the dedup window.
 * @param {string} dataDir
 * @param {object} log
 * @returns {object[]} candidates: {cardId, company, role, name, profileUrl, message, drafted}
 */
export function buildCandidates(dataDir, log) {
  const cards = loadHotCards(dataDir);
  const out = [];
  for (const card of cards) {
    for (const conn of connectionsForCard(card)) {
      if (alreadyMessaged(log, conn.url, card.id)) continue;
      const msg = messageForCard(card, conn);
      out.push({
        cardId: card.id, company: card.company || '', role: card.role || '',
        name: conn.name || '', profileUrl: conn.url, message: msg.text, drafted: msg.drafted,
      });
    }
  }
  return out;
}

// ─── auto-fill login (mirrors workday-login.mjs's layered-selector convention) ─

const EMAIL_SELECTORS = ['#username', 'input[name="session_key"]', 'input[type="email"]'];
const PASSWORD_SELECTORS = ['#password', 'input[name="session_password"]', 'input[type="password"]'];
const SIGNIN_SELECTORS = ['[type="submit"]', 'button:has-text("Sign in")'];
const VERIFICATION_SELECTORS = [
  '#input__phone_verification_pin', 'input[name="pin"]', '#two-step-challenge',
  '[data-testid="two-step-challenge"]', 'input[autocomplete="one-time-code"]',
];

async function firstMatch(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) return el;
    } catch { /* try next selector */ }
  }
  return null;
}

export async function isLoggedIn(page) {
  const el = await firstMatch(page, ['.global-nav__primary-link', '.feed-identity-module', '#voyager-feed']);
  return Boolean(el);
}

/**
 * Ensure an active LinkedIn session, auto-filling credentials first and
 * falling back to a manual-completion wait (2-minute deadline, skipped when
 * non-interactive) if a 2FA/verification challenge appears — same shape as
 * workday-login.mjs's waitForManualVerification().
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
export async function ensureLoggedIn(page, creds, { interactive = Boolean(process.stdin.isTTY) } = {}) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  if (await isLoggedIn(page)) return { ok: true, reason: 'session-active' };

  if (!creds.email || !creds.password) {
    return { ok: false, reason: 'missing-credentials' };
  }

  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const emailEl = await firstMatch(page, EMAIL_SELECTORS);
  if (!emailEl) return { ok: false, reason: 'email-field-not-found' };
  await emailEl.fill(creds.email);
  const passwordEl = await firstMatch(page, PASSWORD_SELECTORS);
  if (!passwordEl) return { ok: false, reason: 'password-field-not-found' };
  await passwordEl.fill(creds.password);
  const signInEl = await firstMatch(page, SIGNIN_SELECTORS);
  if (!signInEl) return { ok: false, reason: 'sign-in-button-not-found' };
  await signInEl.click();
  if (page.waitForTimeout) await page.waitForTimeout(2000);

  const needs2FA = Boolean(await firstMatch(page, VERIFICATION_SELECTORS));
  if (needs2FA) {
    if (!interactive) return { ok: false, reason: 'non-interactive-2fa' };
    console.log('');
    console.log('---------------------------------------------------');
    console.log('  LinkedIn needs verification (2FA / CAPTCHA).');
    console.log('  Complete it in the browser window that opened.');
    console.log('  Waiting up to 2 minutes...');
    console.log('---------------------------------------------------');
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await isLoggedIn(page)) return { ok: true, reason: 'verified' };
    }
    return { ok: false, reason: 'timeout' };
  }

  if (await isLoggedIn(page)) return { ok: true, reason: 'logged-in' };
  return { ok: false, reason: 'login-did-not-land-on-feed' };
}

// ─── send ─────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

const MSG_INPUT_SELECTORS = [
  'div.msg-form__contenteditable[contenteditable="true"]',
  'div[aria-label="Write a message…"]',
  '.msg-form__msg-content-container [contenteditable="true"]',
];
const SEND_BUTTON_SELECTORS = [
  'button.msg-form__send-button',
  'button[type="submit"]:has-text("Send")',
  'button:has-text("Send"):not([disabled])',
];

/**
 * Open a connection's profile and send the given message. Throws on any
 * step it can't complete (caller records the failure per-candidate rather
 * than aborting the whole batch).
 */
export async function sendDM(page, profileUrl, message) {
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(rand(1000, 2000));

  const msgBtn = await firstMatch(page, ['button:has-text("Message")', 'a:has-text("Message")']);
  if (!msgBtn) throw new LinkedInDmError('Could not open messaging interface (no Message button found)');
  await msgBtn.click();
  await sleep(rand(800, 1500));

  const inputEl = await firstMatch(page, MSG_INPUT_SELECTORS);
  if (!inputEl) throw new LinkedInDmError('Message input not found');
  await inputEl.click();
  await sleep(rand(200, 400));
  await page.keyboard.type(message, { delay: rand(20, 40) });
  await sleep(rand(400, 900));

  const sendBtn = await firstMatch(page, SEND_BUTTON_SELECTORS);
  if (!sendBtn) throw new LinkedInDmError('Send button not found');
  await sendBtn.click();
  await sleep(rand(500, 1200));
}

/**
 * Send messages for the given candidates. ALWAYS requires the caller to have
 * already gated this on --confirm at the CLI layer — this function itself
 * does not re-check confirmation, so callers (tests, future scripts) must be
 * deliberate about invoking it.
 * @param {object[]} candidates  from buildCandidates()
 * @param {{ pwModule?: object, headless?: boolean, dryRun?: boolean, creds?: object, cap?: number }} opts
 */
export async function sendCandidates(candidates, {
  pwModule = null, headless = false, dryRun = false, creds = null, cap = Infinity,
} = {}) {
  const log = loadLog();
  const resolvedCreds = creds || await loadLinkedInCredentials();
  const toSend = candidates.slice(0, cap);
  const results = [];

  if (dryRun) {
    for (const c of toSend) {
      console.log(`[linkedin-dm] [DRY RUN] Would send to ${c.name} (${c.cardId}): "${c.message.slice(0, 80)}${c.message.length > 80 ? '...' : ''}"`);
      results.push({ ...c, status: 'dry_run' });
    }
    return { ok: true, sent: 0, results };
  }

  const pw = pwModule || await import('playwright');
  mkdirSync(SESSION_DIR, { recursive: true });
  const context = await pw.chromium.launchPersistentContext(SESSION_DIR, {
    headless,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  let sentCount = 0;
  try {
    const login = await ensureLoggedIn(page, resolvedCreds);
    if (!login.ok) {
      await context.close().catch(() => {});
      return { ok: false, sent: 0, results, code: login.reason === 'timeout' ? 2 : 1, reason: login.reason };
    }

    for (const c of toSend) {
      try {
        await sendDM(page, c.profileUrl, c.message);
        results.push({ ...c, status: 'sent', sent_at: new Date().toISOString() });
        log.messaged.push({ cardId: c.cardId, profileUrl: c.profileUrl, name: c.name, messaged_at: new Date().toISOString() });
        sentCount++;
        console.log(`[linkedin-dm]   OK sent to ${c.name} (${c.cardId}).`);
        if (toSend.indexOf(c) < toSend.length - 1) await sleep(rand(3000, 8000));
      } catch (err) {
        results.push({ ...c, status: 'error', error: err.message, sent_at: new Date().toISOString() });
        console.error(`[linkedin-dm]   FAILED for ${c.name} (${c.cardId}): ${err.message}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  log.entries.push({
    date: new Date().toISOString().slice(0, 10), ran_at: new Date().toISOString(),
    sent: sentCount, attempted: toSend.length, dry_run: false, messages: results,
  });
  saveLog(log);

  return { ok: true, sent: sentCount, results };
}

// ── CLI guard (prevents CLI parsing from running on import) ──────────────────

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null;
}
function flag(name) { return process.argv.includes(name); }

function printCandidateList(candidates) {
  if (candidates.length === 0) {
    console.log('[linkedin-dm] No pending New-Hot outreach — nothing new to send (or all messaged within 30 days).');
    return;
  }
  console.log(`[linkedin-dm] ${candidates.length} pending outreach candidate(s):\n`);
  for (const c of candidates) {
    console.log(`  cardId: ${c.cardId}`);
    console.log(`  ${c.name}  @  ${c.company} (${c.role})`);
    console.log(`  ${c.profileUrl}`);
    console.log(`  message${c.drafted ? '' : ' (auto-generated — no Notes field set)'}: "${c.message.slice(0, 100)}${c.message.length > 100 ? '...' : ''}"`);
    console.log('');
  }
  console.log('To send: node scripts/linkedin-dm.mjs --send <cardId> --confirm');
  console.log('To send all: node scripts/linkedin-dm.mjs --send-all --confirm');
}

async function main() {
  try {
    const { config } = await import('dotenv');
    config();
  } catch { /* dotenv optional */ }

  const dataDir = resolve(ROOT, 'data');
  const log = loadLog();
  const candidates = buildCandidates(dataDir, log);

  if (flag('--list') || (!flag('--send') && !flag('--send-all') && !arg('--send'))) {
    printCandidateList(candidates);
    process.exit(candidates.length > 0 ? 0 : 3);
  }

  const cardId = arg('--send');
  const sendAll = flag('--send-all');
  const confirmed = flag('--confirm');
  const dryRun = flag('--dry-run');

  let toSend = candidates;
  if (typeof cardId === 'string') {
    toSend = candidates.filter((c) => c.cardId === cardId);
    if (toSend.length === 0) {
      console.error(`[linkedin-dm] No pending candidate for cardId "${cardId}" (already sent, no connection URL, or card not New-Hot).`);
      process.exit(3);
    }
  } else if (!sendAll) {
    console.error('[linkedin-dm] Usage: --send <cardId> --confirm | --send-all --confirm | --list');
    process.exit(1);
  }

  if (!confirmed && !dryRun) {
    console.error('[linkedin-dm] Refusing to send without --confirm (or use --dry-run to rehearse). This is a human-in-the-loop gate — see file header.');
    printCandidateList(toSend);
    process.exit(1);
  }

  // Daily cap only meaningfully applies to --send-all; a single --send is always 1.
  const dailyCap = sendAll ? Math.floor(Math.random() * 6) + 5 : 1;
  const result = await sendCandidates(toSend, { dryRun, cap: dailyCap });

  if (!result.ok) {
    console.error(`[linkedin-dm] FAILED: ${result.reason}`);
    process.exit(result.code || 1);
  }
  console.log(`[linkedin-dm] Done. Sent: ${result.sent}/${toSend.length}.`);
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (IS_CLI) {
  main().catch((e) => {
    console.error(`[linkedin-dm] FATAL: ${e.message}`);
    process.exit(1);
  });
}

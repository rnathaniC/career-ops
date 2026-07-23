#!/usr/bin/env node
/**
 * workday-login.mjs — Pre-authenticate a Workday tenant and save the session
 * for reuse by auto-submit.mjs / other apply scripts.
 *
 * REBUILT 2026-07-06 — lost to the r7 OneDrive truncation incident (see BUGS.md
 * r7) and never rebuilt until now. Original design recovered from git history
 * (commit 4664285, "feat: Phase 1 — Cloudflare Worker + Greenhouse/Lever
 * adapters"): a fully-manual flow — opens a headed browser, Rahil signs in by
 * hand, script waits for an ENTER keypress, then saves storageState. That
 * design is preserved as the fallback path here.
 *
 * WHAT'S NEW in this rebuild: automated credential fill using WORKDAY_PASSWORD
 * (.env) + the login email from config/profile.yml
 * (autosubmit.platform_logins.workday.email) — mirrors the env-var-precedence
 * pattern already used by linkedin-dm.mjs. Auto-fill is attempted first; if a
 * 2FA/verification challenge is detected (or auto-fill can't find the form),
 * this falls back to the original manual-completion flow instead of failing
 * outright — same shape as linkedin-dm.mjs's ensureLoggedIn() 2FA wait.
 *
 * IMPORTANT — NOT LIVE-TESTED: this script has NOT been run against a real
 * Workday tenant from this sandbox. Automating a real login attempt from an
 * unfamiliar sandbox IP risks tripping Workday's bot/security flags against
 * Rahil's real account. All Playwright interaction here is unit-tested via an
 * injectable `pwModule` (fake chromium/page/context) — see
 * test/workday-login.test.mjs. Rahil must run this for real on his own
 * machine/session before it's used for a live application.
 *
 * Sessions are stored per Workday tenant (hostname prefix, e.g. "gevernova",
 * "humana", "globalhr") in data/workday-sessions/{tenant}.json. A single
 * sign-in covers ALL jobs on that tenant. Sessions typically last ~21 days.
 *
 * REUSABLE HELPER: other apply scripts (auto-submit.mjs) should call
 * getValidSessionPath(url) before submitting to a Workday listing — returns
 * the storageState path to load into the browser context, or null if no
 * fresh session exists (caller should then prompt Rahil to run this script).
 *
 * Usage:
 *   node scripts/workday-login.mjs --url "https://gevernova.wd5.myworkdayjobs.com/..."
 *   node scripts/workday-login.mjs --tenant gevernova     # opens tenant home page
 *   node scripts/workday-login.mjs --list                 # show saved sessions
 *   node scripts/workday-login.mjs --clear gevernova       # delete saved session
 *   node scripts/workday-login.mjs --clear-all             # delete all sessions
 *   node scripts/workday-login.mjs --url "..." --force     # re-auth even if fresh session exists
 *
 * Exit codes: 0 = session saved/already fresh · 1 = fatal error ·
 *             2 = manual verification (2FA/CAPTCHA) timed out ·
 *             3 = no action needed / management command completed
 */

import {
  readFileSync, writeFileSync, renameSync, existsSync,
  mkdirSync, readdirSync, unlinkSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

export const SESSIONS_DIR     = join(ROOT, 'data', 'workday-sessions');
export const SESSION_TTL_DAYS = 21; // sessions older than this are flagged stale
export const PROFILE_PATH     = join(ROOT, 'config', 'profile.yml');

export class WorkdayLoginError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkdayLoginError';
  }
}

// ─── tenant / session-path helpers ────────────────────────────────────────────

/** @param {string} url @returns {string|null} tenant slug, e.g. "gevernova" */
export function extractTenant(url) {
  try {
    const host = new URL(url).hostname; // e.g. gevernova.wd5.myworkdayjobs.com
    return host.split('.')[0] || null;
  } catch {
    return null;
  }
}

/** @param {string} tenant @returns {string} absolute path to that tenant's session file */
export function sessionPath(tenant, dir = SESSIONS_DIR) {
  return join(dir, `${tenant}.json`);
}

/**
 * Read a tenant's saved session and report its freshness. Never throws — a
 * missing/corrupt file just reports as not existing.
 * @param {string} tenant
 * @returns {{exists: boolean, stale?: boolean, ageDays?: number, savedAt?: string, path: string}}
 */
export function sessionMeta(tenant, dir = SESSIONS_DIR) {
  const p = sessionPath(tenant, dir);
  if (!existsSync(p)) return { exists: false, path: p };
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    const savedAt = new Date(data._saved_at);
    const ageDays = (Date.now() - savedAt.getTime()) / 86400000;
    return { exists: true, stale: ageDays > SESSION_TTL_DAYS, ageDays, savedAt: data._saved_at, path: p };
  } catch {
    return { exists: false, path: p };
  }
}

/**
 * REUSABLE HELPER for other apply scripts (auto-submit.mjs): given a Workday
 * job URL, return the storageState path to load if a fresh (non-stale) saved
 * session exists for that tenant, else null.
 * @param {string} url
 * @returns {string|null}
 */
export function getValidSessionPath(url, dir = SESSIONS_DIR) {
  const tenant = extractTenant(url);
  if (!tenant) return null;
  const meta = sessionMeta(tenant, dir);
  return meta.exists && !meta.stale ? meta.path : null;
}

export function listSessions(dir = SESSIONS_DIR) {
  if (!existsSync(dir)) { console.log('No sessions saved yet.'); return []; }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) { console.log('No sessions saved yet.'); return []; }
  const rows = files.map((f) => {
    const tenant = f.replace(/\.json$/, '');
    const meta = sessionMeta(tenant, dir);
    return { tenant, ...meta };
  });
  console.log(`\nSaved Workday sessions (${rows.length}):\n`);
  for (const r of rows) {
    const status = !r.exists ? '❓ UNREADABLE' : r.stale ? '⚠️  STALE' : '✅ FRESH';
    const ageStr = r.ageDays != null ? `${r.ageDays.toFixed(1)} days ago` : '';
    console.log(`  ${status}  ${r.tenant.padEnd(20)} ${ageStr}`);
  }
  console.log('');
  return rows;
}

export function clearSession(tenant, dir = SESSIONS_DIR) {
  const p = sessionPath(tenant, dir);
  if (existsSync(p)) { unlinkSync(p); return true; }
  return false;
}

export function clearAllSessions(dir = SESSIONS_DIR) {
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) unlinkSync(join(dir, f));
  return files.length;
}

// ─── credentials (env password + profile.yml email — never hardcoded) ────────

/**
 * Load Workday login credentials. Password comes ONLY from WORKDAY_PASSWORD
 * (.env / process.env) — never hardcoded, never logged. Email is not a
 * secret and lives in config/profile.yml under autosubmit.platform_logins.workday.email
 * (same non-secret/secret split as linkedin-dm.mjs's linkedin.email + LINKEDIN_PASSWORD).
 * @returns {Promise<{email: string, password: string}>}
 */
export async function loadWorkdayCredentials() {
  const password = process.env.WORKDAY_PASSWORD || '';
  let email = '';
  if (existsSync(PROFILE_PATH)) {
    try {
      const { default: yaml } = await import('js-yaml');
      const doc = yaml.load(readFileSync(PROFILE_PATH, 'utf8')) || {};
      email = doc?.autosubmit?.platform_logins?.workday?.email || '';
    } catch {
      // js-yaml missing or profile.yml malformed — fall through with empty email.
      // Callers surface a clear error rather than crashing (see runLogin()).
    }
  }
  return { email, password };
}

// ─── auto-fill login (layered selectors, Kaizen K-2026-06-09-21 convention) ──

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="username"]',
  'input#input-1',
  'input[data-automation-id="email"]',
];
const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[data-automation-id="password"]',
];
const SIGNIN_SELECTORS = [
  'button[type="submit"]',
  'button[data-automation-id="signInSubmitButton"]',
  'button:has-text("Sign In")',
];
const VERIFICATION_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name="verificationCode"]',
  '[data-automation-id="verificationCode"]',
  'text=/verify|verification code|two-factor/i',
];

async function firstMatch(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) return el;
    } catch { /* selector engine may not support one variant — try next */ }
  }
  return null;
}

/**
 * Attempt automated credential fill on whatever Workday sign-in page is
 * currently loaded. Returns without throwing on failure — callers decide
 * whether to fall back to the manual flow.
 * @param {object} page  Playwright Page (or injectable test double)
 * @param {{email: string, password: string}} creds
 * @returns {Promise<{ok: boolean, needsManual: boolean, reason: string}>}
 */
export async function attemptAutoLogin(page, creds) {
  if (!creds.email || !creds.password) {
    return { ok: false, needsManual: true, reason: 'missing-credentials' };
  }

  const emailEl = await firstMatch(page, EMAIL_SELECTORS);
  if (!emailEl) return { ok: false, needsManual: true, reason: 'email-field-not-found' };
  await emailEl.fill(creds.email);

  const passwordEl = await firstMatch(page, PASSWORD_SELECTORS);
  if (!passwordEl) return { ok: false, needsManual: true, reason: 'password-field-not-found' };
  await passwordEl.fill(creds.password);

  const signInEl = await firstMatch(page, SIGNIN_SELECTORS);
  if (!signInEl) return { ok: false, needsManual: true, reason: 'sign-in-button-not-found' };
  await signInEl.click();

  if (page.waitForTimeout) await page.waitForTimeout(1500);

  const verificationEl = await firstMatch(page, VERIFICATION_SELECTORS);
  if (verificationEl) return { ok: false, needsManual: true, reason: '2fa-challenge' };

  return { ok: true, needsManual: false, reason: 'submitted' };
}

/**
 * Poll for login success after a manual/2FA step, same shape as
 * linkedin-dm.mjs's ensureLoggedIn() 2FA wait (3s poll, 2-minute deadline).
 * Skips the wait entirely in non-interactive contexts (no TTY) so a scheduled
 * run never hangs — it just reports the timeout immediately.
 * @param {object} page
 * @param {() => Promise<boolean>} isLoggedInFn
 * @param {{ deadlineMs?: number, pollMs?: number, interactive?: boolean }} [opts]
 */
export async function waitForManualVerification(page, isLoggedInFn, opts = {}) {
  const {
    deadlineMs = 120_000,
    pollMs = 3000,
    interactive = Boolean(process.stdin.isTTY),
  } = opts;

  if (!interactive) {
    return { verified: false, reason: 'non-interactive-no-wait' };
  }

  console.log('');
  console.log('---------------------------------------------------');
  console.log('  Workday needs manual verification (2FA/CAPTCHA).');
  console.log('  Complete it in the browser window that opened.');
  console.log('  Script will continue automatically once done.');
  console.log(`  Waiting up to ${(deadlineMs / 1000 / 60).toFixed(0)} minute(s)...`);
  console.log('---------------------------------------------------');

  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (await isLoggedInFn()) return { verified: true, reason: 'verified' };
  }
  return { verified: false, reason: 'timeout' };
}

// ─── main login orchestration (Playwright-injectable for tests) ─────────────

/**
 * Run the full pre-auth flow for one tenant: check existing session (unless
 * force), launch a browser, try automated credential fill, fall back to a
 * manual completion window if needed, save storageState.
 *
 * `pwModule` defaults to the real `playwright` import but is injectable so
 * tests can supply a fake chromium/page/context double — this function
 * launches a real browser ONLY when called with the default import, which
 * this repo's test suite never does (see test/workday-login.test.mjs).
 *
 * @param {{
 *   url?: string, tenant?: string, force?: boolean, headless?: boolean,
 *   pwModule?: object, creds?: {email:string,password:string},
 *   interactive?: boolean,
 * }} opts
 * @returns {Promise<{ok: boolean, code: number, message: string, tenant?: string}>}
 */
export async function runLogin({
  url = null, tenant: tenantArg = null, force = false, headless = false,
  pwModule = null, creds = null, interactive = undefined, sessionsDir = SESSIONS_DIR,
} = {}) {
  let tenant = tenantArg;
  let startUrl = url;
  if (url) {
    tenant = extractTenant(url);
  } else if (tenantArg) {
    tenant = tenantArg;
    startUrl = `https://${tenant}.wd1.myworkdayjobs.com`;
  } else {
    return { ok: false, code: 1, message: 'Provide --url <job url> or --tenant <slug>.' };
  }
  if (!tenant) {
    return { ok: false, code: 1, message: `Could not extract tenant from URL: ${url}` };
  }

  if (!force) {
    const meta = sessionMeta(tenant, sessionsDir);
    if (meta.exists && !meta.stale) {
      return {
        ok: true, code: 0, tenant,
        message: `Session for "${tenant}" already saved (${meta.ageDays.toFixed(1)} days old). Run with --force to refresh.`,
      };
    }
  }

  const resolvedCreds = creds || await loadWorkdayCredentials();
  const pw = pwModule || await import('playwright');

  mkdirSync(sessionsDir, { recursive: true });

  console.log(`\n🔐 Opening Workday login for tenant: ${tenant}`);
  console.log(`   URL: ${startUrl}`);

  const browser = await pw.chromium.launch({ headless, args: ['--start-maximized'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: null,
  });
  const page = await context.newPage();

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    const isLoggedInFn = async () => {
      const el = await firstMatch(page, ['[data-automation-id="userAccountLink"]', 'text=/sign out|log out/i']);
      return Boolean(el);
    };

    const attempt = await attemptAutoLogin(page, resolvedCreds);
    let finalOk = attempt.ok;

    if (!attempt.ok) {
      console.log(`[workday-login] Auto-fill did not complete (${attempt.reason}) — falling back to manual completion.`);
      const wait = await waitForManualVerification(page, isLoggedInFn, { interactive });
      finalOk = wait.verified;
      if (!finalOk) {
        await browser.close().catch(() => {});
        if (wait.reason === 'non-interactive-no-wait') {
          return {
            ok: false, code: 2, tenant,
            message: `Could not auto-fill Workday login for "${tenant}" (${attempt.reason}) and this run is non-interactive — re-run on an interactive session to complete manually, or set up credentials so auto-fill can proceed.`,
          };
        }
        return { ok: false, code: 2, tenant, message: `Manual verification for "${tenant}" timed out. Re-run when ready.` };
      }
    }

    const state = await context.storageState();
    state._saved_at = new Date().toISOString();
    state._tenant   = tenant;
    state._url      = startUrl;

    const target = sessionPath(tenant, sessionsDir);
    const tmp = target + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, target);

    await browser.close().catch(() => {});
    return { ok: true, code: 0, tenant, message: `Session saved for "${tenant}" → data/workday-sessions/${tenant}.json` };
  } catch (e) {
    await browser.close().catch(() => {});
    return { ok: false, code: 1, tenant, message: `Fatal error during Workday login: ${e.message}` };
  }
}

// ── CLI guard (prevents CLI parsing from running on import) ──────────────────

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null;
}
function flag(name) { return process.argv.includes(name); }

async function main() {
  try {
    const { config } = await import('dotenv');
    config();
  } catch { /* dotenv optional */ }

  if (flag('--list')) { listSessions(); process.exit(3); }

  const clearTenant = arg('--clear');
  if (clearTenant && typeof clearTenant === 'string') {
    const cleared = clearSession(clearTenant);
    console.log(cleared ? `Cleared session for: ${clearTenant}` : `No session found for: ${clearTenant}`);
    process.exit(3);
  }

  if (flag('--clear-all')) {
    const n = clearAllSessions();
    console.log(`Cleared ${n} session(s).`);
    process.exit(3);
  }

  const urlArg    = arg('--url');
  const tenantArg = arg('--tenant');
  if (!urlArg && !tenantArg) {
    console.error('Usage: node scripts/workday-login.mjs --url <url> | --tenant <slug> | --list | --clear <slug> | --clear-all');
    process.exit(1);
  }

  const result = await runLogin({
    url: typeof urlArg === 'string' ? urlArg : null,
    tenant: typeof tenantArg === 'string' ? tenantArg : null,
    force: flag('--force'),
    headless: false,
  });

  console.log(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
  process.exit(result.code);
}

const __filename = fileURLToPath(import.meta.url);
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (IS_CLI) {
  main().catch((e) => {
    console.error(`[workday-login] FATAL: ${e.message}`);
    process.exit(1);
  });
}

/**
 * workday-login.test.mjs — Workday pre-auth helper (session mgmt + login flow)
 *
 * Playwright is never launched for real here — chromium.launch/newContext/
 * newPage are fake doubles (same convention as test/cdp-attach.test.mjs's
 * mockPw). This script must NOT be run against live Workday from this
 * sandbox — see file header in scripts/workday-login.mjs.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  extractTenant,
  sessionPath,
  sessionMeta,
  getValidSessionPath,
  listSessions,
  clearSession,
  clearAllSessions,
  attemptAutoLogin,
  waitForManualVerification,
  runLogin,
  SESSION_TTL_DAYS,
} from '../scripts/workday-login.mjs';

const TMP = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-workday-login-test-'));
function freshDir() { return fs.mkdtempSync(path.join(TMP, 'case-')); }
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function writeSession(dir, tenant, ageDays) {
  fs.mkdirSync(dir, { recursive: true });
  const savedAt = new Date(Date.now() - ageDays * 86400000).toISOString();
  fs.writeFileSync(path.join(dir, `${tenant}.json`), JSON.stringify({ _saved_at: savedAt, _tenant: tenant, cookies: [] }));
}

// ── extractTenant ─────────────────────────────────────────────────────────────

describe('extractTenant', () => {
  test('extracts the subdomain prefix from a myworkdayjobs.com URL', () => {
    assert.equal(extractTenant('https://gevernova.wd5.myworkdayjobs.com/en-US/GE_ExternalSite/job/123'), 'gevernova');
  });
  test('returns null for an unparseable URL', () => {
    assert.equal(extractTenant('not a url'), null);
  });
});

// ── session management ────────────────────────────────────────────────────────

describe('sessionMeta / listSessions / clearSession', () => {
  test('reports exists:false for a tenant with no saved session', () => {
    const dir = freshDir();
    const meta = sessionMeta('nobody', dir);
    assert.equal(meta.exists, false);
  });

  test('reports fresh for a session younger than SESSION_TTL_DAYS', () => {
    const dir = freshDir();
    writeSession(dir, 'gevernova', 2);
    const meta = sessionMeta('gevernova', dir);
    assert.equal(meta.exists, true);
    assert.equal(meta.stale, false);
  });

  test('reports stale for a session older than SESSION_TTL_DAYS', () => {
    const dir = freshDir();
    writeSession(dir, 'gevernova', SESSION_TTL_DAYS + 5);
    const meta = sessionMeta('gevernova', dir);
    assert.equal(meta.exists, true);
    assert.equal(meta.stale, true);
  });

  test('corrupt session file reports exists:false rather than throwing', () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
    const meta = sessionMeta('broken', dir);
    assert.equal(meta.exists, false);
  });

  test('getValidSessionPath returns the path for a fresh session', () => {
    const dir = freshDir();
    writeSession(dir, 'gevernova', 1);
    const url = 'https://gevernova.wd5.myworkdayjobs.com/en-US/GE_ExternalSite/job/123';
    assert.equal(getValidSessionPath(url, dir), sessionPath('gevernova', dir));
  });

  test('getValidSessionPath returns null for a stale session', () => {
    const dir = freshDir();
    writeSession(dir, 'gevernova', SESSION_TTL_DAYS + 1);
    const url = 'https://gevernova.wd5.myworkdayjobs.com/en-US/GE_ExternalSite/job/123';
    assert.equal(getValidSessionPath(url, dir), null);
  });

  test('getValidSessionPath returns null when no session exists at all', () => {
    const dir = freshDir();
    const url = 'https://nevernova.wd5.myworkdayjobs.com/job/1';
    assert.equal(getValidSessionPath(url, dir), null);
  });

  test('listSessions reports every saved tenant with freshness', () => {
    const dir = freshDir();
    writeSession(dir, 'fresh-co', 1);
    writeSession(dir, 'stale-co', SESSION_TTL_DAYS + 10);
    const rows = listSessions(dir);
    assert.equal(rows.length, 2);
    const fresh = rows.find((r) => r.tenant === 'fresh-co');
    const stale = rows.find((r) => r.tenant === 'stale-co');
    assert.equal(fresh.stale, false);
    assert.equal(stale.stale, true);
  });

  test('clearSession removes the tenant file and reports true', () => {
    const dir = freshDir();
    writeSession(dir, 'gevernova', 1);
    assert.equal(clearSession('gevernova', dir), true);
    assert.equal(fs.existsSync(path.join(dir, 'gevernova.json')), false);
  });

  test('clearSession returns false when nothing to clear', () => {
    const dir = freshDir();
    assert.equal(clearSession('ghost', dir), false);
  });

  test('clearAllSessions removes every saved session and returns the count', () => {
    const dir = freshDir();
    writeSession(dir, 'a', 1);
    writeSession(dir, 'b', 1);
    assert.equal(clearAllSessions(dir), 2);
    assert.equal(fs.existsSync(dir) && fs.readdirSync(dir).length, 0);
  });
});

// ── attemptAutoLogin (fake page double, no real browser) ─────────────────────

function fakeEl(overrides = {}) {
  return { fill: async () => {}, click: async () => {}, ...overrides };
}

describe('attemptAutoLogin', () => {
  test('missing credentials -> needsManual, no page interaction attempted', async () => {
    const page = { $: async () => { throw new Error('should not be called'); } };
    const res = await attemptAutoLogin(page, { email: '', password: '' });
    assert.equal(res.ok, false);
    assert.equal(res.needsManual, true);
    assert.equal(res.reason, 'missing-credentials');
  });

  test('email field not found -> needsManual', async () => {
    const page = { $: async () => null };
    const res = await attemptAutoLogin(page, { email: 'a@b.com', password: 'x' });
    assert.equal(res.needsManual, true);
    assert.equal(res.reason, 'email-field-not-found');
  });

  test('happy path: fills email+password, clicks sign-in, no 2FA -> ok', async () => {
    let filledEmail = null, filledPassword = null, clicked = false;
    const page = {
      $: async (sel) => {
        if (sel === 'input[type="email"]') return fakeEl({ fill: async (v) => { filledEmail = v; } });
        if (sel === 'input[type="password"]') return fakeEl({ fill: async (v) => { filledPassword = v; } });
        if (sel === 'button[type="submit"]') return fakeEl({ click: async () => { clicked = true; } });
        return null; // no verification challenge selectors match
      },
      waitForTimeout: async () => {},
    };
    const res = await attemptAutoLogin(page, { email: 'rahil@example.com', password: 'secret' });
    assert.equal(res.ok, true);
    assert.equal(filledEmail, 'rahil@example.com');
    assert.equal(filledPassword, 'secret');
    assert.equal(clicked, true);
  });

  test('2FA challenge detected after submit -> needsManual, reason 2fa-challenge', async () => {
    const page = {
      $: async (sel) => {
        if (sel === 'input[type="email"]') return fakeEl();
        if (sel === 'input[type="password"]') return fakeEl();
        if (sel === 'button[type="submit"]') return fakeEl();
        if (sel === 'input[autocomplete="one-time-code"]') return fakeEl();
        return null;
      },
      waitForTimeout: async () => {},
    };
    const res = await attemptAutoLogin(page, { email: 'a@b.com', password: 'x' });
    assert.equal(res.needsManual, true);
    assert.equal(res.reason, '2fa-challenge');
  });
});

// ── waitForManualVerification ─────────────────────────────────────────────────

describe('waitForManualVerification', () => {
  test('non-interactive context skips the wait immediately', async () => {
    const res = await waitForManualVerification({}, async () => true, { interactive: false });
    assert.equal(res.verified, false);
    assert.equal(res.reason, 'non-interactive-no-wait');
  });

  test('interactive context resolves as soon as isLoggedInFn returns true', async () => {
    let calls = 0;
    const isLoggedInFn = async () => { calls++; return calls >= 2; };
    const res = await waitForManualVerification({}, isLoggedInFn, { interactive: true, deadlineMs: 5000, pollMs: 10 });
    assert.equal(res.verified, true);
  });

  test('interactive context times out if never verified', async () => {
    const res = await waitForManualVerification({}, async () => false, { interactive: true, deadlineMs: 50, pollMs: 10 });
    assert.equal(res.verified, false);
    assert.equal(res.reason, 'timeout');
  });
});

// ── runLogin (fully mocked Playwright — no real browser, no real network) ───

function makeFakePw({ needs2FA = false } = {}) {
  const calls = { goto: [], filled: {}, closed: false, storageStateSaved: null };
  const page = {
    goto: async (url) => { calls.goto.push(url); },
    $: async (sel) => {
      if (sel === 'input[type="email"]') return fakeEl({ fill: async (v) => { calls.filled.email = v; } });
      if (sel === 'input[type="password"]') return fakeEl({ fill: async (v) => { calls.filled.password = v; } });
      if (sel === 'button[type="submit"]') return fakeEl();
      if (needs2FA && sel === 'input[autocomplete="one-time-code"]') return fakeEl();
      if (sel === '[data-automation-id="userAccountLink"]') return needs2FA ? null : fakeEl();
      return null;
    },
    waitForTimeout: async () => {},
    keyboard: { type: async () => {} },
  };
  const context = {
    newPage: async () => page,
    storageState: async () => ({ cookies: [{ name: 'session', value: 'abc' }] }),
  };
  const browser = {
    newContext: async () => context,
    close: async () => { calls.closed = true; },
  };
  return { pw: { chromium: { launch: async () => browser } }, calls };
}

describe('runLogin', () => {
  test('returns error when neither --url nor --tenant is given', async () => {
    const res = await runLogin({});
    assert.equal(res.ok, false);
    assert.equal(res.code, 1);
  });

  test('skips launching a browser when a fresh session already exists (no force)', async () => {
    const dir = freshDir();
    writeSession(dir, 'gevernova', 1);
    const { pw } = makeFakePw();
    let launched = false;
    const pwSpy = { chromium: { launch: async (...a) => { launched = true; return pw.chromium.launch(...a); } } };
    const res = await runLogin({
      url: 'https://gevernova.wd5.myworkdayjobs.com/job/1', sessionsDir: dir, pwModule: pwSpy,
    });
    assert.equal(res.ok, true);
    assert.equal(res.code, 0);
    assert.equal(launched, false, 'should not launch a browser when a fresh session already covers this tenant');
  });

  test('force:true re-authenticates even with a fresh existing session, saves new state', async () => {
    const dir = freshDir();
    writeSession(dir, 'gevernova', 1);
    const { pw, calls } = makeFakePw();
    const res = await runLogin({
      url: 'https://gevernova.wd5.myworkdayjobs.com/job/1', sessionsDir: dir, pwModule: pw, force: true,
      creds: { email: 'rahil@example.com', password: 'secret' },
    });
    assert.equal(res.ok, true, res.message);
    assert.equal(res.code, 0);
    assert.equal(calls.filled.email, 'rahil@example.com');
    assert.equal(calls.closed, true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'gevernova.json'), 'utf8'));
    assert.equal(saved._tenant, 'gevernova');
    assert.ok(saved._saved_at);
  });

  test('non-interactive + 2FA challenge -> code 2, session not saved', async () => {
    const dir = freshDir();
    const { pw } = makeFakePw({ needs2FA: true });
    const res = await runLogin({
      url: 'https://gevernova.wd5.myworkdayjobs.com/job/1', sessionsDir: dir, pwModule: pw, force: true,
      creds: { email: 'rahil@example.com', password: 'secret' }, interactive: false,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 2);
    assert.equal(fs.existsSync(path.join(dir, 'gevernova.json')), false);
  });
});

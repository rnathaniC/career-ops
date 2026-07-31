import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrowserMode, parseDebugPort, launchBrowserForMode } from '../scripts/auto-submit.mjs';
import { buildBrowserArgs } from '../scripts/launch-debug-browser.mjs';

// ── parseBrowserMode ──────────────────────────────────────────────────────────

const chromiumWithProfile = { preferred: 'chromium', chromium: { profile_path: '/some/profile', executable_path: '' }, firefox: {} };
const chromiumNoProfile   = { preferred: 'chromium', chromium: { profile_path: '',              executable_path: '' }, firefox: {} };
const firefoxCfg          = { preferred: 'firefox',  chromium: {},                                                     firefox: { profile_path: '/ff' } };

describe('parseBrowserMode', () => {

  test('explicit connect returns connect regardless of config', () => {
    assert.equal(parseBrowserMode('connect', chromiumNoProfile), 'connect');
  });

  test('explicit launch returns launch regardless of config', () => {
    assert.equal(parseBrowserMode('launch', chromiumWithProfile), 'launch');
  });

  test('null + chromium with profile → connect (default for SpeedyApply use case)', () => {
    assert.equal(parseBrowserMode(null, chromiumWithProfile), 'connect');
  });

  test('null + chromium without profile → launch (fresh context, no extensions needed)', () => {
    assert.equal(parseBrowserMode(null, chromiumNoProfile), 'launch');
  });

  test('null + firefox → launch (always persistent context for firefox)', () => {
    assert.equal(parseBrowserMode(null, firefoxCfg), 'launch');
  });

});

// ── parseDebugPort ────────────────────────────────────────────────────────────

describe('parseDebugPort', () => {

  test('parses a valid port string', () => {
    assert.equal(parseDebugPort('9333'), 9333);
  });

  test('returns 9222 when arg is null (default)', () => {
    assert.equal(parseDebugPort(null), 9222);
  });

  test('returns 9222 for non-numeric input', () => {
    assert.equal(parseDebugPort('banana'), 9222);
  });

});

// ── buildBrowserArgs ──────────────────────────────────────────────────────────

describe('buildBrowserArgs', () => {

  test('includes --remote-debugging-port with the given port', () => {
    const args = buildBrowserArgs(9222, '/path/to/profile');
    assert.ok(args.includes('--remote-debugging-port=9222'), 'should include debug port flag');
  });

  test('includes --user-data-dir with the profile path', () => {
    const args = buildBrowserArgs(9333, '/edge/user/profile');
    assert.ok(args.includes('--user-data-dir=/edge/user/profile'), 'should include profile path flag');
  });

  test('includes no-first-run and no-default-browser-check', () => {
    const args = buildBrowserArgs(9222, '/p');
    assert.ok(args.includes('--no-first-run'), 'should suppress first-run dialog');
    assert.ok(args.includes('--no-default-browser-check'), 'should suppress default browser check');
  });

});

// ── launchBrowserForMode — CDP connect failure ────────────────────────────────

describe('launchBrowserForMode — CDP connect failure', () => {

  // ensureBrowser is stubbed to a no-op (endpoint "already up") so these tests
  // exercise the connectOverCDP failure path WITHOUT auto-launching a real browser.
  const ensureUp = async () => ({ alreadyRunning: true, launched: false });

  test('throws with a message pointing to launch-debug-browser.mjs when connect fails', async () => {
    const mockPw = {
      chromium: {
        connectOverCDP: async () => { throw new Error('ECONNREFUSED'); },
      },
    };
    const cfg = { preferred: 'chromium', chromium: { profile_path: '/some/profile', executable_path: '' }, firefox: {} };

    await assert.rejects(
      () => launchBrowserForMode(mockPw, cfg, { browserMode: 'connect', debugPort: 9222, ensureBrowser: ensureUp }),
      (e) => /launch-debug-browser/.test(e.message),
    );
  });

  test('error message includes the debug port number', async () => {
    const mockPw = {
      chromium: {
        connectOverCDP: async () => { throw new Error('connection refused'); },
      },
    };
    const cfg = { preferred: 'chromium', chromium: { profile_path: '/profile', executable_path: '' }, firefox: {} };

    await assert.rejects(
      () => launchBrowserForMode(mockPw, cfg, { browserMode: 'connect', debugPort: 9999, ensureBrowser: ensureUp }),
      (e) => /9999/.test(e.message),
    );
  });

  test('auto-launches the debug browser before attaching, then connects', async () => {
    const calls = [];
    const mockPw = {
      chromium: {
        connectOverCDP: async () => {
          calls.push('connect');
          // Minimal CDP browser stub: no pre-existing contexts → helper creates one.
          return {
            contexts: () => [],
            newContext: async () => ({ id: 'ctx' }),
          };
        },
      },
    };
    const cfg = { preferred: 'chromium', chromium: { profile_path: '/some/profile', executable_path: '' }, firefox: {} };
    const ensureBrowser = async (port) => { calls.push(`ensure:${port}`); return { alreadyRunning: false, launched: true }; };

    const res = await launchBrowserForMode(mockPw, cfg, { browserMode: 'connect', debugPort: 9222, ensureBrowser });

    assert.deepEqual(calls, ['ensure:9222', 'connect'], 'ensureBrowser must run before connectOverCDP');
    assert.equal(res.isAttached, true, 'CDP attach must not be owned by us');
    assert.equal(res.contextWasCreatedByUs, true);
  });

  test('surfaces a clear error when auto-launch times out (browser never comes up)', async () => {
    const mockPw = { chromium: { connectOverCDP: async () => { throw new Error('should not reach here'); } } };
    const cfg = { preferred: 'chromium', chromium: { profile_path: '/some/profile', executable_path: '' }, firefox: {} };
    const ensureBrowser = async () => { throw new Error('did not become reachable on port 9222 within 30000ms'); };

    await assert.rejects(
      () => launchBrowserForMode(mockPw, cfg, { browserMode: 'connect', debugPort: 9222, ensureBrowser }),
      (e) => /auto-launch debug browser/.test(e.message) && /reachable/.test(e.message),
    );
  });

});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCdpEndpointUp,
  spawnDebugBrowserLauncher,
  ensureDebugBrowser,
  LAUNCHER_PATH,
} from '../scripts/ensure-debug-browser.mjs';

// Every test here MOCKS the port probe and the process spawn. No real browser is
// launched and no real network request is made — the "port up/down" signal is a fake.

// ── isCdpEndpointUp ───────────────────────────────────────────────────────────

describe('isCdpEndpointUp', () => {

  test('true when the endpoint answers 2xx', async () => {
    const fetchImpl = async (url) => {
      assert.match(url, /^http:\/\/localhost:9222\/json\/version$/);
      return { ok: true };
    };
    assert.equal(await isCdpEndpointUp(9222, { fetchImpl }), true);
  });

  test('false on non-OK status (port busy with something else)', async () => {
    const fetchImpl = async () => ({ ok: false });
    assert.equal(await isCdpEndpointUp(9222, { fetchImpl }), false);
  });

  test('false (never throws) when the connection is refused', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal(await isCdpEndpointUp(9222, { fetchImpl }), false);
  });

  test('targets the configured port', async () => {
    let seen;
    const fetchImpl = async (url) => { seen = url; return { ok: true }; };
    await isCdpEndpointUp(9333, { fetchImpl });
    assert.match(seen, /:9333\/json\/version$/);
  });

});

// ── spawnDebugBrowserLauncher ─────────────────────────────────────────────────

describe('spawnDebugBrowserLauncher', () => {

  test('spawns the existing launcher detached, with --port, and unrefs it', () => {
    const recorded = {};
    let unrefed = false;
    const spawnImpl = (cmd, args, opts) => {
      recorded.cmd = cmd; recorded.args = args; recorded.opts = opts;
      return { unref: () => { unrefed = true; } };
    };

    spawnDebugBrowserLauncher(9222, { spawnImpl, nodeExec: '/usr/bin/node' });

    assert.equal(recorded.cmd, '/usr/bin/node');
    assert.deepEqual(recorded.args, [LAUNCHER_PATH, '--port', '9222']);
    assert.equal(recorded.opts.detached, true, 'must detach so it outlives auto-submit');
    assert.equal(recorded.opts.stdio, 'ignore');
    assert.equal(unrefed, true, 'must unref so the parent event loop is not held open');
  });

});

// ── ensureDebugBrowser ────────────────────────────────────────────────────────

describe('ensureDebugBrowser', () => {

  test('no-op fast path when the browser is already up (no launch attempted)', async () => {
    let launched = false;
    const res = await ensureDebugBrowser(9222, {
      probe: async () => true,
      spawnLauncher: () => { launched = true; },
    });
    assert.deepEqual(res, { alreadyRunning: true, launched: false });
    assert.equal(launched, false, 'must not spawn a launcher when one is already listening');
  });

  test('launches once, then polls until the endpoint comes up', async () => {
    let launches = 0;
    let probes = 0;
    // Down for the first two polls, up on the third — simulates browser startup lag.
    const probe = async () => { probes++; return probes > 3; }; // first call (pre-check) + 2 polls false
    const res = await ensureDebugBrowser(9222, {
      probe,
      spawnLauncher: () => { launches++; },
      sleep: async () => {},          // no real waiting
      pollIntervalMs: 1,
      timeoutMs: 10000,
    });
    assert.equal(res.launched, true);
    assert.equal(res.alreadyRunning, false);
    assert.equal(launches, 1, 'must launch exactly once');
  });

  test('throws a clear error when the endpoint never comes up before timeout', async () => {
    let launches = 0;
    await assert.rejects(
      () => ensureDebugBrowser(9222, {
        probe: async () => false,     // always down
        spawnLauncher: () => { launches++; },
        sleep: async () => {},
        pollIntervalMs: 1,
        timeoutMs: 5,                 // tiny window → give up quickly
      }),
      (e) => /did not become reachable on port 9222/.test(e.message)
          && /launch-debug-browser\.mjs/.test(e.message),
    );
    assert.equal(launches, 1, 'should have attempted the launch once');
  });

  test('passes the requested port through to probe and launcher', async () => {
    const seen = { probe: null, launch: null };
    await ensureDebugBrowser(9333, {
      probe: async (p) => { seen.probe = p; return true; },
      spawnLauncher: (p) => { seen.launch = p; },
    });
    assert.equal(seen.probe, 9333);
    assert.equal(seen.launch, null, 'already up → launcher never called');
  });

});

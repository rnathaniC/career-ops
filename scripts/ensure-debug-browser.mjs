#!/usr/bin/env node
/**
 * ensure-debug-browser.mjs — Guarantee a CDP debug browser is up before attach
 *
 * auto-submit.mjs attaches to a Chrome/Edge remote-debugging endpoint (CDP) on
 * port 9222 via connectOverCDP. Historically that browser had to be started by
 * hand in a separate terminal (scripts/launch-debug-browser.mjs, "Terminal A"),
 * which never happens in the non-interactive 1am orchestrator (pulse-refresh.mjs)
 * — so the attach failed with "Could not connect to debug browser on port 9222."
 *
 * This helper closes that gap: probe the CDP endpoint, and if it's down, start the
 * SAME launcher as a detached background process, then poll until the endpoint
 * responds (or a timeout elapses). Because it reuses launch-debug-browser.mjs — which
 * reads the configured chromium.profile_path via loadBrowserConfig — the existing
 * logged-in session/auth is preserved; no fresh unauthenticated profile is spawned.
 *
 * Every side-effecting dependency (the port probe, the process spawn, the sleep) is
 * injectable so the logic can be unit-tested with fakes — no real browser is launched
 * and no real network is hit in tests. See test/ensure-debug-browser.test.mjs.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the interactive launcher this helper drives. */
export const LAUNCHER_PATH = path.join(__dirname, 'launch-debug-browser.mjs');

/**
 * Probe the CDP endpoint to see whether a debug browser is already listening.
 * Returns false (never throws) on refused connection, timeout, or non-OK status,
 * so callers can treat it as a plain up/down signal.
 *
 * @param {number} port                     Remote debugging port (e.g. 9222)
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [deps]
 * @returns {Promise<boolean>}              true iff /json/version answers 2xx
 */
export async function isCdpEndpointUp(port, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://localhost:${port}/json/version`, { signal: ac.signal });
    return Boolean(res && res.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start the debug browser by spawning the existing launcher as a DETACHED
 * background process, so it outlives auto-submit and keeps holding the browser
 * (extensions live) for the rest of the run — and for the non-interactive
 * orchestrator, with no human-open terminal required.
 *
 * The launcher itself resolves the profile from config/browser.yml, so the
 * authenticated session is reused. Exported for testing (spawnImpl is injectable).
 *
 * @param {number} port
 * @param {{ spawnImpl?: Function, launcherPath?: string, nodeExec?: string }} [deps]
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnDebugBrowserLauncher(port, {
  spawnImpl = spawn,
  launcherPath = LAUNCHER_PATH,
  nodeExec = process.execPath,
} = {}) {
  const child = spawnImpl(nodeExec, [launcherPath, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
  });
  // Don't keep auto-submit's event loop alive waiting on the launcher — it's a
  // background service now, not a child we manage.
  if (child && typeof child.unref === 'function') child.unref();
  return child;
}

/**
 * Ensure a CDP debug browser is reachable on `port`. No-op (fast) when one is
 * already up; otherwise auto-launches via the existing launcher and polls until
 * the endpoint answers or `timeoutMs` elapses.
 *
 * @param {number} port
 * @param {{
 *   probe?: Function, spawnLauncher?: Function,
 *   pollIntervalMs?: number, timeoutMs?: number,
 *   sleep?: Function, log?: Function,
 * }} [deps]
 * @returns {Promise<{ alreadyRunning: boolean, launched: boolean }>}
 * @throws {Error} if the endpoint never becomes reachable within the timeout
 */
export async function ensureDebugBrowser(port, {
  probe = isCdpEndpointUp,
  spawnLauncher = spawnDebugBrowserLauncher,
  pollIntervalMs = 500,
  timeoutMs = 30000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  if (await probe(port)) {
    return { alreadyRunning: true, launched: false };
  }

  log(`[ensure-debug-browser] No debug browser on port ${port} — auto-launching (reusing configured profile)...`);
  spawnLauncher(port);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if (await probe(port)) {
      log(`[ensure-debug-browser] Debug browser reachable on port ${port}.`);
      return { alreadyRunning: false, launched: true };
    }
  }

  throw new Error(
    `Debug browser did not become reachable on port ${port} within ${timeoutMs}ms.\n` +
    `  Auto-launch via scripts/launch-debug-browser.mjs did not come up in time.\n` +
    `  Manual fallback — run in a separate terminal: node scripts/launch-debug-browser.mjs`,
  );
}

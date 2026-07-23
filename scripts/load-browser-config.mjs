#!/usr/bin/env node
/**
 * load-browser-config.mjs — Loads and validates config/browser.yml
 *
 * Returns a safe default (chromium, extension autofill off) when the file is absent.
 * Validates that required paths exist on disk when preferred = firefox.
 * When chromium.executable_path is missing from disk, auto-detects Edge/Chrome.
 * BROWSER_PATH env var overrides the configured executable_path entirely.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'config', 'browser.yml');

export class BrowserConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserConfigError';
  }
}

const DEFAULT_CONFIG = {
  preferred: 'chromium',
  firefox: {},
  chromium: {},
  extension_autofill: false,
};

// Platform-specific install locations for a Chromium-based system browser.
// Windows (Rahil's primary machine) is probed first historically; macOS and Linux
// candidates added 2026-06-24 so the engine is browser-agnostic on any runner.
const CHROMIUM_CANDIDATES_BY_PLATFORM = {
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
};

// Back-compat export (Windows candidates) — some callers/tests import this name.
const CHROMIUM_CANDIDATES = CHROMIUM_CANDIDATES_BY_PLATFORM.win32;

/**
 * Last-resort fallback: Playwright's own bundled Chromium, so the engine can run
 * on a headless runner (CI / sandbox) with no system browser installed. Scans the
 * ms-playwright cache synchronously for a full chrome or chrome-headless-shell binary.
 * @returns {string|null}
 */
export function detectPlaywrightChromium() {
  const cacheRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'ms-playwright'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
  ].filter(Boolean);

  const binNames = process.platform === 'win32'
    ? ['chrome.exe', 'chrome-headless-shell.exe']
    : ['chrome', 'chrome-headless-shell', 'headless_shell'];

  for (const root of cacheRoots) {
    if (!fs.existsSync(root)) continue;
    let dirs;
    try { dirs = fs.readdirSync(root); } catch { continue; }
    // Prefer the full 'chromium-*' build over 'chromium_headless_shell-*'.
    dirs.sort((a, b) => (a.includes('headless') ? 1 : 0) - (b.includes('headless') ? 1 : 0));
    for (const d of dirs) {
      if (!/^chromium/i.test(d)) continue;
      const base = path.join(root, d);
      // Walk a couple of levels for the binary (paths differ per platform/version).
      const stack = [base];
      let hops = 0;
      while (stack.length && hops < 5000) {
        hops++;
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const full = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (binNames.includes(e.name) && fs.existsSync(full)) return full;
        }
      }
    }
  }
  return null;
}

/**
 * Probe common install locations, then the platform's PATH lookup, then fall back
 * to Playwright's bundled Chromium. Cross-platform as of 2026-06-24.
 * @returns {string|null} Absolute path to the executable, or null if none found.
 */
export function detectChromiumExe() {
  const candidates = CHROMIUM_CANDIDATES_BY_PLATFORM[process.platform] || CHROMIUM_CANDIDATES_BY_PLATFORM.linux;
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // PATH lookup: `where` on Windows, `which` elsewhere.
  const isWin = process.platform === 'win32';
  const lookup = isWin ? 'where' : 'which';
  const cmds = isWin
    ? ['msedge', 'chrome']
    : ['microsoft-edge', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const cmd of cmds) {
    try {
      const r = spawnSync(lookup, [cmd], { encoding: 'utf8', shell: false, timeout: 5000 });
      if (r.status === 0 && r.stdout?.trim()) {
        const line = r.stdout.trim().split('\n')[0].trim();
        if (line && fs.existsSync(line)) return line;
      }
    } catch { /* cmd not on PATH */ }
  }
  // Final fallback: Playwright's bundled Chromium (headless runners / sandbox).
  return detectPlaywrightChromium();
}

/**
 * Load and validate config/browser.yml.
 * If the file is absent, returns a safe default (chromium, no extension autofill).
 *
 * @param {string} [configPath]  Override path (useful in tests)
 * @returns {Promise<object>}    Validated config
 * @throws {BrowserConfigError}  If the file exists but has invalid/missing values
 */
export async function loadBrowserConfig(configPath = DEFAULT_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  let yaml;
  try {
    ({ default: yaml } = await import('js-yaml'));
  } catch {
    throw new BrowserConfigError('js-yaml not installed — run: npm install js-yaml');
  }

  let raw;
  try {
    raw = yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new BrowserConfigError(`browser.yml parse error: ${e.message}`);
  }

  if (!raw || typeof raw !== 'object') {
    throw new BrowserConfigError('browser.yml is empty or not a YAML object');
  }

  const preferred = raw.preferred || 'chromium';

  // extension_autofill defaults to true when preferred=firefox and not explicitly set
  const extension_autofill =
    raw.extension_autofill !== undefined
      ? Boolean(raw.extension_autofill)
      : preferred === 'firefox';

  const cfg = {
    preferred,
    firefox:  raw.firefox  || {},
    chromium: raw.chromium || {},
    extension_autofill,
  };

  if (cfg.preferred === 'chromium') {
    const envBrowserPath = (process.env.BROWSER_PATH || '').trim() || null;

    if (envBrowserPath) {
      // BROWSER_PATH env var takes absolute priority over config
      if (!fs.existsSync(envBrowserPath)) {
        throw new BrowserConfigError(`BROWSER_PATH not found on disk: ${envBrowserPath}`);
      }
      cfg.chromium.executable_path = envBrowserPath;
    } else {
      const exePath = cfg.chromium?.executable_path;
      if (exePath && !fs.existsSync(exePath)) {
        // Configured path missing — probe common locations + Playwright fallback before failing
        const detected = detectChromiumExe();
        if (detected) {
          console.warn(`[browser-config] ${exePath} not found — auto-detected: ${detected}`);
          cfg.chromium.executable_path = detected;
        } else {
          // No system browser found — clear the path so Playwright uses its bundled Chromium.
          // This is normal on headless cloud runners where the configured Windows path doesn't exist.
          console.warn(`[browser-config] ${exePath} not found and no system browser detected — using Playwright bundled Chromium`);
          cfg.chromium.executable_path = null;
        }
      } else if (!exePath) {
        // No path configured at all — try to detect one (incl. Playwright bundled).
        const detected = detectChromiumExe();
        if (detected) cfg.chromium.executable_path = detected;
      }
    }

    const profilePath = cfg.chromium?.profile_path;
    if (profilePath && !fs.existsSync(profilePath)) {
      // Profile path doesn't exist on this machine (e.g. Windows path on a Linux cloud runner).
      // Fall back to an ephemeral context rather than blocking the run.
      console.warn(`[browser-config] chromium.profile_path not found on disk: ${profilePath} — using ephemeral context`);
      cfg.chromium.profile_path = null;
    }
  }

  if (cfg.preferred === 'firefox') {
    const exePath = cfg.firefox.executable_path;
    if (!exePath) {
      throw new BrowserConfigError(
        'browser.yml: firefox.executable_path is required when preferred: firefox\n' +
        '  Run: node scripts/detect-firefox.mjs   to find the correct path',
      );
    }
    if (!fs.existsSync(exePath)) {
      throw new BrowserConfigError(
        `browser.yml: firefox.executable_path not found on disk: ${exePath}\n` +
        '  Run: node scripts/detect-firefox.mjs   to auto-detect the correct path',
      );
    }

    const profilePath = cfg.firefox.profile_path;
    if (!profilePath) {
      throw new BrowserConfigError(
        'browser.yml: firefox.profile_path is required when preferred: firefox\n' +
        '  Run: node scripts/detect-firefox.mjs   to find your profile directory',
      );
    }
    if (!fs.existsSync(profilePath)) {
      throw new BrowserConfigError(
        `browser.yml: firefox.profile_path not found on disk: ${profilePath}\n` +
        '  Run: node scripts/detect-firefox.mjs   to auto-detect your profile directory',
      );
    }
  }

  return cfg;
}

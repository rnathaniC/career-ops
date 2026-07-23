#!/usr/bin/env node
/**
 * export-auth-state.mjs — One-time auth session export for auto-submit
 *
 * Run this on Windows in PowerShell from the career-ops folder:
 *   node scripts/export-auth-state.mjs
 *
 * What it does:
 *   1. Opens a headed Chromium browser window
 *   2. Loads tabs for each ATS platform (Greenhouse, Lever, Ashby, LinkedIn)
 *   3. Waits for you to log in to each site manually
 *   4. Exports all cookies/sessions to data/auth-state.json
 *
 * The 1am auto-submit loads this file as its starting browser state — instant auth.
 * Re-run every 4-6 weeks when sessions expire (auto-submit will start returning
 * "unauthenticated" errors when that happens).
 *
 * Output: data/auth-state.json
 */

import path from 'node:path';
import fs   from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const OUT_PATH  = path.join(ROOT, 'data', 'auth-state.json');

// Workday excluded: each company runs its own Workday instance — no single login covers them all.
// LinkedIn excluded: not used for auto-apply, handled separately.
const ATS_URLS = [
  { name: 'Greenhouse',  url: 'https://boards.greenhouse.io/' },
  { name: 'Lever',       url: 'https://jobs.lever.co/' },
  { name: 'Ashby',       url: 'https://jobs.ashbyhq.com/' },
];

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function main() {
  console.log('\n[export-auth-state] Starting session export...\n');

  let pw;
  try {
    pw = await import('playwright');
  } catch {
    console.error('[export-auth-state] FATAL: Playwright not installed. Run: npx playwright install chromium');
    process.exit(1);
  }

  // Launch a headed browser so you can see and interact with the pages
  const browser = await pw.chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    viewport: null, // use window size
    ignoreHTTPSErrors: true, // allow login on sites that show cert warnings in fresh Chromium
  });

  console.log('[export-auth-state] Opening ATS sites in browser tabs...\n');

  // Open all ATS sites as separate tabs
  for (const { name, url } of ATS_URLS) {
    try {
      const page = await context.newPage();
      await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
      console.log(`  Opened: ${name} (${url})`);
    } catch {
      console.log(`  Skipped: ${name} (could not load)`);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ACTION REQUIRED:');
  console.log('');
  console.log('  In the browser that just opened, log in to each site:');
  console.log('  - Greenhouse (boards.greenhouse.io)');
  console.log('  - Lever (jobs.lever.co)');
  console.log('  - Ashby (jobs.ashbyhq.com)');
  console.log('');
  console.log('  Note: If a site shows a security warning, click "Advanced" then');
  console.log('  "Proceed to site" — this is safe, it is just Playwright Chromium');
  console.log('  not having your system root certificates installed.');
  console.log('');
  console.log('  If you are already logged in on a site, just verify the tab.');
  console.log('  When done with ALL sites, come back here and press Enter.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await prompt('  Press Enter when you are logged in to all sites...');

  console.log('\n[export-auth-state] Capturing session state...');

  // Export the full storage state (cookies + localStorage)
  const state = await context.storageState();

  // Filter to keep only the ATS domains we care about (drop ad/tracking noise)
  const keepDomains = [
    'greenhouse.io', 'lever.co', 'ashbyhq.com',
  ];

  state.cookies = state.cookies.filter((c) =>
    keepDomains.some((d) => (c.domain || '').includes(d)),
  );
  state.origins = (state.origins || []).filter((o) =>
    keepDomains.some((d) => (o.origin || '').includes(d)),
  );

  // Add metadata
  state._exported_at = new Date().toISOString();
  state._expires_hint = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString(); // ~5 weeks

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');

  const cookieCount = state.cookies.length;
  await browser.close();

  console.log(`\n[export-auth-state] Done. Saved ${cookieCount} cookies to:\n  ${OUT_PATH}`);
  console.log(`\n  Sessions valid until approximately: ${new Date(state._expires_hint).toLocaleDateString()}`);
  console.log('  Re-run this script when auto-submit starts returning auth errors (every ~5 weeks).\n');
}

main().catch((e) => {
  console.error('[export-auth-state] FATAL:', e.message);
  process.exit(1);
});

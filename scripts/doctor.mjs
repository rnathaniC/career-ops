#!/usr/bin/env node
// doctor.mjs — NUL-byte + JSON preflight (Kaizen K-2026-06-08-1, approved 2026-06-11)
// Run BEFORE any pipeline step. Exits non-zero on corruption with a one-line repair hint.
// Guards against risk r7 (OneDrive sync truncation/NUL-padding).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const root = process.argv[2] || '.';
const CRITICAL_JSON = ['package.json', 'data/last-refresh.json', 'data/sus-db.json',
  'data/blocked-jobs.json', 'data/bat-run-log.json', 'gen/states.json'];

let bad = [];
// Scan root + scripts/ + gen/ (2026-06-12: scripts moved off root; truncation hit scripts/codegen-states.mjs)
const dirs = [root, join(root, 'scripts'), join(root, 'gen')];
const mjs = [];
for (const d of dirs) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (f.endsWith('.mjs') || f.endsWith('.js')) mjs.push(join(d, f));
  }
}
for (const f of mjs) {
  const buf = readFileSync(f);
  if (buf.includes(0)) { bad.push(`${f}: ${buf.filter(b => b === 0).length} NUL bytes`); continue; }
  // 2026-06-12: NUL-free truncation (clean tail-cut) caught only by a real parse
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) bad.push(`${f}: syntax error (truncation?) — ${(r.stderr || '').split('\n').find(l => l.includes('Error')) || 'node --check failed'}`);
}
for (const rel of CRITICAL_JSON) {
  const p = join(root, rel);
  if (!existsSync(p)) continue;
  const buf = readFileSync(p);
  if (buf.includes(0)) { bad.push(`${rel}: NUL bytes`); continue; }
  try { JSON.parse(buf.toString('utf8')); } catch (e) { bad.push(`${rel}: invalid JSON (${e.message.slice(0, 60)})`); }
}
// K-2: Playwright Chromium auto-fix — detect missing binary and install before
// auto-submit attempts a browser launch. Checks the ms-playwright cache dir;
// if no chromium-* entry exists, installs it automatically (best-effort).
{
  const pwCacheDirs = ({
    win32:  [join(process.env.LOCALAPPDATA ?? homedir(), 'ms-playwright')],
    darwin: [join(homedir(), 'Library', 'Caches', 'ms-playwright')],
    linux:  [join(homedir(), '.cache', 'ms-playwright'), '/root/.cache/ms-playwright'],
  })[process.platform] ?? [];
  const chromiumPresent = pwCacheDirs.some(dir => {
    if (!existsSync(dir)) return false;
    try { return readdirSync(dir).some(e => e.startsWith('chromium')); } catch { return false; }
  });
  if (!chromiumPresent) {
    process.stdout.write('DOCTOR: Playwright Chromium not found — installing (K-2)…\n');
    const r = spawnSync('npx', ['playwright', 'install', 'chromium'],
      { cwd: root, shell: true, encoding: 'utf8', timeout: 120000, stdio: 'inherit' });
    if (r.status !== 0) {
      bad.push('playwright-chromium: binary missing; auto-install failed — run `npx playwright install chromium`');
    } else {
      process.stdout.write('DOCTOR: Playwright Chromium installed (K-2).\n');
    }
  }
}
if (bad.length) {
  console.error(`DOCTOR: ${bad.length} corrupted file(s) — run \`node scripts/fix-nul-bytes.mjs\` to repair:`);
  bad.forEach(b => console.error('  - ' + b));
  process.exit(1);
}
console.log(`DOCTOR: OK (${mjs.length} .mjs + critical JSON clean)`);

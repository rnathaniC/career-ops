#!/usr/bin/env node
/**
 * check-syntax.mjs — pre-deploy syntax gate for the Dispatch subsystem.
 *
 * THE STORY: before anything ships, every .mjs must at least *parse*. The
 * recurring truncation bug (files cut mid-write on sync) produces "Unexpected
 * end of input" at runtime — in the middle of the 6am job, too late. This gate
 * catches a truncated/half-written module BEFORE dispatch, not during.
 *
 * Uses `node --check` (parse only, no execution — safe, no side effects).
 *
 * Usage:
 *   node check-syntax.mjs                 # check all tracked .mjs (root + scripts/ + test/)
 *   node check-syntax.mjs --files a,b     # check a specific comma-separated list
 *   node check-syntax.mjs --json          # machine-readable result
 * Exit: 0 all parse · 1 one or more failed.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argVal = (f) => process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : null;
const JSON_OUT = process.argv.includes('--json');
const filesArg = argVal('--files');

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith('.mjs')) acc.push(p);
  }
  return acc;
}

const targets = filesArg
  ? filesArg.split(',').map((s) => s.trim()).filter(Boolean)
  : [...walk('.'), ...['scripts', 'test'].flatMap((d) => walk(d))]
      .filter((v, i, a) => a.indexOf(v) === i);

const failures = [];
for (const file of targets) {
  if (!existsSync(file)) { failures.push({ file, error: 'missing' }); continue; }
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) failures.push({ file, error: (r.stderr || '').split('\n')[0] || 'parse error' });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ checked: targets.length, failed: failures.length, failures }, null, 2));
} else {
  console.log(`[check-syntax] checked ${targets.length} .mjs file(s)`);
  if (failures.length === 0) console.log('[check-syntax] ✅ all parse cleanly');
  else { console.error(`[check-syntax] ❌ ${failures.length} failed:`); failures.forEach((f) => console.error(`  - ${f.file}: ${f.error}`)); }
}
process.exit(failures.length === 0 ? 0 : 1);

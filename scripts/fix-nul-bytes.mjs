#!/usr/bin/env node
// fix-nul-bytes.mjs — companion to doctor.mjs. Strips NUL bytes, backs up originals.
// K-2026-06-21: recursive sweep over all text extensions. Restored after v1.12.0
// dropped this script + the doctor NUL check; a git-checkout-through-mount corrupted
// 14 files across .github/ modes/ docs/ dashboard/ templates/ .claude/ in one update
// and the prior root-only/.mjs scan caught only package.json.
import { readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || '.';
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

// Keep EXTS in sync with doctor.mjs checkNoNullBytes().
const EXTS = ['.mjs', '.js', '.json', '.md', '.yml', '.yaml', '.html', '.go', '.tex'];
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const isBackup = (name) => name.includes('.bak') || name.includes('bak-null');

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const name = ent.name;
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && EXTS.some((e) => name.endsWith(e)) && !isBackup(name)) out.push(p);
  }
  return out;
}

let fixed = 0;
for (const p of walk(root)) {
  const buf = readFileSync(p);
  if (!buf.includes(0)) continue;
  copyFileSync(p, `${p}.bak-null-${stamp}`);
  writeFileSync(p, Buffer.from(buf.filter((b) => b !== 0)));
  fixed++; console.log(`fixed ${p} (backup ${p}.bak-null-${stamp})`);
}
console.log(fixed ? `Repaired ${fixed} file(s). Re-run doctor.mjs.` : 'Nothing to fix.');

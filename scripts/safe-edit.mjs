#!/usr/bin/env node
// safe-edit.mjs — Guardrail wrapper for editing large CRLF .mjs/.js files on OneDrive paths.
// Risk r7 / Kaizen K-2026-05-29-7. Confirmed live 2026-06-04: edits truncated AND OneDrive
// appended ~1KB of \x00 to a freshly written file. This wrapper defends against both.
//
// Usage:
//   node scripts/safe-edit.mjs <target> --apply-patch <patch>
//   node scripts/safe-edit.mjs <target> --check-only
//
// Deploy: copy to C:\Users\rahil\career-ops\scripts\safe-edit.mjs.

import { execSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, renameSync, existsSync,
  statSync, readdirSync, unlinkSync, copyFileSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node safe-edit.mjs <target> [--apply-patch <patch>] [--check-only]');
  process.exit(2);
}

const target = args[0];
const checkOnly = args.includes('--check-only');
const patchIdx = args.indexOf('--apply-patch');
const patchFile = patchIdx >= 0 ? args[patchIdx + 1] : null;

if (!existsSync(target)) {
  console.error('Target not found: ' + target);
  process.exit(2);
}

function isClean(file) {
  try {
    const out = execSync('git status --porcelain -- "' + file + '"', { encoding: 'utf8' });
    return out.trim() === '';
  } catch {
    return false;
  }
}

function stripTrailingNulls(path) {
  const buf = readFileSync(path);
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0x00) end--;
  if (end !== buf.length) {
    writeFileSync(path, buf.subarray(0, end));
    console.log('  healed ' + (buf.length - end) + ' trailing nulls');
  }
}

function lastLineLooksTruncated(path) {
  const txt = readFileSync(path, 'utf8');
  const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1].trimEnd();
  return !/[}\)\];,'"`]|\*\/|\/\/.*$/.test(last);
}

if (!checkOnly && !isClean(target)) {
  console.error('Refusing to edit: "' + target + '" has uncommitted changes.');
  process.exit(3);
}

const snapshot = join(tmpdir(), 'safe-edit-' + Date.now() + '-' + basename(target));
if (!checkOnly) copyFileSync(target, snapshot);

if (patchFile && !checkOnly) {
  if (!existsSync(patchFile)) {
    console.error('Patch not found: ' + patchFile);
    unlinkSync(snapshot);
    process.exit(2);
  }
  try {
    execSync('git apply --unsafe-paths --directory="' + dirname(target) + '" "' + patchFile + '"', {
      stdio: 'inherit',
    });
  } catch {
    console.error('Patch failed. Original untouched.');
    unlinkSync(snapshot);
    process.exit(4);
  }
}

const verifyTarget = checkOnly ? target : snapshot;
stripTrailingNulls(verifyTarget);

if (lastLineLooksTruncated(verifyTarget)) {
  console.error('Last line looks truncated. Aborting.');
  if (!checkOnly) unlinkSync(snapshot);
  process.exit(6);
}

try {
  execSync('node --check "' + verifyTarget + '"', { stdio: 'pipe' });
  console.log('syntax OK: ' + basename(verifyTarget));
} catch (e) {
  console.error('Syntax FAILED. Original untouched.');
  console.error((e.stderr && e.stderr.toString()) || e.message);
  if (!checkOnly) unlinkSync(snapshot);
  process.exit(5);
}

if (checkOnly) process.exit(0);

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const bak = target + '.last-safe-edit-' + ts + '.bak';
copyFileSync(target, bak);
renameSync(snapshot, target);
console.log('applied. backup: ' + basename(bak));

const dir = dirname(target);
const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
for (const f of readdirSync(dir)) {
  if (!f.includes('.last-safe-edit-')) continue;
  const fp = join(dir, f);
  try {
    if (statSync(fp).mtimeMs < cutoff) {
      unlinkSync(fp);
      console.log('  pruned ' + f);
    }
  } catch {}
}

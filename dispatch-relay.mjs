#!/usr/bin/env node
/**
 * dispatch-relay.mjs — the Dispatch subsystem's ship gate + audit trail.
 *
 * THE STORY: on 2026-05-30 a fix was "validated, stamped ready-to-deploy" and
 * then vanished — it was never committed, so the data moved to a new schema but
 * the code never shipped. The relay's whole job is to make that impossible:
 * it refuses to stamp a dispatch unless the named files actually EXIST, PARSE,
 * and are COMMITTED in git. "Validated" and "exists in history" become the same
 * thing. Every dispatch appends to data/deploy-log.json (the audit trail) and
 * updates data/dispatch-manifest.json (current shippable state).
 *
 * Commands:
 *   node dispatch-relay.mjs --status
 *       Print manifest summary + last deploy-log entries.
 *   node dispatch-relay.mjs --dispatch --files a.mjs,b.mjs --message "fix: ..."
 *       Gate (exist + node --check + git-committed) → stamp manifest + append log.
 *       Add --allow-staged to accept staged-but-uncommitted files.
 *       Add --dry-run to validate without writing.
 *
 * Exit: 0 ok · 1 gate failed / bad args.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const MANIFEST = 'data/dispatch-manifest.json';
const LOG = 'data/deploy-log.json';
const argVal = (f) => process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : null;
const has = (f) => process.argv.includes(f);

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });

function gitState(file) {
  // Returns 'committed' | 'staged' | 'dirty' | 'untracked'
  const tracked = git('ls-files', '--error-unmatch', file).status === 0;
  if (!tracked) return 'untracked';
  const staged = git('diff', '--cached', '--quiet', '--', file).status !== 0;
  const dirty = git('diff', '--quiet', '--', file).status !== 0;
  if (dirty) return 'dirty';
  if (staged) return 'staged';
  return 'committed';
}

function cmdStatus() {
  const manifest = readJson(MANIFEST, { version: 1, last_dispatch: null, pending: [], dispatched: [] });
  const log = readJson(LOG, { version: 1, entries: [] });
  console.log('── Dispatch status ──────────────────────────────');
  console.log(`last_dispatch : ${manifest.last_dispatch || '(none)'}`);
  console.log(`pending       : ${manifest.pending.length} file(s)`);
  manifest.pending.forEach((f) => console.log(`   • ${f}`));
  console.log(`deploy-log    : ${log.entries.length} entr(y/ies)`);
  log.entries.slice(-5).forEach((e) =>
    console.log(`   ${e.at} — ${e.result} — "${e.message}" (${(e.files || []).length} file(s))`));
  return 0;
}

function cmdDispatch() {
  const filesArg = argVal('--files');
  const message = argVal('--message') || '(no message)';
  const allowStaged = has('--allow-staged');
  const dryRun = has('--dry-run');
  if (!filesArg) { console.error('[dispatch] --files required (comma-separated)'); return 1; }
  const files = filesArg.split(',').map((s) => s.trim()).filter(Boolean);

  const problems = [];
  for (const f of files) {
    if (!existsSync(f)) { problems.push(`${f}: missing on disk`); continue; }
    if (f.endsWith('.mjs')) {
      const chk = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      if (chk.status !== 0) { problems.push(`${f}: syntax error (${(chk.stderr || '').split('\n')[0]})`); continue; }
    }
    const state = gitState(f);
    const ok = state === 'committed' || (allowStaged && state === 'staged');
    if (!ok) problems.push(`${f}: git state '${state}' — not shippable (commit it${allowStaged ? '' : ', or pass --allow-staged'})`);
  }

  if (problems.length) {
    console.error(`[dispatch] ❌ GATE FAILED — ${problems.length} blocker(s):`);
    problems.forEach((p) => console.error(`  - ${p}`));
    console.error('[dispatch] Nothing stamped. (This is the guard that stops "validated but vanished".)');
    return 1;
  }

  const entry = { at: new Date().toISOString(), result: dryRun ? 'dry-run-pass' : 'dispatched',
    message, files, gate: 'exist+parse+committed' };
  console.log(`[dispatch] ✅ gate passed for ${files.length} file(s)`);
  if (dryRun) { console.log('[dispatch] --dry-run: not writing manifest/log'); return 0; }

  const manifest = readJson(MANIFEST, { version: 1, last_dispatch: null, pending: [], dispatched: [] });
  manifest.last_dispatch = entry.at;
  manifest.dispatched = [...(manifest.dispatched || []), { at: entry.at, files, message }];
  manifest.pending = (manifest.pending || []).filter((f) => !files.includes(f));
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  const log = readJson(LOG, { version: 1, entries: [] });
  log.entries.push(entry);
  writeFileSync(LOG, JSON.stringify(log, null, 2));
  console.log(`[dispatch] stamped → ${MANIFEST} + ${LOG}`);
  return 0;
}

const code = has('--dispatch') ? cmdDispatch() : cmdStatus();
process.exit(code);

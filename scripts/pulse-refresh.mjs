#!/usr/bin/env node
/**
 * pulse-refresh.mjs — Job Pulse daily refresh orchestrator
 *
 * Runs every mechanically-automatable step of the 1am pipeline in sequence.
 * Steps that require LLM reasoning (WebSearch discovery, CL generation, Kanban
 * card injection, Airtable two-way sync decisions) are stubbed with TODOs and
 * skipped in the current phase.
 *
 * Invoke via:
 *   npm run pulse:refresh
 *
 * Exit codes (propagated from auto-submit.mjs where applicable):
 *   0 = pipeline completed cleanly
 *   1 = fatal abort (doctor red, safety lock failed, unrecoverable error)
 *   2 = partial: CAPTCHA-blocked or requires-human submissions
 *   3 = partial: form-blocked or dead-listing submissions
 *
 * DESIGN NOTE — Active Pipeline Lane branching (implemented 2026-06-15):
 * ─────────────────────────────────────────────────────────────────────
 * Standing automation law. The Active Pipeline has two intake lanes:
 *
 *   "New-Fresh"  No referral match. DoR = fully automate end to end with no
 *                human gate. auto-submit:live may run without confirmation.
 *
 *   "New-Hot"    Referral wired into Connection Name / LinkedIn URL /
 *                Has Connection / Warm Referral fields. DoR = human-in-the-loop.
 *                Hold for Rahil to review/send before ANY submission attempt.
 *                auto-submit MUST NOT run on New-Hot cards.
 *
 * AIRTABLE TWO-WAY SYNC (implemented 2026-06-16, risk r12 — see scripts/airtable-sync.mjs):
 * Step -0.5 pulls the live Active Pipeline from Airtable into a fresh
 * data/kanban-import-{date}.json (+ data/airtable-sync-state.json conflict baseline)
 * before doctor preflight, so every downstream step (lane-branch, ingest, auto-submit)
 * works off current data. Step 9 pushes local changes back at the end of the run,
 * skipping any card whose Airtable side also changed since the pull (Rahil's edit
 * wins) and never re-creating cards that moved to the Archive table. Both steps are
 * best-effort: a missing AIRTABLE_PAT or a failed call logs a warning and the
 * pipeline continues against whatever local data already exists — see Step -0.5 and
 * Step 9 below.
 *
 * STALENESS / AUTO-ARCHIVE (implemented 2026-06-16 — see scripts/archive-stale.mjs):
 * Step -0.4 runs right after the Airtable pull and archives New-Fresh cards older
 * than 33h and New-Hot cards older than 99h (move to Archive table, delete from
 * Active Pipeline), and tags any card that left New-Fresh/New-Hot for another lane
 * before its threshold fired with a `[flow:{from}→{to} {date}]` note. Best-effort,
 * same failure mode as the sync steps above.
 *
 * Flow (Step 4.6 below):
 *   1. `npm run referral-queue` reads the newest kanban-import, splits by isWarmReferral,
 *      prints a "REFERRAL QUEUE — review and send" block per New-Hot card, and writes
 *      data/referral-queue-{date}.json with { hot, hot_count, fresh_ids, fresh_count }.
 *   2. New-Hot cards are logged for Rahil; nothing is sent automatically.
 *   3. New-Fresh card IDs are passed to auto-submit:live via --card-ids (added to
 *      auto-submit.mjs as a defense-in-depth allowlist — auto-submit's own isEligible()
 *      already excludes isWarmReferral cards independently, so this is belt-and-suspenders).
 *   4. If referral-queue fails to run, or comes back with zero New-Fresh IDs, Step 5 is
 *      SKIPPED rather than falling back to an unfiltered auto-submit:live run — see Step 5.
 *
 * KNOWN GAP: fresh_ids come from kanban-import card IDs. auto-submit.mjs's own card
 * source is dashboard/job-pulse-kanban.html (or --kanban-json), populated by the K2
 * dashboard app's browser-side state, not by this orchestrator (TODO(Kanban-Inject) is
 * still unimplemented). Until that bridge exists, --card-ids will often filter down to
 * 0 matches against whatever auto-submit actually sees — which is the safe failure mode
 * (Step 5 is skipped, nothing is submitted), not a silent bypass.
 * ─────────────────────────────────────────────────────────────────────
 */

import { spawn, spawnSync }  from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url); // for best-effort sync requires in preflight
const ROOT      = resolve(__dirname, '..');
const DATA      = join(ROOT, 'data');
const LOGS      = join(ROOT, 'logs');

// ─── log file setup ──────────────────────────────────────────────────────────

const date    = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
mkdirSync(LOGS, { recursive: true });
const logPath = join(LOGS, `pulse-refresh-${date}.log`);
appendFileSync(logPath, `[${new Date().toISOString()}] [startup] STARTED\n`);

function ts() { return new Date().toTimeString().slice(0, 8); } // HH:MM:SS

function appendLog(step, text) {
  let out = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) out += `[${ts()}] [${step}] ${line}\n`;
  }
  if (out) appendFileSync(logPath, out);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[pulse-refresh] ${msg}`;
  console.log(line);
  appendLog('orchestrator', line);
}
function warn(msg) {
  const line = `[pulse-refresh] WARN  ${msg}`;
  console.warn(line);
  appendLog('orchestrator', line);
}
function abort(msg, code = 1) {
  const line = `[pulse-refresh] FATAL ${msg}`;
  console.error(line);
  appendLog('orchestrator', line);
  process.exit(code);
}

/**
 * Spawn cmd+args, tee stdout/stderr to both console and the log file in real
 * time, then resolve with { ok, stdout, stderr, status }.
 */
function teeSpawn(cmd, args, { cwd = ROOT, shell = true, step = cmd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell, stdio: ['inherit', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      const text = chunk.toString();
      stdout += text;
      appendLog(step, text);
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      const text = chunk.toString();
      stderr += text;
      appendLog(step, text);
    });

    child.on('close', (status) => {
      resolve({ ok: status === 0, stdout, stderr, status });
    });
  });
}

/**
 * Run an npm script and return { ok, stdout, stderr, status }.
 * All output is teed to both the console and the log file.
 * Pass capture:true when stdout must be parsed by the caller (uses spawnSync
 * internally but still emits captured output to console + log after completion).
 */
async function npm(script, { capture = false, args = [], step } = {}) {
  log(`→ npm run ${script}${args.length ? ' ' + args.join(' ') : ''}`);
  const stepTag = step ?? script;

  if (capture) {
    const result = spawnSync(
      'npm',
      ['run', script, ...(args.length ? ['--', ...args] : [])],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true }
    );
    const stdout = result.stdout?.toString() ?? '';
    const stderr = result.stderr?.toString() ?? '';
    if (stdout) { process.stdout.write(stdout); appendLog(stepTag, stdout); }
    if (stderr) { process.stderr.write(stderr); appendLog(stepTag, stderr); }
    const ok = result.status === 0;
    if (!ok) warn(`npm run ${script} exited ${result.status ?? 'null'}`);
    return { ok, stdout, stderr, status: result.status };
  }

  const result = await teeSpawn(
    'npm',
    ['run', script, ...(args.length ? ['--', ...args] : [])],
    { step: stepTag }
  );
  if (!result.ok) warn(`npm run ${script} exited ${result.status ?? 'null'}`);
  return result;
}

/**
 * Windows-hardened step runner: spawns `node` DIRECTLY on a repo script instead
 * of going through `npm run`. The npm -> cmd.exe -> npm.cmd -> node chain
 * intermittently aborts on Windows with exit 3221226505 (0xC0000409,
 * STATUS_STACK_BUFFER_OVERRUN), which surfaced as a spurious "Airtable pull
 * failed" even though the pull itself is healthy (it PULLed fine in isolation).
 * Direct `node script.mjs` spawns — already used for write-refresh-status and
 * airtable-map without issue — do not hit that abort, so the Airtable sync steps
 * use this path. Same { ok, stdout, stderr, status } shape as npm().
 */
async function nodeScript(relScript, scriptArgs = [], { step } = {}) {
  const stepTag = step ?? relScript;
  const localPath = join(...relScript.split('/'));
  log(`→ node ${relScript}${scriptArgs.length ? ' ' + scriptArgs.join(' ') : ''}`);
  const result = await teeSpawn('node', [localPath, ...scriptArgs], { step: stepTag });
  if (!result.ok) warn(`node ${relScript} exited ${result.status ?? 'null'}`);
  return result;
}

/**
 * Persist run state to data/last-refresh.json via the atomic writer
 * (scripts/write-refresh-status.mjs). Maps the orchestrator summary into the
 * board's known shape and pipes it on stdin. Best-effort: never throws.
 */
function writeRefreshStatus(summary) {
  const payload = {
    mode: summary.autosubmit?.mode ?? 'full',
    doctor: summary.doctor,
    primary_scan:  { exit: summary.primary_scan?.exit  ?? null },
    workday_scan:  { exit: summary.workday_scan?.exit  ?? null },
    worker_grader: summary.worker_grader ?? null,
    ashby_scan:    summary.ashby_scan    ?? null,
    kanban_inject: summary.kanban_inject ?? null,
    ingest:        summary.ingest        ?? null,
    lane_branch:   summary.lane_branch   ?? null,
    archive_stale: summary.archive_stale ?? null,
    cover_letters: summary.cover_letters ?? 0,
    cadence: summary.cadence ?? null,
    autosubmit: {
      attempted: summary.autosubmit?.skipped ? 0 : (summary.autosubmit?.attempted ?? 0),
      result: summary.autosubmit?.result ?? (summary.autosubmit?.skipped ? 'skipped' : null),
      exit: summary.autosubmit?.exit ?? null,
    },
    notes: summary.notes ?? [],
  };
  const res = spawnSync(
    'node',
    [join('scripts', 'write-refresh-status.mjs')],
    { cwd: ROOT, shell: true, input: JSON.stringify(payload), stdio: ['pipe', 'inherit', 'inherit'] }
  );
  if (res.status !== 0) warn(`write-refresh-status.mjs exited ${res.status}`);
}

// ─── pipeline state ─────────────────────────────────────────────────────────

const summary = {
  orchestrator:  'pulse-refresh.mjs',
  date,
  doctor:        null,   // 'ok' | 'fixed' | 'aborted'
  workday_scan:  { attempted: true, skipped: false, exit: null },
  primary_scan:  { exit: null },
  worker_grader: { exit: null, skipped: false },
  ashby_scan:    { exit: null, skipped: false },
  kanban_inject: { exit: null, skipped: false, injected: null },
  ingest:        { exit: null },
  lane_branch:   { exit: null, hot_count: null, fresh_count: null },
  autosubmit:    { exit: null, mode: 'live', skipped: false },
  airtable_sync: { pull: { exit: null, skipped: false }, push: { exit: null, skipped: false } },
  archive_stale: { exit: null, skipped: false, archived: null, tagged_flow: null },
  cover_letters: 0,
  cadence:       { gap_count: null, missing: [], silent_misses: [] },
  notes:         [],
};

// ─── main pipeline (async for tee streaming) ────────────────────────────────

(async () => {

// ─── Step -0.55 — Sync connections from Airtable ─────────────────────────────
// Pulls the "Connections" Airtable table into config/linkedin-connections.json
// so kanban-inject (Step 3.5) has the freshest warm-referral data for lane
// routing (New-Hot vs New-Fresh). Best-effort: missing PAT, table not yet
// seeded, or any network error warns and continues with the cached file.

log('Step -0.55 — Sync connections (sync-connections.mjs)');
const connSync = await npm('connections:sync', { step: 'step-0.55' });
if (!connSync.ok) {
  warn(`Connections sync exited ${connSync.status} — using cached config/linkedin-connections.json`);
  summary.notes.push(`Connections sync non-zero exit (${connSync.status}) — run "node scripts/seed-connections.mjs" if the Connections table does not exist yet.`);
}

// ─── Step -0.5 — Airtable pull ───────────────────────────────────────────────
// Pulls the live Active Pipeline into a fresh data/kanban-import-{date}.json
// (+ data/airtable-sync-state.json conflict baseline) before anything else
// reads local data, so lane-branch/ingest/auto-submit work off current state.
// Best-effort: missing AIRTABLE_PAT or a failed call warns and continues
// against whatever kanban-import file already exists locally.

log('Step -0.5 — Airtable pull (airtable-sync.mjs --pull)');
const airtablePull = await nodeScript('scripts/airtable-sync.mjs', ['--pull'], { step: 'step-0.5' });
summary.airtable_sync.pull.exit = airtablePull.status;
if (!airtablePull.ok) {
  warn(`Airtable pull exited ${airtablePull.status} — continuing against existing local data`);
  summary.airtable_sync.pull.skipped = true;
  summary.notes.push(`Airtable pull non-zero exit (${airtablePull.status}) — see AIRTABLE_PAT setup in .env.example if this is new.`);
}

// ─── Step -0.45 — Scan card flags (#OFF / #GOOD comment codes) ───────────────
// Runs right AFTER the Airtable pull (-0.5) so it scans the freshest mirror of
// the Active Pipeline. Reads every card's Airtable COMMENTS, parses Rahil's
// #OFF / #GOOD code words into data/card-flags-{date}.json (tuning signal), and
// files each NEW #OFF onto the Bug Triage board (deduped). Best-effort: a missing
// AIRTABLE_PAT prints SKIPPED and exits 0, and any error degrades loudly without
// crashing the run. Windows-hardened: direct node spawn, not `npm run` (npm.cmd
// intermittently aborts with 3221226505 / 0xC0000409 — same fix as the other
// Airtable steps).
log('Step -0.45 — Scan card flags (scan-card-flags.mjs)');
const cardFlags = await nodeScript('scripts/scan-card-flags.mjs', [], { step: 'step-0.45' });
summary.card_flags = { exit: cardFlags.status };
{
  const m = (cardFlags.stdout || '').match(/(\d+)\s+flag\(s\):\s*#OFF\s+(\d+).*?#GOOD\s+(\d+)/i);
  if (m) {
    summary.card_flags.total = Number(m[1]);
    summary.card_flags.off = Number(m[2]);
    summary.card_flags.good = Number(m[3]);
    if (summary.card_flags.total > 0) {
      summary.notes.push(`Card flags: Rahil flagged ${summary.card_flags.total} card(s) (#OFF ${summary.card_flags.off}, #GOOD ${summary.card_flags.good}).`);
    }
  }
  const filed = (cardFlags.stdout || '').match(/filed (\d+) new #OFF flag\(s\) to Bug Triage/i);
  if (filed && Number(filed[1]) > 0) {
    summary.notes.push(`Card flags: filed ${filed[1]} new #OFF flag(s) to Bug Triage.`);
  }
}
if (!cardFlags.ok) {
  warn(`Scan card flags exited ${cardFlags.status} — continuing (best-effort)`);
  summary.notes.push(`Scan card flags non-zero exit (${cardFlags.status}).`);
}

// ─── Step -0.4 — Archive stale Active Pipeline cards ────────────────────────
// Runs right after the Airtable pull (-0.5) so today's freshest kanban-import
// snapshot is on disk for flow-transition diffing, and right before doctor
// preflight (-1) so stale New-Fresh/New-Hot cards are cleared out of Active
// Pipeline before anything downstream (lane-branch, ingest, auto-submit) sees
// them. --apply mode: actually archives + writes flow tags, not just a report.
// Best-effort: missing AIRTABLE_PAT or a failed run logs a warning and the
// pipeline continues — see scripts/archive-stale.mjs for the full contract.

log('Step -0.4 — Archive stale cards (archive-stale.mjs --apply)');
// Windows-hardened: direct node spawn, not `npm run` (npm.cmd intermittently
// aborts with 3221226505 / 0xC0000409 — hit this step on 2026-08-12). Same fix
// as the Airtable and auto-submit steps.
const archiveStale = await nodeScript('scripts/archive-stale.mjs', ['--apply'], { step: 'step-0.4' });
summary.archive_stale.exit = archiveStale.status;
if (!archiveStale.ok) {
  warn(`Archive-stale exited ${archiveStale.status} — continuing without archiving this run`);
  summary.archive_stale.skipped = true;
  summary.notes.push(`Archive-stale non-zero exit (${archiveStale.status}) — see AIRTABLE_PAT setup in .env.example if this is new.`);
} else {
  const archivedMatch = archiveStale.stdout.match(/archived (\d+), tagged (\d+) flow transition/);
  if (archivedMatch) {
    summary.archive_stale.archived = Number(archivedMatch[1]);
    summary.archive_stale.tagged_flow = Number(archivedMatch[2]);
    log(`Archive-stale: archived ${summary.archive_stale.archived}, tagged ${summary.archive_stale.tagged_flow} flow transition(s)`);
  }
  // stdout already flushed to console + log by npm(capture:true) above
}

// ─── Step -1.1 — Self-healing browser preflight (Kaizen K-0626-1) ─────────────
// Every cold sandbox boots WITHOUT a launchable Chromium and (on Linux) missing
// libXdamage.so.1 — which red-lights doctor and fatal-halts the whole run. This
// repairs both, best-effort, BEFORE doctor so the 1am run heals itself instead of
// dying. Runs inline (not a child) so LD_LIBRARY_PATH propagates to later spawns.
function preflightBrowser() {
  const note = (m) => { log(`Step -1.1 — preflight: ${m}`); };
  // 1) Ensure a launchable Chromium exists (system Edge/Chrome OR Playwright's bundled build).
  let chromiumOk = false;
  try {
    const { detectChromiumExe, detectPlaywrightChromium } = require('./load-browser-config.mjs');
    chromiumOk = Boolean(detectChromiumExe?.() || detectPlaywrightChromium?.());
  } catch { /* fall through to install attempt */ }
  if (!chromiumOk) {
    note('no Chromium found — installing Playwright Chromium (best-effort)…');
    let r = spawnSync('npx', ['playwright', 'install', 'chromium'], { cwd: ROOT, shell: true, encoding: 'utf8' });
    chromiumOk = r.status === 0;
    note(chromiumOk ? 'Chromium installed.' : `Chromium install exit ${r.status} — doctor will gate if still missing.`);
  } else {
    note('Chromium present.');
  }
  // 2) On Linux, make sure libXdamage.so.1 is resolvable; if not, locate a copy and
  //    prepend its dir to LD_LIBRARY_PATH for every child spawned after this point.
  if (process.platform === 'linux') {
    const haveLib = (() => {
      const r = spawnSync('sh', ['-c', 'ldconfig -p 2>/dev/null | grep -q libXdamage.so.1'], { encoding: 'utf8' });
      return r.status === 0;
    })();
    if (haveLib) {
      note('libXdamage.so.1 already resolvable.');
    } else {
      const cacheDir = join(DATA, '.preflight-libs');
      // Search existing locations first, then a prior preflight cache, then fetch.
      let found = spawnSync('sh', ['-c',
        `find "$HOME/.cache/ms-playwright" /usr/lib /usr/lib/x86_64-linux-gnu "${cacheDir}" -name "libXdamage.so.1*" 2>/dev/null | head -1`
      ], { encoding: 'utf8' }).stdout.trim();
      if (!found) {
        // Proven non-root workaround (tested 2026-06-26): apt-get download the .deb and
        // extract it into a cache dir — no root, no apt install, survives within the run.
        note('libXdamage.so.1 missing — fetching via non-root apt-get download…');
        const fetch = spawnSync('sh', ['-c',
          `set -e; mkdir -p "${cacheDir}"; cd "${cacheDir}"; ` +
          `apt-get download libxdamage1 >/dev/null 2>&1 || true; ` +
          `for d in *.deb; do [ -f "$d" ] && dpkg-deb -x "$d" . 2>/dev/null || true; done; ` +
          `find . -name "libXdamage.so.1*" 2>/dev/null | head -1`
        ], { encoding: 'utf8' });
        found = (fetch.stdout || '').trim();
      }
      if (found) {
        const dir = dirname(found);
        const cur = process.env.LD_LIBRARY_PATH || '';
        if (!cur.split(':').includes(dir)) {
          process.env.LD_LIBRARY_PATH = dir + (cur ? ':' + cur : '');
        }
        note(`libXdamage.so.1 ready — added ${dir} to LD_LIBRARY_PATH for this run.`);
      } else {
        note('libXdamage.so.1 unavailable (offline?) — doctor will gate if a headed browser is needed.');
      }
    }
  }
}
try { preflightBrowser(); } catch (e) { warn(`Step -1.1 preflight threw (non-fatal): ${e.message}`); }

// ─── Step -1 — Doctor preflight ─────────────────────────────────────────────

log('Step -1 — Doctor preflight');
const doctorResult = await npm('doctor', { step: 'step-1' });
if (!doctorResult.ok) {
  log('Doctor reported issues — attempting fix-nul then re-run…');
  await npm('fix-nul', { step: 'step-1-fix' });
  const retry = await npm('doctor', { step: 'step-1-retry' });
  if (!retry.ok) {
    summary.doctor = 'aborted';
    // Write what we have before hard exit so the caller can see the state.
    writeRefreshStatus(summary);
    abort('Doctor still red after fix-nul. Pipeline halted.', 1);
  }
  summary.doctor = 'fixed';
} else {
  summary.doctor = 'ok';
}

// ─── Step -0.9 — Cadence watchdog (K-2026-06-21-3) ───────────────────────────
// Flags days in the last week with no run log, so silent misses (6/16, 6/20)
// surface in the 8am report instead of rotting unnoticed. Never blocks the run.
log('Step -0.9 — Cadence watchdog (cadence-watchdog.mjs)');
const cadence = await npm('cadence', { capture: true, step: 'step-0.9' });
try {
  const cs = JSON.parse(readFileSync(join(DATA, 'cadence-status.json'), 'utf8'));
  summary.cadence.gap_count     = cs.gap_count     ?? null;
  summary.cadence.missing       = cs.missing       ?? [];
  summary.cadence.silent_misses = cs.silent_misses ?? [];
  const silent = cs.silent_misses ?? [];
  if (silent.length > 0) {
    // The worst kind: a marker exists but the pipeline produced no fresh data.
    summary.notes.push(`Cadence watchdog: ${silent.length} SILENT miss(es) [marker present but last-refresh never advanced] — ${silent.join(', ')}. The 1 AM task may be firing cadence-mark WITHOUT running the real pipeline. Investigate now.`);
  }
  if ((cs.missing?.length ?? 0) > 0) {
    summary.notes.push(`Cadence watchdog: ${cs.missing.length} missed run(s) [no log] in last ${cs.window_days}d — ${cs.missing.join(', ')}. Investigate the scheduler (last genuine run ${cs.last_run}).`);
  }
} catch (e) {
  warn(`Cadence watchdog output unreadable: ${e.message}`);
}

// ─── Step 0 — SuS resolution ─────────────────────────────────────────────────
// TODO(SuS-Auto): Read data/sus-db.json and for each unresolved company call
//   node scripts/auto-submit.mjs --confirm "[company]"
//   (No npm target yet; add auto-submit:confirm in next Kaizen per SKILL.md note.)
//   For now: log a reminder and continue — SuS remains a manual step.
const susDb = join(DATA, 'sus-db.json');
if (existsSync(susDb)) {
  log('Step 0 — SuS: db exists — TODO auto-resolve (see SuS-Auto TODO above)');
  summary.notes.push('SuS resolution is manual this phase; see TODO(SuS-Auto).');
} else {
  log('Step 0 — SuS: no sus-db.json found, skipping');
}

// ─── Step 0.5 — Workday scrape ───────────────────────────────────────────────

log('Step 0.5 — Workday scrape');
const workday = await npm('workday', { args: ['--hours', '8', '--output', `data/workday-jobs.json`], step: 'step-0.5-workday' });
summary.workday_scan.exit = workday.status;
if (!workday.ok) {
  warn('Workday scraper unavailable or errored — continuing (B6 documented)');
  summary.workday_scan.skipped = true;
  summary.notes.push(`Workday exited ${workday.status} — B6 may apply.`);
}
// NOTE: Workday jobs with hasConnection:true → referral lane (New-Hot).
// The TODO(Lane-Branch) design above handles routing of these cards.

// ─── Step 0.75 — Primary ATS scan ───────────────────────────────────────────

log('Step 0.75 — Primary ATS scan (scan.mjs)');
const scan = await npm('scan', { step: 'step-0.75' });
summary.primary_scan.exit = scan.status;
if (!scan.ok) {
  warn(`Primary scan exited ${scan.status} — pipeline continues with whatever was injected`);
  summary.notes.push(`Primary scan non-zero exit (${scan.status}).`);
}

// ─── Step 1.5 — Worker grader: grade scan output for Airtable injection ──────
// Reads the entries scan.mjs just added to data/scan-history.tsv, scores each
// title against the keyword list in config/sources.yml, and writes
// data/graded-jobs-{date}.json (A/B/C/D). Grade D entries are excluded from
// the inject step below. Best-effort: empty or missing scan output exits 0.

log('Step 1.5 — Worker grader (worker-grader.mjs)');
const workerGrader = await npm('worker-grader', { step: 'step-1.5' });
summary.worker_grader.exit = workerGrader.status;
if (!workerGrader.ok) {
  warn(`Worker grader exited ${workerGrader.status} — no graded-jobs file written; kanban-inject will skip`);
  summary.worker_grader.skipped = true;
  summary.notes.push(`Worker grader non-zero exit (${workerGrader.status}) — scan output may be empty or portals.yml missing.`);
}

// ─── Step 1.55 — Indeed shortlink resolution (K-0810-3) ─────────────────────
// Indeed's search_jobs hands back click-tracking shortlinks (to.indeed.com/xxxx),
// not employer URLs. Everything downstream routes off the ATS detected from the
// URL — detectATS → fillForm → getAtsSubmitSelectors — so an unresolved Indeed
// card routes as "unknown" and falls to fillGenericForm, the same path that
// produced the B-16 empty-form click. Resolve BEFORE inject so Indeed-sourced
// jobs land in the existing lanes with the existing fillers, correctly routed.
//
// No-op when the graded set contains no Indeed links (the case until K-0810-2
// makes Indeed a scan source), and an unresolvable link leaves its card fully
// untouched rather than mis-routing it.
log('Step 1.55 — Indeed shortlink resolution (indeed-resolve.mjs)');
const indeedResolve = await npm('indeed:resolve', { step: 'step-1.55' });
if (!indeedResolve.ok) {
  warn(`Indeed resolve exited ${indeedResolve.status} — cards left unrouted; pipeline continues`);
  summary.notes.push(`Indeed shortlink resolution non-zero exit (${indeedResolve.status}) — URLs unmodified.`);
}

// ─── Step 1.6 — Indeed employer-signal enrichment (K-0810-1) ─────────────────
// Folds Indeed's review/rating/salary-band data into the freshly graded cards
// BEFORE they reach inject + readiness, so a poor-fit employer is downgraded out
// of auto-submit eligibility instead of being auto-filled and discovered later.
//
// Runs OFFLINE against data/indeed-company-cache.json. The cache is populated by
// the agent in-session (`node scripts/indeed-enrich.mjs --scan` lists what is
// missing; the agent fetches each via the Indeed MCP get_company_data and merges).
// A cold or stale cache is NOT an error — every unknown employer keeps its grade,
// so the nightly pipeline never blocks on the agent having run.
log('Step 1.6 — Indeed employer signal (indeed-enrich.mjs)');
const indeedEnrich = await npm('indeed:enrich', { step: 'step-1.6' });
if (!indeedEnrich.ok) {
  warn(`Indeed enrich exited ${indeedEnrich.status} — grades left as-is; pipeline continues`);
  summary.notes.push(`Indeed employer-signal enrichment non-zero exit (${indeedEnrich.status}) — grades unmodified.`);
}

// ─── Step 0.9 — Ashby scan — RETIRED 2026-08-16 (K-0816-2, approved by Rahil) ─
// This step called `npm run scan` with NO arguments — byte-identical to the
// Step 0.75 invocation above. scan.mjs already auto-detects Ashby via
// jobs.ashbyhq.com in careers_url during that first pass, so the second call
// re-hit all 66 companies (~90s), re-fetched ~8,400 postings, and yielded
// exactly 0 net-new every time because scan-history.tsv deduplicates.
//
// It was not free: 90s of pure duplicate work is what pushed the monolith past
// the host's process time budget on 2026-08-16, forcing the rest of the run to
// be executed step-wise. Removing it is the whole fix — Ashby coverage is
// unchanged because it never depended on this call.
//
// If Ashby ever needs a genuinely separate pass, give it a real filter
// (e.g. `npm run scan -- --platform ashby`) rather than restoring a bare
// duplicate.
log('Step 0.9 — Ashby scan: RETIRED (K-0816-2) — Step 0.75 already covers Ashby; duplicate pass removed');
summary.ashby_scan.exit = 0;
summary.ashby_scan.skipped = true;
summary.ashby_scan.retired = true;
summary.notes.push('Ashby scan step retired 2026-08-16 (K-0816-2): it duplicated Step 0.75 exactly and returned 0 net-new. Ashby coverage unchanged.');

// ─── Steps 1–1.5 — WebSearch secondary scan + URL verification ───────────────
// TODO(WebSearch-Secondary): Issue 6 high-precision queries for Scrum Master /
//   Agile Coach / TPM / Program Manager (Dallas or Remote, $130K+, last 24h)
//   on greenhouse.io / lever.co / ashbyhq.com / linkedin.com/jobs / indeed.com.
//   Skip companies already in sources/portals. Verify each URL via ATS API before
//   injecting. Log dead URLs to data/dead-url-history.json.
//   Requires: LLM reasoning + Playwright/fetch. Implement as a separate script
//   after Worker-Grader, sharing the same grade-jobs.mjs pipeline.
log('Steps 1–1.5 — WebSearch secondary scan: TODO(WebSearch-Secondary) — skipped this phase');
summary.notes.push('WebSearch secondary scan not yet implemented in orchestrator (TODO WebSearch-Secondary).');

// ─── Step 3.5 — Kanban inject: create Airtable records from graded scan ───────
// Reads the newest data/graded-jobs-*.json (written by Step 1.5), deduplicates
// against existing kanban-import cards + prior inject runs, and POSTs grade A/B/C
// jobs as new Active Pipeline records in Airtable (Lane = New-Fresh). Also appends
// the new cards to the local kanban-import file so Step 4.5 (ingest-runner) picks
// them up in the same pipeline run without waiting for the next pull.
// Best-effort: missing AIRTABLE_PAT or a failed POST warns and the pipeline continues.

log('Step 3.5 — Kanban inject (kanban-inject.mjs)');
const kanbanInject = await npm('kanban:inject:apply', { capture: true, step: 'step-3.5' });
summary.kanban_inject.exit = kanbanInject.status;
if (!kanbanInject.ok) {
  warn(`Kanban inject exited ${kanbanInject.status} — new scan cards not pushed to Airtable this run`);
  summary.kanban_inject.skipped = true;
  summary.notes.push(`Kanban inject non-zero exit (${kanbanInject.status}) — check AIRTABLE_PAT and graded-jobs file.`);
} else {
  const injectedMatch = kanbanInject.stdout.match(/injected=(\d+)/);
  if (injectedMatch) {
    summary.kanban_inject.injected = Number(injectedMatch[1]);
    if (summary.kanban_inject.injected > 0) {
      summary.notes.push(`Kanban inject: ${summary.kanban_inject.injected} new card(s) created in Airtable Active Pipeline.`);
    }
  }
}

// ─── Steps 2–4 — Cover Letter generation ─────────────────────────────────────
// TODO(CL-Gen): For confirmed non-referral A/B cards with no existing CL in output/,
//   generate a 249-word cover letter using the proof points in _profile.md and
//   article-digest.md. Save to output/cl_[company-slug]_[role-slug]_[date].txt.
//   Requires LLM reasoning. Share output path format with auto-submit:live.
log('Steps 2–4 — CL generation: TODO(CL-Gen) — skipped this phase');
summary.notes.push('CL generation not yet in orchestrator (TODO CL-Gen).');

// ─── Step 4.4 — Board-state export (R1 fix: localStorage funnel bridge) ──────
// Reconstructs data/board-state.json (sandbox-READABLE) from the newest
// kanban-import, overlaid with applications.md so already-actioned jobs are
// excluded. auto-submit:* now read --kanban-json data/board-state.json instead
// of the empty localStorage-backed HTML, which is why "0 eligible" persisted.

log('Step 4.4 — Board-state export (export-board-state.mjs)');
const boardState = await npm('board-state', { step: 'step-4.4' });
if (!boardState.ok) {
  warn(`Board-state export exited ${boardState.status} — auto-submit will see no eligible cards`);
  summary.notes.push(`Board-state export non-zero exit (${boardState.status}) — R1 bridge degraded.`);
}

// ─── Step 4.5 — Ingest bridge: kanban-import → submit-queue ─────────────────

log('Step 4.5 — Ingest bridge (ingest-runner.mjs)');
const ingest = await npm('ingest', { step: 'step-4.5' });
summary.ingest.exit = ingest.status;
if (!ingest.ok) {
  warn(`Ingest exited ${ingest.status} — submit-queue may be stale; continuing`);
  summary.notes.push(`Ingest non-zero exit (${ingest.status}).`);
}

// ─── Step 4.6 — Lane Branch: New-Hot referral queue vs New-Fresh ────────────
// See DESIGN NOTE at top of file. Reads the newest data/kanban-import-*.json,
// prints a "REFERRAL QUEUE — review and send" block per New-Hot card (Rahil
// reviews/sends these himself — nothing here sends on his behalf), and writes
// data/referral-queue-{date}.json with the New-Fresh card IDs that Step 5 may
// safely run auto-submit:live against.

log('Step 4.6 — Lane Branch (referral-queue.mjs)');
const laneBranch = await npm('referral-queue', { step: 'step-4.6' });
summary.lane_branch.exit = laneBranch.status;

let freshIds = [];
const referralQueuePath = join(DATA, `referral-queue-${date}.json`);
if (laneBranch.ok && existsSync(referralQueuePath)) {
  try {
    const rq = JSON.parse(readFileSync(referralQueuePath, 'utf8'));
    summary.lane_branch.hot_count   = rq.hot_count   ?? rq.hot?.length   ?? 0;
    summary.lane_branch.fresh_count = rq.fresh_count ?? rq.fresh_ids?.length ?? 0;
    freshIds = Array.isArray(rq.fresh_ids) ? rq.fresh_ids : [];
    if (summary.lane_branch.hot_count > 0) {
      summary.notes.push(`${summary.lane_branch.hot_count} New-Hot card(s) waiting on Rahil — see referral-queue output above.`);
    }
  } catch (e) {
    warn(`Could not parse ${referralQueuePath}: ${e.message}`);
    summary.notes.push('Lane Branch ran but output JSON was unreadable — Step 5 skipped as a precaution.');
  }
} else {
  warn(`Lane Branch exited ${laneBranch.status} or wrote no output — Step 5 skipped as a precaution`);
  summary.notes.push(`Lane Branch non-zero/missing output (exit ${laneBranch.status}). Auto-submit:live skipped this run to avoid running unfiltered.`);
}

// ─── Step 4.55 — Cover-letter generation (K-2026-06-21-1) ────────────────────
// Generates a deterministic, zero-cost CL for every eligible A/B card that lacks
// one (generate-cl --all reads data/board-state.json from Step 4.4). Without this,
// A/B cards that hit the 89+ readiness band were silently held for "no CL".
// Grade-C cards are intentionally NOT eligible here (never auto-submitted), so a
// clean run with 0 A/B cards correctly produces 0 CLs.
log('Step 4.55 — Cover-letter generation (generate-cl --all)');
const clGen = await npm('cl:all', { capture: true, step: 'step-4.55' });
if (clGen.ok && clGen.stdout) {
  const made = (clGen.stdout.match(/CL score:/g) || []).length;
  summary.cover_letters = made;
  if (made > 0) summary.notes.push(`CL-Gen: generated ${made} cover letter(s) for eligible A/B cards.`);
} else if (!clGen.ok) {
  warn(`CL-Gen exited ${clGen.status} — readiness may hold 89+ cards lacking a CL`);
  summary.notes.push(`CL-Gen non-zero exit (${clGen.status}).`);
}

// ─── Step 4.65 — Readiness scoring pre-filter ────────────────────────────────
// Pre-scores all New-Fresh cards against Harvard MCS resume + CL standards.
// Cards that fail readiness (total < 70/100) are removed from freshIds so they
// never reach auto-submit. Cards where scoring is skipped (missing cv.md or CL)
// are kept in freshIds — scoring gaps don't block submission.
// Best-effort: a failed scorer or missing results file warns and continues with
// all freshIds unchanged.

if (freshIds.length > 0) {
  log('Step 4.65 — Readiness scoring pre-filter (score:dry-run)');
  await npm('score:dry-run', { args: ['--card-ids', freshIds.join(',')], step: 'step-4.65' });
  const readinessResultsPath = join(DATA, `readiness-results-${date}.json`);
  if (existsSync(readinessResultsPath)) {
    try {
      const rr = JSON.parse(readFileSync(readinessResultsPath, 'utf8'));
      const passedOrSkipped = new Set([...(rr.passed_ids ?? []), ...(rr.skipped_ids ?? [])]);
      const before = freshIds.length;
      freshIds = freshIds.filter((id) => passedOrSkipped.has(id));
      const gated = before - freshIds.length;
      if (gated > 0) {
        log(`Step 4.65 — ${gated} card(s) gated by readiness; ${freshIds.length} proceed to auto-submit`);
        summary.notes.push(`Readiness gate: ${gated} card(s) below 70/100 threshold; ${freshIds.length} proceed.`);
      } else {
        log(`Step 4.65 — All ${freshIds.length} cards passed readiness (avg ${rr.avg_score}/${rr.avg_grade})`);
      }
    } catch (e) {
      warn(`Could not parse readiness results: ${e.message} — all fresh IDs forwarded to auto-submit`);
    }
  } else {
    warn('Step 4.65 — readiness-results file not written; proceeding with all fresh IDs');
  }
} else {
  log('Step 4.65 — Readiness scoring: skipped (no New-Fresh cards)');
}

// ─── Step 5 — AutoSubmit live ────────────────────────────────────────────────
// TD-01 FIX: previous SKILL.md incorrectly called
//   node scripts/auto-submit.mjs --url "..." --grade ... --cl "..."
// The flags --url / --grade / --cl do not exist in auto-submit.mjs.
// Correct invocation: npm run auto-submit:live
// (reads the Kanban for queued A/B non-referral cards via --live --allow-tier lower)
//
// Lane-Branch: only New-Fresh card IDs from Step 4.6 are passed via --card-ids.
// If Lane Branch failed or found zero New-Fresh cards, this step is skipped
// entirely rather than falling back to an unfiltered run — see Step 4.6 above.

// Step 5 rewired 2026-08-02 (approved by Rahil, Product Owner): the nightly run no
// longer attempts an automated submit CLICK. Live-clicking Greenhouse/Lever/Ashby
// submit buttons is silently blocked by reCAPTCHA bot-detection (the confirmed 0%
// ceiling — a human click passes, an automated one does not), and the 1am pipeline
// cannot leave a filled browser open for Rahil to click hours later anyway. Instead
// it STAGES eligible New-Fresh cards into the Airtable "Submit Ready" lane (same
// readiness/grade/cap gates), where Rahil runs an interactive fill and clicks Submit
// himself. Warm-referral/New-Hot cards were never in the eligible set — untouched.
if (!laneBranch.ok || freshIds.length === 0) {
  const reason = !laneBranch.ok ? 'Lane Branch failed' : 'no New-Fresh cards this run';
  log(`Step 5 — AutoSubmit park-ready: SKIPPED (${reason})`);
  summary.autosubmit.skipped = true;
  summary.notes.push(`AutoSubmit park-ready skipped — ${reason}.`);
} else {
  log(`Step 5 — AutoSubmit park-ready (node auto-submit.mjs --park-ready --card-ids <${freshIds.length} New-Fresh card(s)> → Submit Ready lane)`);
  // Windows-hardened: spawn node directly (not `npm run`) — the npm.cmd wrapper
  // intermittently aborts with exit 3221226505 (0xC0000409), which hit this step
  // on 2026-08-09 and cost a -10 health penalty. Same fix as the Airtable steps.
  const autoSubmit = await nodeScript('scripts/auto-submit.mjs',
    ['--kanban-json', 'data/board-state.json', '--park-ready', '--card-ids', freshIds.join(',')],
    { step: 'step-5' });
  summary.autosubmit.exit = autoSubmit.status;
  // Record the TRUE number of cards processed: prefer the park-ready summary line
  // ("<n> card(s) → Submit Ready"), then the --card-ids filter line, then the
  // "<n> eligible cards found" fallback.
  {
    const out = autoSubmit.stdout || '';
    const mPark   = out.match(/(\d+)\s+card\(s\)\s*→\s*Submit Ready/i);
    const mFilter = out.match(/(\d+)\s*\(requested/);
    const mFound  = out.match(/(\d+)\s+eligible\s+cards?\s+found/i);
    summary.autosubmit.attempted = mPark ? Number(mPark[1]) : mFilter ? Number(mFilter[1]) : (mFound ? Number(mFound[1]) : 0);
  }
  // park-ready exit codes: 0=staged cleanly · 1=fatal (bad kanban / eligibility load)
  if (autoSubmit.status === 1) {
    summary.autosubmit.result = 'fatal';
    summary.notes.push('AutoSubmit park-ready fatal exit (1). Check kanban source and eligibility load.');
  } else if (autoSubmit.ok) {
    summary.autosubmit.result = 'staged';
    if (summary.autosubmit.attempted > 0) {
      summary.notes.push(`${summary.autosubmit.attempted} card(s) staged to Submit Ready — awaiting Rahil's final Submit click.`);
    }
  }
}

// ─── Step 5.5 — Commute sweep (K-0816-3, approved by Rahil 2026-08-16) ───────
// Runs AFTER park-ready so it gates what actually reached the human queue.
//
// SCOPED TO "Submit Ready" ON PURPOSE. A full sweep of all three active lanes
// moves 8 of 18 cards, four of them New-Hot warm referrals — a far wider blast
// radius than the Submit Ready table Rahil approved. Warm referrals spend a real
// relationship exactly once, so they stay a human decision and are NOT swept
// here. To widen this later, change --lanes; do not remove the flag.
//
// Non-destructive: onsite roles outside ~24mi of 75067 move to the Blocked lane,
// which is a holding bin, not a delete. Remote/hybrid and unknown locations are
// always kept (see scripts/locations.mjs).
log('Step 5.5 — Commute sweep (commute-sweep.mjs --lanes "Submit Ready" --apply)');
const commute = await nodeScript('scripts/commute-sweep.mjs',
  ['--lanes', 'Submit Ready', '--apply'], { step: 'step-5.5' });
summary.commute_sweep = { exit: commute.status };
{
  const m = (commute.stdout || '').match(/moved (\d+) card\(s\) to Blocked/i);
  const moved = m ? Number(m[1]) : 0;
  summary.commute_sweep.moved = moved;
  if (moved > 0) {
    summary.notes.push(`Commute sweep moved ${moved} onsite card(s) out of Submit Ready to Blocked (K-0816-3).`);
  }
}
if (!commute.ok) {
  warn(`Commute sweep exited ${commute.status} — pipeline continues`);
  summary.notes.push(`Commute sweep non-zero exit (${commute.status}).`);
}

// ─── Steps 6–8 — Kanban column update + SEED_VERSION bump ────────────────────
// TODO(Kanban-Update): After autosubmit completes, update columns in the Kanban:
//   exit 0 → move card to applied column
//   exit 3 → move card to blocked column
//   Then bump SEED_VERSION and atomic-save dashboard/job-pulse-kanban.html via
//   npm run safe-edit (scripts/safe-edit.mjs).
//   Depends on TODO(Kanban-Inject) delivering mutable card state.
log('Steps 6–8 — Kanban column update: TODO(Kanban-Update) — skipped this phase');
summary.notes.push('Kanban column update + SEED_VERSION bump not yet in orchestrator (TODO Kanban-Update).');

// ─── Step 8.5 — Write last-refresh.json ─────────────────────────────────────

log('Step 8.5 — Writing data/last-refresh.json');
writeRefreshStatus(summary);

// ─── Step 8.7 — Airtable snapshot ───────────────────────────────────────────
// Rollback/audit snapshot via airtable-map.mjs (unrelated to the live sync —
// this is a point-in-time dump of the local mirror, kept for history). The
// actual live two-way sync is Step -0.5 (pull, above) and Step 9 (push, below).

const airtableOut = join(DATA, `airtable-payload-${date}.json`);
log('Step 8.7 — Airtable snapshot');
const snap = spawnSync(
  'node',
  [join('scripts', 'airtable-map.mjs')],
  { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'inherit'] }
);
if (snap.status === 0 && snap.stdout?.length) {
  try {
    writeFileSync(airtableOut, snap.stdout);
    log(`Airtable snapshot written → ${airtableOut}`);
    summary.notes.push(`Airtable snapshot OK → data/airtable-payload-${date}.json`);
  } catch (e) {
    warn(`Could not write airtable snapshot: ${e.message}`);
  }
} else {
  warn(`airtable-map.mjs exited ${snap.status} — snapshot skipped`);
  summary.notes.push(`Airtable snapshot skipped (exit ${snap.status}).`);
}

// ─── Step 9 — Airtable push ──────────────────────────────────────────────────
// Final step: push local changes back to Airtable. Only cards whose local
// Last Refreshed is newer than the Step -0.5 pull baseline AND whose Airtable
// side hasn't also drifted since then are PATCHed — conflicts and archived
// (no-longer-Active) cards are logged and skipped, never overwritten/recreated.
// Best-effort: missing AIRTABLE_PAT or a failed call warns and does not affect
// the pipeline's exit code.

log('Step 9 — Airtable push (airtable-sync.mjs --push)');
const airtablePush = await nodeScript('scripts/airtable-sync.mjs', ['--push'], { step: 'step-9' });
summary.airtable_sync.push.exit = airtablePush.status;
if (!airtablePush.ok) {
  warn(`Airtable push exited ${airtablePush.status} — local changes were not synced back this run`);
  summary.airtable_sync.push.skipped = true;
  summary.notes.push(`Airtable push non-zero exit (${airtablePush.status}).`);
}

// ─── Step 9.5 — Board snapshot for the 8am emailed report ────────────────────
// Render the pipeline board PNG here, on the real machine where chromium exists.
// The 8am report task runs in a browserless sandbox and cannot render it, so it
// falls back to the newest image on disk — without this step that image is a day
// (or more) stale (the exact "board dated 08-04 in the 08-05 email" bug). Renders
// from today's kanban-import (the Step -0.5 pull). Best-effort: render-board-
// snapshot degrades loudly and exits 0 on skip, so this never fails the run.
log('Step 9.5 — Board snapshot (render-board-snapshot.mjs)');
const boardSnap = await nodeScript('scripts/render-board-snapshot.mjs', [], { step: 'step-9.5' });
if (!boardSnap.ok) {
  summary.notes.push(`Board snapshot render exited ${boardSnap.status} — the 8am email may attach an older board image.`);
}

// ─── Final exit code ─────────────────────────────────────────────────────────

log(`=== PULSE REFRESH COMPLETE — ${date} ===`);
log(`doctor=${summary.doctor} workday=${summary.workday_scan.exit} scan=${summary.primary_scan.exit} grader=${summary.worker_grader.exit} inject=${summary.kanban_inject.exit}(injected=${summary.kanban_inject.injected}) ingest=${summary.ingest.exit} lane_branch=${summary.lane_branch.exit} (hot=${summary.lane_branch.hot_count} fresh=${summary.lane_branch.fresh_count}) autosubmit=${summary.autosubmit.exit}${summary.autosubmit.skipped ? ' (skipped)' : ''} airtable_pull=${summary.airtable_sync.pull.exit} airtable_push=${summary.airtable_sync.push.exit} archive_stale=${summary.archive_stale.exit} (archived=${summary.archive_stale.archived} tagged=${summary.archive_stale.tagged_flow})`);
if (summary.notes.length) {
  log('--- Notes ---');
  for (const n of summary.notes) log(`  • ${n}`);
}

// K-1: check live-runs for submission errors — a clean exit(0) can mask
// individual run-level errors when every card errored inside auto-submit.
{
  const liveRunsPath = join(DATA, `live-runs-${date}.json`);
  if (existsSync(liveRunsPath) && summary.autosubmit.result === 'clean') {
    try {
      const liveRuns = JSON.parse(readFileSync(liveRunsPath, 'utf8'));
      const runs = Array.isArray(liveRuns) ? liveRuns : (liveRuns.runs ?? []);
      if (runs.some(r => r.status === 'error')) {
        summary.autosubmit.result = 'error';
        warn(`K-1: live-runs-${date}.json has error entries — overriding autosubmit result to "error"`);
        summary.notes.push(`K-1: live-runs has error entries — autosubmit result overridden to "error".`);
      }
    } catch (e) {
      warn(`K-1: could not parse live-runs-${date}.json: ${e.message}`);
    }
  }
}

// Final exit code propagates the most severe partial state from auto-submit.
// 0 = clean · 1 = error (K-1: live-runs error entries) · 2 = captcha/human-required · 3 = form-blocked/dead.
// Fatal (1) already hard-exited earlier via abort(). A skipped auto-submit
// is not an error — the rest of the pipeline still completed cleanly.
let finalCode = 0;
if (summary.autosubmit.result === 'captcha-blocked') finalCode = 2;
else if (summary.autosubmit.result === 'form-blocked') finalCode = 3;
else if (summary.autosubmit.result === 'error') finalCode = 1;

// ─── Log summary line ────────────────────────────────────────────────────────
appendLog('summary', [
  `exit=${finalCode}`,
  `doctor=${summary.doctor}`,
  `workday=${summary.workday_scan.exit}`,
  `scan=${summary.primary_scan.exit}`,
  `grader=${summary.worker_grader.exit}`,
  `inject=${summary.kanban_inject.exit}`,
  `injected=${summary.kanban_inject.injected}`,
  `ingest=${summary.ingest.exit}`,
  `lane_branch=${summary.lane_branch.exit}`,
  `hot=${summary.lane_branch.hot_count}`,
  `fresh=${summary.lane_branch.fresh_count}`,
  `autosubmit=${summary.autosubmit.exit}${summary.autosubmit.skipped ? '(skipped)' : ''}`,
  `autosubmit_result=${summary.autosubmit.result}`,
  `airtable_pull=${summary.airtable_sync.pull.exit}`,
  `airtable_push=${summary.airtable_sync.push.exit}`,
  `archive_stale=${summary.archive_stale.exit}`,
  `archived=${summary.archive_stale.archived}`,
  `tagged=${summary.archive_stale.tagged_flow}`,
  `notes=${summary.notes.length}`,
].join(' '));

log(`Final exit code: ${finalCode}`);
process.exit(finalCode);

})().catch((err) => {
  console.error(`[pulse-refresh] FATAL ${err?.stack || err}`);
  try { appendLog('orchestrator', `FATAL ${err?.message || err}`); } catch {}
  process.exit(1);
});

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
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const DATA      = join(ROOT, 'data');
const LOGS      = join(ROOT, 'logs');

// ─── log file setup ──────────────────────────────────────────────────────────

const date    = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
mkdirSync(LOGS, { recursive: true });
const logPath = join(LOGS, `pulse-refresh-${date}.log`);

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
  kanban_inject: { exit: null, skipped: false, injected: null },
  ingest:        { exit: null },
  lane_branch:   { exit: null, hot_count: null, fresh_count: null },
  autosubmit:    { exit: null, mode: 'live', skipped: false },
  airtable_sync: { pull: { exit: null, skipped: false }, push: { exit: null, skipped: false } },
  archive_stale: { exit: null, skipped: false, archived: null, tagged_flow: null },
  cover_letters: 0,
  cadence:       { gap_count: null, missing: [] },
  notes:         [],
};

// ─── main pipeline (async for tee streaming) ────────────────────────────────

(async () => {

// ─── Step -0.5 — Airtable pull ───────────────────────────────────────────────
// Pulls the live Active Pipeline into a fresh data/kanban-import-{date}.json
// (+ data/airtable-sync-state.json conflict baseline) before anything else
// reads local data, so lane-branch/ingest/auto-submit work off current state.
// Best-effort: missing AIRTABLE_PAT or a failed call warns and continues
// against whatever kanban-import file already exists locally.

log('Step -0.5 — Airtable pull (airtable-sync.mjs --pull)');
const airtablePull = await npm('airtable:pull', { step: 'step-0.5' });
summary.airtable_sync.pull.exit = airtablePull.status;
if (!airtablePull.ok) {
  warn(`Airtable pull exited ${airtablePull.status} — continuing against existing local data`);
  summary.airtable_sync.pull.skipped = true;
  summary.notes.push(`Airtable pull non-zero exit (${airtablePull.status}) — see AIRTABLE_PAT setup in .env.example if this is new.`);
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
const archiveStale = await npm('archive:apply', { capture: true, step: 'step-0.4' });
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
  summary.cadence.gap_count = cs.gap_count ?? null;
  summary.cadence.missing   = cs.missing   ?? [];
  if ((cs.gap_count ?? 0) > 0) {
    summary.notes.push(`Cadence watchdog: ${cs.gap_count} missed run(s) in last ${cs.window_days}d — ${cs.missing.join(', ')}. Investigate the scheduler (last run ${cs.last_run}).`);
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

// ─── Step 0.9 — Greenhouse / Ashby / Lever via Worker ───────────────────────
// TODO(Worker-Grader): Call the Cloudflare Worker at
//   https://pulse-jobs-proxy.rahilnathanipulse.workers.dev
//   per company slug in config/sources.yml, filter titles, grade A/B/C,
//   resolve connections from config/linkedin-connections.json, and emit cards
//   into data/kanban-import-[date].json.
//   Requires: HTTP client, YAML parser, grade-jobs.mjs integration.
//   Implement after Lane-Branch is designed (cards route to New-Hot or New-Fresh).
log('Step 0.9 — Worker/Ashby scan: TODO(Worker-Grader) — skipped this phase');
summary.notes.push('Worker/Ashby scan not yet implemented in orchestrator (TODO Worker-Grader).');

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

if (!laneBranch.ok || freshIds.length === 0) {
  const reason = !laneBranch.ok ? 'Lane Branch failed' : 'no New-Fresh cards this run';
  log(`Step 5 — AutoSubmit live: SKIPPED (${reason})`);
  summary.autosubmit.skipped = true;
  summary.notes.push(`AutoSubmit:live skipped — ${reason}.`);
} else {
  log(`Step 5 — AutoSubmit live (TD-01 fix: npm run auto-submit:live --card-ids <${freshIds.length} New-Fresh card(s)>)`);
  const autoSubmit = await npm('auto-submit:live', { capture: true, args: ['--card-ids', freshIds.join(',')], step: 'step-5' });
  summary.autosubmit.exit = autoSubmit.status;
  // TD-01: record the TRUE number of cards auto-submit actually processed,
  // not a hardcoded 1. Post-filter eligible count is "<n> (requested <m>)";
  // fall back to "<n> eligible cards found" for unfiltered runs.
  {
    const out = autoSubmit.stdout || '';
    const mFilter = out.match(/(\d+)\s*\(requested/);
    const mFound  = out.match(/(\d+)\s+eligible\s+cards?\s+found/i);
    summary.autosubmit.attempted = mFilter ? Number(mFilter[1]) : (mFound ? Number(mFound[1]) : 0);
  }
  // Exit codes: 0=clean · 1=fatal · 2=captcha/human-required · 3=form-blocked/dead
  // There is NO exit code 4. The prior "4=deferred" in SKILL.md was incorrect.
  if (autoSubmit.status === 1) {
    summary.autosubmit.result = 'fatal';
    summary.notes.push('AutoSubmit fatal exit (1). Check safety locks and kanban file.');
  } else if (autoSubmit.status === 2) {
    summary.autosubmit.result = 'captcha-blocked';
  } else if (autoSubmit.status === 3) {
    summary.autosubmit.result = 'form-blocked';
  } else if (autoSubmit.ok) {
    summary.autosubmit.result = 'clean';
  }
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
const airtablePush = await npm('airtable:push', { step: 'step-9' });
summary.airtable_sync.push.exit = airtablePush.status;
if (!airtablePush.ok) {
  warn(`Airtable push exited ${airtablePush.status} — local changes were not synced back this run`);
  summary.airtable_sync.push.skipped = true;
  summary.notes.push(`Airtable push non-zero exit (${airtablePush.status}).`);
}

// ─── Final exit code ─────────────────────────────────────────────────────────

log(`=== PULSE REFRESH COMPLETE — ${date} ===`);
log(`doctor=${summary.doctor} workday=${summary.workday_scan.exit} scan=${summary.primary_scan.exit} grader=${summary.worker_grader.exit} inject=${summary.kanban_inject.exit}(injected=${summary.kanban_inject.injected}) ingest=${summary.ingest.exit} lane_branch=${summary.lane_branch.exit} (hot=${summary.lane_branch.hot_count} fresh=${summary.lane_branch.fresh_count}) autosubmit=${summary.autosubmit.exit}${summary.autosubmit.skipped ? ' (skipped)' : ''} airtable_pull=${summary.airtable_sync.pull.exit} airtable_push=${summary.airtable_sync.push.exit} archive_stale=${summary.archive_stale.exit} (archived=${summary.archive_stale.archived} tagged=${summary.archive_stale.tagged_flow})`);
if (summary.notes.length) {
  log('--- Notes ---');
  for (const n of summary.notes) log(`  • ${n}`);
}

// Final exit code propagates the most severe partial state from auto-submit.
// 0 = clean · 2 = captcha/human-required · 3 = form-blocked/dead.
// Fatal (1) already hard-exited earlier via abort(). A skipped auto-submit
// is not an error — the rest of the pipeline still completed cleanly.
let finalCode = 0;
if (summary.autosubmit.result === 'captcha-blocked') finalCode = 2;
else if (summary.autosubmit.result === 'form-blocked') finalCode = 3;

// ─── Log summary line ────────────────────────────────────────────────────────
appendLog('summary', [
  `exit=${finalCode}`,
  `doctor=${summary.doctor}`,
  `workday=${summary.workday_scan.exit}`,
  `scan=${summary.primary_scan.exit}`,
  `grader=${summary.worker_grader.exit}`,
  `inject=${summary.kanban_inject.exit}(injected=${summary.kanban_inject.injected})`,
  `ingest=${summary.ingest.exit}`,
  `lane_branch=${summary.lane_branch.exit}(hot=${summary.lane_branch.hot_count} fresh=${summary.lane_branch.fresh_count})`,
  `autosubmit=${summary.autosubmit.exit ?? (summary.autosubmit.skipped ? 'skipped' : null)}`,
  `airtable_pull=${summary.airtable_sync.pull.exit}`,
  `airtable_push=${summary.airtable_sync.push.exit}`,
  `archive_stale=${summary.archive_stale.exit}(archived=${summary.archive_stale.archived} tagged=${summary.archive_stale.tagged_flow})`,
].join(' | '));

log(`Exit ${finalCode}`);
process.exit(finalCode);

})().catch(e => {
  console.error('[pulse-refresh] FATAL uncaught:', e);
  appendLog('orchestrator', `FATAL uncaught: ${e?.message ?? e}`);
  process.exit(1);
});

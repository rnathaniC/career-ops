#!/usr/bin/env node
/**
 * daily-health-report.mjs — self-contained daily Job-Pulse health report.
 *
 * THE STORY: the 1 AM pipeline (pulse-refresh.mjs) reliably writes the raw
 * telemetry — data/last-refresh.json, cadence-status.json, referral-queue-*.json,
 * submit-queue.json, ingest-status.json. But the *report* that Rahil actually
 * reads used to be synthesised inside an opaque OneDrive SKILL.md session that
 * silently no-op'd for days (no file written, nothing delivered — the worst kind
 * of failure: a green checkmark over an empty hand). This script moves that logic
 * INTO the repo where we control and test it.
 *
 * It reads the telemetry, computes a pipeline health score, and writes a dated
 * report to reports/pulse-daily-YYYY-MM-DD.md AND prints the same report to
 * stdout so a scheduled task can capture and relay it.
 *
 * DESIGN RULE #1 — never a silent no-op. If a data source is missing or corrupt,
 * the report is STILL written, with a loud, explicit note about what was missing.
 * A degraded report beats zero reports every time.
 *
 * Usage:
 *   node scripts/daily-health-report.mjs
 *   node scripts/daily-health-report.mjs --date 2026-07-22   # override report date
 *   node scripts/daily-health-report.mjs --data-dir ./x --out-dir ./y --quiet
 *
 * Exit: 0 on success (report written), 1 only if the report file itself could
 *       not be written to disk (a real I/O failure, not merely missing inputs).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_GITIGNORED_FILES, isUserGitignoredFile } from '../user-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// ── small resilient helpers ──────────────────────────────────────
export function readJsonSafe(p) {
  try {
    if (!p || !existsSync(p)) return { ok: false, error: 'missing', data: null };
    return { ok: true, data: JSON.parse(readFileSync(p, 'utf8')), error: null };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), data: null };
  }
}

export function newestReferralQueue(dataDir) {
  try {
    const files = readdirSync(dataDir)
      .filter((f) => /^referral-queue-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    return files.length ? path.join(dataDir, files[files.length - 1]) : null;
  } catch {
    return null;
  }
}

export function chicagoDate(d = new Date()) {
  // en-CA formats as YYYY-MM-DD; pin to Central so the report date matches the run.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function hoursSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now - t) / 3.6e6;
}

// ── health score (pure) ──────────────────────────────────────────
export function computeHealthScore(refresh, cadence, referral, now = Date.now()) {
  if (!refresh) {
    return {
      score: null,
      grade: 'UNKNOWN',
      verdict: 'UNKNOWN',
      factors: ['last-refresh.json missing or unreadable — cannot score the pipeline'],
    };
  }
  let score = 100;
  const factors = [];
  const ding = (n, why) => {
    score -= n;
    factors.push(`-${n} ${why}`);
  };

  if (refresh.doctor && refresh.doctor !== 'ok') ding(20, `doctor=${refresh.doctor}`);

  const age = hoursSince(refresh.ran_at_utc, now);
  if (age == null) ding(15, 'ran_at_utc missing/unparseable');
  else if (age > 30) ding(25, `pipeline data stale (${age.toFixed(1)}h old)`);
  else if (age > 26) ding(10, `pipeline data aging (${age.toFixed(1)}h old)`);

  const exitChecks = [
    ['autosubmit', refresh.autosubmit && refresh.autosubmit.exit, 10],
    ['primary_scan', refresh.primary_scan && refresh.primary_scan.exit, 5],
    ['workday_scan', refresh.workday_scan && refresh.workday_scan.exit, 5],
    ['worker_grader', refresh.worker_grader && refresh.worker_grader.exit, 5],
    ['ashby_scan', refresh.ashby_scan && refresh.ashby_scan.exit, 5],
    ['kanban_inject', refresh.kanban_inject && refresh.kanban_inject.exit, 5],
    ['ingest', refresh.ingest && refresh.ingest.exit, 5],
    ['archive_stale', refresh.archive_stale && refresh.archive_stale.exit, 5],
    ['lane_branch', refresh.lane_branch && refresh.lane_branch.exit, 5],
  ];
  for (const [name, exit, pen] of exitChecks) {
    if (typeof exit === 'number' && exit !== 0) ding(pen, `${name} exit=${exit}`);
  }

  // Cadence health — a cadence MARKER alone must NEVER count as a run. The
  // watchdog now separates genuine runs from SILENT misses (marker present but
  // last-refresh never advanced — the masking bug K-2026-07-28 hardened against).
  // Prefer the granular arrays; fall back to the legacy scalar gap_count for
  // older cadence-status.json blobs so this stays backward compatible.
  const cadSrc = cadence || (refresh && refresh.cadence) || {};
  const silentMisses = Array.isArray(cadSrc.silent_misses) ? cadSrc.silent_misses : [];
  if (Array.isArray(cadSrc.missing) || silentMisses.length) {
    const hardMissing = Array.isArray(cadSrc.missing) ? cadSrc.missing : [];
    if (hardMissing.length) ding(Math.min(hardMissing.length * 5, 20), `cadence: ${hardMissing.length} missed run(s) in last 7d`);
    if (silentMisses.length) {
      ding(
        Math.min(silentMisses.length * 8, 30),
        `SILENT pipeline miss(es) — cadence marker present but no fresh refresh: ${silentMisses.join(', ')}`,
      );
    }
  } else {
    const gaps = cadSrc.gap_count ?? 0;
    if (gaps > 0) ding(Math.min(gaps * 5, 20), `cadence: ${gaps} missed run(s) in last 7d`);
  }

  const hot = (referral && referral.hot_count) ?? (refresh.lane_branch && refresh.lane_branch.hot_count) ?? 0;
  if (hot > 20) ding(5, `referral backlog: ${hot} New-Hot cards waiting on Rahil`);

  score = Math.max(0, Math.min(100, score));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';
  const verdict = score >= 90 ? 'GREEN' : score >= 60 ? 'AMBER' : 'RED';
  return { score, grade, verdict, factors };
}

// ── user (gitignored) files — never shippable ────────────────────
// These per-user layer files are the customization layer that .gitignore keeps
// out of the repo forever. dispatch-relay's ship-gate already refuses them
// ("git state 'untracked' — not shippable"), so if they ever land in the
// dispatch manifest's `pending` array they'd nag as a validated-but-not-
// dispatched tech-debt flag FOREVER — a false permanent alarm. We exclude them
// from the ship-gap computation here (see collectFlags below).
//
// The canonical set + matcher now live in ../user-files.mjs, shared with
// doctor.mjs's USER_LAYER_PREREQS so the two can NEVER drift. Imported above;
// re-exported here so this module's public API is unchanged.
export { USER_GITIGNORED_FILES, isUserGitignoredFile };

// ── tech-debt / kaizen flags (pure) ──────────────────────────────
export function collectFlags(refresh, dispatch, cadence, referral) {
  const techDebt = [];
  const actions = [];
  const kaizen = [];

  if (refresh) {
    for (const n of refresh.notes || []) {
      if (/TODO|not yet in orchestrator|not yet implemented/i.test(n)) techDebt.push(n);
      else if (/waiting on Rahil|New-Hot|below .*threshold|Investigate/i.test(n)) actions.push(n);
    }
    for (const d of refresh.defects_autofixed || []) {
      techDebt.push(`auto-fixed defect: ${typeof d === 'string' ? d : JSON.stringify(d)}`);
    }
  }

  // Only shippable files count toward the commit+ship gap. Per-user gitignored
  // files (portals.yml, config/profile.yml, …) can never be committed, so they'd
  // otherwise nag here forever even though the ship-gate correctly refuses them.
  const shippablePending = (dispatch && Array.isArray(dispatch.pending) ? dispatch.pending : [])
    .filter((f) => !isUserGitignoredFile(f));
  if (shippablePending.length) {
    techDebt.push(
      `${shippablePending.length} file(s) validated but NOT dispatched (commit+ship gap): ${shippablePending.join(', ')}`,
    );
    kaizen.push('Commit + `node dispatch-relay.mjs --dispatch` the pending files to close the validated-but-vanished risk.');
  }

  const cadSrc = cadence || (refresh && refresh.cadence) || {};
  const silentMisses = Array.isArray(cadSrc.silent_misses) ? cadSrc.silent_misses : [];
  const hardMissing = Array.isArray(cadSrc.missing) ? cadSrc.missing : [];
  const gaps = cadSrc.gap_count ?? 0;

  // Hard scheduler gaps — days with no run log at all. Prefer the explicit
  // hard-missing array; fall back to the legacy scalar gap_count.
  const hardCount = hardMissing.length || (silentMisses.length ? 0 : gaps);
  if (hardCount > 0) {
    kaizen.push(
      `Scheduler missed ${hardCount} run(s)${hardMissing.length ? ` (${hardMissing.join(', ')})` : ''} — verify the 1 AM task is firing and writing cadence markers.`,
    );
  }

  // SILENT misses — the worst failure mode: a cadence marker was written but the
  // pipeline produced no fresh data (last-refresh never advanced). This is the
  // exact outage that hid for 5 days. Surface each one loudly so it can never
  // masquerade as a healthy run behind a green marker again.
  for (const d of silentMisses) {
    techDebt.push(`⚠ marker present but no fresh refresh — silent pipeline miss on ${d}`);
  }
  if (silentMisses.length) {
    actions.push(
      `Pipeline SILENTLY missed on ${silentMisses.join(', ')} — a cadence marker exists but no fresh data was produced. Check whether the 1 AM task actually runs \`npm run pulse:refresh\`.`,
    );
    kaizen.push(
      `${silentMisses.length} day(s) wrote a cadence marker but never advanced last-refresh (${silentMisses.join(', ')}) — confirm the scheduler executes the real pipeline, not just cadence-mark.`,
    );
  }

  const hot = (referral && referral.hot_count) ?? 0;
  if (hot > 20) {
    kaizen.push(`Referral backlog at ${hot} New-Hot — triage the queue or auto-age old cards so the reaper/review cadence stays sane.`);
  }

  return { techDebt, actions, kaizen };
}

// ── markdown builder (pure) ──────────────────────────────────────
function line(v) {
  return v === undefined || v === null ? '—' : v;
}

export function buildReport(ctx) {
  const { date, now, refresh, cadence, referral, submitQueue, ingest, dispatch, sourceStatus } = ctx;
  const health = computeHealthScore(refresh, cadence, referral, now);
  const flags = collectFlags(refresh, dispatch, cadence, referral);
  const out = [];

  const scoreStr = health.score == null ? 'UNKNOWN' : `${health.score}/100 (${health.grade})`;
  out.push(`# Pulse Daily — ${date}`);
  out.push('');
  out.push(`**Health:** ${health.verdict} · **Score:** ${scoreStr} · generated ${new Date(now).toISOString()}`);
  out.push('');

  // Loud degraded-source banner (anti silent-no-op).
  const missing = Object.entries(sourceStatus).filter(([, s]) => !s.ok);
  if (missing.length) {
    out.push('> ⚠️ **DEGRADED REPORT** — some data sources were missing/unreadable; sections below are best-effort:');
    for (const [name, s] of missing) out.push(`> - \`${name}\`: ${s.error}`);
    out.push('');
  }

  // 1. Pipeline health
  out.push('## Pipeline health');
  out.push('');
  if (refresh) {
    out.push(`- Last 1 AM run: \`${line(refresh.ran_at_utc)}\` · mode \`${line(refresh.mode)}\` · doctor \`${line(refresh.doctor)}\``);
    const age = hoursSince(refresh.ran_at_utc, now);
    out.push(`- Data age: ${age == null ? 'unknown' : age.toFixed(1) + 'h'}`);
    const silent = cadence && Array.isArray(cadence.silent_misses) ? cadence.silent_misses : [];
    if (silent.length) {
      out.push(`- 🚨 SILENT pipeline miss(es): ${silent.join(', ')} — a cadence marker was written but last-refresh never advanced (masked outage; these do NOT count as runs).`);
    }
  } else {
    out.push('- ⚠️ `last-refresh.json` unavailable — the 1 AM pipeline telemetry could not be read.');
  }
  if (health.factors.length) {
    out.push('- Score factors:');
    for (const f of health.factors) out.push(`  - ${f}`);
  } else {
    out.push('- Score factors: none (clean run)');
  }
  out.push('');

  // 2. Submissions
  out.push('## Submissions');
  out.push('');
  if (refresh) {
    const a = refresh.autosubmit || {};
    out.push(`- AutoSubmit: attempted ${line(a.attempted)} · result \`${line(a.result)}\` · exit ${line(a.exit)}`);
    out.push(`- Cards injected: ${line(refresh.cards_injected)} · cover letters: ${line(refresh.cover_letters)}`);
  }
  if (ingest) {
    out.push(`- Ingest: considered ${line(ingest.considered)} · graded ${line(ingest.graded)} · fresh ${line(ingest.fresh)} · referral-held ${line(ingest.referral_held)} · added ${line(ingest.added)}`);
  }
  if (Array.isArray(submitQueue)) {
    const byStatus = {};
    for (const r of submitQueue) byStatus[r.status || 'unknown'] = (byStatus[r.status || 'unknown'] || 0) + 1;
    const summary = Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' · ') || 'empty';
    out.push(`- Submit queue: ${submitQueue.length} item(s) (${summary})`);
  }
  if (!refresh && !ingest && !Array.isArray(submitQueue)) out.push('- ⚠️ No submission telemetry available.');
  out.push('');

  // 3. Referral queue
  out.push('## Referral queue');
  out.push('');
  if (referral) {
    const hot = Array.isArray(referral.hot) ? referral.hot : [];
    const drafted = hot.filter((h) => h.message_drafted).length;
    out.push(`- New-Hot: ${line(referral.hot_count)} (messages drafted: ${drafted}/${hot.length}) · New-Fresh: ${line(referral.fresh_count)}`);
    if (hot.length) {
      out.push('- Top Hot referrals:');
      for (const h of hot.slice(0, 8)) {
        out.push(`  - ${line(h.company)} — ${line(h.role)} → ${line(h.connectionName)}${h.message_drafted ? '' : ' · ⚠ no message drafted'}`);
      }
      if (hot.length > 8) out.push(`  - …and ${hot.length - 8} more`);
    }
  } else {
    out.push('- ⚠️ No referral-queue file found for today.');
  }
  out.push('');

  // 4. Action needed
  out.push('## Action needed — Rahil');
  out.push('');
  if (flags.actions.length) for (const a of flags.actions) out.push(`- ${a}`);
  else out.push('- Nothing blocking flagged by the pipeline.');
  out.push('');

  // 5. Tech debt
  out.push('## Tech-debt flags');
  out.push('');
  if (flags.techDebt.length) for (const t of flags.techDebt) out.push(`- ${t}`);
  else out.push('- None surfaced this run.');
  out.push('');

  // 6. Kaizen
  out.push('## Kaizen flags (need Rahil Y/N)');
  out.push('');
  if (flags.kaizen.length) flags.kaizen.forEach((k, i) => out.push(`${i + 1}. ${k}`));
  else out.push('- No new kaizen proposals this run.');
  out.push('');

  out.push('---');
  out.push('_Generated by `scripts/daily-health-report.mjs` (in-repo, deterministic). Reads only committed pipeline telemetry; degrades loudly rather than silently._');
  out.push('');

  return out.join('\n');
}

// ── orchestration (side effects isolated here) ───────────────────
export function generate(opts = {}) {
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const outDir = opts.outDir || path.join(ROOT, 'reports');
  const now = opts.now || Date.now();
  const date = opts.date || chicagoDate(new Date(now));

  const sourceStatus = {};
  const load = (name, p) => {
    const r = readJsonSafe(p);
    sourceStatus[name] = { ok: r.ok, error: r.error };
    return r.data;
  };

  const refresh = load('last-refresh.json', path.join(dataDir, 'last-refresh.json'));
  const cadence = load('cadence-status.json', path.join(dataDir, 'cadence-status.json'));
  const ingest = load('ingest-status.json', path.join(dataDir, 'ingest-status.json'));
  const submitQueue = load('submit-queue.json', path.join(dataDir, 'submit-queue.json'));
  const dispatch = load('dispatch-manifest.json', path.join(dataDir, 'dispatch-manifest.json'));

  const refPath = newestReferralQueue(dataDir);
  const referral = load(refPath ? path.basename(refPath) : 'referral-queue-*.json', refPath);

  const markdown = buildReport({
    date,
    now,
    refresh,
    cadence,
    referral,
    submitQueue,
    ingest,
    dispatch,
    sourceStatus,
  });

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, `pulse-daily-${date}.md`);
  writeFileSync(reportPath, markdown, 'utf8');

  return { reportPath, markdown, date, sourceStatus };
}

function parseArgs(argv) {
  const get = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  return {
    date: get('--date'),
    dataDir: get('--data-dir'),
    outDir: get('--out-dir'),
    quiet: argv.includes('--quiet'),
  };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { reportPath, markdown } = generate(args);
    if (!args.quiet) {
      process.stdout.write(markdown);
      process.stdout.write(`\n[daily-health-report] wrote ${reportPath}\n`);
    } else {
      process.stdout.write(`[daily-health-report] wrote ${reportPath}\n`);
    }
    process.exit(0);
  } catch (e) {
    console.error(`[daily-health-report] FATAL: could not write report: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}

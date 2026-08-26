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

export function newestCardFlags(dataDir) {
  try {
    const files = readdirSync(dataDir)
      .filter((f) => /^card-flags-\d{4}-\d{2}-\d{2}\.json$/.test(f))
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

// ── auto-submit outcome scorecard (pure) ─────────────────────────
// THE STORY: every 1 AM auto-submit run journals per-card outcomes into
// data/live-runs-YYYY-MM-DD.json. We want a running scoreboard: how many
// applications actually CONFIRMED vs got blocked, errored, or need a human.
//
// LANDMINE (the whole reason this code is careful): the string "confirmed" is a
// substring of "unconfirmed". A naive `status.includes('confirmed')` therefore
// counts every UNCONFIRMED card as a success — a prior quick analysis did exactly
// this and reported 10 confirmed when the truth is ZERO. We classify by EXACT,
// normalized token equality (a lookup table), never substring, so 'unconfirmed'
// can never leak into 'confirmed'.
export const AUTO_SUBMIT_CATEGORIES = [
  'confirmed',
  'error',
  'blocked',
  'requires-human',
  'unconfirmed',
  'unknown',
  'skipped',
];

const AUTO_SUBMIT_LABELS = {
  confirmed: 'Confirmed / submitted',
  error: 'Error',
  blocked: 'Blocked',
  'requires-human': 'Requires-human',
  unconfirmed: 'Unconfirmed',
  unknown: 'Unknown',
  skipped: 'Skipped',
};

// Exact, normalized aliases → canonical category. Keys are already normalized
// (lowercased, spaces/underscores → hyphens). Anything not present → 'unknown'.
const OUTCOME_ALIASES = {
  confirmed: 'confirmed',
  submitted: 'confirmed',
  success: 'confirmed',
  'submit-confirmed': 'confirmed',
  error: 'error',
  errored: 'error',
  failed: 'error',
  failure: 'error',
  blocked: 'blocked',
  'form-blocked': 'blocked',
  'requires-human': 'requires-human',
  'needs-human': 'requires-human',
  manual: 'requires-human',
  unconfirmed: 'unconfirmed',
  skipped: 'skipped',
  skip: 'skipped',
};

function emptyTally() {
  const t = {};
  for (const c of AUTO_SUBMIT_CATEGORIES) t[c] = 0;
  return t;
}

// Normalize a raw outcome string to exactly one canonical category. EXACT match
// only — 'unconfirmed' → 'unconfirmed', never 'confirmed'.
export function normalizeOutcome(raw) {
  if (raw === undefined || raw === null) return 'unknown';
  const key = String(raw).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!key) return 'unknown';
  return OUTCOME_ALIASES[key] ?? 'unknown';
}

// A result item's outcome may live under 'outcome', 'result', or 'status'.
function itemOutcome(it) {
  if (!it || typeof it !== 'object') return undefined;
  return it.outcome ?? it.result ?? it.status;
}

// Flatten a parsed live-runs file into leaf result items. Handles the three
// observed shapes: a bare array of items, an object with a `results` array, and
// an array of run-wrappers that each nest their own `results` array. We only
// count leaf objects that actually look like a card result (have an outcome key
// or an id/url) so run-wrapper metadata never inflates the attempt count.
export function flattenLiveRun(parsed) {
  const items = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (node && typeof node === 'object') {
      if (Array.isArray(node.results)) {
        for (const n of node.results) visit(n);
        return;
      }
      if (
        node.outcome !== undefined ||
        node.result !== undefined ||
        node.status !== undefined ||
        node.id !== undefined ||
        node.url !== undefined
      ) {
        items.push(node);
      }
    }
  };
  visit(parsed);
  return items;
}

// Pure aggregator. runFiles: [{ file, date, data, readError }]. Splits every
// result into TODAY (file date === reportDate) vs the RUNNING total across all
// files, and computes raw + adjusted confirmed-success rates.
//   raw      = confirmed / all attempts
//   adjusted = confirmed / (attempts excluding skipped + requires-human)
// We exclude BOTH skipped (dup-guards, never real submissions) and
// requires-human (captcha/manual hand-offs the bot can't own) from the adjusted
// denominator, so it reflects only attempts the automation could truly close.
export function summarizeLiveRuns(runFiles, reportDate) {
  const today = emptyTally();
  const running = emptyTally();
  let filesRead = 0;
  let filesUnreadable = 0;
  let itemsToday = 0;
  let itemsRunning = 0;

  for (const rf of runFiles || []) {
    if (!rf || rf.readError || rf.data == null) {
      filesUnreadable += 1;
      continue;
    }
    filesRead += 1;
    const isToday = rf.date === reportDate;
    for (const it of flattenLiveRun(rf.data)) {
      const cat = normalizeOutcome(itemOutcome(it));
      running[cat] += 1;
      itemsRunning += 1;
      if (isToday) {
        today[cat] += 1;
        itemsToday += 1;
      }
    }
  }

  const rate = (confirmed, denom) => (denom > 0 ? Number(((confirmed / denom) * 100).toFixed(1)) : null);
  const rAdjDenom = itemsRunning - running.skipped - running['requires-human'];
  const tAdjDenom = itemsToday - today.skipped - today['requires-human'];

  return {
    reportDate,
    today,
    running,
    totals: { today: itemsToday, running: itemsRunning },
    filesRead,
    filesUnreadable,
    rates: {
      running: {
        raw: rate(running.confirmed, itemsRunning),
        rawDenom: itemsRunning,
        adjusted: rate(running.confirmed, rAdjDenom),
        adjustedDenom: rAdjDenom,
      },
      today: {
        raw: rate(today.confirmed, itemsToday),
        rawDenom: itemsToday,
        adjusted: rate(today.confirmed, tAdjDenom),
        adjustedDenom: tAdjDenom,
      },
    },
  };
}

// Side-effectful reader: glob data/live-runs-*.json, read each safely, tag its
// date (from the filename), and hand the lot to the pure aggregator. Degrades
// loudly — a missing dir or unreadable file becomes a zero/unreadable count,
// never a crash.
export function computeAutoSubmitScorecard(dataDir, reportDate) {
  let names = [];
  try {
    names = readdirSync(dataDir)
      .filter((f) => /^live-runs-.*\.json$/.test(f))
      .sort();
  } catch {
    names = [];
  }
  const runFiles = names.map((name) => {
    const r = readJsonSafe(path.join(dataDir, name));
    const m = name.match(/^live-runs-(\d{4}-\d{2}-\d{2})/);
    return {
      file: name,
      date: m ? m[1] : null,
      data: r.ok ? r.data : null,
      readError: r.ok ? null : r.error,
    };
  });
  return summarizeLiveRuns(runFiles, reportDate);
}

// Render the scorecard as markdown lines that slot into the report body.
export function renderAutoSubmitScorecard(sc) {
  const out = [];
  out.push('## Auto-Submit Scorecard');
  out.push('');
  if (sc.filesRead === 0) {
    out.push('> ⚠️ No readable `data/live-runs-*.json` files found — scorecard shows zeros (degraded, not silent).');
    out.push('');
  }
  if (sc.filesUnreadable > 0) {
    out.push(`> ⚠️ ${sc.filesUnreadable} live-runs file(s) were unreadable and skipped.`);
    out.push('');
  }
  out.push(
    "Auto-submit outcomes classified per result item (exact/normalized match — `unconfirmed` is never counted as `confirmed`). **Today** = results in today's live-runs file (0 if none); **Running total** = every `data/live-runs-*.json` since inception.",
  );
  out.push('');
  out.push('| Outcome | Today | Running total |');
  out.push('| --- | ---: | ---: |');
  for (const cat of AUTO_SUBMIT_CATEGORIES) {
    out.push(`| ${AUTO_SUBMIT_LABELS[cat]} | ${sc.today[cat]} | ${sc.running[cat]} |`);
  }
  out.push(`| **Total attempts** | **${sc.totals.today}** | **${sc.totals.running}** |`);
  out.push('');
  const pct = (v) => (v == null ? 'n/a' : `${v.toFixed(1)}%`);
  const r = sc.rates.running;
  out.push('**Confirmed success rate (running, since inception):**');
  out.push('');
  out.push(
    `- Raw: ${r.raw == null ? 'n/a (no attempts yet)' : pct(r.raw)} — ${sc.running.confirmed} confirmed / ${r.rawDenom} total attempts.`,
  );
  out.push(
    `- Adjusted: ${r.adjusted == null ? 'n/a (no genuine attempts yet)' : pct(r.adjusted)} — ${sc.running.confirmed} confirmed / ${r.adjustedDenom} genuine attempts (excludes ${sc.running.skipped} skipped + ${sc.running['requires-human']} requires-human).`,
  );
  out.push('');
  out.push(`_Files read: ${sc.filesRead} · unreadable: ${sc.filesUnreadable}._`);
  out.push('');
  return out;
}

// ── markdown builder (pure) ──────────────────────────────────────
function line(v) {
  return v === undefined || v === null ? '—' : v;
}

export function buildReport(ctx) {
  const { date, now, refresh, cadence, referral, submitQueue, ingest, dispatch, sourceStatus, parkReady, cardFlags } = ctx;
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

  // 2a. Submit Ready — the HUMAN queue (K-0816-1).
  {
    const staged = Number(parkReady?.parked ?? 0);
    const rows = Array.isArray(parkReady?.results)
      ? parkReady.results.filter((r) => r && r.status === 'submit-ready') : [];
    out.push('## Submit Ready — waiting on you');
    out.push('');
    if (staged > 0 || rows.length > 0) {
      out.push(`- **${rows.length || staged} card(s) staged today** — each needs your final Submit click.`);
      for (const r of rows.slice(0, 10)) {
        out.push(`  - ${r.company} — ${String(r.role || '').slice(0, 60)}`);
      }
      out.push('');
      out.push('- Drain the whole lane in one sitting: `npm run submit-ready:open`');
      out.push('- List without opening tabs: `npm run submit-ready`');
      out.push('');
      out.push('> Confirmed submit rate is 0.0% until these are clicked. Staging is not applying.');
    } else {
      out.push('- Nothing staged today.');
      out.push('- Check for carry-over from previous runs: `npm run submit-ready`');
    }
    out.push('');
  }

  // 2b. Auto-Submit Scorecard — per-card outcome tally (today vs since inception).
  const autoSubmit = ctx.autoSubmit || summarizeLiveRuns([], date);
  for (const l of renderAutoSubmitScorecard(autoSubmit)) out.push(l);

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

  // 3a. Card flags — Rahil's #OFF / #GOOD comment codes on Active Pipeline cards.
  out.push('## Card flags — Rahil');
  out.push('');
  if (Array.isArray(cardFlags)) {
    const off = cardFlags.filter((h) => h && h.tag === '#OFF');
    const good = cardFlags.filter((h) => h && h.tag === '#GOOD');
    out.push(`- Rahil flagged: ${cardFlags.length} card(s) (#OFF: ${off.length}, #GOOD: ${good.length})`);
    for (const h of cardFlags.slice(0, 10)) {
      const reason = h.tag === '#OFF' && h.reason ? `:${h.reason}` : '';
      out.push(`  - ${h.tag}${reason} — ${line(h.company)} — ${String(h.role || '').slice(0, 60)}`);
    }
    if (cardFlags.length > 10) out.push(`  - …and ${cardFlags.length - 10} more`);
  } else {
    out.push('- No card-flags file found for today (0 flags, or the scan has not run yet).');
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

  // K-0816-1: how many cards are parked awaiting Rahil's human Submit click.
  // The lane backed up to 8 on 2026-08-16 while every upstream metric read
  // green — the report has to surface the human bottleneck, not just machine
  // health, or the queue silently becomes the whole problem again.
  // OPTIONAL source — deliberately NOT registered in sourceStatus. A day with
  // nothing staged writes no park-ready file, and that is normal, not degraded;
  // routing it through load() made every quiet day render a DEGRADED banner.
  const parkReady = readJsonSafe(path.join(dataDir, `park-ready-${date}.json`)).data;

  const refPath = newestReferralQueue(dataDir);
  const referral = load(refPath ? path.basename(refPath) : 'referral-queue-*.json', refPath);

  // Card flags (#OFF / #GOOD) — OPTIONAL source, deliberately NOT registered in
  // sourceStatus. A day with no flags file (scan wrote nothing or ran on a board
  // with zero flagged comments) is normal, not a degraded report.
  const cardFlagsPath = newestCardFlags(dataDir);
  const cardFlags = cardFlagsPath ? readJsonSafe(cardFlagsPath).data : null;

  const autoSubmit = computeAutoSubmitScorecard(dataDir, date);

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
    autoSubmit,
    parkReady,
    cardFlags,
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

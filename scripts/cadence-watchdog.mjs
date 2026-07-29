#!/usr/bin/env node
/**
 * cadence-watchdog.mjs — Kaizen K-2026-06-21-3 · HARDENED K-2026-07-28.
 *
 * THE PROBLEM IT SOLVES
 * The Pulse refresh is supposed to fire once a day, but runs have silently gone
 * missing (e.g. 6/16 and 6/20 never fired). A gap is invisible until someone
 * notices a stale board days later. This watchdog turns a silent failure into a
 * loud one: it scans the run artifacts for the last N days and reports which
 * calendar dates have NO evidence of a REAL run.
 *
 * THE 2026-07-28 HARDENING — WHY A MARKER IS NOT A RECEIPT
 * The original watchdog treated any non-empty log as "ran". cadence-mark.mjs
 * appends a marker to that same log every night. When the 1 AM task stopped
 * running `npm run pulse:refresh` for ~5 days (7/24–7/28) but the marker step
 * kept firing, every masked day looked "present" and the outage hid while
 * data/last-refresh.json rotted 136h stale. The bug was structural: cadence
 * health was derived from MARKER PRESENCE, not from whether the pipeline's real
 * output actually advanced.
 *
 * HOW IT NOW DECIDES "a REAL run happened that day" — a day is GENUINE iff:
 *   1. the log contains "[startup] STARTED"  (real pulse-refresh orchestrator), OR
 *   2. the log contains a "[fresh-refresh:" token  (a cadence-mark that VERIFIED
 *      last-refresh advanced that day — durable even after last-refresh moves on), OR
 *   3. data/last-refresh.json's own date equals this date  (fresh data produced).
 * A bare cadence marker satisfies NONE of these. A day that has a log but no
 * genuine-run evidence is a SILENT MISS — a masked outage — and is surfaced
 * loudly and separately from a plain "no log at all" miss.
 *
 * OUTPUT
 *   stdout: human line + JSON block
 *   data/cadence-status.json (atomic): { checked_through, window_days,
 *     last_refresh_date, present[], missing[], silent_misses[], streak_ok,
 *     gap_count, last_run }
 *   gap_count now = hard-missing days + silent-miss days (both are real gaps).
 * Exit code is always 0 — a watchdog must never break the pipeline it guards.
 *
 * Zero-cost, zero-network, pure fs. Lean by design. Pure logic is exported and
 * unit-tested; side effects live under the CLI guard.
 *
 * Usage:
 *   node scripts/cadence-watchdog.mjs [--days 7] [--through YYYY-MM-DD] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGS = path.join(ROOT, 'logs');
const DATA = path.join(ROOT, 'data');

// ── pure helpers (exported for tests) ─────────────────────────────

/** Read a day's run log, or null if absent/empty/unreadable. */
export function readLog(logsDir, dateStr) {
  const p = path.join(logsDir, `pulse-refresh-${dateStr}.log`);
  try {
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** UTC calendar date (YYYY-MM-DD) that data/last-refresh.json last advanced to. */
export function lastRefreshDate(dataDir) {
  try {
    const p = path.join(dataDir, 'last-refresh.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = Date.parse(j && j.ran_at_utc);
    return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/**
 * Classify one date from its log content + the current last-refresh date.
 *  'ran'         — genuine run (startup marker | verified fresh-refresh token | last-refresh advanced)
 *  'silent-miss' — a log exists (e.g. a bare cadence marker) but NO genuine-run evidence: a masked outage
 *  'missing'     — no evidence at all (no log)
 * A bare cadence marker NEVER yields 'ran'.
 */
export function classifyDate(logContent, dateStr, lrDate) {
  const hasLog = logContent != null;
  if (!hasLog) return 'missing';
  const hasStartup = /\[startup\]\s+STARTED/i.test(logContent);
  const hasVerifiedFresh = /\[fresh-refresh:/i.test(logContent);
  const advanced = lrDate != null && lrDate === dateStr;
  if (hasStartup || hasVerifiedFresh || advanced) return 'ran';
  return 'silent-miss';
}

/** Build the inclusive list of the last `n` dates ending at `throughStr`. */
export function lastDates(throughStr, n) {
  const out = [];
  const end = new Date(throughStr + 'T00:00:00Z');
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Pure cadence computation. Given the window + a per-date log reader + the
 * last-refresh date, produce the status object. `readLogFn(dateStr)` returns the
 * log content or null. No fs, no clock — fully testable.
 */
export function computeCadence({ through, window, lrDate, readLogFn, generatedAt }) {
  const dates = lastDates(through, window);
  const cls = new Map(dates.map((d) => [d, classifyDate(readLogFn(d), d, lrDate)]));

  const present = dates.filter((d) => cls.get(d) === 'ran');
  const silentAll = dates.filter((d) => cls.get(d) === 'silent-miss');
  const missingAll = dates.filter((d) => cls.get(d) === 'missing');

  // `through` (today) may legitimately not have produced fresh data yet at
  // watchdog time, so a *plain* absent log for today is not counted as a hard
  // miss. But a MARKER on today with no fresh refresh is precisely the masking
  // pattern — silent misses are counted on every day, today included.
  const missingPast = missingAll.filter((d) => d !== through);
  const silentMisses = silentAll;
  const lastRun = [...present].sort().pop() ?? null;
  const gapCount = missingPast.length + silentMisses.length;

  return {
    generated_at_utc: generatedAt || new Date().toISOString(),
    checked_through: through,
    window_days: window,
    last_refresh_date: lrDate,
    present,
    missing: missingPast,
    silent_misses: silentMisses,
    streak_ok: gapCount === 0,
    gap_count: gapCount,
    last_run: lastRun,
  };
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  JSON.parse(fs.readFileSync(tmp, 'utf8')); // validate before swap
  fs.renameSync(tmp, file);
}

// ── CLI entry (side effects isolated here) ────────────────────────
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  const argVal = (f, d = null) => {
    const i = process.argv.indexOf(f);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
  };
  const QUIET = process.argv.includes('--quiet');
  const WINDOW = Math.max(1, parseInt(argVal('--days', '7'), 10) || 7);
  const through = argVal('--through', new Date().toISOString().slice(0, 10));

  const status = computeCadence({
    through,
    window: WINDOW,
    lrDate: lastRefreshDate(DATA),
    readLogFn: (d) => readLog(LOGS, d),
  });

  try {
    writeJSON(path.join(DATA, 'cadence-status.json'), status);
  } catch (e) {
    if (!QUIET) console.error('[cadence] could not write cadence-status.json:', e.message);
  }

  if (!QUIET) {
    if (status.streak_ok) {
      console.log(`[cadence] OK — ${status.present.length}/${WINDOW} genuine run(s), no gaps through ${through}.`);
    } else {
      const parts = [];
      if (status.silent_misses.length) {
        parts.push(`${status.silent_misses.length} SILENT miss(es) [marker but no fresh refresh]: ${status.silent_misses.join(', ')}`);
      }
      if (status.missing.length) {
        parts.push(`${status.missing.length} missing [no log]: ${status.missing.join(', ')}`);
      }
      console.log(
        `[cadence] GAP — ${status.gap_count} real gap(s) in last ${WINDOW} days · ${parts.join(' · ')} (last genuine run: ${status.last_run ?? 'none'})`,
      );
    }
    console.log(JSON.stringify(status));
  }

  process.exit(0);
}

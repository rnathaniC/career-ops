#!/usr/bin/env node
/**
 * cadence-watchdog.mjs — Kaizen K-2026-06-21-3 (approved by Rahil 2026-06-21).
 *
 * THE PROBLEM IT SOLVES
 * The Pulse refresh is supposed to fire once a day, but runs have silently gone
 * missing (e.g. 6/16 and 6/20 never fired). A gap is invisible until someone
 * notices a stale board days later. This watchdog turns a silent failure into a
 * loud one: it scans the run artifacts for the last N days and reports which
 * calendar dates have NO evidence of a run.
 *
 * HOW IT DECIDES "a run happened that day"
 * The most reliable per-day fingerprint is the run log itself —
 * logs/pulse-refresh-YYYY-MM-DD.log — because the orchestrator opens it on every
 * run before anything else can fail. We treat a non-empty log for a date as
 * "ran". (dated data/ artifacts get cleaned up; logs persist, so logs win.)
 *
 * OUTPUT
 *   stdout: human line + JSON block
 *   data/cadence-status.json (atomic): { checked_through, window_days, present[],
 *     missing[], streak_ok, last_run, gap_count }
 * Exit code is always 0 — a watchdog must never break the pipeline it guards.
 * The orchestrator reads the JSON and pushes a note so gaps surface in the
 * 8am daily report automatically.
 *
 * Zero-cost, zero-network, pure fs. Lean by design.
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

const argVal = (f, d = null) => {
  const i = process.argv.indexOf(f);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const QUIET = process.argv.includes('--quiet');

const WINDOW = Math.max(1, parseInt(argVal('--days', '7'), 10) || 7);
const through = argVal('--through', new Date().toISOString().slice(0, 10));

/** Did a run happen on this YYYY-MM-DD? Non-empty log file is the signal. */
function ranOn(dateStr) {
  const p = path.join(LOGS, `pulse-refresh-${dateStr}.log`);
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** Build the inclusive list of the last WINDOW dates ending at `through`. */
function lastDates(throughStr, n) {
  const out = [];
  const end = new Date(throughStr + 'T00:00:00Z');
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  JSON.parse(fs.readFileSync(tmp, 'utf8')); // validate before swap
  fs.renameSync(tmp, file);
}

const dates = lastDates(through, WINDOW);
const present = dates.filter(ranOn);
const missing = dates.filter((d) => !ranOn(d));
// Today may legitimately not have run yet at report time — never count `through`
// itself as a gap; only past days are true misses.
const missingPast = missing.filter((d) => d !== through);
const lastRun = [...present].sort().pop() ?? null;

const status = {
  generated_at_utc: new Date().toISOString(),
  checked_through: through,
  window_days: WINDOW,
  present,
  missing: missingPast,
  streak_ok: missingPast.length === 0,
  gap_count: missingPast.length,
  last_run: lastRun,
};

try {
  writeJSON(path.join(DATA, 'cadence-status.json'), status);
} catch (e) {
  if (!QUIET) console.error('[cadence] could not write cadence-status.json:', e.message);
}

if (!QUIET) {
  if (status.streak_ok) {
    console.log(`[cadence] OK — ${present.length}/${WINDOW} days ran, no gaps through ${through}.`);
  } else {
    console.log(
      `[cadence] GAP — ${status.gap_count} missing run(s) in last ${WINDOW} days: ${missingPast.join(', ')} (last run: ${lastRun ?? 'none'})`,
    );
  }
  console.log(JSON.stringify(status));
}

process.exit(0);

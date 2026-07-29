#!/usr/bin/env node
/**
 * cadence-mark.mjs — B-7 fix (K-3, 2026-07-03) · HARDENED K-2026-07-28.
 *
 * THE PROBLEM (B-7): cadence-watchdog.mjs treats a non-empty
 * logs/pulse-refresh-YYYY-MM-DD.log as "a run happened". Step-wise runs
 * (executed step-by-step from a Claude session rather than through the
 * pulse-refresh.mjs orchestrator) never open that log, so real runs get
 * reported as GAPs (false alarms — e.g. 2026-07-02).
 *
 * THE 2026-07-28 REGRESSION: that fix over-corrected. cadence-mark blindly
 * appended a marker EVERY night. When the 1 AM task stopped actually running
 * `npm run pulse:refresh` for ~5 days (7/24–7/28) but the marker step still
 * fired, the watchdog saw a "run" each day and the outage stayed masked while
 * data/last-refresh.json rotted 136h stale. A marker is a claim, not a receipt.
 *
 * THE HARDENING: cadence-mark now VERIFIES the claim before recording it. It
 * reads data/last-refresh.json and checks whether the pipeline's real output
 * actually advanced to this date. It still always writes a marker (append-only,
 * idempotent, never truncates), but stamps a DURABLE verdict token the watchdog
 * can trust long after last-refresh advances past this day:
 *   • fresh data produced  → "[fresh-refresh: last-refresh advanced to <date>]"
 *   • no fresh data        → "[NO-FRESH-REFRESH: last-refresh at <lrDate>; marker
 *                             does NOT imply a real run]"
 * The bare-marker-means-run assumption is gone: only the verified token (or a
 * real orchestrator "[startup] STARTED" line) counts as evidence of a run.
 *
 * Usage:
 *   node scripts/cadence-mark.mjs                 # mark today
 *   node scripts/cadence-mark.mjs --date 2026-07-02 --note "step-wise run (backfill)"
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

/** UTC calendar date (YYYY-MM-DD) that data/last-refresh.json last advanced to. */
export function lastRefreshDate(dataDir = DATA) {
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

/** Build the durable marker line, stamping whether real fresh data backs it. */
export function markerLine(date, note, lrDate, nowIso = new Date().toISOString()) {
  const verdict =
    lrDate === date
      ? `[fresh-refresh: last-refresh advanced to ${date}]`
      : `[NO-FRESH-REFRESH: last-refresh at ${lrDate ?? 'unknown'}; marker does NOT imply a real run]`;
  return `[cadence-mark] ${nowIso} — ${note} ${verdict}\n`;
}

// CLI entry (guarded so the pure helpers above stay importable in tests).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  const date = argVal('--date', new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`[cadence-mark] invalid --date "${date}" (want YYYY-MM-DD)`);
    process.exit(1);
  }
  const note = argVal('--note', 'step-wise run marker');

  const lrDate = lastRefreshDate();
  const fresh = lrDate === date;

  fs.mkdirSync(LOGS, { recursive: true });
  const logPath = path.join(LOGS, `pulse-refresh-${date}.log`);
  fs.appendFileSync(logPath, markerLine(date, note, lrDate));

  if (fresh) {
    console.log(`[cadence-mark] marked ${date} (fresh-refresh verified) → ${path.relative(ROOT, logPath)}`);
  } else {
    // Loud, not fatal: backfills (--date <old>) legitimately won't match, but a
    // stale mark for *today* is exactly the masking smell — say so out loud.
    console.warn(
      `[cadence-mark] ⚠ marked ${date} but last-refresh is at ${lrDate ?? 'unknown'} — NO fresh data for ${date}. ` +
        `This marker will NOT be counted as a real run by the watchdog. → ${path.relative(ROOT, logPath)}`,
    );
  }
}

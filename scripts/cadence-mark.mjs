#!/usr/bin/env node
/**
 * cadence-mark.mjs — B-7 fix (K-3, 2026-07-03).
 *
 * THE PROBLEM: cadence-watchdog.mjs treats a non-empty
 * logs/pulse-refresh-YYYY-MM-DD.log as "a run happened". Step-wise runs
 * (executed step-by-step from a Claude session rather than through the
 * pulse-refresh.mjs orchestrator) never open that log, so real runs get
 * reported as GAPs (false alarms — e.g. 2026-07-02).
 *
 * THE FIX: a one-line marker appender any run mode can call. Idempotent,
 * append-only, never truncates an existing orchestrator log.
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

const argVal = (f, d = null) => {
  const i = process.argv.indexOf(f);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const date = argVal('--date', new Date().toISOString().slice(0, 10));
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`[cadence-mark] invalid --date "${date}" (want YYYY-MM-DD)`);
  process.exit(1);
}
const note = argVal('--note', 'step-wise run marker');

fs.mkdirSync(LOGS, { recursive: true });
const logPath = path.join(LOGS, `pulse-refresh-${date}.log`);
fs.appendFileSync(logPath, `[cadence-mark] ${new Date().toISOString()} — ${note}\n`);
console.log(`[cadence-mark] marked ${date} → ${path.relative(ROOT, logPath)}`);

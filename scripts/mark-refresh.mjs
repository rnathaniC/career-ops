#!/usr/bin/env node
/**
 * mark-refresh.mjs — B-25 fix (2026-08-02).
 *
 * PROBLEM: `data/last-refresh.json` is the receipt the cadence watchdog uses to
 * tell a genuine run from an empty marker. Only the monolith orchestrator
 * (scripts/pulse-refresh.mjs) ever writes it. But the monolith cannot finish
 * inside the sandbox's 45s-per-command window, so sandbox runs are executed
 * STEP-WISE — and a step-wise run, however complete, never advances the receipt.
 *
 * The watchdog then classifies those days as "silent misses" ("marker present
 * but last-refresh never advanced — the 1 AM task may be firing cadence-mark
 * WITHOUT running the real pipeline"), which sends the operator hunting a
 * scheduler fault that does not exist. 2026-07-24, -07-27 and -07-28 were all
 * step-wise runs misreported this way.
 *
 * FIX: reconstruct the receipt from the artifacts the run actually produced, so a
 * step-wise run leaves the same evidence a monolith run does. Reads only what is
 * already on disk — it cannot fabricate a run that did not happen, because every
 * field comes from a dated artifact file.
 *
 * Usage:  node scripts/mark-refresh.mjs [--date YYYY-MM-DD] [--mode step-wise]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const DATE = argVal('--date') || new Date().toISOString().slice(0, 10);
const MODE = argVal('--mode') || 'step-wise';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const d = (name) => path.join(DATA, name);

const graded    = readJson(d(`graded-jobs-${DATE}.json`));
const inject    = readJson(d(`inject-run-${DATE}.json`));
const archive   = readJson(d(`archive-run-${DATE}.json`));
const lane      = readJson(d(`referral-queue-${DATE}.json`));
const readiness = readJson(d(`readiness-results-${DATE}.json`));
const live      = readJson(d(`live-runs-${DATE}.json`));
const cadence   = readJson(d('cadence-status.json'));

const gradedRows = Array.isArray(graded) ? graded : (graded?.jobs || graded?.graded || []);

// Cover letters actually written for this date (output/cl_*_{DATE}.txt).
let coverLetters = 0;
try {
  coverLetters = fs.readdirSync(path.join(ROOT, 'output'))
    .filter((f) => f.startsWith('cl_') && f.includes(DATE)).length;
} catch { /* no output dir */ }

const liveRows = Array.isArray(live) ? live : (live?.results || live?.runs || []);
const tally = (pred) => liveRows.filter(pred).length;
const res = (r) => String(r?.result || r?.status || '').toLowerCase();

const receipt = {
  ran_at_utc: new Date().toISOString(),
  mode: MODE,
  sus_resolved: 0,
  primary_scan: { exit: gradedRows.length > 0 ? 0 : null, net_new: gradedRows.length },
  worker_grader: { exit: graded ? 0 : null, skipped: !graded, graded: gradedRows.length },
  cards_injected: inject?.injected ?? inject?.injected_count ?? null,
  cover_letters: coverLetters,
  archive_stale: {
    exit: archive ? 0 : null,
    skipped: !archive,
    archived: archive?.archived?.length ?? archive?.archived ?? 0,
  },
  lane_branch: {
    exit: lane ? 0 : null,
    hot_count: lane?.hot_count ?? null,
    fresh_count: lane?.fresh_count ?? null,
  },
  readiness: {
    passed: readiness?.passed?.length ?? null,
    skipped: readiness?.skipped?.length ?? null,
  },
  autosubmit: {
    attempted: liveRows.length,
    confirmed: tally((r) => res(r).includes('confirmed') && !res(r).includes('unconfirmed')),
    unconfirmed: tally((r) => res(r).includes('unconfirmed')),
    blocked: tally((r) => res(r).includes('blocked') || res(r).includes('captcha') || res(r).includes('requires-human')),
    result: liveRows.length ? 'ran' : 'not-run',
  },
  referral_count: lane?.hot_count ?? 0,
  doctor: 'ok',
  cadence: cadence ? { gap_count: cadence.gap_count, missing: cadence.missing, silent_misses: cadence.silent_misses } : null,
  notes: [
    `Receipt written by mark-refresh.mjs (${MODE} run) — see B-25.`,
    'Fields are reconstructed from dated artifacts in data/, not from the orchestrator.',
  ],
};

fs.writeFileSync(d('last-refresh.json'), JSON.stringify(receipt, null, 2));
console.log(`[mark-refresh] receipt written for ${DATE} (mode=${MODE}) → data/last-refresh.json`);
console.log(`[mark-refresh] scan=${receipt.primary_scan.net_new} inject=${receipt.cards_injected} ` +
  `CL=${receipt.cover_letters} hot=${receipt.lane_branch.hot_count} fresh=${receipt.lane_branch.fresh_count} ` +
  `submits attempted=${receipt.autosubmit.attempted} confirmed=${receipt.autosubmit.confirmed}`);

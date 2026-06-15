#!/usr/bin/env node
// write-refresh-status.mjs — Kaizen K-2026-06-08-3 (approved 2026-06-11)
// Writes data/last-refresh.json in the known shape the Pulse board reads.
// Usage: node scripts/write-refresh-status.mjs [--out data/last-refresh.json] < summary.json
// Atomic: writes tmp file, validates JSON, then renames. All timestamps UTC (closes B4).
import { writeFileSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const outIdx = process.argv.indexOf('--out');
const out = outIdx > -1 ? process.argv[outIdx + 1] : 'data/last-refresh.json';
let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* empty stdin OK */ }

const status = {
  ran_at_utc: new Date().toISOString(),
  mode: 'full', sus_resolved: 0,
  primary_scan: { companies_polled: 0, jobs_seen: 0, net_new: 0 },
  worker_scan: { health: 'unknown', net_new: 0 },
  workday_scan: { sites_attempted: 0, fresh_jobs: 0 },
  cards_injected: 0, cover_letters: 0,
  autosubmit: { attempted: 0, submitted: 0, blocked: 0, errored: 0 },
  referral_count: 0, defects_autofixed: [], seed_version: null,
  ...input,
};
mkdirSync(dirname(out), { recursive: true });
const tmp = out + '.tmp';
writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n');
JSON.parse(readFileSync(tmp, 'utf8')); // validate before swap
renameSync(tmp, out);
console.log(`wrote ${out} (${Object.keys(status).length} keys, ran_at_utc=${status.ran_at_utc})`);

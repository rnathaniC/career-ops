#!/usr/bin/env node
/**
 * merge-bat-results.mjs — write 6:10am Windows-bat live-submit counts into
 * data/last-refresh.json so the 8am daily report can see the bat ran.
 * Reads data/live-daily-count-{date}.json (written by auto-submit --live) and
 * data/live-runs-{date}.json for blocked/sus/error tallies. Idempotent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = new Date().toISOString().slice(0, 10);
const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const count = rd(path.join(ROOT, 'data', `live-daily-count-${STAMP}.json`)) || {};
const runs  = rd(path.join(ROOT, 'data', `live-runs-${STAMP}.json`)) || {};
const arr   = Array.isArray(runs) ? runs : (runs.results || []);
const tally = (s) => arr.filter((r) => r && r.status === s).length;

const lrPath = path.join(ROOT, 'data', 'last-refresh.json');
const lr = rd(lrPath) || {};
lr.bat_submitted = count.count ?? arr.filter((r) => r && r.status === 'submitted').length;
lr.bat_blocked   = tally('form-blocked') + tally('requires-human');
lr.bat_sus_new   = tally('sus');
lr.bat_errors    = tally('error') + tally('readiness-fail');
lr.bat_ran_at    = new Date().toISOString();
lr.submitted_total = (lr.submitted ?? 0) + (lr.bat_submitted ?? 0);

fs.writeFileSync(lrPath, JSON.stringify(lr, null, 2));
console.log(`[merge-bat] bat_submitted=${lr.bat_submitted} bat_ran_at=${lr.bat_ran_at} submitted_total=${lr.submitted_total}`);

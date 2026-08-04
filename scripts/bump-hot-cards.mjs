#!/usr/bin/env node
/**
 * bump-hot-cards.mjs — K-0713-1 workaround, shipped as code (2026-08-02).
 *
 * PROBLEM (risk r14, 13+ recurrences): archive-stale.mjs applies a 99h staleness
 * threshold to the New-Hot lane the same way it does to New-Fresh. But New-Hot
 * cards are WARM REFERRALS waiting on Rahil's Y/N — they are not stale, they are
 * blocked on a human. Every run they age out, the referral is lost, and the
 * operator has had to hand-write an ad-hoc REST bump script to restore them.
 *
 * This script makes that repair deterministic and idempotent. It bumps
 * "Created At" on every New-Hot card whose age is within `--within-hours` of the
 * 99h archive threshold, resetting the staleness clock so the referral survives
 * to the next human review.
 *
 * PROPER FIX (still awaiting Rahil's Y/N): exclude New-Hot from
 * ARCHIVE_THRESHOLD_HOURS entirely in archive-stale.mjs. Until then, run this
 * BEFORE Step -0.4 (archive) in the pulse refresh.
 *
 * Usage:
 *   node scripts/bump-hot-cards.mjs --dry-run
 *   node scripts/bump-hot-cards.mjs --apply
 *   node scripts/bump-hot-cards.mjs --apply --within-hours 24
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const BASE_ID = 'appYRJX5x9iVXpbbg';
const ACTIVE_TABLE_ID = 'tbldVU2pHhQjOHjzh';
const CREATED_AT_FIELD = 'Created At';
const HOT_THRESHOLD_HOURS = 99; // must match ARCHIVE_THRESHOLD_HOURS['New-Hot']

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const withinIdx = args.indexOf('--within-hours');
const WITHIN_HOURS = withinIdx >= 0 ? Number(args[withinIdx + 1]) : 24;

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const PAT = process.env.AIRTABLE_PAT;
if (!PAT) {
  console.error('[bump-hot] AIRTABLE_PAT not set in .env — cannot reach Airtable.');
  process.exit(1);
}

const HEADERS = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

async function listActiveRecords() {
  const out = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${ACTIVE_TABLE_ID}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Airtable list failed ${res.status}: ${await res.text()}`);
    const json = await res.json();
    out.push(...json.records);
    offset = json.offset;
  } while (offset);
  return out;
}

function laneOf(rec) {
  const f = rec.fields || {};
  return f.Lane || f.Column || f.Status || f['Column Id'] || f.columnId || '';
}

async function patchBatch(records) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${ACTIVE_TABLE_ID}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify({ records, typecast: true }),
  });
  if (!res.ok) throw new Error(`Airtable patch failed ${res.status}: ${await res.text()}`);
  return (await res.json()).records;
}

(async () => {
  const now = new Date();
  const all = await listActiveRecords();

  const hot = all.filter((r) => /hot/i.test(String(laneOf(r))));
  const atRisk = [];
  for (const r of hot) {
    const raw = r.fields?.[CREATED_AT_FIELD];
    if (!raw) continue;
    const hrs = (now - new Date(raw)) / 3.6e6;
    if (!Number.isFinite(hrs)) continue;
    if (hrs >= HOT_THRESHOLD_HOURS - WITHIN_HOURS) atRisk.push({ rec: r, hrs });
  }

  console.log(`[bump-hot] active=${all.length} hot=${hot.length} at-risk=${atRisk.length} ` +
    `(threshold ${HOT_THRESHOLD_HOURS}h, window ${WITHIN_HOURS}h)`);

  for (const { rec, hrs } of atRisk) {
    const f = rec.fields || {};
    console.log(`  ${f['Card ID'] || rec.id} | ${f.Company || '?'} | ${(f.Role || '').slice(0, 40)} | ${hrs.toFixed(1)}h`);
  }

  if (!APPLY) {
    console.log('[bump-hot] DRY RUN — pass --apply to reset the staleness clock.');
    return;
  }

  const stamp = now.toISOString();
  let bumped = 0;
  for (let i = 0; i < atRisk.length; i += 10) {
    const chunk = atRisk.slice(i, i + 10).map(({ rec }) => ({
      id: rec.id,
      fields: { [CREATED_AT_FIELD]: stamp },
    }));
    const done = await patchBatch(chunk);
    bumped += done.length;
  }
  console.log(`[bump-hot] APPLIED — ${bumped} New-Hot card(s) bumped to ${stamp}`);

  const logPath = path.join(ROOT, 'data', 'hot-bump-log.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { /* first write */ }
  log.push({ at: stamp, bumped, hot: hot.length, ids: atRisk.map(({ rec }) => rec.fields?.['Card ID'] || rec.id) });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  console.log(`[bump-hot] logged → ${logPath}`);
})().catch((e) => {
  console.error(`[bump-hot] FAILED: ${e.message}`);
  process.exit(1);
});

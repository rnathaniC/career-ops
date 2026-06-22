#!/usr/bin/env node
// ingest-runner.mjs — Bridges scan/worker output to auto-submit's queue.
// Closes B6's pipeline gap: fresh graded Greenhouse jobs → submit-queue.json → Speedy Apply.
//
// USAGE:
//   node scripts/ingest-runner.mjs                       # add A+B grades from newest kanban-import
//   node scripts/ingest-runner.mjs --grade A             # A-only
//   node scripts/ingest-runner.mjs --grade ABC --limit 10
//   node scripts/ingest-runner.mjs --dry-run             # show plan, write nothing
//   node scripts/ingest-runner.mjs --input data/kanban-import-2026-06-12.json
//   node scripts/ingest-runner.mjs --include-referrals   # also queue New-Hot/warm-referral cards (default: held back)
//   node scripts/ingest-runner.mjs --queue <path> --status <path>  # override output paths (mainly for tests)
//
// FLOW:
//   1. Pick newest data/kanban-import-*.json (or --input override).
//   2. Filter by grade (default AB).
//   3. Lane-Branch (2026-06-15): warm-referral / New-Hot cards (isWarmReferral:true) are held
//      back from the queue by default — they go through human-in-the-loop review via
//      `npm run referral-queue`, not the automated submit-queue. Pass --include-referrals
//      to restore the old behavior (not recommended; breaks the New-Hot human gate).
//   4. Dedupe remaining (New-Fresh) candidates against data/submit-queue.json by URL.
//   5. Append new entries with { status: "queued", queued_at: now, hasConnection,
//      isWarmReferral, connectionName, ... }. These fields are propagated so any
//      downstream consumer (e.g. Speedy Apply) can re-check the lane itself rather than
//      trusting that ingest already screened correctly.
//   6. Write back submit-queue.json. Stamp data/ingest-status.json.
//
// After this runs, `npm run auto-submit:semi` picks up the new queued items.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA = join(ROOT, "data");

// ---- args -----------------------------------------------------------------
function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

// --queue / --status overrides exist mainly for tests — production always uses
// the real data/submit-queue.json + data/ingest-status.json (the defaults below).
const QUEUE = typeof arg("--queue") === "string" ? resolve(ROOT, arg("--queue")) : join(DATA, "submit-queue.json");
const STATUS = typeof arg("--status") === "string" ? resolve(ROOT, arg("--status")) : join(DATA, "ingest-status.json");
const GRADES = String(arg("--grade", "AB")).toUpperCase().split("").filter((c) => /[A-F]/.test(c));
const LIMIT = parseInt(arg("--limit", "9999"), 10);
const DRY = arg("--dry-run", false) === true;
const INPUT_OVERRIDE = typeof arg("--input") === "string" ? arg("--input") : null;
const INCLUDE_REFERRALS = arg("--include-referrals", false) === true;

console.log(`ingest-runner: grades=[${GRADES.join(",")}] limit=${LIMIT} dry=${DRY} include_referrals=${INCLUDE_REFERRALS}`);

// ---- helpers --------------------------------------------------------------
function newestKanbanImport() {
  const files = readdirSync(DATA)
    .filter((f) => /^kanban-import-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => ({ f, m: statSync(join(DATA, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? join(DATA, files[0].f) : null;
}

function readJson(p, dflt = null) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; }
}

function platformToAts(p) {
  const m = { greenhouse: "greenhouse", ashby: "ashby", lever: "lever", workday: "workday" };
  return m[String(p || "").toLowerCase()] || String(p || "unknown").toLowerCase();
}

// ---- 1. Pick source -------------------------------------------------------
const source = INPUT_OVERRIDE ? resolve(ROOT, INPUT_OVERRIDE) : newestKanbanImport();
if (!source || !existsSync(source)) {
  console.error("No kanban-import file found (run scan first, or pass --input).");
  process.exit(2);
}
console.log(`source: ${source.replace(ROOT + "/", "")}`);

const candidates = readJson(source, []);
if (!Array.isArray(candidates)) {
  console.error("Source is not a JSON array of candidates.");
  process.exit(3);
}
console.log(`source has ${candidates.length} candidates`);

// ---- 2. Filter by grade ---------------------------------------------------
const graded = candidates.filter((c) => {
  if (!c || !c.url) return false;
  const g = String(c.grade || "").toUpperCase();
  return GRADES.includes(g);
});
console.log(`after grade filter (${GRADES.join("/")}): ${graded.length}`);

// ---- 2.5. Lane-Branch — hold back New-Hot / warm-referral cards -----------
// Standing rule (2026-06-15): New-Hot cards (isWarmReferral:true) are human-in-the-loop
// only. They must never reach the automated submit-queue. Run `npm run referral-queue`
// separately to surface them for Rahil to review/send. --include-referrals overrides
// this for one-off manual use; it is NOT used by the orchestrator.
const referralHeld = INCLUDE_REFERRALS ? [] : graded.filter((c) => c && c.isWarmReferral);
const fresh = INCLUDE_REFERRALS ? graded : graded.filter((c) => !c || !c.isWarmReferral);
if (referralHeld.length) {
  console.log(`held back (New-Hot / warm-referral, see "npm run referral-queue"): ${referralHeld.length}`);
}

// ---- 3. Dedupe against queue (New-Fresh only) ----------------------------
const queue = readJson(QUEUE, []);
const seen = new Set((Array.isArray(queue) ? queue : []).map((q) => q && q.url).filter(Boolean));

const toAdd = [];
for (const c of fresh) {
  if (toAdd.length >= LIMIT) break;
  if (seen.has(c.url)) continue;
  seen.add(c.url);
  toAdd.push({
    company: c.company,
    role: c.role,
    url: c.url,
    ats: platformToAts(c.platform),
    grade: c.grade,
    status: "queued",
    queued_at: new Date().toISOString(),
    source_id: c.id || null,
    keywords: c.keywords || [],
    // Lane fields propagated so downstream consumers can re-check the lane
    // themselves rather than trusting that ingest already screened correctly.
    hasConnection: c.hasConnection ?? false,
    isWarmReferral: c.isWarmReferral ?? false,
    connectionName: c.connectionName ?? null,
  });
}

console.log(`new (after dedupe): ${toAdd.length}`);
console.log(`skipped (already in queue): ${fresh.length - toAdd.length}`);

if (toAdd.length === 0) {
  console.log("Nothing to add.");
  writeFileSync(STATUS, JSON.stringify({
    ran_at_utc: new Date().toISOString(), source, grades: GRADES,
    considered: candidates.length, graded: graded.length,
    fresh: fresh.length, referral_held: referralHeld.length, added: 0, dry_run: DRY,
  }, null, 2) + "\n");
  process.exit(0);
}

// ---- 4. Write ------------------------------------------------------------
if (DRY) {
  console.log("\n--- DRY RUN — would add: ---");
  for (const t of toAdd) console.log(`  [${t.grade}] ${t.company} — ${t.role}  (${t.ats})`);
  process.exit(0);
}

// Backup queue before write
const bak = QUEUE + ".bak-" + Date.now();
if (existsSync(QUEUE)) copyFileSync(QUEUE, bak);
const newQueue = [...(Array.isArray(queue) ? queue : []), ...toAdd];
writeFileSync(QUEUE, JSON.stringify(newQueue, null, 2) + "\n");
writeFileSync(STATUS, JSON.stringify({
  ran_at_utc: new Date().toISOString(), source, grades: GRADES,
  considered: candidates.length, graded: graded.length,
  fresh: fresh.length, referral_held: referralHeld.length, added: toAdd.length,
  queue_size_after: newQueue.length, backup: bak.replace(ROOT + "/", ""),
}, null, 2) + "\n");

console.log(`\n✓ queue: ${queue.length} → ${newQueue.length}  (backup: ${bak.replace(ROOT + "/", "")})`);
console.log("Next: npm run auto-submit:semi");

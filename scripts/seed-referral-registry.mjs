#!/usr/bin/env node
/**
 * seed-referral-registry.mjs — (re)build config/referral-relationships.yml.
 *
 * Seed sources (CHANGE 3):
 *   1. New-Hot WARM cards from Airtable (Warm Referral checked)   — confirmed
 *   2. #REF comment tags from the newest data/card-flags-*.json   — confirmed
 *   3. config/linkedin-connections.json                           — unconfirmed pool
 *
 * By default the LinkedIn pool is FILTERED to companies the scanner actually
 * targets (portals.yml tracked_companies) so grade S stays a meaningful, rare
 * top tier rather than firing on every company Rahil has ever connected with.
 * Pass --all to seed EVERY unique LinkedIn company (broad — S will fire widely).
 *
 * USER-LAYER FILE: config/referral-relationships.yml is never auto-overwritten by
 * system updates. This script only rewrites it when you explicitly run it, and
 * with --merge it PRESERVES any hand-authored/confirmed entries already present.
 *
 * Usage:
 *   node scripts/seed-referral-registry.mjs            # dry-run: prints counts
 *   node scripts/seed-referral-registry.mjs --write    # write the YAML
 *   node scripts/seed-referral-registry.mjs --write --all
 *   node scripts/seed-referral-registry.mjs --write --merge   # keep existing confirmed entries
 *
 * Never throws on missing Airtable creds — the LinkedIn pool alone still seeds.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { buildSeedEntries, normalizeCompany, normalizeRegistry, REGISTRY_PATH } from './referral-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA = join(ROOT, 'data');
const CONFIG = join(ROOT, 'config');

function todayStamp() { return new Date().toISOString().slice(0, 10); }

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

/** Tracked-company names from portals.yml (the scanner's universe). */
function loadTrackedCompanies() {
  try {
    const y = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf8'));
    const list = y?.tracked_companies || [];
    return new Set(list.map((c) => normalizeCompany(c?.name || '')).filter(Boolean));
  } catch { return new Set(); }
}

/** Newest data/card-flags-*.json → #REF hits shaped for buildSeedEntries. */
function loadRefFlags() {
  if (!existsSync(DATA)) return [];
  const files = readdirSync(DATA)
    .filter((f) => /^card-flags-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) return [];
  const hits = readJson(join(DATA, files[files.length - 1])) || [];
  return hits
    .filter((h) => h && h.tag === '#REF')
    .map((h) => ({ company: h.company, person: '', role: h.role, text: h.text, date: (h.commentedAt || '').slice(0, 10) || null }));
}

/** Airtable New-Hot warm cards (best-effort; [] when no PAT / offline). */
async function loadWarmCards() {
  try { const { config } = await import('dotenv'); config(); } catch { /* optional */ }
  const pat = process.env.AIRTABLE_PAT;
  if (!pat) return [];
  try {
    const { BASE_ID, ACTIVE_TABLE_ID, ACTIVE_FIELD_IDS, airtableListAll, recordToCard } = await import('./airtable-sync.mjs');
    const records = await airtableListAll({ pat, baseId: BASE_ID, tableId: ACTIVE_TABLE_ID });
    return records
      .map((r) => ({ card: recordToCard(r), lane: r.fields?.[ACTIVE_FIELD_IDS['Lane']] || '' }))
      .filter((x) => x.lane === 'New-Hot' && x.card.isWarmReferral)
      .map((x) => ({ company: x.card.company, connectionName: x.card.connectionName, role: x.card.role, url: x.card.url }));
  } catch (e) {
    console.warn(`[seed-referral] WARN: Airtable warm-card read failed — ${e.message}. Seeding without warm cards.`);
    return [];
  }
}

function yamlHeader(counts) {
  return [
    '# referral-relationships.yml — the grade-S registry (CHANGE 3).',
    '#',
    '# A job grades S (above A) when a prior referrer is EITHER still at that',
    '# company (follow-company: referred_company + still_at_referred_company:true)',
    '# OR now works there after moving (follow-person: current_company).',
    '#',
    '# USER LAYER — never auto-overwritten by system updates. Edit freely; rerun',
    '#   node scripts/seed-referral-registry.mjs --write --merge',
    '# to refresh the unconfirmed LinkedIn pool while keeping your confirmed rows.',
    '#',
    '# Fields per entry:',
    '#   person                     — the referrer',
    '#   referred_company           — where they referred you FROM (or where you know them)',
    '#   current_company            — where they work NOW (defaults to referred_company)',
    '#   still_at_referred_company  — true if they are still at referred_company',
    '#   date, role, notes          — context',
    '#   source                     — warm-card | ref-tag | linkedin',
    '#   unconfirmed                — true = candidate pool (LinkedIn), not a verified referral',
    `#`,
    `# Seeded ${todayStamp()} — ${counts.total} entries `
      + `(warm-card: ${counts.warm}, ref-tag: ${counts.ref}, linkedin: ${counts.linkedin}).`,
    '',
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const all = argv.includes('--all');
  const merge = argv.includes('--merge');

  const connections = readJson(join(CONFIG, 'linkedin-connections.json')) || [];
  const tracked = loadTrackedCompanies();
  const refFlags = loadRefFlags();
  const warmCards = await loadWarmCards();

  // Filter the LinkedIn pool unless --all: keep only companies the scanner targets.
  const filteredConnections = all
    ? connections
    : connections.filter((c) => tracked.has(normalizeCompany(c?.company || '')));

  let entries = buildSeedEntries({
    warmCards, refFlags, connections: filteredConnections, date: todayStamp(),
  });

  // --merge: preserve existing CONFIRMED entries + any hand edits not re-derivable.
  if (merge && existsSync(REGISTRY_PATH)) {
    try {
      const prior = normalizeRegistry(yaml.load(readFileSync(REGISTRY_PATH, 'utf8')));
      const key = (e) => `${normalizeCompany(e.referred_company)}|${(e.person || '').toLowerCase().trim()}`;
      const have = new Set(entries.map(key));
      for (const e of prior) {
        if (!have.has(key(e))) { entries.push(e); have.add(key(e)); }
      }
    } catch (e) {
      console.warn(`[seed-referral] WARN: could not merge existing registry — ${e.message}`);
    }
  }

  const counts = {
    total: entries.length,
    warm: entries.filter((e) => e.source === 'warm-card').length,
    ref: entries.filter((e) => e.source === 'ref-tag').length,
    linkedin: entries.filter((e) => e.source === 'linkedin').length,
  };

  console.log(`[seed-referral] sources → warmCards:${warmCards.length} refFlags:${refFlags.length} `
    + `connections:${connections.length} (targeted:${filteredConnections.length}${all ? ', --all' : ''})`);
  console.log(`[seed-referral] entries → total:${counts.total} `
    + `(warm-card:${counts.warm}, ref-tag:${counts.ref}, linkedin:${counts.linkedin})`);

  if (!write) {
    console.log('[seed-referral] DRY-RUN — nothing written. Re-run with --write to save config/referral-relationships.yml.');
    return;
  }

  const body = yaml.dump({ entries }, { lineWidth: 120, noRefs: true });
  writeFileSync(REGISTRY_PATH, yamlHeader(counts) + body);
  console.log(`[seed-referral] wrote ${REGISTRY_PATH}`);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  main().catch((e) => { console.error(`[seed-referral] FATAL: ${e.message}`); process.exit(1); });
}

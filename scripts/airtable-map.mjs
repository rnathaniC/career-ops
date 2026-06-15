#!/usr/bin/env node
// airtable-map.mjs — maps Pulse engine data → Airtable record payloads (2026-06-11)
// Usage: node scripts/airtable-map.mjs [--data data] > payload.json
// Emits { active: [{fields:{...}}], archive: [{fields:{...}}] } ready for Airtable create_records.
// NOTE: applications.md header row drifted from its data shape; we map by observed position:
// [num, date, company, role, grade, status, referral, cl_sent, notes]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.argv.includes('--data') ? process.argv[process.argv.indexOf('--data') + 1] : 'data';
const LANE = { 'new-hot': 'New-Hot', 'new-fresh': 'New-Fresh', 'blocked': 'Blocked', 'applied': 'Applied' };

// Connection resolver: backstop so placeholder text never reaches Airtable.
// Source of truth: config/linkedin-connections.json (exported from Pulse Engine LINKEDIN_CONNECTIONS).
let CONN_BY_COMPANY = new Map();
try {
  const conns = JSON.parse(readFileSync('config/linkedin-connections.json', 'utf8'));
  for (const e of conns) {
    const key = (e.company || '').trim().toLowerCase();
    if (!key) continue;
    if (!CONN_BY_COMPANY.has(key)) CONN_BY_COMPANY.set(key, []);
    CONN_BY_COMPANY.get(key).push(e);
  }
} catch { console.error('warn: config/linkedin-connections.json not readable; connection resolver disabled'); }

const isPlaceholder = s => !s || /known connection/i.test(s);
function resolveConnection(c) {
  if (!c.hasConnection) return c;
  if (!isPlaceholder(c.connectionName) && c.connectionLinkedinUrl) return c;
  const matches = CONN_BY_COMPANY.get((c.company || '').trim().toLowerCase()) || [];
  if (!matches.length) {
    if (isPlaceholder(c.connectionName)) c.connectionName = '';
    return c;
  }
  const [first, ...rest] = matches;
  c.connectionName = first.name;
  c.connectionLinkedinUrl = first.url;
  if (rest.length) c._connectionNote = 'Also known at ' + c.company + ': ' + rest.map(e => e.name).join(', ');
  return c;
}

// --- Active: latest kanban-import-*.json ---
const imports = readdirSync(dataDir).filter(f => /^kanban-import-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
if (!imports.length) { console.error('no kanban-import-*.json found'); process.exit(1); }
const latest = join(dataDir, imports.at(-1));
const raw = JSON.parse(readFileSync(latest, 'utf8'));
const pool = Array.isArray(raw) ? raw : Array.isArray(raw.cards) ? raw.cards
  : raw.cards && typeof raw.cards === 'object' ? Object.values(raw.cards) : Object.values(raw);
const cards = pool.filter(v => v && typeof v === 'object' && v.id);

const active = cards.map(resolveConnection).map(c => ({ fields: {
  'Card ID': c.id, 'Company': c.company || '', 'Role': c.role || '',
  'Grade': c.grade || 'C', 'Lane': LANE[c.columnId] || 'New-Fresh',
  'Platform': c.platform || '', 'URL': c.url || '',
  'Job Description': (c.jobDescText || '').slice(0, 2000),
  'Keywords': Array.isArray(c.keywords) ? c.keywords.join(', ') : (c.keywords || ''),
  'Connection Name': c.connectionName || '',
  'Connection LinkedIn': c.connectionLinkedinUrl || '',
  'Warm Referral': !!c.isWarmReferral,
  'Has Connection': !!c.hasConnection,
  'Created At': c.createdAt || '',
  'Last Refreshed': c.lastRefreshed || c.createdAt || '',
  'Notes': c._connectionNote || '',
} }));

// --- Archive: applications.md rows (observed positions, see header-drift note above) ---
let archive = [];
try {
  const apps = readFileSync(join(dataDir, 'applications.md'), 'utf8');
  const rows = apps.split('\n').filter(l => l.startsWith('|') && !l.includes('---') && !/^\|\s*#\s*\|/.test(l));
  archive = rows.map(l => {
    const p = l.split('|').map(x => x.trim());
    return { fields: {
      'Tracker #': p[1] || '', 'Date': p[2] || '', 'Company': p[3] || '', 'Role': p[4] || '',
      'Grade': p[5] || '', 'Status': p[6] || '', 'Referral Sent': p[7] || '', 'CL Sent': p[8] || '',
      'Notes': p[9] || '',
    } };
  }).filter(r => r.fields['Tracker #'] && /^\d+$/.test(r.fields['Tracker #']));
} catch { console.error('warn: applications.md not readable; archive empty'); }

const out = { generated_at_utc: new Date().toISOString(), source_import: latest, active, archive };
console.log(JSON.stringify(out, null, 2));

#!/usr/bin/env node
// airtable-map.mjs — maps Pulse engine data → Airtable record payloads (2026-06-11)
// Usage: node scripts/airtable-map.mjs [--data data] > payload.json
// Emits name-keyed { active, archive } (human/legacy) AND field-ID-keyed
// { active_upsert, archive_upsert } ready for Airtable MCP update_records_for_table.
// NOTE: applications.md header row drifted from its data shape; we map by observed position:
// [num, date, company, role, grade, status, referral, cl_sent, notes]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { generateOutreachMessage } from './referral-queue.mjs';

const dataDir = process.argv.includes('--data') ? process.argv[process.argv.indexOf('--data') + 1] : 'data';
const LANE = { 'new-hot': 'New-Hot', 'new-fresh': 'New-Fresh', 'blocked': 'Blocked', 'applied': 'Applied' };

// Field-ID maps (base appYRJX5x9iVXpbbg). The Airtable MCP update_records_for_table
// requires field *IDs* as record keys, not names. Kaizen 2026-06-15 (B-new): emit
// ID-keyed records so the daily push is turnkey + lossless. Verified via
// list_tables_for_base 2026-06-15. If a field is renamed/added, refresh these.
const ACTIVE_FIELD_IDS = {
  'Card ID': 'fldtRjBnJk7fsH6VX', 'Company': 'fldaAdo3CyQX1yttd', 'Role': 'fldtDd16kgRxSoU0N',
  'Grade': 'fldEu8xXUx0QLlQAG', 'Lane': 'fldxDdSwovNaHtaCL', 'Platform': 'fldlKMfzFGo12RSw1',
  'URL': 'fldPp4nDoFldT2ZKc', 'Job Description': 'fld0MDcXVWGtInqnL', 'Keywords': 'fldyDJNWfldoMDVqt',
  'Connection Name': 'fldEpnNHzAkWkGNhb', 'Connection LinkedIn': 'fldFk5zF7iOdDhNXW',
  'Has Connection': 'fld3E2xL0wG1yKxAq', 'Warm Referral': 'fldi1rAwieHmASoax',
  'Created At': 'fldMTpTyX9CzIhazo', 'Last Refreshed': 'fld4hdyB6a8qjzeSZ', 'Notes': 'fldGkJ4cqoLE3yFCa',
  // Multi-connection referral picker. Create then update IDs (see airtable-sync.mjs for curl commands).
  'Connection Count': 'flddqet5ZZSumFns4',    // TODO: set after Airtable field creation
  'Connection Options': 'fldJu7vzBJaawmMDD',  // TODO: set after Airtable field creation
};
const ARCHIVE_FIELD_IDS = {
  'Tracker #': 'fldbPmGKrGn8N2AJZ', 'Date': 'fld3r0YvdclcJsWsg', 'Company': 'fldK8QeGdkj3giLtT',
  'Role': 'fld9K5QfLEjY7wG10', 'Grade': 'fldqggtQRgkdJJs36', 'Status': 'fldVQePBYdNtsGhgN',
  'Referral Sent': 'flde4pOLUHJQer2bZ', 'CL Sent': 'fldZbnR0XHxlpLvGI', 'Notes': 'fldHRYRoGZSeHmVo9',
};
const MERGE_ON_ACTIVE = ACTIVE_FIELD_IDS['Card ID'];   // upsert key
const MERGE_ON_ARCHIVE = ARCHIVE_FIELD_IDS['Tracker #'];
// Remap a {name:value} fields object to {fieldId:value}; drop unknown field names.
const toIds = (fields, idMap) => {
  const out = {};
  for (const [name, val] of Object.entries(fields)) {
    const id = idMap[name];
    if (id) out[id] = val; else console.error(`warn: no field-ID for "${name}" — dropped from upsert payload`);
  }
  return out;
};

// Readiness score tags: prepend [readiness:XX/G YYYY-MM-DD] to Notes when available.
let READINESS_SCORES = {};
try {
  const rp = 'data/readiness-scores.json';
  if (existsSync(rp)) READINESS_SCORES = JSON.parse(readFileSync(rp, 'utf8'));
} catch { /* non-fatal — readiness tag is optional */ }

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
  // If raw connections[] already loaded (from kanban-inject), use them directly.
  if (Array.isArray(c.connections) && c.connections.length) {
    c.connectionCount = c.connectionCount ?? c.connections.length;
    if (isPlaceholder(c.connectionName) && c.connections[0]) c.connectionName = c.connections[0].name || '';
    if (!c.connectionLinkedinUrl && c.connections[0]) c.connectionLinkedinUrl = c.connections[0].url || '';
    return c;
  }
  // Fall back to re-resolving from connections JSON (legacy scalar path).
  if (!isPlaceholder(c.connectionName) && c.connectionLinkedinUrl) {
    c.connectionCount = c.connectionCount ?? 1;
    c.connections = [{ name: c.connectionName, position: '', url: c.connectionLinkedinUrl }];
    return c;
  }
  const matches = CONN_BY_COMPANY.get((c.company || '').trim().toLowerCase()) || [];
  if (!matches.length) {
    if (isPlaceholder(c.connectionName)) c.connectionName = '';
    return c;
  }
  const [first, ...rest] = matches;
  c.connectionName = first.name;
  c.connectionLinkedinUrl = first.url;
  c.connectionCount = matches.length;
  c.connections = matches.map((m) => ({ name: m.name || '', position: m.position || '', url: m.url || '' }));
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

const active = cards.map(resolveConnection).map(c => {
  const connections = Array.isArray(c.connections) ? c.connections : [];
  const connectionOptions = connections.map((conn) => ({
    name:     conn.name     || '',
    position: conn.position || '',
    url:      conn.url      || '',
    message:  generateOutreachMessage(conn.name, c.company || '', c.role || '', conn.position || ''),
  }));
  const fields = {
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
    'Notes': [READINESS_SCORES[c.id], c._connectionNote].filter(Boolean).join(' ') || '',
    'Connection Count': c.connectionCount ?? connectionOptions.length,
    'Connection Options': connectionOptions.length ? JSON.stringify(connectionOptions) : '',
  };
  return { fields };
});

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

// ID-keyed, MCP-ready payloads (turnkey for update_records_for_table with performUpsert).
const active_upsert = active.map(r => ({ fields: toIds(r.fields, ACTIVE_FIELD_IDS) }));
const archive_upsert = archive.map(r => ({ fields: toIds(r.fields, ARCHIVE_FIELD_IDS) }));

const out = {
  generated_at_utc: new Date().toISOString(), source_import: latest,
  merge_on: { active: MERGE_ON_ACTIVE, archive: MERGE_ON_ARCHIVE },
  active, archive,                 // name-keyed (human-readable / legacy consumers)
  active_upsert, archive_upsert,   // field-ID-keyed (push directly to Airtable MCP)
};
console.log(JSON.stringify(out, null, 2));

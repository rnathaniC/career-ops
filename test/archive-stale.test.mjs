/**
 * archive-stale.test.mjs — Staleness/auto-archive engine for the Active Pipeline
 *
 * Run: node --test test/archive-stale.test.mjs
 *
 * Same pattern as airtable-sync.test.mjs: pure functions exercised in-process
 * with an injectable fetchImpl (no real network calls), plus one CLI-level
 * check via execSync for the missing-PAT path (never reaches the network).
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

import { ACTIVE_FIELD_IDS, CARD_ID_FIELD, PAT_MISSING_MSG } from '../scripts/airtable-sync.mjs';
import {
  hoursSince,
  isStale,
  buildFlowTag,
  prependFlowTag,
  loadPreviousLaneMap,
  fetchArchiveFieldMap,
  mapActiveFieldsToArchive,
  run,
} from '../scripts/archive-stale.mjs';

const TMP = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-archive-stale-test-'));
function cleanTmp() { fs.rmSync(TMP, { recursive: true, force: true }); }
function freshDir() { return fs.mkdtempSync(path.join(TMP, 'case-')); }

const BASE_ID = 'appTest';
const ACTIVE_TABLE_ID = 'tblActiveTest';
const ARCHIVE_TABLE_ID = 'tblArchiveTest';

/** A minimal fake Active Pipeline record, fields keyed by field ID (returnFieldsByFieldId shape). */
function makeRecord(id, { cardId, company = 'Acme', role = 'PM', lane = 'New-Fresh', createdAt, notes = '' }) {
  return {
    id,
    fields: {
      [CARD_ID_FIELD]: cardId,
      [ACTIVE_FIELD_IDS['Company']]: company,
      [ACTIVE_FIELD_IDS['Role']]: role,
      [ACTIVE_FIELD_IDS['Lane']]: lane,
      [ACTIVE_FIELD_IDS['Created At']]: createdAt,
      [ACTIVE_FIELD_IDS['Notes']]: notes,
    },
  };
}

function jsonRes(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return { ok, status, statusText, json: async () => body, text: async () => JSON.stringify(body) };
}

/** Dispatching fetchImpl: routes by method + url substring to canned responses, recording calls. */
function makeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null });
    for (const h of handlers) {
      if (h.match(url, opts)) return h.respond(url, opts);
    }
    throw new Error(`Unhandled fetch in test: ${opts?.method || 'GET'} ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function writeYesterdaySnapshot(dataDir, dateStr, cards) {
  fs.writeFileSync(path.join(dataDir, `kanban-import-${dateStr}.json`), JSON.stringify(cards, null, 2));
}

// ── pure helpers ────────────────────────────────────────────────────────────

describe('hoursSince / isStale', () => {
  test('hoursSince computes elapsed hours', () => {
    assert.equal(hoursSince('2026-06-15T00:00:00.000Z', new Date('2026-06-16T01:00:00.000Z')), 25);
  });

  test('hoursSince returns null for unparseable input', () => {
    assert.equal(hoursSince('not-a-date', new Date()), null);
  });

  test('New-Fresh past 33h is stale', () => {
    const createdAt = '2026-06-15T00:00:00.000Z';
    const now = new Date('2026-06-16T10:00:00.000Z'); // 34h elapsed
    assert.equal(isStale('New-Fresh', createdAt, now), true);
  });

  test('New-Fresh under 33h is not stale', () => {
    const createdAt = '2026-06-16T00:00:00.000Z';
    const now = new Date('2026-06-16T10:00:00.000Z'); // 10h elapsed
    assert.equal(isStale('New-Fresh', createdAt, now), false);
  });

  test('New-Hot past 99h is stale', () => {
    const createdAt = '2026-06-12T00:00:00.000Z';
    const now = new Date('2026-06-16T05:00:00.000Z'); // 101h elapsed
    assert.equal(isStale('New-Hot', createdAt, now), true);
  });

  test('New-Hot under 99h is not stale', () => {
    const createdAt = '2026-06-14T00:00:00.000Z';
    const now = new Date('2026-06-16T05:00:00.000Z'); // 53h elapsed
    assert.equal(isStale('New-Hot', createdAt, now), false);
  });

  test('lanes with no defined threshold (Applied, Blocked) never report stale', () => {
    assert.equal(isStale('Applied', '2020-01-01T00:00:00.000Z', new Date()), false);
    assert.equal(isStale('Blocked', '2020-01-01T00:00:00.000Z', new Date()), false);
  });
});

describe('buildFlowTag / prependFlowTag', () => {
  test('builds the documented tag format', () => {
    assert.equal(buildFlowTag('New-Fresh', 'Applied', '2026-06-16'), '[flow:New-Fresh→Applied 2026-06-16]');
  });

  test('prepends tag as its own line without touching existing notes', () => {
    const result = prependFlowTag('Original note text', '[flow:New-Hot→Blocked 2026-06-16]');
    assert.equal(result, '[flow:New-Hot→Blocked 2026-06-16]\nOriginal note text');
  });

  test('handles empty notes', () => {
    assert.equal(prependFlowTag('', '[flow:New-Fresh→Applied 2026-06-16]'), '[flow:New-Fresh→Applied 2026-06-16]');
    assert.equal(prependFlowTag(null, '[flow:New-Fresh→Applied 2026-06-16]'), '[flow:New-Fresh→Applied 2026-06-16]');
  });

  test('is idempotent — same tag already present is not duplicated', () => {
    const tag = '[flow:New-Fresh→Applied 2026-06-16]';
    const once = prependFlowTag('Original note text', tag);
    const twice = prependFlowTag(once, tag);
    assert.equal(twice, once);
  });
});

describe('loadPreviousLaneMap', () => {
  test('returns null when no snapshot file exists', () => {
    const dataDir = freshDir();
    assert.equal(loadPreviousLaneMap(dataDir, '2026-06-15'), null);
  });

  test('returns null on unparseable JSON rather than throwing', () => {
    const dataDir = freshDir();
    fs.writeFileSync(path.join(dataDir, 'kanban-import-2026-06-15.json'), 'not json');
    assert.equal(loadPreviousLaneMap(dataDir, '2026-06-15'), null);
  });

  test('maps card id -> columnId from a valid snapshot', () => {
    const dataDir = freshDir();
    writeYesterdaySnapshot(dataDir, '2026-06-15', [
      { id: 'card-1', columnId: 'new-fresh' },
      { id: 'card-2', columnId: 'new-hot' },
    ]);
    const map = loadPreviousLaneMap(dataDir, '2026-06-15');
    assert.equal(map.get('card-1'), 'new-fresh');
    assert.equal(map.get('card-2'), 'new-hot');
  });
});

// ── Archive table schema discovery ───────────────────────────────────────────

describe('fetchArchiveFieldMap', () => {
  test('maps Archive fields to Active Pipeline fields by name, reports unmapped', async () => {
    const metaBody = {
      tables: [
        {
          id: ARCHIVE_TABLE_ID,
          fields: [
            { name: 'Card ID', id: 'fldArchCardId' },
            { name: 'Company', id: 'fldArchCompany' },
            { name: 'Role', id: 'fldArchRole' },
            // Notes intentionally missing from Archive table -> should show up as unmapped.
          ],
        },
      ],
    };
    const fetchImpl = makeFetch([
      { match: (url) => url.includes('/meta/bases/'), respond: () => jsonRes(metaBody) },
    ]);
    const res = await fetchArchiveFieldMap({ pat: 'fake-pat', baseId: BASE_ID, archiveTableId: ARCHIVE_TABLE_ID, fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(res.fieldMap['Card ID'], 'fldArchCardId');
    assert.equal(res.fieldMap['Company'], 'fldArchCompany');
    assert.ok(res.unmapped.includes('Notes'), 'Notes should be reported as unmapped');
  });

  test('archive table not found in meta response -> clean error', async () => {
    const fetchImpl = makeFetch([
      { match: (url) => url.includes('/meta/bases/'), respond: () => jsonRes({ tables: [] }) },
    ]);
    const res = await fetchArchiveFieldMap({ pat: 'fake-pat', baseId: BASE_ID, archiveTableId: ARCHIVE_TABLE_ID, fetchImpl });
    assert.equal(res.ok, false);
    assert.match(res.error, /not found/);
  });

  test('meta request failure (e.g. insufficient scope) -> clean error, not a throw', async () => {
    const fetchImpl = makeFetch([
      { match: (url) => url.includes('/meta/bases/'), respond: () => jsonRes({ error: 'NOT_AUTHORIZED' }, { ok: false, status: 403, statusText: 'Forbidden' }) },
    ]);
    const res = await fetchArchiveFieldMap({ pat: 'fake-pat', baseId: BASE_ID, archiveTableId: ARCHIVE_TABLE_ID, fetchImpl });
    assert.equal(res.ok, false);
    assert.match(res.error, /403/);
  });
});

describe('mapActiveFieldsToArchive', () => {
  test('maps only the fields present in fieldMap, skips unmapped', () => {
    const activeFields = {
      [CARD_ID_FIELD]: 'card-1',
      [ACTIVE_FIELD_IDS['Company']]: 'Acme',
      [ACTIVE_FIELD_IDS['Notes']]: 'some notes',
    };
    const fieldMap = { 'Card ID': 'fldArchCardId', 'Company': 'fldArchCompany' }; // Notes deliberately absent
    const out = mapActiveFieldsToArchive(activeFields, fieldMap);
    assert.equal(out['fldArchCardId'], 'card-1');
    assert.equal(out['fldArchCompany'], 'Acme');
    assert.ok(!Object.values(out).includes('some notes'), 'unmapped Notes value should not appear anywhere in the output');
  });
});

// ── run() — the full engine ──────────────────────────────────────────────────

describe('run', () => {
  test('missing PAT returns a clean error, no network call', async () => {
    const dataDir = freshDir();
    const res = await run({ pat: null, dataDir, fetchImpl: () => { throw new Error('should not be called'); } });
    assert.equal(res.ok, false);
    assert.equal(res.error, PAT_MISSING_MSG);
  });

  test('New-Fresh card past 33h threshold is archived in --apply mode (create then delete)', async () => {
    const dataDir = freshDir();
    const rec = makeRecord('rec1', { cardId: 'card-1', lane: 'New-Fresh', createdAt: '2026-06-14T00:00:00.000Z' }); // 34h before "now"
    const metaBody = { tables: [{ id: ARCHIVE_TABLE_ID, fields: [{ name: 'Card ID', id: 'fldArchCardId' }, { name: 'Company', id: 'fldArchCompany' }, { name: 'Role', id: 'fldArchRole' }, { name: 'Lane', id: 'fldArchLane' }, { name: 'Created At', id: 'fldArchCreatedAt' }, { name: 'Notes', id: 'fldArchNotes' }] }] };

    let createCalled = false;
    let deleteCalled = false;
    const fetchImpl = makeFetch([
      { match: (url, opts) => (!opts?.method || opts.method === 'GET') && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [rec] }) },
      { match: (url) => url.includes('/meta/bases/'), respond: () => jsonRes(metaBody) },
      { match: (url, opts) => opts?.method === 'POST' && url.includes(ARCHIVE_TABLE_ID), respond: (_url, opts) => { createCalled = true; const body = JSON.parse(opts.body); return jsonRes({ records: body.records.map((r, i) => ({ id: `archRec${i}`, fields: r.fields })) }); } },
      { match: (url, opts) => opts?.method === 'DELETE' && url.includes(ACTIVE_TABLE_ID), respond: () => { deleteCalled = true; return jsonRes({ records: [{ id: 'rec1' }] }); } },
    ]);

    const res = await run({
      pat: 'fake-pat', dataDir, dateStr: '2026-06-16', now: new Date('2026-06-16T10:00:00.000Z'),
      fetchImpl, baseId: BASE_ID, activeTableId: ACTIVE_TABLE_ID, archiveTableId: ARCHIVE_TABLE_ID, apply: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.dry_run, false);
    assert.equal(res.archived.length, 1);
    assert.equal(res.archived[0].cardId, 'card-1');
    assert.equal(createCalled, true, 'archive create must be called');
    assert.equal(deleteCalled, true, 'delete from Active Pipeline must be called after create succeeds');

    const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'archive-run-2026-06-16.json'), 'utf8'));
    assert.equal(written.archived.length, 1);
    assert.equal(written.dry_run, false);
  });

  test('New-Hot card past 99h threshold is archived', async () => {
    const dataDir = freshDir();
    const rec = makeRecord('rec1', { cardId: 'card-2', lane: 'New-Hot', createdAt: '2026-06-12T00:00:00.000Z' }); // 101h before "now"
    const metaBody = { tables: [{ id: ARCHIVE_TABLE_ID, fields: [{ name: 'Card ID', id: 'fldArchCardId' }, { name: 'Company', id: 'fldArchCompany' }, { name: 'Role', id: 'fldArchRole' }, { name: 'Lane', id: 'fldArchLane' }, { name: 'Created At', id: 'fldArchCreatedAt' }, { name: 'Notes', id: 'fldArchNotes' }] }] };

    const fetchImpl = makeFetch([
      { match: (url, opts) => (!opts?.method || opts.method === 'GET') && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [rec] }) },
      { match: (url) => url.includes('/meta/bases/'), respond: () => jsonRes(metaBody) },
      { match: (url, opts) => opts?.method === 'POST' && url.includes(ARCHIVE_TABLE_ID), respond: (_url, opts) => { const body = JSON.parse(opts.body); return jsonRes({ records: body.records.map((r, i) => ({ id: `archRec${i}`, fields: r.fields })) }); } },
      { match: (url, opts) => opts?.method === 'DELETE' && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [{ id: 'rec1' }] }) },
    ]);

    const res = await run({
      pat: 'fake-pat', dataDir, dateStr: '2026-06-16', now: new Date('2026-06-16T05:00:00.000Z'),
      fetchImpl, baseId: BASE_ID, activeTableId: ACTIVE_TABLE_ID, archiveTableId: ARCHIVE_TABLE_ID, apply: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.archived.length, 1);
    assert.equal(res.archived[0].cardId, 'card-2');
    assert.equal(res.archived[0].lane, 'New-Hot');
  });

  test('card under threshold is not archived', async () => {
    const dataDir = freshDir();
    const rec = makeRecord('rec1', { cardId: 'card-3', lane: 'New-Fresh', createdAt: '2026-06-16T00:00:00.000Z' }); // 10h elapsed, well under 33h
    const fetchImpl = makeFetch([
      { match: (url, opts) => (!opts?.method || opts.method === 'GET') && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [rec] }) },
    ]);

    const res = await run({
      pat: 'fake-pat', dataDir, dateStr: '2026-06-16', now: new Date('2026-06-16T10:00:00.000Z'),
      fetchImpl, baseId: BASE_ID, activeTableId: ACTIVE_TABLE_ID, archiveTableId: ARCHIVE_TABLE_ID, apply: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.archived.length, 0);
  });

  test('dry-run mode reports archive candidates without calling create/delete', async () => {
    const dataDir = freshDir();
    const rec = makeRecord('rec1', { cardId: 'card-1', lane: 'New-Fresh', createdAt: '2026-06-14T00:00:00.000Z' });
    const fetchImpl = makeFetch([
      { match: (url, opts) => (!opts?.method || opts.method === 'GET') && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [rec] }) },
    ]);

    const res = await run({
      pat: 'fake-pat', dataDir, dateStr: '2026-06-16', now: new Date('2026-06-16T10:00:00.000Z'),
      fetchImpl, baseId: BASE_ID, activeTableId: ACTIVE_TABLE_ID, archiveTableId: ARCHIVE_TABLE_ID, apply: false,
    });

    assert.equal(res.ok, true);
    assert.equal(res.dry_run, true);
    assert.equal(res.archived.length, 1);
    assert.equal(res.archived[0].cardId, 'card-1');
    // No POST/DELETE/meta handler registered — would throw "Unhandled fetch" if called.
  });

  test('flow transition detected: card left New-Fresh for Applied before threshold -> tagged in --apply mode', async () => {
    const dataDir = freshDir();
    writeYesterdaySnapshot(dataDir, '2026-06-15', [{ id: 'card-1', columnId: 'new-fresh' }]);
    const rec = makeRecord('rec1', { cardId: 'card-1', lane: 'Applied', createdAt: '2026-06-16T00:00:00.000Z', notes: 'Original notes' });

    let patchBody = null;
    const fetchImpl = makeFetch([
      { match: (url, opts) => (!opts?.method || opts.method === 'GET') && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [rec] }) },
      { match: (url, opts) => opts?.method === 'PATCH' && url.includes(ACTIVE_TABLE_ID), respond: (_url, opts) => { patchBody = JSON.parse(opts.body); return jsonRes({ records: patchBody.records }); } },
    ]);

    const res = await run({
      pat: 'fake-pat', dataDir, dateStr: '2026-06-16', now: new Date('2026-06-16T10:00:00.000Z'),
      fetchImpl, baseId: BASE_ID, activeTableId: ACTIVE_TABLE_ID, archiveTableId: ARCHIVE_TABLE_ID, apply: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.tagged_flow.length, 1);
    assert.equal(res.tagged_flow[0].cardId, 'card-1');
    assert.equal(res.tagged_flow[0].tag, '[flow:New-Fresh→Applied 2026-06-16]');
    assert.ok(patchBody, 'PATCH must be called to write the flow tag');
    const patchedNotes = patchBody.records[0].fields[ACTIVE_FIELD_IDS['Notes']];
    assert.equal(patchedNotes, '[flow:New-Fresh→Applied 2026-06-16]\nOriginal notes');
  });

  test('flow transition not detected when card is still in New-Fresh', async () => {
    const dataDir = freshDir();
    writeYesterdaySnapshot(dataDir, '2026-06-15', [{ id: 'card-1', columnId: 'new-fresh' }]);
    const rec = makeRecord('rec1', { cardId: 'card-1', lane: 'New-Fresh', createdAt: '2026-06-16T00:00:00.000Z' }); // still fresh, under threshold

    const fetchImpl = makeFetch([
      { match: (url, opts) => (!opts?.method || opts.method === 'GET') && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [rec] }) },
    ]);

    const res = await run({
      pat: 'fake-pat', dataDir, dateStr: '2026-06-16', now: new Date('2026-06-16T10:00:00.000Z'),
      fetchImpl, baseId: BASE_ID, activeTableId: ACTIVE_TABLE_ID, archiveTableId: ARCHIVE_TABLE_ID, apply: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.tagged_flow.length, 0);
    assert.equal(res.archived.length, 0);
    // No PATCH handler registered — would throw "Unhandled fetch" if (incorrectly) called.
  });

  test('dry-run reports the flow tag without calling PATCH', async () => {
    const dataDir = freshDir();
    writeYesterdaySnapshot(dataDir, '2026-06-15', [{ id: 'card-1', columnId: 'new-hot' }]);
    const rec = makeRecord('rec1', { cardId: 'card-1', lane: 'Blocked', createdAt: '2026-06-16T00:00:00.000Z' });

    const fetchImpl = makeFetch([
      { match: (url, opts) => (!opts?.method || opts.method === 'GET') && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [rec] }) },
    ]);

    const res = await run({
      pat: 'fake-pat', dataDir, dateStr: '2026-06-16', now: new Date('2026-06-16T10:00:00.000Z'),
      fetchImpl, baseId: BASE_ID, activeTableId: ACTIVE_TABLE_ID, archiveTableId: ARCHIVE_TABLE_ID, apply: false,
    });

    assert.equal(res.ok, true);
    assert.equal(res.dry_run, true);
    assert.equal(res.tagged_flow.length, 1);
    assert.equal(res.tagged_flow[0].tag, '[flow:New-Hot→Blocked 2026-06-16]');
  });

  test('missing previous-day snapshot falls back gracefully (no crash, archiving still runs)', async () => {
    const dataDir = freshDir(); // no kanban-import-2026-06-15.json written
    const rec = makeRecord('rec1', { cardId: 'card-1', lane: 'Applied', createdAt: '2026-06-16T00:00:00.000Z' });
    const fetchImpl = makeFetch([
      { match: (url, opts) => (!opts?.method || opts.method === 'GET') && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [rec] }) },
    ]);

    const res = await run({
      pat: 'fake-pat', dataDir, dateStr: '2026-06-16', now: new Date('2026-06-16T10:00:00.000Z'),
      fetchImpl, baseId: BASE_ID, activeTableId: ACTIVE_TABLE_ID, archiveTableId: ARCHIVE_TABLE_ID, apply: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.tagged_flow.length, 0);
    assert.ok(res.notes.some((n) => n.includes('No previous-day snapshot')));
  });

  test('Archive table schema mismatch: unmapped fields are logged but archiving still proceeds', async () => {
    const dataDir = freshDir();
    const rec = makeRecord('rec1', { cardId: 'card-1', lane: 'New-Fresh', createdAt: '2026-06-14T00:00:00.000Z' });
    // Archive table only has Card ID + Company — Role/Lane/Created At/Notes are unmapped.
    const metaBody = { tables: [{ id: ARCHIVE_TABLE_ID, fields: [{ name: 'Card ID', id: 'fldArchCardId' }, { name: 'Company', id: 'fldArchCompany' }] }] };

    const fetchImpl = makeFetch([
      { match: (url, opts) => (!opts?.method || opts.method === 'GET') && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [rec] }) },
      { match: (url) => url.includes('/meta/bases/'), respond: () => jsonRes(metaBody) },
      { match: (url, opts) => opts?.method === 'POST' && url.includes(ARCHIVE_TABLE_ID), respond: (_url, opts) => { const body = JSON.parse(opts.body); return jsonRes({ records: body.records.map((r, i) => ({ id: `archRec${i}`, fields: r.fields })) }); } },
      { match: (url, opts) => opts?.method === 'DELETE' && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [{ id: 'rec1' }] }) },
    ]);

    const res = await run({
      pat: 'fake-pat', dataDir, dateStr: '2026-06-16', now: new Date('2026-06-16T10:00:00.000Z'),
      fetchImpl, baseId: BASE_ID, activeTableId: ACTIVE_TABLE_ID, archiveTableId: ARCHIVE_TABLE_ID, apply: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.archived.length, 1, 'archiving still completes despite a partial field map');
    assert.ok(res.errors.some((e) => e.includes('Role') && e.includes('Lane')), 'unmapped field names should be reported in errors');
  });

  test('archive create failure: delete is never called, error is reported', async () => {
    const dataDir = freshDir();
    const rec = makeRecord('rec1', { cardId: 'card-1', lane: 'New-Fresh', createdAt: '2026-06-14T00:00:00.000Z' });
    const metaBody = { tables: [{ id: ARCHIVE_TABLE_ID, fields: [{ name: 'Card ID', id: 'fldArchCardId' }] }] };

    let deleteCalled = false;
    const fetchImpl = makeFetch([
      { match: (url, opts) => (!opts?.method || opts.method === 'GET') && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [rec] }) },
      { match: (url) => url.includes('/meta/bases/'), respond: () => jsonRes(metaBody) },
      { match: (url, opts) => opts?.method === 'POST' && url.includes(ARCHIVE_TABLE_ID), respond: () => jsonRes({ error: 'INVALID_REQUEST' }, { ok: false, status: 422, statusText: 'Unprocessable' }) },
      { match: (url, opts) => opts?.method === 'DELETE' && url.includes(ACTIVE_TABLE_ID), respond: () => { deleteCalled = true; return jsonRes({ records: [] }); } },
    ]);

    const res = await run({
      pat: 'fake-pat', dataDir, dateStr: '2026-06-16', now: new Date('2026-06-16T10:00:00.000Z'),
      fetchImpl, baseId: BASE_ID, activeTableId: ACTIVE_TABLE_ID, archiveTableId: ARCHIVE_TABLE_ID, apply: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.archived.length, 0, 'a card whose archive-create failed must not be reported as archived');
    assert.equal(deleteCalled, false, 'delete must never run if create failed — no data loss');
    assert.ok(res.errors.some((e) => e.includes('Archive create failed')));
  });

  test('archive create succeeds but delete fails: card is in both tables, flagged for manual cleanup', async () => {
    const dataDir = freshDir();
    const rec = makeRecord('rec1', { cardId: 'card-1', lane: 'New-Fresh', createdAt: '2026-06-14T00:00:00.000Z' });
    const metaBody = { tables: [{ id: ARCHIVE_TABLE_ID, fields: [{ name: 'Card ID', id: 'fldArchCardId' }] }] };

    const fetchImpl = makeFetch([
      { match: (url, opts) => (!opts?.method || opts.method === 'GET') && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [rec] }) },
      { match: (url) => url.includes('/meta/bases/'), respond: () => jsonRes(metaBody) },
      { match: (url, opts) => opts?.method === 'POST' && url.includes(ARCHIVE_TABLE_ID), respond: (_url, opts) => { const body = JSON.parse(opts.body); return jsonRes({ records: body.records.map((r, i) => ({ id: `archRec${i}`, fields: r.fields })) }); } },
      { match: (url, opts) => opts?.method === 'DELETE' && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ error: 'INVALID_REQUEST' }, { ok: false, status: 500, statusText: 'Server Error' }) },
    ]);

    const res = await run({
      pat: 'fake-pat', dataDir, dateStr: '2026-06-16', now: new Date('2026-06-16T10:00:00.000Z'),
      fetchImpl, baseId: BASE_ID, activeTableId: ACTIVE_TABLE_ID, archiveTableId: ARCHIVE_TABLE_ID, apply: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.archived.length, 0, 'not reported as cleanly archived since delete failed');
    assert.ok(res.errors.some((e) => e.includes('manual cleanup')));
  });

  test('writes data/archive-run-{date}.json with the documented shape', async () => {
    const dataDir = freshDir();
    const fetchImpl = makeFetch([
      { match: (url, opts) => (!opts?.method || opts.method === 'GET') && url.includes(ACTIVE_TABLE_ID), respond: () => jsonRes({ records: [] }) },
    ]);
    const res = await run({
      pat: 'fake-pat', dataDir, dateStr: '2026-06-16', fetchImpl,
      baseId: BASE_ID, activeTableId: ACTIVE_TABLE_ID, archiveTableId: ARCHIVE_TABLE_ID, apply: false,
    });
    const written = JSON.parse(fs.readFileSync(res.outPath, 'utf8'));
    assert.deepEqual(Object.keys(written).sort(), ['archived', 'dry_run', 'errors', 'notes', 'tagged_flow']);
  });
});

// ── CLI: missing PAT (no network reached, safe to run as a real subprocess) ──

describe('archive-stale CLI', () => {
  test('exits 1 with a helpful message when AIRTABLE_PAT is not set', () => {
    const dataDir = freshDir();
    const env = { ...process.env };
    delete env.AIRTABLE_PAT;
    assert.throws(() => {
      execSync(`node scripts/archive-stale.mjs --dry-run --data "${dataDir}"`, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', env });
    }, (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr.toString(), /AIRTABLE_PAT/);
      return true;
    });
  });
});

after(cleanTmp);

/**
 * airtable-sync.test.mjs — Two-way Airtable sync (pull/push, conflict clock)
 *
 * Run: node --test test/airtable-sync.test.mjs
 *
 * airtable-sync.mjs's pull()/push() take an injectable `fetchImpl`, so these
 * tests mock the Airtable REST API directly (no real network calls, no
 * subprocess needed) — same dual pattern as referral-queue.mjs /
 * ingest-runner.mjs: pure functions imported + exercised in-process, with a
 * couple of CLI-level checks via execSync where a subprocess is actually
 * useful (missing AIRTABLE_PAT, which never reaches the network).
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

import {
  pull,
  push,
  recordToCard,
  cardToFields,
  isNewer,
  sameTimestamp,
  CARD_ID_FIELD,
  LAST_REFRESHED_FIELD,
  PAT_MISSING_MSG,
} from '../scripts/airtable-sync.mjs';

const TMP = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-airtable-sync-test-'));
function cleanTmp() { fs.rmSync(TMP, { recursive: true, force: true }); }
function freshDir() {
  const d = fs.mkdtempSync(path.join(TMP, 'case-'));
  return d;
}

// A minimal fake Airtable record using field IDs, the same shape the real API
// returns when fetched with returnFieldsByFieldId=true.
function makeRecord(id, { cardId, company, role, lastRefreshed, lane = 'New-Fresh' }) {
  return {
    id,
    fields: {
      [CARD_ID_FIELD]: cardId,
      'fldaAdo3CyQX1yttd': company,        // Company
      'fldtDd16kgRxSoU0N': role,           // Role
      'fldEu8xXUx0QLlQAG': 'B',            // Grade
      'fldxDdSwovNaHtaCL': lane,           // Lane
      'fldlKMfzFGo12RSw1': 'greenhouse',   // Platform
      'fldPp4nDoFldT2ZKc': 'https://x/' + cardId, // URL
      'fld0MDcXVWGtInqnL': 'JD text',      // Job Description
      'fldyDJNWfldoMDVqt': 'Scrum, Agile', // Keywords
      [LAST_REFRESHED_FIELD]: lastRefreshed,
    },
  };
}

/** Build a fetchImpl that serves canned GET/PATCH responses in call order. */
function fakeFetch(responses) {
  let i = 0;
  return async (_url, _opts) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.ok !== false,
      status: r.status ?? 200,
      statusText: r.statusText ?? 'OK',
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
}

// ── pull ──────────────────────────────────────────────────────────────────

describe('pull', () => {
  test('missing PAT returns a clean error, no network call', async () => {
    const dataDir = freshDir();
    const res = await pull({ pat: null, dataDir, fetchImpl: () => { throw new Error('should not be called'); } });
    assert.equal(res.ok, false);
    assert.equal(res.error, PAT_MISSING_MSG);
  });

  test('normal pull writes kanban-import + sync-state from Airtable records', async () => {
    const dataDir = freshDir();
    const records = [
      makeRecord('rec1', { cardId: 'card-1', company: 'Acme', role: 'PM', lastRefreshed: '2026-06-16T01:00:00.000Z' }),
      makeRecord('rec2', { cardId: 'card-2', company: 'Globex', role: 'TPM', lastRefreshed: '2026-06-16T01:05:00.000Z', lane: 'New-Hot' }),
    ];
    const fetchImpl = fakeFetch([{ body: { records } }]);

    const res = await pull({ pat: 'fake-pat', dataDir, dateStr: '2026-06-16', fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(res.count, 2);
    assert.equal(res.skipped, 0);

    const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'kanban-import-2026-06-16.json'), 'utf8'));
    assert.equal(written.length, 2);
    assert.equal(written[0].id, 'card-1');
    assert.equal(written[0].company, 'Acme');
    assert.equal(written[1].columnId, 'new-hot');
    assert.ok(!('_airtableRecordId' in written[0]), 'internal record id should not leak into the consumer-facing file');

    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'airtable-sync-state.json'), 'utf8'));
    assert.equal(state.cards['card-1'].lastRefreshed, '2026-06-16T01:00:00.000Z');
    assert.equal(state.cards['card-2'].recordId, 'rec2');
  });

  test('empty Active Pipeline pulls cleanly (no crash, empty outputs)', async () => {
    const dataDir = freshDir();
    const fetchImpl = fakeFetch([{ body: { records: [] } }]);

    const res = await pull({ pat: 'fake-pat', dataDir, dateStr: '2026-06-16', fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(res.count, 0);

    const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'kanban-import-2026-06-16.json'), 'utf8'));
    assert.deepEqual(written, []);
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'airtable-sync-state.json'), 'utf8'));
    assert.deepEqual(state.cards, {});
  });

  test('records with no Card ID are skipped and reported, not crashed on', async () => {
    const dataDir = freshDir();
    const records = [
      { id: 'rec1', fields: { [CARD_ID_FIELD]: '', 'fldaAdo3CyQX1yttd': 'Ghost Co' } },
      makeRecord('rec2', { cardId: 'card-2', company: 'Globex', role: 'TPM', lastRefreshed: '2026-06-16T01:05:00.000Z' }),
    ];
    const fetchImpl = fakeFetch([{ body: { records } }]);
    const res = await pull({ pat: 'fake-pat', dataDir, dateStr: '2026-06-16', fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(res.count, 1);
    assert.equal(res.skipped, 1);
  });

  test('paginates via offset until none is returned', async () => {
    const dataDir = freshDir();
    const page1 = { records: [makeRecord('rec1', { cardId: 'card-1', company: 'Acme', role: 'PM', lastRefreshed: '2026-06-16T01:00:00.000Z' })], offset: 'tok123' };
    const page2 = { records: [makeRecord('rec2', { cardId: 'card-2', company: 'Globex', role: 'TPM', lastRefreshed: '2026-06-16T01:05:00.000Z' })] };
    const fetchImpl = fakeFetch([{ body: page1 }, { body: page2 }]);

    const res = await pull({ pat: 'fake-pat', dataDir, dateStr: '2026-06-16', fetchImpl });
    assert.equal(res.count, 2);
  });

  test('a failed GET surfaces an error instead of throwing', async () => {
    const dataDir = freshDir();
    const fetchImpl = fakeFetch([{ ok: false, status: 401, statusText: 'Unauthorized', body: { error: 'bad token' } }]);
    const res = await pull({ pat: 'bad-pat', dataDir, fetchImpl });
    assert.equal(res.ok, false);
    assert.match(res.error, /401/);
  });
});

// ── push ──────────────────────────────────────────────────────────────────

function writeState(dataDir, cards) {
  fs.writeFileSync(path.join(dataDir, 'airtable-sync-state.json'), JSON.stringify({
    synced_at_utc: '2026-06-16T01:00:00.000Z', base: 'appX', table: 'tblX', cards,
  }, null, 2));
}

describe('push', () => {
  test('missing PAT returns a clean error, no network call', async () => {
    const dataDir = freshDir();
    const res = await push({ pat: null, dataDir, fetchImpl: () => { throw new Error('should not be called'); } });
    assert.equal(res.ok, false);
    assert.equal(res.error, PAT_MISSING_MSG);
  });

  test('no sync-state baseline -> clean error telling caller to pull first', async () => {
    const dataDir = freshDir();
    const res = await push({ pat: 'fake-pat', dataDir, fetchImpl: () => { throw new Error('should not be called'); } });
    assert.equal(res.ok, false);
    assert.match(res.error, /run --pull first/);
  });

  test('nothing to push when no local card is newer than the baseline', async () => {
    const dataDir = freshDir();
    writeState(dataDir, { 'card-1': { lastRefreshed: '2026-06-16T01:00:00.000Z', recordId: 'rec1' } });
    const localCards = [{ id: 'card-1', company: 'Acme', lastRefreshed: '2026-06-16T01:00:00.000Z' }];

    const res = await push({ pat: 'fake-pat', dataDir, localCards, fetchImpl: () => { throw new Error('should not be called'); } });
    assert.equal(res.ok, true);
    assert.equal(res.pushed, 0);
  });

  test('pushes a card that changed locally and is unchanged on the Airtable side', async () => {
    const dataDir = freshDir();
    writeState(dataDir, { 'card-1': { lastRefreshed: '2026-06-16T01:00:00.000Z', recordId: 'rec1' } });
    const localCards = [{
      id: 'card-1', company: 'Acme Updated', role: 'Senior PM', columnId: 'new-fresh',
      lastRefreshed: '2026-06-16T02:00:00.000Z',
    }];
    const currentRecord = makeRecord('rec1', { cardId: 'card-1', company: 'Acme', role: 'PM', lastRefreshed: '2026-06-16T01:00:00.000Z' });
    const patchedRecord = { id: 'rec1', fields: { ...cardToFields(localCards[0]), [LAST_REFRESHED_FIELD]: '2026-06-16T02:00:00.000Z' } };

    let patchBody = null;
    const fetchImpl = async (url, opts) => {
      if (!opts || opts.method !== 'PATCH') {
        return { ok: true, json: async () => ({ records: [currentRecord] }) };
      }
      patchBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ records: [patchedRecord] }) };
    };

    const res = await push({ pat: 'fake-pat', dataDir, localCards, fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(res.pushed, 1);
    assert.equal(res.conflicts.length, 0);
    assert.equal(patchBody.records[0].id, 'rec1');
    assert.equal(patchBody.records[0].fields[CARD_ID_FIELD], 'card-1');

    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'airtable-sync-state.json'), 'utf8'));
    assert.equal(state.cards['card-1'].lastRefreshed, '2026-06-16T02:00:00.000Z');
  });

  test('conflict: Airtable side changed since pull -> skipped, not overwritten', async () => {
    const dataDir = freshDir();
    writeState(dataDir, { 'card-1': { lastRefreshed: '2026-06-16T01:00:00.000Z', recordId: 'rec1' } });
    const localCards = [{
      id: 'card-1', company: 'Acme Updated', columnId: 'new-fresh',
      lastRefreshed: '2026-06-16T02:00:00.000Z',
    }];
    // Rahil edited the Airtable row at 01:30 — after the pull baseline (01:00).
    const currentRecord = makeRecord('rec1', { cardId: 'card-1', company: 'Acme (Rahil edit)', role: 'PM', lastRefreshed: '2026-06-16T01:30:00.000Z' });

    let patchCalled = false;
    const fetchImpl = async (_url, opts) => {
      if (opts && opts.method === 'PATCH') { patchCalled = true; }
      return { ok: true, json: async () => ({ records: [currentRecord] }) };
    };

    const res = await push({ pat: 'fake-pat', dataDir, localCards, fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(res.pushed, 0);
    assert.equal(res.conflicts.length, 1);
    assert.equal(res.conflicts[0].id, 'card-1');
    assert.equal(patchCalled, false, 'PATCH must never be called for a conflicting card');

    // Baseline must be left untouched — the local edit was not applied.
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'airtable-sync-state.json'), 'utf8'));
    assert.equal(state.cards['card-1'].lastRefreshed, '2026-06-16T01:00:00.000Z');
  });

  test('archived card (no longer in Active Pipeline) is skipped, not recreated', async () => {
    const dataDir = freshDir();
    writeState(dataDir, { 'card-1': { lastRefreshed: '2026-06-16T01:00:00.000Z', recordId: 'rec1' } });
    const localCards = [{
      id: 'card-1', company: 'Acme', columnId: 'applied',
      lastRefreshed: '2026-06-16T02:00:00.000Z',
    }];

    let patchCalled = false;
    // Re-fetch returns no matching record — card-1 was moved to Archive.
    const fetchImpl = async (_url, opts) => {
      if (opts && opts.method === 'PATCH') { patchCalled = true; }
      return { ok: true, json: async () => ({ records: [] }) };
    };

    const res = await push({ pat: 'fake-pat', dataDir, localCards, fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(res.pushed, 0);
    assert.deepEqual(res.archived, ['card-1']);
    assert.equal(patchCalled, false, 'PATCH must never be called to recreate an archived card');
  });

  test('a failed PATCH surfaces an error instead of throwing', async () => {
    const dataDir = freshDir();
    writeState(dataDir, { 'card-1': { lastRefreshed: '2026-06-16T01:00:00.000Z', recordId: 'rec1' } });
    const localCards = [{ id: 'card-1', company: 'Acme', columnId: 'new-fresh', lastRefreshed: '2026-06-16T02:00:00.000Z' }];
    const currentRecord = makeRecord('rec1', { cardId: 'card-1', company: 'Acme', role: 'PM', lastRefreshed: '2026-06-16T01:00:00.000Z' });

    const fetchImpl = async (_url, opts) => {
      if (opts && opts.method === 'PATCH') {
        return { ok: false, status: 422, statusText: 'Unprocessable', text: async () => 'bad field' };
      }
      return { ok: true, json: async () => ({ records: [currentRecord] }) };
    };

    const res = await push({ pat: 'fake-pat', dataDir, localCards, fetchImpl });
    assert.equal(res.ok, false);
    assert.match(res.error, /422/);
  });
});

// ── mapping + timestamp helpers ──────────────────────────────────────────────

describe('recordToCard / cardToFields round trip', () => {
  test('maps lane name to columnId and keywords string to array', () => {
    const record = makeRecord('rec1', { cardId: 'card-1', company: 'Acme', role: 'PM', lastRefreshed: '2026-06-16T01:00:00.000Z', lane: 'New-Hot' });
    const card = recordToCard(record);
    assert.equal(card.columnId, 'new-hot');
    assert.deepEqual(card.keywords, ['Scrum', 'Agile']);
  });

  test('cardToFields omits Created At and keeps Card ID as upsert key', () => {
    const fields = cardToFields({ id: 'card-1', company: 'Acme', columnId: 'new-fresh', keywords: ['A', 'B'], lastRefreshed: '2026-06-16T02:00:00.000Z' });
    assert.equal(fields[CARD_ID_FIELD], 'card-1');
    assert.ok(!('fldMTpTyX9CzIhazo' in fields), 'Created At should not be in the push payload');
    assert.equal(fields['fldyDJNWfldoMDVqt'], 'A, B');
  });
});

describe('isNewer / sameTimestamp', () => {
  test('isNewer compares ISO timestamps', () => {
    assert.equal(isNewer('2026-06-16T02:00:00.000Z', '2026-06-16T01:00:00.000Z'), true);
    assert.equal(isNewer('2026-06-16T01:00:00.000Z', '2026-06-16T02:00:00.000Z'), false);
    assert.equal(isNewer('', ''), false);
  });

  test('sameTimestamp treats equal instants as equal regardless of formatting', () => {
    assert.equal(sameTimestamp('2026-06-16T01:00:00.000Z', '2026-06-16T01:00:00.000Z'), true);
    assert.equal(sameTimestamp('2026-06-16T01:00:00.000Z', '2026-06-16T01:30:00.000Z'), false);
  });
});

// ── CLI: missing PAT (no network reached, safe to run as a real subprocess) ──

describe('airtable-sync CLI', () => {
  test('exits 1 with a helpful message when AIRTABLE_PAT is not set', () => {
    const dataDir = freshDir();
    const env = { ...process.env };
    delete env.AIRTABLE_PAT;
    assert.throws(() => {
      execSync(`node scripts/airtable-sync.mjs --pull --data "${dataDir}"`, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', env });
    }, (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr.toString(), /AIRTABLE_PAT/);
      return true;
    });
  });

  test('exits 2 with usage when neither --pull nor --push is given', () => {
    assert.throws(() => {
      execSync(`node scripts/airtable-sync.mjs`, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, AIRTABLE_PAT: 'x' } });
    }, (err) => {
      assert.equal(err.status, 2);
      assert.match(err.stderr.toString(), /Usage/);
      return true;
    });
  });
});

after(cleanTmp);

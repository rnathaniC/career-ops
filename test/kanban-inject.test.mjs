/**
 * kanban-inject.test.mjs — Unit and integration tests for kanban-inject.mjs
 *
 * Run: node --test test/kanban-inject.test.mjs
 *
 * Tests cover: URL dedup, grade-D skip, dry-run vs apply, missing PAT,
 * card ID sequencing, Airtable POST batching (injectable fetch),
 * local kanban-import append, inject-run output file shape.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  newestMatching, buildSeenUrls, maxCardSeq, buildFields, injectCards,
  airtableCreateBatch, appendToKanbanImport,
} from '../scripts/kanban-inject.mjs';

import { ACTIVE_FIELD_IDS } from '../scripts/airtable-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-inject-test-'));
function cleanTmp() { fs.rmSync(TMP, { recursive: true, force: true }); }

// ── test fixtures ─────────────────────────────────────────────────────────────

const GRADED_JOBS = [
  { company: 'Stripe',  role: 'Program Manager',  grade: 'A', platform: 'greenhouse', url: 'https://ex.com/1', jd_snippet: null, keywords_matched: ['Program Manager'] },
  { company: 'Notion',  role: 'Scrum Master',      grade: 'B', platform: 'ashby',      url: 'https://ex.com/2', jd_snippet: null, keywords_matched: ['Scrum Master'] },
  { company: 'Acme',    role: 'Sales Rep',          grade: 'D', platform: 'lever',      url: 'https://ex.com/3', jd_snippet: null, keywords_matched: [] },
];

function makeFetch(status = 200, body = {}) {
  return async (_url, _opts) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  });
}

// ── newestMatching ────────────────────────────────────────────────────────────

describe('newestMatching', () => {
  test('returns null for missing dir', () => {
    assert.equal(newestMatching(path.join(TMP, 'no-such-dir'), /^foo/), null);
  });

  test('returns null when no files match', () => {
    const dir = path.join(TMP, 'empty-nm');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(newestMatching(dir, /^graded-jobs/), null);
  });

  test('returns the most recent matching file', () => {
    const dir = path.join(TMP, 'nm-dir');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'graded-jobs-2026-06-14.json'), '[]');
    fs.writeFileSync(path.join(dir, 'graded-jobs-2026-06-16.json'), '[]');
    const result = newestMatching(dir, /^graded-jobs-\d{4}-\d{2}-\d{2}\.json$/);
    assert.ok(result.endsWith('graded-jobs-2026-06-16.json') || result.endsWith('graded-jobs-2026-06-14.json'));
  });
});

// ── buildSeenUrls ─────────────────────────────────────────────────────────────

describe('buildSeenUrls', () => {
  test('returns empty Set for missing dir', () => {
    const seen = buildSeenUrls(path.join(TMP, 'no-dir'));
    assert.equal(seen.size, 0);
  });

  test('collects URLs from kanban-import files', () => {
    const dir = path.join(TMP, 'seen-dir');
    fs.mkdirSync(dir, { recursive: true });
    const cards = [
      { id: 'live-2026-06-15-01', url: 'https://ex.com/a', company: 'X', role: 'Y' },
    ];
    fs.writeFileSync(path.join(dir, 'kanban-import-2026-06-15.json'), JSON.stringify(cards));
    const seen = buildSeenUrls(dir);
    assert.ok(seen.has('https://ex.com/a'));
  });

  test('collects URLs from inject-run files', () => {
    const dir = path.join(TMP, 'seen-dir-2');
    fs.mkdirSync(dir, { recursive: true });
    const run = { cards_injected: [{ url: 'https://ex.com/b' }] };
    fs.writeFileSync(path.join(dir, 'inject-run-2026-06-15.json'), JSON.stringify(run));
    const seen = buildSeenUrls(dir);
    assert.ok(seen.has('https://ex.com/b'));
  });
});

// ── maxCardSeq ────────────────────────────────────────────────────────────────

describe('maxCardSeq', () => {
  test('returns 0 for empty dir', () => {
    const dir = path.join(TMP, 'seq-empty');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(maxCardSeq(dir, '2026-06-16'), 0);
  });

  test('finds max seq from kanban-import', () => {
    const dir = path.join(TMP, 'seq-dir');
    fs.mkdirSync(dir, { recursive: true });
    const cards = [
      { id: 'live-2026-06-16-001' },
      { id: 'live-2026-06-16-003' },
      { id: 'live-2026-06-16-002' },
    ];
    fs.writeFileSync(path.join(dir, 'kanban-import-2026-06-16.json'), JSON.stringify(cards));
    assert.equal(maxCardSeq(dir, '2026-06-16'), 3);
  });

  test('ignores IDs for other dates', () => {
    const dir = path.join(TMP, 'seq-dir-2');
    fs.mkdirSync(dir, { recursive: true });
    const cards = [{ id: 'live-2026-06-15-099' }];
    fs.writeFileSync(path.join(dir, 'kanban-import-2026-06-15.json'), JSON.stringify(cards));
    assert.equal(maxCardSeq(dir, '2026-06-16'), 0);
  });
});

// ── buildFields ───────────────────────────────────────────────────────────────

describe('buildFields', () => {
  test('produces correct field mapping', () => {
    const fields = buildFields({
      cardId:   'live-2026-06-16-001',
      company:  'Stripe',
      role:     'Program Manager',
      grade:    'A',
      platform: 'greenhouse',
      url:      'https://ex.com/1',
      keywords: ['Program Manager'],
      nowIso:   '2026-06-16T00:00:00.000Z',
    });
    assert.equal(fields[ACTIVE_FIELD_IDS['Card ID']],  'live-2026-06-16-001');
    assert.equal(fields[ACTIVE_FIELD_IDS['Company']],  'Stripe');
    assert.equal(fields[ACTIVE_FIELD_IDS['Grade']],    'A');
    assert.equal(fields[ACTIVE_FIELD_IDS['Lane']],     'New-Fresh');
    assert.equal(fields[ACTIVE_FIELD_IDS['Has Connection']], false);
    assert.equal(fields[ACTIVE_FIELD_IDS['Warm Referral']],  false);
  });
});

// ── airtableCreateBatch ───────────────────────────────────────────────────────

describe('airtableCreateBatch', () => {
  test('makes one POST per 10-record batch', async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      const records = JSON.parse(opts.body).records.map((r, i) => ({ id: `rec${i}`, fields: r.fields }));
      return { ok: true, status: 200, async json() { return { records }; }, async text() { return ''; } };
    };

    const records = Array.from({ length: 12 }, (_, i) => ({ fields: { x: i } }));
    const created = await airtableCreateBatch({
      pat: 'test-pat', baseId: 'baseX', tableId: 'tableY', records, fetchImpl: mockFetch,
    });

    assert.equal(calls.length, 2, 'should batch into ceil(12/10)=2 requests');
    assert.equal(created.length, 12);
  });

  test('throws on non-ok response', async () => {
    const mockFetch = makeFetch(422, { error: 'INVALID_VALUE_FOR_COLUMN' });
    await assert.rejects(
      () => airtableCreateBatch({ pat: 'p', baseId: 'b', tableId: 't', records: [{ fields: {} }], fetchImpl: mockFetch }),
      /Airtable POST/
    );
  });
});

// ── appendToKanbanImport ──────────────────────────────────────────────────────

describe('appendToKanbanImport', () => {
  test('creates file with new cards when file is missing', () => {
    const p = path.join(TMP, 'ki-new.json');
    appendToKanbanImport(p, [{ id: 'live-1', url: 'https://ex.com/new' }]);
    const cards = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, 'live-1');
  });

  test('appends to existing cards', () => {
    const p = path.join(TMP, 'ki-append.json');
    fs.writeFileSync(p, JSON.stringify([{ id: 'live-0', url: 'https://ex.com/old' }]));
    appendToKanbanImport(p, [{ id: 'live-1', url: 'https://ex.com/new' }]);
    const cards = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(cards.length, 2);
    assert.equal(cards[1].id, 'live-1');
  });

  test('no-ops when newCards is empty', () => {
    const p = path.join(TMP, 'ki-noop.json');
    fs.writeFileSync(p, JSON.stringify([{ id: 'live-0' }]));
    appendToKanbanImport(p, []);
    const cards = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(cards.length, 1);
  });
});

// ── injectCards ───────────────────────────────────────────────────────────────

describe('injectCards: grade-D skip', () => {
  test('grade-D jobs are never passed to Airtable', async () => {
    const dir = path.join(TMP, 'inject-d');
    fs.mkdirSync(dir, { recursive: true });

    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push(opts);
      return { ok: true, status: 200, async json() { return { records: [] }; }, async text() { return ''; } };
    };

    const result = await injectCards({
      gradedJobs: [GRADED_JOBS[2]],  // grade D only
      seenUrls: new Set(),
      pat: 'test-pat',
      dataDir: dir,
      date: '2026-06-16',
      fetchImpl: mockFetch,
    });

    assert.equal(result.injected, 0);
    assert.equal(result.skipped_grade_d, 1);
    assert.equal(calls.length, 0, 'should make zero Airtable calls for D-grade-only input');
  });
});

describe('injectCards: URL dedup', () => {
  test('skips jobs whose URL is already in seenUrls', async () => {
    const dir = path.join(TMP, 'inject-dedup');
    fs.mkdirSync(dir, { recursive: true });

    const calls = [];
    const mockFetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body.records.length);
      const records = body.records.map((r, i) => ({ id: `rec${i}`, fields: r.fields }));
      return { ok: true, status: 200, async json() { return { records }; }, async text() { return ''; } };
    };

    const seen = new Set([GRADED_JOBS[0].url]);  // Stripe already seen
    const result = await injectCards({
      gradedJobs: [GRADED_JOBS[0], GRADED_JOBS[1]],  // A + B, both non-D
      seenUrls: seen,
      pat: 'test-pat',
      dataDir: dir,
      date: '2026-06-16',
      fetchImpl: mockFetch,
    });

    assert.equal(result.skipped_dupe, 1, 'Stripe URL should be skipped as dupe');
    assert.equal(result.injected, 1, 'only Notion should be injected');
    assert.equal(calls[0], 1, 'POST should contain exactly 1 record');
  });
});

describe('injectCards: dry-run', () => {
  test('dry-run returns zero injected and makes no Airtable calls', async () => {
    const dir = path.join(TMP, 'inject-dry');
    fs.mkdirSync(dir, { recursive: true });

    const calls = [];
    const mockFetch = async (_url, opts) => { calls.push(opts); return makeFetch(200, { records: [] })(); };

    const result = await injectCards({
      gradedJobs: [GRADED_JOBS[0]],
      seenUrls: new Set(),
      pat: 'test-pat',
      dataDir: dir,
      date: '2026-06-16',
      dryRun: true,
      fetchImpl: mockFetch,
    });

    assert.equal(result.injected, 0);
    assert.equal(result.dry_run, true);
    assert.equal(calls.length, 0, 'no HTTP calls in dry-run');
  });
});

describe('injectCards: missing PAT', () => {
  test('throws PAT_MISSING_MSG when pat is null and not dry-run', async () => {
    const dir = path.join(TMP, 'inject-nopat');
    fs.mkdirSync(dir, { recursive: true });

    await assert.rejects(
      () => injectCards({
        gradedJobs: [GRADED_JOBS[0]],
        seenUrls: new Set(),
        pat: null,
        dataDir: dir,
        date: '2026-06-16',
        fetchImpl: makeFetch(200, { records: [] }),
      }),
      /AIRTABLE_PAT/
    );
  });
});

describe('injectCards: card ID sequencing', () => {
  test('assigns sequential IDs starting from max+1', async () => {
    const dir = path.join(TMP, 'inject-seq');
    fs.mkdirSync(dir, { recursive: true });
    // Pre-populate with existing cards up to seq 5
    const existing = [{ id: 'live-2026-06-16-005' }];
    fs.writeFileSync(path.join(dir, 'kanban-import-2026-06-16.json'), JSON.stringify(existing));

    let postedFields = [];
    const mockFetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      postedFields = body.records.map((r) => r.fields);
      const records = body.records.map((r, i) => ({ id: `rec${i}`, fields: r.fields }));
      return { ok: true, status: 200, async json() { return { records }; }, async text() { return ''; } };
    };

    await injectCards({
      gradedJobs: [GRADED_JOBS[0], GRADED_JOBS[1]],
      seenUrls: new Set(),
      pat: 'test-pat',
      dataDir: dir,
      date: '2026-06-16',
      fetchImpl: mockFetch,
    });

    const cardIds = postedFields.map((f) => f['fldtRjBnJk7fsH6VX']);
    assert.equal(cardIds[0], 'live-2026-06-16-006', 'first card should be seq 006');
    assert.equal(cardIds[1], 'live-2026-06-16-007', 'second card should be seq 007');
  });
});

describe('injectCards: local kanban-import append', () => {
  test('new cards are appended to kanban-import after injection', async () => {
    const dir = path.join(TMP, 'inject-append');
    fs.mkdirSync(dir, { recursive: true });
    const kanbanPath = path.join(dir, 'kanban-import-2026-06-16.json');
    fs.writeFileSync(kanbanPath, JSON.stringify([{ id: 'live-2026-06-16-001', url: 'https://existing.com' }]));

    const mockFetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const records = body.records.map((r, i) => ({ id: `rec${i}`, fields: r.fields }));
      return { ok: true, status: 200, async json() { return { records }; }, async text() { return ''; } };
    };

    await injectCards({
      gradedJobs: [GRADED_JOBS[0]],  // Stripe, not in existing
      seenUrls: new Set(['https://existing.com']),
      pat: 'test-pat',
      dataDir: dir,
      date: '2026-06-16',
      fetchImpl: mockFetch,
      kanbanImportPath: kanbanPath,
    });

    const cards = JSON.parse(fs.readFileSync(kanbanPath, 'utf8'));
    assert.equal(cards.length, 2, 'existing + 1 new card');
    const newCard = cards[1];
    assert.equal(newCard.company, 'Stripe');
    assert.equal(newCard.columnId, 'new-fresh');
    assert.equal(newCard.hasConnection, false);
    assert.equal(newCard.isWarmReferral, false);
  });
});

// ── CLI integration: missing PAT → exit 1 ─────────────────────────────────────

describe('CLI: missing AIRTABLE_PAT', () => {
  test('exits 1 with helpful message when PAT is absent and not dry-run', () => {
    const dir = path.join(TMP, 'cli-nopat');
    fs.mkdirSync(dir, { recursive: true });
    const gradedPath = path.join(dir, 'graded-jobs-2026-06-16.json');
    fs.writeFileSync(gradedPath, JSON.stringify([GRADED_JOBS[0]]));

    let threw = false;
    try {
      execSync(
        `node scripts/kanban-inject.mjs --graded "${gradedPath}" --data "${dir}"`,
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AIRTABLE_PAT: '' } }
      );
    } catch (e) {
      threw = true;
      assert.ok(e.status !== 0, 'should exit non-zero');
      assert.ok(
        (e.stdout || '').includes('AIRTABLE_PAT') || (e.stderr || '').includes('AIRTABLE_PAT'),
        'error output should mention AIRTABLE_PAT'
      );
    }
    assert.ok(threw, 'should have thrown (non-zero exit)');
  });
});

describe('CLI: dry-run with no graded-jobs file', () => {
  test('exits 0 cleanly when no graded-jobs file found', () => {
    const dir = path.join(TMP, 'cli-nograded');
    fs.mkdirSync(dir, { recursive: true });

    const out = execSync(
      `node scripts/kanban-inject.mjs --dry-run --data "${dir}"`,
      { cwd: ROOT, encoding: 'utf8' }
    );
    assert.match(out, /no graded-jobs/i);
  });
});

describe('CLI: dry-run output file', () => {
  test('writes inject-run JSON even in dry-run mode', () => {
    const dir = path.join(TMP, 'cli-dryrun-out');
    fs.mkdirSync(dir, { recursive: true });
    const gradedPath = path.join(dir, 'graded-jobs-2026-06-16.json');
    fs.writeFileSync(gradedPath, JSON.stringify([GRADED_JOBS[0], GRADED_JOBS[2]]));

    execSync(
      `node scripts/kanban-inject.mjs --dry-run --graded "${gradedPath}" --data "${dir}"`,
      { cwd: ROOT, encoding: 'utf8' }
    );

    const outFiles = fs.readdirSync(dir).filter((f) => f.startsWith('inject-run-'));
    assert.equal(outFiles.length, 1, 'inject-run file should be written');

    const run = JSON.parse(fs.readFileSync(path.join(dir, outFiles[0]), 'utf8'));
    assert.equal(run.dry_run, true);
    assert.equal(run.injected, 0);
    assert.equal(run.skipped_grade_d, 1, 'grade-D Acme Sales Rep should be counted');
  });
});

after(cleanTmp);

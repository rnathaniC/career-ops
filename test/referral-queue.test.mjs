/**
 * referral-queue.test.mjs — Tests for Lane-Branch reporting (New-Hot vs New-Fresh)
 *
 * Run: node --test test/referral-queue.test.mjs
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
  newestKanbanImport,
  messagePreview,
  splitByLane,
  formatReferralBlock,
} from '../scripts/referral-queue.mjs';

const TMP = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-referral-test-'));
function cleanTmp() { fs.rmSync(TMP, { recursive: true, force: true }); }

const SAMPLE_CARDS = [
  { id: 'live-A1', company: 'Duolingo', role: 'PMO Lead', url: 'https://x/a1',
    grade: 'C', hasConnection: false, isWarmReferral: false, connectionName: '',
    jobDescText: 'PMO Lead at Duolingo — auto-discovered.', closedAt: null },
  { id: 'live-A2', company: 'Databricks', role: 'Field TPM', url: 'https://x/a2',
    grade: 'C', hasConnection: true, isWarmReferral: true, connectionName: 'Denny Lee',
    jobDescText: 'Field TPM at Databricks — warm referral via Denny Lee.', closedAt: null },
  { id: 'live-A3', company: 'Closed Co', role: 'Ghost Role', url: 'https://x/a3',
    grade: 'B', hasConnection: true, isWarmReferral: true, connectionName: 'Someone',
    jobDescText: 'should be excluded — already closed.', closedAt: '2026-06-10T00:00:00Z' },
  { id: 'live-A4', company: 'NoMessage Co', role: 'Mystery Role', url: 'https://x/a4',
    grade: 'B', hasConnection: true, isWarmReferral: true, connectionName: 'Jane Doe',
    jobDescText: '', closedAt: null },
];

// ── splitByLane ────────────────────────────────────────────────────────────────

describe('splitByLane', () => {
  test('splits warm-referral (New-Hot) from non-referral (New-Fresh)', () => {
    const { hot, fresh } = splitByLane(SAMPLE_CARDS);
    assert.deepEqual(hot.map((c) => c.id).sort(), ['live-A2', 'live-A3', 'live-A4']);
    assert.deepEqual(fresh.map((c) => c.id), ['live-A1']);
  });

  test('handles empty input', () => {
    const { hot, fresh } = splitByLane([]);
    assert.equal(hot.length, 0);
    assert.equal(fresh.length, 0);
  });

  test('ignores non-object / null entries defensively', () => {
    const { hot, fresh } = splitByLane([null, undefined, SAMPLE_CARDS[0]]);
    assert.equal(hot.length, 0);
    assert.equal(fresh.length, 1);
  });
});

// ── messagePreview ────────────────────────────────────────────────────────────

describe('messagePreview', () => {
  test('uses notes field when present', () => {
    const { text, drafted } = messagePreview({ notes: 'Hi Denny, hope you are well...' });
    assert.equal(drafted, true);
    assert.ok(text.startsWith('Hi Denny'));
  });

  test('falls back to jobDescText when notes is absent', () => {
    const { text, drafted } = messagePreview({ jobDescText: 'Field TPM at Databricks.' });
    assert.equal(drafted, true);
    assert.equal(text, 'Field TPM at Databricks.');
  });

  test('flags an empty Notes field instead of silently treating it as ready', () => {
    const { text, drafted } = messagePreview({ jobDescText: '', notes: '' });
    assert.equal(drafted, false);
    assert.match(text, /no outreach message drafted/);
  });

  test('truncates to 100 chars', () => {
    const long = 'x'.repeat(250);
    const { text } = messagePreview({ jobDescText: long });
    assert.equal(text.length, 100);
  });
});

// ── formatReferralBlock ───────────────────────────────────────────────────────

describe('formatReferralBlock', () => {
  test('includes company, role, connection name, and URL', () => {
    const block = formatReferralBlock(SAMPLE_CARDS[1]);
    assert.match(block, /Databricks/);
    assert.match(block, /Field TPM/);
    assert.match(block, /Denny Lee/);
    assert.match(block, /https:\/\/x\/a2/);
  });

  test('warns when no outreach message is drafted yet', () => {
    const block = formatReferralBlock(SAMPLE_CARDS[3]);
    assert.match(block, /no outreach message drafted/);
    assert.match(block, /draft an outreach message before sending/);
  });
});

// ── newestKanbanImport ────────────────────────────────────────────────────────

describe('newestKanbanImport', () => {
  test('returns null when directory has no matching files', () => {
    assert.equal(newestKanbanImport(TMP), null);
  });

  test('picks the most recently modified kanban-import file', () => {
    const older = path.join(TMP, 'kanban-import-2026-06-10.json');
    const newer = path.join(TMP, 'kanban-import-2026-06-12.json');
    fs.writeFileSync(older, '[]');
    fs.writeFileSync(newer, '[]');
    const now = Date.now();
    fs.utimesSync(older, new Date(now - 10000), new Date(now - 10000));
    fs.utimesSync(newer, new Date(now), new Date(now));
    assert.equal(newestKanbanImport(TMP), newer);
  });
});

// ── CLI integration ───────────────────────────────────────────────────────────

describe('referral-queue CLI', () => {
  test('exits 2 with no source file found', () => {
    const emptyDir = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-referral-empty-'));
    try {
      assert.throws(() => {
        execSync(`node scripts/referral-queue.mjs --data "${emptyDir}"`, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
      }, /Command failed/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test('writes a summary JSON with hot/fresh split and prints REFERRAL QUEUE blocks', () => {
    const inputPath = path.join(TMP, 'kanban-import-2026-06-15.json');
    fs.writeFileSync(inputPath, JSON.stringify(SAMPLE_CARDS));
    const outPath = path.join(TMP, 'referral-queue-out.json');

    const stdout = execSync(
      `node scripts/referral-queue.mjs --input "${inputPath}" --out "${outPath}"`,
      { cwd: ROOT, encoding: 'utf8' }
    );

    assert.match(stdout, /REFERRAL QUEUE — review and send/);
    assert.match(stdout, /Databricks/);
    assert.match(stdout, /2 card\(s\) waiting on Rahil/);

    const summary = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(summary.hot_count, 2);   // live-A2, live-A4 (live-A3 excluded: closedAt set)
    assert.equal(summary.fresh_count, 1); // live-A1
    assert.deepEqual(summary.fresh_ids, ['live-A1']);
    assert.ok(summary.hot.some((c) => c.id === 'live-A4' && c.message_drafted === false));
  });
});

after(cleanTmp);

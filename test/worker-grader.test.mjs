/**
 * worker-grader.test.mjs — Unit tests for worker-grader.mjs
 *
 * Run: node --test test/worker-grader.test.mjs
 *
 * Tests cover: grade thresholds, D-grade skip, no-scan-output exit 0,
 * platform normalization, keyword loading, TSV parsing, latestScanDate.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  gradeJob, normalizePlatform, parseScanHistory, latestScanDate, loadKeywords,
} from '../scripts/worker-grader.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-grader-test-'));
function cleanTmp() { fs.rmSync(TMP, { recursive: true, force: true }); }

// ── gradeJob ──────────────────────────────────────────────────────────────────

describe('gradeJob', () => {
  const kws = ['Program Manager', 'Scrum Master', 'Agile', 'TPM'];

  test('0 matches → D', () => {
    const r = gradeJob('Sales Associate', kws);
    assert.equal(r.grade, 'D');
    assert.deepEqual(r.keywords_matched, []);
  });

  test('1 match → C', () => {
    const r = gradeJob('Senior Scrum Master', kws);
    assert.equal(r.grade, 'C');
    assert.equal(r.keywords_matched.length, 1);
  });

  test('2 matches → B', () => {
    const r = gradeJob('Agile Program Manager', kws);
    assert.equal(r.grade, 'B');
    assert.equal(r.keywords_matched.length, 2);
  });

  test('3+ matches → A', () => {
    const r = gradeJob('Senior Agile Program Manager TPM', kws);
    assert.equal(r.grade, 'A');
    assert.ok(r.keywords_matched.length >= 3);
  });

  test('case-insensitive match', () => {
    const r = gradeJob('SCRUM MASTER', kws);
    assert.equal(r.grade, 'C');
  });

  test('empty title → D', () => {
    const r = gradeJob('', kws);
    assert.equal(r.grade, 'D');
  });
});

// ── normalizePlatform ─────────────────────────────────────────────────────────

describe('normalizePlatform', () => {
  test('strips -api suffix', () => {
    assert.equal(normalizePlatform('greenhouse-api'), 'greenhouse');
    assert.equal(normalizePlatform('ashby-api'),      'ashby');
    assert.equal(normalizePlatform('lever-api'),      'lever');
  });

  test('already clean names pass through', () => {
    assert.equal(normalizePlatform('greenhouse'), 'greenhouse');
    assert.equal(normalizePlatform('workday'),    'workday');
  });

  test('null/undefined → unknown', () => {
    assert.equal(normalizePlatform(null),      'unknown');
    assert.equal(normalizePlatform(undefined), 'unknown');
  });
});

// ── parseScanHistory ──────────────────────────────────────────────────────────

describe('parseScanHistory', () => {
  test('returns [] for missing file', () => {
    assert.deepEqual(parseScanHistory(path.join(TMP, 'nonexistent.tsv')), []);
  });

  test('returns [] for header-only file', () => {
    const p = path.join(TMP, 'header-only.tsv');
    fs.writeFileSync(p, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n');
    assert.deepEqual(parseScanHistory(p), []);
  });

  test('parses data rows correctly', () => {
    const p = path.join(TMP, 'scan-history.tsv');
    fs.writeFileSync(p, [
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus',
      'https://example.com/job1\t2026-06-16\tgreenhouse-api\tProgram Manager\tStripe\tadded',
      'https://example.com/job2\t2026-06-16\tashby-api\tSales Rep\tAcme\tadded',
    ].join('\n') + '\n');

    const rows = parseScanHistory(p);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].url,    'https://example.com/job1');
    assert.equal(rows[0].title,  'Program Manager');
    assert.equal(rows[0].company, 'Stripe');
    assert.equal(rows[0].portal, 'greenhouse-api');
  });

  test('skips rows with no url or title', () => {
    const p = path.join(TMP, 'bad-rows.tsv');
    fs.writeFileSync(p, [
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus',
      '\t2026-06-16\tgreenhouse-api\t\tStripe\tadded',  // empty url + title
      'https://example.com/job1\t2026-06-16\tgreenhouse-api\tOK Title\tStripe\tadded',
    ].join('\n') + '\n');

    const rows = parseScanHistory(p);
    assert.equal(rows.length, 1);
  });
});

// ── latestScanDate ────────────────────────────────────────────────────────────

describe('latestScanDate', () => {
  test('returns null for empty array', () => {
    assert.equal(latestScanDate([]), null);
  });

  test('returns the most recent date among entries', () => {
    const entries = [
      { first_seen: '2026-06-14' },
      { first_seen: '2026-06-16' },
      { first_seen: '2026-06-15' },
    ];
    assert.equal(latestScanDate(entries), '2026-06-16');
  });
});

// ── loadKeywords ──────────────────────────────────────────────────────────────

describe('loadKeywords', () => {
  test('reads target_titles from sources.yml', async () => {
    const configDir = path.join(TMP, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'sources.yml'), [
      'defaults:',
      '  target_titles:',
      '    - Custom Title A',
      '    - Custom Title B',
    ].join('\n'));

    const yaml = (await import('js-yaml')).default;
    const kws  = loadKeywords(TMP, yaml);
    assert.deepEqual(kws, ['Custom Title A', 'Custom Title B']);
  });

  test('falls back to hardcoded list when config missing', async () => {
    const yaml = (await import('js-yaml')).default;
    const kws  = loadKeywords(path.join(TMP, 'no-config-dir'), yaml);
    assert.ok(kws.length > 0);
    assert.ok(kws.some((k) => /program manager/i.test(k)));
  });
});

// ── CLI integration: no scan history → exit 0 ─────────────────────────────────

describe('CLI: no scan-history.tsv', () => {
  test('exits 0 cleanly when scan-history.tsv is missing', () => {
    // Run worker-grader pointing at a temp dir that has no scan-history.tsv.
    // Must not throw or exit non-zero.
    const out = execSync(
      `node scripts/worker-grader.mjs --history "${path.join(TMP, 'nonexistent.tsv')}"`,
      { cwd: ROOT, encoding: 'utf8' }
    );
    assert.match(out, /no scan-history|empty|skipping/i);
  });
});

describe('CLI: graded output file', () => {
  test('writes graded-jobs JSON with correct shape', () => {
    const histPath = path.join(TMP, 'scan-h-full.tsv');
    const outPath  = path.join(TMP, 'graded-output.json');
    const today    = new Date().toISOString().slice(0, 10);

    fs.writeFileSync(histPath, [
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus',
      `https://example.com/j1\t${today}\tgreenhouse-api\tProgram Manager\tStripe\tadded`,
      `https://example.com/j2\t${today}\tashby-api\tSales Rep\tAcme\tadded`,
    ].join('\n') + '\n');

    execSync(
      `node scripts/worker-grader.mjs --history "${histPath}" --out "${outPath}"`,
      { cwd: ROOT, encoding: 'utf8' }
    );

    assert.ok(fs.existsSync(outPath));
    const graded = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.ok(Array.isArray(graded));
    assert.equal(graded.length, 2);

    const pm = graded.find((g) => g.role === 'Program Manager');
    assert.ok(pm);
    assert.ok(['A', 'B', 'C'].includes(pm.grade), 'Program Manager should have grade A/B/C');

    const sales = graded.find((g) => g.role === 'Sales Rep');
    assert.ok(sales);
    assert.equal(sales.grade, 'D');
    assert.equal(sales.platform, 'ashby');

    for (const g of graded) {
      assert.ok('company'          in g);
      assert.ok('role'             in g);
      assert.ok('grade'            in g);
      assert.ok('platform'         in g);
      assert.ok('url'              in g);
      assert.ok('jd_snippet'       in g);
      assert.ok('keywords_matched' in g);
    }
  });
});

after(cleanTmp);

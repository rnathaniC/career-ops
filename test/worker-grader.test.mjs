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
  effectiveLocation, locationDisqualifiers,
} from '../scripts/worker-grader.mjs';
import { passesCommuteGate } from '../scripts/locations.mjs';

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

    // Use a company that is NOT in the referral registry so this test measures
    // BASE grading only. (CHANGE 3: a company with a live referral overlays grade
    // S — verified separately in referral-registry.test.mjs — which would
    // legitimately turn "Program Manager @ Stripe" into an S and mask the base
    // A/B/C check this test exists for.)
    fs.writeFileSync(histPath, [
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus',
      `https://example.com/j1\t${today}\tgreenhouse-api\tProgram Manager\tZeta Fictional Labs\tadded`,
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

    // Shape is mode-dependent (config/profile.yml grading.mode). The "title"
    // matcher emits keywords_matched; the substance grader emits matched_terms
    // + fit_score. Asserting only the title shape made this test fail the moment
    // substance mode became the default on 2026-08-10 — assert the shared
    // contract, then the mode-specific half.
    for (const g of graded) {
      assert.ok('company'    in g);
      assert.ok('role'       in g);
      assert.ok('grade'      in g);
      assert.ok('platform'   in g);
      assert.ok('url'        in g);
      assert.ok('jd_snippet' in g);
      const hasTitleShape     = 'keywords_matched' in g;
      const hasSubstanceShape = 'matched_terms' in g && 'fit_score' in g;
      assert.ok(
        hasTitleShape || hasSubstanceShape,
        `graded entry must carry either keywords_matched (title mode) or matched_terms+fit_score (substance mode); got ${Object.keys(g).join(',')}`,
      );
    }
  });
});

// B-0821-1 regression: an unresolved Workday aggregate ("2 Locations") is
// truthy and used to short-circuit URL-derivation, so a placeholder location
// fared BETTER than a blank one and fell through the commute gate's fail-open.
// Real leak: Fiserv "Payment Relations Manager EMEA Acquiring" (Basildon, UK)
// graded A and landed in the HOT lane on 2026-08-18.
describe('effectiveLocation — unresolved multi-location (B-0821-1)', () => {
  const FISERV_UK = 'https://fiserv.wd5.myworkdayjobs.com/EXT/job/Basildon-Endeavour-Drive/Payment-Relations-Manager-EMEA-Acquiring_R-10386690-1';

  test('recovers a real city from the URL when location is "N Locations"', () => {
    assert.equal(
      effectiveLocation({ location: '2 Locations', url: FISERV_UK }),
      'Basildon Endeavour Drive',
    );
  });

  test('placeholder + foreign URL is DROPPED by the commute gate', () => {
    const eff = effectiveLocation({ location: '2 Locations', url: FISERV_UK });
    assert.equal(passesCommuteGate(eff, 'Regional Product Manager').keep, false);
  });

  test('"Multiple Locations" takes the same recovery path', () => {
    assert.equal(
      effectiveLocation({ location: 'Multiple Locations', url: FISERV_UK }),
      'Basildon Endeavour Drive',
    );
  });

  test('a real location field is never overridden by the URL', () => {
    assert.equal(
      effectiveLocation({ location: 'Frisco, TX', url: FISERV_UK }),
      'Frisco, TX',
    );
  });

  test('local placeholder + local URL still KEEPS', () => {
    const eff = effectiveLocation({
      location: '4 Locations',
      url: 'https://x.wd1.myworkdayjobs.com/y/job/Frisco-TX/Product-Manager_R2',
    });
    assert.equal(passesCommuteGate(eff, 'Product Manager').keep, true);
  });

  test('genuinely unknown (placeholder, no usable URL) still fails OPEN', () => {
    const eff = effectiveLocation({ location: '61 Locations', url: '' });
    assert.equal(eff, '61 Locations');
    assert.equal(passesCommuteGate(eff, 'Product Manager').keep, true);
  });
});

// B-0821-2 regression: bare "remote" was in the "a US option exists" token set,
// so any location containing the word short-circuited the foreign screen.
// Real leak: Twilio "Product Manager — Remote - Estonia" graded A and APPLIED.
describe('locationDisqualifiers — remote is not a US token (B-0821-2)', () => {
  const drops = ['Remote - Estonia', 'Remote - India', 'Remote, Tallinn'];
  for (const loc of drops) {
    test(`"${loc}" is disqualified`, () => {
      assert.ok(locationDisqualifiers(loc).length > 0, `${loc} should disqualify`);
    });
  }

  const keeps = ['Remote', 'Remote Nationwide', 'US-Remote', 'TX - Work from home'];
  for (const loc of keeps) {
    test(`"${loc}" still passes clean`, () => {
      assert.deepEqual(locationDisqualifiers(loc), []);
    });
  }

  test('dual-sited US+foreign keeps the documented asymmetry', () => {
    assert.deepEqual(locationDisqualifiers('Remote within Canada or United States'), []);
    assert.deepEqual(locationDisqualifiers('San Francisco, CA, US; Remote, CA, US'), []);
  });
});

// B-0816-3 regression (closed 2026-08-21): the US token set knew only
// us/usa/united states/dallas/texas/tx, so "New York; London" matched no US
// token, fell through to the foreign screen and was hard-D'd — a false
// negative that silently shrank the funnel.
describe('locationDisqualifiers — US states and metros (B-0816-3)', () => {
  const keeps = [
    'New York; London', 'Chicago, Illinois; Berlin', 'Charlotte, NC',
    'NJ - Work from home', 'US-TX-PLANO-465', 'Bellevue Washington', 'New Mexico',
  ];
  for (const loc of keeps) {
    test(`"${loc}" is recognised as a US option`, () => {
      assert.deepEqual(locationDisqualifiers(loc), [], `${loc} should be clean`);
    });
  }

  test('foreign-only locations are still disqualified', () => {
    for (const loc of ['Bogota, Colombia', 'Glenrothes, Fife', 'Sao Paulo Brazil',
                       'Madrid Madrid Spain', 'Besiktas Istanbul Turkey', 'Pune']) {
      assert.ok(locationDisqualifiers(loc).length > 0, `${loc} should disqualify`);
    }
  });
});

after(cleanTmp);

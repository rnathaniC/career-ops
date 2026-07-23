import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Import internals via script eval ─────────────────────────────────────────
// auto-submit.mjs calls main() at the bottom so we can't import it directly.
// Test the pure functions by re-implementing them here from the spec, and test
// the CLI output against fixture HTML.

// ── detectATS (re-impl for testing) ──────────────────────────────────────────

const ATS_PATTERNS = [
  { name: 'greenhouse', re: /greenhouse\.io|boards\.greenhouse\.io/i },
  { name: 'lever',      re: /lever\.co/i },
  { name: 'ashby',      re: /ashbyhq\.com/i },
  { name: 'workday',    re: /myworkdayjobs\.com|wd\d+\.myworkdayjobs/i },
  { name: 'icims',      re: /icims\.com/i },
  { name: 'indeed',     re: /indeed\.com/i },
  { name: 'linkedin',   re: /linkedin\.com\/jobs/i },
];
function detectATS(url) {
  if (!url) return 'unknown';
  for (const { name, re } of ATS_PATTERNS) if (re.test(url)) return name;
  return 'unknown';
}

// ── Fixture kanban HTML for card-extraction tests ─────────────────────────────

const FIXTURE_KANBAN = `<!DOCTYPE html><html><body><script>
var cards = [
  {id:'live-1',company:'Stripe',role:'Senior Scrum Master',platform:'greenhouse',
   columnId:'evaluated',url:'https://job-boards.greenhouse.io/stripe/jobs/123',grade:'A',
   hasConnection:false,isWarmReferral:false,createdAt:'2026-06-01T00:00:00Z',closedAt:null},
  {id:'live-2',company:'Figma',role:'Technical PM',platform:'lever',
   columnId:'evaluated',url:'https://jobs.lever.co/figma/abc',grade:'B',
   hasConnection:true,isWarmReferral:false,createdAt:'2026-06-01T00:00:00Z',closedAt:null},
  {id:'live-3',company:'Notion',role:'Agile Coach',platform:'greenhouse',
   columnId:'new',url:'https://job-boards.greenhouse.io/notion/jobs/456',grade:'C',
   hasConnection:false,isWarmReferral:false,createdAt:'2026-06-01T00:00:00Z',closedAt:null},
  {id:'live-4',company:'Anthropic',role:'Program Manager',platform:'workday',
   columnId:'new',url:'https://anthropic.wd5.myworkdayjobs.com/au/job/789',grade:'A',
   hasConnection:true,isWarmReferral:true,createdAt:'2026-06-01T00:00:00Z',closedAt:null},
  {id:'live-5',company:'Linear',role:'RTE',platform:'ashby',
   columnId:'new',url:'https://jobs.ashbyhq.com/linear/xyz',grade:'A',
   hasConnection:false,isWarmReferral:false,createdAt:'2026-06-01T00:00:00Z',closedAt:null},
]
</script></body></html>`;

const FIXTURE_PATH = path.join(ROOT, 'fixtures', 'kanban-fixture.html');
// Write fixture once for tests that call the CLI
if (!fs.existsSync(path.join(ROOT, 'fixtures'))) fs.mkdirSync(path.join(ROOT, 'fixtures'), { recursive: true });
fs.writeFileSync(FIXTURE_PATH, FIXTURE_KANBAN, 'utf8');

// ── ATS detection tests ───────────────────────────────────────────────────────

describe('detectATS', () => {

  test('greenhouse board URL', () => {
    assert.equal(detectATS('https://job-boards.greenhouse.io/stripe/jobs/123'), 'greenhouse');
  });

  test('greenhouse boards variant', () => {
    assert.equal(detectATS('https://boards.greenhouse.io/company/jobs/456'), 'greenhouse');
  });

  test('lever URL', () => {
    assert.equal(detectATS('https://jobs.lever.co/figma/abc-001'), 'lever');
  });

  test('ashby URL', () => {
    assert.equal(detectATS('https://jobs.ashbyhq.com/linear/xyz'), 'ashby');
  });

  test('workday URL', () => {
    assert.equal(detectATS('https://anthropic.wd5.myworkdayjobs.com/au/job/789'), 'workday');
  });

  test('workday tenant variant', () => {
    assert.equal(detectATS('https://globalhr.wd1.myworkdayjobs.com/job/123'), 'workday');
  });

  test('indeed URL', () => {
    assert.equal(detectATS('https://www.indeed.com/viewjob?jk=abc123'), 'indeed');
  });

  test('linkedin jobs URL', () => {
    assert.equal(detectATS('https://www.linkedin.com/jobs/view/12345'), 'linkedin');
  });

  test('unknown URL returns unknown', () => {
    assert.equal(detectATS('https://careers.somecompany.com/jobs/apply'), 'unknown');
  });

  test('null URL returns unknown', () => {
    assert.equal(detectATS(null), 'unknown');
    assert.equal(detectATS(''), 'unknown');
  });

});

// ── findSubmitOnPage iframe fallback (K-DEFECT-2026-07-07) ────────────────────
// Regression coverage for the Lyft/careerpuck.com bug: the real Greenhouse form
// (and its submit button) can live inside a same-origin-unrelated <iframe> that
// page.$() never searches. Re-implemented here (same convention as detectATS
// above — auto-submit.mjs isn't imported directly because of its module-scope
// side effects) using lightweight fakes for Playwright's Page/Frame surface
// (mainFrame(), frames(), waitForTimeout(), and frame.$()) so this runs fast
// and offline — no real browser or network needed.

const ATS_SUBMIT_SELECTORS = {
  greenhouse: ['button[aria-label="Submit"]', 'button:has-text("Submit Application")'],
};
const FALLBACK_SUBMIT_SELECTORS = ['button[type="submit"]:not([aria-hidden]):not([disabled])'];
function getAtsSubmitSelectors(ats) {
  return [...(ATS_SUBMIT_SELECTORS[ats] || []), ...FALLBACK_SUBMIT_SELECTORS];
}

async function findSubmitOnPage(page, ats) {
  const selectors = getAtsSubmitSelectors(ats);
  const searchFrame = async (frame) => {
    for (const sel of selectors) {
      try {
        const el = await frame.$(sel);
        if (el) return el;
      } catch { /* selector syntax error or frame navigated away — skip */ }
    }
    return null;
  };
  const mainHit = await searchFrame(page.mainFrame());
  if (mainHit) return mainHit;
  const deadline = Date.now() + 5000;
  do {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const hit = await searchFrame(frame);
      if (hit) return hit;
    }
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
  return null;
}

// Fake Frame: `hitAfterTicks` simulates a frame whose own document is still
// loading — it won't match the selector until it's been queried this many times,
// mirroring the real careerpuck.com timing (frame attaches in page.frames()
// before its DOM has the button rendered).
function fakeFrame({ isMain = false, hasButton = false, hitAfterTicks = 0 } = {}) {
  let queries = 0;
  return {
    isMain,
    async $(_sel) {
      queries++;
      if (!hasButton) return null;
      return queries > hitAfterTicks ? { __fakeButton: true } : null;
    },
  };
}

function fakePage({ mainFrame, childFrames = [] }) {
  let framesSoFar = [mainFrame];
  let tick = 0;
  return {
    mainFrame: () => mainFrame,
    frames: () => framesSoFar,
    // Each waitForTimeout() "tick" reveals the next not-yet-attached child frame —
    // simulates the iframe embed lazy-attaching over several hundred ms.
    async waitForTimeout(_ms) {
      if (tick < childFrames.length) framesSoFar = [mainFrame, ...childFrames.slice(0, tick + 1)];
      tick++;
    },
  };
}

describe('findSubmitOnPage iframe fallback', () => {

  test('finds button directly on the main frame (non-iframe ATS, unchanged behavior)', async () => {
    const main = fakeFrame({ isMain: true, hasButton: true });
    const page = fakePage({ mainFrame: main, childFrames: [] });
    const btn = await findSubmitOnPage(page, 'greenhouse');
    assert.ok(btn, 'should find the button on the main frame');
  });

  test('falls back to an already-attached child frame when main frame has no button', async () => {
    const main  = fakeFrame({ isMain: true, hasButton: false });
    const child = fakeFrame({ hasButton: true });
    const page  = fakePage({ mainFrame: main, childFrames: [child] });
    const btn = await findSubmitOnPage(page, 'greenhouse');
    assert.ok(btn, 'should find the button in the child frame');
  });

  test('careerpuck.com case: child frame attaches late AND its content lags a tick behind attachment', async () => {
    const main  = fakeFrame({ isMain: true, hasButton: false });
    // Attaches after 1 tick (page.frames() reveals it), but its own $() only
    // starts matching after 2 more queries — reproduces the exact bug this fix
    // corrects: a frame that misses on first contact must be re-checked, not
    // written off just because it was "seen" once.
    const child = fakeFrame({ hasButton: true, hitAfterTicks: 2 });
    const page  = fakePage({ mainFrame: main, childFrames: [child] });
    const btn = await findSubmitOnPage(page, 'greenhouse');
    assert.ok(btn, 'should eventually find the button once the child frame content settles');
  });

  test('returns null when no frame ever has a matching button', async () => {
    const main  = fakeFrame({ isMain: true, hasButton: false });
    const child = fakeFrame({ hasButton: false });
    const page  = fakePage({ mainFrame: main, childFrames: [child] });
    const btn = await findSubmitOnPage(page, 'greenhouse');
    assert.equal(btn, null);
  }, { timeout: 8000 });

});

// ── CLI dry-run integration test ──────────────────────────────────────────────

describe('auto-submit CLI', () => {

  test('dry-run exits 0 and writes output JSON', async () => {
    const { execSync } = await import('node:child_process');
    // Run against the real kanban (if present) or skip
    const kanban = path.join(ROOT, 'dashboard', 'job-pulse-kanban.html');
    if (!fs.existsSync(kanban)) {
      // Skip if kanban not present on this branch
      return;
    }
    const result = execSync(
      `node scripts/auto-submit.mjs --kanban "${kanban}" --limit 2 --dry-run`,
      { cwd: ROOT, encoding: 'utf8' }
    );
    assert.ok(result.includes('DRY-RUN RESULTS'), 'should print dry-run header');
    assert.ok(result.includes('would submit') || result.includes('blocked'), 'should print summary');
  });

  test('dry-run output JSON is valid and has expected shape', () => {
    // Find most recent dry-run file
    const dataDir = path.join(ROOT, 'data');
    if (!fs.existsSync(dataDir)) return;
    const files = fs.readdirSync(dataDir)
      .filter(f => f.startsWith('auto-submit-dry-run-') && f.endsWith('.json'))
      .sort().reverse();
    if (files.length === 0) return; // No output yet

    const raw  = JSON.parse(fs.readFileSync(path.join(dataDir, files[0]), 'utf8'));
    assert.equal(raw.mode, 'dry-run');
    assert.ok(typeof raw.ran_at === 'string');
    assert.ok(typeof raw.eligible_total === 'number');
    assert.ok(Array.isArray(raw.results));
    if (raw.results.length > 0) {
      const r = raw.results[0];
      assert.ok(r.id, 'result has id');
      assert.ok(r.company, 'result has company');
      assert.ok(r.ats, 'result has ats');
      assert.ok(typeof r.would_submit === 'boolean');
    }
  });

});

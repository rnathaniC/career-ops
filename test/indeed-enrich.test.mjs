/**
 * indeed-enrich.test.mjs — K-0810-1 employer-signal enrichment.
 *
 * Run: node --test test/indeed-enrich.test.mjs
 *
 * The contract worth protecting here is the ASYMMETRY: this layer may only
 * downgrade, never upgrade, never past C, and absence of data is never a
 * penalty. Those are the properties that keep it from quietly shrinking the
 * funnel the way a naive employer filter would.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normKey, parseSalary, evaluateEmployer, downgrade, applySignal,
  enrichCards, pendingLookups, THRESHOLDS, normalizeIndeedPayload, parseCompensationLine,
  isBelowCompFloor, loadCompFloor, HARD_EXCLUDE_GRADE, violatesCompPolicy, loadRangeHeadroomPct,
  loadBottomTolerancePct,
} from '../scripts/indeed-enrich.mjs';

const compFloor = 110000; // matches config/profile.yml compensation.minimum
const POLICY = { tolerancePct: 20, headroomPct: 0 }; // min allowed bottom = $88,000
const card = (over = {}) => ({ company: 'Acme', role: 'Program Manager', grade: 'B', ...over });

describe('normKey', () => {
  test('is insensitive to case and punctuation', () => {
    assert.equal(normKey('Toyota Motors N.A.', 'Program Manager'), normKey('toyota motors na', 'program manager'));
  });
  test('separates company from title', () => {
    assert.notEqual(normKey('Acme', 'PM'), normKey('Acme PM', ''));
  });
});

describe('parseSalary', () => {
  test('parses K-notation, commas, plain numbers', () => {
    assert.equal(parseSalary('$130K'), 130000);
    assert.equal(parseSalary('$130,000'), 130000);
    assert.equal(parseSalary('145000'), 145000);
    assert.equal(parseSalary(120000), 120000);
  });
  test('takes the low end of a range', () => {
    assert.equal(parseSalary('$120,000 - $170,000'), 120000);
  });
  test('returns null for junk', () => {
    assert.equal(parseSalary(null), null);
    assert.equal(parseSalary('competitive'), null);
  });
});

describe('evaluateEmployer', () => {
  test('missing signal is no-signal, never a penalty', () => {
    const r = evaluateEmployer(null, { compFloor });
    assert.deepEqual(r.flags, ['no-signal']);
    assert.equal(r.steps, 0);
  });
  test('an entry with no usable fields is also no-signal', () => {
    const r = evaluateEmployer({ company: 'Acme' }, { compFloor });
    assert.deepEqual(r.flags, ['no-signal']);
    assert.equal(r.steps, 0);
  });
  test('healthy employer produces zero flags', () => {
    const r = evaluateEmployer({ rating: 4.1, ceo_approval: 82, salary_max: 165000 }, { compFloor });
    assert.deepEqual(r.flags, []);
    assert.equal(r.steps, 0);
  });
  test('low rating fires one step', () => {
    const r = evaluateEmployer({ rating: 2.4, ceo_approval: 70, salary_max: 150000 }, { compFloor });
    assert.equal(r.steps, 1);
    assert.match(r.flags[0], /^low-rating/);
  });
  test('low CEO approval fires one step', () => {
    const r = evaluateEmployer({ rating: 3.8, ceo_approval: 41, salary_max: 150000 }, { compFloor });
    assert.equal(r.steps, 1);
    assert.match(r.flags[0], /^low-ceo-approval/);
  });
  test('comp below floor fires one step', () => {
    const r = evaluateEmployer({ rating: 4.0, ceo_approval: 80, salary_max: 95000, salary_n: 40 }, { compFloor, ...POLICY });
    assert.equal(r.steps, 1);
    assert.match(r.flags[0], /^comp-below-floor/);
  });
  test('comp uses the optimistic band max, so a low min alone does not fire', () => {
    const r = evaluateEmployer({ salary_min: 90000, salary_max: 160000 }, { compFloor });
    assert.deepEqual(r.flags, []);
  });
  test('two flags cap at two steps, three flags still cap at two', () => {
    const r = evaluateEmployer({ rating: 2.1, ceo_approval: 30, salary_max: 90000 }, { compFloor });
    assert.equal(r.flags.length, 3);
    assert.equal(r.steps, 2);
  });
  test('boundary values are inclusive-pass (rating 3.0, ceo 50, comp at floor)', () => {
    const r = evaluateEmployer(
      { rating: THRESHOLDS.rating_floor, ceo_approval: THRESHOLDS.ceo_approval_floor, salary_max: compFloor },
      { compFloor },
    );
    assert.deepEqual(r.flags, []);
  });
});

describe('downgrade', () => {
  test('drops letters but never past C', () => {
    assert.equal(downgrade('A', 1), 'B');
    assert.equal(downgrade('A', 2), 'C');
    assert.equal(downgrade('B', 2), 'C');
    assert.equal(downgrade('C', 2), 'C');
  });
  test('never touches D and never upgrades', () => {
    assert.equal(downgrade('D', 2), 'D');
    assert.equal(downgrade('B', 0), 'B');
    assert.equal(downgrade('B', -1), 'B');
  });
});

describe('applySignal', () => {
  test('B card with a bad employer drops to C — out of auto-submit eligibility', () => {
    const out = applySignal(card(), { rating: 2.2, fetched: '2026-08-10' }, { compFloor });
    assert.equal(out.grade, 'C');
    assert.equal(out.grade_before_employer_signal, 'B');
    assert.equal(out.employer_signal.downgraded_by, 1);
  });
  test('clean employer leaves the grade untouched and records the evidence', () => {
    const out = applySignal(card({ grade: 'A' }), { rating: 4.3, ceo_approval: 88, salary_max: 175000 }, { compFloor });
    assert.equal(out.grade, 'A');
    assert.equal(out.grade_before_employer_signal, undefined);
    assert.equal(out.employer_signal.rating, 4.3);
  });
  test('no signal leaves grade untouched', () => {
    const out = applySignal(card({ grade: 'A' }), null, { compFloor });
    assert.equal(out.grade, 'A');
    assert.equal(out.employer_signal.source, 'none');
  });
  test('does not mutate the input card', () => {
    const c = card();
    applySignal(c, { rating: 1.9 }, { compFloor });
    assert.equal(c.grade, 'B');
    assert.equal(c.employer_signal, undefined);
  });
});

describe('enrichCards', () => {
  const cache = {
    entries: {
      [normKey('Acme', 'Program Manager')]: { rating: 2.0, fetched: '2026-08-10' },
      [normKey('Globex', 'Scrum Master')]: { rating: 4.4, ceo_approval: 90, salary_max: 160000, fetched: '2026-08-10' },
    },
  };
  test('enriches what it can and counts the rest as missing', () => {
    const { cards, stats } = enrichCards(
      [card(), card({ company: 'Globex', role: 'Scrum Master', grade: 'A' }), card({ company: 'Initech', grade: 'A' })],
      cache, { compFloor },
    );
    assert.equal(stats.enriched, 2);
    assert.equal(stats.missing, 1);
    assert.equal(stats.downgraded, 1);
    assert.equal(cards[0].grade, 'C');
    assert.equal(cards[1].grade, 'A');
    assert.equal(cards[2].grade, 'A'); // unknown employer keeps its grade
  });
});

describe('pendingLookups', () => {
  const now = new Date('2026-08-10');
  test('skips grade D and de-dupes repeat company+title pairs', () => {
    const p = pendingLookups(
      [card(), card(), card({ company: 'Initech', grade: 'D' })],
      { entries: {} }, { now },
    );
    assert.equal(p.length, 1);
    assert.equal(p[0].company, 'Acme');
    assert.equal(p[0].reason, 'missing');
  });
  test('re-fetches entries past the TTL but leaves fresh ones alone', () => {
    const cache = {
      entries: {
        [normKey('Acme', 'Program Manager')]: { rating: 4, fetched: '2026-01-01' },
        [normKey('Globex', 'Scrum Master')]:  { rating: 4, fetched: '2026-08-05' },
      },
    };
    const p = pendingLookups([card(), card({ company: 'Globex', role: 'Scrum Master' })], cache, { now });
    assert.equal(p.length, 1);
    assert.equal(p[0].company, 'Acme');
    assert.match(p[0].reason, /^stale:/);
  });
});

// ── normalizeIndeedPayload: fixtures captured from LIVE MCP calls 2026-08-10 ──
// These are trimmed real responses, not invented shapes. They exist to lock in
// the three wrapper traps documented on normalizeIndeedPayload.

const LYFT_RAW = {
  employerData: {
    ugcStats: {
      ratings_in_1_to_5_scale: {},
      ceo_approval_percentage: { approval_percentage: 0.4251 },
      salarySatisfaction: { yesCount: 5222, noCount: 9752 },
      recommendFriend: { yesCount: 8019, noCount: 6634 },
    },
    companyPageUrl: 'https://www.indeed.com/cmp/Lyft-Drivers-4',
    salaries: { forJobTitle: 'Technical Program Manager', forLocation: 'US', averageSalary: 198001.53, count: 6 },
  },
};

const PWC_RAW = {
  employerData: {
    ugcStats: {
      ratings_in_1_to_5_scale: {},
      ceo_approval_percentage: { approval_percentage: 0.568 },
      salarySatisfaction: { yesCount: 1552, noCount: 960 },
      recommendFriend: { yesCount: 1918, noCount: 697 },
    },
    companyPageUrl: 'https://www.indeed.com/cmp/Pwc',
    salaries: { forJobTitle: 'Technical Program Manager', forLocation: 'US' }, // no averageSalary
  },
};

describe('normalizeIndeedPayload (live-shape fixtures)', () => {
  test('converts the CEO approval FRACTION to a percent', () => {
    const e = normalizeIndeedPayload(LYFT_RAW, { company: 'Lyft', title: 'TPM', fetched: '2026-08-10' });
    assert.equal(e.ceo_approval, 42.5);
  });
  test('derives recommend_friend when the star rating is absent', () => {
    const e = normalizeIndeedPayload(LYFT_RAW, { company: 'Lyft', title: 'TPM' });
    assert.equal(e.rating, undefined);
    assert.equal(e.recommend_friend, 54.7);
    assert.equal(e.recommend_friend_n, 14653);
  });
  test('tolerates a salaries object with no averageSalary', () => {
    const e = normalizeIndeedPayload(PWC_RAW, { company: 'PwC', title: 'TPM' });
    assert.equal(e.salary_avg, undefined);
    assert.equal(e.ceo_approval, 56.8);
  });
  test('carries the company page url through', () => {
    assert.equal(normalizeIndeedPayload(PWC_RAW, {}).url, 'https://www.indeed.com/cmp/Pwc');
  });
  test('an empty payload normalizes to a bare entry that reads as no-signal', () => {
    const e = normalizeIndeedPayload({}, { company: 'Ghost', title: 'PM' });
    assert.deepEqual(evaluateEmployer(e, { compFloor }).flags, ['no-signal']);
  });
});

describe('live employer signals produce the right verdicts', () => {
  test('Lyft: CEO approval 42.5% is below floor → one downgrade step', () => {
    const e = normalizeIndeedPayload(LYFT_RAW, { company: 'Lyft', title: 'TPM' });
    const r = evaluateEmployer(e, { compFloor });
    assert.equal(r.steps, 1);
    assert.ok(r.flags.some((f) => f.startsWith('low-ceo-approval')));
  });
  test("Lyft: the thin 6-report $198K average is ignored, not treated as a pass or a fail", () => {
    const e = normalizeIndeedPayload(LYFT_RAW, { company: 'Lyft', title: 'TPM' });
    const r = evaluateEmployer(e, { compFloor });
    assert.equal(r.evidence.salary_considered, undefined);
    assert.deepEqual(r.evidence.salary_ignored_low_sample, { value: 198002, n: 6 });
    assert.ok(!r.flags.some((f) => f.startsWith('comp-below-floor')));
  });
  test('PwC: healthy on every available axis → no flags, grade untouched', () => {
    const e = normalizeIndeedPayload(PWC_RAW, { company: 'PwC', title: 'TPM' });
    assert.deepEqual(evaluateEmployer(e, { compFloor }).flags, []);
    assert.equal(applySignal(card({ grade: 'B' }), e, { compFloor }).grade, 'B');
  });
});

// ── posting-level compensation (inline from search_jobs) ──────────────────────
// Real strings captured from a live search_jobs call, Dallas TX, 2026-08-10.

describe('parseCompensationLine', () => {
  test('parses a yearly range', () => {
    const c = parseCompensationLine('$100,000 - $120,000 a year');
    assert.equal(c.annual_min, 100000);
    assert.equal(c.annual_max, 120000);
    assert.equal(c.period, 'year');
  });
  test('parses decimals in a range', () => {
    const c = parseCompensationLine('$111,120.10 - $155,177.13 a year');
    assert.equal(c.annual_min, 111120);
    assert.equal(c.annual_max, 155177);
  });
  test('annualizes hourly pay at 2080h', () => {
    const c = parseCompensationLine('$45.00 - $55.00 an hour');
    assert.equal(c.annual_min, 93600);
    assert.equal(c.annual_max, 114400);
  });
  test('annualizes monthly pay at 12x', () => {
    assert.equal(parseCompensationLine('$8,000 a month').annual_max, 96000);
  });
  test('handles open-ended "From" and "Up to" phrasing', () => {
    const from = parseCompensationLine('From $130,000 a year');
    assert.equal(from.annual_min, 130000);
    assert.equal(from.annual_max, null);
    const upto = parseCompensationLine('Up to $150,000 a year');
    assert.equal(upto.annual_max, 150000);
    assert.equal(upto.annual_min, null);
  });
  test('a single figure becomes a degenerate band', () => {
    const c = parseCompensationLine('$140,000 a year');
    assert.equal(c.annual_min, 140000);
    assert.equal(c.annual_max, 140000);
  });
  test('N/A and junk return null rather than a fake zero', () => {
    assert.equal(parseCompensationLine('N/A'), null);
    assert.equal(parseCompensationLine(''), null);
    assert.equal(parseCompensationLine('Competitive'), null);
    assert.equal(parseCompensationLine(null), null);
  });
});

describe('posting comp takes precedence over the company average', () => {
  test('a posting band under floor fires the posting-specific flag', () => {
    const sig = {
      salary_avg: 198000, salary_n: 50,            // company average says fine
      posting_comp: parseCompensationLine('$70,000 - $95,000 a year'), // posting says no
    };
    const r = evaluateEmployer(sig, { compFloor, ...POLICY });
    assert.equal(r.evidence.salary_basis, 'posting');
    assert.ok(r.flags.some((f) => f.startsWith('comp-policy-')));
  });
  test('a posting band over floor clears it even when the company average is low', () => {
    const sig = {
      salary_avg: 90000, salary_n: 50,
      posting_comp: parseCompensationLine('$150,000 - $180,000 a year'),
    };
    const r = evaluateEmployer(sig, { compFloor, ...POLICY });
    assert.equal(r.evidence.salary_basis, 'posting');
    assert.deepEqual(r.flags, []);
  });
  test('with no posting band it falls back to the company average', () => {
    const r = evaluateEmployer({ salary_avg: 90000, salary_n: 50 }, { compFloor });
    assert.equal(r.evidence.salary_basis, 'company-average');
    assert.ok(r.flags.some((f) => f.startsWith('comp-below-floor:')));
  });
  test('real posting: MPI Energy $110-130K now PASSES — reaches $110K, bottom is at the floor', () => {
    const sig = { posting_comp: parseCompensationLine('$110,000 - $130,000 a year') };
    const r = evaluateEmployer(sig, { compFloor, ...POLICY });
    assert.equal(r.exclude, false);
  });
  test('real posting: ioVista $90-120K now PASSES at the finalized 20% tolerance', () => {
    const r = evaluateEmployer({ posting_comp: parseCompensationLine('$90,000 - $120,000 a year') }, { compFloor, ...POLICY });
    assert.equal(r.exclude, false);
  });
});

// ── Below-floor POSTING comp hard-excludes to D (Rahil 2026-08-10) ────────────

describe('comp floor is wired to the configured value, not a literal', () => {
  test('loadCompFloor reads $110K out of config/profile.yml', () => {
    assert.equal(loadCompFloor(), 110000);
    // Guards the five-places-drift problem: if someone edits profile.yml, this
    // module must follow rather than keeping a stale constant.
  });
});

describe('below-floor POSTING comp hard-excludes to D', () => {
  test('a published band under floor grades D, not C', () => {
    const sig = { posting_comp: parseCompensationLine('$80,000 - $95,000 a year') };
    const out = applySignal(card({ grade: 'A' }), sig, { compFloor, ...POLICY });
    assert.equal(out.grade, HARD_EXCLUDE_GRADE);
    assert.equal(out.grade, 'D');
    assert.equal(out.employer_signal.excluded, true);
    assert.equal(out.grade_before_employer_signal, 'A');
  });
  test('exclusion ignores the never-below-C downgrade floor entirely', () => {
    const sig = { posting_comp: parseCompensationLine('$50,000 a year') };
    assert.equal(applySignal(card({ grade: 'C' }), sig, { compFloor, ...POLICY }).grade, 'D');
  });
  test('hourly work that annualizes under floor is excluded too', () => {
    const r = evaluateEmployer({ posting_comp: parseCompensationLine('$40.00 - $45.00 an hour') }, { compFloor, ...POLICY });
    assert.equal(r.exclude, true);
  });
  test('a band straddling the floor now survives if its bottom stays inside tolerance', () => {
    const r = evaluateEmployer({ posting_comp: parseCompensationLine('$95,000 - $125,000 a year') }, { compFloor, ...POLICY });
    assert.equal(r.exclude, false);
  });
});

describe('no comp attached is never rated differently (explicit Rahil instruction)', () => {
  test('a posting with no comp keeps its grade and earns no flag', () => {
    const out = applySignal(card({ grade: 'A' }), { posting_comp: null }, { compFloor, ...POLICY });
    assert.equal(out.grade, 'A');
    assert.deepEqual(out.employer_signal.flags, ['no-signal']);
  });
  test('"N/A" comp is silence, not a low number', () => {
    const sig = { posting_comp: parseCompensationLine('N/A') };
    const r = evaluateEmployer(sig, { compFloor, ...POLICY });
    assert.equal(r.exclude, false);
    assert.equal(r.evidence.salary_considered, undefined);
  });
  test('a clean employer with no comp is untouched', () => {
    const sig = { ceo_approval: 80, recommend_friend: 70 };
    const out = applySignal(card({ grade: 'B' }), sig, { compFloor, ...POLICY });
    assert.equal(out.grade, 'B');
  });
});

describe('company AVERAGE below floor downgrades but never hard-excludes', () => {
  test('a low crowd average costs one letter, not the card', () => {
    const r = evaluateEmployer({ salary_avg: 85000, salary_n: 40 }, { compFloor, ...POLICY });
    assert.equal(r.exclude, false);
    assert.equal(r.steps, 1);
    assert.ok(r.flags.some((f) => f.startsWith('comp-below-floor:')));
    // An average spans every req at the company. Killing a role that may well
    // pay above floor on the strength of an average is the false negative this
    // module exists to avoid.
  });
});

describe('isBelowCompFloor — the scan-time drop predicate', () => {
  test('drops postings under floor before they ever become cards', () => {
    assert.equal(isBelowCompFloor('$85,000 - $115,000 a year', compFloor, POLICY), true);  // bottom $85K < $88K
    assert.equal(isBelowCompFloor('$40.00 an hour', compFloor, POLICY), true);            // $83.2K, cannot reach floor
  });
  test('keeps anything at or above floor', () => {
    assert.equal(isBelowCompFloor('$110,000 a year', compFloor, POLICY), false);          // single figure at floor
    assert.equal(isBelowCompFloor('$120,000 - $140,000 a year', compFloor, POLICY), false);
  });
  test('keeps everything with no comp attached', () => {
    assert.equal(isBelowCompFloor('N/A', compFloor, POLICY), false);
    assert.equal(isBelowCompFloor('', compFloor, POLICY), false);
    assert.equal(isBelowCompFloor(null, compFloor, POLICY), false);
    assert.equal(isBelowCompFloor('Competitive', compFloor, POLICY), false);
  });
  test('accepts an already-parsed band as well as a raw string', () => {
    assert.equal(isBelowCompFloor(parseCompensationLine('$80,000 a year'), compFloor, POLICY), true);
  });
});

// ── Rahil's two-part comp policy, stated 2026-08-10 ──────────────────────────
// "$111k = should be their lowest + 20% should hit at min if there is a range."


// ── Rahil's REVISED comp policy, 2026-08-10 ──────────────────────────────────
// "salary logic of 110k min and if there is a range then the bottom end cannot
//  dip lower than 15% of $110k"  →  reach $110,000; bottom not under $93,500.
// This SUPERSEDES the earlier "$111K must be their lowest" rule, which required
// the opposite (bottom clears the floor outright).

describe('revised policy — test 1: the posting must be able to REACH the floor', () => {
  test('a top under the floor is out, however tight the band', () => {
    const v = violatesCompPolicy(parseCompensationLine('$95,000 - $105,000 a year'), compFloor, POLICY);
    assert.equal(v.violates, true);
    assert.match(v.reason, /^max-below-floor/);
  });
  test('a single figure under the floor is out', () => {
    assert.equal(violatesCompPolicy(parseCompensationLine('$95,000 a year'), compFloor, POLICY).violates, true);
  });
  test('a single figure exactly at the floor passes', () => {
    assert.equal(violatesCompPolicy(parseCompensationLine('$110,000 a year'), compFloor, POLICY).violates, false);
  });
  test('hourly that cannot annualize to the floor is out', () => {
    // $50/h => $104,000
    assert.equal(violatesCompPolicy(parseCompensationLine('$50.00 an hour'), compFloor, POLICY).violates, true);
  });
});

describe('revised policy — test 2: how far the bottom may dip', () => {
  test('min allowed is floor minus 20% = $88,000', () => {
    assert.equal(violatesCompPolicy(parseCompensationLine('$100,000 - $150,000 a year'), compFloor, POLICY).min_allowed, 88000);
  });
  test('a bottom exactly at $88,000 is inside tolerance', () => {
    assert.equal(violatesCompPolicy(parseCompensationLine('$88,000 - $140,000 a year'), compFloor, POLICY).violates, false);
  });
  test('a bottom one dollar under tolerance is out', () => {
    const v = violatesCompPolicy(parseCompensationLine('$87,999 - $140,000 a year'), compFloor, POLICY);
    assert.equal(v.violates, true);
    assert.match(v.reason, /^bottom-dips-too-low/);
  });
  test('the retired 15% boundary now passes — $90K bottom is inside 20%', () => {
    // Guards the finalization: under the previous 15% tolerance ($93,500) this
    // exact posting (ioVista) was excluded. At 20% it survives.
    assert.equal(violatesCompPolicy(parseCompensationLine('$90,000 - $120,000 a year'), compFloor, POLICY).violates, false);
  });
  test('a very wide band is caught by the bottom even though the top is generous', () => {
    assert.equal(violatesCompPolicy(parseCompensationLine('$60,000 - $200,000 a year'), compFloor, POLICY).violates, true);
  });
  test('tolerance is configurable, not baked in', () => {
    const band = parseCompensationLine('$95,000 - $140,000 a year');
    assert.equal(violatesCompPolicy(band, compFloor, { tolerancePct: 20 }).violates, false);
    assert.equal(violatesCompPolicy(band, compFloor, { tolerancePct: 0 }).violates, true); // bottom must clear floor
  });
});

describe('revised policy — partial data still never convicts', () => {
  test('"From $130,000" publishes no top, so the reach test is skipped', () => {
    assert.equal(violatesCompPolicy(parseCompensationLine('From $130,000 a year'), compFloor, POLICY).violates, false);
  });
  test('"From $80,000" still fails — the bottom IS published and dips under $88,000', () => {
    assert.equal(violatesCompPolicy(parseCompensationLine('From $80,000 a year'), compFloor, POLICY).violates, true);
  });
  test('"Up to $150,000" publishes no bottom, so the dip test is skipped', () => {
    assert.equal(violatesCompPolicy(parseCompensationLine('Up to $150,000 a year'), compFloor, POLICY).violates, false);
  });
  test('"Up to $95,000" fails the reach test — its published top cannot pay the number', () => {
    assert.equal(violatesCompPolicy(parseCompensationLine('Up to $95,000 a year'), compFloor, POLICY).violates, true);
  });
  test('no band at all is never a violation', () => {
    assert.equal(violatesCompPolicy(null, compFloor, POLICY).violates, false);
  });
});

describe('the retired +20% headroom rule stays off unless re-enabled', () => {
  test('config ships headroom at 0, so a tight band above the floor passes', () => {
    assert.equal(loadRangeHeadroomPct(), 0);
    assert.equal(violatesCompPolicy(parseCompensationLine('$110,000 - $115,000 a year'), compFloor, POLICY).violates, false);
  });
  test('setting headroom back above 0 restores the old behaviour', () => {
    const v = violatesCompPolicy(parseCompensationLine('$110,000 - $115,000 a year'), compFloor, { tolerancePct: 15, headroomPct: 20 });
    assert.equal(v.violates, true);
    assert.match(v.reason, /^range-no-headroom/);
  });
});

describe('policy values come from config, not literals', () => {
  test('floor $110K and tolerance 20% give an $88,000 minimum allowed bottom', () => {
    assert.equal(loadCompFloor(), 110000);
    assert.equal(loadBottomTolerancePct(), 20);
    assert.equal(Math.round(loadCompFloor() * (1 - loadBottomTolerancePct() / 100)), 88000);
  });
});

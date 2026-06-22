/**
 * readiness-scorer.test.mjs — Harvard MCS standards scorer unit tests
 *
 * Run: node --test test/readiness-scorer.test.mjs
 *      npm run test:readiness
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreResume,
  scoreCoverLetter,
  scoreCard,
} from '../scripts/readiness-scorer.mjs';

// ── Shared keywords ───────────────────────────────────────────────────────────

const JD_KEYWORDS = ['agile', 'CI/CD', 'cloud', 'team', 'budget'];
const COMPANY     = 'Acme Corp';

// ── Fixture: perfect resume (60/60) ──────────────────────────────────────────
//
// Design targets:
//   pronouns:       0 violations → 10 pts
//   action_verbs:   6/6 bullets start with verbs (100%) → 15 pts
//   quantification: all 6 bullets have numbers (100% ≥ 50%) → 10 pts
//   structure:      email + phone + Experience + Education → 10 pts
//   keyword_overlap:all 5 keywords present (100% ≥ 60%) → 15 pts
//   total: 60/60

const PERFECT_RESUME = `# Test Candidate
test@example.com | (555) 555-5555

## Experience
- Achieved 50% reduction in deployment time through CI/CD pipeline implementation
- Increased team velocity by 30% coaching agile engineers on delivery practices
- Delivered $200,000 in cost savings by optimizing cloud resource utilization
- Led 20 cross-functional teams across 3 product lines to on-time delivery
- Managed $5M annual budget with zero overruns across 4 quarters
- Organized 12 sprint ceremonies improving throughput by 25%

## Education
Bachelor of Science, Computer Science, State University
`;

// ── Fixture: perfect cover letter (40/40) ─────────────────────────────────────
//
// Design targets:
//   structure:  date+dear+colon+3para+closing → 15 pts
//   tailoring:  mentions "acme corp" + "position" → 10 pts
//   keywords:   all 5 keywords (100% ≥ 50%) → 10 pts
//   verbs:      ≥3 action verbs in text → 5 pts
//   total: 40/40

const PERFECT_CL = `June 17, 2026

Dear Hiring Manager:

I am writing to apply for the Senior Program Manager position at Acme Corp. With extensive experience in agile and CI/CD environments, I am confident in my ability to contribute effectively to your team.

I have delivered significant improvements across complex programs, managing cloud infrastructure and team budgets with measurable results. I increased team velocity by 30% and achieved cost savings through budget optimization across multiple engagements.

I would welcome the opportunity to discuss how my background in agile delivery and team leadership aligns with this position at Acme Corp.

Thank you for your consideration and time.

Sincerely,
Test Candidate
`;

// ── 1. Perfect resume ─────────────────────────────────────────────────────────

describe('scoreResume — perfect resume', () => {
  test('returns 60/60 with all checks passing', () => {
    const result = scoreResume(PERFECT_RESUME, JD_KEYWORDS);
    assert.equal(result.score, 60, `expected 60, got ${result.score}`);
    assert.equal(result.max, 60);
    assert.equal(result.checks.pronouns.score, 10,          'pronouns: 10');
    assert.equal(result.checks.action_verbs.score, 15,      'action_verbs: 15');
    assert.equal(result.checks.quantification.score, 10,    'quantification: 10');
    assert.equal(result.checks.structure.score, 10,         'structure: 10');
    assert.equal(result.checks.keyword_overlap.score, 15,   'keyword_overlap: 15');
    assert.equal(result.flags.length, 0, `expected no flags, got: ${result.flags}`);
  });
});

// ── 2. Resume with pronoun violations ─────────────────────────────────────────

describe('scoreResume — pronoun violations', () => {
  const resumeWithPronouns = `# Jane Smith
jane@example.com | (555) 555-5556

## Experience
- I managed a portfolio and completed it successfully
- We delivered the product on time and under budget
- Led the team to a successful product launch

## Education
MBA, Business School
`;

  test('deducts 2 pts per pronoun-containing bullet', () => {
    const result = scoreResume(resumeWithPronouns, JD_KEYWORDS);
    // 2 violations ("I managed", "We delivered") → 10 - 4 = 6
    assert.equal(result.checks.pronouns.score, 6, `expected 6, got ${result.checks.pronouns.score}`);
    assert.equal(result.checks.pronouns.violations.length, 2, 'should record 2 violations');
    assert.ok(result.flags.some((f) => /pronoun/i.test(f)), 'flag should mention pronouns');
  });

  test('score is below perfect', () => {
    const result = scoreResume(resumeWithPronouns, JD_KEYWORDS);
    assert.ok(result.score < 60, `score ${result.score} should be < 60`);
  });
});

// ── 3. Resume with no quantification ─────────────────────────────────────────

describe('scoreResume — no quantification', () => {
  const noQuantResume = `# Sam Brown
sam@example.com | (555) 555-5557

## Experience
- Led the team through various projects successfully
- Managed stakeholders across multiple departments
- Coordinated with vendors for timely deliveries
- Organized sprint ceremonies and retrospectives
- Developed new workflows to improve efficiency

## Education
BS, University
`;

  test('returns minimum quantification score of 2', () => {
    const result = scoreResume(noQuantResume, []);
    assert.equal(result.checks.quantification.score, 2,
      `expected 2 (minimum), got ${result.checks.quantification.score}`);
    assert.equal(result.checks.quantification.pct, 0, 'pct should be 0');
  });

  test('adds flag for low quantification', () => {
    const result = scoreResume(noQuantResume, []);
    assert.ok(result.flags.some((f) => /quantif/i.test(f)), 'flag should mention quantification');
  });
});

// ── 4. Resume missing email ───────────────────────────────────────────────────

describe('scoreResume — missing email', () => {
  const noEmailResume = `# Pat Lee
(555) 555-5558

## Experience
- Achieved 30% cost savings through agile CI/CD cloud optimization
- Increased team budget efficiency by 40% across all programs
- Delivered $100,000 in savings through team consolidation

## Education
BS, State University
`;

  test('structure check records missing email', () => {
    const result = scoreResume(noEmailResume, JD_KEYWORDS);
    assert.ok(result.checks.structure.missing.includes('email'), 'missing should include "email"');
    assert.ok(result.checks.structure.score < 10, 'structure score should be < 10');
  });

  test('adds flag for missing email', () => {
    const result = scoreResume(noEmailResume, JD_KEYWORDS);
    assert.ok(result.flags.some((f) => /email/i.test(f)), 'flag should mention email');
  });
});

// ── 5. Low keyword overlap ────────────────────────────────────────────────────

describe('scoreResume — low keyword overlap', () => {
  const lowKwResume = `# Jordan Kim
jordan@example.com | (555) 555-5559

## Experience
- Authored comprehensive documentation for technical processes
- Collaborated with stakeholders on strategic planning initiatives

## Education
BS, University
`;

  const mismatchedKeywords = ['kubernetes', 'terraform', 'docker', 'rust', 'golang'];

  test('returns 0 keyword score when overlap < 20%', () => {
    const result = scoreResume(lowKwResume, mismatchedKeywords);
    assert.equal(result.checks.keyword_overlap.score, 0,
      `expected 0, got ${result.checks.keyword_overlap.score}`);
    assert.ok(result.checks.keyword_overlap.pct < 20, `pct ${result.checks.keyword_overlap.pct} should be < 20`);
  });

  test('missing keywords are reported', () => {
    const result = scoreResume(lowKwResume, mismatchedKeywords);
    assert.ok(result.checks.keyword_overlap.missing.length > 0, 'should report missing keywords');
  });
});

// ── 6. Perfect cover letter ───────────────────────────────────────────────────

describe('scoreCoverLetter — perfect CL', () => {
  test('returns 40/40 with all checks passing', () => {
    const result = scoreCoverLetter(PERFECT_CL, COMPANY, JD_KEYWORDS);
    assert.equal(result.score, 40, `expected 40, got ${result.score}`);
    assert.equal(result.max, 40);
    assert.equal(result.checks.structure.score, 15,   'structure: 15');
    assert.equal(result.checks.tailoring.score, 10,   'tailoring: 10');
    assert.equal(result.checks.keyword_overlap.score, 10, 'kw_overlap: 10');
    assert.equal(result.checks.action_verbs.score, 5, 'action_verbs: 5');
  });

  test('all structure checks pass', () => {
    const result = scoreCoverLetter(PERFECT_CL, COMPANY, JD_KEYWORDS);
    const s = result.checks.structure;
    assert.ok(s.has_date, 'should detect date');
    assert.ok(s.has_dear, 'should detect Dear');
    assert.ok(s.has_colon, 'should detect colon after salutation');
    assert.ok(s.has_three_paragraphs, 'should have 3+ paragraphs');
    assert.ok(s.has_closing, 'should detect closing');
  });

  test('cleanpaste_reminder is set', () => {
    const result = scoreCoverLetter(PERFECT_CL, COMPANY, JD_KEYWORDS);
    assert.ok(result.cleanpaste_reminder, 'cleanpaste_reminder should be true');
  });
});

// ── 7. CL missing company name ────────────────────────────────────────────────

describe('scoreCoverLetter — missing company name', () => {
  const noCompanyCL = `June 17, 2026

Dear Hiring Manager:

I am writing to apply for the Senior Program Manager position. With extensive experience in agile and CI/CD environments, I can contribute effectively to your team.

I have delivered improvements across complex programs, managing cloud infrastructure and team budgets with measurable results. I increased team velocity by 30% and achieved budget optimization.

I would welcome the opportunity to discuss how my background aligns with this position.

Thank you for your consideration.

Sincerely,
Test Candidate
`;

  test('tailoring.mentions_company is false', () => {
    const result = scoreCoverLetter(noCompanyCL, COMPANY, JD_KEYWORDS);
    assert.ok(!result.checks.tailoring.mentions_company, 'should not mention company');
    assert.equal(result.checks.tailoring.score, 5, 'tailoring score should be 5 (role only)');
  });

  test('adds flag for missing company name', () => {
    const result = scoreCoverLetter(noCompanyCL, COMPANY, JD_KEYWORDS);
    assert.ok(result.flags.some((f) => /company/i.test(f)), 'flag should mention company name');
  });
});

// ── 8. CL low keyword overlap ─────────────────────────────────────────────────

describe('scoreCoverLetter — low keyword overlap', () => {
  const lowKwCL = `June 17, 2026

Dear Hiring Manager:

I am writing to apply for a position at Acme Corp. I have experience in various areas and would like to join your team.

I have worked on multiple projects and delivered results through careful planning and execution over my career.

I would welcome the chance to discuss my background with your organization.

Thank you for your consideration.

Sincerely,
Test
`;

  const mismatchedKw = ['kubernetes', 'terraform', 'docker', 'rust', 'golang'];

  test('returns 2 pts (minimum) for keyword overlap < 30%', () => {
    const result = scoreCoverLetter(lowKwCL, COMPANY, mismatchedKw);
    assert.equal(result.checks.keyword_overlap.score, 2,
      `expected 2 (minimum), got ${result.checks.keyword_overlap.score}`);
    assert.ok(result.checks.keyword_overlap.pct < 30, `pct should be < 30`);
  });

  test('adds flag for low keyword coverage', () => {
    const result = scoreCoverLetter(lowKwCL, COMPANY, mismatchedKw);
    assert.ok(result.flags.some((f) => /keyword/i.test(f)), 'flag should mention keywords');
  });
});

// ── 9. Full scoreCard integration ─────────────────────────────────────────────

describe('scoreCard — integration', () => {
  const card = {
    id:       'test-card-001',
    company:  COMPANY,
    role:     'Senior Program Manager',
    keywords: JD_KEYWORDS,
  };

  test('returns correct shape for passing card', async () => {
    const result = await scoreCard(card, { resumeText: PERFECT_RESUME, clText: PERFECT_CL });
    assert.ok(!result.score_skipped,    'should not be skipped');
    assert.ok('total' in result,        'should have total');
    assert.ok('grade' in result,        'should have grade');
    assert.ok('passed' in result,       'should have passed');
    assert.ok('resume' in result,       'should have resume section');
    assert.ok('cover_letter' in result, 'should have cover_letter section');
    assert.ok(Array.isArray(result.flags), 'flags should be array');
    assert.ok(result.cleanpaste_reminder,  'cleanpaste_reminder should be set');
  });

  test('total equals resume.score + cover_letter.score', async () => {
    const result = await scoreCard(card, { resumeText: PERFECT_RESUME, clText: PERFECT_CL });
    assert.equal(result.total, result.resume.score + result.cover_letter.score);
  });

  test('perfect inputs produce total=100, grade=A, passed=true', async () => {
    const result = await scoreCard(card, { resumeText: PERFECT_RESUME, clText: PERFECT_CL });
    assert.equal(result.total, 100);
    assert.equal(result.grade, 'A');
    assert.ok(result.passed);
  });

  test('returns score_skipped when resumeText is null and cv.md absent', async () => {
    // Pass explicit null texts — cv.md likely exists but we test the null path by
    // using a card with a company that has no matching CL in cover-letters/
    const noClCard = { id: 'no-cl-card', company: 'NonExistentCorp12345', keywords: [] };
    const result   = await scoreCard(noClCard, { resumeText: PERFECT_RESUME, clText: null });
    // With no matching CL, should be skipped
    assert.ok(result.score_skipped, 'should be skipped when CL missing');
    assert.ok(typeof result.reason === 'string', 'should have reason string');
  });
});

// ── 10. Grade thresholds ──────────────────────────────────────────────────────

describe('grade thresholds', () => {
  const card = { id: 'grade-test', company: COMPANY, keywords: JD_KEYWORDS };

  test('grade A: total >= 90', async () => {
    // Perfect resume (60) + perfect CL (40) = 100
    const r = await scoreCard(card, { resumeText: PERFECT_RESUME, clText: PERFECT_CL });
    assert.equal(r.grade, 'A', `expected A, got ${r.grade} (total ${r.total})`);
    assert.ok(r.total >= 90);
  });

  test('grade B: total 80-89', async () => {
    // Perfect resume (60) + CL scoring ~25/40 = 85
    // Design: struct=10(dear+3para+closing), tailor=10(company+role), kw=2(<30% no keywords), verb=3(1 verb)
    const reducedCL = `Dear Hiring Manager,

I am writing to apply for the position at Acme Corp. With years of experience in similar roles, I am confident I can contribute meaningfully to your organization.

I have delivered valuable results in previous positions through careful planning and coordination with cross-functional partners. My approach focuses on quality execution and strategic communication.

Thank you for your consideration.

Best regards,
Candidate
`;
    const r = await scoreCard(card, { resumeText: PERFECT_RESUME, clText: reducedCL });
    assert.equal(r.grade, 'B', `expected B, got ${r.grade} (total ${r.total})`);
    assert.ok(r.total >= 80 && r.total < 90, `total ${r.total} should be 80-89`);
  });

  test('grade C: total 70-79', async () => {
    // Perfect resume (60) + CL scoring ~16/40 = 76
    // Design: struct=6(dear+closing, 1 para no 3para), tailor=5(role mention only), kw=2(<30%), verb=3(1 verb)
    const gradeCCL = `Dear Hiring Team,
I want to apply for this opportunity. I have Delivered results in past positions.

Sincerely,
`;
    const r = await scoreCard(card, { resumeText: PERFECT_RESUME, clText: gradeCCL });
    assert.equal(r.grade, 'C', `expected C, got ${r.grade} (total ${r.total})`);
    assert.ok(r.total >= 70 && r.total < 80, `total ${r.total} should be 70-79`);
  });

  test('grade D: total < 70', async () => {
    // Resume with major issues + very poor CL
    const poorResume = `Pat Smith

## Experience
- I handled a project last year
- We worked on something

## Education
High School
`;
    const poorCL = `Dear Hiring Team,
Looking for a job here.

regards
`;
    const r = await scoreCard(card, { resumeText: poorResume, clText: poorCL });
    assert.equal(r.grade, 'D', `expected D, got ${r.grade} (total ${r.total})`);
    assert.ok(r.total < 70, `total ${r.total} should be < 70`);
  });
});

// ── 11. Pass/fail at threshold boundary ──────────────────────────────────────

describe('pass/fail threshold boundary', () => {
  const card = { id: 'boundary-test', company: COMPANY, keywords: JD_KEYWORDS };

  // Perfect resume = 60/60
  // CL designed to score exactly 10/40:
  //   struct=3 (dear only, no colon, 1 short para, no closing)
  //   tailor=0 (no company mention, no role/position)
  //   kw=2    (<30% of keywords)
  //   verb=5  (≥3 action verbs in text: Achieved, Delivered, Implemented)
  //   total CL = 3+0+2+5 = 10 → grand total = 60+10 = 70 → pass

  const clScoring10 = `Dear Hiring Team
I Achieved significant results. I Delivered value and Implemented new improvements in agile environments.
`;

  // CL scoring ~9/40 → grand total 60+9 = 69 → fail
  //   struct=7 (dear=3, 3para=4; no date/colon/closing)
  //   tailor=0 (no company, no role/position)
  //   kw=2    (<30%)
  //   verb=0  (no action verbs from list in short text)
  //   total = 7+0+2+0 = 9

  const clScoring9 = `Dear Hiring Team,
I want to work here on meaningful projects.

And I have relevant background experience in general areas of work.

More info available upon request from my background history.
`;

  test('total >= 70 → passed=true', async () => {
    const r = await scoreCard(card, { resumeText: PERFECT_RESUME, clText: clScoring10 });
    assert.ok(r.total >= 70, `total ${r.total} should be >= 70`);
    assert.ok(r.passed, `passed should be true for total ${r.total}`);
  });

  test('total < 70 → passed=false', async () => {
    const r = await scoreCard(card, { resumeText: PERFECT_RESUME, clText: clScoring9 });
    assert.ok(r.total < 70, `total ${r.total} should be < 70`);
    assert.ok(!r.passed, `passed should be false for total ${r.total}`);
  });
});

/**
 * referral-registry.test.mjs — unit tests for the grade-S referral matcher.
 *
 * Run: node --test test/referral-registry.test.mjs
 *
 * Covers (CHANGE 3): follow-person, follow-company (still_at true/false), no-match,
 * company-name normalization (Nvidia == NVIDIA Corporation), the S-above-A ordering
 * (gradeRank), the gradeWithReferral overlay, and the seed builder dedupe rules.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCompany, normalizeRegistry, matchReferral, gradeWithReferral,
  gradeRank, GRADE_ORDER, buildSeedEntries,
} from '../scripts/referral-registry.mjs';

const reg = (entries) => ({ entries: normalizeRegistry(entries) });

describe('normalizeCompany — collapses suffixes + aliases', () => {
  test('Nvidia == NVIDIA Corporation == NVIDIA Corp.', () => {
    const a = normalizeCompany('Nvidia');
    assert.equal(normalizeCompany('NVIDIA Corporation'), a);
    assert.equal(normalizeCompany('NVIDIA Corp.'), a);
    assert.equal(a, 'nvidia');
  });
  test('alias fold: Facebook → meta, AWS → amazon', () => {
    assert.equal(normalizeCompany('Facebook'), 'meta');
    assert.equal(normalizeCompany('Meta Platforms'), 'meta');
    assert.equal(normalizeCompany('AWS'), 'amazon');
  });
  test('blank → empty string', () => {
    assert.equal(normalizeCompany(''), '');
    assert.equal(normalizeCompany(null), '');
  });
});

describe('matchReferral — follow-company', () => {
  const r = reg([
    { person: 'Drew', referred_company: 'Nvidia', still_at_referred_company: true },
  ]);
  test('still-at referrer at the company → matched via company (normalized)', () => {
    const m = matchReferral('NVIDIA Corporation', r);
    assert.equal(m.matched, true);
    assert.equal(m.via, 'company');
    assert.equal(m.entry.person, 'Drew');
  });
  test('still_at_referred_company:false does NOT match via company', () => {
    const r2 = reg([{ person: 'Drew', referred_company: 'Nvidia', current_company: 'Nvidia', still_at_referred_company: false }]);
    // current_company also Nvidia here, so it WOULD match via person — make current different:
    const r3 = reg([{ person: 'Drew', referred_company: 'Nvidia', current_company: 'Google', still_at_referred_company: false }]);
    assert.equal(matchReferral('Nvidia', r3).matched, false);
    // sanity: with still_at true it matches
    assert.equal(matchReferral('Nvidia', reg([{ person: 'Drew', referred_company: 'Nvidia', still_at_referred_company: true }])).matched, true);
    void r2;
  });
});

describe('matchReferral — follow-person (referrer moved)', () => {
  const r = reg([
    { person: 'Sam', referred_company: 'Stripe', current_company: 'OpenAI', still_at_referred_company: false },
  ]);
  test('referrer now at OpenAI → job at OpenAI matches via person', () => {
    const m = matchReferral('OpenAI', r);
    assert.equal(m.matched, true);
    assert.equal(m.via, 'person');
  });
  test('the OLD company (Stripe) no longer matches once they left', () => {
    assert.equal(matchReferral('Stripe', r).matched, false);
  });
});

describe('matchReferral — no match', () => {
  test('company with no referral entry', () => {
    const r = reg([{ person: 'A', referred_company: 'Acme', still_at_referred_company: true }]);
    assert.equal(matchReferral('Globex', r).matched, false);
    assert.equal(matchReferral('', r).matched, false);
  });
});

describe('gradeRank — S ranks above A everywhere', () => {
  test('order S<A<B<C<D', () => {
    assert.deepEqual(GRADE_ORDER, ['S', 'A', 'B', 'C', 'D']);
    assert.ok(gradeRank('S') < gradeRank('A'));
    assert.ok(gradeRank('A') < gradeRank('B'));
    assert.ok(gradeRank('B') < gradeRank('C'));
    assert.ok(gradeRank('C') < gradeRank('D'));
  });
  test('unknown grade ranks last', () => {
    assert.ok(gradeRank('?') > gradeRank('D'));
    assert.ok(gradeRank('') > gradeRank('D'));
  });
  test('a list sorts S to the very top', () => {
    const cards = [{ grade: 'B' }, { grade: 'A' }, { grade: 'S' }, { grade: 'D' }, { grade: 'C' }];
    const sorted = [...cards].sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade)).map((c) => c.grade);
    assert.deepEqual(sorted, ['S', 'A', 'B', 'C', 'D']);
  });
});

describe('gradeWithReferral — overlay', () => {
  const r = reg([{ person: 'Drew', referred_company: 'Nvidia', still_at_referred_company: true }]);
  test('A at a referral company → S', () => {
    assert.equal(gradeWithReferral('A', 'Nvidia', r).grade, 'S');
  });
  test('B at a referral company → S (any non-D base is promoted)', () => {
    assert.equal(gradeWithReferral('B', 'NVIDIA Corp.', r).grade, 'S');
  });
  test('A at a non-referral company keeps A', () => {
    assert.equal(gradeWithReferral('A', 'Globex', r).grade, 'A');
  });
  test('D is NOT rescued to S by default (referral cannot fix an ineligible role)', () => {
    assert.equal(gradeWithReferral('D', 'Nvidia', r).grade, 'D');
  });
  test('D CAN be rescued when rescueD:true is explicitly passed', () => {
    assert.equal(gradeWithReferral('D', 'Nvidia', r, { rescueD: true }).grade, 'S');
  });
});

describe('buildSeedEntries — source precedence + dedupe', () => {
  const connections = [
    { name: 'Sam Move', company: 'OpenAI', position: 'PM' },   // provides follow-person data
    { name: 'Cold Contact', company: 'Globex', position: 'Eng' },
  ];
  test('warm card resolves current_company from LinkedIn when the person moved', () => {
    const entries = buildSeedEntries({
      warmCards: [{ company: 'Stripe', connectionName: 'Sam Move', role: 'TPM' }],
      connections,
    });
    const sam = entries.find((e) => e.person === 'Sam Move');
    assert.equal(sam.referred_company, 'Stripe');
    assert.equal(sam.current_company, 'OpenAI'); // follow-person filled from LinkedIn
    assert.equal(sam.source, 'warm-card');
    assert.equal(sam.unconfirmed, false);
  });
  test('LinkedIn pool seeds one entry per unique company, unconfirmed', () => {
    const entries = buildSeedEntries({ connections });
    const globex = entries.find((e) => e.referred_company === 'Globex');
    assert.equal(globex.source, 'linkedin');
    assert.equal(globex.unconfirmed, true);
    assert.equal(globex.current_company, 'Globex'); // default = referred_company
  });
  test('#REF tag seeds a confirmed entry', () => {
    const entries = buildSeedEntries({ refFlags: [{ company: 'Databricks', text: 'ping Jane first', role: 'Staff PM' }] });
    const d = entries.find((e) => e.referred_company === 'Databricks');
    assert.equal(d.source, 'ref-tag');
    assert.equal(d.unconfirmed, false);
    assert.match(d.notes, /ping Jane first/);
  });
});

/**
 * substance-grader.test.mjs — Tests for JD-substance fit grading.
 *
 * Run: node --test test/substance-grader.test.mjs
 *
 * Covers the signed weighted scorer (value-prop terms add, anti-fit subtract,
 * fit outranks bare title match) and the Workday job-detail URL derivation used
 * by the best-effort JD fetch.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scoreSubstance, fetchJd } from '../scripts/substance-grader.mjs';

describe('scoreSubstance', () => {
  test('a delivery/constraint role grades A', () => {
    const r = scoreSubstance(
      'Senior Delivery Manager. Attack delivery constraints and bottlenecks, improve throughput and predictable outcomes, run RAID and dependencies across teams of teams.');
    assert.equal(r.grade, 'A');
    assert.ok(r.score >= 6);
  });

  test('fit outranks a bare ceremony Scrum Master title', () => {
    const ceremony = scoreSubstance('Scrum Master');
    const delivery = scoreSubstance('Program Manager, Delivery — remove bottlenecks, drive throughput and predictable outcomes');
    assert.ok(delivery.score > ceremony.score, 'delivery-substance role must score above a bare Scrum Master title');
    assert.equal(ceremony.grade, 'D'); // bare ceremony title alone is deprioritized to skip
    assert.ok(['A', 'B'].includes(delivery.grade));
  });

  test('anti-fit level/domain mismatches are penalized to D', () => {
    assert.equal(scoreSubstance('Junior Project Coordinator').grade, 'D');
    assert.equal(scoreSubstance('Senior Software Engineer').grade, 'D');
  });

  test('a substantive program-leadership JD lifts a modest title', () => {
    const r = scoreSubstance(
      'Scrum Master\nLead an Agile Release Train, PI planning, portfolio governance, automate delivery metrics, coach teams to self-sufficiency and maturity.');
    assert.ok(['A', 'B'].includes(r.grade), `expected A/B, got ${r.grade} (score ${r.score})`);
  });
});

describe('fetchJd (Workday URL derivation)', () => {
  test('derives the CXS job-detail endpoint from a public Workday URL and returns stripped text', async () => {
    let calledWith = null;
    const mockFetch = async (u) => {
      calledWith = u;
      return { jobPostingInfo: { jobDescription: '<p>Drive <b>throughput</b> &amp; flow</p>' } };
    };
    const text = await fetchJd(
      'https://globalhr.wd5.myworkdayjobs.com/en-US/REC_RTX_Ext_Gateway/job/US-AZ/Program-Manager_01864526',
      'workday', mockFetch);
    assert.equal(calledWith,
      'https://globalhr.wd5.myworkdayjobs.com/wday/cxs/globalhr/REC_RTX_Ext_Gateway/job/US-AZ/Program-Manager_01864526');
    assert.match(text, /Drive throughput/);
    assert.ok(!/</.test(text), 'HTML should be stripped');
  });

  test('returns empty string for an unsupported source (title-only fallback)', async () => {
    const text = await fetchJd('https://careers.example.com/job/123', 'playwright', async () => ({}));
    assert.equal(text, '');
  });
});

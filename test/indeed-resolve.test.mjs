/**
 * indeed-resolve.test.mjs — Indeed shortlink → real ATS URL resolution.
 *
 * Run: node --test test/indeed-resolve.test.mjs
 *
 * The network path is driven entirely by mocked fetchImpl. Live resolution is
 * deliberately NOT exercised here: the sandbox IP is already CAPTCHA-walled
 * (K-0723-1) and burning its reputation against Indeed's redirect service would
 * cost us more than the test is worth. Live validation happens on Windows.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isIndeedShortlink, detectAtsFromUrl, stripTrackingParams,
  resolveOne, resolveMany, applyResolutions,
} from '../scripts/indeed-resolve.mjs';

const SHORT = 'https://to.indeed.com/aa9v9k7f7vtm';
const mockFetch = (finalUrl, ok = true, status = 200) => async () => ({ ok, finalUrl, status });
const noSleep = async () => {};

describe('isIndeedShortlink', () => {
  test('recognizes the to.indeed.com tracker and indeed.com itself', () => {
    assert.equal(isIndeedShortlink(SHORT), true);
    assert.equal(isIndeedShortlink('https://www.indeed.com/viewjob?jk=abc'), true);
  });
  test('leaves real ATS urls alone', () => {
    assert.equal(isIndeedShortlink('https://boards.greenhouse.io/acme/jobs/123'), false);
    assert.equal(isIndeedShortlink(''), false);
    assert.equal(isIndeedShortlink('not-a-url'), false);
  });
});

describe('detectAtsFromUrl', () => {
  test('detects the ATS families we can actually fill', () => {
    assert.equal(detectAtsFromUrl('https://boards.greenhouse.io/acme/jobs/1'), 'greenhouse');
    assert.equal(detectAtsFromUrl('https://jobs.lever.co/acme/abc'), 'lever');
    assert.equal(detectAtsFromUrl('https://jobs.ashbyhq.com/acme/x'), 'ashby');
    assert.equal(detectAtsFromUrl('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/x'), 'workday');
  });
  test('returns unknown rather than guessing', () => {
    assert.equal(detectAtsFromUrl('https://careers.example.com/job/1'), 'unknown');
    assert.equal(detectAtsFromUrl(''), 'unknown');
  });
});

describe('stripTrackingParams', () => {
  test('drops utm/source junk but keeps the real query', () => {
    const out = stripTrackingParams('https://boards.greenhouse.io/acme/jobs/1?gh_jid=9&utm_source=indeed&from=serp');
    assert.ok(out.includes('gh_jid=9'));
    assert.ok(!out.includes('utm_source'));
    assert.ok(!out.includes('from=serp'));
  });
  test('is a no-op on a malformed url', () => {
    assert.equal(stripTrackingParams('nonsense'), 'nonsense');
  });
});

describe('resolveOne', () => {
  test('resolves a shortlink and reports the destination ATS', async () => {
    const r = await resolveOne(SHORT, { fetchImpl: mockFetch('https://boards.greenhouse.io/acme/jobs/1?utm_source=indeed') });
    assert.equal(r.ok, true);
    assert.equal(r.ats, 'greenhouse');
    assert.equal(r.reason, 'resolved');
    assert.ok(!r.resolved.includes('utm_source'));
  });
  test('a link that lands back on indeed is flagged indeed-hosted, not routable', async () => {
    const r = await resolveOne(SHORT, { fetchImpl: mockFetch('https://www.indeed.com/viewjob?jk=abc') });
    assert.equal(r.ats, 'indeed-hosted');
    assert.equal(r.reason, 'indeed-hosted-apply');
  });
  test('a failed resolve returns not-ok instead of throwing', async () => {
    const r = await resolveOne(SHORT, { fetchImpl: mockFetch(null, false, 503) });
    assert.equal(r.ok, false);
    assert.equal(r.ats, 'unknown');
    assert.match(r.reason, /^unresolved/);
  });
  test('a non-shortlink passes straight through with its ATS', async () => {
    const r = await resolveOne('https://jobs.lever.co/acme/x', { fetchImpl: mockFetch('SHOULD-NOT-BE-CALLED') });
    assert.equal(r.reason, 'not-a-shortlink');
    assert.equal(r.ats, 'lever');
  });
  test('uses the cache instead of the network when present', async () => {
    let called = false;
    const spy = async () => { called = true; return { ok: true, finalUrl: 'x' }; };
    const cache = { entries: { [SHORT]: { resolved: 'https://jobs.ashbyhq.com/acme/x', ats: 'ashby' } } };
    const r = await resolveOne(SHORT, { fetchImpl: spy, cache });
    assert.equal(called, false);
    assert.equal(r.reason, 'cache');
    assert.equal(r.ats, 'ashby');
  });
  test('an empty url is handled, not crashed on', async () => {
    const r = await resolveOne('', {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty-url');
  });
});

describe('resolveMany', () => {
  test('de-dupes repeated links so one req costs one call', async () => {
    let calls = 0;
    const spy = async () => { calls++; return { ok: true, finalUrl: 'https://jobs.lever.co/a/b' }; };
    const out = await resolveMany([SHORT, SHORT, SHORT], { fetchImpl: spy, sleep: noSleep });
    assert.equal(calls, 1);
    assert.equal(out.length, 1);
  });
});

describe('applyResolutions', () => {
  const cards = [
    { company: 'Acme',  role: 'TPM', grade: 'B', url: SHORT },
    { company: 'Globex', role: 'PM', grade: 'A', url: 'https://jobs.lever.co/globex/1' },
  ];
  test('rewrites url + platform and preserves the original as source_url', () => {
    const results = [{ url: SHORT, resolved: 'https://boards.greenhouse.io/acme/jobs/1', ats: 'greenhouse', ok: true, reason: 'resolved' }];
    const { cards: out, stats } = applyResolutions(cards, results);
    assert.equal(out[0].platform, 'greenhouse');
    assert.equal(out[0].url, 'https://boards.greenhouse.io/acme/jobs/1');
    assert.equal(out[0].source_url, SHORT);
    assert.equal(stats.resolved, 1);
    assert.deepEqual(out[1], cards[1]); // untouched
  });
  test('indeed-hosted cards are marked needs_human_apply — we have no filler for that surface', () => {
    const results = [{ url: SHORT, resolved: 'https://www.indeed.com/viewjob?jk=a', ats: 'indeed-hosted', ok: true, reason: 'indeed-hosted-apply' }];
    const { cards: out, stats } = applyResolutions(cards, results);
    assert.equal(out[0].needs_human_apply, true);
    assert.equal(out[0].platform, 'indeed-hosted');
    assert.equal(stats.hosted, 1);
  });
  test('an unresolved link leaves the card completely untouched', () => {
    const results = [{ url: SHORT, resolved: null, ats: 'unknown', ok: false, reason: 'unresolved:503' }];
    const { cards: out, stats } = applyResolutions(cards, results);
    assert.deepEqual(out[0], cards[0]);
    assert.equal(stats.unresolved, 1);
  });
});

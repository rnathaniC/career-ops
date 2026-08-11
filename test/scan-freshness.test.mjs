/**
 * scan-freshness.test.mjs — Tests for the Fresh-lane posting-age gate.
 *
 * Run: node --test test/scan-freshness.test.mjs
 *
 * A posting older than the cutoff (by the employer's posted date, not when we
 * found it) is dropped so the Fresh lane only holds newly posted roles. Postings
 * with no determinable date are kept (never dropped on missing data).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { postingAgeDays, isFreshPosting } from '../scan.mjs';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const daysAgoISO = (d) => new Date(NOW - d * 86_400_000).toISOString();

describe('postingAgeDays', () => {
  test('parses ISO dates into whole-day ages', () => {
    assert.equal(postingAgeDays(daysAgoISO(0), NOW), 0);
    assert.equal(postingAgeDays(daysAgoISO(3), NOW), 3);
    assert.equal(postingAgeDays(daysAgoISO(30), NOW), 30);
  });

  test('parses epoch-ms timestamps (Lever)', () => {
    assert.equal(postingAgeDays(NOW - 5 * 86_400_000, NOW), 5);
  });

  test('parses Workday fuzzy text', () => {
    assert.equal(postingAgeDays('Posted Today', NOW), 0);
    assert.equal(postingAgeDays('Posted Yesterday', NOW), 1);
    assert.equal(postingAgeDays('Posted 5 Days Ago', NOW), 5);
    assert.equal(postingAgeDays('Posted 30+ Days Ago', NOW), 30);
  });

  test('returns null when no date is determinable', () => {
    assert.equal(postingAgeDays(null, NOW), null);
    assert.equal(postingAgeDays('', NOW), null);
    assert.equal(postingAgeDays('sometime recently', NOW), null);
  });
});

describe('isFreshPosting (cutoff = 3 days)', () => {
  test('keeps postings at or under the cutoff', () => {
    assert.equal(isFreshPosting('Posted Today', 3, NOW), true);
    assert.equal(isFreshPosting(daysAgoISO(3), 3, NOW), true);
  });

  test('drops postings older than the cutoff', () => {
    assert.equal(isFreshPosting(daysAgoISO(4), 3, NOW), false);
    assert.equal(isFreshPosting('Posted 30+ Days Ago', 3, NOW), false);
    assert.equal(isFreshPosting('Posted 10 Days Ago', 3, NOW), false);
  });

  test('keeps postings with unknown date (no drop on missing data)', () => {
    assert.equal(isFreshPosting(null, 3, NOW), true);
    assert.equal(isFreshPosting('n/a', 3, NOW), true);
  });
});

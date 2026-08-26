/**
 * hot-lane-lifecycle.test.mjs — unit tests for the Hot-lane aging decision logic.
 *
 * Run: node --test test/hot-lane-lifecycle.test.mjs
 *
 * Covers (CHANGE 4): staleness clock (3-day, last-activity across created /
 * refreshed / comment / notes dates), which bucket a card falls into
 * (keep / archive-history / soft-remove), the S/A-vs-<A split, Applied vs Not
 * Applied status derivation, and the history-row / expired-note shapes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  activityTimestamps, lastActivityMs, daysSinceActivity, isStaleHot,
  deriveAppliedStatus, lifecycleDecision, historyRowForCard, expiredNote,
  HOT_HISTORY_FIELD_IDS, loadLifecycleConfig, HARD_DELETE_DEFAULT, DEFAULT_STALE_DAYS,
} from '../scripts/hot-lane-lifecycle.mjs';

const NOW = Date.parse('2026-08-25T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

describe('activity clock', () => {
  test('lastActivityMs picks the most recent of created/refreshed/comment', () => {
    const card = { createdAt: daysAgo(10), lastRefreshed: daysAgo(4), lastCommentAt: daysAgo(1) };
    assert.equal(lastActivityMs(card, NOW), Date.parse(daysAgo(1)));
  });
  test('notes-embedded dates count as activity', () => {
    const card = { createdAt: daysAgo(10), notes: '[flow:New-Fresh→New-Hot 2026-08-24]' };
    const d = daysSinceActivity(card, NOW);
    assert.ok(d < 2, `expected <2 days, got ${d}`);
  });
  test('future timestamps are ignored (capped at now)', () => {
    const card = { createdAt: daysAgo(5), lastRefreshed: new Date(NOW + 5 * 86400000).toISOString() };
    assert.equal(lastActivityMs(card, NOW), Date.parse(daysAgo(5)));
  });
  test('no parseable dates → null', () => {
    assert.equal(lastActivityMs({ notes: 'nothing here' }, NOW), null);
    assert.deepEqual(activityTimestamps({}), []);
  });
});

describe('isStaleHot — 3-day clock', () => {
  test('idle 4 days → stale', () => {
    assert.equal(isStaleHot({ lastRefreshed: daysAgo(4) }, NOW), true);
  });
  test('idle 2 days → not stale', () => {
    assert.equal(isStaleHot({ lastRefreshed: daysAgo(2) }, NOW), false);
  });
  test('exactly 3 days → stale (>=)', () => {
    assert.equal(isStaleHot({ lastRefreshed: daysAgo(3) }, NOW), true);
  });
  test('unknown activity → NOT stale (fail-safe)', () => {
    assert.equal(isStaleHot({ notes: 'x' }, NOW), false);
  });
});

describe('deriveAppliedStatus', () => {
  test('current lane Applied → Applied', () => {
    assert.equal(deriveAppliedStatus({ lane: 'Applied' }), 'Applied');
  });
  test('flow tag to Applied in notes → Applied', () => {
    assert.equal(deriveAppliedStatus({ lane: 'New-Hot', notes: '[flow:New-Hot→Applied 2026-08-20]' }), 'Applied');
  });
  test('otherwise → Not Applied', () => {
    assert.equal(deriveAppliedStatus({ lane: 'New-Hot', notes: '[flow:New-Fresh→New-Hot 2026-08-20]' }), 'Not Applied');
  });
});

describe('lifecycleDecision — bucket selection', () => {
  const hot = (over) => ({ lane: 'New-Hot', ...over });

  test('non-Hot card is always kept', () => {
    const d = lifecycleDecision({ lane: 'New-Fresh', grade: 'A', lastRefreshed: daysAgo(10) }, { now: NOW });
    assert.equal(d.bucket, 'keep');
  });
  test('fresh Hot card (2d) kept', () => {
    const d = lifecycleDecision(hot({ grade: 'A', lastRefreshed: daysAgo(2) }), { now: NOW });
    assert.equal(d.bucket, 'keep');
  });
  test('stale S card → archive-history, Not Applied by default', () => {
    const d = lifecycleDecision(hot({ grade: 'S', lastRefreshed: daysAgo(5) }), { now: NOW });
    assert.equal(d.bucket, 'archive-history');
    assert.equal(d.status, 'Not Applied');
  });
  test('stale A card that was applied → archive-history, Applied', () => {
    const d = lifecycleDecision(hot({ grade: 'A', lastRefreshed: daysAgo(5), notes: '[flow:New-Hot→Applied 2026-08-21]' }), { now: NOW });
    assert.equal(d.bucket, 'archive-history');
    assert.equal(d.status, 'Applied');
  });
  test('stale B card → soft-remove (no history)', () => {
    const d = lifecycleDecision(hot({ grade: 'B', lastRefreshed: daysAgo(5) }), { now: NOW });
    assert.equal(d.bucket, 'soft-remove');
    assert.equal(d.status, null);
  });
  test('stale D card → soft-remove', () => {
    assert.equal(lifecycleDecision(hot({ grade: 'D', lastRefreshed: daysAgo(9) }), { now: NOW }).bucket, 'soft-remove');
  });
  test('stale unknown-grade card → soft-remove (ranks below A)', () => {
    assert.equal(lifecycleDecision(hot({ grade: '', lastRefreshed: daysAgo(9) }), { now: NOW }).bucket, 'soft-remove');
  });
  test('honors a custom staleDays threshold', () => {
    const card = hot({ grade: 'A', lastRefreshed: daysAgo(4) });
    assert.equal(lifecycleDecision(card, { now: NOW, staleDays: 5 }).bucket, 'keep');
    assert.equal(lifecycleDecision(card, { now: NOW, staleDays: 3 }).bucket, 'archive-history');
  });
});

describe('row / note shapes', () => {
  test('historyRowForCard maps identity fields + normalized Status', () => {
    const card = { company: 'Nvidia', role: 'TPM', url: 'https://x/1', connectionName: 'Drew', grade: 's', id: 'card-1', createdAt: daysAgo(9) };
    const row = historyRowForCard(card, { status: 'Applied', now: new Date(NOW) }).fields;
    assert.equal(row[HOT_HISTORY_FIELD_IDS.Company], 'Nvidia');
    assert.equal(row[HOT_HISTORY_FIELD_IDS.Grade], 'S');
    assert.equal(row[HOT_HISTORY_FIELD_IDS.Status], 'Applied');
    assert.equal(row[HOT_HISTORY_FIELD_IDS['Card ID']], 'card-1');
  });
  test('unknown status normalizes to "Not Applied"', () => {
    const row = historyRowForCard({ company: 'X' }, { status: 'whatever', now: new Date(NOW) }).fields;
    assert.equal(row[HOT_HISTORY_FIELD_IDS.Status], 'Not Applied');
  });
  test('expiredNote is human-readable + carries the grade', () => {
    const n = expiredNote({ grade: 'C' }, 5, '2026-08-25');
    assert.match(n, /expired-hot-lane/);
    assert.match(n, /grade C <A/);
  });
});

describe('hard-delete toggle defaults OFF', () => {
  test('HARD_DELETE_DEFAULT is false', () => {
    assert.equal(HARD_DELETE_DEFAULT, false);
  });
  test('missing config → hard_delete false', () => {
    const cfg = loadLifecycleConfig('/nonexistent-root-xyz');
    assert.equal(cfg.hard_delete, false);
  });
  test('DEFAULT_STALE_DAYS is 3', () => {
    assert.equal(DEFAULT_STALE_DAYS, 3);
  });
});

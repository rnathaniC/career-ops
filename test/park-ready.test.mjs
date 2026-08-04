/**
 * park-ready.test.mjs — Tests for the auto-fill-to-Submit-Ready staging path.
 *
 * Run: node --test test/park-ready.test.mjs
 *
 * Covers:
 * - parkCardsToSubmitReady: PATCHes eligible cards to the "Submit Ready" lane,
 *   skips readiness failures and cards with no Airtable record, and is a no-op
 *   (never PATCHes) when AIRTABLE_PAT is absent.
 * - airtable-sync lane mapping: "Submit Ready" <-> "submit-ready" round-trips
 *   through recordToCard / cardToFields and the COLUMN_TO_LANE_NAME maps.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parkCardsToSubmitReady } from '../scripts/auto-submit.mjs';
import {
  COLUMN_TO_LANE_NAME, LANE_NAME_TO_COLUMN, LANE_CHOICE_IDS,
  ACTIVE_FIELD_IDS, CARD_ID_FIELD, recordToCard, cardToFields,
} from '../scripts/airtable-sync.mjs';

// A score result that bypasses readiness scoring (score_skipped => no gate, no
// disk write via saveReadinessScore). Used for the "should park" cases.
const skipScore = async () => ({ score_skipped: true });
const passGate  = () => ({ action: 'submit', reason: 'ok' });

function makeRecord(cardId, recId) {
  return { id: recId, fields: { [CARD_ID_FIELD]: cardId } };
}

describe('parkCardsToSubmitReady', () => {
  test('moves eligible cards to Submit Ready and PATCHes their lane', async () => {
    const cards = [
      { id: 'live-001', company: 'Acme', role: 'TPM' },
      { id: 'live-002', company: 'Globex', role: 'PM' },
    ];
    let patched = null;
    const res = await parkCardsToSubmitReady(cards, {
      patImpl: 'fake-pat',
      listImpl: async () => [makeRecord('live-001', 'recA'), makeRecord('live-002', 'recB')],
      patchImpl: async ({ records }) => { patched = records; return records; },
      scoreImpl: skipScore,
      gateImpl: passGate,
      now: () => '2026-08-02T00:00:00.000Z',
    });

    assert.equal(res.parked, 2);
    assert.equal(res.skipped, 0);
    assert.equal(patched.length, 2);
    // Correct record IDs resolved by Card ID, and lane set by field ID to the name.
    assert.equal(patched[0].id, 'recA');
    assert.equal(patched[0].fields[ACTIVE_FIELD_IDS['Lane']], 'Submit Ready');
    assert.equal(patched[1].id, 'recB');
    assert.equal(patched[1].fields[ACTIVE_FIELD_IDS['Lane']], 'Submit Ready');
  });

  test('skips a card that fails the readiness gate (never PATCHed)', async () => {
    const cards = [{ id: 'live-003', company: 'Initech', role: 'TPM' }];
    let patched = [];
    const res = await parkCardsToSubmitReady(cards, {
      patImpl: 'fake-pat',
      listImpl: async () => [makeRecord('live-003', 'recC')],
      patchImpl: async ({ records }) => { patched = records; return records; },
      scoreImpl: async () => ({ score_skipped: false, total: 42, grade: 'D', flags: [] }),
      gateImpl: () => ({ action: 'skip', reason: 'below-60' }),
    });
    assert.equal(res.parked, 0);
    assert.equal(res.skipped, 1);
    assert.equal(patched.length, 0);
    assert.equal(res.results[0].status, 'skipped');
    assert.equal(res.results[0].reason, 'below-60');
  });

  test('skips a card with no matching Airtable record', async () => {
    const cards = [{ id: 'ghost-999', company: 'Nowhere', role: 'PM' }];
    let patchCalled = false;
    const res = await parkCardsToSubmitReady(cards, {
      patImpl: 'fake-pat',
      listImpl: async () => [makeRecord('live-001', 'recA')],
      patchImpl: async ({ records }) => { patchCalled = true; return records; },
      scoreImpl: skipScore,
      gateImpl: passGate,
    });
    assert.equal(res.parked, 0);
    assert.equal(res.skipped, 1);
    assert.equal(patchCalled, false);
    assert.equal(res.results[0].reason, 'no-airtable-record');
  });

  test('no-ops when AIRTABLE_PAT is missing (never lists or patches)', async () => {
    let listCalled = false;
    const res = await parkCardsToSubmitReady([{ id: 'x', company: 'Y' }], {
      patImpl: undefined,
      listImpl: async () => { listCalled = true; return []; },
      patchImpl: async () => { throw new Error('should not patch'); },
      scoreImpl: skipScore,
      gateImpl: passGate,
    });
    assert.equal(res.parked, 0);
    assert.equal(listCalled, false);
    assert.equal(res.results[0].reason, 'no-pat');
  });
});

describe('Submit Ready lane mapping (airtable-sync)', () => {
  test('choice id is registered', () => {
    assert.equal(LANE_CHOICE_IDS['Submit Ready'], 'sel4EsHp3vQIYyKTh');
  });

  test('column<->lane maps round-trip', () => {
    assert.equal(COLUMN_TO_LANE_NAME['submit-ready'], 'Submit Ready');
    assert.equal(LANE_NAME_TO_COLUMN['Submit Ready'], 'submit-ready');
  });

  test('recordToCard maps Lane "Submit Ready" to columnId "submit-ready"', () => {
    const card = recordToCard({ id: 'rec1', fields: {
      [CARD_ID_FIELD]: 'live-001',
      [ACTIVE_FIELD_IDS['Lane']]: 'Submit Ready',
    } });
    assert.equal(card.columnId, 'submit-ready');
  });

  test('cardToFields maps columnId "submit-ready" back to Lane "Submit Ready"', () => {
    const fields = cardToFields({ id: 'live-001', columnId: 'submit-ready' });
    assert.equal(fields[ACTIVE_FIELD_IDS['Lane']], 'Submit Ready');
  });
});

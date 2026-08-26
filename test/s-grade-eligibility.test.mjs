/**
 * s-grade-eligibility.test.mjs — locks the CHANGE 3 decision that grade S is
 * HUMAN-HOLD: excluded from silent auto-submit, exactly like a warm referral.
 *
 * Run: node --test test/s-grade-eligibility.test.mjs
 *
 * auto-submit.mjs has a CLI guard, so importing it does NOT run main().
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isEligible, SUBMIT_READY_STATES } from '../scripts/auto-submit.mjs';

// Pick a columnId the default ready-states set actually contains, so the only
// variable under test is the grade.
const readyCol = [...SUBMIT_READY_STATES][0];

describe('isEligible — grade S is human-hold', () => {
  test('an A card in a ready state IS eligible (baseline)', () => {
    assert.equal(isEligible({ columnId: readyCol, grade: 'A', isWarmReferral: false }), true);
  });
  test('an S card in the SAME ready state is NOT eligible', () => {
    assert.equal(isEligible({ columnId: readyCol, grade: 'S', isWarmReferral: false }), false);
  });
  test('a warm referral is still excluded regardless of grade', () => {
    assert.equal(isEligible({ columnId: readyCol, grade: 'A', isWarmReferral: true }), false);
  });
});

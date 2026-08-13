/**
 * locations.test.mjs — Tests for the commute geography gate.
 *
 * Run: node --test test/locations.test.mjs
 *
 * Home base 75067 (Lewisville, TX). Remote/hybrid always kept; onsite must be in
 * the ~24-mile DFW-local set; unknown location is kept (no drop on missing data).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { passesCommuteGate, isLocal, isRemoteOrHybrid, isPriorityLocal } from '../scripts/locations.mjs';

describe('isRemoteOrHybrid', () => {
  test('detects remote/hybrid wording', () => {
    assert.equal(isRemoteOrHybrid('Remote - US'), true);
    assert.equal(isRemoteOrHybrid('Hybrid (Plano, TX)'), true);
    assert.equal(isRemoteOrHybrid('Work from home'), true);
    assert.equal(isRemoteOrHybrid('Onsite, Austin, TX'), false);
  });
});

describe('isLocal', () => {
  test('local DFW cities are local', () => {
    for (const c of ['Plano, TX', 'Frisco, TX', 'Addison, TX', 'Lewisville, TX', 'Irving, TX', 'Dallas, TX']) {
      assert.equal(isLocal(c), true, `${c} should be local`);
    }
  });
  test('far cities are not local', () => {
    for (const c of ['Austin, TX', 'Houston, TX', 'New York, NY', 'San Francisco, CA', 'Fort Worth, TX']) {
      assert.equal(isLocal(c), false, `${c} should not be local`);
    }
  });
});

describe('passesCommuteGate', () => {
  test('keeps remote/hybrid regardless of distance', () => {
    assert.equal(passesCommuteGate('Austin, TX', 'Remote role, US').keep, true);
    assert.equal(passesCommuteGate('New York, NY', 'Hybrid').keep, true);
  });
  test('keeps onsite local roles', () => {
    assert.equal(passesCommuteGate('Frisco, TX', 'onsite').keep, true);
    assert.equal(passesCommuteGate('Addison, TX', '').keep, true);
  });
  test('drops onsite roles outside the local radius', () => {
    const r = passesCommuteGate('Austin, TX', 'onsite program manager');
    assert.equal(r.keep, false);
    assert.equal(r.reason, 'onsite-outside-24mi');
  });
  test('keeps roles with unknown location (no drop on missing data)', () => {
    assert.equal(passesCommuteGate('', 'Program Manager').keep, true);
  });
});

describe('isPriorityLocal', () => {
  test('flags the Frisco/Plano/Addison corridor', () => {
    assert.equal(isPriorityLocal('Plano, TX'), true);
    assert.equal(isPriorityLocal('Frisco, TX'), true);
    assert.equal(isPriorityLocal('Dallas, TX'), false);
  });
});

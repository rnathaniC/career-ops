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
  test('keeps unresolved Workday multi-location placeholders (B-0817-1)', () => {
    // "N Locations" / "Multiple Locations" carry no geography — unknown, not
    // a confirmed non-local address, so KEEP like a blank location.
    for (const loc of ['3 Locations', '23 Locations', 'Multiple Locations']) {
      const r = passesCommuteGate(loc, 'Lead Data Product Manager');
      assert.equal(r.keep, true, `${loc} should be kept`);
      assert.equal(r.reason, 'location-unresolved', `${loc} reason`);
    }
  });
  test('no regression: real far onsite city still drops', () => {
    const r = passesCommuteGate('Austin, TX', 'onsite program manager');
    assert.equal(r.keep, false);
    assert.equal(r.reason, 'onsite-outside-24mi');
  });
  test('no regression: local city and remote still keep', () => {
    assert.equal(passesCommuteGate('Frisco, TX', 'onsite').keep, true);
    assert.equal(passesCommuteGate('Austin, TX', 'Remote - US').keep, true);
  });
});

describe('isPriorityLocal', () => {
  test('flags the Frisco/Plano/Addison corridor', () => {
    assert.equal(isPriorityLocal('Plano, TX'), true);
    assert.equal(isPriorityLocal('Frisco, TX'), true);
    assert.equal(isPriorityLocal('Dallas, TX'), false);
  });
});

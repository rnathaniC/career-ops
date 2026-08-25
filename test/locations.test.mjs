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

import { passesCommuteGate, isLocal, isRemoteOrHybrid, isPriorityLocal, isOutOfStateRemote } from '../scripts/locations.mjs';

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

  // B-0825-1: state-qualified remote. TX/US/unqualified remote keep; remote
  // pinned to a specific non-Texas state drops as 'remote-out-of-state'.
  test('keeps Texas-tied remote', () => {
    for (const loc of ['TX-Remote', 'TX Remote', 'Remote - TX', 'Texas Remote', 'Remote (TX)', 'Dallas Remote', 'TX - Work from home']) {
      const r = passesCommuteGate(loc, '');
      assert.equal(r.keep, true, `${loc} should keep`);
    }
  });
  test('keeps nationwide / US remote and unqualified remote', () => {
    for (const loc of ['Remote - US', 'US Remote', 'US-Remote', 'Remote, United States', 'United States-Remote', 'Nationwide', 'Remote Nationwide', 'Anywhere', 'Remote (USA)', 'Remote', 'Work from home']) {
      const r = passesCommuteGate(loc, '');
      assert.equal(r.keep, true, `${loc} should keep`);
    }
  });
  test('drops remote restricted to a specific non-Texas state', () => {
    for (const loc of ['FL-Remote', 'CO-Remote', 'Remote - NY', 'California Remote', 'California - Remote', 'Remote (WA)', 'GA Remote', 'US-MA-REMOTE', 'VA - Work from home', 'NJ - Work from home', 'FL - Work from home', 'Remote - DC']) {
      const r = passesCommuteGate(loc, '');
      assert.equal(r.keep, false, `${loc} should drop`);
      assert.equal(r.reason, 'remote-out-of-state', `${loc} reason`);
    }
  });
  test('out-of-state check ignores JD prose (location field only)', () => {
    // A local location must survive even when the JD mentions other states.
    const r = passesCommuteGate('Frisco, TX', 'Team supports our NY and CA remote offices');
    assert.equal(r.keep, true);
    // A nationwide-remote location with office states listed separately keeps.
    const m = passesCommuteGate('San Francisco, CA, New York, NY, Portland, OR, or Remote within Canada or United States', '');
    assert.equal(m.keep, true, 'Mercury-style multi-office + US-wide remote should keep');
  });
  test('lowercase conjunctions do not trigger a state match', () => {
    // "or" (OR), "in" (IN), "me" (ME) as words must not read as postal codes.
    assert.equal(isOutOfStateRemote('Work in a remote team'), false);
    assert.equal(isOutOfStateRemote('Remote or hybrid'), false);
  });
});

describe('isOutOfStateRemote', () => {
  test('true only for non-Texas state-restricted remote', () => {
    assert.equal(isOutOfStateRemote('FL-Remote'), true);
    assert.equal(isOutOfStateRemote('Remote - NY'), true);
    assert.equal(isOutOfStateRemote('US-MA-REMOTE'), true);
    assert.equal(isOutOfStateRemote('California Remote'), true);
    assert.equal(isOutOfStateRemote('TX-Remote'), false);
    assert.equal(isOutOfStateRemote('Remote - US'), false);
    assert.equal(isOutOfStateRemote('Remote'), false);
    assert.equal(isOutOfStateRemote(''), false);
  });
});

describe('isPriorityLocal', () => {
  test('flags the Frisco/Plano/Addison corridor', () => {
    assert.equal(isPriorityLocal('Plano, TX'), true);
    assert.equal(isPriorityLocal('Frisco, TX'), true);
    assert.equal(isPriorityLocal('Dallas, TX'), false);
  });
});

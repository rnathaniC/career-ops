import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findFormFrame, fillForm } from '../scripts/form-fill.mjs';

// ── findFormFrame / fillForm iframe fallback (K-DEFECT-2026-07-13) ────────────
//
// Regression coverage for the same Lyft/careerpuck.com bug class as
// auto-submit.test.mjs's "findSubmitOnPage iframe fallback" suite, but for the
// field-filler: the real Greenhouse form can live inside a same-origin-unrelated
// <iframe> that page.locator() never searches. findSubmitOnPage was fixed for
// this (K-DEFECT-2026-07-07); form-fill.mjs was not, so Lyft filled 0/10 fields
// against an empty main frame and auto-submit still proceeded to click submit
// (found via the already-fixed findSubmitOnPage), stalling as 'unconfirmed'.
//
// Uses lightweight fakes for Playwright's Page/Frame surface (mainFrame(),
// frames(), waitForTimeout(), and frame.locator(sel).count()) — same convention
// as test/auto-submit.test.mjs — so this runs fast and offline, no real browser.

// Fake Frame for pure frame-resolution tests: `hitAfterTicks` simulates a frame
// whose own document is still loading — its probe selector won't match until
// queried this many times, mirroring careerpuck.com's real timing (frame
// attaches in page.frames() before its DOM has the form rendered).
function fakeProbeFrame({ hasForm = false, hitAfterTicks = 0 } = {}) {
  let queries = 0;
  return {
    locator(_sel) {
      return {
        count: async () => {
          queries++;
          if (!hasForm) return 0;
          return queries > hitAfterTicks ? 1 : 0;
        },
      };
    },
  };
}

function fakePage({ mainFrame, childFrames = [] }) {
  let framesSoFar = [mainFrame];
  let tick = 0;
  return {
    mainFrame: () => mainFrame,
    frames: () => framesSoFar,
    // Real Playwright Pages implement .locator() by delegating to the main
    // frame — mirror that here so fillGreenhouseForm etc. can be handed
    // either `page` (main-frame case) or a child `frame` interchangeably.
    locator: (sel) => mainFrame.locator(sel),
    // Each waitForTimeout() "tick" reveals the next not-yet-attached child frame —
    // simulates the iframe embed lazy-attaching over several hundred ms.
    async waitForTimeout(_ms) {
      if (tick < childFrames.length) framesSoFar = [mainFrame, ...childFrames.slice(0, tick + 1)];
      tick++;
    },
  };
}

describe('findFormFrame iframe fallback', () => {

  test('resolves to the page itself when the main frame has the form (non-iframe ATS, unchanged behavior)', async () => {
    const main = fakeProbeFrame({ hasForm: true });
    const page = fakePage({ mainFrame: main, childFrames: [] });
    const target = await findFormFrame(page, 'greenhouse');
    assert.equal(target, page, 'should resolve to the main page when the form is on the main frame');
  });

  test('falls back to an already-attached child frame when main frame has no form', async () => {
    const main  = fakeProbeFrame({ hasForm: false });
    const child = fakeProbeFrame({ hasForm: true });
    const page  = fakePage({ mainFrame: main, childFrames: [child] });
    const target = await findFormFrame(page, 'greenhouse');
    assert.equal(target, child, 'should resolve to the child frame containing the form');
  });

  test('careerpuck.com/Lyft case: child frame attaches late AND its content lags a tick behind attachment', async () => {
    const main  = fakeProbeFrame({ hasForm: false });
    // Attaches after 1 tick (page.frames() reveals it), but its own probe
    // selector only starts matching 2 queries later — reproduces the exact
    // lazy-load timing (~3.5s) that findSubmitOnPage's fix already handles.
    const child = fakeProbeFrame({ hasForm: true, hitAfterTicks: 2 });
    const page  = fakePage({ mainFrame: main, childFrames: [child] });
    const target = await findFormFrame(page, 'greenhouse');
    assert.equal(target, child, 'should eventually resolve to the child frame once its content settles');
  });

  test('falls back to the main page (not null, not a crash) when no frame ever has the form', async () => {
    const main  = fakeProbeFrame({ hasForm: false });
    const child = fakeProbeFrame({ hasForm: false });
    const page  = fakePage({ mainFrame: main, childFrames: [child] });
    const target = await findFormFrame(page, 'greenhouse');
    assert.equal(target, page, 'should fall back to the main page so missing_fields/B-16 guard behavior is preserved');
  }, { timeout: 8000 });

  test('mock/legacy pages without mainFrame()/frames() short-circuit to the page unchanged', async () => {
    const legacyPage = { locator: () => ({ count: async () => 0 }) };
    const target = await findFormFrame(legacyPage, 'greenhouse');
    assert.equal(target, legacyPage, 'pages without frame support must behave exactly as before');
  });

});

// ── fillForm end-to-end: fields land in the correct frame ─────────────────────

function makeFieldFrame(presentFields = new Set()) {
  const filled = {};
  const uploaded = {};

  function fieldNameFor(selector) {
    if (/given-name|first_name|id\*.*first/i.test(selector))              return 'first_name';
    if (/family-name|last_name|id\*.*last/i.test(selector))               return 'last_name';
    if (/email/i.test(selector))                                          return 'email';
    if (/tel|phone/i.test(selector))                                      return 'phone';
    if (/address-level2|city/i.test(selector))                            return 'city';
    if (/LinkedIn|linkedin/i.test(selector))                              return 'linkedin';
    if (/authorized to work|authorized to legally work/i.test(selector))  return 'work_auth';
    if (/sponsorship|require visa/i.test(selector))                       return 'sponsorship';
    if (/resume|\.pdf|cv/i.test(selector))                                return 'resume_upload';
    if (/cover/i.test(selector))                                          return 'cl_upload';
    return 'unknown';
  }

  function makeLocator(selector) {
    const fieldName = fieldNameFor(selector);
    const loc = {
      count: async () => (presentFields.has(fieldName) ? 1 : 0),
      fill: async (val) => { filled[fieldName] = val; },
      selectOption: async () => { filled[fieldName] = true; },
      setInputFiles: async (val) => { uploaded[fieldName] = val; },
      first() { return this; },
      locator() { return this; },
    };
    return loc;
  }

  return {
    locator: (selector) => makeLocator(selector),
    _filled: filled,
    _uploaded: uploaded,
  };
}

function makePersonal() {
  return {
    name:     { first: 'Jane', last: 'Doe', full: 'Jane Doe' },
    contact:  { email: 'jane@example.com', phone: '+15551234567' },
    location: { city: 'San Francisco', state: 'CA', country: 'US' },
    links:    { linkedin: 'https://linkedin.com/in/janedoe' },
    work_auth:  { requires_sponsorship: false },
    experience: { current_company: 'Acme Inc' },
    resume:       { path: null },
    cover_letter: { default_path: '' },
    custom:  { authorized_to_work: true },
  };
}

describe('fillForm resolves iframe-embedded Greenhouse forms (Lyft/careerpuck.com regression)', () => {

  test('main frame empty, child frame has the form -> fills land in the child frame, not the main frame', async () => {
    const mainFrame  = makeFieldFrame(new Set());                                    // empty main frame — the bug's failure mode
    const childFrame  = makeFieldFrame(new Set(['first_name', 'last_name', 'email'])); // real Greenhouse embed
    const page = fakePage({ mainFrame, childFrames: [childFrame] });

    const report = await fillForm('greenhouse', page, makePersonal(), null);

    assert.equal(report.filled, 3, 'should fill the 3 present fields from the child frame');
    assert.equal(childFrame._filled.first_name, 'Jane', 'first_name should land in the child frame');
    assert.equal(childFrame._filled.email, 'jane@example.com', 'email should land in the child frame');
    assert.equal(Object.keys(mainFrame._filled).length, 0, 'main (empty) frame should receive no fills');
  });

  test('lazy-loaded embed (careerpuck.com timing): fillForm still finds and fills the child frame', async () => {
    const mainFrame = makeFieldFrame(new Set());
    const childFrame = makeFieldFrame(new Set(['first_name', 'email']));
    // Simulate the frame not being attached in page.frames() for the first tick.
    const page = fakePage({ mainFrame, childFrames: [childFrame] });

    const report = await fillForm('greenhouse', page, makePersonal(), null);
    assert.equal(report.filled, 2);
    assert.equal(childFrame._filled.first_name, 'Jane');
  });

  test('no iframe present (regular non-embedded Greenhouse page): fills the main frame directly, unchanged behavior', async () => {
    const mainFrame = makeFieldFrame(new Set(['first_name', 'last_name', 'email']));
    const page = fakePage({ mainFrame, childFrames: [] });

    const report = await fillForm('greenhouse', page, makePersonal(), null);
    assert.equal(report.filled, 3);
    assert.equal(mainFrame._filled.first_name, 'Jane');
  });

  test('no form anywhere: falls back to main frame, reports fields missing (preserves B-16 empty-form guard upstream)', async () => {
    const mainFrame = makeFieldFrame(new Set());
    const childFrame = makeFieldFrame(new Set());
    const page = fakePage({ mainFrame, childFrames: [childFrame] });

    const report = await fillForm('greenhouse', page, makePersonal(), null);
    assert.equal(report.filled, 0, 'nothing found anywhere -> 0 filled, so auto-submit.mjs B-16 guard blocks the submit');
  }, { timeout: 8000 });

});

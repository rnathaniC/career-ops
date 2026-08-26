/**
 * card-flags.test.mjs — unit tests for the #OFF / #GOOD comment-flag PARSER.
 *
 * Run: node --test test/card-flags.test.mjs
 *
 * Convention: "#" is the documented primary tag prefix; "@" is accepted as a
 * fallback (Airtable's "@" triggers a person-mention). Both normalize to the "#"
 * form. Case-insensitive on the tag. Optional #OFF reason ∈ {LOC,FIT,STALE,DUPE,
 * LEVEL}; free text may follow.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFlag, parseFlags, flagKey, bugTriageRowForHit, summarize,
  shouldAutoBlockOff, blockedNoteForOff, withRefMarker, refHitToRegistryEntry, updateRegistryWithRefs,
} from '../scripts/scan-card-flags.mjs';

describe('parseFlag — primary "#" tokens', () => {
  test('#OFF with no reason', () => {
    assert.deepEqual(parseFlag('#OFF'), { tag: '#OFF', reason: null, text: '' });
  });

  test('#OFF:LOC reason, no free text', () => {
    assert.deepEqual(parseFlag('#OFF:LOC'), { tag: '#OFF', reason: 'LOC', text: '' });
  });

  test('#off:fit — case-insensitive tag and reason, normalized to upper', () => {
    assert.deepEqual(parseFlag('#off:fit'), { tag: '#OFF', reason: 'FIT', text: '' });
  });

  test('#GOOD positive signal', () => {
    assert.deepEqual(parseFlag('#GOOD'), { tag: '#GOOD', reason: null, text: '' });
  });

  test('plain text with no token returns null', () => {
    assert.equal(parseFlag('looks like a solid lead, following up'), null);
  });

  test('#OFF:LOC Walnut Creek CA — reason plus free text', () => {
    assert.deepEqual(parseFlag('#OFF:LOC Walnut Creek CA'), {
      tag: '#OFF',
      reason: 'LOC',
      text: 'Walnut Creek CA',
    });
  });
});

describe('parseFlag — "@" fallback prefix normalizes to "#"', () => {
  test('@OFF fallback', () => {
    assert.deepEqual(parseFlag('@OFF'), { tag: '#OFF', reason: null, text: '' });
  });
  test('@off:fit fallback, case-insensitive', () => {
    assert.deepEqual(parseFlag('@off:fit'), { tag: '#OFF', reason: 'FIT', text: '' });
  });
  test('@GOOD fallback', () => {
    assert.deepEqual(parseFlag('@GOOD'), { tag: '#GOOD', reason: null, text: '' });
  });
  test('@OFF:LOC Walnut Creek CA fallback with reason + free text', () => {
    assert.deepEqual(parseFlag('@OFF:LOC Walnut Creek CA'), {
      tag: '#OFF',
      reason: 'LOC',
      text: 'Walnut Creek CA',
    });
  });
});

describe('parseFlags — edge cases', () => {
  test('empty / null / undefined comment → no hits', () => {
    assert.deepEqual(parseFlags(''), []);
    assert.deepEqual(parseFlags(null), []);
    assert.deepEqual(parseFlags(undefined), []);
  });

  test('does not match inside a larger word (#OFFICE)', () => {
    assert.deepEqual(parseFlags('working at the #OFFICE downtown'), []);
  });

  test('unknown reason code is NOT consumed as a reason', () => {
    // ":XYZ" is not a valid reason → bare #OFF whose free text keeps ":XYZ …".
    assert.deepEqual(parseFlag('#OFF:XYZ too junior'), {
      tag: '#OFF',
      reason: null,
      text: ':XYZ too junior',
    });
  });

  test('multiple flags in one comment are all captured, with per-hit free text', () => {
    const hits = parseFlags('#OFF:DUPE already applied here #GOOD strong backup though');
    assert.equal(hits.length, 2);
    assert.deepEqual(hits[0], { tag: '#OFF', reason: 'DUPE', text: 'already applied here' });
    assert.deepEqual(hits[1], { tag: '#GOOD', reason: null, text: 'strong backup though' });
  });

  test('reason is only attached to #OFF, never #GOOD', () => {
    // A ":LOC" after #GOOD is consumed by the regex but reason stays null for GOOD.
    assert.equal(parseFlag('#GOOD:LOC').reason, null);
  });

  test('leading text before the token still yields the hit', () => {
    assert.deepEqual(parseFlag('nope — #OFF:STALE posting is closed'), {
      tag: '#OFF',
      reason: 'STALE',
      text: 'posting is closed',
    });
  });
});

describe('parseFlags — #REF (CHANGE 1)', () => {
  test('#REF with prep free text captured', () => {
    assert.deepEqual(parseFlag('#REF ping Drew, mention the GTC demo'), {
      tag: '#REF', reason: null, text: 'ping Drew, mention the GTC demo',
    });
  });
  test('@REF fallback normalizes to #REF', () => {
    assert.deepEqual(parseFlag('@ref warm intro via Sam'), { tag: '#REF', reason: null, text: 'warm intro via Sam' });
  });
  test('#REF never carries an #OFF reason', () => {
    assert.equal(parseFlag('#REF:LOC whatever').reason, null);
  });
  test('does not match inside #REFERRAL', () => {
    assert.deepEqual(parseFlags('great #REFERRAL program'), []);
  });
  test('mixed #REF + #OFF both captured', () => {
    const hits = parseFlags('#REF call first #OFF:DUPE already applied');
    assert.equal(hits.length, 2);
    assert.equal(hits[0].tag, '#REF');
    assert.equal(hits[1].tag, '#OFF');
    assert.equal(hits[1].reason, 'DUPE');
  });
  test('summarize counts #REF', () => {
    const s = summarize([{ tag: '#REF', reason: null }, { tag: '#OFF', reason: 'LOC' }]);
    assert.equal(s.byTag['#REF'], 1);
    assert.equal(s.byTag['#OFF'], 1);
  });
});

describe('shouldAutoBlockOff — #OFF on New-Hot (CHANGE 2)', () => {
  test('#OFF on New-Hot → true', () => {
    assert.equal(shouldAutoBlockOff({ tag: '#OFF', lane: 'New-Hot' }), true);
  });
  test('#OFF on New-Fresh → false (unchanged behavior)', () => {
    assert.equal(shouldAutoBlockOff({ tag: '#OFF', lane: 'New-Fresh' }), false);
  });
  test('#GOOD / #REF on New-Hot → false', () => {
    assert.equal(shouldAutoBlockOff({ tag: '#GOOD', lane: 'New-Hot' }), false);
    assert.equal(shouldAutoBlockOff({ tag: '#REF', lane: 'New-Hot' }), false);
  });
  test('blockedNoteForOff is reason-aware', () => {
    assert.match(blockedNoteForOff('FIT', '2026-08-25'), /#OFF:FIT/);
    assert.match(blockedNoteForOff('FIT', '2026-08-25'), /removed from Hot lane/);
    assert.match(blockedNoteForOff(null, '2026-08-25'), /#OFF —/);
  });
});

describe('withRefMarker — idempotent top-of-lane marker (CHANGE 1)', () => {
  test('adds marker to empty notes', () => {
    assert.equal(withRefMarker(''), '[#REF]');
  });
  test('prepends marker as its own line', () => {
    assert.equal(withRefMarker('existing note'), '[#REF]\nexisting note');
  });
  test('idempotent — does not double-add', () => {
    assert.equal(withRefMarker('[#REF]\nexisting note'), '[#REF]\nexisting note');
  });
});

describe('refHitToRegistryEntry — #REF feeds the registry (CHANGE 1/3)', () => {
  test('maps company + prep text into a confirmed ref-tag entry', () => {
    const e = refHitToRegistryEntry({ company: 'Databricks', role: 'Staff PM', text: 'ask Jane', commentedAt: '2026-08-25T00:00:00Z' });
    assert.equal(e.referred_company, 'Databricks');
    assert.equal(e.source, 'ref-tag');
    assert.equal(e.unconfirmed, false);
    assert.match(e.notes, /ask Jane/);
  });
});

describe('updateRegistryWithRefs — idempotent merge (fake fs)', () => {
  const yaml = { load: (t) => JSON.parse(t), dump: (o) => JSON.stringify(o) };
  const makeFs = (initial) => {
    const store = { 'reg.yml': initial };
    return {
      existsSync: (p) => p in store,
      readFileSync: (p) => store[p],
      writeFileSync: (p, d) => { store[p] = d; },
      _store: store,
    };
  };
  test('adds a new #REF company once; second run adds nothing', () => {
    const fs = makeFs(JSON.stringify({ entries: [] }));
    const refHits = [{ company: 'Snowflake', text: 'intro via Lee' }];
    const r1 = updateRegistryWithRefs(refHits, { path: 'reg.yml', yaml, fs });
    assert.equal(r1.added, 1);
    const r2 = updateRegistryWithRefs(refHits, { path: 'reg.yml', yaml, fs });
    assert.equal(r2.added, 0); // idempotent
    const parsed = JSON.parse(fs._store['reg.yml']);
    assert.equal(parsed.entries.filter((e) => e.referred_company === 'Snowflake').length, 1);
  });
  test('no yaml/fs injected → no-op (safe on import)', () => {
    assert.deepEqual(updateRegistryWithRefs([{ company: 'X' }], {}), { added: 0 });
  });
});

describe('flagKey — stable dedupe key', () => {
  test('same record + comment → same key; different → different', () => {
    const a = flagKey('recABC', '#OFF:LOC too far');
    const b = flagKey('recABC', '#OFF:LOC too far');
    const c = flagKey('recXYZ', '#OFF:LOC too far');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{16}$/);
  });
});

describe('bugTriageRowForHit — row shape for an #OFF hit', () => {
  test('title, description, notes, source, status populated; flag-key embedded', () => {
    const hit = {
      company: 'Acme', role: 'Staff PM', url: 'https://jobs.example/1',
      lane: 'New-Fresh', tag: '#OFF', reason: 'LOC', text: 'Walnut Creek CA',
      commenter: 'Rahil', commentedAt: '2026-08-25T10:00:00.000Z',
      key: 'abc123def4567890',
    };
    const row = bugTriageRowForHit(hit).fields;
    const title = row[Object.keys(row)[0]];
    assert.match(title, /^\[card-flag\] Acme Staff PM - #OFF:LOC$/);
    // The Notes field must carry the dedupe marker for idempotent re-runs.
    const notes = Object.values(row).find((v) => /\[flag-key:/.test(v));
    assert.match(notes, /\[flag-key: abc123def4567890\]/);
    // The url + comment text land in the Description.
    const desc = Object.values(row).find((v) => /jobs\.example/.test(v));
    assert.match(desc, /Walnut Creek CA/);
  });
});

describe('summarize — counts by tag and reason', () => {
  test('tallies #OFF/#GOOD and #OFF reasons', () => {
    const s = summarize([
      { tag: '#OFF', reason: 'LOC' },
      { tag: '#OFF', reason: 'FIT' },
      { tag: '#OFF', reason: null },
      { tag: '#GOOD', reason: null },
    ]);
    assert.equal(s.total, 4);
    assert.equal(s.byTag['#OFF'], 3);
    assert.equal(s.byTag['#GOOD'], 1);
    assert.equal(s.byReason.LOC, 1);
    assert.equal(s.byReason.FIT, 1);
    assert.equal(s.byReason.NONE, 1);
  });
});

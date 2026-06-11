import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanpaste } from '../scripts/cleanpaste.mjs';

// Build test strings from explicit \u escapes so the test file is pure ASCII --
// no reliance on editor/encoding to preserve the Unicode chars at rest.
const LDQUO  = '“'; // LEFT DOUBLE QUOTATION MARK
const RDQUO  = '”'; // RIGHT DOUBLE QUOTATION MARK
const LSQUO  = '‘'; // LEFT SINGLE QUOTATION MARK
const RSQUO  = '’'; // RIGHT SINGLE QUOTATION MARK
const ZWSP   = '​'; // ZERO WIDTH SPACE
const BOM    = '﻿'; // BYTE ORDER MARK
const WJ     = '⁠'; // WORD JOINER
const EMDASH = '—'; // EM DASH
const ENDASH = '–'; // EN DASH
const NBSP   = ' '; // NO-BREAK SPACE
const HELLIP = '…'; // HORIZONTAL ELLIPSIS

describe('cleanpaste', () => {

  test('curly double quotes become straight double quotes', () => {
    assert.equal(cleanpaste(LDQUO + 'Hello world' + RDQUO), '"Hello world"');
  });

  test('curly single quotes and apostrophes become straight', () => {
    assert.equal(
      cleanpaste('I' + RSQUO + 've done it' + LSQUO + 'well' + RSQUO),
      "I've done it'well'",
    );
  });

  test('zero-width chars (ZWSP, BOM, WJ) are stripped', () => {
    assert.equal(cleanpaste('hel' + ZWSP + 'lo' + BOM + ' wor' + WJ + 'ld'), 'hello world');
  });

  test('em-dash before lowercase becomes ", "', () => {
    assert.equal(cleanpaste('teams' + EMDASH + 'not just'), 'teams, not just');
  });

  test('em-dash before uppercase becomes ". "', () => {
    assert.equal(cleanpaste('sounds' + EMDASH + 'Both require'), 'sounds. Both require');
  });

  test('en-dash becomes hyphen-minus', () => {
    assert.equal(cleanpaste('2020' + ENDASH + '2024'), '2020-2024');
  });

  test('non-breaking space becomes regular space', () => {
    assert.equal(cleanpaste('foo' + NBSP + 'bar'), 'foo bar');
  });

  test('horizontal ellipsis becomes three dots', () => {
    assert.equal(cleanpaste('and so on' + HELLIP), 'and so on...');
  });

  test('plain ASCII text is returned unchanged', () => {
    const plain = 'Hello, world. No changes needed here.';
    assert.equal(cleanpaste(plain), plain);
  });

});

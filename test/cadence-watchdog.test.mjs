/**
 * cadence-watchdog.test.mjs — Tests the hardened cadence watchdog (K-2026-07-28).
 *
 * THE BUG THIS GUARDS AGAINST: cadence health used to be derived from MARKER
 * PRESENCE. A cadence marker was appended every night, so when the 1 AM task
 * stopped running the real pipeline for ~5 days (7/24–7/28) but kept firing the
 * marker step, every masked day looked "present" and the outage stayed hidden
 * while data/last-refresh.json rotted 136h stale.
 *
 * The watchdog now counts a day as a genuine run ONLY IF there is real evidence:
 * a "[startup] STARTED" line, a verified "[fresh-refresh:" marker token, or the
 * last-refresh date advancing to that day. A bare marker => SILENT MISS.
 *
 * Run: node --test test/cadence-watchdog.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDate,
  computeCadence,
  lastDates,
} from '../scripts/cadence-watchdog.mjs';
import { markerLine } from '../scripts/cadence-mark.mjs';

const BARE_MARKER = '[cadence-mark] 2026-07-24T05:21:31.416Z — step-wise run marker\n';
const STARTUP_LOG = '[2026-07-22T05:22:58.682Z] [startup] STARTED\n...orchestrator output...\n';

describe('classifyDate — a marker is not a receipt', () => {
  test('bare cadence marker + last-refresh NOT advanced => silent-miss', () => {
    assert.equal(classifyDate(BARE_MARKER, '2026-07-24', '2026-07-23'), 'silent-miss');
  });

  test('real orchestrator [startup] STARTED => ran', () => {
    assert.equal(classifyDate(STARTUP_LOG, '2026-07-22', '2026-07-23'), 'ran');
  });

  test('last-refresh advanced to this date => ran (covers stepwise runs)', () => {
    assert.equal(classifyDate(BARE_MARKER, '2026-07-23', '2026-07-23'), 'ran');
  });

  test('verified [fresh-refresh:] marker token => ran, durably (even after last-refresh moves on)', () => {
    const verified = markerLine('2026-07-23', 'step-wise run marker', '2026-07-23');
    // last-refresh has since advanced to a later day, yet the durable token still proves it.
    assert.equal(classifyDate(verified, '2026-07-23', '2026-07-29'), 'ran');
  });

  test('NO-FRESH-REFRESH marker token => still a silent-miss', () => {
    const stale = markerLine('2026-07-24', 'step-wise run marker', '2026-07-23');
    assert.equal(classifyDate(stale, '2026-07-24', '2026-07-23'), 'silent-miss');
  });

  test('no log at all => missing', () => {
    assert.equal(classifyDate(null, '2026-07-25', '2026-07-23'), 'missing');
  });
});

describe('computeCadence — reproduces the real 7/24–7/28 masked outage', () => {
  // Model the actual incident: real runs 7/22 (startup log) and 7/23 (last-refresh
  // advanced), then marker-only nights 7/24, 7/27, 7/28 and NO log 7/25, 7/26.
  const logs = {
    '2026-07-22': STARTUP_LOG,
    '2026-07-23': BARE_MARKER,
    '2026-07-24': BARE_MARKER,
    '2026-07-27': BARE_MARKER,
    '2026-07-28': BARE_MARKER,
    // 7/25 and 7/26 absent entirely
  };
  const status = computeCadence({
    through: '2026-07-28',
    window: 7,
    lrDate: '2026-07-23', // last-refresh frozen at 7/23 — the outage signature
    readLogFn: (d) => logs[d] ?? null,
    generatedAt: '2026-07-28T05:16:00.000Z',
  });

  test('genuine runs are exactly 7/22 and 7/23', () => {
    assert.deepEqual(status.present, ['2026-07-22', '2026-07-23']);
    assert.equal(status.last_run, '2026-07-23');
  });

  test('marker-only nights are flagged as SILENT misses, not counted healthy', () => {
    assert.deepEqual(status.silent_misses, ['2026-07-24', '2026-07-27', '2026-07-28']);
  });

  test('no-log days are hard misses (today excluded from hard-miss grace only)', () => {
    assert.deepEqual(status.missing, ['2026-07-25', '2026-07-26']);
  });

  test('total gap_count = hard + silent = 5, streak NOT ok', () => {
    assert.equal(status.gap_count, 5);
    assert.equal(status.streak_ok, false);
  });

  test('a healthy window with genuine runs every day has zero gaps', () => {
    const good = computeCadence({
      through: '2026-07-28',
      window: 3,
      lrDate: '2026-07-28',
      readLogFn: () => STARTUP_LOG,
      generatedAt: '2026-07-28T05:16:00.000Z',
    });
    assert.equal(good.gap_count, 0);
    assert.equal(good.streak_ok, true);
    assert.deepEqual(good.silent_misses, []);
  });
});

describe('lastDates', () => {
  test('inclusive window ending at through', () => {
    assert.deepEqual(lastDates('2026-07-28', 3), ['2026-07-26', '2026-07-27', '2026-07-28']);
  });
});

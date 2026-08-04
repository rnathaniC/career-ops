/**
 * daily-health-report.test.mjs — Tests for the in-repo daily health report generator.
 *
 * Guards the two things the old OneDrive SKILL.md got wrong:
 *   1. The score/flag logic is deterministic and correct.
 *   2. It NEVER silently no-ops — even with zero data sources it still writes a
 *      report file (with a loud DEGRADED banner).
 *
 * Run: node --test test/daily-health-report.test.mjs
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  computeHealthScore,
  collectFlags,
  buildReport,
  generate,
  newestReferralQueue,
  hoursSince,
  normalizeOutcome,
  flattenLiveRun,
  summarizeLiveRuns,
  renderAutoSubmitScorecard,
  computeAutoSubmitScorecard,
  AUTO_SUBMIT_CATEGORIES,
} from '../scripts/daily-health-report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-07-22T14:00:00Z');

// A clean, fresh telemetry blob (ran ~9h ago relative to NOW).
function cleanRefresh() {
  return {
    ran_at_utc: '2026-07-22T05:23:31.163Z',
    mode: 'live',
    doctor: 'ok',
    cards_injected: 3,
    cover_letters: 2,
    autosubmit: { attempted: 4, result: 'clean', exit: 0 },
    primary_scan: { exit: 0 },
    workday_scan: { exit: 0 },
    worker_grader: { exit: 0 },
    ashby_scan: { exit: 0 },
    kanban_inject: { exit: 0 },
    ingest: { exit: 0 },
    archive_stale: { exit: 0 },
    lane_branch: { exit: 0, hot_count: 4, fresh_count: 6 },
    cadence: { gap_count: 0, missing: [] },
    notes: [],
    defects_autofixed: [],
  };
}

describe('computeHealthScore', () => {
  test('clean run scores 100 / A / GREEN', () => {
    const h = computeHealthScore(cleanRefresh(), { gap_count: 0 }, { hot_count: 4 }, NOW);
    assert.equal(h.score, 100);
    assert.equal(h.grade, 'A');
    assert.equal(h.verdict, 'GREEN');
    assert.deepEqual(h.factors, []);
  });

  test('missing refresh yields UNKNOWN (never throws)', () => {
    const h = computeHealthScore(null, null, null, NOW);
    assert.equal(h.score, null);
    assert.equal(h.verdict, 'UNKNOWN');
    assert.ok(h.factors.length >= 1);
  });

  test('cadence gaps, doctor failure and stale data all deduct', () => {
    const r = cleanRefresh();
    r.doctor = 'degraded';
    r.ran_at_utc = '2026-07-20T05:00:00Z'; // >30h before NOW
    const h = computeHealthScore(r, { gap_count: 4 }, { hot_count: 4 }, NOW);
    // -20 doctor, -25 stale, -20 cadence (capped) = 35
    assert.equal(h.score, 35);
    assert.equal(h.verdict, 'RED');
    assert.ok(h.factors.some((f) => /doctor/.test(f)));
    assert.ok(h.factors.some((f) => /stale/.test(f)));
  });

  test('nonzero autosubmit exit deducts 10', () => {
    const r = cleanRefresh();
    r.autosubmit = { attempted: 4, result: 'blocked', exit: 2 };
    const h = computeHealthScore(r, { gap_count: 0 }, { hot_count: 4 }, NOW);
    assert.equal(h.score, 90);
    assert.ok(h.factors.some((f) => /autosubmit exit=2/.test(f)));
  });

  test('large referral backlog deducts 5', () => {
    const h = computeHealthScore(cleanRefresh(), { gap_count: 0 }, { hot_count: 26 }, NOW);
    assert.equal(h.score, 95);
  });

  test('SILENT misses (marker but no fresh refresh) deduct and are named in factors', () => {
    // K-2026-07-28: a cadence marker without an advanced last-refresh must NOT be
    // treated as a healthy run — it is a masked outage and must deduct + surface.
    const h = computeHealthScore(
      cleanRefresh(),
      { gap_count: 3, missing: [], silent_misses: ['2026-07-24', '2026-07-27', '2026-07-28'] },
      { hot_count: 4 },
      NOW,
    );
    assert.equal(h.score, 76); // -24 for 3 silent misses (3*8, capped 30)
    assert.ok(h.factors.some((f) => /SILENT pipeline miss/.test(f)));
    assert.ok(h.factors.some((f) => /2026-07-24/.test(f)));
  });

  test('an advanced last-refresh day is healthy — a marker-only day is NOT', () => {
    // Day WITH real fresh data (no silent miss) stays clean/GREEN...
    const healthy = computeHealthScore(
      cleanRefresh(),
      { gap_count: 0, missing: [], silent_misses: [] },
      { hot_count: 4 },
      NOW,
    );
    assert.equal(healthy.score, 100);
    assert.equal(healthy.verdict, 'GREEN');
    assert.ok(!healthy.factors.some((f) => /SILENT/.test(f)));

    // ...while the same telemetry with a marker-only day is penalised and flagged.
    const masked = computeHealthScore(
      cleanRefresh(),
      { gap_count: 1, missing: [], silent_misses: ['2026-07-24'] },
      { hot_count: 4 },
      NOW,
    );
    assert.ok(masked.score < healthy.score, 'a silent-miss day must score lower than a genuine run');
    assert.ok(masked.factors.some((f) => /SILENT pipeline miss/.test(f)));
  });
});

describe('collectFlags', () => {
  test('splits notes, surfaces pending dispatch as tech debt + kaizen', () => {
    const r = cleanRefresh();
    r.notes = [
      'CL generation not yet in orchestrator (TODO CL-Gen).',
      '26 New-Hot card(s) waiting on Rahil.',
    ];
    const dispatch = { pending: ['a.mjs', 'b.mjs'] };
    const flags = collectFlags(r, dispatch, { gap_count: 2, missing: ['2026-07-20', '2026-07-21'] }, { hot_count: 26 });
    assert.ok(flags.techDebt.some((t) => /TODO CL-Gen/.test(t)));
    assert.ok(flags.techDebt.some((t) => /NOT dispatched/.test(t)));
    assert.ok(flags.actions.some((a) => /waiting on Rahil/.test(a)));
    assert.ok(flags.kaizen.some((k) => /dispatch-relay/.test(k)));
    assert.ok(flags.kaizen.some((k) => /missed 2 run/.test(k)));
  });

  test('clean state produces no debt and no actions', () => {
    const flags = collectFlags(cleanRefresh(), { pending: [] }, { gap_count: 0 }, { hot_count: 4 });
    assert.deepEqual(flags.techDebt, []);
    assert.deepEqual(flags.actions, []);
  });

  test('silent misses surface loudly as tech-debt + action + kaizen', () => {
    const flags = collectFlags(
      cleanRefresh(),
      { pending: [] },
      { gap_count: 3, missing: ['2026-07-25'], silent_misses: ['2026-07-24', '2026-07-27'] },
      { hot_count: 4 },
    );
    // Exact loud flag format, one per silent-miss day.
    assert.ok(flags.techDebt.some((t) => /marker present but no fresh refresh — silent pipeline miss on 2026-07-24/.test(t)));
    assert.ok(flags.techDebt.some((t) => /silent pipeline miss on 2026-07-27/.test(t)));
    // Action + kaizen call out the masking explicitly.
    assert.ok(flags.actions.some((a) => /SILENTLY missed/.test(a)));
    assert.ok(flags.kaizen.some((k) => /never advanced last-refresh/.test(k)));
    // A true hard-missing day still surfaces its own kaizen, separately.
    assert.ok(flags.kaizen.some((k) => /Scheduler missed 1 run/.test(k)));
  });

  test('a day whose last-refresh advanced (no silent miss) yields no silent-miss flags', () => {
    const flags = collectFlags(
      cleanRefresh(),
      { pending: [] },
      { gap_count: 0, missing: [], silent_misses: [] },
      { hot_count: 4 },
    );
    assert.ok(!flags.techDebt.some((t) => /silent pipeline miss/.test(t)));
    assert.ok(!flags.actions.some((a) => /SILENTLY missed/.test(a)));
  });

  test('gitignored user files (portals.yml) are excluded from the ship-gap flag', () => {
    // portals.yml is a per-user gitignored file the ship-gate can never dispatch;
    // it must NOT appear as a "validated but NOT dispatched" tech-debt nag, while
    // a normal source file in the same pending set still surfaces.
    const dispatch = { pending: ['portals.yml', 'scripts/real.mjs'] };
    const flags = collectFlags(cleanRefresh(), dispatch, { gap_count: 0 }, { hot_count: 4 });
    const shipGap = flags.techDebt.find((t) => /NOT dispatched/.test(t));
    assert.ok(shipGap, 'the normal file must still produce a ship-gap flag');
    assert.ok(!/portals\.yml/.test(shipGap), 'portals.yml must not appear in the ship-gap flag');
    assert.ok(/scripts\/real\.mjs/.test(shipGap), 'the normal file must still be listed');
    assert.ok(/^1 file\(s\)/.test(shipGap), 'count must reflect shippable files only (1, not 2)');
  });

  test('a pending set of ONLY gitignored user files yields no ship-gap flag or kaizen', () => {
    const dispatch = { pending: ['portals.yml', 'config/profile.yml', 'modes\\_profile.md'] };
    const flags = collectFlags(cleanRefresh(), dispatch, { gap_count: 0 }, { hot_count: 4 });
    assert.ok(!flags.techDebt.some((t) => /NOT dispatched/.test(t)), 'no ship-gap tech-debt');
    assert.ok(!flags.kaizen.some((k) => /dispatch-relay/.test(k)), 'no dispatch kaizen nag');
  });
});

describe('hoursSince', () => {
  test('parses ISO and returns null for garbage', () => {
    assert.equal(Math.round(hoursSince('2026-07-22T05:00:00Z', Parse('2026-07-22T14:00:00Z'))), 9);
    assert.equal(hoursSince('not-a-date', NOW), null);
  });
});
function Parse(s) { return Date.parse(s); }

describe('generate — anti silent-no-op', () => {
  const TMP = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-dhr-'));
  after(() => fs.rmSync(TMP, { recursive: true, force: true }));

  test('writes a full report when all sources present', () => {
    const dataDir = path.join(TMP, 'data-full');
    const outDir = path.join(TMP, 'out-full');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'last-refresh.json'), JSON.stringify(cleanRefresh()));
    fs.writeFileSync(path.join(dataDir, 'cadence-status.json'), JSON.stringify({ gap_count: 0, missing: [] }));
    fs.writeFileSync(path.join(dataDir, 'referral-queue-2026-07-22.json'), JSON.stringify({ hot_count: 2, fresh_count: 1, hot: [{ company: 'X', role: 'PM', connectionName: 'Y', message_drafted: true }] }));
    fs.writeFileSync(path.join(dataDir, 'submit-queue.json'), JSON.stringify([{ status: 'queued' }, { status: 'queued' }]));
    fs.writeFileSync(path.join(dataDir, 'ingest-status.json'), JSON.stringify({ considered: 10, graded: 3, fresh: 2, referral_held: 1, added: 0 }));
    fs.writeFileSync(path.join(dataDir, 'dispatch-manifest.json'), JSON.stringify({ pending: [] }));

    const res = generate({ dataDir, outDir, date: '2026-07-22', now: NOW });
    assert.ok(fs.existsSync(res.reportPath));
    const md = fs.readFileSync(res.reportPath, 'utf8');
    assert.ok(md.includes('# Pulse Daily — 2026-07-22'));
    assert.ok(md.includes('GREEN'));
    assert.ok(md.includes('## Referral queue'));
    assert.ok(!md.includes('DEGRADED')); // all sources present
  });

  test('STILL writes a report (with DEGRADED banner) when data dir is empty', () => {
    const dataDir = path.join(TMP, 'data-empty');
    const outDir = path.join(TMP, 'out-empty');
    fs.mkdirSync(dataDir, { recursive: true });

    const res = generate({ dataDir, outDir, date: '2026-07-22', now: NOW });
    assert.ok(fs.existsSync(res.reportPath), 'report file must exist even with zero sources');
    const md = fs.readFileSync(res.reportPath, 'utf8');
    assert.ok(md.includes('DEGRADED'), 'must loudly flag missing sources');
    assert.ok(md.includes('UNKNOWN'), 'health verdict is UNKNOWN with no telemetry');
    assert.ok(md.length > 200, 'report must have real content, not be empty');
  });
});

describe('newestReferralQueue', () => {
  const TMP = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-rq-'));
  after(() => fs.rmSync(TMP, { recursive: true, force: true }));

  test('picks the lexically-latest dated file', () => {
    for (const d of ['2026-07-01', '2026-07-22', '2026-07-09']) {
      fs.writeFileSync(path.join(TMP, `referral-queue-${d}.json`), '{}');
    }
    fs.writeFileSync(path.join(TMP, 'referral-queue-notes.txt'), 'ignore');
    assert.equal(path.basename(newestReferralQueue(TMP)), 'referral-queue-2026-07-22.json');
  });

  test('returns null when nothing matches', () => {
    const empty = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-rq-empty-'));
    assert.equal(newestReferralQueue(empty), null);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

// ── Auto-Submit Scorecard ────────────────────────────────────────
// Guards THE landmine: "confirmed" is a substring of "unconfirmed". A naive
// includes() classifier reported 10 confirmed when the truth was 0. These tests
// pin exact/normalized classification and the today-vs-running split.
describe('normalizeOutcome — exact match, never substring', () => {
  test("'unconfirmed' classifies as unconfirmed, NOT confirmed", () => {
    assert.equal(normalizeOutcome('unconfirmed'), 'unconfirmed');
    assert.notEqual(normalizeOutcome('unconfirmed'), 'confirmed');
  });

  test('confirmed and its aliases map to confirmed', () => {
    for (const v of ['confirmed', 'submitted', 'SUCCESS', ' Confirmed ']) {
      assert.equal(normalizeOutcome(v), 'confirmed');
    }
  });

  test('each canonical category is recognized', () => {
    assert.equal(normalizeOutcome('error'), 'error');
    assert.equal(normalizeOutcome('blocked'), 'blocked');
    assert.equal(normalizeOutcome('requires-human'), 'requires-human');
    assert.equal(normalizeOutcome('requires_human'), 'requires-human'); // underscore normalized
    assert.equal(normalizeOutcome('skipped'), 'skipped');
  });

  test('missing / garbage / null → unknown (never throws)', () => {
    assert.equal(normalizeOutcome(undefined), 'unknown');
    assert.equal(normalizeOutcome(null), 'unknown');
    assert.equal(normalizeOutcome(''), 'unknown');
    assert.equal(normalizeOutcome('banana'), 'unknown');
  });
});

describe('flattenLiveRun — handles the three observed shapes', () => {
  test('object with results array', () => {
    const items = flattenLiveRun({ ran_at: 'x', results: [{ status: 'error' }, { status: 'blocked' }] });
    assert.equal(items.length, 2);
  });

  test('bare array of result items', () => {
    const items = flattenLiveRun([{ status: 'unconfirmed' }, { status: 'skipped' }]);
    assert.equal(items.length, 2);
  });

  test('array of run-wrappers that each nest their own results (no wrapper double-count)', () => {
    const items = flattenLiveRun([
      { ran_at: 'a', confirmed: 0, results: [{ status: 'requires-human' }] },
      { ran_at: 'b', confirmed: 0, results: [{ status: 'unconfirmed' }] },
    ]);
    // Two leaf results, NOT four (the two wrapper objects must not be counted).
    assert.equal(items.length, 2);
  });
});

describe('summarizeLiveRuns — classification, today/running split, rates', () => {
  const reportDate = '2026-08-02';
  const runFiles = [
    // Historical file: 1 confirmed does NOT exist here — only unconfirmed + skipped.
    { file: 'live-runs-2026-07-17.json', date: '2026-07-17', data: { results: [
      { status: 'unconfirmed' }, { status: 'skipped' }, { status: 'skipped' },
    ] } },
    { file: 'live-runs-2026-07-20.json', date: '2026-07-20', data: { results: [
      { status: 'error' }, { status: 'requires-human' },
    ] } },
    // Today's file.
    { file: 'live-runs-2026-08-02.json', date: '2026-08-02', data: { results: [
      { status: 'blocked' }, { status: 'unconfirmed' }, { status: 'requires-human' },
    ] } },
    // An unreadable file must be counted as unreadable, never crash.
    { file: 'live-runs-2026-08-01.json', date: '2026-08-01', data: null, readError: 'missing' },
  ];

  test('an unconfirmed outcome is NEVER counted as confirmed (0 confirmed everywhere)', () => {
    const sc = summarizeLiveRuns(runFiles, reportDate);
    assert.equal(sc.running.confirmed, 0, 'zero confirmed across all files');
    assert.equal(sc.today.confirmed, 0, 'zero confirmed today');
    // There ARE unconfirmed cards — they must land in the unconfirmed bucket.
    assert.equal(sc.running.unconfirmed, 2);
    assert.equal(sc.today.unconfirmed, 1);
  });

  test('per-category running totals are correct', () => {
    const sc = summarizeLiveRuns(runFiles, reportDate);
    assert.equal(sc.running.error, 1);
    assert.equal(sc.running.blocked, 1);
    assert.equal(sc.running['requires-human'], 2);
    assert.equal(sc.running.skipped, 2);
    assert.equal(sc.running.unknown, 0);
    assert.equal(sc.totals.running, 8); // 3 + 2 + 3 leaf items across readable files
  });

  test('today column reflects ONLY the report-date file', () => {
    const sc = summarizeLiveRuns(runFiles, reportDate);
    assert.equal(sc.totals.today, 3);
    assert.equal(sc.today.blocked, 1);
    assert.equal(sc.today['requires-human'], 1);
    assert.equal(sc.today.error, 0); // error was a historical day, not today
    // Today's counts must never exceed the running totals.
    for (const cat of AUTO_SUBMIT_CATEGORIES) {
      assert.ok(sc.today[cat] <= sc.running[cat], `today.${cat} <= running.${cat}`);
    }
  });

  test('unreadable file is tallied as unreadable, not as an attempt', () => {
    const sc = summarizeLiveRuns(runFiles, reportDate);
    assert.equal(sc.filesRead, 3);
    assert.equal(sc.filesUnreadable, 1);
  });

  test('raw and adjusted rates are 0.0% when confirmed is 0', () => {
    const sc = summarizeLiveRuns(runFiles, reportDate);
    // raw = 0 / 8 = 0.0
    assert.equal(sc.rates.running.raw, 0);
    assert.equal(sc.rates.running.rawDenom, 8);
    // adjusted denom excludes skipped(2) + requires-human(2) = 8 - 4 = 4
    assert.equal(sc.rates.running.adjustedDenom, 4);
    assert.equal(sc.rates.running.adjusted, 0);
  });

  test('a genuinely confirmed card DOES move the rate (classifier is not stuck at zero)', () => {
    const withWin = [
      { file: 'live-runs-2026-08-02.json', date: '2026-08-02', data: { results: [
        { status: 'confirmed' }, { status: 'unconfirmed' },
      ] } },
    ];
    const sc = summarizeLiveRuns(withWin, reportDate);
    assert.equal(sc.running.confirmed, 1);
    assert.equal(sc.running.unconfirmed, 1);
    assert.equal(sc.rates.running.raw, 50); // 1 of 2
  });

  test('empty input degrades to zeros with no genuine attempts (no throw, no NaN)', () => {
    const sc = summarizeLiveRuns([], reportDate);
    assert.equal(sc.totals.running, 0);
    assert.equal(sc.rates.running.raw, null); // 0/0 → null, rendered as n/a
    assert.equal(sc.rates.running.adjusted, null);
  });
});

describe('renderAutoSubmitScorecard', () => {
  test('renders a table with all categories and a zero-confirmed rate line', () => {
    const sc = summarizeLiveRuns([
      { file: 'live-runs-2026-08-02.json', date: '2026-08-02', data: { results: [{ status: 'unconfirmed' }] } },
    ], '2026-08-02');
    const md = renderAutoSubmitScorecard(sc).join('\n');
    assert.ok(md.includes('## Auto-Submit Scorecard'));
    assert.ok(md.includes('| Confirmed / submitted | 0 | 0 |'));
    assert.ok(/Raw: 0\.0% — 0 confirmed \/ 1 total attempts/.test(md));
    assert.ok(md.includes('| Unconfirmed | 1 | 1 |'));
  });

  test('empty data renders the degraded note, not a silent blank', () => {
    const md = renderAutoSubmitScorecard(summarizeLiveRuns([], '2026-08-02')).join('\n');
    assert.ok(md.includes('No readable'));
    assert.ok(md.includes('Total attempts'));
  });
});

describe('computeAutoSubmitScorecard — real repo data reads 0 confirmed', () => {
  test('the live data/ directory has zero confirmed submissions', () => {
    // The repo's real live-runs history is the ground truth the task pins:
    // ZERO confirmed across the corpus. If a substring bug ever regresses this,
    // confirmed jumps and this test fails loudly.
    const dataDir = path.join(__dirname, '..', 'data');
    const sc = computeAutoSubmitScorecard(dataDir, '2026-08-02');
    assert.equal(sc.running.confirmed, 0, 'real corpus must show ZERO confirmed');
    assert.ok(sc.totals.running > 0, 'and must actually be reading attempts');
  });
});

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

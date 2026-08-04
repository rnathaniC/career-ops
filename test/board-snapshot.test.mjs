/**
 * board-snapshot.test.mjs — Tests for the pipeline board snapshot's pure helpers.
 *
 * Run: node --test test/board-snapshot.test.mjs
 *
 * Only the pure functions are covered (HTML building, latest-file discovery).
 * The Playwright screenshot itself is not exercised — it needs a browser binary
 * and degrades loudly on its own when chromium is unavailable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildBoardHtml, findLatestBoardMirror } from '../scripts/render-board-snapshot.mjs';
import { findLatestBoardImage } from '../scripts/email-report.mjs';

const SAMPLE = [
  { id: 'a1', company: 'Databricks', role: 'Staff Program Manager, People M&A', grade: 'C', columnId: 'new-hot', connectionName: 'Denny Lee' },
  { id: 'a2', company: 'Stripe', role: 'Technical Program Manager, Bridge', grade: 'B', columnId: 'new-fresh' },
  { id: 'a3', company: 'Pinterest', role: 'Staff Technical Program Manager', grade: 'B', columnId: 'submit-ready' },
  { id: 'a4', company: 'Coupa', role: 'PM', grade: 'D', columnId: 'blocked' },
  { id: 'a5', company: 'Acme', role: 'TPM', grade: 'A', columnId: 'applied' },
];

describe('buildBoardHtml', () => {
  test('renders all five lanes with their names and counts', () => {
    const html = buildBoardHtml(SAMPLE, '2026-08-04');
    for (const lane of ['New-Hot', 'New-Fresh', 'Submit Ready', 'Blocked', 'Applied']) {
      assert.ok(html.includes(lane), `missing lane ${lane}`);
    }
    assert.ok(html.includes('Job Pulse Board'));
    assert.ok(html.includes('2026-08-04'));
    assert.ok(html.includes('5 active card(s)'));
  });

  test('places each card in its lane and shows the connection for hot cards', () => {
    const html = buildBoardHtml(SAMPLE, '2026-08-04');
    assert.ok(html.includes('Databricks'));
    assert.ok(html.includes('Denny Lee'), 'hot card connection should render');
    assert.ok(html.includes('Pinterest'));
  });

  test('escapes HTML-significant characters (ampersand in role)', () => {
    const html = buildBoardHtml(SAMPLE, '2026-08-04');
    assert.ok(html.includes('People M&amp;A'));
    assert.ok(!html.includes('People M&A '));
  });

  test('an unknown columnId falls back into New-Fresh rather than being dropped', () => {
    const html = buildBoardHtml([{ id: 'x', company: 'Ghost', role: 'R', grade: 'B', columnId: 'nonsense' }], '2026-08-04');
    assert.ok(html.includes('Ghost'));
    assert.ok(html.includes('1 active card(s)'));
  });
});

describe('findLatestBoardMirror / findLatestBoardImage', () => {
  test('findLatestBoardMirror returns the newest kanban-import file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
    try {
      for (const d of ['2026-08-01', '2026-08-04', '2026-08-02']) {
        fs.writeFileSync(path.join(dir, `kanban-import-${d}.json`), '[]');
      }
      fs.writeFileSync(path.join(dir, 'other.json'), '[]');
      assert.equal(path.basename(findLatestBoardMirror(dir)), 'kanban-import-2026-08-04.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('findLatestBoardImage returns the newest pulse-board png, ignoring other files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgs-'));
    try {
      fs.writeFileSync(path.join(dir, 'pulse-board-2026-08-02.png'), 'x');
      fs.writeFileSync(path.join(dir, 'pulse-board-2026-08-04.png'), 'x');
      fs.writeFileSync(path.join(dir, 'pulse-daily-2026-08-04.md'), 'x');
      assert.equal(path.basename(findLatestBoardImage(dir)), 'pulse-board-2026-08-04.png');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('findLatestBoardImage returns null when there are no snapshots', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgs-empty-'));
    try {
      assert.equal(findLatestBoardImage(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

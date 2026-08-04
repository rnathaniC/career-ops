/**
 * email-report.test.mjs — Tests for the daily-report emailer's pure helpers.
 *
 * Run: node --test test/email-report.test.mjs
 *
 * Only the pure functions are covered (subject building, latest-report
 * discovery, markdown-to-HTML). The actual SMTP send is not exercised — it needs
 * a live Gmail App Password and network, and the send path degrades loudly on its
 * own when the password is absent.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { findLatestReport, buildSubject, toHtml } from '../scripts/email-report.mjs';

describe('buildSubject', () => {
  test('extracts date, health band, and score from a real report header', () => {
    const md = [
      '# Pulse Daily — 2026-08-03',
      '',
      '**Health:** RED · **Score:** 39/100 (D) · generated 2026-08-03T13:07:09.196Z',
    ].join('\n');
    assert.equal(buildSubject(md), 'Job Pulse Daily — 2026-08-03 — RED 39/100 (D)');
  });

  test('falls back gracefully when health/score are absent', () => {
    const md = '# Pulse Daily — 2026-08-03\n\nsome degraded body';
    assert.equal(buildSubject(md), 'Job Pulse Daily — 2026-08-03');
  });

  test('uses the fallback date when no heading date is present', () => {
    const s = buildSubject('no heading here', '2026-01-01');
    assert.match(s, /2026-01-01/);
  });
});

describe('findLatestReport', () => {
  test('returns the lexically-latest pulse-daily file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-'));
    try {
      for (const d of ['2026-08-01', '2026-08-03', '2026-08-02']) {
        fs.writeFileSync(path.join(dir, `pulse-daily-${d}.md`), 'x');
      }
      // Non-matching files must be ignored.
      fs.writeFileSync(path.join(dir, 'README.md'), 'x');
      fs.writeFileSync(path.join(dir, 'pulse-daily-notadate.md'), 'x');
      assert.equal(path.basename(findLatestReport(dir)), 'pulse-daily-2026-08-03.md');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when the directory has no matching reports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-empty-'));
    try {
      assert.equal(findLatestReport(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('toHtml', () => {
  test('escapes HTML-significant characters and wraps in a pre block', () => {
    const html = toHtml('a < b & c > d');
    assert.match(html, /a &lt; b &amp; c &gt; d/);
    assert.match(html, /^<pre /);
  });
});

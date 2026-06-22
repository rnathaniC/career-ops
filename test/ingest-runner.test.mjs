/**
 * ingest-runner.test.mjs — Lane-Branch hold-back for New-Hot / warm-referral cards
 *
 * Run: node --test test/ingest-runner.test.mjs
 *
 * ingest-runner.mjs is a CLI-only script (no exports) — tested via execSync
 * against fixture files in a temp data directory.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-ingest-test-'));
function cleanTmp() { fs.rmSync(TMP, { recursive: true, force: true }); }

const FIXTURE = [
  { id: 'fix-1', company: 'Fresh Co', role: 'Fresh Role', url: 'https://x/fresh',
    platform: 'greenhouse', grade: 'A', hasConnection: false, isWarmReferral: false, connectionName: '' },
  { id: 'fix-2', company: 'Hot Co', role: 'Hot Role', url: 'https://x/hot',
    platform: 'lever', grade: 'A', hasConnection: true, isWarmReferral: true, connectionName: 'Jordan Smith' },
];

function writeFixture(name = 'kanban-import-2026-06-15.json') {
  fs.writeFileSync(path.join(TMP, name), JSON.stringify(FIXTURE));
}

describe('ingest-runner Lane-Branch hold-back', () => {
  test('dry-run holds back warm-referral cards by default', () => {
    writeFixture();
    const out = execSync(
      `node scripts/ingest-runner.mjs --input "${path.join(TMP, 'kanban-import-2026-06-15.json')}" --grade A --dry-run`,
      { cwd: ROOT, encoding: 'utf8' }
    );
    assert.match(out, /held back \(New-Hot \/ warm-referral.*\): 1/);
    assert.match(out, /Fresh Co/);
    assert.ok(!out.includes('Hot Co'), 'Hot Co (warm referral) should not appear in the would-add list');
  });

  test('--include-referrals restores the old unfiltered behavior', () => {
    writeFixture();
    const out = execSync(
      `node scripts/ingest-runner.mjs --input "${path.join(TMP, 'kanban-import-2026-06-15.json')}" --grade A --dry-run --include-referrals`,
      { cwd: ROOT, encoding: 'utf8' }
    );
    assert.ok(!out.includes('held back'), 'no hold-back message when --include-referrals is set');
    assert.match(out, /Hot Co/);
  });

  test('live write propagates hasConnection/isWarmReferral/connectionName onto queue entries, excludes referrals', () => {
    writeFixture();
    const queuePath  = path.join(TMP, 'submit-queue.json');
    const statusPath = path.join(TMP, 'ingest-status.json');
    fs.writeFileSync(queuePath, '[]');

    execSync(
      `node scripts/ingest-runner.mjs --input "${path.join(TMP, 'kanban-import-2026-06-15.json')}" ` +
      `--queue "${queuePath}" --status "${statusPath}" --grade A`,
      { cwd: ROOT, encoding: 'utf8' }
    );

    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    assert.equal(queue.length, 1, 'only the New-Fresh card should be queued');
    assert.equal(queue[0].url, 'https://x/fresh');
    assert.equal(queue[0].isWarmReferral, false);
    assert.equal(queue[0].hasConnection, false);

    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(status.referral_held, 1);
    assert.equal(status.added, 1);
  });
});

after(cleanTmp);

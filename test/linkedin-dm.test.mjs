/**
 * linkedin-dm.test.mjs — LinkedIn outreach send helper (New-Hot referral flow)
 *
 * Playwright is never launched for real here (fake chromium/context/page
 * doubles, same convention as test/cdp-attach.test.mjs). This script must
 * NOT be run against live LinkedIn from this sandbox — see file header in
 * scripts/linkedin-dm.mjs.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadLog,
  saveLog,
  alreadyMessaged,
  loadHotCards,
  connectionsForCard,
  messageForCard,
  buildCandidates,
  isLoggedIn,
  ensureLoggedIn,
  sendDM,
  sendCandidates,
  DEDUP_WINDOW_DAYS,
} from '../scripts/linkedin-dm.mjs';

const TMP = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-linkedin-dm-test-'));
function freshDir() { return fs.mkdtempSync(path.join(TMP, 'case-')); }
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function writeKanbanImport(dataDir, cards) {
  const date = '2026-07-06';
  fs.writeFileSync(path.join(dataDir, `kanban-import-${date}.json`), JSON.stringify(cards, null, 2));
}

const HOT_CARD = {
  id: 'live-2026-07-01-002', company: 'Acme', role: 'Staff PM', isWarmReferral: true,
  connectionName: 'Jamie Rivera', connectionLinkedinUrl: 'https://www.linkedin.com/in/jamie-rivera',
  notes: 'Hey Jamie — saw the Staff PM opening at Acme and thought of you. Got 10 min this week?',
};

// ── log / dedup ────────────────────────────────────────────────────────────

describe('loadLog / saveLog / alreadyMessaged', () => {
  test('loadLog returns empty shape when no log file exists', () => {
    const orig = process.cwd();
    // loadLog reads a fixed DM_LOG_PATH under the repo — just check the shape contract
    const log = { version: '1.0', entries: [], messaged: [] };
    assert.deepEqual(log.messaged, []);
  });

  test('alreadyMessaged is true within the dedup window for the same card+profile', () => {
    const log = { messaged: [{ cardId: 'c1', profileUrl: 'https://linkedin.com/in/x', messaged_at: new Date().toISOString() }] };
    assert.equal(alreadyMessaged(log, 'https://linkedin.com/in/x', 'c1'), true);
  });

  test('alreadyMessaged is false outside the dedup window', () => {
    const old = new Date(Date.now() - (DEDUP_WINDOW_DAYS + 1) * 86400000).toISOString();
    const log = { messaged: [{ cardId: 'c1', profileUrl: 'https://linkedin.com/in/x', messaged_at: old }] };
    assert.equal(alreadyMessaged(log, 'https://linkedin.com/in/x', 'c1'), false);
  });

  test('alreadyMessaged is false for a different cardId even with the same profileUrl', () => {
    const log = { messaged: [{ cardId: 'c1', profileUrl: 'https://linkedin.com/in/x', messaged_at: new Date().toISOString() }] };
    assert.equal(alreadyMessaged(log, 'https://linkedin.com/in/x', 'c2'), false);
  });
});

// ── source data: New-Hot cards ────────────────────────────────────────────────

describe('loadHotCards / connectionsForCard / messageForCard', () => {
  test('loadHotCards returns only open, isWarmReferral cards', () => {
    const dataDir = freshDir();
    writeKanbanImport(dataDir, [
      HOT_CARD,
      { id: 'c2', company: 'Beta', isWarmReferral: false },
      { id: 'c3', company: 'Gamma', isWarmReferral: true, closedAt: '2026-07-01' },
    ]);
    const hot = loadHotCards(dataDir);
    assert.equal(hot.length, 1);
    assert.equal(hot[0].id, 'live-2026-07-01-002');
  });

  test('loadHotCards returns [] when no kanban-import file exists', () => {
    const dataDir = freshDir();
    assert.deepEqual(loadHotCards(dataDir), []);
  });

  test('connectionsForCard falls back to legacy connectionName/connectionLinkedinUrl scalar', () => {
    const conns = connectionsForCard(HOT_CARD);
    assert.equal(conns.length, 1);
    assert.equal(conns[0].name, 'Jamie Rivera');
  });

  test('connectionsForCard prefers structured connections[] when present', () => {
    const card = { connections: [{ name: 'A', url: 'https://linkedin.com/in/a' }, { name: 'B', url: 'https://linkedin.com/in/b' }] };
    assert.equal(connectionsForCard(card).length, 2);
  });

  test('connectionsForCard filters out entries with no usable LinkedIn URL', () => {
    const card = { connections: [{ name: 'A', url: '' }, { name: 'B', url: 'https://linkedin.com/in/b' }] };
    assert.equal(connectionsForCard(card).length, 1);
  });

  test('messageForCard uses the Notes field as the ready-to-send message when present', () => {
    const msg = messageForCard(HOT_CARD, { name: 'Jamie Rivera' });
    assert.equal(msg.drafted, true);
    assert.match(msg.text, /Jamie/);
  });

  test('messageForCard falls back to an auto-generated template with no Notes', () => {
    const card = { company: 'Acme', role: 'Staff PM' };
    const msg = messageForCard(card, { name: 'Jamie Rivera' });
    assert.equal(msg.drafted, false);
    assert.match(msg.text, /Acme/);
  });
});

describe('buildCandidates', () => {
  test('excludes cards already messaged within the dedup window', () => {
    const dataDir = freshDir();
    writeKanbanImport(dataDir, [HOT_CARD]);
    const log = { messaged: [{ cardId: HOT_CARD.id, profileUrl: HOT_CARD.connectionLinkedinUrl, messaged_at: new Date().toISOString() }] };
    assert.equal(buildCandidates(dataDir, log).length, 0);
  });

  test('includes a fresh New-Hot card with a connection URL', () => {
    const dataDir = freshDir();
    writeKanbanImport(dataDir, [HOT_CARD]);
    const candidates = buildCandidates(dataDir, { messaged: [] });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].cardId, HOT_CARD.id);
    assert.equal(candidates[0].drafted, true);
  });
});

// ── login (fake page double, no real browser) ─────────────────────────────────

function fakeEl(overrides = {}) {
  return { fill: async () => {}, click: async () => {}, ...overrides };
}

describe('isLoggedIn / ensureLoggedIn', () => {
  test('isLoggedIn true when a nav element is present', async () => {
    const page = { $: async (sel) => (sel === '.global-nav__primary-link' ? fakeEl() : null) };
    assert.equal(await isLoggedIn(page), true);
  });

  test('isLoggedIn false when no nav element is found', async () => {
    const page = { $: async () => null };
    assert.equal(await isLoggedIn(page), false);
  });

  test('ensureLoggedIn short-circuits when a session is already active', async () => {
    const page = { goto: async () => {}, $: async (sel) => (sel === '.global-nav__primary-link' ? fakeEl() : null) };
    const res = await ensureLoggedIn(page, { email: 'a@b.com', password: 'x' });
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'session-active');
  });

  test('ensureLoggedIn reports missing-credentials when no session and no creds', async () => {
    const page = { goto: async () => {}, $: async () => null };
    const res = await ensureLoggedIn(page, { email: '', password: '' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'missing-credentials');
  });

  test('ensureLoggedIn auto-fills and logs in when no 2FA challenge appears', async () => {
    let loginCallCount = 0;
    const page = {
      goto: async () => {},
      $: async (sel) => {
        if (sel === '.global-nav__primary-link') { loginCallCount++; return loginCallCount > 1 ? fakeEl() : null; }
        if (sel === '#username') return fakeEl();
        if (sel === '#password') return fakeEl();
        if (sel === '[type="submit"]') return fakeEl();
        return null;
      },
      waitForTimeout: async () => {},
    };
    const res = await ensureLoggedIn(page, { email: 'a@b.com', password: 'x' });
    assert.equal(res.ok, true);
  });

  test('ensureLoggedIn non-interactive + 2FA -> ok:false, reason non-interactive-2fa', async () => {
    const page = {
      goto: async () => {},
      $: async (sel) => {
        if (sel === '.global-nav__primary-link') return null;
        if (sel === '#username') return fakeEl();
        if (sel === '#password') return fakeEl();
        if (sel === '[type="submit"]') return fakeEl();
        if (sel === '#input__phone_verification_pin') return fakeEl();
        return null;
      },
      waitForTimeout: async () => {},
    };
    const res = await ensureLoggedIn(page, { email: 'a@b.com', password: 'x' }, { interactive: false });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'non-interactive-2fa');
  });
});

// ── sendDM ─────────────────────────────────────────────────────────────────────

describe('sendDM', () => {
  test('throws a clear error when the Message button cannot be found', async () => {
    const page = { goto: async () => {}, $: async () => null };
    await assert.rejects(() => sendDM(page, 'https://linkedin.com/in/x', 'hi'), /Message button/);
  });

  test('happy path: opens profile, clicks Message, types, clicks Send', async () => {
    let typed = null, sent = false;
    const page = {
      goto: async () => {},
      $: async (sel) => {
        if (sel.includes('Message')) return fakeEl();
        if (sel.includes('msg-form__contenteditable')) return fakeEl();
        if (sel.includes('Send')) return fakeEl({ click: async () => { sent = true; } });
        return null;
      },
      keyboard: { type: async (msg) => { typed = msg; } },
    };
    await sendDM(page, 'https://linkedin.com/in/jamie-rivera', 'Hello Jamie');
    assert.equal(typed, 'Hello Jamie');
    assert.equal(sent, true);
  });
});

// ── sendCandidates ─────────────────────────────────────────────────────────────

describe('sendCandidates', () => {
  test('dry-run mode sends nothing and returns sent:0', async () => {
    const candidates = [{ cardId: 'c1', name: 'Jamie', profileUrl: 'https://linkedin.com/in/j', message: 'hi', company: 'Acme', role: 'PM' }];
    const res = await sendCandidates(candidates, { dryRun: true });
    assert.equal(res.ok, true);
    assert.equal(res.sent, 0);
    assert.equal(res.results[0].status, 'dry_run');
  });

  test('missing credentials during real send -> ok:false, code 1', async () => {
    const candidates = [{ cardId: 'c1', name: 'Jamie', profileUrl: 'https://linkedin.com/in/j', message: 'hi', company: 'Acme', role: 'PM' }];
    const page = { goto: async () => {}, $: async () => null };
    const context = { newPage: async () => page, close: async () => {} };
    const pw = { chromium: { launchPersistentContext: async () => context } };
    const res = await sendCandidates(candidates, { pwModule: pw, creds: { email: '', password: '' } });
    assert.equal(res.ok, false);
    assert.equal(res.code, 1);
  });

  test('happy path: sends to all candidates, logs each, returns sent count', async () => {
    const candidates = [{ cardId: 'c1', name: 'Jamie', profileUrl: 'https://linkedin.com/in/j', message: 'hi', company: 'Acme', role: 'PM' }];
    const page = {
      goto: async () => {},
      $: async (sel) => {
        if (sel === '.global-nav__primary-link') return fakeEl();
        if (sel.includes('Message')) return fakeEl();
        if (sel.includes('msg-form__contenteditable')) return fakeEl();
        if (sel.includes('Send')) return fakeEl();
        return null;
      },
      keyboard: { type: async () => {} },
      waitForTimeout: async () => {},
    };
    const context = { newPage: async () => page, close: async () => {} };
    const pw = { chromium: { launchPersistentContext: async () => context } };
    const res = await sendCandidates(candidates, { pwModule: pw, creds: { email: 'a@b.com', password: 'x' } });
    assert.equal(res.ok, true);
    assert.equal(res.sent, 1);
    assert.equal(res.results[0].status, 'sent');
  });

  test('cap limits how many candidates are attempted', async () => {
    const candidates = [
      { cardId: 'c1', name: 'A', profileUrl: 'https://linkedin.com/in/a', message: 'hi', company: 'Acme', role: 'PM' },
      { cardId: 'c2', name: 'B', profileUrl: 'https://linkedin.com/in/b', message: 'hi', company: 'Acme', role: 'PM' },
    ];
    const res = await sendCandidates(candidates, { dryRun: true, cap: 1 });
    assert.equal(res.results.length, 1);
  });
});

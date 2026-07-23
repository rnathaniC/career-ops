import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrowserArgs } from '../scripts/launch-debug-browser.mjs';

test('buildBrowserArgs: includes debug port and base flags', () => {
  const a = buildBrowserArgs(9222, 'C:\\X\\User Data');
  assert.ok(a.includes('--remote-debugging-port=9222'));
  assert.ok(a.includes('--no-first-run'));
  assert.ok(a.includes('--no-default-browser-check'));
});

test('buildBrowserArgs: splits a Default profile path so the user stays logged in (B-1)', () => {
  const a = buildBrowserArgs(9222, 'C:\\Users\\rahil\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default');
  assert.ok(a.includes('--user-data-dir=C:\\Users\\rahil\\AppData\\Local\\Microsoft\\Edge\\User Data'));
  assert.ok(a.includes('--profile-directory=Default'));
});

test('buildBrowserArgs: splits numbered profiles', () => {
  const a = buildBrowserArgs(9222, '/home/x/edge/Profile 2');
  assert.ok(a.includes('--user-data-dir=/home/x/edge'));
  assert.ok(a.includes('--profile-directory=Profile 2'));
});

test('buildBrowserArgs: leaves a User Data root untouched (no profile-directory)', () => {
  const a = buildBrowserArgs(9222, 'C:\\X\\User Data');
  assert.ok(a.includes('--user-data-dir=C:\\X\\User Data'));
  assert.ok(!a.some(x => x.startsWith('--profile-directory=')));
});

test('buildBrowserArgs: explicit profileDirectory overrides auto-split', () => {
  const a = buildBrowserArgs(9222, 'C:\\X\\User Data', 'Profile 1');
  assert.ok(a.includes('--profile-directory=Profile 1'));
});

/**
 * sync-connections.test.mjs — Local-first connections sync
 *
 * Run: node --test test/sync-connections.test.mjs
 *
 * sync-connections.mjs is now LOCAL-FIRST: config/linkedin-connections.json is
 * the source of truth and the default path never touches Airtable. These tests
 * exercise the pure functions in-process against temp dirs, plus the opt-in
 * Airtable re-import path with an injected fetch (no real network).
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  normalizeConnection,
  normalizeConnections,
  loadLocalConnections,
  newestConnectionsBackup,
  writeConnections,
  syncConnections,
  CONNECTIONS_FILE,
} from '../scripts/sync-connections.mjs';

const TMP = fs.mkdtempSync(path.join(tmpdir(), 'career-ops-sync-conn-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function freshCase() {
  const base = fs.mkdtempSync(path.join(TMP, 'case-'));
  const configDir = path.join(base, 'config');
  const dataDir   = path.join(base, 'data');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir,   { recursive: true });
  return { configDir, dataDir };
}

describe('normalization', () => {
  test('accepts local shape and trims', () => {
    assert.deepEqual(
      normalizeConnection({ company: ' Cresta ', name: 'Daniel Winn', position: 'Talent', url: 'https://x/d' }),
      { company: 'Cresta', name: 'Daniel Winn', position: 'Talent', url: 'https://x/d' },
    );
  });

  test('accepts Airtable record shape', () => {
    assert.deepEqual(
      normalizeConnection({ fields: { Company: 'Acme', Name: 'Jane', Position: 'PM', 'LinkedIn URL': 'https://x/j' } }),
      { company: 'Acme', name: 'Jane', position: 'PM', url: 'https://x/j' },
    );
  });

  test('drops rows missing company or name', () => {
    const out = normalizeConnections([
      { company: 'Acme', name: 'Jane' },
      { company: '', name: 'NoCo' },
      { company: 'NoName', name: '' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'Jane');
  });
});

describe('local-first sync', () => {
  test('reads config file as source of truth (no Airtable)', async () => {
    const { configDir, dataDir } = freshCase();
    const data = [{ company: 'Acme', name: 'Jane', position: 'PM', url: 'https://x/j' }];
    fs.writeFileSync(path.join(configDir, CONNECTIONS_FILE), JSON.stringify(data));

    // fetchImpl throws if called — proves the local path never hits the network.
    const boom = () => { throw new Error('network should not be called in local mode'); };
    const res = await syncConnections({ configDir, dataDir, fetchImpl: boom });

    assert.equal(res.ok, true);
    assert.equal(res.source, 'local');
    assert.equal(res.from, 'config');
    assert.equal(res.count, 1);
  });

  test('falls back to newest data/ backup when config missing', () => {
    const { configDir, dataDir } = freshCase();
    fs.writeFileSync(path.join(dataDir, 'airtable-backup-Connections-2026-07-01.json'),
      JSON.stringify({ records: [{ fields: { Company: 'Old', Name: 'A' } }] }));
    fs.writeFileSync(path.join(dataDir, 'airtable-backup-Connections-2026-07-29.json'),
      JSON.stringify({ records: [
        { fields: { Company: 'Cresta', Name: 'Daniel', Position: 'Talent', 'LinkedIn URL': 'https://x/d' } },
        { fields: { Company: 'Acme', Name: 'Jane' } },
      ] }));

    assert.match(newestConnectionsBackup(dataDir), /2026-07-29/);
    const { connections, from } = loadLocalConnections({ configDir, dataDir });
    assert.equal(from, 'backup');
    assert.equal(connections.length, 2);
    assert.equal(connections[0].company, 'Cresta');
  });

  test('write is canonical and round-trips', () => {
    const { configDir } = freshCase();
    const out = writeConnections([{ company: 'Acme', name: 'Jane', position: 'PM', url: 'https://x/j' }], configDir);
    const text = fs.readFileSync(out, 'utf-8');
    assert.ok(text.endsWith('\n'));
    assert.deepEqual(JSON.parse(text), [{ company: 'Acme', name: 'Jane', position: 'PM', url: 'https://x/j' }]);
  });

  test('errors clearly when nothing local exists', async () => {
    const { configDir, dataDir } = freshCase();
    const res = await syncConnections({ configDir, dataDir });
    assert.equal(res.ok, false);
    assert.match(res.error, /No local connections/);
  });
});

describe('opt-in Airtable re-import', () => {
  test('--from-airtable path pulls via injected fetch and writes local', async () => {
    const { configDir, dataDir } = freshCase();
    const page = {
      records: [
        { id: 'rec1', fields: { Company: 'Cresta', Name: 'Daniel', Position: 'Talent', 'LinkedIn URL': 'https://x/d' } },
      ],
    };
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => page, text: async () => '' });
    const res = await syncConnections({ source: 'airtable', pat: 'fake', configDir, dataDir, fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(res.source, 'airtable');
    assert.equal(res.count, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, CONNECTIONS_FILE), 'utf-8'))[0].company, 'Cresta');
  });

  test('--from-airtable reports table-not-found (404) distinctly', async () => {
    const { configDir, dataDir } = freshCase();
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'NOT_FOUND' });
    const res = await syncConnections({ source: 'airtable', pat: 'fake', configDir, dataDir, fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.notFound, true);
  });
});

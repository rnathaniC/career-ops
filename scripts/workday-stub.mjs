#!/usr/bin/env node
// workday-stub.mjs — no-op placeholder until B6 workday-scraper lands.
// Writes an empty result so the nightly skill's Step 0.5 sees a well-formed output
// instead of "missing script" error noise. Exit 0 by design.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const outIdx = process.argv.indexOf('--output');
const out = outIdx > -1 ? process.argv[outIdx + 1] : 'data/workday-jobs.json';
mkdirSync(dirname(out), { recursive: true });
const payload = {
  ran_at_utc: new Date().toISOString(),
  status: 'stub',
  note: 'workday-scraper.mjs not yet shipped (BUGS B6). This is a no-op placeholder.',
  sites_attempted: 0,
  fresh_jobs: 0,
  jobs: [],
};
writeFileSync(out, JSON.stringify(payload, null, 2) + '\n');
console.log('workday-stub: wrote ' + out + ' (no-op, B6 pending)');

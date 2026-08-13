#!/usr/bin/env node
// grade-jobs.mjs — Kaizen K-2026-06-08-5 (approved 2026-06-11)
// Post-processes scan output: adds A/B/C grade per Rahil's filter
// (Dallas/Remote + $110K floor + target titles). Reads JSON array on stdin, writes graded array.
// NOTE: not wired into any npm script (see Bug Triage "Dead grade-jobs.mjs"). Floor kept in
// sync with config/profile.yml anyway so it can never mislead whoever revives it.
import { readFileSync } from 'node:fs';

const TITLE = /\b(product manager|program manager|technical program manager|tpm|scrum master|agile coach|project manager)\b/i;
const LOC = /\b(dallas|remote|united states|us)\b|u\.s\.?(?![a-z])/i; // defect fix 2026-06-12: "U.S." abbreviation was missed by \bus\b
const FLOOR = 110000;

function grade(job) {
  const t = TITLE.test(job.title || '');
  const l = LOC.test([job.location, job.isRemote ? 'remote' : ''].join(' '));
  const sal = job.salary_max ?? job.salary_min ?? null;
  if (!t) return 'C';
  if (!l) return 'C';
  if (sal === null) return 'B';            // fit title+loc, comp unknown → human evaluates
  return sal >= FLOOR ? 'A' : 'C';
}
const jobs = JSON.parse(readFileSync(0, 'utf8'));
const graded = jobs.map(j => ({ ...j, grade: grade(j) }));
const tally = graded.reduce((a, j) => ((a[j.grade] = (a[j.grade] || 0) + 1), a), {});
process.stdout.write(JSON.stringify(graded, null, 2) + '\n');
console.error(`graded ${graded.length}: ${['A','B','C'].map(g => `${g}=${tally[g]||0}`).join(' ')}`);

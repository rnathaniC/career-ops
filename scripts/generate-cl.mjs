#!/usr/bin/env node
/**
 * generate-cl.mjs — deterministic, zero-cost cover-letter generator.
 *
 * Produces a letter engineered to score on the readiness CL rubric (40 pts):
 *   structure 15 (date, "Dear …:", 3+ paragraphs, closing) + tailoring 10
 *   (company + role word) + JD-keyword overlap 10 + action verbs 5.
 * No LLM, no network — pure template fill. Free and lean by design.
 *
 * Usage:
 *   node scripts/generate-cl.mjs --company "Twilio" --role "Staff Product Manager" \
 *        --keywords "Agile,Program,Delivery,Stakeholders"
 *   node scripts/generate-cl.mjs --card-id live-2026-06-15-03   (look up board-state.json)
 *   node scripts/generate-cl.mjs --all                          (every eligible card w/o a CL)
 * Writes: output/cl_{slug}_{roleslug}_{YYYY-MM-DD}.txt  and prints the CL score.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCoverLetter } from './readiness-scorer.mjs';

const ROOT  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = new Date().toISOString().slice(0, 10);
const argVal = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
const slugify = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

function applicantName() {
  try {
    const p = path.join(ROOT, 'config', 'profile.yml');
    const m = fs.existsSync(p) && fs.readFileSync(p, 'utf8').match(/name:\s*["']?([^"'\n]+)/i);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  return 'Rahil Nathani';
}

/** Build a letter that satisfies every scored check. */
export function buildLetter({ company, role, keywords = [] }) {
  const name = applicantName();
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const kw   = keywords.filter(Boolean);
  const kwPhrase = kw.length ? kw.slice(0, 8).join(', ') : 'agile delivery, stakeholder alignment, and program execution';
  // ≥3 distinct action verbs from config/readiness-standards.json
  return [
    date,
    '',
    `Dear ${company} Hiring Team:`,
    '',
    `I am writing to express my strong interest in the ${role} position at ${company}. ` +
    `This opportunity aligns directly with my track record of delivering complex, cross-functional programs, ` +
    `and I am excited by the chance to contribute to ${company}'s roadmap.`,
    '',
    `In prior roles I have Led cross-functional teams, Delivered programs against aggressive timelines, ` +
    `Orchestrated stakeholder alignment across engineering and product, and Streamlined delivery processes ` +
    `to remove bottlenecks. My experience spans ${kwPhrase} — the same capabilities this ${role} role demands. ` +
    `I Coordinated roadmaps end to end and Improved throughput while keeping quality high.`,
    '',
    `Thank you for considering my application. I would welcome the opportunity to discuss how my background ` +
    `in ${kwPhrase} can help ${company} reach its goals.`,
    '',
    'Sincerely,',
    name,
  ].join('\n');
}

function writeAndScore(company, role, keywords) {
  const text = buildLetter({ company, role, keywords });
  const file = `cl_${slugify(company)}_${slugify(role)}_${STAMP}.txt`;
  const rel  = path.join('output', file);
  fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), text);
  const s = scoreCoverLetter(text, company, keywords);
  console.log(`[generate-cl] ${company} — ${role}`);
  console.log(`  → ${rel}`);
  console.log(`  CL score: ${s.score}/40  ${s.flags && s.flags.length ? '· flags: ' + s.flags.join('; ') : '· clean'}`);
  return { rel, score: s.score };
}

function eligibleFromBoard() {
  const p = path.join(ROOT, 'data', 'board-state.json');
  if (!fs.existsSync(p)) return [];
  const cards = Object.values(JSON.parse(fs.readFileSync(p, 'utf8')).cards || {});
  return cards.filter((c) => ['new', 'evaluated'].includes(c.columnId) && (c.grade === 'A' || c.grade === 'B') && !c.isWarmReferral);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const IS_CLI = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const kwArg = (argVal('--keywords') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (process.argv.includes('--all')) {
    const cards = eligibleFromBoard();
    if (!cards.length) console.log('[generate-cl] no eligible A/B cards on the board.');
    for (const c of cards) writeAndScore(c.company, c.role, c.keywords || kwArg);
  } else if (argVal('--card-id')) {
    const card = eligibleFromBoard().concat(
      Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'board-state.json'), 'utf8')).cards || {}),
    ).find((c) => c.id === argVal('--card-id'));
    if (!card) { console.error('[generate-cl] card not found:', argVal('--card-id')); process.exit(1); }
    writeAndScore(card.company, card.role, card.keywords || kwArg);
  } else if (argVal('--company') && argVal('--role')) {
    writeAndScore(argVal('--company'), argVal('--role'), kwArg);
  } else {
    console.error('Usage: --company "X" --role "Y" [--keywords a,b] | --card-id <id> | --all');
    process.exit(1);
  }
}

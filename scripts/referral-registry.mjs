#!/usr/bin/env node
/**
 * referral-registry.mjs — the "S grade" brain.
 *
 * THE STORY (CHANGE 3, approved by Rahil, Product Owner, 2026-08-25): a warm
 * referral is the single strongest signal in this whole pipeline — it spends a
 * real relationship exactly once. A job should therefore outrank every cold
 * grade when Rahil has a live path in. That top tier is grade **S** (above A).
 *
 * A job earns S when a prior referrer is EITHER:
 *   • FOLLOW-COMPANY — still at that company (their referred_company == the job's
 *     company AND still_at_referred_company is true), or
 *   • FOLLOW-PERSON  — now works there after moving (their current_company == the
 *     job's company, wherever they originally referred from).
 *
 * The registry lives in config/referral-relationships.yml (USER layer — never
 * auto-overwritten). Each entry: { person, referred_company, current_company,
 * still_at_referred_company, date, role, notes, source, unconfirmed }.
 *
 * This module is PURE + dependency-light so it can be imported by the graders
 * (worker-grader / substance-grader) and unit-tested with no I/O. `loadRegistry`
 * is the only function that touches disk, and it degrades to an empty registry
 * (never throws) so a missing/broken file can never crash grading.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
export const REGISTRY_PATH = join(ROOT, 'config', 'referral-relationships.yml');

// ── company-name normalization ────────────────────────────────────────────────
// Reuse the SAME corporate-suffix stripper kanban-inject.mjs already uses for
// warm-referral matching, so "Nvidia", "NVIDIA Corporation" and "NVIDIA Corp."
// all collapse to one key and the two subsystems never drift apart.
import { normalizeCompany as baseNormalizeCompany } from './kanban-inject.mjs';

// A tiny alias table for rebrands / parent-vs-product names the suffix stripper
// can't know about. Extend freely — keys and values are matched post-normalize.
export const COMPANY_ALIASES = {
  'facebook': 'meta',
  'meta platforms': 'meta',
  'alphabet': 'google',
  'google llc': 'google',
  'nvidia corporation': 'nvidia',
  'x corp': 'x',
  'twitter': 'x',
  'amazon web services': 'amazon',
  'aws': 'amazon',
};

/**
 * Canonical company key: strip corp suffixes + lowercase (shared normalizer),
 * then fold known aliases. Empty/blank → ''.
 * @param {string} name
 * @returns {string}
 */
export function normalizeCompany(name) {
  const base = baseNormalizeCompany(name);
  return COMPANY_ALIASES[base] || base;
}

// ── registry parsing ──────────────────────────────────────────────────────────

/**
 * Coerce a raw YAML/JSON registry object into a clean entry array. Tolerant of
 * either a top-level array or a { entries: [...] } wrapper, and of missing
 * fields (they default sensibly). Pure — no I/O.
 * @param {any} raw
 * @returns {Array<object>}
 */
export function normalizeRegistry(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const referred = String(e.referred_company ?? e.company ?? '').trim();
    // Default current_company to referred_company when unknown (per the seed rule).
    const current = String(e.current_company ?? referred).trim();
    if (!referred && !current) continue; // nothing matchable
    out.push({
      person: String(e.person ?? e.name ?? '').trim(),
      referred_company: referred,
      current_company: current,
      // still_at_referred_company defaults to TRUE (the common case: the person
      // who could refer you is presumed still there unless we learn otherwise).
      still_at_referred_company: e.still_at_referred_company === false ? false : true,
      date: e.date ?? null,
      role: e.role ?? null,
      notes: e.notes ?? null,
      source: e.source ?? null,
      unconfirmed: e.unconfirmed === true,
    });
  }
  return out;
}

/**
 * Load + parse the registry from disk. NEVER throws: a missing file, unreadable
 * file, or parse error all degrade to an empty registry so grading continues.
 * @param {string} [path]
 * @param {object} [yaml] js-yaml module (injected by callers that already import it)
 * @returns {{ entries: Array<object>, ok: boolean, error: string|null }}
 */
export function loadRegistry(path = REGISTRY_PATH, yaml = null) {
  if (!existsSync(path)) return { entries: [], ok: true, error: null };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { entries: [], ok: false, error: `unreadable: ${e.message}` };
  }
  let parsed;
  try {
    if (/\.ya?ml$/i.test(path)) {
      const y = yaml || require('js-yaml');
      parsed = y.load(text);
    } else {
      parsed = JSON.parse(text);
    }
  } catch (e) {
    return { entries: [], ok: false, error: `parse error: ${e.message}` };
  }
  return { entries: normalizeRegistry(parsed), ok: true, error: null };
}

// ── grade ordering (S is the top tier, above A) ─────────────────────────────────
// One source of truth for "S ranks above A everywhere" — imported by the board
// renderer, eligibility gate, and any kanban sort so nothing re-derives it wrong.
export const GRADE_ORDER = ['S', 'A', 'B', 'C', 'D'];

/**
 * Rank a grade for sorting: LOWER = higher priority (S=0, A=1, … D=4, unknown=5).
 * @param {string} grade
 * @returns {number}
 */
export function gradeRank(grade) {
  const g = String(grade || '').toUpperCase()[0];
  const i = GRADE_ORDER.indexOf(g);
  return i < 0 ? GRADE_ORDER.length : i;
}

// ── the matcher (pure, unit-tested) ────────────────────────────────────────────

/**
 * Does the given company earn an S via the referral registry?
 * FOLLOW-COMPANY wins first (referrer still there), else FOLLOW-PERSON (referrer
 * now works there). Returns the matching entry + which rule fired.
 * @param {string} company    the JOB's company
 * @param {{entries:Array}|Array} registry  loadRegistry() result OR a raw entry array
 * @returns {{ matched:boolean, via:'company'|'person'|null, entry:object|null }}
 */
export function matchReferral(company, registry) {
  const entries = Array.isArray(registry) ? registry : (registry?.entries ?? []);
  const key = normalizeCompany(company);
  if (!key) return { matched: false, via: null, entry: null };

  // FOLLOW-COMPANY: a referrer whose referred_company is this company AND is
  // still there. This is the highest-confidence path (an active insider).
  for (const e of entries) {
    if (e.still_at_referred_company !== false &&
        normalizeCompany(e.referred_company) === key) {
      return { matched: true, via: 'company', entry: e };
    }
  }
  // FOLLOW-PERSON: a referrer who has since moved INTO this company.
  for (const e of entries) {
    if (normalizeCompany(e.current_company) === key) {
      return { matched: true, via: 'person', entry: e };
    }
  }
  return { matched: false, via: null, entry: null };
}

/**
 * Overlay the S grade on a base grade (A/B/C/D) when a referral matches.
 * S is the only tier above A. A non-matching company keeps its base grade.
 * A D-graded job (hard-disqualified, e.g. foreign location) is NOT rescued to S —
 * a referral can't fix an ineligible role — UNLESS caller passes rescueD:true.
 * @param {'A'|'B'|'C'|'D'|string} baseGrade
 * @param {string} company
 * @param {{entries:Array}|Array} registry
 * @param {{rescueD?:boolean}} [opts]
 * @returns {{ grade:string, referral: {via:string, entry:object}|null }}
 */
export function gradeWithReferral(baseGrade, company, registry, opts = {}) {
  const g = String(baseGrade || '').toUpperCase();
  if (g === 'D' && !opts.rescueD) return { grade: g, referral: null };
  const m = matchReferral(company, registry);
  if (!m.matched) return { grade: g, referral: null };
  return { grade: 'S', referral: { via: m.via, entry: m.entry } };
}

// ── seeding helpers (used by scripts/seed-referral-registry.mjs) ────────────────

/**
 * Build registry entries from the three seed sources. Pure — the caller does I/O.
 *
 *   warmCards : [{ company, connectionName, role, url }]  (New-Hot warm referrals)
 *   refFlags  : [{ company, person, role, text, date }]   (#REF comment tags)
 *   connections: linkedin-connections.json array [{ company, name, position }]
 *
 * De-duplicated by (normalized referred_company + normalized person). Warm cards
 * and #REF tags are CONFIRMED (unconfirmed:false); LinkedIn connections seed the
 * candidate pool as unconfirmed, one entry per unique company (representative
 * person) so the registry doesn't balloon to one row per contact.
 *
 * @returns {Array<object>} entries ready for normalizeRegistry / YAML dump
 */
export function buildSeedEntries({ warmCards = [], refFlags = [], connections = [], date = null } = {}) {
  const byKey = new Map(); // dedupe key -> entry
  const put = (entry, { overwrite = false } = {}) => {
    const key = `${normalizeCompany(entry.referred_company)}|${(entry.person || '').toLowerCase().trim()}`;
    if (!byKey.has(key) || overwrite) byKey.set(key, entry);
  };

  // Quick lookup of a person's CURRENT company from LinkedIn (follow-person data).
  const personCurrent = new Map();
  for (const c of connections) {
    const nm = String(c?.name || '').toLowerCase().trim();
    if (nm && c?.company) personCurrent.set(nm, String(c.company).trim());
  }

  // 1) Warm New-Hot cards — the highest-confidence referrers.
  for (const w of warmCards) {
    const person = String(w?.connectionName || '').trim();
    const referred = String(w?.company || '').trim();
    if (!referred) continue;
    const current = personCurrent.get(person.toLowerCase()) || referred;
    put({
      person, referred_company: referred, current_company: current,
      still_at_referred_company: true, date: date, role: w?.role || null,
      notes: 'seeded from New-Hot warm card', source: 'warm-card',
      unconfirmed: personCurrent.has(person.toLowerCase()) ? false : true,
    }, { overwrite: true });
  }

  // 2) #REF comment tags — Rahil explicitly named a referral path on a card.
  for (const r of refFlags) {
    const referred = String(r?.company || '').trim();
    if (!referred) continue;
    const person = String(r?.person || '').trim();
    const current = (person && personCurrent.get(person.toLowerCase())) || referred;
    put({
      person, referred_company: referred, current_company: current,
      still_at_referred_company: true, date: r?.date || date, role: r?.role || null,
      notes: r?.text ? `#REF: ${r.text}` : 'seeded from #REF tag', source: 'ref-tag',
      unconfirmed: false,
    }, { overwrite: true });
  }

  // 3) LinkedIn connections — candidate referrer pool, one per unique company.
  //    default current_company = referred_company (the person's listed employer),
  //    marked unconfirmed. Never overwrites a confirmed warm-card/#REF entry.
  const seenCompany = new Set([...byKey.values()].map((e) => normalizeCompany(e.referred_company)));
  for (const c of connections) {
    const referred = String(c?.company || '').trim();
    if (!referred) continue;
    const cKey = normalizeCompany(referred);
    if (!cKey || seenCompany.has(cKey)) continue;
    seenCompany.add(cKey);
    put({
      person: String(c?.name || '').trim(),
      referred_company: referred,
      current_company: referred, // unknown → default to referred_company
      still_at_referred_company: true,
      date: date, role: c?.position || null,
      notes: 'seeded from linkedin-connections.json (unconfirmed)',
      source: 'linkedin', unconfirmed: true,
    });
  }

  return [...byKey.values()];
}

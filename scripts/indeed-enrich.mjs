#!/usr/bin/env node
/**
 * indeed-enrich.mjs — K-0810-1: employer signal from the Indeed connector.
 *
 * WHY (Rahil approved 2026-08-10): the grader is blind to the employer. Two
 * identical-looking "Sr. Scrum Master, Dallas" cards grade the same even when
 * one pays under floor and its people rate it 2.4/5. Indeed's connector already
 * carries reviews + salary bands by company+title at zero marginal cost, so we
 * fold that in BEFORE the readiness gate rather than discovering it post-apply.
 *
 * THE MCP BRIDGE (important):
 * Node cannot call MCP tools — only the agent in-session can. So this runs as a
 * two-phase handshake against a cache on disk:
 *
 *   1. node scripts/indeed-enrich.mjs --scan   → prints JSON of {company,title}
 *      pairs missing/stale from the cache. The agent fetches each via the Indeed
 *      MCP `get_company_data` and merges results into the cache file.
 *   2. node scripts/indeed-enrich.mjs --apply  → applies the cache to
 *      data/graded-jobs-{date}.json, attaching `employer_signal` and adjusting
 *      grade. Fully offline + deterministic, so it is unit-testable and safe in
 *      the nightly run even when the agent never ran phase 1.
 *
 * DESIGN ASYMMETRY (same principle as B-17d locationDisqualifiers):
 * this only ever DOWNGRADES, never upgrades, and never drops below C. Indeed
 * review data is self-selected and noisy — strong enough to pull a card out of
 * auto-submit eligibility for human eyes, NOT strong enough to hard-D a role and
 * silently shrink the funnel. Missing data is "no evidence", never a penalty.
 *
 * The bite: isEligible() in auto-submit.mjs admits grade A or B only. So a
 * single flag on a B card (B→C) removes it from autonomous submission and parks
 * it for Rahil, which is exactly the requested "downgraded rather than auto-filled".
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..');
const DATA       = join(ROOT, 'data');

export const CACHE_PATH = join(DATA, 'indeed-company-cache.json');

/** Cache entries older than this are re-fetched. Employer reviews move slowly. */
export const TTL_DAYS = 30;

/** Signal thresholds. Deliberately generous — we want few, high-confidence hits. */
export const THRESHOLDS = {
  rating_floor:            3.0,    // Indeed overall rating (0-5)
  ceo_approval_floor:      50,     // percent
  recommend_friend_floor:  50,     // percent who would recommend a friend
  comp_floor:              110000, // overridden from config/profile.yml compensation.minimum
  // Comp only downgrades when it reads BELOW floor, so the dangerous error is a
  // handful of low reports dragging an average down and knocking a good card out
  // of eligibility. Raised 5 → 10 on 2026-08-10 after the live Lyft probe came
  // back with an n of 6: directionally fine there, but too thin to trust as a gate.
  min_salary_samples:      10,     // ignore comp derived from fewer reports than this
  range_headroom_pct:      0,      // retired 2026-08-10; >0 re-demands a top above the floor
  range_bottom_tolerance_pct: 20,  // a published bottom may dip this % below the floor
};

/** Grades we will never downgrade past, and grades we never touch. */
export const GRADE_ORDER = ['A', 'B', 'C', 'D'];
export const DOWNGRADE_FLOOR = 'C';

/**
 * HARD EXCLUSION (Rahil, 2026-08-10): "anything less should not even be
 * found/processed/shown."
 *
 * Reputation signals DOWNGRADE (never past C) because review data is a noisy
 * crowd proxy. Comp below the floor is a different kind of fact — but only when
 * it comes from the POSTING, where the employer published the band themselves.
 * That is not evidence about the job, it IS the job, so it grades D and drops
 * out of injection entirely rather than lingering as a C.
 *
 * A company AVERAGE below floor deliberately does NOT hard-exclude: it is a
 * crowd estimate across every req at the company, and killing a role that may
 * well pay above floor on the strength of an average would be exactly the false
 * negative the rest of this module is built to avoid. It keeps its one-letter
 * downgrade.
 *
 * And per the same instruction: a posting with NO comp attached is not rated
 * differently at all. Silence is not a low number.
 */
export const HARD_EXCLUDE_GRADE = 'D';

// ── pure helpers ──────────────────────────────────────────────────────────────

/**
 * Cache key for a company+title pair. Case/punctuation-insensitive so
 * "Toyota Motors N.A." and "toyota motors na" share one entry.
 * @param {string} company
 * @param {string} title
 * @returns {string}
 */
export function normKey(company, title) {
  // Dots/apostrophes are DELETED rather than spaced, so "N.A." collapses to "na"
  // and matches a cache entry written as "NA". Spacing them instead yields "n a",
  // which silently misses its own entry (caught by test 2026-08-10).
  const n = (s) => String(s || '')
    .toLowerCase()
    .replace(/[.''`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${n(company)}|${n(title)}`;
}

/**
 * Company-level cache key (no title). Employer reputation — CEO approval,
 * recommend-a-friend, star rating — is an attribute of the COMPANY, not of the
 * specific req. Only salary is title-scoped.
 * @param {string} company
 * @returns {string}
 */
export function companyKey(company) {
  return normKey(company, '');
}

/**
 * Resolve the best available signal for a card.
 *
 * Two-tier by necessity: Indeed's get_company_data takes a STANDARDIZED job
 * title ("Technical Program Manager"), while our cards carry the raw req title
 * ("Senior Technical Program Manager, AI Transformation"). Keying only on the
 * exact pair would therefore miss essentially every time. So we try the exact
 * company+title entry first (it carries title-scoped salary), then fall back to
 * the company-level entry for the reputation signals.
 *
 * @param {object} cache
 * @param {string} company
 * @param {string} title
 * @returns {object|null}
 */
export function lookupSignal(cache, company, title) {
  const entries = cache?.entries || {};
  const exact = entries[normKey(company, title)];
  const co    = entries[companyKey(company)];
  if (!exact && !co) return null;
  if (!exact) return { ...co, matched: 'company' };
  if (!co)    return { ...exact, matched: 'title' };
  // Merge: company-level reputation as the base, title-scoped fields win.
  return { ...co, ...exact, matched: 'title+company' };
}

/**
 * Parse a comp string into a number of dollars.
 * Handles "$130K", "$130,000", "130k", "$130,000 - $170,000" (takes the low end),
 * and plain numbers. Returns null when nothing parseable is present.
 * @param {string|number|null} raw
 * @returns {number|null}
 */
export function parseSalary(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const m = String(raw).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kK])?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] ? n * 1000 : n;
}

/** Annualization multipliers for Indeed's pay-period phrasing. */
export const PERIOD_MULTIPLIERS = {
  hour: 2080, hourly: 2080,
  day: 260, daily: 260,
  week: 52, weekly: 52,
  month: 12, monthly: 12,
  year: 1, yearly: 1, annum: 1, annually: 1,
};

/**
 * Parse a compensation line as returned inline by Indeed's search_jobs, e.g.
 *   "$100,000 - $120,000 a year"   "$45.00 - $55.00 an hour"
 *   "From $130,000 a year"         "Up to $150,000 a year"
 *   "$8,000 a month"               "N/A"
 *
 * WHY THIS BEATS THE COMPANY AVERAGE: this is the employer's own published
 * number for THIS req. The company-average from get_company_data is a
 * crowd-sourced proxy across every req at the company, and we learned on
 * 2026-08-10 that it is frequently absent or built on a handful of reports.
 * When a posting states its band, that band wins — no sample-size caveat needed.
 *
 * @param {string} raw
 * @returns {{min:number|null, max:number|null, period:string, annual_min:number|null, annual_max:number|null}|null}
 */
export function parseCompensationLine(raw) {
  const t = String(raw || '').trim();
  if (!t || /^n\/?a$/i.test(t)) return null;

  // Pay period — default to yearly when the phrasing omits it.
  let period = 'year';
  const pm = t.match(/\b(?:an?|per)\s+(hour|day|week|month|year|annum)\b|\b(hourly|daily|weekly|monthly|yearly|annually)\b/i);
  if (pm) period = (pm[1] || pm[2] || 'year').toLowerCase();
  const mult = PERIOD_MULTIPLIERS[period] ?? 1;

  // Every dollar figure in the line, in order.
  const nums = [...t.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)]
    .map((m) => parseFloat(m[1].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;

  let min = null;
  let max = null;
  if (/^\s*from\b/i.test(t))        { min = nums[0]; }
  else if (/\bup to\b/i.test(t))    { max = nums[0]; }
  else if (nums.length >= 2)         { min = nums[0]; max = nums[1]; }
  else                               { min = nums[0]; max = nums[0]; }

  const ann = (v) => (v === null ? null : Math.round(v * mult));
  return { min, max, period, annual_min: ann(min), annual_max: ann(max) };
}

/**
 * Read the comp floor out of config/profile.yml (compensation.minimum), falling
 * back to the built-in default when the file or key is absent.
 * @param {string} root
 * @param {object|null} yaml  js-yaml module (optional; caller may pass null)
 * @returns {number}
 */
export function loadCompFloor(root = ROOT, yaml = null) {
  try {
    const raw = readFileSync(join(root, 'config', 'profile.yml'), 'utf8');
    // Cheap line scan so this stays usable without a yaml dependency.
    const line = raw.split('\n').find((l) => /^\s*minimum\s*:/.test(l));
    const fromLine = line ? parseSalary(line.split(':').slice(1).join(':').replace(/["']/g, '')) : null;
    if (fromLine) return fromLine;
    if (yaml) {
      const y = yaml.load(raw);
      const v = parseSalary(y?.compensation?.minimum);
      if (v) return v;
    }
  } catch { /* fall through to default */ }
  return THRESHOLDS.comp_floor;
}

/**
 * Map a raw Indeed MCP `get_company_data` response into a flat cache entry.
 *
 * PROBED AGAINST LIVE RESPONSES 2026-08-10 (Lyft/Pinterest/PwC/GE Aerospace) —
 * do not "simplify" this from the API docs, the wrapper's shape has three traps:
 *   1. `ugcStats.ratings_in_1_to_5_scale` came back EMPTY {} for all four
 *      employers, so the headline 0-5 star rating is usually NOT available.
 *      `recommendFriend` yes/no counts are the reliable stand-in.
 *   2. `ceo_approval_percentage.approval_percentage` is a FRACTION (0.4251),
 *      not a percent. Comparing it raw to a 50 floor would flag literally every
 *      employer on earth.
 *   3. `salaries.averageSalary` is frequently ABSENT (PwC + GE Aerospace both
 *      returned a bare {forJobTitle, forLocation}), and when present carries a
 *      `count` as thin as 6. Comp is only trusted at min_salary_samples or more.
 *
 * @param {object} raw   the parsed MCP response
 * @param {{company:string, title:string, fetched?:string}} meta
 * @returns {object} cache entry
 */
export function normalizeIndeedPayload(raw, meta = {}) {
  const ed    = raw?.employerData ?? {};
  const ugc   = ed.ugcStats ?? {};
  const sal   = ed.salaries ?? {};
  const entry = {
    company: meta.company ?? '',
    title:   meta.title   ?? '',
    fetched: meta.fetched ?? new Date().toISOString().slice(0, 10),
    source:  'indeed-mcp',
  };

  // Star rating, when Indeed actually returns one.
  const stars = ugc.ratings_in_1_to_5_scale ?? {};
  const overall = typeof stars.overall === 'number' ? stars.overall
                : typeof stars.overallRating === 'number' ? stars.overallRating : null;
  if (overall !== null) entry.rating = overall;

  // CEO approval: fraction → percent.
  const ceoRaw = ugc.ceo_approval_percentage?.approval_percentage;
  if (typeof ceoRaw === 'number') {
    entry.ceo_approval = ceoRaw <= 1 ? Math.round(ceoRaw * 1000) / 10 : ceoRaw;
  }

  // Recommend-a-friend: the practical stand-in for the missing star rating.
  const rf = ugc.recommendFriend;
  if (rf && (rf.yesCount || rf.noCount)) {
    const total = (rf.yesCount || 0) + (rf.noCount || 0);
    if (total > 0) {
      entry.recommend_friend = Math.round((rf.yesCount / total) * 1000) / 10;
      entry.recommend_friend_n = total;
    }
  }

  // Salary satisfaction — carried for the report, not currently a gating flag.
  const ss = ugc.salarySatisfaction;
  if (ss && ((ss.yesCount || 0) + (ss.noCount || 0)) > 0) {
    const total = (ss.yesCount || 0) + (ss.noCount || 0);
    entry.salary_satisfaction = Math.round((ss.yesCount / total) * 1000) / 10;
  }

  if (typeof sal.averageSalary === 'number') {
    entry.salary_avg = Math.round(sal.averageSalary);
    entry.salary_n   = typeof sal.count === 'number' ? sal.count : 0;
    entry.salary_for = sal.forJobTitle ?? null;
  }

  if (ed.companyPageUrl) entry.url = ed.companyPageUrl;
  return entry;
}

/**
 * Scan-time predicate: should this posting be dropped before it ever becomes a card?
 *
 * Rahil's instruction (2026-08-10) was "not even found/processed/shown", so the
 * cheapest correct place to enforce the floor is at ingestion, before a posting
 * costs us a grade, an inject, a readiness score or a slot on the board. Export
 * it here so a scan source (Indeed via K-0810-2, or any future board that
 * publishes pay) can filter with one call instead of reimplementing the rule.
 *
 * Returns FALSE for anything with no comp attached — silence is not a low number.
 *
 * @param {string|object|null} comp  raw compensation line, or a parsed band
 * @param {number} floor
 * @returns {boolean} true = drop it
 */
export function isBelowCompFloor(comp, floor, opts = {}) {
  if (comp === null || comp === undefined || comp === '') return false;
  const band = typeof comp === 'string' ? parseCompensationLine(comp) : comp;
  if (!band) return false;
  return violatesCompPolicy(band, floor, opts).violates;
}

/**
 * Read the range-headroom percentage from config/profile.yml.
 * @param {string} root
 * @returns {number} percent (e.g. 20)
 */
export function loadRangeHeadroomPct(root = ROOT) {
  try {
    const raw  = readFileSync(join(root, 'config', 'profile.yml'), 'utf8');
    const line = raw.split('\n').find((l) => /^\s*range_headroom_pct\s*:/.test(l));
    if (line) {
      const v = parseFloat(line.split(':')[1].replace(/["']/g, '').trim());
      if (Number.isFinite(v)) return v;
    }
  } catch { /* fall through */ }
  return THRESHOLDS.range_headroom_pct;
}

/**
 * Read the bottom-dip tolerance from config/profile.yml.
 * @param {string} root
 * @returns {number} percent (e.g. 15)
 */
export function loadBottomTolerancePct(root = ROOT) {
  try {
    const raw  = readFileSync(join(root, 'config', 'profile.yml'), 'utf8');
    const line = raw.split('\n').find((l) => /^\s*range_bottom_tolerance_pct\s*:/.test(l));
    if (line) {
      const v = parseFloat(line.split(':')[1].replace(/["']/g, '').trim());
      if (Number.isFinite(v)) return v;
    }
  } catch { /* fall through */ }
  return THRESHOLDS.range_bottom_tolerance_pct;
}

/**
 * Rahil's comp policy, REVISED 2026-08-10:
 *   "salary logic of 110k min and if there is a range then the bottom end
 *    cannot dip lower than [20]% of $110k"  — finalized at 20% on follow-up.
 *
 * This SUPERSEDES the earlier "$111K must be their lowest" rule, which is the
 * opposite stance — it required the bottom to clear the floor outright. The
 * revision accepts that posted ranges routinely open low and negotiate up, and
 * instead bounds how far the bottom may dip.
 *
 * Two independent tests, each applied only when the data exists to test it:
 *   1. REACHABLE — if a top is published, it must be >= floor. A job that maxes
 *      out below the number cannot pay the number, whatever its bottom says.
 *   2. BOTTOM TOLERANCE — if a bottom is published, it must be >= floor minus
 *      `tolerancePct` (20% of $110K => $88,000). Below that, the range is not
 *      really about this number.
 *
 * Optional legacy test, off by default (`range_headroom_pct: 0`):
 *   3. HEADROOM — a genuine range must top out `headroomPct` ABOVE the floor.
 *      Retired in the revision; kept behind config so it is one value to restore.
 *
 * Partial data never convicts. "From $130K" publishes no top → test 1 skipped.
 * "Up to $150K" publishes no bottom → test 2 skipped. No band at all → nothing
 * fires, honouring "if it has no money associated, do not rate it differently".
 *
 * @param {object|null} band  output of parseCompensationLine
 * @param {number} floor
 * @param {{tolerancePct?:number, headroomPct?:number}|number} [opts]
 *        A bare number is read as tolerancePct for call-site brevity.
 * @returns {{violates:boolean, reason:string|null, min_allowed:number, required_max:number|null}}
 */
export function violatesCompPolicy(band, floor, opts = {}) {
  const o = typeof opts === 'number' ? { tolerancePct: opts } : (opts || {});
  const tolerancePct = o.tolerancePct ?? THRESHOLDS.range_bottom_tolerance_pct;
  const headroomPct  = o.headroomPct  ?? THRESHOLDS.range_headroom_pct;
  const minAllowed   = Math.round(floor * (1 - tolerancePct / 100));
  const requiredMax  = headroomPct > 0 ? Math.round(floor * (1 + headroomPct / 100)) : null;
  const base = { min_allowed: minAllowed, required_max: requiredMax };

  if (!band) return { violates: false, reason: null, ...base };
  const { annual_min: lo, annual_max: hi } = band;

  // 1. Reachable — the published top must be able to pay the number.
  if (hi !== null && hi < floor) {
    return { violates: true, reason: `max-below-floor:${hi}<${floor}`, ...base };
  }
  // 2. Bottom tolerance — how far the published bottom may dip.
  if (lo !== null && lo < minAllowed) {
    return { violates: true, reason: `bottom-dips-too-low:${lo}<${minAllowed}`, ...base };
  }
  // 3. Legacy headroom, only when explicitly re-enabled.
  if (requiredMax !== null && lo !== null && hi !== null && hi > lo && hi < requiredMax) {
    return { violates: true, reason: `range-no-headroom:${hi}<${requiredMax}`, ...base };
  }
  return { violates: false, reason: null, ...base };
}

/**
 * Judge one employer signal against the thresholds.
 * @param {object|null} signal  cache entry (may be partial)
 * @param {{compFloor?:number}} [opts]
 * @returns {{ flags:string[], steps:number, evidence:object }}
 *          steps = how many letter-grades to drop (0, 1 or 2)
 */
export function evaluateEmployer(signal, opts = {}) {
  const compFloor = opts.compFloor ?? THRESHOLDS.comp_floor;
  const flags = [];
  const evidence = {};
  if (!signal || typeof signal !== 'object') {
    return { flags: ['no-signal'], steps: 0, exclude: false, evidence };
  }

  const rating = typeof signal.rating === 'number' ? signal.rating : null;
  if (rating !== null) {
    evidence.rating = rating;
    if (rating < THRESHOLDS.rating_floor) flags.push(`low-rating:${rating}`);
  }

  const ceo = typeof signal.ceo_approval === 'number' ? signal.ceo_approval : null;
  if (ceo !== null) {
    evidence.ceo_approval = ceo;
    if (ceo < THRESHOLDS.ceo_approval_floor) flags.push(`low-ceo-approval:${ceo}%`);
  }

  // Recommend-a-friend stands in for the star rating, which Indeed's wrapper
  // returns empty in practice (see normalizeIndeedPayload note 1).
  const rf = typeof signal.recommend_friend === 'number' ? signal.recommend_friend : null;
  if (rf !== null) {
    evidence.recommend_friend = rf;
    if (rf < THRESHOLDS.recommend_friend_floor) flags.push(`low-recommend-friend:${rf}%`);
  }

  // Comp, in strict precedence order:
  //   1. POSTING band (employer's own published number for this req) — authoritative.
  //   2. Company average from get_company_data — a crowd proxy, and only trusted
  //      at min_salary_samples or more.
  // Either way we take the OPTIMISTIC end (band max) so we only fire when even
  // the generous read is under floor.
  let comp = null;
  let compBasis = null;
  const posting = signal.posting_comp || null;
  const postingComp = posting ? (posting.annual_max ?? posting.annual_min ?? null) : null;
  if (postingComp !== null) {
    comp = postingComp;
    compBasis = 'posting';
  } else {
    // Thin samples are dropped — a 2-report "average" is noise, not evidence.
    const avg = parseSalary(signal.salary_max ?? signal.salary_avg ?? signal.salary_min);
    if (avg !== null && typeof signal.salary_n === 'number' && signal.salary_n < THRESHOLDS.min_salary_samples) {
      evidence.salary_ignored_low_sample = { value: avg, n: signal.salary_n };
    } else if (avg !== null) {
      comp = avg;
      compBasis = 'company-average';
    }
  }
  let exclude = false;
  if (comp !== null) {
    evidence.salary_considered = comp;
    evidence.salary_basis = compBasis;
    evidence.comp_floor = compFloor;
    if (compBasis === 'posting') {
      // Authoritative: the employer published this band, so the full two-part
      // policy applies and a violation hard-excludes.
      const v = violatesCompPolicy(posting, compFloor, {
        tolerancePct: opts.tolerancePct,
        headroomPct:  opts.headroomPct,
      });
      evidence.posting_band = { min: posting.annual_min, max: posting.annual_max };
      evidence.min_allowed  = v.min_allowed;
      if (v.required_max !== null) evidence.required_max = v.required_max;
      if (v.violates) {
        flags.push(`comp-policy-${v.reason}`);
        exclude = true;
      }
    } else if (comp < compFloor) {
      // Crowd average: a soft signal, one letter, never an exclusion.
      flags.push(`comp-below-floor:${Math.round(comp)}`);
    }
  }
  if (typeof signal.salary_satisfaction === 'number') evidence.salary_satisfaction = signal.salary_satisfaction;

  if (flags.length === 0) {
    const nothing = rating === null && ceo === null && rf === null && comp === null;
    // (comp covers both bases — posting band and company average.)
    return { flags: nothing ? ['no-signal'] : [], steps: 0, exclude: false, evidence };
  }
  // One flag = one letter. Two or more = two letters. Never more than two.
  // `exclude` short-circuits all of that — a below-floor posting is not a matter
  // of degree.
  return { flags, steps: Math.min(flags.length, 2), exclude, evidence };
}

/**
 * Drop a grade by n letters, never past DOWNGRADE_FLOOR, never touching D.
 * @param {string} grade
 * @param {number} steps
 * @returns {string}
 */
export function downgrade(grade, steps) {
  const i = GRADE_ORDER.indexOf(grade);
  if (i < 0 || grade === 'D' || steps <= 0) return grade;
  const floorIdx = GRADE_ORDER.indexOf(DOWNGRADE_FLOOR);
  return GRADE_ORDER[Math.min(i + steps, floorIdx)];
}

/**
 * Attach employer signal to one graded card and adjust its grade.
 * Pure: returns a new object, never mutates the input.
 * @param {object} card   graded-jobs entry ({company, role, grade, ...})
 * @param {object|null} signal
 * @param {{compFloor?:number}} [opts]
 * @returns {object}
 */
export function applySignal(card, signal, opts = {}) {
  const { flags, steps, exclude, evidence } = evaluateEmployer(signal, opts);
  const next = exclude ? HARD_EXCLUDE_GRADE : downgrade(card.grade, steps);
  const out = {
    ...card,
    employer_signal: {
      source: signal ? 'indeed' : 'none',
      flags,
      ...evidence,
      ...(signal?.url ? { company_url: signal.url } : {}),
      ...(signal?.fetched ? { fetched: signal.fetched } : {}),
    },
  };
  if (next !== card.grade) {
    out.grade = next;
    out.grade_before_employer_signal = card.grade;
    if (exclude) out.employer_signal.excluded = true;
    else out.employer_signal.downgraded_by = steps;
  }
  return out;
}

/**
 * Apply a whole cache over a list of graded cards.
 * @param {object[]} cards
 * @param {object} cache  { entries: { key: signal } }
 * @param {{compFloor?:number}} [opts]
 * @returns {{ cards:object[], stats:{enriched:number, downgraded:number, missing:number} }}
 */
export function enrichCards(cards, cache, opts = {}) {
  const stats = { enriched: 0, downgraded: 0, excluded: 0, missing: 0 };
  const out = cards.map((c) => {
    const sig = lookupSignal(cache, c.company, c.role || c.title);
    if (sig) stats.enriched++; else stats.missing++;
    const next = applySignal(c, sig, opts);
    if (next.grade !== c.grade) {
      if (next.employer_signal?.excluded) stats.excluded++;
      else stats.downgraded++;
    }
    return next;
  });
  return { cards: out, stats };
}

/**
 * Which company+title pairs still need an Indeed lookup?
 * Skips grade D (already excluded, no point spending a call) and de-dupes.
 * @param {object[]} cards
 * @param {object} cache
 * @param {{ttlDays?:number, now?:Date}} [opts]
 * @returns {Array<{company:string, title:string, key:string, reason:string}>}
 */
export function pendingLookups(cards, cache, opts = {}) {
  const ttlDays = opts.ttlDays ?? TTL_DAYS;
  const now     = opts.now ?? new Date();
  const entries = cache?.entries || {};
  const seen = new Set();
  const out  = [];
  for (const c of cards) {
    if (c.grade === 'D') continue;
    const title = c.role || c.title || '';
    const key   = normKey(c.company, title);
    // De-dupe per COMPANY, not per req: five Brex postings need one lookup, not five.
    if (!c.company || seen.has(companyKey(c.company))) continue;
    seen.add(companyKey(c.company));
    const hit = entries[companyKey(c.company)] || entries[key];
    if (!hit) { out.push({ company: c.company, title, key, reason: 'missing' }); continue; }
    const age = hit.fetched ? (now - new Date(hit.fetched)) / 86400000 : Infinity;
    if (age > ttlDays) out.push({ company: c.company, title, key, reason: `stale:${Math.round(age)}d` });
  }
  return out;
}

// ── I/O ───────────────────────────────────────────────────────────────────────

export function loadCache(cachePath = CACHE_PATH) {
  if (!existsSync(cachePath)) return { version: 1, entries: {} };
  try {
    const c = JSON.parse(readFileSync(cachePath, 'utf8'));
    return c && typeof c === 'object' && c.entries ? c : { version: 1, entries: {} };
  } catch { return { version: 1, entries: {} }; }
}

export function saveCache(cache, cachePath = CACHE_PATH) {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function argVal(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

async function main() {
  const date    = argVal('--date', new Date().toISOString().slice(0, 10));
  const inPath  = resolve(ROOT, argVal('--in', join(DATA, `graded-jobs-${date}.json`)));
  const outPath = resolve(ROOT, argVal('--out', inPath));
  const cachePath = resolve(ROOT, argVal('--cache', CACHE_PATH));
  const mode = process.argv.includes('--scan') ? 'scan' : 'apply';

  if (!existsSync(inPath)) {
    console.log(`[indeed-enrich] no graded file at ${inPath} — nothing to do (exit 0)`);
    process.exit(0);
  }
  const cards = JSON.parse(readFileSync(inPath, 'utf8'));
  const cache = loadCache(cachePath);

  if (mode === 'scan') {
    const pending = pendingLookups(cards, cache);
    // Machine-readable on stdout so the agent can consume it directly.
    process.stdout.write(JSON.stringify(pending, null, 2) + '\n');
    console.error(`[indeed-enrich] ${pending.length} lookup(s) needed of ${cards.length} card(s); cache has ${Object.keys(cache.entries).length}`);
    process.exit(0);
  }

  const compFloor  = loadCompFloor(ROOT);
  const headroomPct  = loadRangeHeadroomPct(ROOT);
  const tolerancePct = loadBottomTolerancePct(ROOT);
  const { cards: enriched, stats } = enrichCards(cards, cache, { compFloor, headroomPct, tolerancePct });
  writeFileSync(outPath, JSON.stringify(enriched, null, 2) + '\n');
  const moved = enriched.filter((c) => c.grade_before_employer_signal);
  const minAllowed = Math.round(compFloor * (1 - tolerancePct / 100));
  console.log(`[indeed-enrich] comp policy: must reach $${compFloor.toLocaleString()}; published bottom may not dip below $${minAllowed.toLocaleString()} (-${tolerancePct}%)${headroomPct > 0 ? `; range must top $${Math.round(compFloor * (1 + headroomPct / 100)).toLocaleString()}` : ''}`);
  console.log(`[indeed-enrich] ${stats.enriched} enriched, ${stats.missing} no-signal, ${stats.downgraded} downgraded, ${stats.excluded} EXCLUDED`);
  for (const m of moved) {
    const tag = m.employer_signal.excluded ? 'EXCLUDED' : 'downgraded';
    console.log(`[indeed-enrich]   [${tag}] ${m.company} — ${m.role}: ${m.grade_before_employer_signal}→${m.grade} (${m.employer_signal.flags.join(', ')})`);
  }
  console.log(`[indeed-enrich] written → ${outPath}`);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (IS_CLI) {
  main().catch((e) => { console.error('[indeed-enrich] FATAL:', e.message); process.exit(1); });
}

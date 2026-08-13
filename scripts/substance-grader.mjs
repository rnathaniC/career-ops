#!/usr/bin/env node
/**
 * substance-grader.mjs — Fit grading by JD substance, not just title keywords.
 *
 * Rahil's directive (2026-08-10): prioritize roles that match the value prop
 * (attacking delivery constraints, automating admin overhead, building team
 * self-sufficiency, predictable outcomes) over named-title matches and poor fits.
 * The old worker-grader scored TITLE keyword-count only, which can't tell a
 * constraint-removing delivery role from a ceremony Scrum Master role by title.
 *
 * This module scores the full available text (title + fetched job description)
 * with a WEIGHTED, SIGNED model: value-prop terms add, anti-fit terms subtract.
 * When the JD can't be fetched for a source, it degrades to scoring the title
 * with the same signed model (still better than count-only).
 *
 * Toggle: config/profile.yml `grading.mode` — "substance" (default) or "title"
 * (the revert code word → worker-grader uses the old keyword matcher instead).
 *
 * Exported pure fn `scoreSubstance` is unit-tested; `fetchJd` is best-effort I/O.
 */

// ── weighted term model (sourced from modes/_profile.md Scoring Priorities) ────

// Each entry: [regex-safe substring, weight]. Matched case-insensitively against
// title + JD text. High weights = core value prop; negatives = anti-fit.
export const POSITIVE = [
  // core value prop (weight 3)
  ['theory of constraints', 3], ['delivery constraint', 3], ['throughput', 3],
  ['lead time', 3], ['cycle time', 3], ['bottleneck', 3], ['predictab', 3],
  ['flow efficiency', 3], ['release train', 3], ['teams of teams', 3],
  ['pi planning', 3], ['program manager', 3], ['delivery manager', 3],
  ['delivery lead', 3], ['technical program manager', 3], ['portfolio management', 3],
  ['self-suffic', 3], ['self suffic', 3], ['team enablement', 3], ['delivery metrics', 3],
  // strong supporting (weight 2)
  ['program', 2], ['delivery', 2], ['roadmap', 2], ['dependencies', 2], ['raid', 2],
  ['stakeholder', 2], ['cross-functional', 2], ['cross functional', 2], ['transformation', 2],
  ['coaching', 2], ['maturity', 2], ['kpi', 2], ['okr', 2], ['metrics', 2],
  ['automation', 2], ['continuous improvement', 2], ['kaizen', 2], ['scaled agile', 2],
  ['safe', 2], ['pmo', 2], ['chief of staff', 2], ['product owner', 2], ['agile coach', 2],
  ['governance', 2], ['operating model', 2], ['process improvement', 2],
  // weak / title-level (weight 1)
  ['scrum master', 1], ['agile', 1], ['project manager', 1], ['sprint', 1],
  ['kanban', 1], ['backlog', 1], ['facilitat', 1],
  // local priority corridor (2026-08-12): boost corporate roles near home so
  // Frisco/Plano/Addison and the immediate area rank above equal fits elsewhere.
  ['frisco', 2], ['plano', 2], ['addison', 2], ['lewisville', 2], ['the colony', 2],
];

export const NEGATIVE = [
  // level / seniority mismatch (weight -3)
  ['junior', -3], ['jr.', -3], ['associate ', -3], ['intern', -3], ['entry level', -3],
  ['entry-level', -3], ['apprentice', -3], ['co-op', -3], ['coordinator', -3],
  ['assistant', -3], ['graduate program', -3],
  // wrong domain (weight -2) — not a delivery/PM leadership role
  ['software engineer', -2], ['developer', -2], ['data engineer', -2], ['nurse', -2],
  ['physician', -2], ['technician', -2], ['sales representative', -2],
  ['account executive', -2], ['recruiter', -2], ['warehouse', -2], ['cashier', -2],
  ['store manager', -2], ['restaurant', -2], ['driver', -2], ['machinist', -2],
];

// Grade thresholds on the net signed score.
export const THRESHOLDS = { A: 6, B: 4, C: 2 };

/**
 * Score fit from arbitrary text (title, or title + JD).
 * @param {string} text
 * @returns {{ grade:'A'|'B'|'C'|'D', score:number, matched:string[], penalized:string[] }}
 */
export function scoreSubstance(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  let score = 0;
  const matched = [];
  const penalized = [];
  for (const [term, w] of POSITIVE) {
    if (t.includes(term)) { score += w; matched.push(term); }
  }
  for (const [term, w] of NEGATIVE) {
    if (t.includes(term)) { score += w; penalized.push(term); }
  }
  let grade;
  if (score >= THRESHOLDS.A) grade = 'A';
  else if (score >= THRESHOLDS.B) grade = 'B';
  else if (score >= THRESHOLDS.C) grade = 'C';
  else grade = 'D';
  return { grade, score, matched, penalized };
}

// ── best-effort JD fetch by source ─────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 12_000;
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

async function getJson(url, opts = {}) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: c.signal, headers: { Accept: 'application/json' }, ...opts });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

/**
 * Fetch a job's description text from its public URL. Best-effort: returns '' when
 * the source isn't wired or the fetch fails (caller then scores title only).
 * Wired in v1: Workday (validated, the dominant source) and Greenhouse. Others → ''.
 * @param {string} url    public job URL from scan-history
 * @param {string} portal normalized portal/source hint (may be '')
 * @param {(u:string,o?:object)=>Promise<any>} fetchImpl  (test seam)
 * @returns {Promise<string>}
 */
export async function fetchJd(url, portal = '', fetchImpl = getJson) {
  if (!url) return '';
  try {
    // Workday: derive the CXS job-detail endpoint from the public URL.
    if (/myworkdayjobs\.com/.test(url)) {
      const u = new URL(url);
      const tenant = u.hostname.split('.')[0];
      const path = u.pathname.replace(/^\/[a-z]{2}-[A-Z]{2}\//, '/'); // strip /en-US/
      const cxs = `${u.origin}/wday/cxs/${tenant}${path}`;
      const j = await fetchImpl(cxs);
      return stripHtml(j?.jobPostingInfo?.jobDescription);
    }
    // Greenhouse: boards-api per-job content, if board + id are parseable.
    const gh = url.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?#]+).*?(?:jobs\/|gh_jid=)(\d+)/);
    if (gh) {
      const j = await fetchImpl(`https://boards-api.greenhouse.io/v1/boards/${gh[1]}/jobs/${gh[2]}`);
      return stripHtml(j?.content);
    }
  } catch { /* fall through to title-only */ }
  return '';
}

/**
 * role-matcher.mjs — Fuzzy role title matching for dedup and merge operations.
 *
 * Extracted from dedup-tracker.mjs so both dedup-tracker and merge-tracker
 * share one canonical implementation.
 */

function normalizeRole(role) {
  return role.toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 /]/g, '')
    .trim();
}

const ROLE_STOPWORDS = new Set([
  'senior', 'junior', 'lead', 'staff', 'principal', 'head', 'chief',
  'manager', 'director', 'associate', 'intern', 'contractor',
  'remote', 'hybrid', 'onsite',
  'engineer', 'engineering',
]);

const LOCATION_STOPWORDS = new Set([
  'tokyo', 'japan', 'london', 'berlin', 'paris', 'singapore',
  'york', 'francisco', 'angeles', 'seattle', 'austin', 'boston',
  'chicago', 'denver', 'toronto', 'amsterdam', 'dublin', 'sydney',
  'remote', 'global', 'emea', 'apac', 'latam',
]);

/**
 * Returns true when two role title strings are similar enough to be treated
 * as the same role. Uses word-overlap after stripping stopwords and
 * normalizing punctuation.
 *
 * Threshold: at least 2 shared content words AND overlap/min-length >= 0.6.
 * Exception (B3, 2026-07-22): when the shorter title reduces to a single
 * content word after stopword removal (e.g. "Software Engineer" vs
 * "Software Engineering" both reduce to just "software" once "engineer"/
 * "engineering" are stripped as role stopwords), the >=2 floor makes an
 * exact single-word match impossible. In that case a single exact-word
 * overlap is enough.
 *
 * @param {string} a First role title
 * @param {string} b Second role title
 * @returns {boolean}
 */
export function roleFuzzyMatch(a, b) {
  const filterStopwords = (words) =>
    words.filter(w => !ROLE_STOPWORDS.has(w) && !LOCATION_STOPWORDS.has(w));

  const wordsA = filterStopwords(normalizeRole(a || '').split(/\s+/).filter(w => w.length > 2));
  const wordsB = filterStopwords(normalizeRole(b || '').split(/\s+/).filter(w => w.length > 2));

  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const overlap = wordsA.filter(w => wordsB.some(wb => wb === w));
  const smaller = Math.min(wordsA.length, wordsB.length);
  const ratio   = overlap.length / smaller;
  const minOverlap = smaller <= 1 ? 1 : 2;

  return overlap.length >= minOverlap && ratio >= 0.6;
}

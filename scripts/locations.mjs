#!/usr/bin/env node
/**
 * locations.mjs — Rahil's commute geography for Job Pulse (added 2026-08-12).
 *
 * Rules:
 *  - Home base: 75067 (Lewisville, TX).
 *  - Remote and hybrid roles are always kept, regardless of distance.
 *  - Onsite roles must be within ~24 miles of home. Without a geocoding service,
 *    "within 24 miles" is approximated by an explicit DFW-local city set.
 *  - Priority corridor (Frisco, Plano, Addison, and the immediate area) gets a
 *    scoring boost for corporate tech/health roles.
 *
 * Pure, dependency-free, unit-tested.
 */

// DFW cities within roughly 24 miles of 75067. Lowercased, matched as substrings
// against the job's location string (+ description when available).
export const LOCAL_CITIES = [
  'lewisville', 'flower mound', 'highland village', 'coppell', 'carrollton',
  'farmers branch', 'addison', 'plano', 'frisco', 'the colony', 'little elm',
  'denton', 'corinth', 'lantana', 'argyle', 'grapevine', 'southlake',
  'colleyville', 'keller', 'roanoke', 'trophy club', 'westlake', 'double oak',
  'irving', 'las colinas', 'valley ranch', 'richardson', 'allen', 'garland',
  'university park', 'highland park', 'dallas', 'north dallas',
  // metro-wide phrasings that imply the local area
  'dfw', 'dallas-fort worth', 'dallas/fort worth', 'dallas fort worth',
  'dallas metroplex', 'north texas',
];

// The priority corridor Rahil called out for corporate tech/health roles.
export const PRIORITY_CITIES = ['frisco', 'plano', 'addison', 'lewisville', 'the colony'];

const REMOTE_RE = /\b(remote|hybrid|work[-\s]?from[-\s]?home|wfh|telecommute|virtual|anywhere|nationwide)\b/i;

/** True if the text signals remote or hybrid (always kept regardless of distance). */
export function isRemoteOrHybrid(text) {
  return REMOTE_RE.test(String(text || ''));
}

/** True if the location string names a city inside the ~24-mile local set. */
export function isLocal(location) {
  const l = String(location || '').toLowerCase();
  if (!l.trim()) return false;
  return LOCAL_CITIES.some((c) => l.includes(c));
}

/** True if the location is in the priority corridor (Frisco/Plano/Addison area). */
export function isPriorityLocal(location) {
  const l = String(location || '').toLowerCase();
  return PRIORITY_CITIES.some((c) => l.includes(c));
}

/**
 * Commute gate. Keep if remote/hybrid, or local, or location is unknown (never
 * drop on missing data — real postings almost always carry a location, and a
 * blank one shouldn't silently discard a possibly-local role). Drop only when the
 * location is a known, non-local, onsite place.
 * @param {string} location  location string from the scan
 * @param {string} [text]     extra text (title + JD) to catch remote/hybrid wording
 * @returns {{ keep: boolean, reason: string }}
 */
// B-0816-5 (2026-08-16): the gate used to test REMOTE_RE against the whole
// "location + title + job description" blob. Job descriptions mention remote
// work constantly in passing — "supports remote teams", "occasional remote
// collaboration", and most damningly "this role is NOT remote" — so a single
// incidental word kept every onsite posting. Measured effect: the commute sweep
// moved 0 of 18 active cards, including Tucson AZ, Evendale OH and
// Glenrothes SCOTLAND, and read as a clean pass rather than a broken filter.
//
// Two changes: the free-text pass now requires a DECLARATIVE phrase (the
// posting asserting its own arrangement, not merely using the word), and any
// such phrase is discarded when negated. The LOCATION field keeps the loose
// match — "Remote, US" in a location column is unambiguous.
const DECLARATIVE_REMOTE_RE = /\b(fully|100%|entirely|permanently)?[-\s]?(remote|hybrid)[-\s]?(first|role|position|opportunity|work arrangement|working|eligible|based)\b|\b(work|working)\s+from\s+home\s+(role|position|opportunity)\b|\bthis\s+(role|position)\s+is\s+(fully\s+)?(remote|hybrid)\b|\bremote\s*\((us|usa|united states|anywhere)\b/i;

// Negation window: "not remote", "no remote", "is not a remote role",
// "cannot be performed remotely", "not eligible for remote".
const NEGATED_REMOTE_RE = /\b(not|no|non|isn't|is not|aren't|cannot|can not|can't|never)\b[^.!?]{0,40}?\b(remote|hybrid|work from home)\b/i;

/**
 * True when free text AFFIRMATIVELY declares a remote/hybrid arrangement.
 * Stricter than isRemoteOrHybrid() on purpose — see B-0816-5 above.
 * @param {string} text
 * @returns {boolean}
 */
export function declaresRemote(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (NEGATED_REMOTE_RE.test(t)) return false;
  if (DECLARATIVE_REMOTE_RE.test(t)) return true;
  // Short strings are TAGS, not prose — a work-model field reading "Hybrid" or
  // "Remote - US" is an assertion about the role, whereas the same word buried
  // in a 4,000-character description is not. The length ceiling is what keeps
  // the loose match from leaking back into job-description body text.
  if (t.length <= 40 && REMOTE_RE.test(t)) return true;
  return false;
}

// B-0817-1 (2026-08-17): Workday postings frequently surface an AGGREGATE
// placeholder in the location field — "3 Locations", "23 Locations",
// "Multiple Locations" — instead of a concrete city. These strings are
// non-empty but carry ZERO geographic information: they don't name a city, so
// they match no LOCAL_CITY and aren't tagged remote/hybrid, and they were
// silently falling through to the onsite-outside-24mi drop. That is a false
// negative — an unresolved placeholder is *unknown*, not a confirmed non-local
// address, so it must be treated identically to a blank location (KEEP, never
// drop on missing data). Today this wrongly buried a Wells Fargo "Lead Data
// Product Manager" card whose location read "3 Locations".
//   Matches: /^\s*\d+\s+locations?\s*$/i  ("3 Locations", "23 Locations")
//         or the substring "multiple locations" (case-insensitive).
const UNRESOLVED_MULTILOCATION_RE = /^\s*\d+\s+locations?\s*$|multiple\s+locations?/i;

/** True when the location field is an unresolved Workday multi-location placeholder. */
export function isUnresolvedMultiLocation(location) {
  return UNRESOLVED_MULTILOCATION_RE.test(String(location || ''));
}

// B-0825-1 (2026-08-25): STATE-QUALIFIED REMOTE leak. isRemoteOrHybrid() keeps
// ANY string with remote/WFH wording, so "FL-Remote", "US-MA-REMOTE",
// "VA - Work from home", "Remote - NY" and "Remote, CA" all sailed onto the
// board — even though Rahil can only take remote roles that are open to Texas.
// His rule, verbatim: "TX-Remote is good, but FL-Remote or CO-Remote is not."
//
// A remote role is DROPPED only when the location field pins it to one specific
// NON-Texas US state (or DC). Nationwide/US remote ("Remote - US", "US Remote",
// "Remote, United States", "Nationwide", "Remote (USA)"), unqualified remote
// ("Remote", "Work from home"), and Texas-tied remote ("TX-Remote",
// "Remote - TX", "Texas Remote", "Remote (TX)", "Dallas Remote") all stay.
//
// Detection is deliberately CONSERVATIVE to avoid false positives on prose:
//   1. A US state must sit DIRECTLY next to remote/WFH wording (within a 3-char
//      punctuation gap) — the "XX-Remote" / "Remote - XX" / "XX Remote" /
//      "Remote (XX)" shapes, or the same shapes with a full state name.
//   2. The 2-letter postal code is matched CASE-SENSITIVELY (uppercase only).
//      Many codes collide with common lowercase words — OR/"or", IN/"in",
//      ME/"me", HI/"hi", OK/"ok" — so requiring uppercase stops the conjunction
//      in "...Portland, OR, or Remote within the US" from reading as Oregon.
//   3. TEXAS is excluded from both lists, so Texas-tied remote never matches
//      here and falls through to the normal remote KEEP below.
// Only the LOCATION FIELD is inspected (never the JD blob): descriptions mention
// other states constantly ("supports our NY office"), and matching those would
// resurrect the exact false-positive problem B-0816-5 fixed for plain remote.

// Non-Texas US postal codes (+ DC). TX intentionally omitted → Texas remote keeps.
const NON_TX_STATE_ABBR =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|' +
  'MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|UT|VT|VA|WA|WV|WI|WY|DC';

// Non-Texas full state names (+ DC). "texas" intentionally omitted.
const NON_TX_STATE_NAME =
  'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|' +
  'florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|' +
  'maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|' +
  'nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|' +
  'north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|' +
  'south dakota|tennessee|utah|vermont|virginia|washington|west virginia|' +
  'wisconsin|wyoming|district of columbia';

// Remote/WFH wording with per-letter case classes so these regexes can stay
// CASE-SENSITIVE for the state code while still matching "Remote", "REMOTE"
// (e.g. "US-MA-REMOTE") and "Work from home". "hybrid" is deliberately NOT
// included — hybrid handling is left unchanged (see note on passesCommuteGate).
const RW =
  '[Rr][Ee][Mm][Oo][Tt][Ee]' +
  '|[Ww][Oo][Rr][Kk][-\\s]?[Ff][Rr][Oo][Mm][-\\s]?[Hh][Oo][Mm][Ee]' +
  '|[Ww][Ff][Hh]|[Tt][Ee][Ll][Ee][Cc][Oo][Mm][Mm][Uu][Tt][Ee]';
const GAP = '[\\s,\\-\\(\\)]{0,3}'; // small punctuation gap between qualifier and remote word

// Case-SENSITIVE (uppercase codes only): "FL-Remote", "VA - Work from home",
// "US-MA-REMOTE"  and  "Remote - NY", "Remote (WA)", "Remote, CA".
const ABBR_BEFORE_REMOTE_RE = new RegExp(`\\b(?:${NON_TX_STATE_ABBR})\\b${GAP}(?:${RW})\\b`);
const ABBR_AFTER_REMOTE_RE = new RegExp(`\\b(?:${RW})\\b${GAP}(?:${NON_TX_STATE_ABBR})\\b`);
// Case-INSENSITIVE for full state names (they don't collide with common words):
// "California Remote", "Remote - California", "Virginia - Work from home".
const NAME_REMOTE_RE = new RegExp(
  `\\b(?:${NON_TX_STATE_NAME})\\b${GAP}(?:remote|work[-\\s]?from[-\\s]?home|wfh|telecommute)\\b` +
  `|\\b(?:remote|work[-\\s]?from[-\\s]?home|wfh|telecommute)\\b${GAP}(?:${NON_TX_STATE_NAME})\\b`,
  'i',
);

/**
 * True when the LOCATION field describes remote work restricted to a single
 * non-Texas US state (or DC) — e.g. "FL-Remote", "Remote - NY", "US-MA-REMOTE",
 * "California Remote". Texas-tied and nationwide/US remote return false (kept).
 * @param {string} location  the short Location field string
 * @returns {boolean}
 */
export function isOutOfStateRemote(location) {
  const loc = String(location || '');
  if (!loc.trim()) return false;
  return (
    ABBR_BEFORE_REMOTE_RE.test(loc) ||
    ABBR_AFTER_REMOTE_RE.test(loc) ||
    NAME_REMOTE_RE.test(loc)
  );
}

export function passesCommuteGate(location, text = '') {
  // (0) State-qualified remote is the most specific verdict, so it runs FIRST —
  // before the generic remote/hybrid keep — or "FL-Remote" would leak through as
  // plain remote. Only the LOCATION field is checked (never the JD blob).
  if (isOutOfStateRemote(location)) return { keep: false, reason: 'remote-out-of-state' };
  // The location FIELD is authoritative — a loose match is safe here. By now any
  // out-of-state remote is already gone, so what remains is nationwide/US,
  // unqualified, Texas-tied remote, or hybrid (hybrid handling unchanged).
  if (isRemoteOrHybrid(location)) return { keep: true, reason: 'remote-or-hybrid' };
  if (isLocal(location)) return { keep: true, reason: 'local' };
  // Free text only counts when the posting declares the arrangement outright.
  if (declaresRemote(text)) return { keep: true, reason: 'remote-declared-in-text' };
  if (!String(location || '').trim()) return { keep: true, reason: 'location-unknown' };
  // Unresolved Workday aggregate ("N Locations" / "Multiple Locations") carries
  // no geography — treat as unknown and KEEP, exactly like a blank location.
  // Runs AFTER the remote/hybrid + local keeps (a genuine signal wins first) and
  // BEFORE the onsite drop (so the placeholder never reads as a confirmed address).
  if (isUnresolvedMultiLocation(location)) return { keep: true, reason: 'location-unresolved' };
  return { keep: false, reason: 'onsite-outside-24mi' };
}

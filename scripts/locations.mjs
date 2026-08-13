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

const REMOTE_RE = /\b(remote|hybrid|work[-\s]?from[-\s]?home|wfh|telecommute|virtual|anywhere)\b/i;

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
export function passesCommuteGate(location, text = '') {
  const blob = `${location || ''} ${text || ''}`;
  if (isRemoteOrHybrid(blob)) return { keep: true, reason: 'remote-or-hybrid' };
  if (isLocal(location)) return { keep: true, reason: 'local' };
  if (!String(location || '').trim()) return { keep: true, reason: 'location-unknown' };
  return { keep: false, reason: 'onsite-outside-24mi' };
}

/**
 * user-files.mjs — SINGLE SOURCE OF TRUTH for the per-user, gitignored
 * "user-layer" files.
 *
 * These four paths are the customization layer that .gitignore intentionally
 * keeps out of the repo forever ("User config and customization (never
 * auto-updated)"). Two very different consumers depend on this EXACT set and
 * must never drift:
 *   • doctor.mjs — the First-Run prerequisite checklist (`checkPrereq`) and the
 *     machine-readable cold-start state (`onboardingState`).
 *   • scripts/daily-health-report.mjs — excludes them from the ship-gap so they
 *     never nag as a permanent, false "validated-but-not-dispatched" alarm.
 *
 * PURE MODULE — no side effects, no top-level execution, no process.exit — so
 * anything can import it safely, including doctor.mjs (which exits at load).
 */

// Canonical set. Paths use "/" and are split on it by consumers for join().
export const USER_GITIGNORED_FILES = [
  'cv.md',
  'config/profile.yml',
  'modes/_profile.md',
  'portals.yml',
];

const _canonical = new Set(USER_GITIGNORED_FILES);

// True when `f` is one of the per-user gitignored files above. Normalises
// Windows back-slashes and a leading "./" so manifest paths match regardless
// of how they were written.
export function isUserGitignoredFile(f) {
  if (typeof f !== 'string') return false;
  const norm = f.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return _canonical.has(norm);
}

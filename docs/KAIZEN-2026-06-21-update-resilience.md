# Kaizen Proposal — Self-Healing Update + Durable NUL Defense
**Date:** 2026-06-21  **Author:** Claude (for Rahil's approval)  **Status:** DRAFT — awaiting go/no-go

## Context (what happened)
`node update-system.mjs apply` (v1.3.0 → v1.12.0) succeeded on file copy (40 paths)
but left three problems caused by writing through the Windows/OneDrive mount:
1. A stale `.git/HEAD.lock` + a NUL-corrupted `.git/index` (bad signature) — git half-failed.
2. **14 working files NUL-corrupted** by the git checkout (package.json, CLAUDE.md, 5x .github,
   modes, docs, dashboard, templates, .claude skill pointer).
3. **v1.12.0 upstream had REMOVED the NUL defense** — no `checkNoNullBytes` in doctor.mjs,
   no `scripts/fix-nul-bytes.mjs`, no `fix-nul` npm script — yet `scripts/pulse-refresh.mjs`
   still calls `npm run fix-nul` (line 279). The next scheduled pulse would have HALTED.

## Done already (2026-06-21, Kaizen #1 — no approval needed, defect class)
- Rebuilt corrupt git index; cleared stale locks.
- Repaired all 14 NUL files (package.json via fix-nul; other 13 restored from clean upstream blobs).
- **Restored + widened the NUL defense**: recursive sweep over
  `.mjs .js .json .md .yml .yaml .html .go .tex`, skipping `.git/node_modules/*.bak`.
  Touched: `scripts/fix-nul-bytes.mjs`, `doctor.mjs` (re-added `checkNoNullBytes`),
  `package.json` (re-added `fix-nul` script). Verified by planting a NUL and watching
  doctor flag + fix-nul repair it.

## The treadmill problem (why #2 is needed)
The three files above are SYSTEM-layer. The NEXT `update-system.mjs apply` will overwrite
them with upstream (which lacks the NUL defense) — silently re-opening the hole. We cannot
keep hand-patching after every update.

## Proposal (Kaizen #2 — needs Rahil's go/no-go)
**Make the update + pulse resilient so corruption self-heals and the defense survives updates.**

- **2a. Post-update self-heal in `update-system.mjs`:** after the git checkout, automatically
  (i) detect a NUL-corrupted or bad-signature `.git/index` and rebuild via `git read-tree HEAD`,
  (ii) run the recursive `fix-nul-bytes.mjs`, (iii) re-run `doctor`. Abort loudly only if still red.
- **2b. Keep the NUL defense out of the update's blast radius.** Two options:
  - **Option A (recommended): commit the defense to Rahil's fork** so `update-system.mjs`
    (which merges upstream) keeps it. Lowest ongoing effort.
  - **Option B: move the defense to a user-layer guard** — a standalone `scripts/guard-nul.mjs`
    that `pulse-refresh.mjs` calls first, and that update-system is told never to overwrite.
- **2c. Guard `pulse-refresh.mjs`** so a missing `fix-nul` script degrades gracefully
  (warn + run the .mjs directly) instead of halting the whole pipeline.

## Risk / trade-off
- 2a edits the updater itself — test on a backup branch first (backup-pre-update-* already exists).
- Option A requires Rahil to push to his fork (one-time). Option B adds one small user-layer file.
- Cost: zero new dependencies, lean. Aligns with the "lean tech stack / kaizen" mandate.

## Recommendation
Do **2a + 2c now** (defect-adjacent, protects the nightly run) and **2b Option A**
(commit the defense to the fork) so updates stop nuking it. Awaiting your go/no-go.

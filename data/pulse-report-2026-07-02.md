# Job Pulse Daily Report — 2026-07-02 (12:01am CT run)

**Run mode:** step-wise (monolith exceeds sandbox shell window) · **Result:** PARTIAL (exit-2 equivalent — CAPTCHA/requires-human) · **Pipeline health:** 0 errors / 1 warning

## Environment (self-healed this run)
- Chromium not installed in fresh sandbox → installed (2 windows, 114MB + headless shell)
- libXdamage.so.1 missing → apt-get download workaround to /tmp/pw-libs (ephemeral, recurs daily)
- xvfb present natively this run (new — no manual X server workaround needed)
- Doctor: green. fix-nul: clean. All pipeline scripts passed syntax check — **no truncation epidemic today.**

## Counts
| Step | Result |
|---|---|
| Connections sync | 3,394 |
| Airtable pull | 10 cards → kanban-import-2026-07-02.json |
| Archive stale | 2 New-Fresh archived (live-2026-06-30-001, -003) |
| Cadence | GAP 1 — 2026-06-27 still the only hole in 7-day window |
| Scan | net-new incl. Okta Sr PM, Samsara Sr PM (Canada), Coupa Bogotá |
| Worker grader | 10 graded: A=0 B=1 C=9 |
| Kanban inject | 10 injected, 0 dupes, 0 errors |
| Lane branch | Hot=7 / Fresh=13 (deterministic — B-1 mitigation applied: rm'd day file before run) |
| CL generation | 0 (no A/B cards on Fresh; the 2 A/B are Hot/warm-held) |
| Readiness | 12/20 PASS, avg 81/B; 6 FAIL (generic CLs); 2 skipped no-CL (B-3) |
| **AutoSubmit live** | **5 attempted → 0 submitted** |
| Airtable push | 0 changed |

## AutoSubmit detail — B-2 auth gate BREACHED, new frontier is CAPTCHA
`data/auth-state.json` loaded successfully (export-auth worked). Browser launched, liveness OK, readiness A-band on all 5. Outcomes:

| Card | Score | Outcome |
|---|---|---|
| live-2026-07-01-003 | 91/A | CAPTCHA → requires-human |
| live-2026-06-30-001 (Lyft) | 96/A | BLOCKED — no submit button found |
| live-2026-07-01-001 (Lyft) | 96/A | BLOCKED — no submit button found |
| live-2026-07-02-006 (Okta) | 91/A | CAPTCHA → requires-human |
| live-2026-07-02-007 (Okta) | 91/A | CAPTCHA → requires-human (screenshot saved: data/screenshots/2026-07-02/) |

This is the furthest the pipeline has ever gotten. The remaining blockers are anti-bot walls, not our code or env.

## Hot lane — 7 cards waiting on Rahil (never auto-fired, by design)
Includes Stripe TPM (Link) via **Shamila Zindani Merchant** — outreach message drafted in `data/referral-queue-2026-07-02.json`. Run `npm run referral-queue` to reprint all 7 blocks.

## Bug Triage (new + persisting)
1. **NEW P2 B-4:** per-card `auto-submit:live` runs OVERWRITE `data/live-runs-{date}.json` — only the last card survives. Fix: merge/append. (Matters because monolith can't finish in one sandbox window, so per-card is the operating mode.)
2. **B-3 persists (P2):** readiness scorer skips no-CL cards (2 today) even in the 60–88 no-CL band.
3. **NEW P3:** 6 readiness FAILs were "CL doesn't mention company / 1–2 paragraphs / 0% keywords" — a stale generic CL is being matched to cards it wasn't written for. CL-Gen only covers A/B, so C-cards inherit garbage.
4. **P3:** archive-stale WARN — Airtable Archive table has none of the Active Pipeline fields; archived rows land blank. Add matching columns in Airtable.
5. **B-1 (lane-branch non-determinism):** did not reproduce with the rm-day-file mitigation; permanent in-memory fix still recommended.

## Kaizen recommendations (ranked)
1. **CAPTCHA path:** mark requires-human cards on the board + morning digest for Rahil to one-click finish (submission is 95% pre-filled by SpeedyApply).
2. **Lyft "no submit button":** selector likely changed — capture DOM snapshot on BLOCKED for offline selector repair.
3. Make live-runs writer append (B-4) — 5-line fix.
4. Score no-CL band without CL (B-3).
5. Apply update v1.12.0 → v1.15.0 (waiting on Rahil's go).

## For Rahil (exact steps)
1. Open `data/referral-queue-2026-07-02.json` → send the 7 Hot outreach messages (Shamila/Stripe drafted for you).
2. The 3 CAPTCHA cards: open each URL from the table above in Edge, solve CAPTCHA, hit submit — forms are pre-filled.
3. Say "update career-ops" next session to apply v1.15.0.

# Pulse Refresh — 2026-07-12 (12:01am CT scheduled run)

**Mode:** step-wise (monolith background process killed between sandbox calls — known limitation)
**Overall:** partial (exit-2 equivalent) — pipeline green end-to-end, 0/3 auto-submits landed (2 CAPTCHA, 1 form-blocked)

## Step results
| Step | Result |
|---|---|
| -0.55 connections:sync | OK — 3,394 connections pulled |
| -0.5 airtable:pull | OK — 15 cards |
| -0.4 archive-stale | 2 archived (live-2026-07-10-002/003, New-Fresh aged out); B-12 blank-row warning persists |
| -1 doctor | GREEN (1 non-blocking warning: Playwright MCP not detected) |
| -0.9 cadence | OK — no gaps through 2026-07-12; today marked via cadence:mark |
| 0.5 workday | stub no-op (B6 pending) |
| 0.75 scan | 38 companies, 5,056 jobs, 0 net-new (288 dupes) |
| 1.5 worker-grader | 4 graded from 7/11 history: all C |
| 3.5 kanban-inject | 0 injected (4 dupes) |
| 4.4/4.5 board-state + ingest | 15 cards: 10 Hot / 5 C-Fresh; 0 new to queue |
| 4.6 lane branch | 10 New-Hot HELD for Rahil ✋; 3 New-Fresh forwarded |
| 4.55 CL gen | no eligible A/B cards |
| 4.65 readiness | Figma 87/B PASS · Okta 95/A PASS · Delinea SKIP (no CL, proceeds by design) |
| 5 auto-submit LIVE | 3 attempted, **0 submitted**: Figma+Okta CAPTCHA (Greenhouse, recurring), Delinea BLOCKED no-submit-button (Ashby) |
| 8.5–9 wrap-up | last-refresh.json written; Airtable snapshot OK (144 KB); push 0 (no local card changes) |

## Env notes (playbook confirmations)
- /tmp/chrome-linux64.zip from 7/11 run SURVIVED in sandbox — reused, no re-download.
- NEW playbook shortcut: Playwright 1.61 demands chromium_headless_shell-1228; **symlinking the Chrome-for-Testing binary to that exact path works** — no headless-shell zip download needed.
- --no-extension-autofill (B-15 workaround) + xvfb + cached libXdamage all held.

## Bug triage (no new bugs)
- B-12 (blank archived rows) — persists, P3, Airtable Archive-table schema fix needed.
- Greenhouse CAPTCHA (Figma/Okta) — recurring, env-level; correctly downgraded to requires-human. Candidate for manual-assist queue.
- Delinea Ashby no-submit-button — first Ashby block; may be multi-step form (pattern echoes Lyft). Worth a look before writing a bug.

## Waiting on Rahil
1. **10 Hot referral cards** in data/referral-queue-2026-07-12.json (incl. Datadog→Dardan Lajqi, Stripe→Shamila Zindani Merchant) — review & send.
2. **Email checks still pending:** CI&T Lever + Pinterest submits (from 7/09–7/10) — confirm before any re-attempt.
3. Uncommitted fixes (B-16 empty-form guard, B-17 titleDisqualifiers) still need a host-side commit.

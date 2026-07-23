# SKILL_UPDATE_AUTO_SUBMIT.md — OBSOLETE (superseded)

> **Status: OBSOLETE — do not act on this file.**
>
> This doc originally instructed manually pasting the block below into the OneDrive
> scheduled task's `SKILL.md`, citing "sandbox cannot write to OneDrive directly" as the
> blocker. That blocker no longer applies — the Auto-Submit logic described here (4-mode
> escalation, 3-lock live-mode safety rail, Lane-Branch New-Hot/New-Fresh routing) is now
> fully implemented in code and runs live via the real pipeline scripts:
>
> - `scripts/pulse-refresh.mjs` — orchestrates the nightly run
> - `scripts/referral-queue.mjs` — referral routing
> - `scripts/auto-submit.mjs` — the 4-mode auto-submit logic described below
> - `scripts/kanban-inject.mjs` — Lane-Branch New-Hot / New-Fresh injection
> - `scripts/archive-stale.mjs` — stale-card archival
>
> Kept below for historical reference only. If you need current behavior, read the
> scripts above, not this file.

---

## Step 5 — Auto-Submit (4 modes, escalate in order)

**Safety rail: default is DRY-RUN. Nothing is submitted, nothing is clicked, no browser is launched.**

### Mode 1 — Dry-run (default, run first every time)

```bash
cd <career-ops root>  # e.g. your local checkout
node scripts/auto-submit.mjs \
  --kanban dashboard/job-pulse-kanban.html \
  --limit 10 \
  --dry-run
```

Reads the Kanban, finds cards in `new-hot` / `autosubmit-ready` columns with grade A/B (non-referral), and reports:
- What ATS each job uses (Greenhouse, Lever, Ashby, Workday, etc.)
- Whether the form is fillable (Playwright support level)
- Whether a cover letter exists in `cover-letters/`
- Which cards WOULD be submitted if run with `--live`

Output: `data/auto-submit-dry-run-{date}.json`

**Add `--report` to see a markdown table in the terminal:**
```bash
node scripts/auto-submit.mjs --kanban dashboard/job-pulse-kanban.html --limit 10 --dry-run --report
```

---

### Mode 2 — Semi-auto (visible browser, YOU click submit)

Use after a clean dry-run. Playwright opens a visible Chromium window, navigates to the URL,
detects the submit button and highlights it with a red CSS border. You review the filled form
and click Submit yourself (or press Ctrl+C to abort).

**B7 liveness check fires first** — dead listings are skipped before any browser is launched.

```bash
node scripts/auto-submit.mjs \
  --kanban dashboard/job-pulse-kanban.html \
  --semi-auto \
  --limit 3
```

Log: `data/semi-auto-{date}.json` (card ID, URL, outcome: user-submitted | aborted | unknown)

---

### Mode 3 — Live (fully automated, all 3 safety locks required)

**THREE locks must ALL be active — any missing one is a hard refusal with an actionable error.**

Lock (a) — CLI flag on every invocation:
```
--allow-tier lower
```

Lock (b) — edit `config/lower-tier-test-companies.yml`:
```yaml
enabled: true
```

Lock (c) — company slug in the YAML list (matching the kanban card `company` field, slugified):
```yaml
companies:
  - slug: acme-corp
    reason: low-priority target approved 2026-06-10
```

**Hard cap: 5 live submissions per day** — `--limit` flag cannot override this. Tracked in
`data/live-daily-count-{date}.json`.

```bash
node scripts/auto-submit.mjs \
  --kanban dashboard/job-pulse-kanban.html \
  --live \
  --allow-tier lower \
  --limit 3
```

Safety checks per card (in order, any failure skips/stops):
1. B7 liveness: HEAD request to URL — 404/410/redirect-to-homepage → dead-listing, skip
2. CAPTCHA detection: recaptcha/hcaptcha/cf-challenge → mark requires-human, skip card, continue
3. Intermediate step: "Review your application" / "Confirm submission" / "Verify your information"
   → **CRITICAL STOP** — log intermediate-step, screenshot, STOP entire run (don't move on)
4. Submit button detection: ATS-specific selectors (Greenhouse / Lever / Workday) with generic fallback
5. Click and wait up to 60s for: URL change OR success text ("Thank you for applying" / "Application submitted" / "We received your application")
6. No confirmation within 60s → mark `unconfirmed`, screenshot, continue (NOT marked as applied)

On confirmed success: screenshot to `data/screenshots/{date}/`, entry in `data/submit-queue.json` (kanban sync), TSV entry in `batch/tracker-additions/`.

Logs: `data/live-runs-{date}.json`, `data/dead-listings-{date}.json`

Exit codes: 0=clean, 1=fatal/safety-refused, 2=CAPTCHA-blocked, 3=form-blocked

---

### Mode 4 — Future: unrestricted live (post-F1000 graduation)

Not yet implemented. After 1 week of clean lower-tier live runs, Rahil will add a second YAML tier
(`production`) for Fortune 100 targets. The `--allow-tier production` flag + a separate YAML list
will gate this tier. Daily cap will be separate per tier.

---

### Per-card override (any mode)

```bash
node scripts/auto-submit.mjs --kanban dashboard/job-pulse-kanban.html --card live-42 --dry-run
node scripts/auto-submit.mjs --kanban dashboard/job-pulse-kanban.html --card live-42 --semi-auto
```

---

### Output files reference

| File | Mode | Contents |
|------|------|----------|
| `data/auto-submit-dry-run-{date}.json` | dry-run | eligible_total, processed, would_submit, partial, blocked, results[] |
| `data/semi-auto-{date}.json` | semi-auto | results[] with outcome: user-submitted \| aborted |
| `data/live-runs-{date}.json` | live | confirmed, unconfirmed, captcha_blocked, form_blocked, results[] |
| `data/dead-listings-{date}.json` | live / semi-auto | URLs that failed B7 liveness check |
| `data/screenshots/{date}/` | live / semi-auto | pre-submit, confirmed, unconfirmed, captcha, intermediate screenshots |
| `data/submit-queue.json` | live (confirmed) | Queue file for kanban state sync |
| `data/live-daily-count-{date}.json` | live | Daily submission counter (hard cap enforcement) |

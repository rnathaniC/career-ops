# Runbook: Editing large files safely (truncation root cause)

**Status:** ROOT CAUSE CONFIRMED — 2026-06-18
**Symptom:** `.mjs`/large files get truncated (tail chopped or mid-body mangled)
after an AI edit. Repo has accumulated `*.bak-trunc` files from repeat incidents.

## Root cause
The agent's `Read` tool returns a **partial, paged view** of large files, capped
at ~25,000 tokens (~322 lines of 60-char text; varies with line width). The host
file editor (`Edit`/`Write`) only ever holds that buffered window. When it writes
the file back, **everything past the read window is lost** → truncation.

Proof (2026-06-18):
- `Read` on a 1,502-line probe reported: `PARTIAL view — showing lines 1-322 of
  1502 total (98971 tokens, cap 25000)`.
- `auto-submit.mjs` is 60,635 bytes / 1,423 lines — sits right at the cap, so host
  edits truncated only the *tail* (a bigger file loses much more).
- Writes performed via **bash** (sed/python/node) never truncate — they operate on
  the true full file on disk.

## Rule
For any file that does **not** fully fit one `Read` (no "PARTIAL view" banner =
safe; banner present = unsafe):
- **DO NOT** use `Read` + `Edit`/`Write`. The buffer is incomplete.
- **DO** edit via bash: `python3` exact-string splice, `sed`, or `node`. Always
  follow with `node --check <file>` (or equivalent) and re-run unit tests.
- Keep a one-shot backup first: `cp file file.bak` (note: this sandbox mount
  blocks `rm`, so prune backups host-side).

## Quick test for any file before editing
`wc -c <file>` — if > ~45-50 KB (or you see the PARTIAL banner on Read), treat as
large and edit via bash.

## Related Kaizens (need approval)
- K-A: add `*.bak*`, `*.pre-*`, `_*probe*` to `.gitignore` so junk/backups never commit.
- K-B: investigate raising the Read cap or auto-paging full files for the agent.

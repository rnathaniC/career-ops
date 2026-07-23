@echo off
REM ============================================================================
REM  tidy-repo.bat  -  untrack scratch/cache/secret-template files that the
REM  big git add -A (commit 9adbc09) accidentally swept in. K-2026-06-21-COMMIT.
REM
REM  SAFE: `git rm --cached` removes files from GIT ONLY. Your files stay on
REM  disk, untouched. .gitignore was already expanded so they won't come back.
REM
REM  Logs everything to tidy-repo.log. TO RUN: double-click.
REM ============================================================================
setlocal
cd /d "%~dp0"
set "LOG=%~dp0tidy-repo.log"
call :run > "%LOG%" 2>&1
echo.
type "%LOG%"
echo.
echo Full log: %LOG%   (send it to me if anything looks off)
pause
exit /b

:run
echo === tidy-repo: untracking scratch/cache from git ===
git --version
echo.
echo [1] Removing from index only (files kept on disk)...
git rm -r --cached --quiet --ignore-unmatch "cloudflare-worker/.dev.vars" "cloudflare-worker/.wrangler" "commit-pulse.log" "tmp" "data/tmp" "modes/_zztest"
git rm --cached --quiet --ignore-unmatch "data/tmp-*" "data/test-*" "data/live-*" "data/worker-candidates-*" "data/worker-new-us-*" "data/worker-scan-*" "data/kanban-snapshot-*" "data/kanban-k2-export-*" "data/secondary-verified-*" "data/dead-listings-*" "data/airtable-map.err"
git rm -r --cached --quiet --ignore-unmatch "data/worker-raw"
for /d %%d in ("data\worker-raw-*") do git rm -r --cached --quiet --ignore-unmatch "%%d"

echo.
echo [2] Staging the .gitignore update too...
git add -A .gitignore

echo.
echo [3] What will change in this commit (name-status):
git diff --cached --name-status

echo.
echo [4] Committing cleanup...
git commit -m "chore: untrack scratch/cache/worker-dev files swept in by 9adbc09" -m "Expand .gitignore (cloudflare-worker/.wrangler+.dev.vars, tmp/, data scratch, *.trash). Files kept on disk; index only. Commit-hygiene K-2026-06-21-COMMIT."
if errorlevel 1 (
  echo   commit returned non-zero ^(maybe nothing to untrack^). Status:
  git status
  exit /b 1
)

echo.
echo [5] Pushing...
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
git push fork %BRANCH%
if errorlevel 1 ( echo   push failed - retry: git push fork %BRANCH% & exit /b 1 )

echo.
echo === DONE. Latest commits: ===
git log -3 --oneline
exit /b 0

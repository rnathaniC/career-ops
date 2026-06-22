@echo off
REM ============================================================================
REM  commit-pulse.bat  -  one-click commit + push for career-ops (with full log)
REM  K-2026-06-21-COMMIT. Logs EVERYTHING to commit-pulse.log so we can see
REM  exactly where git stops if a commit doesn't land.
REM
REM  Safe by design: .gitignore was hardened first, so artifacts/PII/binaries
REM  are never staged. Deleting .git\index (corruption heal) is safe -- git
REM  rebuilds it from HEAD; your working files are never touched.
REM
REM  TO RUN: double-click, or in a terminal:  commit-pulse.bat
REM ============================================================================

setlocal
cd /d "%~dp0"
set "LOG=%~dp0commit-pulse.log"

REM Run the real work with ALL output captured to the log, then show it.
call :run > "%LOG%" 2>&1

echo.
type "%LOG%"
echo.
echo ----------------------------------------------------------------------
echo Full log saved to: %LOG%
echo If anything failed, that log has the exact git message. Send it to me.
echo ----------------------------------------------------------------------
pause
exit /b

:run
echo === career-ops commit + push ===
echo Repo: %cd%
git --version
echo.

echo [1] Clearing stale lock if present...
if exist ".git\index.lock" ( del /f /q ".git\index.lock" & echo   removed .git\index.lock ) else ( echo   no lock )

echo.
echo [1b] Checking index health...
git status >nul 2>&1
if errorlevel 1 (
  echo   index UNREADABLE - rebuilding from HEAD ^(working files untouched^)
  if exist ".git\index" del /f /q ".git\index"
  git reset -q
  git status >nul 2>&1
  if errorlevel 1 (
    echo   STILL UNREADABLE after rebuild. Close any Git tool ^(SourceTree/VS Code/GitHub Desktop^) and re-run.
    echo   --- git status verbose ---
    git status
    exit /b 1
  )
  echo   index rebuilt OK
) else (
  echo   index healthy
)

echo.
echo [2] Identity / branch:
git config user.name
git config user.email
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
echo   branch: %BRANCH%

echo.
echo [3] Staging (git add -A; artifacts/PII/binaries auto-excluded)...
git add -A
git reset -q -- "config/personal-info.yml.txt" "config/linkedin-connections.json" 2>nul
git reset -q -- "dashboard/kanban-server.exe" 2>nul

echo.
echo [3b] Files staged for commit:
git diff --cached --name-only
echo   --- end staged list ---

echo.
echo [4] Committing...
git commit -m "pulse: restore truncated package.json scripts + ship CL-Gen & cadence watchdog + commit-hygiene" -m "P0: rebuild 11 pipeline npm scripts lost to truncation. K-2026-06-21-1 CL-Gen (Step 4.55) + readiness reads output/. K-2026-06-21-3 cadence watchdog (Step -0.9). TD-01 honest attempted count. Harden .gitignore."
if errorlevel 1 (
  echo   COMMIT returned non-zero ^(likely nothing staged, or an error above^).
  echo   --- current status ---
  git status
  exit /b 1
)
echo   commit OK

echo.
echo [5] Pushing to fork/%BRANCH%...
git push fork %BRANCH%
if errorlevel 1 (
  echo   PUSH failed ^(sign-in prompt or network^). Retry: git push fork %BRANCH%
  exit /b 1
)

echo.
echo === DONE. Latest commits: ===
git log -3 --oneline
exit /b 0

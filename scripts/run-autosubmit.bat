@echo off
REM ============================================================================
REM run-autosubmit.bat - JobPulse LIVE auto-submit (Fresh lane) - YOU launch this
REM
REM Sequence: launch debug Edge on YOUR logged-in profile (CDP) -> freshen cover
REM           letters -> auto-submit --live reading the R1 board-state bridge -> clean up.
REM
REM SAFETY (all enforced inside auto-submit.mjs, cannot be bypassed by this bat):
REM   1. --allow-tier lower            (CLI arm)
REM   2. config\lower-tier-test-companies.yml  enabled: true   (global kill-switch)
REM   3. Per-card gates: grade A/B/C eligibility + readiness band >=60 + 5/day cap
REM   4. Hot lane (warm referrals) are ALWAYS excluded - never auto-fired.
REM   Flip the kill-switch to enabled: false to stop everything instantly.
REM
REM BEFORE YOU RUN: close ALL Microsoft Edge windows first. Edge refuses a second
REM   debug instance on an already-open profile, which silently breaks the login.
REM ============================================================================
setlocal
cd /d "%~dp0\.."

echo.
echo  Close ALL Edge windows before continuing (needed so the debug profile is your real login).
echo  Press any key once Edge is fully closed, or Ctrl+C to abort.
pause >nul

for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set DT=%%I
set STAMP=%DT:~0,8%
set LOG=data\autosubmit-bat-%STAMP%.log

echo [bat] %date% %time% START >> "%LOG%"

REM 1. Launch debug Edge on your authenticated profile (holds it open on port 9222)
start "JobPulse-DebugBrowser" /min cmd /c "node scripts\launch-debug-browser.mjs --port 9222 >> "%LOG%" 2>&1"

REM 2. Give Edge + CDP time to come up
timeout /t 12 /nobreak >nul

REM 2b. Freshen cover letters for eligible cards (lifts readiness over the 60 gate). Free + deterministic.
node scripts\generate-cl.mjs --all >> "%LOG%" 2>&1

REM 3. LIVE submit - reads the R1 board-state bridge (NOT the stale HTML kanban) and attaches via CDP
node scripts\auto-submit.mjs --kanban-json data\board-state.json --live --allow-tier lower --browser-mode connect --debug-port 9222 >> "%LOG%" 2>&1
set RESULT=%ERRORLEVEL%
echo [bat] %date% %time% auto-submit exit=%RESULT% >> "%LOG%"

REM 3b. Merge bat counts into last-refresh.json so the 8am report sees this run
node scripts\merge-bat-results.mjs >> "%LOG%" 2>&1

REM 4. Close the background debug-browser launcher (and its Edge child)
taskkill /FI "WINDOWTITLE eq JobPulse-DebugBrowser*" /T /F >nul 2>&1

echo.
echo  Done. Exit code %RESULT%  (0 = clean, 2 = some cards need a human, 3 = some forms blocked)
echo  Full log: %LOG%
echo [bat] %date% %time% END exit=%RESULT% >> "%LOG%"
endlocal

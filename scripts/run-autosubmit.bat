@echo off
REM ============================================================================
REM run-autosubmit.bat — JobPulse daily LIVE auto-submit (6:10am Windows task)
REM
REM Sequence: launch debug Edge (CDP) -> wait -> auto-submit --live -> clean up.
REM Safety: --live enforces 3 locks (allow-tier + YAML enabled + per-company
REM         allowlist) + readiness>=70 gate + 5/day cap, all inside the script.
REM Test manually first:  scripts\run-autosubmit.bat
REM ============================================================================
setlocal
cd /d "%~dp0\.."

for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set DT=%%I
set STAMP=%DT:~0,8%
set LOG=data\autosubmit-bat-%STAMP%.log

echo [bat] %date% %time% START >> "%LOG%"

REM 1. Launch debug browser in a background window (holds Edge open on port 9222)
start "JobPulse-DebugBrowser" /min cmd /c "node scripts\launch-debug-browser.mjs --port 9222 >> "%LOG%" 2>&1"

REM 2. Give Edge + CDP time to come up
timeout /t 12 /nobreak >nul

REM 2b. Freshen cover letters for every eligible A/B card (lifts skip-band cards
REM     over readiness 60 so they become submittable). Free, deterministic.
node scripts\generate-cl.mjs --all >> "%LOG%" 2>&1

REM 3. LIVE submit (attaches to the debug browser via CDP)
node scripts\auto-submit.mjs --live --allow-tier lower --browser-mode connect --debug-port 9222 >> "%LOG%" 2>&1
set RESULT=%ERRORLEVEL%
echo [bat] %date% %time% auto-submit exit=%RESULT% >> "%LOG%"

REM 3b. Merge bat counts into last-refresh.json so the 8am report sees this run
node scripts\merge-bat-results.mjs >> "%LOG%" 2>&1

REM 4. Close the background debug-browser launcher (and its Edge child)
taskkill /FI "WINDOWTITLE eq JobPulse-DebugBrowser*" /T /F >nul 2>&1

echo [bat] %date% %time% END exit=%RESULT% >> "%LOG%"
endlocal

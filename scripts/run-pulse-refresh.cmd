@echo off
REM ============================================================================
REM run-pulse-refresh.cmd — career-ops nightly pipeline runner for Windows
REM Task Scheduler. Runs the FULL refresh with no Claude-agent command-window
REM cap, so the multi-minute pipeline can finish (this is the fix for the
REM "silent miss" pattern where only the early cadence marker got written).
REM
REM pulse-refresh.mjs writes its own dated log to logs\pulse-refresh-YYYY-MM-DD.log.
REM This wrapper additionally appends raw stdout + the exit code to
REM logs\scheduler-run.log so you can confirm the native task actually fired.
REM ============================================================================
cd /d "C:\Users\rahil\career-ops"
echo ==== %DATE% %TIME% : starting pulse:refresh (native scheduler) ==== >> logs\scheduler-run.log
node scripts\pulse-refresh.mjs >> logs\scheduler-run.log 2>&1
echo ==== %DATE% %TIME% : finished, exit code %ERRORLEVEL% ==== >> logs\scheduler-run.log

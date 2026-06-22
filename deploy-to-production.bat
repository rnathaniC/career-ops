@echo off
REM ============================================================================
REM deploy-to-production.bat — one-double-click ship for Pulse / career-ops (TD1)
REM
REM Runs the full deploy gate, then dispatches the files in dispatch-manifest's
REM "pending" list. Refuses to ship if syntax/tests/pipeline fail or if pending
REM files are not committed (dispatch-relay enforces the git-committed guard).
REM
REM Usage:  deploy-to-production.bat            (commit your work first!)
REM         deploy-to-production.bat --dry-run  (validate only, ships nothing)
REM ============================================================================
setlocal
cd /d "%~dp0"

echo [deploy] 1/4 Syntax gate...
call node check-syntax.mjs || goto :fail

echo [deploy] 2/4 Pipeline integrity...
call node verify-pipeline.mjs || goto :fail

echo [deploy] 3/4 Test suite...
call npm test --silent || goto :fail

echo [deploy] 4/4 Dispatch relay...
REM Edit the --files list to match what you're shipping, or keep in sync with
REM data/dispatch-manifest.json "pending". --allow-staged accepts staged files.
call node dispatch-relay.mjs --status

echo.
echo [deploy] Gate green. To stamp a dispatch, run e.g.:
echo   node dispatch-relay.mjs --dispatch --files package.json,scripts/export-board-state.mjs --message "ship: R1 + TD1"
echo.
goto :done

:fail
echo.
echo [deploy] ABORTED — a gate failed above. Nothing shipped.
exit /b 1

:done
echo [deploy] Done.
endlocal

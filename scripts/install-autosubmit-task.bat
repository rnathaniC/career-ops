@echo off
REM ============================================================================
REM install-autosubmit-task.bat — register the 6:10am JobPulse-AutoSubmit task.
REM Double-click ONCE (after a successful manual test of run-autosubmit.bat).
REM Runs as the logged-in user, interactively, so Edge can open on screen.
REM To remove:  schtasks /Delete /TN "JobPulse-AutoSubmit" /F
REM ============================================================================
setlocal
set TASK=JobPulse-AutoSubmit
set ACTION="%~dp0run-autosubmit.bat"

schtasks /Create /TN "%TASK%" /TR "%ACTION%" /SC DAILY /ST 06:10 /IT /RL LIMITED /F
if %ERRORLEVEL%==0 (
  echo.
  echo [ok] "%TASK%" scheduled daily at 06:10.
  echo      Verify:  schtasks /Query /TN "%TASK%"
  echo      Run now: schtasks /Run   /TN "%TASK%"
) else (
  echo.
  echo [FAIL] Could not create the task. Try running this file as Administrator.
)
pause
endlocal

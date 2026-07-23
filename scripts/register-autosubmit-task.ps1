# register-autosubmit-task.ps1
# One-time setup: registers "CareerOps-AutoSubmit" in Windows Task Scheduler.
# Run once in PowerShell as Administrator:
#   cd C:\Users\rahil\career-ops
#   powershell -ExecutionPolicy Bypass -File scripts\register-autosubmit-task.ps1
#
# The task fires at 2:06 AM daily — after the 1am Cowork scan/grade/inject finishes.
# It runs windows-autosubmit.ps1 which starts Edge with SpeedyApply and submits eligible cards.

$TaskName    = "CareerOps-AutoSubmit"
$ScriptPath  = "C:\Users\rahil\career-ops\scripts\windows-autosubmit.ps1"
$NodeCmd     = Get-Command node -ErrorAction SilentlyContinue
$NodePath    = if ($NodeCmd) { $NodeCmd.Source } else { $null }
$WorkDir     = "C:\Users\rahil\career-ops"

if (-not $NodePath) {
    Write-Host "ERROR: Node.js not found on PATH. Install Node.js first." -ForegroundColor Red
    exit 1
}

# Remove existing task if present
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# Action: run PowerShell with the wrapper script
$action  = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -NonInteractive -File `"$ScriptPath`"" `
    -WorkingDirectory $WorkDir

# Trigger: daily at 2:06 AM
$trigger = New-ScheduledTaskTrigger -Daily -At "02:06AM"

# Settings: run whether logged on or not, wake to run, don't miss a run
$settings = New-ScheduledTaskSettingsSet `
    -WakeToRun `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -RunOnlyIfNetworkAvailable

# Principal: run as the current user (keeps Edge profile access)
$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType S4U `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "CareerOps: auto-submit eligible job cards via SpeedyApply. Fires at 2:06am after Cowork scan/grade/inject." `
    -Force

Write-Host ""
Write-Host "Task registered: $TaskName" -ForegroundColor Green
Write-Host "Fires daily at 2:06 AM. Logs: C:\Users\rahil\career-ops\logs\windows-autosubmit-YYYY-MM-DD.log"
Write-Host ""
Write-Host "To test immediately (closes any open Edge first):"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "To remove:"
Write-Host "  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"

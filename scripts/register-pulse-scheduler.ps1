# ============================================================================
# register-pulse-scheduler.ps1
# Registers the career-ops nightly refresh as a NATIVE Windows Scheduled Task.
# This replaces the Claude-app "job-pulse-1am-refresh" task, which was getting
# cut off before the pipeline finished (silent misses) and skipped entirely when
# the Claude app was closed (hard misses).
#
# Runs daily at 1:00 AM, wakes the PC from sleep, catches up if the machine was
# off, and has no command-window cap. Run this ONCE from an elevated PowerShell
# (Start menu -> type "powershell" -> right-click -> Run as administrator).
# ============================================================================
$ErrorActionPreference = 'Stop'

$taskName = 'CareerOps-Pulse-1am'
$runner   = 'C:\Users\rahil\career-ops\scripts\run-pulse-refresh.cmd'

if (-not (Test-Path $runner)) {
    throw "Runner not found at $runner. Make sure the career-ops repo is at C:\Users\rahil\career-ops."
}

$action  = New-ScheduledTaskAction -Execute $runner
$trigger = New-ScheduledTaskTrigger -Daily -At 1:00AM
$settings = New-ScheduledTaskSettingsSet `
    -WakeToRun `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)
# Runs as you, only while you are logged on. To run even when logged off, open
# Task Scheduler after this, open CareerOps-Pulse-1am -> Properties -> General ->
# "Run whether user is logged on or not" (Windows will prompt for your password).
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force `
    -Description 'career-ops nightly job-pulse refresh (native, replaces the Claude-app 1am task).'

Write-Host ''
Write-Host "Registered '$taskName' - runs daily at 1:00 AM." -ForegroundColor Green
Write-Host "Test it right now with:  Start-ScheduledTask -TaskName '$taskName'"
Write-Host "Then check:              Get-Content C:\Users\rahil\career-ops\logs\scheduler-run.log -Tail 20"

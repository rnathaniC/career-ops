# windows-autosubmit.ps1
# Run by Windows Task Scheduler at 2:06 AM daily (after the 1am Cowork scan/grade/inject finishes).
# Starts Edge with remote debugging, waits for it to be ready, runs auto-submit:live via SpeedyApply.
#
# Do NOT run this manually during the day if Edge is open — it will conflict with your running profile.

$CareerOpsDir = "C:\Users\rahil\career-ops"
$LogFile      = "$CareerOpsDir\logs\windows-autosubmit-$(Get-Date -Format 'yyyy-MM-dd').log"
$Port         = 9222

function Write-Log {
    param([string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

# Ensure log directory exists
New-Item -ItemType Directory -Force -Path "$CareerOpsDir\logs" | Out-Null

Write-Log "windows-autosubmit STARTED"

# Check if something is already on port 9222
$portInUse = Test-NetConnection -ComputerName localhost -Port $Port -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
if ($portInUse.TcpTestSucceeded) {
    Write-Log "WARN: Port $Port already in use — skipping debug browser launch (may be a running Edge session)"
} else {
    # Start the debug browser as a background process
    Write-Log "Starting debug browser on port $Port..."
    $debugBrowser = Start-Process -FilePath "node" `
        -ArgumentList "scripts\launch-debug-browser.mjs --port $Port" `
        -WorkingDirectory $CareerOpsDir `
        -PassThru `
        -WindowStyle Hidden

    # Wait up to 20 seconds for the debug port to become available
    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        $check = Test-NetConnection -ComputerName localhost -Port $Port -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
        if ($check.TcpTestSucceeded) {
            $ready = $true
            Write-Log "Debug browser ready after $($i + 1)s"
            break
        }
    }

    if (-not $ready) {
        Write-Log "ERROR: Debug browser did not start within 20s. Aborting."
        if ($debugBrowser -and -not $debugBrowser.HasExited) {
            Stop-Process -Id $debugBrowser.Id -Force -ErrorAction SilentlyContinue
        }
        exit 1
    }
}

# Run auto-submit:live
Write-Log "Running npm run auto-submit:live..."
$result = Start-Process -FilePath "npm" `
    -ArgumentList "run auto-submit:live" `
    -WorkingDirectory $CareerOpsDir `
    -Wait `
    -PassThru `
    -WindowStyle Hidden

$exitCode = $result.ExitCode
Write-Log "auto-submit:live finished with exit code $exitCode"

# Clean up the debug browser we launched (if we launched it)
if ($debugBrowser -and -not $debugBrowser.HasExited) {
    Write-Log "Closing debug browser (pid $($debugBrowser.Id))..."
    Stop-Process -Id $debugBrowser.Id -Force -ErrorAction SilentlyContinue
}

Write-Log "windows-autosubmit DONE (exit $exitCode)"
exit $exitCode

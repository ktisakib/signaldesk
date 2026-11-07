[CmdletBinding()]
param([string]$ServicePath = (Join-Path $PSScriptRoot '..\target\release\broadcast-service.exe'))
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows.' }
try {
    $health = Invoke-RestMethod 'http://127.0.0.1:9780/api/health' -TimeoutSec 2
    if (!$health.ok -or $health.service -ne 'signaldesk') { throw 'Unexpected control service.' }
    Write-Host 'Broadcast service is already running on 127.0.0.1:9780.'
    return
} catch { }
if (!(Test-Path $ServicePath -PathType Leaf)) { throw 'Build the service first: cargo build --release -p broadcast-service. Or pass -ServicePath with the installed executable.' }
$service = (Resolve-Path $ServicePath).Path
if (!$env:BROADCAST_HOME) { $env:BROADCAST_HOME = Join-Path $env:LOCALAPPDATA 'SignalDesk' }
New-Item $env:BROADCAST_HOME -ItemType Directory -Force | Out-Null
$process = Start-Process $service -WorkingDirectory $env:BROADCAST_HOME -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $env:BROADCAST_HOME 'service.stdout.log') -RedirectStandardError (Join-Path $env:BROADCAST_HOME 'service.stderr.log')
foreach ($attempt in 1..30) {
    if ($process.HasExited) { throw "Broadcast service exited. Read $env:BROADCAST_HOME\service.stderr.log" }
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:9780/api/health' -TimeoutSec 1
        if (!$health.ok -or $health.service -ne 'signaldesk') { throw 'Unexpected control service.' }
        Write-Host "Broadcast service started (PID $($process.Id)). Closing this terminal or the dashboard leaves it running."
        return
    } catch { Start-Sleep -Milliseconds 300 }
}
throw "Service did not become ready. Read $env:BROADCAST_HOME\service.stderr.log"

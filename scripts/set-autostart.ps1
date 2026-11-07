[CmdletBinding()]
param(
    [string]$ServicePath = '',
    [switch]$Disable
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows.' }
$taskName = 'SignalDesk broadcast service'
if ($Disable) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host 'Sign-in autostart removed. The running service was left running.'
    return
}
if (!$ServicePath) {
    $ServicePath = Join-Path $PSScriptRoot 'broadcast-service.exe'
    if (!(Test-Path $ServicePath -PathType Leaf)) { $ServicePath = Join-Path $PSScriptRoot '..\target\release\broadcast-service.exe' }
}
if (!(Test-Path $ServicePath -PathType Leaf)) { throw 'Build the service first, or pass -ServicePath with the installed broadcast-service.exe.' }
$service = (Resolve-Path $ServicePath).Path
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$dataDirectory = Join-Path $env:LOCALAPPDATA 'SignalDesk'
New-Item $dataDirectory -ItemType Directory -Force | Out-Null
$action = New-ScheduledTaskAction -Execute $service -WorkingDirectory $dataDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Run SignalDesk after this Windows user signs in.' -Force | Out-Null
Write-Host 'Broadcast service will start when this user signs in. Keep the executable at its current path.'

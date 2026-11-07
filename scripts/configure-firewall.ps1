[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)][int]$Port = 8888,
    [string]$MediaMtxPath = (Join-Path $env:LOCALAPPDATA 'SignalDesk\runtime\bin\mediamtx.exe'),
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open PowerShell as Administrator for this optional firewall change. Runtime setup and local streaming do not need Administrator.'
}
$name = 'SignalDesk HLS viewers'
if ($Remove) {
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Host 'SignalDesk HLS firewall rule removed.'
    return
}
if (!(Test-Path $MediaMtxPath -PathType Leaf)) { throw 'Run setup-windows.ps1 first, or pass the installed MediaMTX path.' }
$program = (Resolve-Path $MediaMtxPath).Path
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Program $program -Profile Private | Out-Null
Write-Host "Allowed viewer TCP port $Port for MediaMTX on Private networks. Configure router port forwarding separately."

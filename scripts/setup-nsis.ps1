[CmdletBinding()]
param()

$tempZip = Join-Path $env:TEMP 'nsis-3.13.zip'
$tempDir = Join-Path $env:TEMP 'nsis-3.13'
$tempDll = Join-Path $env:TEMP 'nsis_tauri_utils.dll'

if (!(Test-Path $tempZip)) {
    Write-Host "Downloading nsis-3.13.zip..."
    & curl.exe -L --retry 5 --retry-delay 2 -o $tempZip "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip"
}

if (!(Test-Path $tempDir)) {
    Write-Host "Extracting nsis-3.13.zip..."
    & cmd.exe /c "tar -xf `"$tempZip`" -C `"$env:TEMP`""
}

if (!(Test-Path $tempDll)) {
    Write-Host "Downloading nsis_tauri_utils.dll..."
    & curl.exe -L --retry 5 --retry-delay 2 -o $tempDll "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll"
}

$destinations = @(
    (Join-Path $env:LOCALAPPDATA 'tauri\NSIS'),
    (Join-Path $env:USERPROFILE '.cache\tauri\NSIS'),
    (Join-Path $PSScriptRoot '..\target\.tauri\NSIS'),
    (Join-Path $PSScriptRoot '..\src-tauri\target\.tauri\NSIS')
)

foreach ($dest in $destinations) {
    $parent = Split-Path $dest -Parent
    if (!(Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    if (!(Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
    Write-Host "Populating $dest..."
    Copy-Item (Join-Path $tempDir '*') $dest -Recurse -Force
    $additionalDir = Join-Path $dest 'Plugins\x86-unicode\additional'
    if (!(Test-Path $additionalDir)) { New-Item -ItemType Directory -Path $additionalDir -Force | Out-Null }
    Copy-Item $tempDll (Join-Path $additionalDir 'nsis_tauri_utils.dll') -Force
    Copy-Item $tempDll (Join-Path $dest 'Plugins\x86-unicode\nsis_tauri_utils.dll') -Force
}

Write-Host "NSIS setup complete."


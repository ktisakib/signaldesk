[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Build the Windows x64 installer on Windows x64.' }
$project = Split-Path $PSScriptRoot -Parent
Push-Location $project
$configPath = Join-Path ([IO.Path]::GetTempPath()) ('signaldesk-bundle-' + [guid]::NewGuid() + '.json')
try {
    & npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw 'Frontend type checks failed.' }
    & npm.cmd run lint
    if ($LASTEXITCODE -ne 0) { throw 'Frontend lint failed.' }
    & cargo test -p broadcast-service
    if ($LASTEXITCODE -ne 0) { throw 'Service tests failed.' }
    & cargo build --release -p broadcast-service
    if ($LASTEXITCODE -ne 0) { throw 'Service build failed.' }
    $runtime = Join-Path $project 'src-tauri\runtime'
    New-Item $runtime -ItemType Directory -Force | Out-Null
    Copy-Item (Join-Path $project 'target\release\broadcast-service.exe') (Join-Path $runtime 'broadcast-service.exe') -Force
    $licenses = Join-Path $runtime 'licenses\fonts'
    New-Item $licenses -ItemType Directory -Force | Out-Null
    Copy-Item (Join-Path $project 'crates\broadcast-service\assets\fonts\*OFL.txt') $licenses -Force
    foreach ($file in @('setup-windows.ps1', 'runtime-downloads.json', 'set-autostart.ps1', 'configure-firewall.ps1')) {
        Copy-Item (Join-Path $PSScriptRoot $file) (Join-Path $runtime $file) -Force
    }
    $runtimeDocs = Join-Path $runtime 'docs'
    New-Item $runtimeDocs -ItemType Directory -Force | Out-Null
    foreach ($file in @('windows.md', 'internet-streaming.md', 'lan-relay.md', 'setup-guide.md', 'live-production.md', 'docker.md', 'deployment.md', 'broadcast-graphics.md')) {
        Copy-Item (Join-Path $project ('docs\' + $file)) (Join-Path $runtimeDocs $file) -Force
    }
    Copy-Item (Join-Path $project 'README.md') (Join-Path $runtime 'README.md') -Force
    $config = @{ bundle = @{ windows = @{ webviewInstallMode = @{ type = 'downloadBootstrapper' } } } } | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
    & npm.cmd run tauri -- build --bundles nsis --config $configPath
    if ($LASTEXITCODE -ne 0) { throw 'Desktop installer build failed.' }
    Write-Host 'Installer: target\release\bundle\nsis\'
    Write-Host 'The installer downloads and verifies FFmpeg, FFprobe and MediaMTX. Internet is required during installation.'
} finally {
    Remove-Item $configPath -Force -ErrorAction SilentlyContinue
    Pop-Location
}

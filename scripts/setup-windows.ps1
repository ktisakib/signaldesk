[CmdletBinding()]
param(
    [string]$RuntimeDirectory = (Join-Path $env:LOCALAPPDATA 'SignalDesk\runtime'),
    [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

function Test-SafeZipEntry([string]$Name) {
    $normalized = $Name.Replace('\', '/')
    return $normalized -notmatch '(^/|:|(^|/)\.\.(/|$))'
}

function Get-PublishedSha256([string]$Content, [string]$FileName) {
    if ($Content.Trim() -match '^[a-fA-F0-9]{64}$') { return $Content.Trim().ToLowerInvariant() }
    $pattern = '(?im)^([a-f0-9]{64})\s+\*?' + [regex]::Escape($FileName) + '\s*$'
    $found = [regex]::Matches($Content, $pattern)
    if ($found.Count -ne 1) { throw "No unique SHA-256 published for $FileName" }
    return $found[0].Groups[1].Value.ToLowerInvariant()
}

if ($SelfTest) {
    $sample = 'a' * 64
    if ((Get-PublishedSha256 "$sample  example.zip" 'example.zip') -ne $sample) { throw 'Checksum parser failed' }
    foreach ($bad in @('../bad.exe', 'dir/../bad.exe', 'C:\bad.exe', '/bad.exe', 'dir\..\bad.exe')) {
        if (Test-SafeZipEntry $bad) { throw "Unsafe archive name accepted: $bad" }
    }
    if (!(Test-SafeZipEntry 'ffmpeg-9.0.2/bin/ffmpeg.exe')) { throw 'Valid archive name rejected' }
    $rejected = $false
    try { Get-PublishedSha256 "$sample  other.zip" 'example.zip' | Out-Null } catch { $rejected = $true }
    if (!$rejected) { throw 'Missing checksum accepted' }
    $rejected = $false
    try { Get-PublishedSha256 "$sample  example.zip`n$sample  example.zip" 'example.zip' | Out-Null } catch { $rejected = $true }
    if (!$rejected) { throw 'Duplicate checksum accepted' }
    Write-Host 'Runtime setup self-check passed.'
    return
}

if ($env:OS -ne 'Windows_NT' -or ![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'This setup supports Windows 10/11 x64. Windows ARM and 32-bit builds are not supported.'
}
if ([Environment]::OSVersion.Version.Build -lt 19041) { throw 'Windows 10 version 2004 or later is required.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$manifest = Get-Content (Join-Path $PSScriptRoot 'runtime-downloads.json') -Raw | ConvertFrom-Json
$runtime = [IO.Path]::GetFullPath($RuntimeDirectory)
$bin = Join-Path $runtime 'bin'
$installedPath = Join-Path $runtime 'installed.json'

if (Test-Path $installedPath) {
    try {
        $installed = Get-Content $installedPath -Raw | ConvertFrom-Json
        $valid = $installed.versions -eq ($manifest | ConvertTo-Json -Depth 5 -Compress)
        foreach ($file in @('ffmpeg.exe', 'ffprobe.exe', 'mediamtx.exe')) {
            $path = Join-Path $bin $file
            if (!(Test-Path $path) -or (Get-FileHash $path -Algorithm SHA256).Hash -ne $installed.hashes.$file) { $valid = $false }
        }
        if ($valid) { Write-Host "Verified runtime already installed: $bin"; return }
    } catch { Write-Host 'Runtime needs repair; downloading verified archives.' }
}

$usingRuntime = @(Get-Process -Name ffmpeg, ffprobe, mediamtx -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($bin + '\', [StringComparison]::OrdinalIgnoreCase) })
if ($usingRuntime.Count) { throw 'Stop the broadcast before installing or repairing its media tools.' }

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('signaldesk-' + [guid]::NewGuid())
New-Item $temporary -ItemType Directory | Out-Null
try {
    $staging = Join-Path $temporary 'runtime'
    New-Item (Join-Path $staging 'bin') -ItemType Directory -Force | Out-Null
    foreach ($tool in $manifest) {
        if (([uri]$tool.url).Scheme -ne 'https' -or ([uri]$tool.checksumUrl).Scheme -ne 'https') { throw 'Downloads must use HTTPS.' }
        $archivePath = Join-Path $temporary $tool.fileName
        Write-Host "Downloading $($tool.name) $($tool.version)..."
        Invoke-WebRequest $tool.url -OutFile $archivePath -UseBasicParsing
        $checksumPath = Join-Path $temporary ($tool.fileName + '.sha256')
        Invoke-WebRequest $tool.checksumUrl -OutFile $checksumPath -UseBasicParsing
        $published = Get-Content $checksumPath -Raw
        $expected = Get-PublishedSha256 $published $tool.fileName
        if ($tool.sha256 -and $expected -ne $tool.sha256) { throw "Published checksum changed for $($tool.fileName)" }
        if ((Get-FileHash $archivePath -Algorithm SHA256).Hash -ne $expected) { throw "Checksum mismatch for $($tool.fileName)" }
        $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
            foreach ($entry in $archive.Entries) {
                if (!(Test-SafeZipEntry $entry.FullName)) { throw "Unsafe ZIP entry: $($entry.FullName)" }
            }
            foreach ($executable in $tool.executables) {
                $matches = @($archive.Entries | Where-Object { $_.FullName.Replace('\', '/') -match ('(^|/)' + [regex]::Escape($executable) + '$') })
                if ($matches.Count -ne 1 -or $matches[0].Length -gt 1GB) { throw "Expected exactly one $executable in archive" }
                $target = Join-Path (Join-Path $staging 'bin') $executable
                [IO.Compression.ZipFileExtensions]::ExtractToFile($matches[0], $target)
            }
            $licenseDirectory = Join-Path $staging ('licenses\' + $tool.name)
            New-Item $licenseDirectory -ItemType Directory -Force | Out-Null
            foreach ($entry in $archive.Entries | Where-Object { $_.Name -match '^(license|copying|readme)(\..*)?$' }) {
                if ($entry.Length -gt 8MB) { throw 'Unexpectedly large license file.' }
                $target = Join-Path $licenseDirectory ($entry.FullName.Replace('/', '_').Replace('\', '_'))
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target)
            }
        } finally { $archive.Dispose() }
    }
    # Copy only known executable names to fixed targets; ZIP entry paths never select a destination.
    New-Item $bin -ItemType Directory -Force | Out-Null
    foreach ($file in @('ffmpeg.exe', 'ffprobe.exe', 'mediamtx.exe')) {
        Copy-Item (Join-Path (Join-Path $staging 'bin') $file) (Join-Path $bin $file) -Force
    }
    Copy-Item (Join-Path $staging 'licenses') $runtime -Recurse -Force
    $hashes = @{}
    foreach ($file in @('ffmpeg.exe', 'ffprobe.exe', 'mediamtx.exe')) { $hashes[$file] = (Get-FileHash (Join-Path $bin $file) -Algorithm SHA256).Hash }
    @{ versions = ($manifest | ConvertTo-Json -Depth 5 -Compress); hashes = $hashes } | ConvertTo-Json -Depth 6 | Set-Content $installedPath -Encoding UTF8
    Write-Host "Runtime installed: $bin"
    Write-Host 'Restart SignalDesk if it is open. No firewall or router settings were changed.'
} finally { Remove-Item $temporary -Recurse -Force }

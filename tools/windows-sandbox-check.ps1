# A stranger's first run of the Windows zip, in Windows Sandbox.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/windows-sandbox-check.ps1
#       [-Tag v1.4.0 | -Zip release/Terramentor-<version>-win32-x64.zip]
#       [-Out <folder>] [-TimeoutMinutes 15] [-Keep] [-DryRun]
#
# No -Tag and no -Zip: the latest stable release. A release zip is checked
# against the release's SHA256SUMS before it goes anywhere.
#
# Windows Sandbox is a clean, throwaway copy of the Windows it runs on: no Node,
# no Terramentor, a browser that has never been opened, nothing on port 3001.
# tools/windows-sandbox-run.ps1 runs inside it and takes the steps a person
# takes: the zip marked as downloaded, unpacked by Explorer, the exe opened by
# a double-click, SmartScreen answered as docs/DESKTOP.md says, then a second
# double-click and Quit. Screenshots, the app's log and result.json come back
# in <Out>\out; the sandbox is closed (and with it everything that ran) unless
# -Keep leaves it open to look around.
#
# What it can see that CI and a developer's machine cannot: the Mark of the Web
# a browser adds and Explorer carries onto every unpacked file, what
# SmartScreen and Defender do with an unsigned exe they have never seen, a
# browser opened for the first time, and a Start Menu with nothing in it. What
# it cannot: another Windows version (the sandbox is always the host's build),
# Windows 11's Smart App Control, and anti-virus other than Defender.
#
# Needs the "Windows Sandbox" optional feature (Pro, Enterprise or Education;
# a restart after turning it on). Windows runs one sandbox at a time, and this
# script refuses to start a second or to close one it did not start.

param(
    [string]$Tag = '',
    [string]$Zip = '',
    [string]$Out = '',
    [int]$TimeoutMinutes = 15,
    [int]$MinFreeCommitGB = 6,
    [switch]$Keep,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'ValeraZSD/terramentor'
$root = Split-Path -Parent $PSScriptRoot
$sandboxExe = Join-Path $env:WINDIR 'System32\WindowsSandbox.exe'

function Refuse([string]$why) {
    Write-Host ('REFUSED ' + $why)
    exit 2
}

function Get-SandboxProcesses {
    @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'WindowsSandbox*' })
}

function Get-Sha256([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }

if ($Tag -and $Zip) { Refuse 'give -Tag or -Zip, not both' }

if (-not $DryRun) {
    if (-not (Test-Path -LiteralPath $sandboxExe)) {
        Refuse ('Windows Sandbox is not available here: turn on the optional feature "Windows Sandbox" ' +
            '(Windows 10 or 11 Pro, Enterprise or Education), then restart.')
    }
    $running = Get-SandboxProcesses
    if ($running.Count) {
        Refuse ('a sandbox is already running (' + (($running | ForEach-Object { $_.ProcessName }) -join ', ') +
            '); Windows runs one at a time. Close it first.')
    }
    # The sandbox is a virtual machine: its memory counts against the commit
    # limit like any other program's.
    $os = Get-CimInstance Win32_OperatingSystem
    $freeGB = [math]::Round($os.FreeVirtualMemory / 1MB, 1)
    if ($freeGB -lt $MinFreeCommitGB) {
        Refuse ("$freeGB GB of commit is free and the sandbox needs up to 4 GB; wait for something to finish (or -MinFreeCommitGB)")
    }
}

# --- the zip ----------------------------------------------------------------------
$releasesUrl = "https://github.com/$repo/releases"
if ($Zip) {
    $zipPath = (Resolve-Path -LiteralPath $Zip).Path
    $zipName = Split-Path $zipPath -Leaf
    if ($zipName -notmatch '^Terramentor-(.+)-win32-x64\.zip$') { Refuse "$zipName is not a Windows zip (Terramentor-<version>-win32-x64.zip)" }
    $version = $Matches[1]
    $sha = Get-Sha256 $zipPath
    $downloadUrl = "$releasesUrl/download/v$version/$zipName"
    Write-Host "zip       $zipPath (built here, sha256 $($sha.Substring(0, 12)))"
} else {
    $api = "https://api.github.com/repos/$repo/releases/" + $(if ($Tag) { 'tags/' + $Tag } else { 'latest' })
    try { $release = Invoke-RestMethod -Uri $api -UseBasicParsing }
    catch { Refuse ("no release " + $(if ($Tag) { $Tag } else { 'marked latest' }) + " on $repo (" + $_.Exception.Message + ')') }
    $asset = @($release.assets | Where-Object { $_.name -like '*-win32-x64.zip' }) | Select-Object -First 1
    $sums = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS' }) | Select-Object -First 1
    if (-not $asset) { Refuse "release $($release.tag_name) has no Windows zip" }
    if (-not $sums) { Refuse "release $($release.tag_name) has no SHA256SUMS to check the zip against" }
    $zipName = $asset.name
    $version = $release.tag_name -replace '^v', ''
    $downloadUrl = $asset.browser_download_url
    $cache = Join-Path $root ('temp\windows-sandbox\downloads\' + $release.tag_name)
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $sumsText = (Invoke-WebRequest -Uri $sums.browser_download_url -UseBasicParsing).Content
    if ($sumsText -is [byte[]]) { $sumsText = [Text.Encoding]::ASCII.GetString($sumsText) }
    $line = @($sumsText -split "`n" | Where-Object { $_ -match ('\s\*?' + [regex]::Escape($zipName) + '\s*$') }) | Select-Object -First 1
    if (-not $line) { Refuse "SHA256SUMS of $($release.tag_name) does not list $zipName" }
    $want = ($line -split '\s+')[0].ToLowerInvariant()
    $zipPath = Join-Path $cache $zipName
    if (-not (Test-Path -LiteralPath $zipPath) -or (Get-Sha256 $zipPath) -ne $want) {
        Write-Host "download  $downloadUrl"
        Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing
    }
    $sha = Get-Sha256 $zipPath
    if ($sha -ne $want) { Remove-Item -LiteralPath $zipPath; Refuse "the downloaded $zipName does not match SHA256SUMS" }
    Write-Host "zip       $zipName from $($release.tag_name), matches SHA256SUMS"
}

# --- the run folder ---------------------------------------------------------------
if (-not $Out) { $Out = Join-Path $root ('temp\windows-sandbox\' + $version + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$Out = [IO.Path]::GetFullPath($Out)
$inDir = Join-Path $Out 'in'
$outDir = Join-Path $Out 'out'
if (Test-Path -LiteralPath (Join-Path $outDir 'done')) { Refuse "$Out already holds a finished run; give a new -Out" }
New-Item -ItemType Directory -Force -Path $inDir, $outDir | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-sandbox-run.ps1') -Destination $inDir -Force

$run = [ordered]@{
    zipName = $zipName; zipFolder = 'C:\sandbox\zip'; sha256 = $sha; version = $version
    downloadUrl = $downloadUrl; referrerUrl = $releasesUrl
}
[IO.File]::WriteAllText((Join-Path $inDir 'run.json'), ($run | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

function X([string]$s) { [Security.SecurityElement]::Escape($s) }
# Networking stays on: SmartScreen asks Microsoft about an exe it has not seen,
# and a stranger is online. The app itself makes no connection; the run checks.
# vGPU off: the sandbox draws in software and leaves the host's GPU alone.
$wsb = @"
<Configuration>
  <vGPU>Disable</vGPU>
  <Networking>Enable</Networking>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$(X $inDir)</HostFolder>
      <SandboxFolder>C:\sandbox\in</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$(X (Split-Path $zipPath -Parent))</HostFolder>
      <SandboxFolder>C:\sandbox\zip</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$(X $outDir)</HostFolder>
      <SandboxFolder>C:\sandbox\out</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\sandbox\in\windows-sandbox-run.ps1</Command>
  </LogonCommand>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <MemoryInMB>4096</MemoryInMB>
</Configuration>
"@
$wsbPath = Join-Path $Out 'first-run.wsb'
[IO.File]::WriteAllText($wsbPath, $wsb, (New-Object Text.UTF8Encoding $false))
Write-Host "run       $Out"

if ($DryRun) {
    Write-Host 'dry run: the sandbox was not started'
    exit 0
}

# --- the sandbox ------------------------------------------------------------------
$startedAt = Get-Date
Start-Process -FilePath $sandboxExe -ArgumentList ('"' + $wsbPath + '"')
$deadline = $startedAt.AddMinutes($TimeoutMinutes)
Write-Host ("sandbox   started {0:HH:mm:ss}, gives up at {1:HH:mm:ss}" -f $startedAt, $deadline)

$progress = Join-Path $outDir 'progress.log'
$shown = 0
$ended = 'timeout'
while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $progress) {
        $lines = @(Get-Content -LiteralPath $progress -Encoding UTF8)
        for ($i = $shown; $i -lt $lines.Count; $i++) { Write-Host ('  ' + $lines[$i]) }
        $shown = $lines.Count
    }
    if (Test-Path -LiteralPath (Join-Path $outDir 'done')) { $ended = 'done'; break }
    if ((Get-Date) -gt $startedAt.AddSeconds(30) -and (Get-SandboxProcesses).Count -eq 0) { $ended = 'closed'; break }
    Start-Sleep -Seconds 2
}

# Only the sandbox this run started: processes that began after it did.
function Close-OurSandbox {
    $ours = @(Get-SandboxProcesses | Where-Object {
        try { $_.StartTime -ge $startedAt.AddSeconds(-2) } catch { $false } })
    foreach ($p in $ours) { try { Stop-Process -Id $p.Id -Force } catch { } }
    $waited = 0
    while ($waited -lt 60 -and @(Get-SandboxProcesses | Where-Object { $ours.Id -contains $_.Id }).Count) { Start-Sleep -Seconds 1; $waited++ }
    $left = @(Get-SandboxProcesses | Where-Object { $ours.Id -contains $_.Id })
    if ($left.Count) { Write-Host ('sandbox   still running: ' + (($left | ForEach-Object { $_.ProcessName }) -join ', ')) }
    else { Write-Host 'sandbox   closed' }
}

if ($Keep) { Write-Host 'sandbox   left open (-Keep); close its window to throw it away' }
elseif ($ended -ne 'closed') { Close-OurSandbox }

# --- what came back ---------------------------------------------------------------
$resultPath = Join-Path $outDir 'result.json'
if ($ended -ne 'done' -or -not (Test-Path -LiteralPath $resultPath)) {
    if ($ended -eq 'closed') { Write-Host 'FAIL the sandbox closed before the run finished' }
    else { Write-Host "FAIL no result within $TimeoutMinutes minutes" }
    Write-Host "     what there is: $outDir"
    exit 3
}
$result = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ''
Write-Host ("{0} {1} on {2} ({3}), {4} s" -f $result.verdict.ToUpperInvariant(), $result.zip, $result.os, $result.uiCulture, $result.seconds)
foreach ($f in @($result.failures)) { if ($f) { Write-Host ('  FAIL ' + $f) } }
foreach ($n in @($result.notes)) { if ($n) { Write-Host ('  note ' + $n) } }
Write-Host ('  shots ' + ((Get-ChildItem -LiteralPath $outDir -Filter *.png | Sort-Object LastWriteTime | ForEach-Object { $_.Name }) -join ', '))
Write-Host ('  in    ' + $outDir)
if ($result.verdict -eq 'pass') { exit 0 } else { exit 1 }

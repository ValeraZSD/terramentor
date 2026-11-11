# A stranger's first run of the Windows zip, in Windows Sandbox.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/windows-sandbox-check.ps1
#       [-Tag v1.4.0 | -Zip release/Terramentor-<version>-win32-x64.zip]
#       [-Out <folder>] [-TimeoutMinutes 30] [-MinFreeCommitGB 6] [-Watch] [-Keep] [-DryRun]
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
# The sandbox's window is kept off the screen while it runs, the keyboard is
# taken back from it each time it grabs it while starting, and inside it the run
# turns sound off, so the machine stays usable meanwhile. -Watch leaves the
# window where Windows puts it; -Keep brings it back once the run is over. The
# sandbox is a virtual machine at normal priority on every processor (Windows
# does not let a user lower it): run it when nothing heavy is running.
#
# What it can see that CI and a developer's machine cannot: the Mark of the Web
# a browser adds and Explorer carries onto every unpacked file, what
# SmartScreen does with an unsigned exe it has never seen, a browser opened for
# the first time, and a Start Menu with nothing in it. What it cannot: another
# Windows version (the sandbox is always the host's build), Windows 11's Smart
# App Control, a UAC prompt (the sandbox runs with UAC off), and anti-virus.
# Defender's service was stopped in the sandbox of Windows 10 22H2; the run
# reads its state and says so when it is not scanning.
#
# Needs the "Windows Sandbox" optional feature (Pro, Enterprise or Education;
# a restart after turning it on). Windows runs one sandbox at a time, and this
# script refuses to start a second or to close one it did not start.

param(
    [string]$Tag = '',
    [string]$Zip = '',
    [string]$Out = '',
    # A run of 1.4.0 took two minutes inside; Explorer's zip folder alone can
    # take three on a desktop whose anti-virus scans every file.
    [int]$TimeoutMinutes = 30,
    [int]$MinFreeCommitGB = 6,
    [switch]$Watch,
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
        # Its window may be past the edge of the screen, left by a run that was killed.
        Refuse ('a sandbox is already running (' + (($running | ForEach-Object { $_.ProcessName }) -join ', ') +
            '); Windows runs one at a time. Close it first: Get-Process WindowsSandbox* | Stop-Process')
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
if ((Test-Path -LiteralPath $outDir) -and @(Get-ChildItem -LiteralPath $outDir -Force).Count) { Refuse "$outDir already holds a run; give a new -Out" }
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
# Only the sandbox this run started: processes that began after it did.
function Close-OurSandbox {
    $ours = @(Get-SandboxProcesses | Where-Object {
        try { $_.StartTime -ge $startedAt.AddSeconds(-2) } catch { $false } })
    if (-not $ours.Count) { Write-Host 'sandbox   none of its processes found to close'; return }
    foreach ($p in $ours) { try { Stop-Process -Id $p.Id -Force } catch { } }
    $waited = 0
    while ($waited -lt 60 -and @(Get-SandboxProcesses | Where-Object { $ours.Id -contains $_.Id }).Count) { Start-Sleep -Seconds 1; $waited++ }
    $left = @(Get-SandboxProcesses | Where-Object { $ours.Id -contains $_.Id })
    if ($left.Count) { Write-Host ('sandbox   still running: ' + (($left | ForEach-Object { $_.ProcessName }) -join ', ')) }
    else { Write-Host 'sandbox   closed' }
}

# The sandbox's windows go past the right edge of every screen, not minimised:
# a minimised remote session may stop drawing, and the run photographs what it
# draws. SetWindowPos, not SetWindowPlacement: that one pulls a window that
# would be off every screen back onto one.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SandboxCheckWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    const uint NOSIZE = 0x1, NOZORDER = 0x4, NOACTIVATE = 0x10, SHOWWINDOW = 0x40, ASYNC = 0x4000;
    const int HIDE = 0, MINIMIZE = 6, SHOW_NO_ACTIVATE = 4;
    static List<IntPtr> Windows(uint pid) {
        var found = new List<IntPtr>();
        EnumWindows((h, p) => { uint owner; GetWindowThreadProcessId(h, out owner);
            if (owner == pid && IsWindowVisible(h)) found.Add(h); return true; }, IntPtr.Zero);
        return found;
    }
    static bool Away(IntPtr h, int screenRight) { RECT r; return GetWindowRect(h, out r) && r.Left >= screenRight; }
    // Where each window first appeared, and which have been past the edge.
    static readonly Dictionary<IntPtr, RECT> first = new Dictionary<IntPtr, RECT>();
    static readonly HashSet<IntPtr> keptAway = new HashSet<IntPtr>();
    public static int KeptAway { get { return keptAway.Count; } }
    public static string FirstSeen(int screenRight) {
        var said = new List<string>();
        foreach (var r in first.Values)
            said.Add(r.Left + "," + r.Top + (r.Left >= screenRight ? " (already past the edge)" : ""));
        return string.Join("; ", said);
    }
    // How many of the process's windows it moved. One already away is left be,
    // and so is one somebody minimised.
    public static int MoveAway(uint pid, int screenRight) {
        int moved = 0;
        foreach (var h in Windows(pid)) {
            RECT r;
            if (!first.ContainsKey(h) && GetWindowRect(h, out r)) first[h] = r;
            if (IsIconic(h)) continue;
            if (!Away(h, screenRight)) {
                SetWindowPos(h, IntPtr.Zero, screenRight + 64, 0, 0, 0, NOSIZE | NOZORDER | NOACTIVATE | ASYNC);
                moved++;
            }
            keptAway.Add(h);
        }
        return moved;
    }
    // Before the sandbox closes: the client opens the next sandbox where its
    // window last was, so it goes back to where it first appeared (or, if that
    // was past the edge too, the screen's corner), hidden first so the move
    // does not show.
    public static void PutBack(uint pid, int left, int top, int screenRight) {
        foreach (var h in Windows(pid)) {
            RECT f; bool known = first.TryGetValue(h, out f) && f.Left < screenRight;
            ShowWindowAsync(h, HIDE);
            SetWindowPos(h, IntPtr.Zero, known ? f.Left : left, known ? f.Top : top, 0, 0, NOSIZE | NOZORDER | NOACTIVATE | ASYNC);
        }
    }
    // The sandbox takes the keyboard when its splash opens, and its window again
    // when it opens and connects; the hidden splash can keep it. It goes back
    // to the window that had it: joined to the input of the thread holding it,
    // this process may hand it on. Failing that, a visible sandbox window is
    // minimised, which lets Windows activate the window under it; that takes a
    // moment, and restoring before it leaves the keyboard where it was
    // (measured). Async calls: a sandbox busy connecting must not stall the run.
    public static bool GiveBackKeyboard(uint[] pids, IntPtr userWindow, int screenRight) {
        IntPtr h = GetForegroundWindow(); uint owner;
        uint thread = GetWindowThreadProcessId(h, out owner);
        if (Array.IndexOf(pids, owner) < 0) return false;
        uint userOwner = 0;
        if (userWindow != IntPtr.Zero && IsWindow(userWindow)) GetWindowThreadProcessId(userWindow, out userOwner);
        if (userOwner != 0 && Array.IndexOf(pids, userOwner) < 0) {
            uint me = GetCurrentThreadId();
            bool joined = AttachThreadInput(me, thread, true);
            SetForegroundWindow(userWindow);
            if (joined) AttachThreadInput(me, thread, false);
            if (GetForegroundWindow() == userWindow) return true;
        }
        if (!IsWindowVisible(h) || IsIconic(h)) return false;
        ShowWindowAsync(h, MINIMIZE);
        for (int i = 0; i < 20 && GetForegroundWindow() == h; i++) System.Threading.Thread.Sleep(50);
        System.Threading.Thread.Sleep(100);
        ShowWindowAsync(h, SHOW_NO_ACTIVATE);
        // A window that was maximised comes back maximised, on the screen.
        System.Threading.Thread.Sleep(100);
        if (!IsIconic(h) && !Away(h, screenRight))
            SetWindowPos(h, IntPtr.Zero, screenRight + 64, 0, 0, 0, NOSIZE | NOZORDER | NOACTIVATE | ASYNC);
        return GetForegroundWindow() != h;
    }
    // -Keep: back on the screen, still without the keyboard.
    public static void Bring(uint pid, int left, int top) {
        foreach (var h in Windows(pid)) {
            if (IsIconic(h)) ShowWindowAsync(h, SHOW_NO_ACTIVATE);
            SetWindowPos(h, IntPtr.Zero, left, top, 0, 0, NOSIZE | NOZORDER | NOACTIVATE | SHOWWINDOW | ASYNC);
        }
    }
}
'@
Add-Type -AssemblyName System.Windows.Forms
[void][SandboxCheckWindow]::SetProcessDPIAware()   # the same pixels as the window rectangles
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$movedAway = 0
$keyboardBack = 0
$hideError = $null
# Whose window the keyboard went back to: the one it was taken from, or not.
$userWindow = [SandboxCheckWindow]::GetForegroundWindow()
$keyboardTo = @{}
# The launcher (its splash) and the client (the sandbox's screen).
function Get-OurClients {
    @(Get-Process -Name WindowsSandbox, WindowsSandboxClient -ErrorAction SilentlyContinue | Where-Object {
        try { $_.StartTime -ge $startedAt.AddSeconds(-2) } catch { $false } })
}
function Hide-SandboxWindow {
    # The sandbox takes the keyboard while it opens and connects; after that, a
    # sandbox in front is one somebody brought there, and is left there.
    $handBack = (Get-Date) -lt $startedAt.AddSeconds(120)
    $ours = @(Get-OurClients)
    try {
        foreach ($p in $ours) { $script:movedAway += [SandboxCheckWindow]::MoveAway([uint32]$p.Id, $screen.Right) }
        $pids = [uint32[]]@($ours | ForEach-Object { [uint32]$_.Id })
        if ($handBack -and $pids.Count -and [SandboxCheckWindow]::GiveBackKeyboard($pids, $userWindow, $screen.Right)) {
            $script:keyboardBack++
            $now = [SandboxCheckWindow]::GetForegroundWindow()
            $script:keyboardTo[$(if ($now -eq $userWindow) { 'the window that had it' } else { 'another window' })] = $true
        }
    } catch { if (-not $script:hideError) { $script:hideError = $_.Exception.Message } }
}
function Show-SandboxWindow {
    foreach ($p in Get-OurClients) {
        try { [SandboxCheckWindow]::Bring([uint32]$p.Id, $screen.Left + 64, $screen.Top + 64) } catch { }
    }
}
function Put-SandboxWindowBack {
    $ours = @(Get-OurClients)
    foreach ($p in $ours) {
        try { [SandboxCheckWindow]::PutBack([uint32]$p.Id, $screen.Left + 64, $screen.Top + 64, $screen.Right) } catch { }
    }
    if ($ours.Count) { Start-Sleep -Milliseconds 300 }   # the moves are posted; let them land
}

$progress = Join-Path $outDir 'progress.log'
$shown = 0
function Show-Progress {
    if (-not (Test-Path -LiteralPath $progress)) { return }
    try { $lines = @(Get-Content -LiteralPath $progress -Encoding UTF8 -ErrorAction Stop) } catch { return }
    for ($i = $script:shown; $i -lt $lines.Count; $i++) { Write-Host ('  ' + $lines[$i]) }
    if ($lines.Count -gt $script:shown) { $script:shown = $lines.Count }
}

$startedAt = Get-Date
$deadline = $startedAt.AddMinutes($TimeoutMinutes)
$ended = 'timeout'
Start-Process -FilePath $sandboxExe -ArgumentList ('"' + $wsbPath + '"')
Write-Host ("sandbox   started {0:HH:mm:ss}, gives up at {1:HH:mm:ss}" -f $startedAt, $deadline)
# finally: Ctrl+C or an error here must not leave the sandbox running, or the
# next run refuses to start.
try {
    while ((Get-Date) -lt $deadline) {
        # Every pass: the client may draw a new main window after its splash.
        if (-not $Watch) { Hide-SandboxWindow }
        Show-Progress
        if (Test-Path -LiteralPath (Join-Path $outDir 'done')) { $ended = 'done'; break }
        if ((Get-Date) -gt $startedAt.AddSeconds(30) -and (Get-SandboxProcesses).Count -eq 0) { $ended = 'closed'; break }
        # Quick until the first window is away (it opens in front, holding the
        # keyboard), for a minute at most.
        if (-not $Watch -and [SandboxCheckWindow]::KeptAway -eq 0 -and (Get-Date) -lt $startedAt.AddSeconds(60)) { Start-Sleep -Milliseconds 100 }
        else { Start-Sleep -Milliseconds 500 }
    }
    Show-Progress   # the lines written just before `done`
} finally {
    if (-not $Watch) {
        if ([SandboxCheckWindow]::KeptAway -eq 0) {
            Write-Host ('WARNING   the sandbox window was never off the screen' + $(if ($hideError) { ': ' + $hideError } else { '' }))
        } else {
            $to = $(if ($keyboardTo.Count) { ' to ' + (@($keyboardTo.Keys) -join ' and ') } else { '' })
            Write-Host ("sandbox   window kept off the screen ($movedAway moves; first seen at " +
                [SandboxCheckWindow]::FirstSeen($screen.Right) + "; keyboard taken back $keyboardBack times$to)")
        }
    }
    if ($Keep) {
        if (-not $Watch) { Show-SandboxWindow }
        Write-Host 'sandbox   left open (-Keep); close its window to throw it away'
    }
    elseif ($ended -ne 'closed') {
        if (-not $Watch) { Put-SandboxWindowBack }
        Close-OurSandbox
    }
}

# --- what came back ---------------------------------------------------------------
$resultPath = Join-Path $outDir 'result.json'
if ($ended -ne 'done') {
    if ($ended -eq 'closed') { Write-Host 'FAIL the sandbox closed before the run finished' }
    else { Write-Host "FAIL no result within $TimeoutMinutes minutes" }
    Write-Host "     what there is: $outDir"
    exit 3
}
try { $result = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json }
catch {
    Write-Host ('FAIL the run finished but its result.json does not read: ' + $_.Exception.Message)
    Write-Host "     what there is: $outDir"
    exit 3
}
Write-Host ''
Write-Host ([string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0} {1} on {2} ({3}), {4} s',
    $result.verdict.ToUpperInvariant(), $result.zip, $result.os, $result.uiCulture, $result.seconds))
foreach ($f in @($result.failures)) { if ($f) { Write-Host ('  FAIL ' + $f) } }
foreach ($n in @($result.notes)) { if ($n) { Write-Host ('  note ' + $n) } }
Write-Host ('  shots ' + ((Get-ChildItem -LiteralPath $outDir -Filter *.png | Sort-Object LastWriteTime | ForEach-Object { $_.Name }) -join ', '))
Write-Host ('  in    ' + $outDir)
if ($result.verdict -eq 'pass') { exit 0 } else { exit 1 }

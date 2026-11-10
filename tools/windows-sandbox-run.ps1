# Runs INSIDE Windows Sandbox: a stranger's first run of the Windows zip.
#
# Started by tools/windows-sandbox-check.ps1, which maps three folders in:
#   C:\sandbox\in   read-only: this script and run.json
#   C:\sandbox\zip  read-only: the folder holding the zip
#   C:\sandbox\out  writable:  everything this script reports
#
# The steps are the ones a person takes, by the routes Windows takes them:
#   1. the zip lands in Downloads marked as downloaded from the internet (the
#      Zone.Identifier stream a browser writes);
#   2. it is unpacked by Explorer's own zip folder ("Extract All"), which
#      carries the mark onto every file it writes;
#   3. Terramentor.exe is opened through Explorer, as a double-click is, so
#      SmartScreen and the Attachment Manager see it as a person's launch;
#   4. whatever Windows asks is photographed, then answered the way
#      docs/DESKTOP.md tells a person to answer it (More info, Run anyway);
#   5. the first screen is photographed once the page is alive;
#   6. a second double-click, then Quit.
#
# Each step is written to progress.log as it happens and to result.json at the
# end; the host stops the sandbox once `done` exists. Nothing here may run
# outside a sandbox: it adds a Start Menu shortcut, writes a library into
# %LOCALAPPDATA% and quits whatever Terramentor answers on 127.0.0.1.
#
#   -ProbeOnly <dir>  take one screenshot and list the top-level windows into
#                     <dir>, change nothing. Allowed anywhere, for checking the
#                     helpers on the machine that will start the sandbox.

param(
    [string]$In = 'C:\sandbox\in',
    [string]$Out = 'C:\sandbox\out',
    [string]$ProbeOnly = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Kept, not thrown: a run that cannot load its helpers must still write `done`,
# or the host waits for its deadline.
$setupError = $null
try {
    # Physical pixels in the screenshots, not the scaled desktop.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SandboxRunNative {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
    [void][SandboxRunNative]::SetProcessDPIAware()
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
    $UIA = [System.Windows.Automation.AutomationElement]
    $Scope = [System.Windows.Automation.TreeScope]
    $AnyElement = [System.Windows.Automation.Condition]::TrueCondition
} catch { $setupError = $_.Exception.Message }

$clock = [Diagnostics.Stopwatch]::StartNew()
$result = [ordered]@{ verdict = 'unfinished'; steps = @(); failures = @(); notes = @() }

function Stamp { '{0:mm\:ss}' -f $clock.Elapsed }

function Say([string]$text) {
    Add-Content -LiteralPath (Join-Path $Out 'progress.log') -Value ('[' + (Stamp) + '] ' + $text) -Encoding UTF8
}

function Step([string]$name, [bool]$ok, [string]$detail) {
    $result.steps += [ordered]@{ step = $name; ok = $ok; at = [math]::Round($clock.Elapsed.TotalSeconds, 1); detail = $detail }
    $line = $name
    if ($detail) { $line += ': ' + $detail }
    if ($ok) { Say ('ok ' + $line) } else { Say ('FAIL ' + $line); $result.failures += $line }
}

function Note([string]$text) {
    $result.notes += $text
    Say ('note ' + $text)
}

function Save-Screen([string]$name) {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
        $bmp.Save((Join-Path $Out ($name + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
        Say ('screenshot ' + $name + '.png')
    } finally { $g.Dispose(); $bmp.Dispose() }
}

function Write-Json([string]$name, $value) {
    $text = $value | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $Out $name), $text, (New-Object Text.UTF8Encoding $false))
}

function Get-ProcessName([int]$id) {
    try { (Get-Process -Id $id -ErrorAction Stop).ProcessName } catch { '?' }
}

# Every top-level window: its handle, owning process, class and title.
function Get-TopWindows {
    $list = @()
    foreach ($w in $UIA::RootElement.FindAll($Scope::Children, $AnyElement)) {
        try {
            $c = $w.Current
            $list += [pscustomobject]@{
                Handle = [int64]$c.NativeWindowHandle; Pid = $c.ProcessId
                Process = Get-ProcessName $c.ProcessId; Class = $c.ClassName; Name = $c.Name; Element = $w
            }
        } catch { }   # a window that closed while being read
    }
    $list
}

# A window's whole tree as indented lines: control type, name, automation id.
function Get-Tree($element) {
    $lines = @()
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($element, 0))
    while ($stack.Count -gt 0) {
        $pair = $stack.Pop()
        $e = $pair[0]; $depth = $pair[1]
        try {
            $c = $e.Current
            $lines += ('  ' * $depth) + $c.ControlType.ProgrammaticName.Replace('ControlType.', '') +
                ' "' + $c.Name + '" id=' + $c.AutomationId
        } catch { continue }
        if ($depth -ge 12) { continue }
        $children = @()
        $child = $walker.GetFirstChild($e)
        while ($child -ne $null) { $children += $child; $child = $walker.GetNextSibling($child) }
        for ($i = $children.Count - 1; $i -ge 0; $i--) { $stack.Push(@($children[$i], $depth + 1)) }
    }
    $lines
}

function Find-All($element, $controlType) {
    $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, $controlType)
    @($element.FindAll($Scope::Descendants, $cond))
}

function Invoke-Element($e) {
    $pattern = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke(); return $true
    }
    return $false
}

if ($ProbeOnly) {
    if ($setupError) { [Console]::Error.WriteLine('setup failed: ' + $setupError); exit 1 }
    $Out = $ProbeOnly
    New-Item -ItemType Directory -Force -Path $Out | Out-Null
    Save-Screen 'probe'
    Get-TopWindows | ForEach-Object { '{0,-20} {1,-28} {2}' -f $_.Process, $_.Class, $_.Name } |
        Set-Content -LiteralPath (Join-Path $Out 'probe-windows.txt') -Encoding UTF8
    exit 0
}

if ($env:USERNAME -ne 'WDAGUtilityAccount') {
    [Console]::Error.WriteLine('This script changes the machine it runs on and runs only inside Windows Sandbox.')
    exit 2
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null

try {
    if ($setupError) { throw ('setup failed: ' + $setupError) }
    $run =Get-Content -LiteralPath (Join-Path $In 'run.json') -Raw | ConvertFrom-Json
    $result.zip = $run.zipName
    $result.sha256 = $run.sha256
    $result.version = $run.version
    Say ('first run of ' + $run.zipName)

    # --- the machine ------------------------------------------------------------
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $result.os = $cv.ProductName + ' ' + $cv.DisplayVersion + ' build ' + $cv.CurrentBuild + '.' + $cv.UBR
    $result.uiCulture = (Get-UICulture).Name
    $result.uacEnabled = ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System').EnableLUA -eq 1)
    $result.scriptElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $result.screen = '' + $screen.Width + 'x' + $screen.Height
    $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    $result.edge = $(if ($edge) { (Get-Item -LiteralPath $edge).VersionInfo.ProductVersion } else { $null })
    try {
        $mp = Get-MpComputerStatus
        $result.defender = [ordered]@{
            service = $mp.AMServiceEnabled; antivirus = $mp.AntivirusEnabled; realTime = $mp.RealTimeProtectionEnabled
            mode = '' + $mp.AMRunningMode; signatures = '' + $mp.AntivirusSignatureVersion
        }
    } catch { $result.defender = 'unavailable: ' + $_.Exception.Message }
    $result.smartScreen = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer' -ErrorAction SilentlyContinue).SmartScreenEnabled
    Say ($result.os + ', ' + $result.uiCulture + ', Edge ' + $result.edge + ', screen ' + $result.screen)

    # --- 1. downloaded ----------------------------------------------------------
    $downloads = Join-Path $env:USERPROFILE 'Downloads'
    New-Item -ItemType Directory -Force -Path $downloads | Out-Null
    $zip = Join-Path $downloads $run.zipName
    Copy-Item -LiteralPath (Join-Path $run.zipFolder $run.zipName) -Destination $zip
    # What a browser writes beside a download: zone 3 is the internet.
    $mark = "[ZoneTransfer]`r`nZoneId=3`r`nReferrerUrl=$($run.referrerUrl)`r`nHostUrl=$($run.downloadUrl)`r`n"
    Set-Content -LiteralPath $zip -Stream Zone.Identifier -Value $mark -Encoding Ascii -NoNewline
    $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    Step 'download' ($hash -eq $run.sha256) ('in Downloads, marked as from the internet, sha256 ' + $hash.Substring(0, 12))

    # --- 2. Extract All ---------------------------------------------------------
    # Explorer's wizard proposes a folder named after the zip, beside it; the
    # zip holds one top folder of the same name, so the app ends up one level
    # further down. CopyHere on the zip's shell namespace is that wizard's
    # engine (zipfldr), carrying the mark included.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    $expected = @($archive.Entries | Where-Object { $_.Name }).Count
    $archive.Dispose()
    $extractTo = Join-Path $downloads ([IO.Path]::GetFileNameWithoutExtension($run.zipName))
    New-Item -ItemType Directory -Force -Path $extractTo | Out-Null
    $shell = New-Object -ComObject Shell.Application
    $t0 = $clock.Elapsed.TotalSeconds
    # 4: no progress window, 16: yes to all, 1024: no error dialog.
    $shell.NameSpace($extractTo).CopyHere($shell.NameSpace($zip).Items(), 4 + 16 + 1024)
    # CopyHere can return before the last file is written: wait for the count.
    $count = 0; $still = 0; $last = -1
    while ($clock.Elapsed.TotalSeconds - $t0 -lt 600) {
        $count = @(Get-ChildItem -LiteralPath $extractTo -Recurse -File -Force -ErrorAction SilentlyContinue).Count
        if ($count -ge $expected) { break }
        if ($count -eq $last) { $still++ } else { $still = 0 }
        if ($still -ge 30) { break }   # a minute without a new file
        $last = $count
        Start-Sleep -Seconds 2
    }
    $result.extractSeconds = [math]::Round($clock.Elapsed.TotalSeconds - $t0, 1)
    Step 'extract' ($count -ge $expected) ("$count of $expected files in $($result.extractSeconds) s by Explorer's zip folder")

    $appDir = (Get-ChildItem -LiteralPath $extractTo -Directory | Select-Object -First 1).FullName
    $exe = Join-Path $appDir 'Terramentor.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "no Terramentor.exe under $extractTo" }
    $motw = [ordered]@{}
    foreach ($f in @($zip, $exe, (Join-Path $appDir 'runtime\node.exe'))) {
        $zone = 'none'
        try { $zone = ((Get-Content -LiteralPath $f -Stream Zone.Identifier -ErrorAction Stop) -match '^ZoneId=') -join '' } catch { }
        $motw[(Split-Path $f -Leaf)] = $zone
    }
    $result.markOfTheWeb = $motw
    # Without the mark on the exe Windows would not ask what it asks a
    # stranger, and the rest of the run would prove less than it says.
    Step 'mark carried onto the app' ($motw['Terramentor.exe'] -eq 'ZoneId=3') (($motw.Keys | ForEach-Object { $_ + ' ' + $motw[$_] }) -join ', ')

    # --- 3 and 4. double-click, and what Windows asks ---------------------------
    $profileDir = (Join-Path $env:LOCALAPPDATA 'Terramentor\browser-profile').ToLowerInvariant()

    function Find-Server {
        foreach ($p in 3001..3010) {
            try {
                $s = Invoke-RestMethod -Uri "http://127.0.0.1:$p/api/desktop/status" -TimeoutSec 2
                if ($s.app -eq 'terramentor') { return $p }
            } catch { }
        }
        return $null
    }

    function Get-AppProcesses {
        $all = @(Get-CimInstance Win32_Process)
        $root = $appDir.ToLowerInvariant()
        [pscustomobject]@{
            Tray = @($all | Where-Object { $_.Name -eq 'Terramentor.exe' })
            Server = @($all | Where-Object { $_.Name -eq 'node.exe' -and $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().StartsWith($root) })
            # Every process of the app window's own browser profile.
            Browser = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($profileDir) })
        }
    }

    # SmartScreen's prompt. On Windows 10 22H2 it is an ApplicationFrameWindow
    # of explorer holding a CoreWindow of CHXSmartScreen, drawn a moment after
    # the frame; elsewhere it may be smartscreen.exe's own window. Returns the
    # element that holds its controls, or nothing.
    function Get-SmartScreenContent($w, [int]$waitSeconds) {
        $until = $clock.Elapsed.TotalSeconds + $waitSeconds
        while ($true) {
            try {
                if ($w.Process -like '*smartscreen*') { return $w.Element }
                foreach ($e in (Find-All $w.Element ([System.Windows.Automation.ControlType]::Window))) {
                    if ((Get-ProcessName $e.Current.ProcessId) -like '*smartscreen*') { return $e }
                }
            } catch { return $null }   # the window went away
            if ($clock.Elapsed.TotalSeconds -ge $until) { return $null }
            Start-Sleep -Milliseconds 500
        }
    }

    # A dialog's own buttons, left to right: not the title bar's Close.
    function Get-DialogButtons($root) {
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        @(Find-All $root ([System.Windows.Automation.ControlType]::Button) | Where-Object {
            $c = $_.Current
            $parent = $walker.GetParent($_)
            $c.Name -and -not $c.IsOffscreen -and $c.IsEnabled -and -not ($parent -and (
                $parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::TitleBar -or
                $parent.Current.AutomationId -eq 'TitleBar'))
        } | Sort-Object { $_.Current.BoundingRectangle.X })
    }

    # Answers one dialog the way docs/DESKTOP.md tells a person to. SmartScreen
    # first shows a link (More info) and one button (Don't run); the link
    # brings Run anyway, left of Don't run. The Attachment Manager's "Open
    # File - Security Warning" has Run left of Cancel and a help link that is
    # never pressed (it opens a browser). Positions, not words: the sandbox
    # speaks the host's language (a left-to-right one is assumed). A slow
    # sandbox may draw the controls late, so it looks again for 15 s.
    function Answer-Dialog($root, [bool]$smartScreen, $entry, [string]$tag) {
        $linkPressed = -not $smartScreen
        $names = ''
        $until = $clock.Elapsed.TotalSeconds + 15
        while ($clock.Elapsed.TotalSeconds -lt $until) {
            try {
                if (-not $linkPressed) {
                    $links = Find-All $root ([System.Windows.Automation.ControlType]::Hyperlink)
                    if ($links.Count -gt 0) {
                        $name = $links[0].Current.Name
                        if (Invoke-Element $links[0]) {
                            $entry.actions += 'pressed link "' + $name + '"'
                            $linkPressed = $true
                            Start-Sleep -Milliseconds 1200
                            Save-Screen ($tag + '-more')
                            (Get-Tree $root) | Set-Content -LiteralPath (Join-Path $Out ($tag + '-more.uia.txt')) -Encoding UTF8
                            continue
                        }
                    }
                }
                $buttons = @(Get-DialogButtons $root)
                $names = ($buttons | ForEach-Object { '"' + $_.Current.Name + '"' }) -join ', '
                if ($linkPressed -and $buttons.Count -ge 2) {
                    $name = $buttons[0].Current.Name
                    if (Invoke-Element $buttons[0]) { $entry.actions += 'pressed button "' + $name + '"'; return }
                }
            } catch {
                $entry.actions += 'the window went away: ' + $_.Exception.Message
                return
            }
            Start-Sleep -Milliseconds 500
        }
        if (-not $linkPressed) { $entry.actions += 'left open: no link within 15 s; buttons ' + $names }
        else { $entry.actions += 'left open: no second button within 15 s; buttons ' + $names }
    }

    # Opens the exe as a double-click does and answers what Windows puts up.
    # Only a dialog (SmartScreen's, or a classic #32770 box) is ever pressed;
    # any other new window is photographed and left alone. Explorer's own
    # windows count only as a #32770 box or as SmartScreen's frame.
    function Open-AsDoubleClick([int]$n) {
        $before = @(Get-TopWindows | ForEach-Object { $_.Handle })
        $launchedAt = $clock.Elapsed.TotalSeconds
        Start-Process -FilePath "$env:WINDIR\explorer.exe" -ArgumentList ('"' + $exe + '"')
        $asked = @()
        $seen = @{}
        while ($clock.Elapsed.TotalSeconds - $launchedAt -lt 45) {
            $new = @(Get-TopWindows | Where-Object {
                $before -notcontains $_.Handle -and -not $seen.ContainsKey($_.Handle) -and
                $_.Process -notin @('msedge', 'node', 'powershell', 'conhost') -and
                -not ($_.Process -eq 'explorer' -and $_.Class -notin @('#32770', 'ApplicationFrameWindow')) })
            foreach ($w in $new) {
                $seen[$w.Handle] = $true
                $tag = 'launch' + $n + '-window' + ($asked.Count + 1)
                Start-Sleep -Milliseconds 800   # let it finish drawing
                Save-Screen $tag
                (Get-Tree $w.Element) | Set-Content -LiteralPath (Join-Path $Out ($tag + '.uia.txt')) -Encoding UTF8
                $entry = [ordered]@{ process = $w.Process; title = $w.Name; class = $w.Class; screenshot = $tag + '.png'; actions = @() }
                $asked += $entry
                if ($w.Process -eq 'Terramentor') { $entry.actions += 'left open: the launcher reports an error'; continue }
                $wait = 0
                if ($w.Class -eq 'ApplicationFrameWindow') { $wait = 10 }
                $content = Get-SmartScreenContent $w $wait
                if ($content) { Answer-Dialog $content $true $entry $tag }
                elseif ($w.Class -eq '#32770') { Answer-Dialog $w.Element $false $entry $tag }
                else { $entry.actions += 'left alone: not a dialog' }
            }
            $up = (Get-AppProcesses).Server.Count -gt 0
            if ($up -and ($asked.Count -gt 0 -or $clock.Elapsed.TotalSeconds - $launchedAt -gt 8)) { break }
            Start-Sleep -Milliseconds 500
        }
        , $asked
    }

    $launchAt = $clock.Elapsed.TotalSeconds
    $asked1 = Open-AsDoubleClick 1
    $result.firstDoubleClick = $asked1
    if ($asked1.Count -eq 0) { Note 'Windows asked nothing on the first double-click' }
    foreach ($a in $asked1) { Note ('first double-click: ' + $a.process + ' "' + $a.title + '" -> ' + ($a.actions -join '; ')) }

    # --- 5. the first screen ----------------------------------------------------
    $port = $null
    while (-not $port -and $clock.Elapsed.TotalSeconds - $launchAt -lt 180) {
        $port = Find-Server
        if (-not $port) { Start-Sleep -Seconds 1 }
    }
    $result.port = $port
    if ($port) { $detail = 'port ' + $port + ', ' + [math]::Round($clock.Elapsed.TotalSeconds - $launchAt, 1) + ' s after the double-click' }
    else { $detail = 'nothing on 3001-3010 within 180 s' }
    Step 'server answers' ([bool]$port) $detail

    $clients = 0
    if ($port) {
        # The page heartbeats once its script runs: one client is a drawn page.
        while ($clients -lt 1 -and $clock.Elapsed.TotalSeconds - $launchAt -lt 240) {
            try { $clients = (Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/desktop/info" -TimeoutSec 3).clients } catch { }
            if ($clients -lt 1) { Start-Sleep -Seconds 1 }
        }
    }
    $result.firstScreenSeconds = [math]::Round($clock.Elapsed.TotalSeconds - $launchAt, 1)
    if ($clients -ge 1) { $detail = 'page alive ' + $result.firstScreenSeconds + ' s after the double-click' } else { $detail = 'no page connected within 240 s' }
    Step 'window shows the app' ($clients -ge 1) $detail
    Start-Sleep -Seconds 4   # fonts, the first card's arrival
    Save-Screen 'first-screen'

    $procs = Get-AppProcesses
    $result.processes = [ordered]@{ tray = $procs.Tray.Count; server = $procs.Server.Count; browser = $procs.Browser.Count }
    $result.appWindows = @(Get-TopWindows | Where-Object { $_.Process -eq 'msedge' } | ForEach-Object { $_.Name })
    $main = @($procs.Browser | Where-Object { $_.CommandLine -match '--app=' }) | Select-Object -First 1
    if ($main) { $result.browserCommand = $main.CommandLine }

    $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Terramentor.lnk'
    $waited = 0
    while (-not (Test-Path -LiteralPath $lnk) -and $waited -lt 20) { Start-Sleep -Seconds 1; $waited++ }
    Step 'Start Menu shortcut' (Test-Path -LiteralPath $lnk) ''

    # A first run makes no connection of its own (SECURITY.md): looked at now
    # and again before Quit.
    function Get-Outbound {
        foreach ($s in (Get-AppProcesses).Server) {
            Get-NetTCPConnection -OwningProcess $s.ProcessId -ErrorAction SilentlyContinue |
                Where-Object { $_.State -ne 'Listen' -and $_.RemoteAddress -notin @('127.0.0.1', '::1', '0.0.0.0', '::') } |
                ForEach-Object { $_.RemoteAddress + ':' + $_.RemotePort }
        }
    }
    $outbound = @(Get-Outbound)

    # --- 6. a second double-click, then Quit ------------------------------------
    # An impatient second double-click must reach the running copy: one server.
    $asked2 = Open-AsDoubleClick 2
    $result.secondDoubleClick = $asked2
    foreach ($a in $asked2) { Note ('second double-click: ' + $a.process + ' "' + $a.title + '" -> ' + ($a.actions -join '; ')) }
    Start-Sleep -Seconds 8
    $procs = Get-AppProcesses
    $windows = @(Get-TopWindows | Where-Object { $_.Process -eq 'msedge' }).Count
    Step 'second double-click reaches the running copy' ($procs.Server.Count -eq 1 -and $procs.Tray.Count -eq 1) ("servers $($procs.Server.Count), tray programs $($procs.Tray.Count), browser windows $windows")
    Save-Screen 'second-launch'

    if ($port) {
        $outbound = @(@($outbound) + @(Get-Outbound) | Select-Object -Unique)
        $result.outboundConnections = $outbound
        Step 'no outside connections' ($outbound.Count -eq 0) ($outbound -join ', ')
        try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/desktop/quit" -TimeoutSec 5 | Out-Null } catch { Note ('quit request: ' + $_.Exception.Message) }
        $waited = 0
        do { Start-Sleep -Seconds 1; $waited++; $procs = Get-AppProcesses; $left = $procs.Server.Count + $procs.Tray.Count + $procs.Browser.Count }
        while ($left -gt 0 -and $waited -lt 30)
        Step 'Quit stops everything' ($left -eq 0) ("after $waited s: servers $($procs.Server.Count), tray $($procs.Tray.Count), window processes $($procs.Browser.Count)")
        Save-Screen 'after-quit'
    }
} catch {
    Step 'run' $false ($_.Exception.Message + ' (line ' + $_.InvocationInfo.ScriptLineNumber + ')')
    try { Save-Screen 'error' } catch { }
} finally {
    # --- what the app wrote, and the verdict ------------------------------------
    # Every piece on its own: whatever fails here, `done` is still written.
    $data = Join-Path $env:LOCALAPPDATA 'Terramentor'
    try {
        $log = Join-Path $data 'logs\app.log'
        if (Test-Path -LiteralPath $log) { Copy-Item -LiteralPath $log -Destination (Join-Path $Out 'app.log') }
    } catch { $result.notes += 'app.log not copied: ' + $_.Exception.Message }
    $result.libraryFiles = @(Get-ChildItem -LiteralPath $data -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    try {
        $result.defenderDetections = @(Get-MpThreatDetection -ErrorAction Stop | ForEach-Object { '' + $_.ThreatID + ' ' + ($_.Resources -join ' ') })
    } catch { $result.defenderDetections = @() }
    if ($result.defenderDetections.Count) {
        $line = 'Defender detections: ' + ($result.defenderDetections -join '; ')
        $result.failures += $line
        try { Say ('FAIL ' + $line) } catch { }
    }
    if ($result.failures.Count -eq 0) { $result.verdict = 'pass' } else { $result.verdict = 'fail' }
    $result.seconds = [math]::Round($clock.Elapsed.TotalSeconds, 1)
    try { Write-Json 'result.json' $result } catch { try { Say ('result.json not written: ' + $_.Exception.Message) } catch { } }
    try { Say ('done: ' + $result.verdict) } catch { }
    Set-Content -LiteralPath (Join-Path $Out 'done') -Value $result.verdict -Encoding Ascii
}

# The desktop app

Terramentor runs as a desktop program on Windows, macOS and Linux: download a
zip, unpack it, double-click. No Node, no Docker, no terminal, no account.

This page is for two readers: someone running it, and someone changing how it
is built. The first half is for the first reader.

## Running it

Get the zip for your system from the
[releases page](https://github.com/ValeraZSD/terramentor/releases) and unpack it
anywhere you like — your Downloads folder, `C:\Apps`, a USB stick.

| System  | Start it with                                                                 |
|---------|-------------------------------------------------------------------------------|
| Windows | `Terramentor.exe` (`Terramentor.cmd` does the same with a console, for diagnosing) |
| macOS   | `Terramentor.app`, or `Terramentor.command` (Apple Silicon Macs)                  |
| Linux   | `./terramentor.sh`; run `./install-desktop-entry.sh` once for a menu entry     |

The app opens in its own window. Closing the window stops the app; opening it
again picks up where you were. A second double-click while it is running opens
another window on the same library rather than a second copy of the app.

**Windows** may show a SmartScreen warning the first time ("Windows protected
your PC") because the launcher is not code-signed. *More info → Run anyway*.
The first start also adds a Start Menu shortcut.

**macOS** may say the app is from an unidentified developer. Right-click the
app → *Open*, once. (If macOS refuses even that: `xattr -dr com.apple.quarantine`
on the unpacked folder, or use `Terramentor.command`.)

### Where your data is

| System  | Folder                                    |
|---------|-------------------------------------------|
| Windows | `%LOCALAPPDATA%\Terramentor`                |
| macOS   | `~/Library/Application Support/Terramentor` |
| Linux   | `~/.local/share/Terramentor` (or `$XDG_DATA_HOME/Terramentor`) |

Everything is in that folder: the library (`terramentor.db`), every uploaded
file and imported card media (`vault/`), the log (`logs/app.log`), and the
window's own browser profile. **Back up that folder and you have backed up
everything.** Settings → General → *This computer* opens it.

**Keeping the library on another disk.** That folder is on your system drive,
which is the drive most likely to be full — a library with a few imported decks
in it runs to gigabytes. Put a file called `library-location.txt` in it
containing one line, the full path you want instead:

```
D:\Terramentor-data
```

Blank lines and lines starting with `#` are ignored, so the file can explain
itself. Delete it to go back to the default. Move your existing folder to the
new path first; the app does not move it for you.

If the path is not there when the app starts — an unplugged drive, a typo — the
app **says so and stops**, naming the file to delete. It will not quietly open an
empty library beside your real one.

An explicit `--data-dir` on the command line still wins over the pointer, and
`DATA_DIR` in the environment wins over that.

**Portable use:** create an empty folder named `data` next to `Terramentor.exe`
before the first start and the library lives there instead — the whole app
then moves with the folder. This beats the pointer file.

### Updating

Download the next zip, unpack it, delete the old folder. Your data is not in
the application folder, so nothing is lost. If a release changes the database
format, the app backs the file up automatically before migrating (the three
most recent snapshots are kept next to it). Settings → General → About checks
for new releases when you ask it to.

### The notification-area icon (Windows)

On Windows, `Terramentor.exe` puts an icon in the notification area — the tray
by the clock — and that icon **is** the app:

- **Double-click it** to open a window, whenever you like.
- **Right-click → Quit Terramentor** to stop the app.
- **Closing the window does not stop anything.** The icon stays, the server
  keeps serving, and your phone keeps its connection.

That last point is the difference the icon makes, so *Keep running in the
background* is not a switch on Windows — it is simply how the app behaves, and
the panel says so instead of drawing a control that cannot change it.

Quitting from the tray closes the window too, and stops the server cleanly (the
database is checkpointed before the process goes). Quitting while the window is
open is the same thing from the other end: Settings → General → *This computer*
→ *Quit*.

On macOS and Linux there is no such icon — see *No tray icon elsewhere* below.
There, **Keep running in the background** is a switch on that panel, and it does
the same job: the server stays up with the window closed, until you press
*Quit*.

### Starting it when you sign in

**Start when I sign in** writes an ordinary login item — a shortcut in your
Startup folder on Windows, a LaunchAgent on macOS, an XDG autostart entry on
Linux. You can delete it by hand from the same place; turning the switch off
removes it. Nothing is written to the registry and no service is installed.

On Windows a second control appears beside it: **When it starts with the
computer** — *Background* or *Window*.

- *Background* (the default) means the app comes up behind the tray icon with
  no window, ready for your phone, out of the way of whatever you actually
  signed in to do. A notification says where it went, once.
- *Window* opens a window as if you had started it yourself.

Either way, **opening the app yourself always opens a window**; the setting is
only about that first start at sign-in. It is a Windows control because it needs
the tray icon to be safe: with nothing on screen to open a window from, coming
up hidden would leave a running app you cannot reach, so on macOS, Linux and a
source checkout a sign-in start always opens a window.

**No console window.** The thing a login item starts is windowless on every
supported path: the compiled `Terramentor.exe` for a packaged copy, and
`wscript.exe` running `desktop/wrappers/launch-hidden.vbs` for a source
checkout, because `node.exe` is a console program and the console it opens is
the server — closing it to tidy the desktop would stop the app.

The login item **names your library explicitly**, because it inherits nothing
from the session that wrote it: no `.env`, no exported `DATA_DIR`, no working
directory. If you move your library, turn the switch off and on again so the
new location is written into it.

### How the window opens

*Window*, *Maximised* or *Full screen*, applied the next time the app starts:
the window is a Chromium app window and its state is chosen at launch, not from
inside the page.

### No tray icon elsewhere

The Windows icon exists because the launcher there is a small compiled program
of the project's own (`desktop/wrappers/Launcher.cs`, built with the C# compiler
Windows already ships). macOS and Linux have no equivalent that costs nothing to
ship: the window belongs to Chromium and the server is a headless Node process,
so an icon there would mean bundling a second runtime for it to live in. On
those systems, start-at-login plus keep-running gets most of the way — the app
is always there, and *Quit* is in Settings.

### AI

The app works without AI: reading, flashcards, schedules, your own material.
Lessons, questions and the tutor need a model. Install
[Ollama](https://ollama.com/download) and pull a model, or point Settings → AI
& Models at any OpenAI-compatible endpoint (llama.cpp, LM Studio, OpenRouter…).
The first feed says what it found and what to do.

### Something is wrong

The log is `logs/app.log` in the data folder. On Windows, `Terramentor.cmd`
starts the app with a console so the same lines are on screen. Settings →
General → About → *Copy details* gives a block to paste into an issue.

## How it is built

`node tools/build-desktop.mjs` produces `release/Terramentor-<version>-<os>-<arch>/`
and a zip of it, for the machine it runs on. The release workflow runs it on
all three operating systems and attaches the zips to the GitHub release.

What is in the folder:

```
runtime/node(.exe)   the Node binary the build ran on, copied — the only runtime
dist/                the built app
server/              the API, minus the database, vault and certificates
desktop/             the launcher (launcher.js + lib.js)
node_modules/        the server's production dependencies only, from package-lock
build.json           version, commit, build time — the app's identity
Terramentor.exe        Windows: a windowless launcher with a tray icon, compiled
                     from desktop/wrappers/Launcher.cs
Terramentor.app        macOS: a thin bundle; Info.plist + icon.icns + a shell script
```

Design decisions worth knowing before changing it:

- **No Electron, no Tauri.** The app is a server plus a browser page, and every
  machine this targets already has a Chromium (Edge ships with Windows). The
  launcher opens a Chromium `--app` window with a dedicated profile: its own
  taskbar entry and icon, no address bar, a remembered size, and independent
  of the person's daily browser. When no Chromium exists it opens the default
  browser as a tab and everything still works. ~90 MB zipped instead of
  ~200 MB, and `better-sqlite3` needs no Electron-ABI rebuild.
- **The window is not the process.** A native app dies with its window; a
  server does not know a tab closed. So the page heartbeats
  (`src/hooks/useDesktop.ts` → `POST /api/desktop/ping`) and the server stops
  itself when every window has been silent for 45 s (`server/desktop.js`).
  The rule is wall-clock, not "the browser process I spawned exited", because
  Chromium hands off to a running instance and exits at once, and because a
  phone over Tailscale is a window too.
- **The Windows launcher is the app's owner, and only on Windows.** It holds the
  server as a child process, shows the tray icon, and is the single instance at
  the program level (a named mutex keyed on the install folder, so two portable
  copies stay two apps). It is ~10 KB of C# compiled at build time by the
  compiler inside Windows PowerShell — no toolchain, no second runtime. That
  compiler speaks C# 5, so nothing in `Launcher.cs` may use a newer form; a
  compile failure is only a *warning* in the build script and the package would
  otherwise ship with the console `.cmd` alone.
- **The tray icon stops the server by closing its standard input**, not over
  HTTP. Windows has no `SIGTERM` to send a child, and `/api/desktop/quit` sits
  behind the password gate on purpose — that gate is what stops someone on your
  tailnet shutting the app down, and a menu item must not need an exception to
  it. The pipe works both ways: kill the tray icon and the server goes with it,
  so there is no orphan holding the port.
- **Single instance by probe, not by lock file.** Before starting, the launcher
  asks `/api/desktop/status` on each port the app could be on; a running
  Terramentor on the same data directory gets a new window instead of a second
  server. A lock file would go stale after a crash; a probe cannot.
- **Data lives outside the application folder** (`server/paths.js`):
  `DB_PATH`/`VAULT_ROOT` if set, else `DATA_DIR`, else the historical layout
  under `server/` for a checkout. The launcher sets `DATA_DIR` in-process
  before importing the server. Under Program Files the folder is unwritable and
  an update replaces it; per-user app data is what every platform reserves for
  exactly this.
- **Port fallback is opt-in** (`PORT_FALLBACK=1`, set by the launcher). A
  developer running two servers wants `EADDRINUSE` loudly; a person with
  something else on 3001 wants the app to open. `server/index.js` exports
  `serverReady`, which resolves with the port actually bound.
- **The staged copy is started before it is zipped**, in a temp directory
  outside the repo — inside it, Node would resolve a missing package from the
  repo's own `node_modules` and the check would pass with an empty package.
  `desktop/launcher.js --check` starts the server on a scratch data directory,
  reads its version and desktop status, and quits.
- **Server dependencies are scanned, then pruned.** `npm ci --omit=dev`, then
  `package.json` is rewritten to only the packages `server/**` imports and
  `npm prune` removes the rest at lockfile versions — the client's packages are
  already inside `dist/`. 635 MB of `node_modules` becomes about 150 MB.
- **Not code-signed.** A Windows Authenticode certificate and an Apple
  Developer ID are recurring costs; until they exist the README and the zip's
  README.txt say what SmartScreen and Gatekeeper will show.

Guard: `node tools/desktop-gates.mjs` (path resolution on every platform, the
launcher's decisions, the shutdown rule, the lifecycle router on a real Express
app, the icon containers, and that every packaging piece exists).

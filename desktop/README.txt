Terramentor __VERSION__ — desktop build
=====================================

A local-first mastery engine for self-directed learners. Your library stays on
this computer: a single SQLite file plus a folder of the files you upload.

STARTING IT
  Windows  double-click Terramentor.exe  (Terramentor.cmd does the same with a
           console window, useful when something goes wrong)
  macOS    double-click Terramentor.app  (or Terramentor.command)
           The first time, macOS may say the app is from an unidentified
           developer: right-click → Open, once.
  Linux    ./terramentor.sh   — and ./install-desktop-entry.sh once to get it
           into your application menu

The app opens in its own window. The first Windows start also adds it to your
Start Menu, so afterwards it is where your other programs are.

ON WINDOWS: THE ICON BY THE CLOCK
  Terramentor puts an icon in the notification area, and that icon is the app.
    - double-click it to open a window
    - right-click -> Quit Terramentor to stop the app
    - closing the window does NOT stop it: the icon stays and the server keeps
      running, which is what lets your phone keep using it
  On macOS and Linux there is no such icon; there, closing the last window
  stops the app unless you turn on "Keep running in the background" in
  Settings -> General -> This computer -> "Background, sign-in and quitting".

STARTING WITH YOUR COMPUTER
  Settings -> General -> This computer -> "Background, sign-in and quitting"
  -> "Start when I sign in".
  On Windows, "When it starts with the computer" then chooses whether that
  first start opens a window or comes up quietly behind the icon. Opening the
  app yourself always opens a window. No console window appears either way.

WHERE YOUR DATA IS
  Windows  %LOCALAPPDATA%\Terramentor
  macOS    ~/Library/Application Support/Terramentor
  Linux    ~/.local/share/Terramentor
Back up that folder and you have backed up everything. Settings → General →
This computer opens it for you.

Keeping it on another disk: put a file called library-location.txt in the
folder above, containing one line — the full path you want instead. A big
library on a full system drive is the reason this exists. Delete the file to
go back. If the path is not there when the app starts (an unplugged drive,
say), it tells you rather than quietly opening an empty library.

Portable use: make an empty folder called `data` next to this file before the
first start, and the library lives there instead — on a USB stick, say.

USING IT FROM YOUR PHONE
  Install Tailscale on this computer and on your phone, sign both in to the
  same account, and run:  tailscale serve --bg 3001
  Then open the https://...ts.net address it prints, on the phone, and add it
  to your home screen. Set a password first: Settings -> Data -> Security.
  Full instructions: docs/REMOTE_ACCESS.md in the source repository.

UPDATING
  Download the next version, unpack it anywhere, delete this folder. Your data
  is not in this folder, so nothing is lost. The app backs the database up
  automatically before any release that changes it.

AI
  Lessons, questions and the tutor are written by a model you connect. The
  welcome screen on the first start connects one: "Connect OpenRouter" signs
  you in there and brings back a key you own, or paste a key for any
  OpenAI-compatible service, or point it at Ollama, LM Studio or llama.cpp on
  this computer. Change it later in Settings -> AI & Models. Without a model the
  app still opens your courses, their saved lessons and questions, and your
  flashcards, but writes nothing new.

PROBLEMS
  The log is in the data folder, under logs/app.log. Settings -> General ->
  About -> "Report a problem" fills in GitHub's issue form for you to check and
  send ("Copy details" copies the same facts). Source code and issues:
  https://github.com/ValeraZSD/terramentor

Licence: GNU AGPL v3 or later (see LICENSE). The bundled Node.js runtime is
MIT-licensed (runtime/NOTICE.txt).

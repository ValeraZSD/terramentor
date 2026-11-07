#!/bin/bash
# Terramentor.app/Contents/MacOS/Terramentor, the bundle's executable. The app
# is INSIDE the bundle, in Contents/Resources/app, so the bundle works wherever
# it is: dragged into Applications on its own, or run by macOS from the
# read-only copy it makes of a downloaded app (App Translocation). Nothing here
# may look outside the bundle. One-click updates replace the app folder and
# never this file, so it stays this small.
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/../Resources/app" 2>/dev/null && pwd)"
# Said on stderr, which a Terminal shows; opened from Finder it reaches no one.
if [ -z "$APP" ]; then why="there is no app folder at $HERE/../Resources/app"
elif [ ! -x "$APP/runtime/node" ]; then why="$APP/runtime/node is missing or cannot be run"
elif [ ! -f "$APP/desktop/launcher.js" ]; then why="$APP/desktop/launcher.js is missing"
fi
if [ -n "${why:-}" ]; then
    echo "Terramentor cannot start: $why. Download Terramentor again." >&2
    exit 1
fi
cd "$APP" || exit 1
exec "$APP/runtime/node" "$APP/desktop/launcher.js" "$@"

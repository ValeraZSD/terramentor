#!/bin/bash
# Terramentor.app/Contents/MacOS/Terramentor, the bundle's executable. The app
# is INSIDE the bundle, in Contents/Resources/app, so the bundle works wherever
# it is: dragged into Applications on its own, or run by macOS from the
# read-only copy it makes of a downloaded app (App Translocation). Nothing here
# may look outside the bundle. One-click updates replace the app folder and
# never this file, so it stays this small.
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/../Resources/app" 2>/dev/null && pwd)"
if [ -z "$APP" ] || [ ! -x "$APP/runtime/node" ] || [ ! -f "$APP/desktop/launcher.js" ]; then
    echo "Terramentor: the app in $HERE/../Resources/app is missing or incomplete; download Terramentor again." >&2
    exit 1
fi
cd "$APP" || exit 1
exec "$APP/runtime/node" "$APP/desktop/launcher.js" "$@"

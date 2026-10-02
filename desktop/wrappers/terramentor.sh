#!/bin/sh
# Starts Terramentor. Run ./install-desktop-entry.sh once to get a launcher in
# your application menu.
cd "$(dirname "$0")"
exec ./runtime/node desktop/launcher.js "$@"

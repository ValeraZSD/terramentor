#!/bin/sh
# Starts Terramentor. Run ./install-desktop-entry.sh once to get a launcher in
# your application menu. A course file named on the command line opens in the
# app; the launcher reads a relative one against the folder you started from.
TERRAMENTOR_CWD="$(pwd)"
export TERRAMENTOR_CWD
cd "$(dirname "$0")"
exec ./runtime/node desktop/launcher.js "$@"

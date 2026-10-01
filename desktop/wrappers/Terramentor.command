#!/bin/bash
# Double-click to start Terramentor. macOS opens a Terminal window for a
# .command file; it can be closed once the app window is up — the server keeps
# running until the last app window is closed. Terramentor.app does the same
# without the Terminal window.
cd "$(dirname "$0")"
exec ./runtime/node desktop/launcher.js "$@"

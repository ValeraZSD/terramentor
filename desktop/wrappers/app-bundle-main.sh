#!/bin/bash
# Terramentor.app/Contents/MacOS/Terramentor — the bundle's executable. The app's
# files live in the folder BESIDE the bundle (../../..), so the bundle stays a
# thin launcher and the folder stays what the zip unpacks to.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
exec "$ROOT/runtime/node" "$ROOT/desktop/launcher.js" "$@"

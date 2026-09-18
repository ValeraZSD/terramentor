#!/bin/sh
# Adds Terramentor to the application menu of the current user (freedesktop
# .desktop entry). Run it once from the unpacked folder; run it again after
# moving the folder. Remove with: rm ~/.local/share/applications/terramentor.desktop
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$DIR"
cat > "$DIR/terramentor.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Terramentor
Comment=Local-first mastery engine for self-directed learners
Exec="$HERE/terramentor.sh"
Icon=$HERE/icon.png
Terminal=false
Categories=Education;
StartupWMClass=terramentor
DESKTOP
chmod +x "$HERE/terramentor.sh" "$HERE/runtime/node" 2>/dev/null || true
echo "Installed $DIR/terramentor.desktop"

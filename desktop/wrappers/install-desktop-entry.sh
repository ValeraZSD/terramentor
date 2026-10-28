#!/bin/sh
# Adds Terramentor to the application menu of the current user (freedesktop
# .desktop entry). Run it once from the unpacked folder; run it again after
# moving the folder. Remove with: rm ~/.local/share/applications/terramentor.desktop
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

# The folder's path goes into the entry as DATA, escaped by the Desktop Entry
# Specification's rules, never pasted into it as text. A .desktop file is lines
# of key=value, so a line break in the path would start a key of its choosing:
# refused, there is no escape every desktop reads the same way.
case "$HERE" in
    *"
"*) echo "The folder's path contains a line break; move Terramentor somewhere plainer and run this again." >&2; exit 1 ;;
esac
# Exec: the path in double quotes, where " \` \$ \\ each take a backslash; the
# value is then a string, so every backslash is doubled again; % starts a field
# code, so a literal one is %%. Icon is a plain string: backslashes doubled.
EXEC_ARG=$(printf '%s/terramentor.sh' "$HERE" | sed -e 's/[\\"`$]/\\&/g' -e 's/\\/\\\\/g' -e 's/%/%%/g')
ICON=$(printf '%s/icon.png' "$HERE" | sed -e 's/\\/\\\\/g')

mkdir -p "$DIR"
{
    # Quoted delimiter: nothing in the fixed part is expanded by the shell.
    cat <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Terramentor
Comment=Local-first mastery engine for self-directed learners
Terminal=false
Categories=Education;
StartupWMClass=terramentor
DESKTOP
    printf 'Exec="%s"\n' "$EXEC_ARG"
    printf 'Icon=%s\n' "$ICON"
} > "$DIR/terramentor.desktop"
chmod +x "$HERE/terramentor.sh" "$HERE/runtime/node" 2>/dev/null || true
echo "Installed $DIR/terramentor.desktop"

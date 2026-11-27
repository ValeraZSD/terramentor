#!/bin/sh
# Adds Terramentor to the application menu of the current user (freedesktop
# .desktop entry) and teaches the desktop the `.studyvault` file type, so a
# double-clicked course file opens in Terramentor, ready to add. Run it once
# from the unpacked folder; run it again after moving the folder. Remove with:
#   rm ~/.local/share/applications/terramentor.desktop \
#      ~/.local/share/mime/packages/terramentor-studyvault.xml
#   update-mime-database ~/.local/share/mime
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DIR="$DATA/applications"
MIME="$DATA/mime"

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

mkdir -p "$DIR" "$MIME/packages"
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
MimeType=application/x-terramentor-studyvault;
DESKTOP
    # %f: the file manager puts the double-clicked file here, as one argument.
    printf 'Exec="%s" %%f\n' "$EXEC_ARG"
    printf 'Icon=%s\n' "$ICON"
} > "$DIR/terramentor.desktop"

# The file type. A course file is a zip inside, so it is declared a kind of
# zip; then the name decides and an archive tool does not take it over.
cat > "$MIME/packages/terramentor-studyvault.xml" <<'MIMEXML'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-terramentor-studyvault">
    <comment>Terramentor course or library</comment>
    <sub-class-of type="application/zip"/>
    <glob pattern="*.studyvault"/>
  </mime-type>
</mime-info>
MIMEXML

# The desktop reads the two databases these rebuild, not the files above.
# Either tool may be missing on a minimal system; the menu entry still works.
if command -v update-mime-database >/dev/null 2>&1; then update-mime-database "$MIME" || true; fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$DIR" || true; fi
if command -v xdg-mime >/dev/null 2>&1; then xdg-mime default terramentor.desktop application/x-terramentor-studyvault || true; fi

chmod +x "$HERE/terramentor.sh" "$HERE/runtime/node" 2>/dev/null || true
echo "Installed $DIR/terramentor.desktop"
echo "Course files (.studyvault) now open in Terramentor."

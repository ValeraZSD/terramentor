#!/bin/bash
# What lets LaunchServices start an app bundle on this Mac, and what stops it.
#
#   bash tools/macos-launch-probe.sh release/Terramentor-<version>-darwin-arm64.zip
#
# Prints facts and never fails: how ditto unpacks a zip entry's mode with and
# without the regular-file type bits, whether a bundle whose main executable is
# a shell script starts through `open` beside one whose executable is Mach-O,
# and whether the packaged bundle starts unpacked fresh, under a bundle id of
# its own, and run directly.
set -u
w="$(cd "$(mktemp -d)" && pwd -P)"
port=3961
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
trap 'pkill -f -- "$w/" 2>/dev/null; rm -rf "$w"' EXIT
sw_vers | tr '\n' ' '; echo

echo "▸ a zip entry's mode as ditto unpacks it"
python3 - "$w/modes.zip" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], 'w')
for name, mode in (('stored-0755', 0o755), ('stored-0100755', 0o100755)):
    i = zipfile.ZipInfo(name)
    i.create_system = 3
    i.external_attr = mode << 16
    z.writestr(i, 'x\n')
z.close()
PY
ditto -x -k "$w/modes.zip" "$w/modes"
stat -f '    %Sp  %N' "$w/modes/"* | sed "s#$w/modes/##"

# plist BUNDLE-ID: a minimal Info.plist whose executable is "probe".
plist() {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
        '<plist version="1.0"><dict>' \
        '<key>CFBundleExecutable</key><string>probe</string>' \
        "<key>CFBundleIdentifier</key><string>$1</string>" \
        '<key>CFBundleName</key><string>probe</string>' \
        '<key>CFBundlePackageType</key><string>APPL</string>' \
        '</dict></plist>'
}
# opened APP: open it with an argument, as the check does; say whether it ran.
opened() {
    local app="$1" mark="$1/Contents/MacOS/probe.ran"
    open -n -a "$app" --args --probe
    local rc=$?
    for _ in $(seq 1 10); do [ -f "$mark" ] && break; sleep 1; done
    [ -f "$mark" ] && echo "    $(basename "$app"): open exited $rc, it ran" || echo "    $(basename "$app"): open exited $rc, it did NOT run"
}

echo "▸ a bundle whose executable is a shell script, beside one whose executable is Mach-O"
s="$w/script.app"; mkdir -p "$s/Contents/MacOS"; plist org.example.probe.script > "$s/Contents/Info.plist"
printf '%s\n' '#!/bin/bash' 'echo ran > "$(cd "$(dirname "$0")" && pwd)/probe.ran"' > "$s/Contents/MacOS/probe"
chmod 755 "$s/Contents/MacOS/probe"
m="$w/macho.app"; mkdir -p "$m/Contents/MacOS"; plist org.example.probe.macho > "$m/Contents/Info.plist"
printf '%s\n' '#include <stdio.h>' '#include <string.h>' '#include <mach-o/dyld.h>' \
    'int main(void) { char p[4096]; uint32_t n = sizeof p; if (_NSGetExecutablePath(p, &n)) return 1;' \
    '  strncat(p, ".ran", sizeof p - strlen(p) - 1); FILE *f = fopen(p, "w"); if (!f) return 1;' \
    '  fputs("ran\n", f); fclose(f); return 0; }' > "$w/probe.c"
cc -o "$m/Contents/MacOS/probe" "$w/probe.c" && echo "    compiled the Mach-O probe" || echo "    could not compile the Mach-O probe"
opened "$s"
opened "$m"

zip="${1:-}"
[ -f "$zip" ] || { echo "▸ no zip given, done"; exit 0; }
echo "▸ the packaged bundle, unpacked fresh with ditto"
ditto -x -k "$zip" "$w/real"
app="$(ls -d "$w"/real/*/Terramentor.app)"
stat -f '    %Sp  %N' "$app/Contents/MacOS/Terramentor" "$app/Contents/Resources/app/runtime/node" | sed "s#$app/##"
echo "    copies of Terramentor.app LaunchServices knows:"
"$LSREGISTER" -dump 2>/dev/null | grep -E '^path:.*Terramentor\.app' | sort -u | head -12 | sed 's/^/      /'

# started LABEL APP: open APP with its own library and port; say whether it served.
started() {
    local label="$1" app="$2" ok=0
    open -n -a "$app" --args --data-dir "$w/lib-$label" --port "$port"
    local rc=$?
    for _ in $(seq 1 40); do
        curl -s "http://127.0.0.1:$port/api/desktop/status" | grep -q '"desktop":true' && { ok=1; break; }
        sleep 1
    done
    [ "$ok" = 1 ] && echo "    $label: open exited $rc, it served" || echo "    $label: open exited $rc, it did NOT serve"
    pkill -f -- "--data-dir $w/" 2>/dev/null; pkill -f -- "--user-data-dir=$w/" 2>/dev/null; sleep 2
}
started "as packaged" "$app"
ided="$w/ided/Terramentor.app"; mkdir -p "$w/ided"; ditto "$app" "$ided"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier org.example.probe.terramentor$$" "$ided/Contents/Info.plist"
started "own bundle id" "$ided"
echo "▸ the packaged bundle's script run directly"
"$app/Contents/MacOS/Terramentor" --check --data-dir "$w/lib-direct" --port "$port" 2>&1 | grep -E 'packaged copy at|Check OK|Error|error' | sed 's/^/    /' | head -5

echo "▸ what launchd and RunningBoard logged about these launches"
log show --last 5m --style compact --predicate 'eventMessage CONTAINS[c] "probe" OR eventMessage CONTAINS[c] "terramentor"' 2>/dev/null \
    | grep -iE 'spawn|constraint|denied|reject|fail|error|111' | cut -c1-400 | tail -30 | sed 's/^/    /'
exit 0

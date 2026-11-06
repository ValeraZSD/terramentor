#!/bin/bash
# Opens the macOS package the way a person does, as far as a CI runner allows.
#
#   bash tools/macos-open-check.sh release/Terramentor-<version>-darwin-arm64.zip [shots-dir]
#
# The zip is unpacked with ditto (as Archive Utility does), the bundle is copied
# ON ITS OWN into another folder and the unpacked folder deleted, so nothing is
# left beside it to reach. Then it is opened through LaunchServices (`open`),
# never by running its script directly:
#
#   1. marked as downloaded (com.apple.quarantine), as a browser marks it. An app
#      that is not notarized may be stopped here by Gatekeeper; if it starts,
#      macOS runs it from a translocated copy, and the log must say so;
#   2. with the mark removed (README.txt's fallback), from where it was copied;
#   3. the same bundle made read-only.
#
# Each run must serve the app from the copy's own Contents/Resources/app; run 2
# must start. A browser, when the runner has one, must be an --app window.
# Fails on the first run that reaches outside the bundle or does not start.
set -uo pipefail

zip="${1:?the darwin zip}"
shots="${2:-}"
# Resolved: node reports its own path with /var as /private/var.
work="$(cd "$(mktemp -d)" && pwd -P)"
port=3950
fail=0
say() { printf '%s\n' "$*"; }
bad() { say "FAIL $*"; fail=1; }

ditto -x -k "$zip" "$work/unzipped" || { say "FAIL could not unpack $zip"; exit 1; }
top="$(ls "$work/unzipped")"
say "▸ the zip's top level ($top/) and the bundle, without the app folder's contents:"
(cd "$work/unzipped/$top" && find . -mindepth 1 -maxdepth 5 -not -path './Terramentor.app/Contents/Resources/app/*' | sort | sed 's/^/    /')

copy="$work/elsewhere/Terramentor.app"
mkdir -p "$work/elsewhere"
ditto "$work/unzipped/$top/Terramentor.app" "$copy"
rm -rf "$work/unzipped"
say "▸ the bundle alone at $copy; the unpacked folder is gone"
say "▸ Gatekeeper on this runner: $(spctl --status 2>&1)"

# Stop whatever an earlier run left: the app, and the browser it opened.
stop() {
    pkill -f 'Terramentor.app/Contents/Resources/app/desktop/launcher.js' 2>/dev/null
    pkill -f -- "--user-data-dir=$work/" 2>/dev/null
    for _ in $(seq 1 20); do
        curl -s -o /dev/null "http://127.0.0.1:$port/api/desktop/status" || return 0
        sleep 0.5
    done
}

# open_run NAME MUST_START: open the copy, wait for it to serve, check its log.
open_run() {
    local name="$1" must="$2" data="$work/lib-$1" log started=0
    mkdir -p "$data"
    say ""
    say "▸ run '$name': open -n -a $copy --args --data-dir $data --port $port"
    open -n -a "$copy" --args --data-dir "$data" --port "$port"
    say "  open exited $?"
    for _ in $(seq 1 60); do
        if curl -s "http://127.0.0.1:$port/api/desktop/status" | grep -q '"desktop":true'; then started=1; break; fi
        sleep 1
    done
    log="$data/logs/app.log"
    if [ "$started" = 1 ]; then
        say "  serving at http://127.0.0.1:$port"
        sleep 4   # the window is opened after the server answers
        [ -f "$log" ] && sed 's/^/  log: /' "$log"
        local from
        from="$(grep -o 'packaged copy at .*' "$log" | head -1 | sed 's/^packaged copy at //')"
        case "$from" in
            "$copy/Contents/Resources/app"|*/AppTranslocation/*/Terramentor.app/Contents/Resources/app) say "  ok: served from inside the bundle: $from" ;;
            *) bad "run '$name' served from outside the bundle: '$from'" ;;
        esac
        case "$from" in
            */AppTranslocation/*) grep -q 'temporary read-only location' "$log" && say "  ok: the log names the translocation" || bad "run '$name' was translocated and the log does not say so" ;;
        esac
        if grep -q 'Opened app window with' "$log"; then
            local ps_line
            ps_line="$(ps -axww -o command= | grep -- "--app=http://127.0.0.1:$port" | grep -v grep | head -1)"
            if [ -n "$ps_line" ]; then say "  ok: the browser runs as an --app window: ${ps_line:0:300}"
            else bad "run '$name': the log says an app window opened, but no browser runs with --app"; fi
            [ -n "$shots" ] && mkdir -p "$shots" && screencapture -x "$shots/macos-$name.png" && say "  screenshot: macos-$name.png"
        else
            say "  no Chromium browser was used: $(grep -o 'Opened default browser.*\|Could not start.*' "$log" | head -1)"
        fi
        curl -s "http://127.0.0.1:$port/api/desktop/info" | grep -o '"appPlacement":[^,}]*' | sed 's/^/  info: /'
    else
        [ -f "$log" ] && sed 's/^/  log: /' "$log"
        if [ "$must" = must ]; then bad "run '$name' did not start within 60 s"
        else say "  did not start within 60 s (macOS may stop an app that is not notarized here)"; fi
    fi
    stop
    return 0
}

stop
xattr -w -r com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;" "$copy"
say "▸ quarantined: $(xattr -p com.apple.quarantine "$copy")"
open_run quarantined may

xattr -dr com.apple.quarantine "$copy"
open_run unquarantined must

chmod -R a-w "$copy"
open_run read-only must
grep -q 'cannot write to, so it cannot update itself' "$work/lib-read-only/logs/app.log" 2>/dev/null \
    && say "  ok: the read-only copy says it cannot update itself" \
    || bad "the read-only copy did not say it cannot update itself"
chmod -R u+w "$copy"

rm -rf "$work"
[ "$fail" = 0 ] && say "" && say "macOS open check: passed"
exit "$fail"

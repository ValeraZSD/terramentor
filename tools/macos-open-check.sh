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
#      that is not notarized may be stopped here by Gatekeeper, and whether
#      macOS translocates it depends on the runner's Gatekeeper settings, so this
#      run says what happened rather than requiring either; if it was
#      translocated, the log must say so;
#   2. with the mark removed (README.txt's fallback), from where it was copied.
#      A second launch while it runs must hand over to it, and Quit must stop
#      the app and close its --app window;
#   3. the same bundle made read-only.
#
# Each run must serve the app from the copy's own Contents/Resources/app; runs 2
# and 3 must start. A browser, when the runner has one, must be an --app window.
# Only processes started with this run's own folder are stopped, so it can run
# on a Mac where Terramentor is in use.
set -uo pipefail

zip="${1:?the darwin zip}"
shots="${2:-}"
# Resolved: node reports its own path with /var as /private/var.
work="$(cd "$(mktemp -d)" && pwd -P)"
port=3950
fail=0
say() { printf '%s\n' "$*"; }
bad() { say "FAIL $*"; fail=1; }
app_window() { ps -axww -o command= | grep -- "--app=http://127.0.0.1:$port" | grep -v grep | head -1; }

# Stop what this run started: the app, and the browser it opened (both carry
# this run's folder on their command line). Returns 1 if the port still answers.
stop() {
    pkill -f -- "desktop/launcher.js --data-dir $work/" 2>/dev/null
    pkill -f -- "--user-data-dir=$work/" 2>/dev/null
    for _ in $(seq 1 20); do
        curl -s -o /dev/null "http://127.0.0.1:$port/api/desktop/status" || return 0
        sleep 0.5
    done
    say "  (port $port still answers after stopping this run's processes)"
    return 1
}
cleanup() { stop >/dev/null; chmod -R u+w "$work" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

ditto -x -k "$zip" "$work/unzipped" || { say "FAIL could not unpack $zip"; exit 1; }
top="$(ls "$work/unzipped")"
say "▸ the zip's top level ($top/) and the bundle, without the app folder's contents:"
(cd "$work/unzipped/$top" && find . -mindepth 1 -maxdepth 5 -not -path './Terramentor.app/Contents/Resources/app/*' | sort | sed 's/^/    /')

copy="$work/elsewhere/Terramentor.app"
mkdir -p "$work/elsewhere"
ditto "$work/unzipped/$top/Terramentor.app" "$copy"
rm -rf "$work/unzipped"
say "▸ the bundle alone at $copy; the unpacked folder is gone"
stat -f '    %Sp  %N' "$copy/Contents/MacOS/Terramentor" "$copy/Contents/Resources/app/runtime/node" | sed "s#$copy/##"
say "▸ Gatekeeper on this runner: $(spctl --status 2>&1)"

# open_run NAME MUST_START [quit]: open the copy, wait for it to serve, check its
# log; with `quit`, also launch it a second time and then press Quit.
open_run() {
    local name="$1" must="$2" data="$work/lib-$1" log started=0 window=0
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
            */AppTranslocation/*)
                say "  translocated: yes"
                grep -q 'temporary read-only location' "$log" && say "  ok: the log names the translocation" || bad "run '$name' was translocated and the log does not say so" ;;
            *) say "  translocated: no (macOS ran the copy where it is)" ;;
        esac
        if grep -q 'Opened app window with' "$log"; then
            local ps_line
            ps_line="$(app_window)"
            if [ -n "$ps_line" ]; then window=1; say "  ok: the browser runs as an --app window: ${ps_line:0:300}"
            else bad "run '$name': the log says an app window opened, but no browser runs with --app"; fi
            [ -n "$shots" ] && mkdir -p "$shots" && screencapture -x "$shots/macos-$name.png" && say "  screenshot: macos-$name.png"
        else
            say "  no Chromium browser was used: $(grep -oE 'Opened default browser.*|Could not start.*' "$log" | head -1)"
        fi
        curl -s "http://127.0.0.1:$port/api/desktop/info" | grep -o '"appPlacement":[^,}]*' | sed 's/^/  info: /'

        if [ "${3:-}" = quit ]; then
            # A second launch finds the running app and leaves; it starts no
            # second server, and its window goes to the browser already
            # holding the app's profile.
            open -n -a "$copy" --args --data-dir "$data" --port "$port"
            say "  second launch: open exited $?"
            sleep 6
            local again
            again="$(pgrep -f -- "desktop/launcher.js --data-dir $data" | wc -l | tr -d ' ')"
            [ "$again" = 1 ] && say "  ok: one app process after the second launch" || bad "run '$name': $again app processes after the second launch"
            say "  second launch logged: $(grep -o 'already running on port.*' "$log" | tail -1)"

            curl -s -o /dev/null -X POST "http://127.0.0.1:$port/api/desktop/quit"
            local gone=0
            for _ in $(seq 1 30); do
                curl -s -o /dev/null "http://127.0.0.1:$port/api/desktop/status" || { gone=1; break; }
                sleep 0.5
            done
            [ "$gone" = 1 ] && say "  ok: Quit stopped the app" || bad "run '$name': Quit did not stop the app"
            if [ "$window" = 1 ]; then
                sleep 2
                [ -z "$(app_window)" ] && say "  ok: Quit closed the --app window" || bad "run '$name': an --app window is still open after Quit"
            fi
        fi
    else
        [ -f "$log" ] && sed 's/^/  log: /' "$log"
        # Why macOS did not start it, from the system log (the launcher never
        # ran, so its own log is empty).
        log show --last 2m --style compact --predicate 'eventMessage CONTAINS[c] "terramentor"' 2>/dev/null \
            | grep -iE 'spawn|constraint|denied|reject|fail' | cut -c1-300 | tail -6 | sed 's/^/  system log: /'
        if [ "$must" = must ]; then bad "run '$name' did not start within 60 s"
        else say "  did not start within 60 s (macOS may stop an app that is not notarized here)"; fi
    fi
    stop || bad "run '$name' left something serving on port $port"
    return 0
}

stop || { say "FAIL port $port is taken by something this script did not start"; exit 1; }
xattr -w -r com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$copy"
say "▸ quarantined: $(xattr -p com.apple.quarantine "$copy")"
say "▸ Gatekeeper's verdict on it: $(spctl --assess --type execute -vv "$copy" 2>&1 | tr '\n' ' ')"
open_run quarantined may

xattr -dr com.apple.quarantine "$copy"
open_run unquarantined must quit

chmod -R a-w "$copy"
open_run read-only must
grep -q 'cannot write to, so it cannot update itself' "$work/lib-read-only/logs/app.log" 2>/dev/null \
    && say "  ok: the read-only copy says it cannot update itself" \
    || bad "the read-only copy did not say it cannot update itself"

[ "$fail" = 0 ] && say "" && say "macOS open check: passed"
exit "$fail"

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
#   1. marked as downloaded (com.apple.quarantine), as a browser marks it.
#      Gatekeeper stops an app that is not notarized with a dialog nobody on a
#      runner can answer, and `open` waits for that answer, so this run (like
#      every command here that waits on macOS) has a time limit and only says
#      what happened;
#   2. marked as downloaded AND approved by the person, as Open Anyway leaves
#      it. If macOS then translocates it, the app's log must say so; whether it
#      starts at all is reported, not required;
#   3. with the mark removed (README.txt's fallback), from where it was copied.
#      A second launch while it runs must hand over to it, and Quit must stop
#      the app and close its --app window;
#   4. the same bundle made read-only.
#
# The unpacked bundle's script and runtime must be executable (a zip entry whose
# mode has no file type loses its executable bit in ditto). Each run must serve
# the app from the copy's own Contents/Resources/app; runs 3 and 4 must start. A
# browser, when the runner has one, must be an --app window. Only processes
# started with this run's own folder are stopped, so it can run on a Mac where
# Terramentor is in use.
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
# What the launcher logs once its window has opened, or has not.
window_said='Opened app window with|Opened default browser|Could not start|Could not open a browser|was stopped'
status() { curl -s -m 5 "http://127.0.0.1:$port/api/desktop/status"; }

# limit SECONDS COMMAND...: run COMMAND, stopping it after SECONDS. Its exit
# status, or 143 when it was stopped.
limit() {
    local secs="$1"; shift
    "$@" &
    local pid=$!
    ( sleep "$secs"; kill "$pid" 2>/dev/null ) &
    local timer=$!
    wait "$pid"
    local rc=$?
    pkill -P "$timer" 2>/dev/null; kill "$timer" 2>/dev/null; wait "$timer" 2>/dev/null
    return "$rc"
}

# Stop what this run started: the app, and the browser it opened (both carry
# this run's folder on their command line). Returns 1 if the port still answers.
stop() {
    pkill -f -- "desktop/launcher.js --data-dir $work/" 2>/dev/null
    # The bundle's script itself, when Gatekeeper holds it before it starts node.
    pkill -f -- "Terramentor.app/Contents/MacOS/Terramentor --data-dir $work/" 2>/dev/null
    pkill -f -- "--user-data-dir=$work/" 2>/dev/null
    for _ in $(seq 1 20); do
        status >/dev/null || return 0
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
for f in Contents/MacOS/Terramentor Contents/Resources/app/runtime/node; do
    if [ -x "$copy/$f" ]; then say "    $(stat -f '%Sp' "$copy/$f")  $f"
    else bad "$f is not executable once unpacked ($(stat -f '%Sp' "$copy/$f")): macOS cannot start the app"; fi
done
say "▸ Gatekeeper on this runner: $(spctl --status 2>&1)"

# open_run NAME MUST_START [quit]: open the copy, wait for it to serve, check its
# log; with `quit`, also launch it a second time and then press Quit.
open_run() {
    local name="$1" must="$2" data="$work/lib-$1" log started=0 window=0
    mkdir -p "$data"
    say ""
    say "▸ run '$name': open -n -a $copy --args --data-dir $data --port $port"
    limit 20 open -n -a "$copy" --args --data-dir "$data" --port "$port"
    local rc=$?
    if [ "$rc" = 143 ]; then say "  open did not return within 20 s: macOS is holding the app at a dialog"
    else say "  open exited $rc"; fi
    for _ in $(seq 1 60); do
        if status | grep -q '"desktop":true'; then started=1; break; fi
        sleep 1
    done
    log="$data/logs/app.log"
    if [ "$started" = 1 ]; then
        say "  serving at http://127.0.0.1:$port"
        # The window is opened after the server answers, and on macOS the line
        # comes once `open` has launched the browser, which takes a while the
        # first time a browser starts on a fresh profile.
        for _ in $(seq 1 30); do
            grep -qE "$window_said" "$log" 2>/dev/null && break
            sleep 1
        done
        [ -f "$log" ] && sed 's/^/  log: /' "$log"
        if ! grep -qE "$window_said" "$log" 2>/dev/null; then
            say "  no window line 30 s after the server answered; browser processes now:"
            ps -axww -o pid=,command= | grep -E 'Google Chrome|open -n -a' | grep -v grep | cut -c1-240 | sed 's/^/    /'
            [ -n "$shots" ] && mkdir -p "$shots" && limit 15 screencapture -x "$shots/macos-$name-no-window.png" && say "  screenshot: macos-$name-no-window.png"
        fi
        local seen
        seen="$(cat "$log" 2>/dev/null | wc -l)"
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
            [ -n "$shots" ] && mkdir -p "$shots" && limit 15 screencapture -x "$shots/macos-$name.png" && say "  screenshot: macos-$name.png"
        else
            say "  no app window: $(grep -oE "$window_said.*" "$log" | head -1 || true)"
        fi
        curl -s -m 5 "http://127.0.0.1:$port/api/desktop/info" | grep -o '"appPlacement":[^,}]*' | sed 's/^/  info: /'

        if [ "${3:-}" = quit ]; then
            # A second launch finds the running app and leaves; it starts no
            # second server, and its window goes to the browser already
            # holding the app's profile.
            local handed
            handed="$(grep -c 'already running on port' "$log")"
            limit 20 open -n -a "$copy" --args --data-dir "$data" --port "$port"
            say "  second launch: open exited $?"
            # It takes a few seconds to arrive, stays while its window opens (at
            # most 15 s), then leaves.
            for _ in $(seq 1 30); do
                [ "$(grep -c 'already running on port' "$log")" -gt "$handed" ] && break
                sleep 1
            done
            local again
            for _ in $(seq 1 25); do
                again="$(pgrep -f -- "desktop/launcher.js --data-dir $data" | wc -l | tr -d ' ')"
                [ "$again" = 1 ] && break
                sleep 1
            done
            [ "$again" = 1 ] && say "  ok: the second launch left; one app process runs" || bad "run '$name': $again app processes 25 s after the second launch"
            tail -n +"$((seen + 1))" "$log" | sed 's/^/  log: /'
            [ "$(grep -c 'already running on port' "$log")" -gt "$handed" ] && say "  ok: the second launch handed over to the running app" || bad "run '$name': the second launch did not find the running app"
            seen="$(cat "$log" 2>/dev/null | wc -l)"

            curl -s -m 10 -o /dev/null -X POST "http://127.0.0.1:$port/api/desktop/quit"
            local gone=0
            for _ in $(seq 1 30); do
                status >/dev/null || { gone=1; break; }
                sleep 0.5
            done
            [ "$gone" = 1 ] && say "  ok: Quit stopped the app" || bad "run '$name': Quit did not stop the app"
            tail -n +"$((seen + 1))" "$log" | sed 's/^/  log: /'
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

# A person's browser has started before; a runner's has not, and its first start
# (macOS checking a large app it has never run) can outlast every wait below.
# Start it once on a profile of its own, as a stranger to the app.
chrome="/Applications/Google Chrome.app"
if [ -d "$chrome" ]; then
    t0="$(date +%s)"
    limit 120 open -n -a "$chrome" --args --user-data-dir="$work/warm-profile" --no-first-run --no-default-browser-check about:blank
    say "▸ $chrome started once beforehand: open exited $? after $(( $(date +%s) - t0 )) s"
    sleep 3
    pkill -f -- "--user-data-dir=$work/warm-profile" 2>/dev/null
    sleep 2
fi
xattr -w -r com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$copy"
say "▸ quarantined: $(xattr -p com.apple.quarantine "$copy")"
say "▸ Gatekeeper's verdict on it: $(spctl --assess --type execute -vv "$copy" 2>&1 | tr '\n' ' ')"
open_run quarantined may

# 0x40 in the flags marks the download as approved by the person.
xattr -w -r com.apple.quarantine "00c1;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$copy"
say ""
say "▸ marked approved: $(xattr -p com.apple.quarantine "$copy")"
open_run approved may

xattr -dr com.apple.quarantine "$copy"
open_run unquarantined must quit

chmod -R a-w "$copy"
open_run read-only must
grep -q 'cannot write to, so it cannot update itself' "$work/lib-read-only/logs/app.log" 2>/dev/null \
    && say "  ok: the read-only copy says it cannot update itself" \
    || bad "the read-only copy did not say it cannot update itself"

[ "$fail" = 0 ] && say "" && say "macOS open check: passed"
exit "$fail"

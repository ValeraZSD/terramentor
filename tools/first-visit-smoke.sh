#!/usr/bin/env bash
# The first visit to a server that has no password yet, from ANOTHER machine —
# which is what every request into a Docker container is. The release workflow
# runs this against the image it just published, before the release names it:
# nobody had started a release's container before 1.0.0 went out.
#
#   tools/first-visit-smoke.sh <base-url> <command that prints the server log>
#   tools/first-visit-smoke.sh http://127.0.0.1:3001 "docker logs smoke"
#
# What it holds the server to, in order, each the way the README describes it:
#   1. the page itself loads;
#   2. a request from off the machine is told a setup code is required;
#   3. that code is in the server's log;
#   4. the code sets the first password and logs the setter in;
#   5. the library behind it answers, and is empty.
# CURL_OPTS is passed to every curl (`-k` for a local HTTPS check).
set -euo pipefail

BASE="$1"
LOGS="$2"
ORIGIN="Origin: $BASE"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
c() { curl -sS --max-time 10 ${CURL_OPTS:-} "$@"; }

up=""
for _ in $(seq 1 60); do
    if c -f -o /dev/null "$BASE/"; then up=1; break; fi
    sleep 2
done
if [ -z "$up" ]; then
    echo "FAIL the page never loaded at $BASE/" >&2
    eval "$LOGS" >&2 || true
    exit 1
fi
echo "ok   1. the page loads"

status="$(c -f "$BASE/api/auth/status")"
case "$status" in
    *'"setupRequired":true'*) echo "ok   2. a visit from another machine is asked for a setup code" ;;
    *) echo "FAIL 2. expected setupRequired, got: $status" >&2; exit 1 ;;
esac

code="$(eval "$LOGS" 2>&1 | grep -o 'setup code: [0-9A-F-]*' | tail -1 | cut -d' ' -f3)"
if [ -z "$code" ]; then
    echo "FAIL 3. no setup code in the server log" >&2
    eval "$LOGS" >&2 || true
    exit 1
fi
echo "ok   3. the setup code is in the server log"

setup="$(c -c "$JAR" -H "$ORIGIN" -H 'Content-Type: application/json' \
    -d "{\"password\":\"first-visit-smoke\",\"setupCode\":\"$code\"}" "$BASE/api/auth/setup")"
case "$setup" in
    *'"ok":true'*) echo "ok   4. the code sets the first password" ;;
    *) echo "FAIL 4. setup refused: $setup" >&2; exit 1 ;;
esac

projects="$(c -f -b "$JAR" -H "$ORIGIN" "$BASE/api/projects")"
if [ "$projects" != "[]" ]; then
    echo "FAIL 5. expected an empty library, got: ${projects:0:200}" >&2
    exit 1
fi
echo "ok   5. the library answers behind the password, and is empty"

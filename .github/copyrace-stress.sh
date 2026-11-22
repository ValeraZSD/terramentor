#!/usr/bin/env bash
# TEMPORARY: runs hosted/rehearse.sh's concurrent new/remove block N times
# against real Docker, every copy.sh call traced, to see how two proxy
# recreates end up overlapping. Removed before the pull request is ready.
set -uo pipefail
N="${1:-25}"
export TM_ENV_FILE=/dev/null TM_DOMAIN=example.test TM_IMAGE=terramentor:ci TM_TLS=internal
export TM_BIND_ADDRESS=127.0.0.1 TM_HTTP_PORT=8080 TM_HTTPS_PORT=8443
export AI_PROVIDER=openai AI_BASE_URL=http://127.0.0.1:9/v1 AI_MODEL=none
TM_BACKUP_DIR="$(mktemp -d)/b"; export TM_BACKUP_DIR
OUT="$PWD/stress-out"; mkdir -p "$OUT"
docker compose version
echo "mkdir: $(mkdir --version | head -1) ($(readlink -f "$(command -v mkdir)"))"
# 300 trials of 8 processes taking one name at once; a trial with more than
# one winner means that way of taking a lock is not exclusive.
race() {
    local multi=0 t d w
    for t in $(seq 1 300); do
        d="$(mktemp -d)"
        w="$(for k in 1 2 3 4 5 6 7 8; do
            { if [ "$1" = mkdir ]; then mkdir "$d/l" 2>/dev/null; else ( set -C; : > "$d/l" ) 2>/dev/null; fi && echo won; } &
        done; wait)"
        [ "$(grep -c won <<< "$w")" -gt 1 ] && multi=$((multi + 1))
        rm -rf "$d"
    done
    echo "$1: trials with more than one winner: $multi of 300"
}
race mkdir
race noclobber
docker events --format '{{.TimeNano}} {{.Type}} {{.Action}} {{.Actor.Attributes.name}} {{slice .Actor.ID 0 12}}' > "$OUT/events.txt" & EV=$!

t() {
    local tag="$1"; shift
    PS4='+ ${EPOCHREALTIME} $$ ' bash -x hosted/copy.sh "$@" > "$OUT/$tag.out" 2> "$OUT/$tag.err"
}
reset() {
    for n in erin dave; do
        docker rm -f "tm-$n" >/dev/null 2>&1; docker volume rm "tm-$n-data" >/dev/null 2>&1
        rm -f "hosted/sites/$n.caddy" "hosted/copies/$n.env"
    done
    docker ps -aq --filter name=_terramentor-proxy | xargs -r docker rm -f >/dev/null
    for n in erin dave; do docker network rm "tm-$n" >/dev/null 2>&1; done
    rm -rf hosted/.locks
}

bad=0
for i in $(seq 1 "$N"); do
    t "$i-new-e1" new erin & a=$!; t "$i-new-e2" new erin & b=$!; t "$i-new-d" new dave & c=$!
    wait $a; ra=$?; wait $b; rb=$?; wait $c; rc=$?
    t "$i-rm-e" remove erin --yes & a=$!; t "$i-rm-d" remove dave --yes & b=$!
    wait $a; qa=$?; wait $b; qb=$?
    conflicts="$(cat "$OUT/$i-"*.err | grep -c 'Conflict')"
    echo "round $i: new erin $ra/$rb, new dave $rc, removes $qa/$qb, Conflict lines $conflicts"
    if [ "$conflicts" != 0 ] || [ "$rc" != 0 ] || [ "$qa" != 0 ] || [ "$qb" != 0 ] || [ $((ra == 0)) = $((rb == 0)) ]; then
        bad=$((bad + 1))
        echo "  --- lock and compose steps of round $i, by time"
        grep -hE '^\++ [0-9.]+ [0-9]+ (mkdir [^-]|rmdir|docker compose|exit|die)' "$OUT/$i-"*.err | sort -k2 -n | sed 's/^/  /' | head -60
        echo "  --- compose output of round $i"
        grep -hvE '^\++ ' "$OUT/$i-"*.err | grep -E 'Container|Conflict|copy.sh' | sed 's/^/  /' | head -30
        reset
    fi
done
kill "$EV" 2>/dev/null
echo "rounds with a failure: $bad of $N"

#!/usr/bin/env bash
# Two hosted copies behind the proxy on one machine, end to end: created by
# copy.sh, reached over HTTPS by name, kept apart, refusing what a hosted copy
# refuses, backed up, restored and removed. CI runs it against the image it
# just built; it needs Docker, curl and free ports (TM_HTTP_PORT/TM_HTTPS_PORT,
# 8080/8443 unless set).
#
#   TM_IMAGE=terramentor:ci bash hosted/rehearse.sh
#   KEEP=1 ...   leaves what is left running afterwards (to look at it)
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"

export TM_ENV_FILE=/dev/null
export TM_DOMAIN="${TM_DOMAIN:-example.test}"
export TM_IMAGE="${TM_IMAGE:-terramentor:ci}"
export TM_TLS=internal
export TM_BIND_ADDRESS=127.0.0.1
export TM_HTTP_PORT="${TM_HTTP_PORT:-8080}"
export TM_HTTPS_PORT="${TM_HTTPS_PORT:-8443}"
export TM_MEMORY="${TM_MEMORY:-768m}"
# Scratch folders named so the Windows docker and curl of Git Bash read them too.
scratch_dir() { (cd "$(mktemp -d)" && { pwd -W 2>/dev/null || pwd; }); }
export TM_BACKUP_DIR="${TM_BACKUP_DIR:-$(scratch_dir)}"
# A closed port: nothing here may reach a model.
export AI_PROVIDER=openai AI_BASE_URL=http://127.0.0.1:9/v1 AI_MODEL=none
COPY="$HERE/copy.sh"
A=alice
B=bob
WORK="$(scratch_dir)"

# It starts and, at the end, deletes the proxy and its certificates: never on a
# machine that already runs copies.
if docker container inspect terramentor-proxy >/dev/null 2>&1; then
    echo "rehearse.sh: a terramentor-proxy already runs here; rehearse on a machine with no copies" >&2
    exit 1
fi

cleanup() {
    [ "${KEEP:-}" = 1 ] && return 0
    for n in "$A" "$B"; do
        docker rm -f "tm-$n" >/dev/null 2>&1 || true
        docker volume rm "tm-$n-data" >/dev/null 2>&1 || true
        rm -f "$HERE/sites/$n.caddy" "$HERE/copies/$n.env"
    done
    (cd "$HERE" && docker compose -f docker-compose.yml down -v >/dev/null 2>&1) || true
    for n in "$A" "$B"; do docker network rm "tm-$n" >/dev/null 2>&1 || true; done
    rm -f "$HERE/networks.yml"
    rm -rf "$WORK"
}
trap cleanup EXIT

pass=0
ok() { pass=$((pass + 1)); echo "ok   $*"; }
no() { echo "FAIL $*" >&2; exit 1; }
fqdn() { echo "$1.$TM_DOMAIN"; }
origin() { echo "https://$(fqdn "$1"):$TM_HTTPS_PORT"; }
# curl through the proxy, by name, as a phone would.
c() {
    local name="$1" path="$2"; shift 2
    curl -sS -k --max-time 15 --resolve "$(fqdn "$name"):$TM_HTTPS_PORT:127.0.0.1" -H "Origin: $(origin "$name")" "$@" "$(origin "$name")$path"
}
status() { local name="$1" path="$2"; shift 2; c "$name" "$path" -o "$WORK/body" -w '%{http_code}' "$@"; }
login() { c "$1" /api/auth/login -c "$WORK/$3.jar" -H 'Content-Type: application/json' -d "{\"password\":\"$2\"}" -o "$WORK/body" -w '%{http_code}'; }

echo "--- two copies ---"
outA="$(bash "$COPY" new "$A")"; echo "$outA" | sed 's/^password: .*/password: (hidden)/'
outB="$(bash "$COPY" new "$B")"; echo "$outB" | sed 's/^password: .*/password: (hidden)/'
pwA="$(echo "$outA" | sed -n 's/^password: //p')"
pwB="$(echo "$outB" | sed -n 's/^password: //p')"
[ -n "$pwA" ] && [ -n "$pwB" ] && [ "$pwA" != "$pwB" ] && ok "each copy got its own password" || no "passwords: '$pwA' '$pwB'"

[ "$(status "$A" /api/projects)" = 401 ] && ok "a visitor without the password reads nothing" || no "unauthenticated read was not refused"
c "$A" /api/auth/status | grep -q '"setupRequired"' && no "a copy offered first-run setup" || ok "no copy offers first-run setup: the password was set before it started"
[ "$(login "$A" "$pwA" a)" = 200 ] && ok "$A signs in with its password over HTTPS" || no "$A login"
[ "$(login "$B" "$pwA" x)" = 401 ] && ok "$A's password does not open $B" || no "$A's password opened $B"
[ "$(login "$B" "$pwB" b)" = 200 ] && ok "$B signs in with its own" || no "$B login"
[ "$(status "$B" /api/projects -b "$WORK/a.jar")" = 401 ] && ok "$A's session is no session on $B" || no "$A's cookie worked on $B"
secure="$(awk -F'\t' '$6 == "sp_sid" { print $4 }' "$WORK/a.jar")"
[ "$secure" = TRUE ] && ok "the session cookie is marked Secure behind the proxy" || no "cookie not Secure: $(cat "$WORK/a.jar")"

c "$A" /api/projects -b "$WORK/a.jar" -H 'Content-Type: application/json' -d '{"name":"Rehearsal course"}' -o "$WORK/made.json"
id="$(sed -n 's/.*"id":\([0-9]*\).*/\1/p' "$WORK/made.json" | head -1)"
[ -n "$id" ] && ok "$A makes a project (id $id)" || no "project not made: $(cat "$WORK/made.json")"
c "$B" /api/projects -b "$WORK/b.jar" | grep -q 'Rehearsal course' && no "$B sees $A's project" || ok "$B does not see it"

if docker exec "tm-$A" node -e "fetch('http://tm-$B:3001/api/health',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0),()=>process.exit(1))"; then
    no "$A's container reached $B's"
else
    ok "$A's container cannot reach $B's: separate networks"
fi

echo "--- what a hosted copy refuses ---"
r="$(c "$A" /api/settings/ai_openai_base_url -b "$WORK/a.jar" -X PUT -H 'Content-Type: application/json' -d '{"value":"http://169.254.169.254/v1"}')"
echo "$r" | grep -q '"hosted":true' && ok "pointing the model at the server's network is refused: $r" || no "model address write: $r"
r="$(c "$A" /api/auth/disable -b "$WORK/a.jar" -H 'Content-Type: application/json' -d "{\"password\":\"$pwA\"}")"
echo "$r" | grep -q '"hosted":true' && ok "removing the password is refused: $r" || no "disable: $r"

echo "--- backup and restore ---"
archive="$(bash "$COPY" backup "$A" | tail -1)"
[ -s "$archive" ] && ok "online backup of $A: $archive ($(wc -c < "$archive") bytes)" || no "no archive"
# Read through stdin: GNU tar takes "Z:/..." for a remote host.
listing="$(tar tzf - < "$archive")"
grep -q '/terramentor.db$' <<< "$listing" && grep -q '/credentials.json$' <<< "$listing" && ok "it holds the database and the credentials" || no "archive contents: $listing"
[ "$(status "$A" "/api/projects/$id" -b "$WORK/a.jar" -X DELETE)" = 200 ] && ok "the project is deleted" || no "delete"
c "$A" /api/projects -b "$WORK/a.jar" | grep -q 'Rehearsal course' && no "still there after delete" || ok "…and gone"
bash "$COPY" restore "$A" "$archive"
[ "$(login "$A" "$pwA" a2)" = 200 ] && ok "the same password opens the restored copy" || no "login after restore"
c "$A" /api/projects -b "$WORK/a2.jar" | grep -q 'Rehearsal course' && ok "the project is back after the restore" || no "project not restored"

all="$(bash "$COPY" backup --all)"
[ "$(echo "$all" | grep -c 'tar.gz$')" = 2 ] && ok "backup --all wrote one archive per copy" || no "backup --all: $all"

echo "--- update and refusals of the tool itself ---"
before="$(ls "$TM_BACKUP_DIR/$A" | wc -l)"
bash "$COPY" update "$A" | grep -q "^updated: $A$" && ok "update replaces $A's container" || no "update $A"
[ "$(ls "$TM_BACKUP_DIR/$A" | wc -l)" -gt "$before" ] && ok "…after backing it up" || no "update made no backup"
[ "$(login "$A" "$pwA" a3)" = 200 ] && c "$A" /api/projects -b "$WORK/a3.jar" | grep -q 'Rehearsal course' \
    && ok "the same password and library after the update" || no "library or password lost in the update"
if AI_MODEL='' bash "$COPY" new carol >/dev/null 2>&1; then no "a copy with no model was made"; else ok "a copy with no model is refused"; fi
docker volume inspect tm-carol-data >/dev/null 2>&1 && no "the refused copy left a volume" || ok "…and leaves nothing behind"

echo "--- remove ---"
out="$(bash "$COPY" remove "$B" --yes)"; echo "$out"
docker container inspect "tm-$B" >/dev/null 2>&1 && no "$B's container is still there" || ok "$B's container is gone"
docker volume inspect "tm-$B-data" >/dev/null 2>&1 && no "$B's volume is still there" || ok "$B's volume is gone"
[ -s "$(echo "$out" | sed -n 's/^its library: //p')" ] && ok "$B's library was exported first" || no "no export of $B"
[ "$(status "$A" /api/auth/status)" = 200 ] && ok "$A still answers after $B's removal" || no "$A down after removal"

echo "$pass passed"

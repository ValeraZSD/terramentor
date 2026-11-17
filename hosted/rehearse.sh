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
# A space in the path: the backup tool keeps paths whole (retention included).
# The archives hold credentials, so a folder made here is deleted at the end;
# one the operator named is left alone.
OWN_BACKUPS=""
if [ -z "${TM_BACKUP_DIR:-}" ]; then OWN_BACKUPS="$(scratch_dir)"; TM_BACKUP_DIR="$OWN_BACKUPS/backups here"; fi
export TM_BACKUP_DIR
# A closed port: nothing here may reach a model.
export AI_PROVIDER=openai AI_BASE_URL=http://127.0.0.1:9/v1 AI_MODEL=none
COPY="$HERE/copy.sh"
A=alice
B=bob
# Every name the rehearsal makes; it deletes only these, and only when none
# existed before it started.
NAMES="alice bob carol dave erin"
WORK="$(scratch_dir)"

# It starts and, at the end, deletes the proxy and its certificates: never on a
# machine that already runs copies.
if docker container inspect terramentor-proxy >/dev/null 2>&1; then
    echo "rehearse.sh: a terramentor-proxy already runs here; rehearse on a machine with no copies" >&2
    exit 1
fi
for n in $NAMES; do
    if docker container inspect "tm-$n" >/dev/null 2>&1 || docker volume inspect "tm-$n-data" >/dev/null 2>&1 \
        || docker network inspect "tm-$n" >/dev/null 2>&1 || [ -e "$HERE/sites/$n.caddy" ] || [ -e "$HERE/copies/$n.env" ]; then
        echo "rehearse.sh: tm-$n (or its site or key file) already exists here and the rehearsal would delete it; rehearse on a machine with no copies" >&2
        exit 1
    fi
done

cleanup() {
    [ "${KEEP:-}" = 1 ] && return 0
    for n in $NAMES; do
        docker rm -f "tm-$n" >/dev/null 2>&1 || true
        docker volume rm "tm-$n-data" >/dev/null 2>&1 || true
        rm -f "$HERE/sites/$n.caddy" "$HERE/copies/$n.env"
    done
    (cd "$HERE" && docker compose -f docker-compose.yml down -v >/dev/null 2>&1) || true
    for n in $NAMES; do docker network rm "tm-$n" >/dev/null 2>&1 || true; done
    rm -f "$HERE/networks.yml"
    rm -rf "$WORK"
    [ -n "$OWN_BACKUPS" ] && rm -rf "$OWN_BACKUPS"
    return 0
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
kept_before="$(find "$(dirname "$archive")" -maxdepth 1 -name '*.tar.gz' | wc -l)"
safety="$(bash "$COPY" restore "$A" "$archive" | sed -n 's/^its library before the restore: //p')"
[ -s "$safety" ] && [ "$safety" != "$archive" ] && [ -s "$archive" ] \
    && [ "$(find "$(dirname "$archive")" -maxdepth 1 -name '*.tar.gz' | wc -l)" = $((kept_before + 1)) ] \
    && ok "the restore backed $A up first ($safety) and kept the archive it restored" || no "no backup before the restore: '$safety'"
[ "$(login "$A" "$pwA" a2)" = 200 ] && ok "the same password opens the restored copy" || no "login after restore"
c "$A" /api/projects -b "$WORK/a2.jar" | grep -q 'Rehearsal course' && ok "the project is back after the restore" || no "project not restored"

echo "not a backup" | gzip > "$WORK/junk.tar.gz"
if bash "$COPY" restore "$A" "$WORK/junk.tar.gz" 2>"$WORK/err"; then no "a file that is no backup was restored"; fi
running_a() { [ "$(docker container inspect -f '{{.State.Running}}' "tm-$A")" = true ]; }
running_a && [ "$(status "$A" /api/auth/status)" = 200 ] && ok "a file that is no backup is refused with $A still running: $(cat "$WORK/err")" || no "junk restore stopped $A"
# A real archive whose database fails its check: the copy is stopped first, so
# it must come back up on its own library.
mkdir -p "$WORK/bad/.backup-x" && echo "not a database" > "$WORK/bad/.backup-x/terramentor.db"
tar czf - -C "$WORK/bad" .backup-x > "$WORK/bad.tar.gz"
if bash "$COPY" restore "$A" "$WORK/bad.tar.gz" 2>"$WORK/err"; then no "a broken backup was restored"; fi
running_a && [ "$(login "$A" "$pwA" a4)" = 200 ] && c "$A" /api/projects -b "$WORK/a4.jar" | grep -q 'Rehearsal course' \
    && ok "a backup that fails its check leaves $A running on its own library: $(tail -1 "$WORK/err")" || no "broken restore left $A down or changed"

before="$(find "$TM_BACKUP_DIR/$A" -name '*.tar.gz' | wc -l)"
bash "$COPY" backup "$A" >/dev/null & p1=$!
bash "$COPY" backup "$A" >/dev/null & p2=$!
r1=0; r2=0; wait "$p1" || r1=$?; wait "$p2" || r2=$?
[ "$r1" = 0 ] && [ "$r2" = 0 ] || no "two backups at once failed ($r1, $r2)"
[ "$(find "$TM_BACKUP_DIR/$A" -name '*.tar.gz' | wc -l)" = $((before + 2)) ] && ok "two backups at once keep two archives" || no "two backups at once kept $(ls "$TM_BACKUP_DIR/$A")"
# Another run holding the copy (a restore, as it would): a backup waits for it
# rather than reading a library that may change halfway.
mkdir -p "$HERE/.locks" && mkdir "$HERE/.locks/$A"
bash "$COPY" backup "$A" >/dev/null & p1=$!
sleep 3
kill -0 "$p1" 2>/dev/null && waited=1 || waited=0
rmdir "$HERE/.locks/$A"
r1=0; wait "$p1" || r1=$?
[ "$waited" = 1 ] && [ "$r1" = 0 ] && ok "a backup waits while another run holds $A, then completes" || no "backup with $A held: waited=$waited exit=$r1"
newest="$(find "$TM_BACKUP_DIR/$A" -name '*.tar.gz' | sort | tail -1)"
TM_BACKUP_KEEP=2 bash "$COPY" backup "$A" >/dev/null
[ "$(find "$TM_BACKUP_DIR/$A" -name '*.tar.gz' | wc -l)" = 2 ] && [ -s "$newest" ] \
    && ok "retention keeps the newest 2 in a folder with a space in its path" || no "retention left: $(ls "$TM_BACKUP_DIR/$A")"

all="$(bash "$COPY" backup --all)"
[ "$(echo "$all" | grep -c 'tar.gz$')" = 2 ] && ok "backup --all wrote one archive per copy" || no "backup --all: $all"

echo "--- update and refusals of the tool itself ---"
before="$(ls "$TM_BACKUP_DIR/$A" | wc -l)"
rc=0; out="$(bash "$COPY" update "$A" 2>&1)" || rc=$?
[ "$rc" = 0 ] && echo "$out" | grep -q "^updated: $A$" && ok "update replaces $A's container" || no "update $A (exit $rc): $out"
[ "$(ls "$TM_BACKUP_DIR/$A" | wc -l)" -gt "$before" ] && ok "…after backing it up" || no "update made no backup"
[ "$(login "$A" "$pwA" a3)" = 200 ] && c "$A" /api/projects -b "$WORK/a3.jar" | grep -q 'Rehearsal course' \
    && ok "the same password and library after the update" || no "library or password lost in the update"
if AI_MODEL='' bash "$COPY" new carol >/dev/null 2>&1; then no "a copy with no model was made"; else ok "a copy with no model is refused"; fi
docker volume inspect tm-carol-data >/dev/null 2>&1 && no "the refused copy left a volume" || ok "…and leaves nothing behind"
docker network create tm-dave >/dev/null
if bash "$COPY" new dave >/dev/null 2>&1; then no "a copy was made over an existing network"; fi
docker network inspect tm-dave >/dev/null 2>&1 && ok "a name whose network exists is refused, and that network is left alone" || no "copy.sh new deleted a network it did not make"
docker network rm tm-dave >/dev/null
# Three at once: the same name twice, and another name applying the shared proxy alongside.
bash "$COPY" new erin > "$WORK/erin1" 2>&1 & p1=$!
bash "$COPY" new erin > "$WORK/erin2" 2>&1 & p2=$!
bash "$COPY" new dave > "$WORK/dave" 2>&1 & p3=$!
r1=0; r2=0; r3=0; wait "$p1" || r1=$?; wait "$p2" || r2=$?; wait "$p3" || r3=$?
[ $((r1 == 0)) -ne $((r2 == 0)) ] && [ "$(status erin /api/auth/status)" = 200 ] \
    && ok "two 'new erin' at once: one makes it, the other is refused and undoes nothing of it" || no "new erin twice: $r1 $r2 $(cat "$WORK/erin1" "$WORK/erin2" | sed 's/^password: .*/password: (hidden)/')"
[ "$r3" = 0 ] && [ "$(status dave /api/auth/status)" = 200 ] && [ "$(status erin /api/auth/status)" = 200 ] \
    && ok "a copy made at the same time as another: both stay behind the proxy" || no "new dave beside erin: $r3 $(sed 's/^password: .*/password: (hidden)/' "$WORK/dave")"
bash "$COPY" remove erin --yes >/dev/null & p1=$!
bash "$COPY" remove dave --yes >/dev/null & p2=$!
r1=0; r2=0; wait "$p1" || r1=$?; wait "$p2" || r2=$?
[ "$r1" = 0 ] && [ "$r2" = 0 ] || no "two removes at once failed ($r1, $r2)"
for n in erin dave; do
    docker container inspect "tm-$n" >/dev/null 2>&1 || docker network inspect "tm-$n" >/dev/null 2>&1 || docker volume inspect "tm-$n-data" >/dev/null 2>&1 \
        && no "two removes at once left something of $n"
done
ok "two copies removed at once: nothing of either is left"

echo "--- remove ---"
out="$(bash "$COPY" remove "$B" --yes)"; echo "$out"
docker container inspect "tm-$B" >/dev/null 2>&1 && no "$B's container is still there" || ok "$B's container is gone"
docker volume inspect "tm-$B-data" >/dev/null 2>&1 && no "$B's volume is still there" || ok "$B's volume is gone"
[ -s "$(echo "$out" | sed -n 's/^its library: //p')" ] && ok "$B's library was exported first" || no "no export of $B"
[ "$(status "$A" /api/auth/status)" = 200 ] && ok "$A still answers after $B's removal" || no "$A down after removal"

echo "$pass passed"

#!/usr/bin/env bash
# Two hosted copies behind the proxy on one machine, end to end: created by
# copy.sh, reached over HTTPS by name, kept apart, refusing what a hosted copy
# refuses, backed up, restored and removed. Then a site front desk beside them,
# backed up with the copies, and erasure: archives encrypted to a key made
# here, a removed person's archives gone after the grace period, and a restore
# of a backup older than an erasure that brings nobody back. CI runs it against
# the image it just built; it needs Docker, curl, age and free ports
# (TM_HTTP_PORT/TM_HTTPS_PORT, 8080/8443, and TM_SITE_PORT, 8090, unless set).
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
# The site front desk, its volume and the address it answers to.
SITE=tm-rehearse-site
SITE_HOST="site.$TM_DOMAIN"
SITE_PORT="${TM_SITE_PORT:-8090}"
command -v age >/dev/null 2>&1 && command -v age-keygen >/dev/null 2>&1 \
    || { echo "rehearse.sh: needs age and age-keygen (apt install age)" >&2; exit 1; }
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
if docker container inspect "$SITE" >/dev/null 2>&1 || docker volume inspect "$SITE" >/dev/null 2>&1; then
    echo "rehearse.sh: $SITE (or its volume) already exists here and the rehearsal would delete it" >&2
    exit 1
fi
if [ -e "$HERE/erasures" ]; then
    echo "rehearse.sh: $HERE/erasures (an erasure ledger) already exists here and the rehearsal would delete it" >&2
    exit 1
fi

cleanup() {
    [ "${KEEP:-}" = 1 ] && return 0
    docker rm -f "$SITE" >/dev/null 2>&1 || true
    docker volume rm "$SITE" >/dev/null 2>&1 || true
    for n in $NAMES; do
        docker rm -f "tm-$n" >/dev/null 2>&1 || true
        docker volume rm "tm-$n-data" >/dev/null 2>&1 || true
        rm -f "$HERE/sites/$n.caddy" "$HERE/copies/$n.env"
    done
    (cd "$HERE" && docker compose -f docker-compose.yml down -v >/dev/null 2>&1) || true
    for n in $NAMES; do docker network rm "tm-$n" >/dev/null 2>&1 || true; done
    rm -f "$HERE/networks.yml" "$HERE/erasures"
    rm -rf "$WORK"
    [ -n "$OWN_BACKUPS" ] && rm -rf "$OWN_BACKUPS"
    return 0
}
trap cleanup EXIT

# The operator's key pair: the server is given only the public half, which is
# all a backup needs; the private half is what a restore asks for.
age-keygen -o "$WORK/backup.key" 2>/dev/null
age-keygen -y "$WORK/backup.key" > "$WORK/recipients"
age-keygen -o "$WORK/other.key" 2>/dev/null
export TM_BACKUP_RECIPIENTS="$WORK/recipients" TM_BACKUP_IDENTITY="$WORK/backup.key"
# Lets the erasure checks below move copy.sh's clock (TM_NOW), here only.
export TM_REHEARSAL=1
# An archive as tar reads it: opened with the key when it is encrypted.
open_archive() {
    if [ "$(head -c 21 "$1")" = age-encryption.org/v1 ]; then age -d -i "$WORK/backup.key" "$1"; else cat "$1"; fi
}

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
listing="$(open_archive "$archive" | tar tzf -)"
grep -q '/terramentor.db$' <<< "$listing" && grep -q '/credentials.json$' <<< "$listing" && ok "it holds the database and the credentials" || no "archive contents: $listing"
[ "$(status "$A" "/api/projects/$id" -b "$WORK/a.jar" -X DELETE)" = 200 ] && ok "the project is deleted" || no "delete"
c "$A" /api/projects -b "$WORK/a.jar" | grep -q 'Rehearsal course' && no "still there after delete" || ok "…and gone"
kept_before="$(find "$(dirname "$archive")" -maxdepth 1 -name '*.tar.gz*' | wc -l)"
safety="$(bash "$COPY" restore "$A" "$archive" | sed -n 's/^its library before the restore: //p')"
[ -s "$safety" ] && [ "$safety" != "$archive" ] && [ -s "$archive" ] \
    && [ "$(find "$(dirname "$archive")" -maxdepth 1 -name '*.tar.gz*' | wc -l)" = $((kept_before + 1)) ] \
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
# The copy cannot be backed up first (its backup folder would sit under a plain
# file): the restore stops before it touches the copy, and --no-backup goes on.
: > "$WORK/plain-file"
if TM_BACKUP_DIR="$WORK/plain-file/x" bash "$COPY" restore "$A" "$archive" 2>"$WORK/err"; then no "a restore went on without the backup of what it replaces"; fi
running_a && [ "$(status "$A" /api/auth/status)" = 200 ] && grep -q "was not touched" "$WORK/err" \
    && ok "a restore whose backup fails leaves $A running: $(tail -1 "$WORK/err")" || no "a failed backup before the restore did not stop it: $(cat "$WORK/err")"
kept_before="$(find "$TM_BACKUP_DIR/$A" -name '*.tar.gz*' | wc -l)"
TM_BACKUP_DIR="$WORK/plain-file/x" bash "$COPY" restore "$A" "$archive" --no-backup >/dev/null
[ "$(find "$TM_BACKUP_DIR/$A" -name '*.tar.gz*' | wc -l)" = "$kept_before" ] && [ "$(login "$A" "$pwA" a5)" = 200 ] \
    && ok "--no-backup restores without taking one" || no "restore --no-backup"

before="$(find "$TM_BACKUP_DIR/$A" -name '*.tar.gz*' | wc -l)"
bash "$COPY" backup "$A" >/dev/null & p1=$!
bash "$COPY" backup "$A" >/dev/null & p2=$!
r1=0; r2=0; wait "$p1" || r1=$?; wait "$p2" || r2=$?
[ "$r1" = 0 ] && [ "$r2" = 0 ] || no "two backups at once failed ($r1, $r2)"
[ "$(find "$TM_BACKUP_DIR/$A" -name '*.tar.gz*' | wc -l)" = $((before + 2)) ] && ok "two backups at once keep two archives" || no "two backups at once kept $(ls "$TM_BACKUP_DIR/$A")"
# Another run holding the copy (a restore, as it would): a backup waits for it
# rather than reading a library that may change halfway.
mkdir -p "$HERE/.locks" && mkdir "$HERE/.locks/$A"
bash "$COPY" backup "$A" >/dev/null & p1=$!
sleep 3
kill -0 "$p1" 2>/dev/null && waited=1 || waited=0
rmdir "$HERE/.locks/$A"
r1=0; wait "$p1" || r1=$?
[ "$waited" = 1 ] && [ "$r1" = 0 ] && ok "a backup waits while another run holds $A, then completes" || no "backup with $A held: waited=$waited exit=$r1"
newest="$(find "$TM_BACKUP_DIR/$A" -name '*.tar.gz*' | sort | tail -1)"
TM_BACKUP_KEEP=2 bash "$COPY" backup "$A" >/dev/null
[ "$(find "$TM_BACKUP_DIR/$A" -name '*.tar.gz*' | wc -l)" = 2 ] && [ -s "$newest" ] \
    && ok "retention keeps the newest 2 in a folder with a space in its path" || no "retention left: $(ls "$TM_BACKUP_DIR/$A")"

all="$(bash "$COPY" backup --all)"
[ "$(echo "$all" | grep -cE '/(alice|bob)/[^/]*\.tar\.gz(\.age)?$')" = 2 ] && ok "backup --all wrote one archive per copy" || no "backup --all: $all"

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

# The four erasure checks report each on its own line and the run fails at the
# end, so a run shows every one that does not hold, not only the first.
MISSED=()
miss() { echo "FAIL $*" >&2; MISSED+=("${1%%:*}"); }
archives() { { find "$1" -maxdepth 1 -type f -name '*.tar.gz*' 2>/dev/null || true; } | wc -l; }
NOW="$(date -u +%s)"
DAY=86400

echo "--- a site front desk beside the copies ---"
docker volume create "$SITE" >/dev/null
docker run -d --name "$SITE" --user 0 -v "$SITE":/site -e SITE_DIR=/site -e HOST=0.0.0.0 -e SITE_HOSTS="$SITE_HOST" \
    -e SITE_BREACH_CHECK=0 -e AI_PROVIDER=openai -e AI_BASE_URL=http://127.0.0.1:9/v1 -e AI_MODEL=none \
    -p "127.0.0.1:$SITE_PORT:3001" "$TM_IMAGE" node server/site/index.js >/dev/null
export TM_SITE_CONTAINER="$SITE"
sc() { local path="$1"; shift; curl -sS --max-time 30 --resolve "$SITE_HOST:$SITE_PORT:127.0.0.1" "$@" "http://$SITE_HOST:$SITE_PORT$path"; }
site_up() { for _ in $(seq 1 60); do sc /site/health -f >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
# The session cookie is read from the answer's headers: it is Secure, which curl's
# own jar keeps only over HTTPS.
site_cookie() { sed -n 's/^[Ss]et-[Cc]ookie: __Host-tm_session=\([^;]*\).*/\1/p' "$WORK/h" | tr -d '\r' | tail -1; }
site_join() {
    local link
    link="$(docker exec "$SITE" node server/site/cli.js invite "$1")"
    : > "$WORK/h"
    sc "/site/invite/${link##*/site/invite/}" -D "$WORK/h" -o /dev/null --data-urlencode "password=$2" --data-urlencode "again=$2" || true
    site_cookie
}
site_signin() {
    : > "$WORK/h"
    sc /site/sign-in -D "$WORK/h" -o /dev/null --data-urlencode "email=$1" --data-urlencode "password=$2" || true
    site_cookie
}
sa() { local ck="$1" path="$2"; shift 2; sc "$path" -H "Cookie: __Host-tm_session=$ck" -H "Origin: http://$SITE_HOST:$SITE_PORT" "$@"; }
site_course() { sa "$1" /api/projects -H 'Content-Type: application/json' -d "{\"name\":\"$2\"}" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1; }
site_has() { sa "$1" /api/projects | grep -q "$2"; }
library_of() { docker exec "$SITE" node server/site/cli.js accounts | awk -F'\t' -v e="$1" '$1 == e { print $2 }'; }
site_up && ok "the front desk answers" || no "the front desk did not start: $(docker logs --tail 20 "$SITE" 2>&1)"
PW_ANN=rehearsal-password-ann PW_BEN=rehearsal-password-ben
ck_ann="$(site_join ann@example.test "$PW_ANN")"
ck_ben="$(site_join ben@example.test "$PW_BEN")"
[ -n "$ck_ann" ] && [ -n "$ck_ben" ] && ok "two people join the site by invitation" || no "site join: '$ck_ann' '$ck_ben'"
[ -n "$(site_course "$ck_ann" 'Ann course')" ] && ben_course="$(site_course "$ck_ben" 'Ben course')" && [ -n "$ben_course" ] \
    && ok "each makes a course in their own library" || no "site courses not made"
ann_lib="$(library_of ann@example.test)"
[ -n "$ann_lib" ] || no "no library for ann"

echo "--- last night's backup: encrypted, and restored ---"
[ "$(login "$A" "$pwA" n)" = 200 ] || no "$A login"
c "$A" /api/projects -b "$WORK/n.jar" -H 'Content-Type: application/json' -d '{"name":"Nightly course"}' -o "$WORK/made.json"
nid="$(sed -n 's/.*"id":\([0-9]*\).*/\1/p' "$WORK/made.json" | head -1)"
night="$(bash "$COPY" backup --all 2>"$WORK/err")" || echo "backup --all: $(cat "$WORK/err")" >&2
night_a="$(grep "/$A/" <<< "$night" | tail -1)" || true
night_desk="$(grep '/_site/_desk/' <<< "$night" | tail -1)" || true
night_ann="$(grep "/_site/$ann_lib/" <<< "$night" | tail -1)" || true
[ -s "$night_ann" ] && cp "$night_ann" "$WORK/offsite-ann"

# Check 2: the archive is useless without the private key.
if [ -s "$night_a" ] && [ "$(head -c 21 "$night_a")" = age-encryption.org/v1 ] \
    && ! tar tzf - < "$night_a" >/dev/null 2>&1 \
    && ! age -d -i "$WORK/other.key" "$night_a" >/dev/null 2>&1 \
    && age -d -i "$WORK/backup.key" "$night_a" | tar tzf - | grep -q '/terramentor\.db$'; then
    ok "check 2: $A's nightly archive is age-encrypted: tar cannot read it, another key cannot open it, the operator's key does"
else
    miss "check 2: $A's nightly archive is readable without the private key, or unreadable with it: '$night_a'"
fi
plain="$(find "$TM_BACKUP_DIR" -type f ! -name '*.age' ! -name erasures)"
[ -z "$plain" ] && ok "check 2: nothing but encrypted archives (and the erasure ledger) in the backup folder" \
    || miss "check 2: readable files in the backup folder: $plain"
if TM_BACKUP_IDENTITY='' bash "$COPY" restore "$A" "${night_a:-/nonexistent}" >/dev/null 2>"$WORK/err"; then
    miss "check 2: a restore without the private key went on"
else
    running_a && ok "check 2: a restore without the private key is refused, $A untouched: $(tail -1 "$WORK/err")" \
        || miss "check 2: a restore without the key stopped $A"
fi

# Check 3: last night's backup round-trips, for a copy and for the site.
[ "$(status "$A" "/api/projects/$nid" -b "$WORK/n.jar" -X DELETE)" = 200 ] || no "delete the nightly course"
[ "$(sa "$ck_ben" "/api/projects/$ben_course" -X DELETE -o /dev/null -w '%{http_code}')" = 200 ] || no "ben deletes the course"
if [ -s "$night_a" ] && [ "$(head -c 21 "$night_a")" = age-encryption.org/v1 ] && bash "$COPY" restore "$A" "$night_a" >/dev/null 2>"$WORK/err" \
    && [ "$(login "$A" "$pwA" a6)" = 200 ] && c "$A" /api/projects -b "$WORK/a6.jar" | grep -q 'Nightly course'; then
    ok "check 3: $A restored from last night's encrypted archive has the course deleted since"
else
    miss "check 3: $A did not round-trip through last night's encrypted archive: $(tail -1 "$WORK/err")"
fi

echo "--- erasure ---"
# A person whose copy is removed and erased; their archive, as an off-site
# copy of the backup folder would still hold it.
out_c="$(bash "$COPY" new carol)"; pwC="$(echo "$out_c" | sed -n 's/^password: //p')"
[ "$(login carol "$pwC" c1)" = 200 ] && c carol /api/projects -b "$WORK/c1.jar" -H 'Content-Type: application/json' -d '{"name":"Carol course"}' -o /dev/null \
    || no "carol's course"
old_carol="$(bash "$COPY" backup carol | tail -1)"
cp "$old_carol" "$WORK/offsite-carol"
bash "$COPY" remove carol --yes --erase >/dev/null 2>"$WORK/err" || echo "remove --erase: $(cat "$WORK/err")" >&2
exists_c() { docker volume inspect tm-carol-data >/dev/null 2>&1; }
exists_c && no "carol's volume outlived remove --erase"
bash "$COPY" site-remove ann@example.test --yes --erase >/dev/null 2>"$WORK/err" || echo "site-remove --erase: $(cat "$WORK/err")" >&2
[ -z "$(site_signin ann@example.test "$PW_ANN")" ] && ok "ann cannot sign in once the account is removed" \
    || miss "check 4: ann still signs in after site-remove"

# Check 4: a restore of a backup older than the erasure brings no one back.
if [ -s "$night_desk" ] && bash "$COPY" site-restore "$night_desk" > "$WORK/site-restore" 2>"$WORK/err" && site_up; then
    ck_ben2="$(site_signin ben@example.test "$PW_BEN")"
    if [ -n "$ck_ben2" ] && site_has "$ck_ben2" 'Ben course'; then
        ok "check 3: the site restored from last night's archives has ben's course deleted since"
    else
        miss "check 3: ben's course is not back after the site restore"
    fi
    if [ -z "$(site_signin ann@example.test "$PW_ANN")" ] && [ -z "$(library_of ann@example.test)" ] \
        && ! docker exec "$SITE" test -e "/site/libraries/$ann_lib"; then
        ok "check 4: the site restored from a backup taken before ann's erasure has no account, row or folder of hers: $(grep -i eras "$WORK/site-restore" | head -1)"
    else
        miss "check 4: the restore of a backup older than ann's erasure brought ann back"
    fi
else
    miss "check 3: the site could not be restored from last night's backup ('$night_desk'): $(tail -2 "$WORK/err")"
    miss "check 4: no site restore to check ann's erasure against"
fi
out_c="$(bash "$COPY" new carol)"; pwC="$(echo "$out_c" | sed -n 's/^password: //p')"
if bash "$COPY" restore carol "$WORK/offsite-carol" >/dev/null 2>"$WORK/err"; then
    miss "check 4: an archive of the erased carol was restored into the new carol"
else
    [ "$(login carol "$pwC" c2)" = 200 ] && ! c carol /api/projects -b "$WORK/c2.jar" | grep -q 'Carol course' \
        && ok "check 4: an archive older than carol's erasure is refused, and the new carol is untouched: $(tail -1 "$WORK/err")" \
        || miss "check 4: the refused restore changed the new carol"
fi
# The same archive restored into someone else: it carries whom it was made from.
if bash "$COPY" restore "$A" "$WORK/offsite-carol" >/dev/null 2>"$WORK/err"; then
    miss "check 4: an archive of the erased carol was restored into $A"
else
    running_a && grep -q 'erased' "$WORK/err" \
        && ok "check 4: the erased carol's archive is refused under another name too: $(tail -1 "$WORK/err")" \
        || miss "check 4: restoring carol's archive into $A failed for another reason, or stopped $A: $(tail -1 "$WORK/err")"
fi

echo "--- a library's own links are not followed ---"
# A library's folder is its own to fill. Links it leaves there, to site.db, are
# planted as its own user; backup and restore run as root.
ben_lib="$(library_of ben@example.test)"
ben_uid="$(docker exec "$SITE" stat -c %u "/site/libraries/$ben_lib" 2>/dev/null)" || true
if [ -z "$ben_lib" ] || [ -z "$ben_uid" ] || [ "$ben_uid" = 0 ]; then
    miss "links: ben's library does not run as a user of its own ('$ben_lib' '$ben_uid')"
else
    docker exec --user "$ben_uid" "$SITE" sh -c "cd /site/libraries/$ben_lib && ln -s /site/site.db terramentor.db.restoring && ln -s /site/site.db terramentor.secrets.json.restoring" \
        || no "ben could not plant links in the library's own folder"
    links="$(bash "$COPY" backup --all 2>"$WORK/err")" || true
    links_desk="$(grep '/_site/_desk/' <<< "$links" | tail -1)" || true
    if [ -s "$links_desk" ] && bash "$COPY" site-restore "$links_desk" >/dev/null 2>"$WORK/err" && site_up \
        && [ -n "$(site_signin ben@example.test "$PW_BEN")" ] && [ "$(docker exec "$SITE" stat -c %u /site/site.db)" = 0 ]; then
        ok "links: a site restore writes nothing through links a library left at its fixed names; site.db is whole and root's"
    else
        miss "links: a site restore went through ben's links to site.db: $(tail -2 "$WORK/err")"
    fi
    docker exec --user "$ben_uid" "$SITE" sh -c "cd /site/libraries/$ben_lib && rm -rf vault && ln -s /site vault" || no "ben could not plant a vault link"
    bash "$COPY" backup --all >/dev/null 2>"$WORK/err" && miss "links: a backup through ben's vault link reported success"
    newest_ben="$(find "$TM_BACKUP_DIR/_site/$ben_lib" -maxdepth 1 -name '*.tar.gz.age' | sort | tail -1)"
    ben_listing="$(open_archive "$newest_ben" | tar tzf -)" || ben_listing=""
    if [ -n "$ben_listing" ] && ! grep -qE 'site\.db|libraries/' <<< "$ben_listing"; then
        ok "links: a library whose vault links to the whole site is not backed up through it: $(grep -m1 'is a link' "$WORK/err")"
    else
        miss "links: ben's archive holds files from outside ben's library: $newest_ben"
    fi
    docker exec "$SITE" rm -f "/site/libraries/$ben_lib/vault"
fi

# Check 1: archives stay through the grace period (14 days) and are gone after it.
in_grace="$(archives "$TM_BACKUP_DIR/carol")"; ann_grace="$(archives "$TM_BACKUP_DIR/_site/$ann_lib")"
TM_NOW=$((NOW + 13 * DAY)) bash "$COPY" sweep >/dev/null 2>&1 || true
day13="$(archives "$TM_BACKUP_DIR/carol")"; ann13="$(archives "$TM_BACKUP_DIR/_site/$ann_lib")"
TM_NOW=$((NOW + 15 * DAY)) bash "$COPY" sweep > "$WORK/sweep" 2>&1 || true
# The new carol's own archives (made after the erasure) are hers and stay.
old_left="$(find "$TM_BACKUP_DIR/carol" -maxdepth 1 -name "$(basename "$old_carol")" 2>/dev/null)"
ann_left="$(archives "$TM_BACKUP_DIR/_site/$ann_lib")"
if [ "$in_grace" -ge 1 ] && [ "$day13" = "$in_grace" ] && [ "$ann_grace" -ge 1 ] && [ "$ann13" = "$ann_grace" ] \
    && [ -z "$old_left" ] && [ "$ann_left" = 0 ]; then
    ok "check 1: the erased archives stay 13 days ($in_grace of carol, $ann_grace of ann) and are gone on day 15: $(head -1 "$WORK/sweep")"
else
    miss "check 1: erased archives after the grace period: carol $in_grace/$day13/${old_left:-gone}, ann $ann_grace/$ann13/$ann_left"
fi
# An off-site copy of the backup folder put back: the next nightly run erases again.
mkdir -p "$TM_BACKUP_DIR/carol" "$TM_BACKUP_DIR/_site/$ann_lib"
cp "$WORK/offsite-carol" "$TM_BACKUP_DIR/carol/$(basename "$old_carol")"
[ -s "$WORK/offsite-ann" ] && cp "$WORK/offsite-ann" "$TM_BACKUP_DIR/_site/$ann_lib/$(basename "$night_ann")"
# ...on a server rebuilt with only the backup folder: the server's own ledger is gone.
rm -f "$HERE/erasures"
TM_NOW=$((NOW + 16 * DAY)) bash "$COPY" backup --all >/dev/null 2>&1 || true
if [ -z "$(find "$TM_BACKUP_DIR/carol" -maxdepth 1 -name "$(basename "$old_carol")")" ] && [ "$(archives "$TM_BACKUP_DIR/_site/$ann_lib")" = 0 ] \
    && [ "$(archives "$TM_BACKUP_DIR/carol")" -ge 1 ] && [ "$(wc -l < "$HERE/erasures" 2>/dev/null || echo 0)" -ge 2 ]; then
    ok "check 4: erased archives put back from an off-site copy, on a server that lost its own ledger, are erased again by the next nightly run; the new carol's stay"
else
    miss "check 4: archives put back after an erasure survived the nightly run, or the server's ledger was not written back"
fi
# Every run deletes what it opened or read unencrypted.
left_work="$(find "$HERE/.work" -mindepth 1 2>/dev/null)"
[ -z "$left_work" ] && ok "check 2: nothing unencrypted is left on the server after the runs" \
    || miss "check 2: unencrypted files left on the server: $left_work"

if [ "${#MISSED[@]}" -gt 0 ]; then
    echo "$pass passed; erasure checks that did not hold: $(printf '%s\n' "${MISSED[@]}" | sort -u | tr '\n' ' ')" >&2
    exit 1
fi
echo "$pass passed"

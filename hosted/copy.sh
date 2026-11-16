#!/usr/bin/env bash
# One private copy of Terramentor per person, behind one HTTPS proxy
# (docs/HOSTING.md).
#
#   hosted/copy.sh new <name> [--ai-key-file <file>]
#       A copy at https://<name>.<TM_DOMAIN>: its own volume, its own network,
#       a memory cap, a generated password printed ONCE.
#   hosted/copy.sh list
#   hosted/copy.sh backup <name> | --all
#       An online backup of each copy into $TM_BACKUP_DIR/<name>/<time>.tar.gz.
#       Run nightly from cron (docs/HOSTING.md).
#   hosted/copy.sh restore <name> <archive.tar.gz>
#       Reads the archive first, then stops the copy, puts the backup in place
#       of its library and starts it. A failed check restarts it on its own
#       library; only a restore that failed partway leaves it stopped.
#   hosted/copy.sh remove <name> [--yes]
#       Backs the copy up first, then removes it, its volume and its network.
#   hosted/copy.sh update <name> | --all
#       Recreates each copy's container from TM_IMAGE; the library stays.
#
# Settings come from hosted/.env (start from hosted/example.env).
set -euo pipefail
# Git Bash on Windows would rewrite /data paths given to docker; this is a no-op elsewhere.
export MSYS_NO_PATHCONV=1

# `pwd -W` exists only in Git Bash, where the Windows docker CLI needs Z:/... not /z/...
HERE="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"
ENV_FILE="${TM_ENV_FILE:-$HERE/.env}"
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi
: "${TM_DOMAIN:?set TM_DOMAIN in hosted/.env}"
: "${TM_IMAGE:?set TM_IMAGE in hosted/.env}"
TM_MEMORY="${TM_MEMORY:-768m}"
TM_CPUS="${TM_CPUS:-1}"
TM_PIDS="${TM_PIDS:-256}"
TM_BACKUP_KEEP="${TM_BACKUP_KEEP:-14}"
TM_HTTPS_PORT="${TM_HTTPS_PORT:-443}"
SITES="$HERE/sites"
KEYS="$HERE/copies"
mkdir -p "$SITES" "$KEYS"
chmod 700 "$KEYS"

die() { echo "copy.sh: $*" >&2; exit 1; }

# One command at a time per copy: `new`, `restore`, `remove`, `update` and
# `backup` (which waits for it) take the copy's lock (a directory: mkdir either makes it or fails, atomically),
# and the exit handler gives it back and undoes a half-made `new`.
LOCKS="$HERE/.locks"
HELD=()
UNDO_NEW=""
on_exit() {
    local rc=$?
    [ -n "$UNDO_NEW" ] && undo_new "$UNDO_NEW"
    for l in ${HELD[@]+"${HELD[@]}"}; do rmdir "$LOCKS/$l" 2>/dev/null || true; done
    exit "$rc"
}
trap on_exit EXIT
lock() {
    mkdir -p "$LOCKS"
    mkdir "$LOCKS/$1" 2>/dev/null || die "another copy.sh is working on $1 (if none is, a killed run left $LOCKS/$1: remove it)"
    HELD+=("$1")
}
# Waited for, not refused: the shared proxy's lock, "_proxy" (a copy's name
# starts with a letter, so none can share it), and a copy's lock for a backup.
# With "soft", giving up returns 1 instead of ending the run.
wait_lock() {
    mkdir -p "$LOCKS"
    for _ in $(seq 1 300); do
        if mkdir "$LOCKS/$1" 2>/dev/null; then HELD+=("$1"); return 0; fi
        sleep 1
    done
    local why="waited 5 minutes for $LOCKS/$1 (if no copy.sh runs, a killed run left it: remove it)"
    if [ "${2:-}" = soft ]; then echo "copy.sh: $why" >&2; return 1; fi
    die "$why"
}
unlock() {
    rmdir "$LOCKS/$1" 2>/dev/null || true
    local kept=() l
    for l in ${HELD[@]+"${HELD[@]}"}; do [ "$l" = "$1" ] || kept+=("$l"); done
    HELD=(${kept[@]+"${kept[@]}"})
}

container() { echo "tm-$1"; }
volume() { echo "tm-$1-data"; }
network() { echo "tm-$1"; }
fqdn() { echo "$1.$TM_DOMAIN"; }
# The address a visitor types; the port only when a rehearsal moved it.
origin() { if [ "$TM_HTTPS_PORT" = 443 ]; then echo "https://$(fqdn "$1")"; else echo "https://$(fqdn "$1"):$TM_HTTPS_PORT"; fi; }

valid_name() {
    [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}[a-z0-9]$ ]] || die "a name is 3-32 lowercase letters, digits and hyphens, starting with a letter: '$1'"
}
exists() { docker container inspect "$(container "$1")" >/dev/null 2>&1; }
running() { [ "$(docker container inspect -f '{{.State.Running}}' "$(container "$1")" 2>/dev/null)" = true ]; }
copies() { docker ps -a --filter label=terramentor.copy --format '{{.Label "terramentor.copy"}}' | sort; }

# Caddy joins every copy's network, and only those: written from the copies
# that exist, then applied. A changed network list recreates the proxy (a
# second of downtime for every copy); a changed site list only reloads it.
#
# The proxy is shared, so the list it is built from and the `compose up` that
# applies it happen under one lock for every copy: two commands at once would
# otherwise each apply a list missing the other's copy. A call made while this
# run already holds it (undo_new after a failed apply) goes straight on.
PROXY_HELD=""
proxy_apply() {
    local mine="" n
    if [ -z "$PROXY_HELD" ]; then
        wait_lock _proxy
        PROXY_HELD=1
        mine=1
    fi
    {
        echo "# Written by copy.sh from the copies that exist. Do not edit."
        echo "services:"
        echo "  caddy:"
        echo "    networks:"
        echo "      - default"
        for n in $(copies); do echo "      - $(network "$n")"; done
        echo "networks:"
        echo "  default:"
        for n in $(copies); do
            echo "  $(network "$n"):"
            echo "    external: true"
        done
    } > "$HERE/networks.yml"
    export TM_ACME_LINE="${ACME_EMAIL:+email $ACME_EMAIL}"
    if ! (cd "$HERE" && docker compose -f docker-compose.yml -f networks.yml up -d --remove-orphans >/dev/null); then
        echo "copy.sh: docker compose could not apply the proxy" >&2
        if [ -n "$mine" ]; then unlock _proxy; PROXY_HELD=""; fi
        return 1
    fi
    docker exec terramentor-proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
    if [ -n "$mine" ]; then unlock _proxy; PROXY_HELD=""; fi
}

# A request through the proxy, as a phone would make it, whatever DNS says yet.
via_proxy() {
    local name="$1" path="$2"; shift 2
    curl -sS --max-time 10 ${TM_CURL_OPTS:-} --resolve "$(fqdn "$name"):$TM_HTTPS_PORT:127.0.0.1" "$@" "$(origin "$name")$path"
}
# The copy itself answers through the proxy: its sign-in status is the one
# route open before signing in (everything else is a 401 once a password is set).
answers() { via_proxy "$1" /api/auth/status -k -f >/dev/null 2>&1; }

cmd_new() {
    local name="${1:-}"; shift || true
    valid_name "$name"
    local keyfile=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --ai-key-file) keyfile="${2:?--ai-key-file needs a file}"; shift 2 ;;
            *) die "unknown option $1" ;;
        esac
    done
    # With no model named, the learner's own choice would decide what the
    # operator's key pays for; a hosted copy refuses that choice instead.
    [ -n "${AI_MODEL:-}" ] || die "set AI_MODEL in hosted/.env: the model every copy uses"
    lock "$name"
    # Checked under the lock, so nothing below can belong to anyone else, and
    # undo_new removes only what this run made.
    exists "$name" && die "a copy called $name already exists"
    docker volume inspect "$(volume "$name")" >/dev/null 2>&1 && die "volume $(volume "$name") already exists (a removed copy's data?); remove it or pick another name"
    docker network inspect "$(network "$name")" >/dev/null 2>&1 && die "network $(network "$name") already exists; remove it or pick another name"
    [ -e "$SITES/$name.caddy" ] && die "$SITES/$name.caddy already exists; remove it or pick another name"
    [ -e "$KEYS/$name.env" ] && die "$KEYS/$name.env already exists (a key kept for $name?); move it or pick another name"
    # A copy half made is undone, so the same name can simply be tried again.
    MADE=()
    UNDO_NEW="$name"

    # The copy's AI key, kept beside this script and readable by root only.
    # Each part is counted as this run's only once this run has made it, so an
    # undo never removes what another run made: the key file is created only
    # if it does not exist, and a network create that fails claims nothing.
    local envfile="$KEYS/$name.env"
    ( set -C; : > "$envfile" ) 2>/dev/null || die "$envfile appeared while $name was being made"
    MADE+=(keys)
    chmod 600 "$envfile"
    if [ -n "$keyfile" ]; then
        [ -s "$keyfile" ] || die "$keyfile is empty"
        printf 'AI_API_KEY=%s\n' "$(tr -d '\r\n' < "$keyfile")" > "$envfile"
    fi

    docker network create "$(network "$name")" >/dev/null || die "could not create network $(network "$name")"
    MADE+=(network)
    docker volume create "$(volume "$name")" >/dev/null
    MADE+=(volume)
    # The password is set BEFORE the copy first starts, so it never listens
    # unlocked (server/hosted.js refuses to). Printed once, below, and kept
    # nowhere: the library holds only its scrypt hash.
    local password
    password="$(docker run --rm --network none -v "$(volume "$name")":/data "$TM_IMAGE" node server/hostedCli.js set-password --generate)"

    MADE+=(container)
    run_copy "$name"

    MADE+=(site)
    {
        echo "$(fqdn "$name") {"
        [ "${TM_TLS:-}" = internal ] && echo "	tls internal"
        echo "	header Strict-Transport-Security \"max-age=31536000\""
        echo "	reverse_proxy $(container "$name"):3001"
        echo "}"
    } > "$SITES/$name.caddy"
    proxy_apply
    wait_up "$name"
    UNDO_NEW=""

    echo "copy:     $name"
    echo "address:  $(origin "$name")"
    echo "password: $password"
    echo "(shown once; nothing keeps it. A lost password is a new one: remove and restore, or set-password on a restored library.)"
}

made() { local m; for m in ${MADE[@]+"${MADE[@]}"}; do [ "$m" = "$1" ] && return 0; done; return 1; }
undo_new() {
    local name="$1"
    echo "copy.sh: $name was not created; undoing what this run made" >&2
    made container && { docker rm -f "$(container "$name")" >/dev/null 2>&1 || true; }
    made site && rm -f "$SITES/$name.caddy"
    made keys && rm -f "$KEYS/$name.env"
    made container && { proxy_apply >/dev/null 2>&1 || true; }
    made network && { docker network rm "$(network "$name")" >/dev/null 2>&1 || true; }
    made volume && { docker volume rm "$(volume "$name")" >/dev/null 2>&1 || true; }
    return 0
}

wait_up() {
    for _ in $(seq 1 60); do
        if answers "$1"; then return 0; fi
        sleep 2
    done
    docker logs --tail 40 "$(container "$1")" >&2
    die "$(origin "$1") did not answer"
}

# The copy's container, from its volume, network and key file. Everything it
# keeps is on the volume, so `update` can throw the container away.
run_copy() {
    local name="$1"
    docker run -d --name "$(container "$name")" \
        --label terramentor.copy="$name" \
        --network "$(network "$name")" \
        --restart unless-stopped \
        --read-only --tmpfs /tmp:size=1g,mode=1777 \
        --cap-drop ALL --security-opt no-new-privileges:true \
        --memory "$TM_MEMORY" --memory-swap "$TM_MEMORY" --cpus "$TM_CPUS" --pids-limit "$TM_PIDS" \
        -v "$(volume "$name")":/data \
        -e TERRAMENTOR_HOSTED=1 \
        -e ALLOWED_HOSTS="$(fqdn "$name")" \
        -e ALLOWED_ORIGINS="$(origin "$name")" \
        -e AI_PROVIDER="${AI_PROVIDER:-openai}" \
        -e AI_BASE_URL="${AI_BASE_URL:-}" \
        -e AI_MODEL="${AI_MODEL:-}" \
        --env-file "$KEYS/$name.env" \
        "$TM_IMAGE" >/dev/null
}

cmd_update() {
    local what="${1:-}"
    [ -n "$what" ] || die "usage: update <name> | --all"
    local names n
    if [ "$what" = --all ]; then names="$(copies)"; else valid_name "$what"; exists "$what" || die "no copy called $what"; names="$what"; fi
    # A registry image is fetched first; a locally built one is used as it is.
    docker pull -q "$TM_IMAGE" >/dev/null 2>&1 || echo "copy.sh: could not pull $TM_IMAGE; using the local image" >&2
    for n in $names; do
        lock "$n"
        # A new image may migrate the database: the library before it is kept.
        backup_one "$n" >/dev/null || die "the backup of $n failed; $n was not updated"
        docker rm -f "$(container "$n")" >/dev/null
        run_copy "$n"
        # Another command applying the proxy while this container was gone
        # left its network out; apply again (a no-op when nothing changed).
        proxy_apply
        wait_up "$n"
        echo "updated: $n"
    done
}

cmd_list() {
    for n in $(copies); do
        printf '%-20s %-8s %s\n' "$n" "$(running "$n" && echo running || echo stopped)" "$(origin "$n")"
    done
}

# Prints the archive's path as its last line, or fails with nothing kept. Every
# step is checked by hand: `set -e` does not apply inside a function called
# from `||` or `$( )`, which is how --all and remove call this one.
backup_one() {
    local name="$1"
    : "${TM_BACKUP_DIR:?set TM_BACKUP_DIR in hosted/.env}"
    exists "$name" || { echo "copy.sh: no copy called $name" >&2; return 1; }
    local stamp dir out tmp ok=1
    # The time first, so the names sort by it; a random tail, so two backups
    # in the same second neither share a working folder nor replace each other.
    stamp="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
    dir="/data/.backup-$stamp"
    out="$TM_BACKUP_DIR/$name"
    mkdir -p "$out" && chmod 700 "$out" || return 1
    tmp="$out/.$stamp.tar.gz.part"
    if running "$name"; then
        # Online: SQLite's backup API reads a consistent copy while the app writes.
        docker exec "$(container "$name")" node server/hostedCli.js backup "$dir" >&2 || ok=0
        # pipefail (set above) makes a failed `docker cp` fail the pipe.
        if [ "$ok" = 1 ]; then docker cp "$(container "$name")":"$dir" - | gzip > "$tmp" || ok=0; fi
        docker exec "$(container "$name")" rm -rf "$dir" >/dev/null 2>&1 || true
    else
        docker run --rm --network none -v "$(volume "$name")":/data "$TM_IMAGE" sh -c \
            "trap 'rm -rf $dir' EXIT; node server/hostedCli.js backup '$dir' >&2 && tar cz -C /data '.backup-$stamp'" > "$tmp" || ok=0
    fi
    # An empty or cut-off archive is still a gzip file: read it back.
    # (A here-string, not a pipe: `grep -q` leaving early would fail tar.)
    local listing=""
    if [ "$ok" = 1 ]; then listing="$(tar tzf - < "$tmp" 2>/dev/null)" || ok=0; fi
    if [ "$ok" = 1 ] && ! grep -q '/terramentor\.db$' <<< "$listing"; then ok=0; fi
    if [ "$ok" != 1 ]; then
        rm -f "$tmp"
        echo "copy.sh: the backup of $name failed; nothing was kept" >&2
        return 1
    fi
    chmod 600 "$tmp" && mv "$tmp" "$out/$stamp.tar.gz" || return 1
    # Keep the newest TM_BACKUP_KEEP; the names sort by time, and only checked
    # archives are ever here.
    # NUL-separated all the way, so a TM_BACKUP_DIR with spaces stays whole.
    find "$out" -maxdepth 1 -type f -name '*.tar.gz' -print0 | sort -z | head -z -n "-$TM_BACKUP_KEEP" | xargs -0 -r rm -f
    echo "$out/$stamp.tar.gz"
}

cmd_backup() {
    local what="${1:-}"
    [ -n "$what" ] || die "usage: backup <name> | --all"
    if [ "$what" = --all ]; then
        local failed=0 n
        for n in $(copies); do
            # Another run's lock is never released here: only one this run took.
            if ! wait_lock "$n" soft; then echo "copy.sh: backup of $n FAILED" >&2; failed=1; continue; fi
            backup_one "$n" || { echo "copy.sh: backup of $n FAILED" >&2; failed=1; }
            unlock "$n"
        done
        return "$failed"
    fi
    valid_name "$what"
    # The copy's lock: a restore must not change the library between the
    # database and the credentials this backup reads.
    wait_lock "$what"
    backup_one "$what"
}

cmd_restore() {
    local name="${1:-}" archive="${2:-}"
    valid_name "$name"
    [ -f "$archive" ] || die "usage: restore <name> <archive.tar.gz>"
    exists "$name" || die "no copy called $name (create it with new, then restore into it)"
    lock "$name"
    # Read before the copy stops: a file that is no backup leaves it running.
    local listing
    listing="$(tar tzf - < "$archive" 2>/dev/null)" || die "$archive is not a readable archive; $name was not touched"
    [ "$(grep -cE '^(\./)?\.backup-[^/]+/terramentor\.db$' <<< "$listing")" = 1 ] || die "$archive is not one backup made by copy.sh; $name was not touched"
    docker stop "$(container "$name")" >/dev/null
    # hostedCli marks the library before it starts replacing it and clears the
    # mark only when every part is in place, so even a killed restore leaves
    # it; the copy itself refuses to start while it is there. A failure is
    # followed by a start only when `restore-state` confirms there is no mark.
    local rc=0
    docker run --rm -i --network none -v "$(volume "$name")":/data "$TM_IMAGE" sh -c \
        'mkdir -p /tmp/restore && tar xz -C /tmp/restore && node server/hostedCli.js restore /tmp/restore/.backup-*' < "$archive" || rc=$?
    if [ "$rc" != 0 ] && ! docker run --rm --network none -v "$(volume "$name")":/data "$TM_IMAGE" node server/hostedCli.js restore-state >/dev/null 2>&1; then
        die "the restore stopped partway through replacing $name's library (exit $rc); $name is left stopped. Restore it again from this or another backup"
    fi
    docker start "$(container "$name")" >/dev/null
    if [ "$rc" != 0 ]; then
        wait_up "$name"
        die "the restore failed before touching $name's library; $name runs again on it as it was"
    fi
    for _ in $(seq 1 60); do
        if answers "$name"; then echo "restored: $(origin "$name")"; return 0; fi
        sleep 2
    done
    die "$(origin "$name") did not answer after the restore"
}

cmd_remove() {
    local name="${1:-}" yes="${2:-}"
    valid_name "$name"
    exists "$name" || die "no copy called $name"
    lock "$name"
    if [ "$yes" != --yes ]; then
        read -r -p "Remove $name and its library? A backup is made first. Type the name to confirm: " typed
        [ "$typed" = "$name" ] || die "not confirmed"
    fi
    # The person's data leaves the server only after it is safely out.
    local archive
    archive="$(backup_one "$name")" || die "the backup failed; nothing was removed"
    [ -s "$archive" ] || die "the backup failed; nothing was removed"
    docker rm -f "$(container "$name")" >/dev/null
    rm -f "$SITES/$name.caddy" "$KEYS/$name.env"
    proxy_apply
    docker network rm "$(network "$name")" >/dev/null
    docker volume rm "$(volume "$name")" >/dev/null
    echo "removed: $name"
    echo "its library: $archive"
}

case "${1:-}" in
    new) shift; cmd_new "$@" ;;
    list) cmd_list ;;
    backup) shift; cmd_backup "$@" ;;
    restore) shift; cmd_restore "$@" ;;
    remove) shift; cmd_remove "$@" ;;
    update) shift; cmd_update "$@" ;;
    *) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

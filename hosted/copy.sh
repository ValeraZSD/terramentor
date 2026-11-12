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
#       Stops the copy, puts the backup in place of its library, starts it.
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
TM_MEMORY="${TM_MEMORY:-1536m}"
TM_CPUS="${TM_CPUS:-1}"
TM_PIDS="${TM_PIDS:-256}"
TM_BACKUP_KEEP="${TM_BACKUP_KEEP:-14}"
TM_HTTPS_PORT="${TM_HTTPS_PORT:-443}"
SITES="$HERE/sites"
KEYS="$HERE/copies"
mkdir -p "$SITES" "$KEYS"
chmod 700 "$KEYS"

die() { echo "copy.sh: $*" >&2; exit 1; }
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
proxy_apply() {
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
    (cd "$HERE" && docker compose -f docker-compose.yml -f networks.yml up -d --remove-orphans >/dev/null)
    docker exec terramentor-proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
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
    exists "$name" && die "a copy called $name already exists"
    # With no model named, the learner's own choice would decide what the
    # operator's key pays for; a hosted copy refuses that choice instead.
    [ -n "${AI_MODEL:-}" ] || die "set AI_MODEL in hosted/.env: the model every copy uses"
    docker volume inspect "$(volume "$name")" >/dev/null 2>&1 && die "volume $(volume "$name") already exists (a removed copy's data?); remove it or pick another name"
    # A copy half made is undone, so the same name can simply be tried again.
    trap "undo_new $name" EXIT

    # The copy's AI key, kept beside this script and readable by root only.
    local envfile="$KEYS/$name.env"
    : > "$envfile"; chmod 600 "$envfile"
    if [ -n "$keyfile" ]; then
        [ -s "$keyfile" ] || die "$keyfile is empty"
        printf 'AI_API_KEY=%s\n' "$(tr -d '\r\n' < "$keyfile")" > "$envfile"
    fi

    docker network create "$(network "$name")" >/dev/null
    docker volume create "$(volume "$name")" >/dev/null
    # The password is set BEFORE the copy first starts, so it never listens
    # unlocked (server/hosted.js refuses to). Printed once, below, and kept
    # nowhere: the library holds only its scrypt hash.
    local password
    password="$(docker run --rm --network none -v "$(volume "$name")":/data "$TM_IMAGE" node server/hostedCli.js set-password --generate)"

    run_copy "$name"

    {
        echo "$(fqdn "$name") {"
        [ "${TM_TLS:-}" = internal ] && echo "	tls internal"
        echo "	header Strict-Transport-Security \"max-age=31536000\""
        echo "	reverse_proxy $(container "$name"):3001"
        echo "}"
    } > "$SITES/$name.caddy"
    proxy_apply
    wait_up "$name"
    trap - EXIT

    echo "copy:     $name"
    echo "address:  $(origin "$name")"
    echo "password: $password"
    echo "(shown once; nothing keeps it. A lost password is a new one: remove and restore, or set-password on a restored library.)"
}

undo_new() {
    local name="$1"
    echo "copy.sh: $name was not created; undoing what was made" >&2
    docker rm -f "$(container "$name")" >/dev/null 2>&1 || true
    rm -f "$SITES/$name.caddy" "$KEYS/$name.env"
    proxy_apply >/dev/null 2>&1 || true
    docker network rm "$(network "$name")" >/dev/null 2>&1 || true
    docker volume rm "$(volume "$name")" >/dev/null 2>&1 || true
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
    local names
    if [ "$what" = --all ]; then names="$(copies)"; else valid_name "$what"; exists "$what" || die "no copy called $what"; names="$what"; fi
    # A registry image is fetched first; a locally built one is used as it is.
    docker pull -q "$TM_IMAGE" >/dev/null 2>&1 || echo "copy.sh: could not pull $TM_IMAGE; using the local image" >&2
    for n in $names; do
        # A new image may migrate the database: the library before it is kept.
        backup_one "$n" >/dev/null || die "the backup of $n failed; $n was not updated"
        docker rm -f "$(container "$n")" >/dev/null
        run_copy "$n"
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
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
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
    ls -1 "$out"/*.tar.gz 2>/dev/null | sort | head -n "-$TM_BACKUP_KEEP" | xargs -r rm -f
    echo "$out/$stamp.tar.gz"
}

cmd_backup() {
    local what="${1:-}"
    [ -n "$what" ] || die "usage: backup <name> | --all"
    if [ "$what" = --all ]; then
        local failed=0
        for n in $(copies); do backup_one "$n" || { echo "copy.sh: backup of $n FAILED" >&2; failed=1; }; done
        return "$failed"
    fi
    valid_name "$what"
    backup_one "$what"
}

cmd_restore() {
    local name="${1:-}" archive="${2:-}"
    valid_name "$name"
    [ -f "$archive" ] || die "usage: restore <name> <archive.tar.gz>"
    exists "$name" || die "no copy called $name (create it with new, then restore into it)"
    docker stop "$(container "$name")" >/dev/null
    docker run --rm -i --network none -v "$(volume "$name")":/data "$TM_IMAGE" sh -c \
        'mkdir -p /tmp/restore && tar xz -C /tmp/restore && node server/hostedCli.js restore /tmp/restore/.backup-*' < "$archive"
    docker start "$(container "$name")" >/dev/null
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

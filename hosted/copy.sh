#!/usr/bin/env bash
# One private copy of Terramentor per person, behind one HTTPS proxy
# (docs/HOSTING.md).
#
#   hosted/copy.sh new <name> [--ai-key-file <file>]
#       A copy at https://<name>.<TM_DOMAIN>: its own volume, its own network,
#       a memory cap, a generated password printed ONCE.
#   hosted/copy.sh list
#   hosted/copy.sh backup <name> | --all
#       An online backup of each copy into $TM_BACKUP_DIR/<name>/<time>.tar.gz.age,
#       encrypted to the age public keys in TM_BACKUP_RECIPIENTS. --all also
#       backs up the site in TM_SITE_CONTAINER (if set) into $TM_BACKUP_DIR/_site/
#       and then runs `sweep`. Run nightly from cron (docs/HOSTING.md).
#   hosted/copy.sh restore <name> <archive> [--identity <key file>] [--no-backup]
#       Reads the archive first (an encrypted one with the private key, from
#       --identity or TM_BACKUP_IDENTITY) and backs the copy up as it is (kept
#       beside its other backups; needs TM_BACKUP_DIR), then stops it, puts the
#       backup in place of its library and starts it. A failed check restarts it
#       on its own library; only a restore that failed partway leaves it stopped.
#       No backup is taken of a library whose last restore never finished
#       (it cannot be backed up, and this restore is the repair), nor with
#       --no-backup, for a library too damaged to back up. An archive made
#       before the copy's name was erased is refused.
#   hosted/copy.sh remove <name> [--erase] [--yes]
#       Backs the copy up first, then removes it, its volume and its network.
#       With --erase, its archives are deleted once TM_ERASE_AFTER_DAYS (14)
#       have passed, and none made before now is restored again.
#   hosted/copy.sh erase <name> | site:<library id>
#       The same erasure for a copy or site library already removed.
#   hosted/copy.sh unerase <name> | site:<library id>
#       Cancels an erasure whose grace period has not ended.
#   hosted/copy.sh sweep
#       Deletes the archives whose erasure is due (backup --all runs it).
#   hosted/copy.sh site-remove <email> [--erase] [--yes]
#       Backs up that person's site library, then deletes their account and
#       library; --erase as for remove.
#   hosted/copy.sh site-restore <_site/_desk/archive> [--identity <key file>] [--no-backup]
#       Puts the site back as it was at that night's backup: backs it up as it
#       is, stops it, restores site.db and every library of that night except
#       erased ones (whose accounts are deleted before the site starts), starts it.
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
TM_ERASE_AFTER_DAYS="${TM_ERASE_AFTER_DAYS:-14}"
TM_HTTPS_PORT="${TM_HTTPS_PORT:-443}"
SITES="$HERE/sites"
KEYS="$HERE/copies"
# Where a backup is read and checked before it is encrypted, and where a
# restore opens one: on the server, readable by root only, never in TM_BACKUP_DIR.
WORKDIR="$HERE/.work"
mkdir -p "$SITES" "$KEYS" "$WORKDIR"
chmod 700 "$KEYS" "$WORKDIR"

die() { echo "copy.sh: $*" >&2; exit 1; }
[[ "$TM_BACKUP_KEEP" =~ ^[1-9][0-9]*$ ]] || die "TM_BACKUP_KEEP is a whole number of archives, at least 1: '$TM_BACKUP_KEEP'"
[[ "$TM_ERASE_AFTER_DAYS" =~ ^[0-9]+$ ]] || die "TM_ERASE_AFTER_DAYS is a whole number of days: '$TM_ERASE_AFTER_DAYS'"

# One command at a time per copy: `new`, `restore`, `remove`, `update` and
# `backup` (which waits for it) take the copy's lock (a directory: mkdir either makes it or fails, atomically),
# and the exit handler gives it back and undoes a half-made `new`.
LOCKS="$HERE/.locks"
HELD=()
UNDO_NEW=""
# Opened or unencrypted files of this run in WORKDIR, deleted however it ends.
SCRATCH=()
on_exit() {
    local rc=$?
    [ -n "$UNDO_NEW" ] && undo_new "$UNDO_NEW"
    for s in ${SCRATCH[@]+"${SCRATCH[@]}"}; do rm -rf "$s"; done
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
    local mine="" n list
    if [ -z "$PROXY_HELD" ]; then
        wait_lock _proxy
        PROXY_HELD=1
        mine=1
    fi
    # Read once: a `remove` deletes its container before it waits for this
    # lock, so a second read could drop a network the first one listed, and
    # compose refuses a service on a network the file never declares.
    list="$(copies)"
    {
        echo "# Written by copy.sh from the copies that exist. Do not edit."
        echo "services:"
        echo "  caddy:"
        echo "    networks:"
        echo "      - default"
        for n in $list; do echo "      - $(network "$n")"; done
        echo "networks:"
        echo "  default:"
        for n in $list; do
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
        # Released per copy: held to the end of an --all run, it made the
        # nightly backup of every copy already updated wait and fail.
        unlock "$n"
    done
}

cmd_list() {
    for n in $(copies); do
        printf '%-20s %-8s %s\n' "$n" "$(running "$n" && echo running || echo stopped)" "$(origin "$n")"
    done
}

# --- Encryption --------------------------------------------------------------
# Every archive is encrypted with age (https://age-encryption.org) to the
# public keys in TM_BACKUP_RECIPIENTS before it is written to TM_BACKUP_DIR, so
# the server, and whatever stores the backups, holds nothing that opens them.
# The private key stays with the operator, off the server; a restore asks for it.
need_recipients() {
    : "${TM_BACKUP_DIR:?set TM_BACKUP_DIR in hosted/.env}"
    : "${TM_BACKUP_RECIPIENTS:?set TM_BACKUP_RECIPIENTS in hosted/.env: a file with the age public key(s) backups are encrypted to (docs/HOSTING.md, Backups)}"
    command -v age >/dev/null 2>&1 || die "age is not installed (apt install age); no backup is written unencrypted"
    [ -s "$TM_BACKUP_RECIPIENTS" ] || die "TM_BACKUP_RECIPIENTS ($TM_BACKUP_RECIPIENTS) is missing or empty"
    ! grep -q 'AGE-SECRET-KEY' "$TM_BACKUP_RECIPIENTS" \
        || die "$TM_BACKUP_RECIPIENTS holds a PRIVATE key; the server gets the public key only (age-keygen -y)"
    grep -qE '^(age1|ssh-)' "$TM_BACKUP_RECIPIENTS" || die "$TM_BACKUP_RECIPIENTS has no age1... public key"
}
# A new archive's stamp: the time first, so the names sort by it; a random tail,
# so two backups in the same second neither share a working folder nor replace each other.
new_stamp() { echo "$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"; }
# Encrypt a checked plain archive into <folder>/<stamp>.tar.gz.age and thin the
# folder to the newest TM_BACKUP_KEEP (unless "keep-all"). Prints the path.
seal() {
    local plain="$1" out="$2" stamp="$3" thin="${4:-}" part
    mkdir -p "$out" && chmod 700 "$out" || return 1
    part="$out/.$stamp.tar.gz.age.part"
    if ! age -R "$TM_BACKUP_RECIPIENTS" -o "$part" "$plain"; then rm -f "$part" "$plain"; return 1; fi
    rm -f "$plain"
    chmod 600 "$part" && mv "$part" "$out/$stamp.tar.gz.age" || return 1
    # The names sort by time, and only checked archives are ever here (those
    # from before encryption, .tar.gz, count too). NUL-separated all the way,
    # so a TM_BACKUP_DIR with spaces stays whole.
    if [ "$thin" != keep-all ]; then
        find "$out" -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.tar.gz.age' \) -print0 | sort -z | head -z -n "-$TM_BACKUP_KEEP" | xargs -0 -r rm -f
    fi
    echo "$out/$stamp.tar.gz.age"
}
# Sets OPENED to a plain gzip tar of <archive>: the archive itself when it was
# written before encryption, else a copy opened with the key into WORKDIR.
open_archive() {
    local archive="$1" identity="$2" what="$3"
    OPENED="$archive"
    [ "$(head -c 21 "$archive" 2>/dev/null)" = age-encryption.org/v1 ] || return 0
    [ -n "$identity" ] && [ -s "$identity" ] \
        || die "$archive is encrypted: give the private key with --identity <file> (or TM_BACKUP_IDENTITY); $what was not touched"
    command -v age >/dev/null 2>&1 || die "age is not installed (apt install age); $what was not touched"
    OPENED="$WORKDIR/open-$$-$RANDOM.tar.gz"
    SCRATCH+=("$OPENED")
    ( umask 077; age -d -i "$identity" -o "$OPENED" "$archive" ) 2>/dev/null \
        || die "$archive could not be opened with $identity (another key, or a damaged file); $what was not touched"
}

# --- The erasure ledger -------------------------------------------------------
# One line per erasure: SHA-256 of "copy:<name>" or "site:<library id>", when it
# was erased and when its grace period ends (UTC, as archive names write time).
# A hash, so the ledger names nobody. It is kept outside every archive, twice:
# hosted/erasures on the server and TM_BACKUP_DIR/erasures beside the archives,
# and read as the union of both, so a backup folder put back from an older
# off-site copy, or a server rebuilt from one, still knows what was erased.
LEDGER="$HERE/erasures"
ledger_key() { case "$1" in site:*) printf '%s' "$1" ;; *) printf 'copy:%s' "$1" ;; esac | sha256sum | cut -d' ' -f1; }
now_epoch() { echo "${TM_NOW:-$(date -u +%s)}"; }  # TM_NOW: a rehearsal's clock
stamp_at() { date -u -d "@$1" +%Y%m%dT%H%M%SZ; }
ledger_lines() {
    { cat "$LEDGER" 2>/dev/null; [ -n "${TM_BACKUP_DIR:-}" ] && cat "$TM_BACKUP_DIR/erasures" 2>/dev/null; } \
        | grep -E '^[0-9a-f]{64} [0-9]{8}T[0-9]{6}Z [0-9]{8}T[0-9]{6}Z$' | sort -u || true
}
# When <what> was last erased, or nothing.
erased_at() { ledger_lines | awk -v k="$(ledger_key "$1")" '$1 == k { print $2 }' | sort | tail -1; }
# Under its own lock, so two erasures never interleave their lines.
erase_record() {
    local what="$1" now line f
    now="$(now_epoch)"
    line="$(ledger_key "$what") $(stamp_at "$now") $(stamp_at $((now + TM_ERASE_AFTER_DAYS * 86400)))"
    wait_lock _erasures
    for f in "$LEDGER" "$TM_BACKUP_DIR/erasures"; do
        ( umask 077; printf '%s\n' "$line" >> "$f" ) || { unlock _erasures; die "could not write the erasure to $f"; }
    done
    unlock _erasures
    echo "erased: no archive of $what made before now is restored again; they are deleted after $(stamp_at $((now + TM_ERASE_AFTER_DAYS * 86400))) (copy.sh unerase $what cancels it until then)"
}

# Prints the archive's path as its last line, or fails with nothing kept. Every
# step is checked by hand: `set -e` does not apply inside a function called
# from `||` or `$( )`, which is how --all and remove call this one.
# With "keep-all" the old archives are not thinned: the backup a restore takes
# first must not delete the archive it is about to restore.
backup_one() {
    local name="$1" thin="${2:-}"
    need_recipients
    exists "$name" || { echo "copy.sh: no copy called $name" >&2; return 1; }
    local stamp dir tmp ok=1
    stamp="$(new_stamp)"
    dir="/data/.backup-$stamp"
    # Read and checked here first, unencrypted, on the server only; encrypted
    # on the way into TM_BACKUP_DIR (seal).
    tmp="$WORKDIR/$name-$stamp.tar.gz"
    : > "$tmp" && chmod 600 "$tmp" || return 1
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
    seal "$tmp" "$TM_BACKUP_DIR/$name" "$stamp" "$thin" || { rm -f "$tmp"; echo "copy.sh: the backup of $name could not be encrypted; nothing was kept" >&2; return 1; }
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
        if [ -n "${TM_SITE_CONTAINER:-}" ]; then
            if wait_lock _site soft; then
                site_backup "" || { echo "copy.sh: backup of the site FAILED" >&2; failed=1; }
                unlock _site
            else
                echo "copy.sh: backup of the site FAILED" >&2; failed=1
            fi
        fi
        cmd_sweep || failed=1
        # What a run killed halfway left unencrypted in WORKDIR (a day old: no run takes that long).
        find "$WORKDIR" -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
        return "$failed"
    fi
    valid_name "$what"
    # The copy's lock: a restore must not change the library between the
    # database and the credentials this backup reads.
    wait_lock "$what"
    backup_one "$what"
}

cmd_restore() {
    local name="${1:-}" archive="${2:-}" keep="" identity="${TM_BACKUP_IDENTITY:-}"
    shift 2 2>/dev/null || shift $#
    while [ $# -gt 0 ]; do
        case "$1" in
            --no-backup) keep=--no-backup; shift ;;
            --identity) identity="${2:?--identity needs the private key file}"; shift 2 ;;
            *) die "usage: restore <name> <archive> [--identity <key file>] [--no-backup]" ;;
        esac
    done
    valid_name "$name"
    [ -f "$archive" ] || die "usage: restore <name> <archive> [--identity <key file>] [--no-backup]"
    exists "$name" || die "no copy called $name (create it with new, then restore into it)"
    lock "$name"
    # Read before the copy stops: a file that is no backup leaves it running.
    open_archive "$archive" "$identity" "$name"
    local listing inner erased
    listing="$(tar tzf - < "$OPENED" 2>/dev/null)" || die "$archive is not a readable archive; $name was not touched"
    [ "$(grep -cE '^(\./)?\.backup-[^/]+/terramentor\.db$' <<< "$listing")" = 1 ] || die "$archive is not one backup made by copy.sh; $name was not touched"
    # An erasure is never undone by a restore: an archive made up to the
    # moment this name was erased belongs to the person erased. The time is the
    # one inside the archive, which renaming the file does not change.
    inner="$(grep -E '^(\./)?\.backup-[^/]+/terramentor\.db$' <<< "$listing" | sed -E 's#^(\./)?\.backup-##')"
    erased="$(erased_at "$name")"
    if [ -n "$erased" ] && ! [[ "${inner:0:16}" > "$erased" ]]; then
        die "$archive was made before $name was erased ($erased), so it is not restored; $name was not touched"
    fi
    # The library as it is now, kept before anything replaces it: a restore
    # from the wrong archive must be one more restore away from undone.
    # Not taken when there is nothing worth keeping: a restore that never
    # finished leaves a library hostedCli refuses to back up (and restoring is
    # the repair), and --no-backup is for one SQLite cannot back up at all.
    local before state=0
    docker run --rm --network none -v "$(volume "$name")":/data "$TM_IMAGE" node server/hostedCli.js restore-state >/dev/null 2>&1 || state=$?
    if [ "$keep" = --no-backup ]; then
        echo "no backup of $name's library before the restore (--no-backup)"
    elif [ "$state" = 3 ]; then
        echo "no backup of $name's library before the restore: its last restore never finished"
    else
        before="$(backup_one "$name" keep-all)" && [ -s "$before" ] || die "the backup of $name before the restore failed; $name was not touched (restore with --no-backup to go on without it)"
        echo "its library before the restore: $before"
    fi
    docker stop "$(container "$name")" >/dev/null
    # hostedCli marks the library before it starts replacing it and clears the
    # mark only when every part is in place, so even a killed restore leaves
    # it; the copy itself refuses to start while it is there. A failure is
    # followed by a start only when `restore-state` confirms there is no mark.
    local rc=0
    docker run --rm -i --network none -v "$(volume "$name")":/data "$TM_IMAGE" sh -c \
        'mkdir -p /tmp/restore && tar xz -C /tmp/restore && node server/hostedCli.js restore /tmp/restore/.backup-*' < "$OPENED" || rc=$?
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
    local name="${1:-}" yes="" erase=""
    shift || true
    while [ $# -gt 0 ]; do
        case "$1" in
            --yes) yes=--yes ;;
            --erase) erase=1 ;;
            *) die "usage: remove <name> [--erase] [--yes]" ;;
        esac
        shift
    done
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
    # Recorded before anything is removed, so a removal that stops halfway is
    # still an erasure.
    if [ -n "$erase" ]; then erase_record "$name"; fi
    docker rm -f "$(container "$name")" >/dev/null
    rm -f "$SITES/$name.caddy" "$KEYS/$name.env"
    proxy_apply
    docker network rm "$(network "$name")" >/dev/null
    docker volume rm "$(volume "$name")" >/dev/null
    echo "removed: $name"
    echo "its library: $archive"
}

# The erasure of a copy or site library that is already gone (removed without
# --erase, whose archives would otherwise be kept until deleted by hand).
cmd_erase() {
    local what="${1:-}"
    [ -n "$what" ] || die "usage: erase <name> | site:<library id>"
    : "${TM_BACKUP_DIR:?set TM_BACKUP_DIR in hosted/.env}"
    case "$what" in
        site:*)
            [[ "${what#site:}" =~ ^[0-9a-f]{32}$ ]] || die "a site library id is 32 hex characters (copy.sh site-remove prints it): '$what'"
            if [ -n "${TM_SITE_CONTAINER:-}" ] && docker exec "$TM_SITE_CONTAINER" node server/site/cli.js accounts | cut -f2 | grep -qx "${what#site:}"; then
                die "library ${what#site:} still has an account: copy.sh site-remove <email> --erase"
            fi ;;
        *)
            valid_name "$what"
            exists "$what" && die "$what still exists: copy.sh remove $what --erase" ;;
    esac
    erase_record "$what"
}

cmd_unerase() {
    local what="${1:-}"
    [ -n "$what" ] || die "usage: unerase <name> | site:<library id>"
    : "${TM_BACKUP_DIR:?set TM_BACKUP_DIR in hosted/.env}"
    local key now before after f
    key="$(ledger_key "$what")"
    now="$(stamp_at "$(now_epoch)")"
    wait_lock _erasures
    before="$(ledger_lines | wc -l)"
    for f in "$LEDGER" "$TM_BACKUP_DIR/erasures"; do
        [ -f "$f" ] || continue
        # Only an erasure still in its grace period; one whose archives are gone stays.
        awk -v k="$key" -v now="$now" '!($1 == k && $3 > now)' "$f" > "$f.new" && chmod 600 "$f.new" && mv "$f.new" "$f"
    done
    after="$(ledger_lines | wc -l)"
    unlock _erasures
    [ "$after" -lt "$before" ] || die "no erasure of $what in its grace period (none, or its archives are already deleted)"
    echo "unerased: $what (its archives are kept and can be restored again)"
}

# Deletes every archive whose erasure is due: in the erased one's folder, each
# archive made up to the moment of the erasure (a later copy of the same name
# is someone else, and keeps its own). Then writes the union of both ledgers to
# both, so neither forgets a line the other had.
cmd_sweep() {
    : "${TM_BACKUP_DIR:?set TM_BACKUP_DIR in hosted/.env}"
    local now d base k f t key erased due n=0 lines
    now="$(stamp_at "$(now_epoch)")"
    declare -A folder_of=()
    for d in "$TM_BACKUP_DIR"/*/ "$TM_BACKUP_DIR"/_site/*/; do
        [ -d "$d" ] || continue
        base="$(basename "$d")"
        if [ "$base" = _site ] || [ "$base" = _desk ]; then continue; fi
        case "$d" in
            "$TM_BACKUP_DIR/_site/"*) k="$(ledger_key "site:$base")" ;;
            *) k="$(ledger_key "$base")" ;;
        esac
        folder_of[$k]="$d"
    done
    lines="$(ledger_lines)"
    while read -r key erased due; do
        [ -n "$key" ] || continue
        [[ "$due" > "$now" ]] && continue
        d="${folder_of[$key]:-}"
        [ -n "$d" ] || continue
        for f in "$d"*.tar.gz "$d"*.tar.gz.age; do
            [ -f "$f" ] || continue
            t="$(basename "$f")"
            if ! [[ "${t:0:16}" > "$erased" ]]; then rm -f "$f"; n=$((n + 1)); fi
        done
        rmdir "$d" 2>/dev/null || true
    done <<< "$lines"
    if [ -n "$lines" ]; then
        wait_lock _erasures
        lines="$(ledger_lines)"
        for f in "$LEDGER" "$TM_BACKUP_DIR/erasures"; do
            ( umask 077; printf '%s\n' "$lines" > "$f.new" ) && mv "$f.new" "$f"
        done
        unlock _erasures
    fi
    echo "sweep: $n archive(s) deleted whose erasure's grace period had ended"
}

# --- The site ------------------------------------------------------------------
# A site front desk (docs/HOSTING.md, "Many people at one address") running in
# the container TM_SITE_CONTAINER. Its backups go to TM_BACKUP_DIR/_site/: one
# folder per library (<library id>/), so one person's can be erased alone, and
# _desk/ for site.db (accounts and sessions), all of one night under one stamp.
site_container() {
    : "${TM_SITE_CONTAINER:?set TM_SITE_CONTAINER in hosted/.env: the container the site front desk runs in}"
    docker container inspect "$TM_SITE_CONTAINER" >/dev/null 2>&1 || die "no container called $TM_SITE_CONTAINER"
}
# Read from the container's settings, so it is known while it is stopped too.
site_dir() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$TM_SITE_CONTAINER" | sed -n 's/^SITE_DIR=//p'; }

# The site, or one library of it (its id as $1), encrypted into TM_BACKUP_DIR/_site.
# Prints each archive's path, site.db's last; nothing is kept when any part fails.
site_backup() {
    local only="$1" thin="${2:-}" c="$TM_SITE_CONTAINER" sdir stamp work src lib id ok=1
    need_recipients
    sdir="$(site_dir)"
    [ -n "$sdir" ] || { echo "copy.sh: $c has no SITE_DIR" >&2; return 1; }
    stamp="$(new_stamp)"
    work="$WORKDIR/site-$stamp"
    mkdir -m 700 "$work" || return 1
    docker exec "$c" node server/site/cli.js backup "$sdir/.backup-$stamp" ${only:+--library "$only"} >&2 || ok=0
    if [ "$ok" = 1 ]; then docker cp "$c:$sdir/.backup-$stamp" - | tar x -C "$work" || ok=0; fi
    docker exec "$c" rm -rf "$sdir/.backup-$stamp" >/dev/null 2>&1 || true
    src="$work/.backup-$stamp"
    if [ "$ok" = 1 ] && [ -z "$only" ] && [ ! -s "$src/site.db" ]; then ok=0; fi
    if [ "$ok" = 1 ] && [ -n "$only" ] && [ ! -d "$src/libraries/$only" ]; then ok=0; fi
    if [ "$ok" != 1 ]; then rm -rf "$work"; echo "copy.sh: the backup of the site failed; nothing was kept" >&2; return 1; fi
    # Each library as an archive of its own, in the layout of a copy's.
    for lib in "$src"/libraries/*/; do
        [ -d "$lib" ] || continue
        id="$(basename "$lib")"
        if ! { mkdir "$work/p" && mv "$lib" "$work/p/.backup-$stamp" && tar cz -C "$work/p" ".backup-$stamp" > "$work/$id.tar.gz" \
            && rm -rf "$work/p" && seal "$work/$id.tar.gz" "$TM_BACKUP_DIR/_site/$id" "$stamp" "$thin"; }; then
            rm -rf "$work"; echo "copy.sh: the backup of site library $id failed" >&2; return 1
        fi
    done
    # site.db last: a night that has its archive has every library's.
    if [ -z "$only" ]; then
        if ! { mkdir -p "$work/p/.backup-$stamp" && mv "$src/site.db" "$work/p/.backup-$stamp/site.db" \
            && tar cz -C "$work/p" ".backup-$stamp" > "$work/_desk.tar.gz" && seal "$work/_desk.tar.gz" "$TM_BACKUP_DIR/_site/_desk" "$stamp" "$thin"; }; then
            rm -rf "$work"; echo "copy.sh: the backup of the site's accounts (site.db) failed" >&2; return 1
        fi
    fi
    rm -rf "$work"
}

cmd_site_remove() {
    local email="${1:-}" yes="" erase="" id archive
    shift || true
    while [ $# -gt 0 ]; do
        case "$1" in
            --yes) yes=--yes ;;
            --erase) erase=1 ;;
            *) die "usage: site-remove <email> [--erase] [--yes]" ;;
        esac
        shift
    done
    [ -n "$email" ] || die "usage: site-remove <email> [--erase] [--yes]"
    site_container
    id="$(docker exec "$TM_SITE_CONTAINER" node server/site/cli.js accounts \
        | awk -F'\t' -v e="$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')" '$1 == e { print $2 }')"
    [ -n "$id" ] || die "no account $email on the site"
    if [ "$yes" != --yes ]; then
        read -r -p "Remove $email's account and library? A backup is made first. Type the address to confirm: " typed
        [ "$typed" = "$email" ] || die "not confirmed"
    fi
    wait_lock _site
    archive="$(site_backup "$id")" || die "the backup failed; nothing was removed"
    archive="$(tail -1 <<< "$archive")"
    [ -s "$archive" ] || die "the backup failed; nothing was removed"
    if [ -n "$erase" ]; then erase_record "site:$id"; fi
    docker exec "$TM_SITE_CONTAINER" node server/site/cli.js remove "$email" || die "the account of $email was not removed"
    unlock _site
    echo "removed: $email (library $id)"
    echo "its library: $archive"
}

cmd_site_restore() {
    local desk="${1:-}" keep="" identity="${TM_BACKUP_IDENTITY:-}"
    shift || true
    while [ $# -gt 0 ]; do
        case "$1" in
            --no-backup) keep=--no-backup; shift ;;
            --identity) identity="${2:?--identity needs the private key file}"; shift 2 ;;
            *) die "usage: site-restore <_site/_desk/archive> [--identity <key file>] [--no-backup]" ;;
        esac
    done
    [ -f "$desk" ] && [ "$(basename "$(dirname "$desk")")" = _desk ] \
        || die "usage: site-restore <_site/_desk/archive> [--identity <key file>] [--no-backup]"
    site_container
    local siteroot stamp sdir image work d id a n=0 skipped=0
    siteroot="$(dirname "$(dirname "$desk")")"
    stamp="$(basename "$desk")"; stamp="${stamp%.age}"; stamp="${stamp%.tar.gz}"
    sdir="$(site_dir)"
    [ -n "$sdir" ] || die "$TM_SITE_CONTAINER has no SITE_DIR"
    image="$(docker inspect -f '{{.Config.Image}}' "$TM_SITE_CONTAINER")"
    wait_lock _site
    work="$WORKDIR/site-restore-$$"
    SCRATCH+=("$work")
    mkdir -p -m 700 "$work/.backup-$stamp/libraries"
    # That night's site.db, and each library of the same night. An erased
    # library's archive is not even opened.
    open_archive "$desk" "$identity" "the site"
    mkdir "$work/x" && tar xz -C "$work/x" < "$OPENED" && mv "$work/x"/.backup-*/site.db "$work/.backup-$stamp/site.db" \
        || die "$desk holds no site.db; the site was not touched"
    rm -rf "$work/x"
    for d in "$siteroot"/*/; do
        id="$(basename "$d")"
        [ "$id" = _desk ] && continue
        if [ -n "$(erased_at "site:$id")" ]; then skipped=$((skipped + 1)); continue; fi
        a="$d$stamp.tar.gz.age"
        [ -f "$a" ] || a="$d$stamp.tar.gz"
        [ -f "$a" ] || continue
        open_archive "$a" "$identity" "the site"
        mkdir "$work/x" && tar xz -C "$work/x" < "$OPENED" && mv "$work/x"/.backup-* "$work/.backup-$stamp/libraries/$id" \
            || die "$a is not a readable library backup; the site was not touched"
        rm -rf "$work/x"
        [ "$OPENED" = "$a" ] || rm -f "$OPENED"
        n=$((n + 1))
    done
    # The ledger goes in with it: the restore deletes every erased library's
    # account and rows from that site.db before it takes the live one's place.
    ledger_lines | cut -d' ' -f1 > "$work/.backup-$stamp/erased"
    if [ "$keep" = --no-backup ]; then
        echo "no backup of the site before the restore (--no-backup)"
    else
        local before
        before="$(site_backup "" keep-all)" || die "the backup of the site before the restore failed; the site was not touched (restore with --no-backup to go on without it)"
        echo "the site before the restore: $(tail -1 <<< "$before")"
    fi
    docker stop "$TM_SITE_CONTAINER" >/dev/null
    local rc=0
    tar c -C "$work" ".backup-$stamp" | docker run --rm -i --network none --user 0 --volumes-from "$TM_SITE_CONTAINER" -e SITE_DIR="$sdir" "$image" \
        sh -c 'mkdir -p /tmp/r && tar x -C /tmp/r && node server/site/cli.js restore /tmp/r/.backup-* --erased /tmp/r/.backup-*/erased' || rc=$?
    docker start "$TM_SITE_CONTAINER" >/dev/null
    unlock _site
    [ "$rc" = 0 ] || die "the site restore failed (exit $rc), see above; the site was started again"
    echo "site restored from $desk: $n librar$([ "$n" = 1 ] && echo y || echo ies), $skipped erased left out"
}

case "${1:-}" in
    new) shift; cmd_new "$@" ;;
    list) cmd_list ;;
    backup) shift; cmd_backup "$@" ;;
    restore) shift; cmd_restore "$@" ;;
    remove) shift; cmd_remove "$@" ;;
    erase) shift; cmd_erase "$@" ;;
    unerase) shift; cmd_unerase "$@" ;;
    sweep) cmd_sweep ;;
    site-remove) shift; cmd_site_remove "$@" ;;
    site-restore) shift; cmd_site_restore "$@" ;;
    update) shift; cmd_update "$@" ;;
    *) sed -n '2,/^# Settings come from/p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

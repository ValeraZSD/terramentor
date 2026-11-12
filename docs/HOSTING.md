# Hosting copies for other people

Terramentor is built to run on its owner's own computer. This page is for the
other case: you run a server, and each person who uses the app gets **their own
private copy** on it, opened in a phone's browser at an address like
`https://alice.study.example.org` and added to the home screen.

Each copy is the ordinary Docker image started in **hosted mode**
(`TERRAMENTOR_HOSTED=1`), with its own volume, its own network, its own
password and a memory cap. One Caddy container in front of them all handles
HTTPS and gets the certificates. `hosted/copy.sh` does all of it.

What this is not, so nobody is surprised:

- **Not multi-user.** A copy is one library with one password. Two people get
  two copies.
- **Not end-to-end encrypted.** Whoever runs the server can read every library
  on it, the same way the owner of a computer can read its files. Tell the
  people you host that, and see the privacy notice you owe them.
- **Not offline.** A copy works while the phone is online.

## What you need

- A Linux server with Docker and the Compose plugin, and ports 80 and 443 open.
- A domain with a wildcard DNS record (`*.study.example.org`) pointing at it.
- The repository's `hosted/` folder on the server (cloning the repository is
  the simplest way to get it).

## Setting up

```sh
cp hosted/example.env hosted/.env     # then fill it in
hosted/copy.sh new alice --ai-key-file alice.key
```

`new` prints the copy's address and a generated password, **once**. Nothing
keeps the password: the library stores only its hash. Give both to the person;
they open the address, sign in, and add it to the home screen.

| command | what it does |
|---|---|
| `copy.sh new <name> [--ai-key-file F]` | creates the volume and network, sets the password before the first start, starts the copy, adds its site to the proxy |
| `copy.sh list` | every copy, running or stopped, with its address |
| `copy.sh backup <name>` / `--all` | an online backup of each copy into `TM_BACKUP_DIR/<name>/` |
| `copy.sh restore <name> <archive>` | stops the copy, puts the backup in place, starts it |
| `copy.sh update <name>` / `--all` | recreates the container from `TM_IMAGE`; the library stays |
| `copy.sh remove <name> [--yes]` | backs the copy up first, then removes it, its volume, network and key |

Each copy runs read-only except for its volume and a temporary folder, with no
Linux capabilities, `no-new-privileges`, and the limits from `hosted/.env`:
`TM_MEMORY` (default `1536m`, enough for the largest deck an import takes),
`TM_CPUS` and `TM_PIDS`. The copies publish no port; only the proxy reaches
them, each over a network shared with nothing but the proxy.

`hosted/rehearse.sh` runs the whole cycle on one machine with two copies and
Caddy's own local certificates. CI runs it on every pull request.

## Hosted mode

A copy started with `TERRAMENTOR_HOSTED=1` (`copy.sh` always sets it) keeps
three rules (`server/hosted.js`):

**It never starts reachable without a lock.** Bound to anything but loopback,
it refuses to start unless a password is already set or the operator gave it a
one-time setup token:

```
$ docker run --rm -e TERRAMENTOR_HOSTED=1 ghcr.io/valerazsd/terramentor:1
[hosted] Refusing to start: bound to 0.0.0.0 with no password and no TERRAMENTOR_SETUP_TOKEN, so whoever reaches it first would set the password. Set one first (node server/hostedCli.js set-password) or give the copy a setup token.
```

`copy.sh new` sets the password before the copy first starts
(`node server/hostedCli.js set-password --generate` on the empty volume). The
alternative is `TERRAMENTOR_SETUP_TOKEN` (at least 24 characters): the person
enters it on the first visit, it is never printed to the log, and it replaces
the random setup code a copy would otherwise print. `AUTH_ALLOW_OPEN_REMOTE=1`
and `ALLOW_PRIVATE_FETCH=1` also stop a hosted copy from starting.

**The password cannot be removed from inside the app.** It can be changed.

**What acts on the server instead of on the library is off.** The server, its
network and its updates are yours, not the person's:

| feature | on a hosted copy | why |
|---|---|---|
| Model address, provider, saved connections, the provider key, the OpenRouter and ChatGPT sign-ins, which connection each job uses | **refused** (403, `hosted: true`); set by the operator in the environment | where the app sends requests is an address on the server's network, which can reach the server's own services and its cloud's metadata address |
| Pulling or deleting a local model | **refused** | there is no local model; it would install software on the server |
| SearXNG address and its "Test" button | **refused** | the test answers "is something listening there" for any address someone types |
| Tailscale sharing | **refused** | it runs the Tailscale command on the server |
| Update check, download, install, channel | **refused**; the panel still reads | the operator updates the image (`copy.sh update`) |
| Desktop controls (quit, open the data folder, start at login) | **refused** | a container has none; quitting would only restart it |
| Removing the password | **refused** | a copy on the internet is never open |
| Fetching a captured link, finding resources, web answers | on | every fetch is checked by `server/netSafety.js`, which refuses private, loopback, link-local and metadata addresses; `ALLOW_PRIVATE_FETCH=1` stops the copy starting |
| Hosted search keys (Tavily, Brave, Jina) | on | the person's own key, sent only to that service's fixed address |
| Files in the library (uploads, Anki decks, pictures) | on | no route takes a path on the server; files are uploaded and stored by their hash on the copy's volume |
| The code runner | on | learner code runs in a worker in the person's browser, never on the server |
| The MCP server | off | nothing starts it in a copy; its HTTP listener refuses any address but loopback, so only someone with a shell on the server could run it |
| Connecting a phone with a code | on | making a code asks for the password again |
| The API key for scripts | on | managed only with the password |
| The activity log | on | it stays in the copy's library |

Reading is never refused: the settings screens still show what is in use.

Behind the proxy a copy trusts `X-Forwarded-For` from private addresses (its
own network), so the login throttle counts each visitor apart: eight wrong
guesses from a stranger lock out that stranger, not the person.

## Backups

`copy.sh backup` copies each library while it runs, through SQLite's backup
API, together with the credentials file beside it (the password hash and any
keys) and the stored files. Each archive is checked on the way out (an
integrity check and the project count) and is readable by its owner only.
`TM_BACKUP_KEEP` (default 14) archives are kept per copy.

Nightly, from root's crontab:

```
15 3 * * * /opt/terramentor/hosted/copy.sh backup --all >> /var/log/terramentor-backup.log 2>&1
```

`TM_BACKUP_DIR` can be a mounted storage box. If it is a local disk, copy it
off the server too: a backup on the same disk as the library survives a
mistake, not a lost server.

A restore is `copy.sh restore <name> <archive>`. Try one before you need one;
`hosted/rehearse.sh` deletes a project, restores the backup and checks it is
back.

## The model and its cost

Every copy uses the model in `hosted/.env` (`AI_PROVIDER`, `AI_BASE_URL`,
`AI_MODEL`) with a key of its own, so one person's use cannot spend another's
budget and a leaked key is one key. With OpenRouter, a **management key**
creates one ordinary key per copy, each with a spending limit. From
OpenRouter's documentation:

- The limit: "Optional spending limit for the API key in USD"
  ([Create API key](https://openrouter.ai/docs/api-reference/api-keys/create-api-key)).
- It can reset: "Type of limit reset for the API key (daily, weekly, monthly,
  or null for no reset)." and "Resets happen automatically at midnight UTC, and
  weeks are Monday through Sunday." (same page).
- At the limit: "`openrouter_key_limit` means the API key's credit limit is
  exhausted." ([Limits](https://openrouter.ai/docs/api-reference/limits)).
- Management: "All key management endpoints are under `/api/v1/keys` and
  require a Management API key in the Authorization header." and "Management
  keys cannot be used to make API calls to OpenRouter's completion endpoints"
  ([Management API keys](https://openrouter.ai/docs/features/provisioning-api-keys)).
- The key itself is returned once: "The actual API key string (only shown
  once)" (Create API key).

So, per copy:

```sh
curl -sS https://openrouter.ai/api/v1/keys \
  -H "Authorization: Bearer $OPENROUTER_MANAGEMENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"terramentor-alice","limit":5,"limit_reset":"monthly"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).key))' > alice.key
hosted/copy.sh new alice --ai-key-file alice.key && shred -u alice.key
```

The key then lives only in `hosted/copies/alice.env` (readable by root) and in
the copy's environment. Raise or pause it with `PATCH /api/v1/keys/{hash}`
(`limit`, `disabled`), and delete it when the copy is removed. A request past
the limit fails at OpenRouter; the copy shows it as a failed model call and
keeps working otherwise. OpenRouter's documentation is ambiguous about whether
that failure is a 402 or a 403, so check what the copy shows once before
relying on the wording.

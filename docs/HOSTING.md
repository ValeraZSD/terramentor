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

### How big a server

Memory is what runs out first. One copy, measured with the container's own
counters (`/sys/fs/cgroup/memory.current` and `memory.peak`) behind the proxy,
with a course of 48 topics (about 5,000 words of lesson each) and 576 cards:

| state | memory |
|---|---|
| started, empty library, idle | 108 MiB |
| after a review session (20 cards rated) | peak 155 MiB |
| after signing in on a phone and opening every main screen and all 48 lessons | peak 246 MiB; 196 MiB held afterwards |
| the proxy (Caddy), serving it | 21 MiB |

Node keeps what it allocated, so plan on about 200 MiB for each copy that has
been used, whether or not its person is online. Fifty copies then need about
10 GiB, plus the system and the proxy (under 1 GiB):

| server memory | 50 copies |
|---|---|
| 12 GB | fit, with about 1 GiB to spare: enough for everyone studying at once, not for several large imports at once. Add a few GB of swap as a buffer. |
| 24 GB | fit with room for imports and growth, or about 100 copies |

CPU is not the limit: an idle copy uses under 1% of a core. Nothing here
depends on the provider: any Linux server with Docker runs it.

`TM_MEMORY` (768m by default, about three times the measured peak) is each
copy's ceiling, not a reservation, so the ceilings may add up to more than the
server has. A copy that reaches its ceiling is stopped by the kernel and
restarted; raise it for someone who imports large Anki decks.

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
| `copy.sh restore <name> <archive> [--no-backup]` | reads the archive, backs the copy up as it is (needs `TM_BACKUP_DIR`), stops it, puts the backup in place, starts it; a backup that fails its check leaves the copy running on its own library |
| `copy.sh update <name>` / `--all` | recreates the container from `TM_IMAGE`; the library stays |
| `copy.sh remove <name> [--yes]` | backs the copy up first, then removes it, its volume, network and key |

`new`, `restore`, `update` and `remove` take a lock per copy in
`hosted/.locks/`, so two operators cannot work on the same copy at once; a
backup waits for that lock, so a restore never changes a library while it is
being read. Every change to the shared proxy waits for one lock of its own.

A restore marks the library before it replaces anything and clears the mark
when every part is in place. A restore that stopped partway, even one that
was killed, leaves the mark, and the copy refuses to start, and a backup of it
is refused, until a restore completes (`node server/hostedCli.js restore-state` inside the image reports it).

Each copy runs read-only except for its volume and a temporary folder, with no
Linux capabilities, `no-new-privileges`, and the limits from `hosted/.env`:
`TM_MEMORY` (default `768m`; see "How big a server"),
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
and `ALLOW_PRIVATE_FETCH=1` also stop a hosted copy from starting, and so does
any value of `TERRAMENTOR_HOSTED` other than `1` or `0` (`true` would otherwise
start an ordinary copy with none of these rules).

**The password cannot be removed from inside the app.** It can be changed.

**What acts on the server instead of on the library is off.** The server, its
network and its updates are yours, not the person's:

| feature | on a hosted copy | why |
|---|---|---|
| Model address, provider, saved connections, the provider key, the OpenRouter and ChatGPT sign-ins, which connection each job uses | **refused** (403, `hosted: true`); set by the operator in the environment | where the app sends requests is an address on the server's network, which can reach the server's own services and its cloud's metadata address |
| Which model answers and how (model names, reasoning effort, provider order, web search, the vision and naming models, the embedding model) | **refused**; turning the model off is still allowed | the operator's key pays for it; `copy.sh new` refuses to start a copy with no `AI_MODEL` |
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

## Many people at one address

A copy per person (above) gives each person their own address. The site front desk
(`server/site/`) puts many people behind one address instead: each person signs in at
`/site/sign-in` and gets their own library, which is still a separate copy of the app with its
own database and files. The front desk checks the session, starts the person's library if it is
not running, passes the request on, and stops the library again when it has been quiet.

**What it needs.** Linux, Node 24.7 or later, and root: the front desk starts each library as a
user of its own (`SITE_SEPARATE=1`, the default on Linux), with a folder no other library can
read and a Unix socket inside that folder instead of a port. From the image:

```
docker run -d --user 0 -v tm-site:/site -e SITE_DIR=/site -e HOST=0.0.0.0 \
  -e SITE_HOSTS=learn.example.org -e AI_PROVIDER=openai -e AI_BASE_URL=... -e AI_MODEL=... -e AI_API_KEY=... \
  -p 127.0.0.1:3001:3001 ghcr.io/valerazsd/terramentor:1 node server/site/index.js
```

Put it behind a TLS proxy (Caddy, as for the copies): the session cookie is `__Host-` and
`Secure`, so a browser keeps it only over HTTPS (or on `localhost`). `SITE_HOSTS` is the name
or names the site answers to; any other `Host` gets 421. With `HOST` beyond loopback (as in a
container) the front desk refuses to start without it.

**Accounts are made by invitation.** There is no public sign-up yet:

```
$ docker exec <container> node server/site/cli.js invite ann@example.org --url https://learn.example.org
Invite for ann@example.org, good for 7 days and once:
https://learn.example.org/site/invite/...
```

The link opens a page that asks for a password (at least 15 characters; one found in the Pwned
Passwords list is refused, `SITE_BREACH_CHECK=0` turns that check off) and then opens the
person's new, empty library. `cli.js accounts` lists accounts, `cli.js sign-out <email>` ends
every session of one, and `cli.js unlock <email>` turns a password back on after 100 wrong
guesses in a row switched it off. Inside the app, Settings → Devices & security shows the
account's email with a Sign out button, and every device it is signed in on, each with its own
Sign out and, with two or more others, "Sign out of all other devices". What the front desk
stores and how it signs people in is in `SECURITY.md`, "Accounts on a site".

**Settings.**

| variable | default | what it does |
|---|---|---|
| `SITE_DIR` | (required) | the site's folder: `site.db` (accounts, sessions) and `libraries/<n>/` |
| `PORT`, `HOST` | 3001, 127.0.0.1 | where the front desk listens |
| `SITE_HOSTS` | (required unless `HOST` is loopback) | the names it answers to, comma-separated; a front desk bound beyond loopback without it refuses to start |
| `SITE_MAX_AWAKE` | 20 | libraries running at once; the next wake stops the longest-quiet idle one, or answers "busy" |
| `SITE_LIBRARY_HEAP_MB` | 256 | each library's V8 heap limit |
| `SITE_LIBRARY_MEMORY_MB` | 400 | resident memory past which a quiet library is stopped |
| `SITE_IDLE_MINUTES` | 10 | quiet minutes before a library is stopped; never while a stream is open or a task runs |
| `SITE_UID_BASE` | 100000 | the first user id given to a library |
| `SITE_BREACH_CHECK` | on | `0` turns off the breached-password check |
| `AI_FUSE_SWITCH_USD` | 5 | a person's model spend in a calendar month past which their calls go to `AI_FUSE_SMALL_MODEL` |
| `AI_FUSE_STOP_USD` | 10 | the spend past which they make no model calls until the next month |
| `AI_FUSE_SMALL_MODEL` | `anthropic/claude-haiku-5.5` | the cheaper model, on the same `AI_BASE_URL` and key |
| `AI_FUSE_NOTICE_URL` | (none) | an address that gets a JSON POST when a library passes either line |

**What each person may spend on the model.** Every library uses the one key in `AI_API_KEY`, so
a spending limit on that key (below, "The model and its cost") is a limit for the whole site,
and one person's runaway loop or bulk generation could spend everyone's month. Each library
therefore counts its own model spend per calendar month (UTC), in its own database, and holds
itself to two lines:

1. Once the month's spend reaches `AI_FUSE_SWITCH_USD`, every model call of that person goes
   to `AI_FUSE_SMALL_MODEL` for the rest of the month.
2. Once it reaches `AI_FUSE_STOP_USD`, that person starts no model call until the first of the
   next month (a call already running when the line is crossed finishes and is counted, so the
   total can end a few cents over). They read one sentence ("AI is paused on your account until next month; your reviews,
   cards and everything already made keep working.") where a model answer would have been. Their
   card reviews, quizzes with set answers, lessons already written and search keep working,
   since none of them needs the model (search still embeds its query: embeddings cost a fraction
   of a cent and are never refused). What does need it waits for the next month: new lessons,
   the assistant, and marking a written answer by its meaning.

There is no daily limit; the monthly total already bounds the cost. The defaults are a fuse
against loops and abuse rather than a quota: they sit far above what one person studying every
day spends. The cost of each call is what OpenRouter reports on it (`usage.cost`, "Cost in
credits", [Usage Accounting](https://openrouter.ai/docs/use-cases/usage-accounting), which
also says "No additional parameters are required"), read from the answer, or from the extra
chunk a streamed answer ends with, so the count matches your OpenRouter activity page. A provider that reports no cost is counted by its tokens at Claude Sonnet 5.5's
listed price (USD 2 in, USD 10 out per million), or by its characters when it reports no
tokens either. A model on the same machine (`AI_PROVIDER=ollama`) is neither counted nor
switched.

When a library passes either line, its log says so (`[ai-fuse] Library 1a2b3c4d has spent USD
5.01 on the model in 2026-12, past USD 5.00 ...`), once per line and month, with how many days
ago the library was made: a switch on the day it was made is what a loop looks like. With
`AI_FUSE_NOTICE_URL` set, the same sentence also goes there as a JSON POST
(`{"text": "...", "event": "switch" | "stop", "library": "1a2b3c4d", "month": "2026-12",
"spentUsd": 5.01, "switchUsd": 5, "stopUsd": 10}`), which a Slack or Mattermost incoming
webhook shows as it is. Nothing a person wrote is in it. The address may be a machine on your
own network; a cloud metadata address is refused and a redirect is not followed. The front desk
refuses to start with a value it cannot use (an amount that is not a number, a switch above the
stop, a stop of 0, a small model that is not a model name, a notice address that is not http or
https) and
prints the lines in force when it starts. A copy per person (above) has no fuse: its own key
with its own limit at OpenRouter does that job.

**Waking is fast and starts nothing that costs.** A library woken by a request answers in about
0.6 s (measured on a 24-thread machine; `tools/site-proofs.mjs` prints the number on yours). A
wake does not start the work an ordinary start does (feed generation, the update check, node
sync, search words), so a person opening the page never spends model money they did not ask
for.

**Check it on your server.** `tools/site-proofs.mjs` (Linux, as root) makes two libraries and
checks that one cannot read the other's files, socket or environment, measures the wake, and
checks that a wake sends nothing to the model. The image does not carry `tools/`, so run it
from a checkout of the same version:

```
docker run --rm --user 0 -v "$PWD/tools:/app/tools:ro" ghcr.io/valerazsd/terramentor:1 node tools/site-proofs.mjs
```

`tools/site-browser-proof.mjs` checks the last part in a real browser: two people on one
browser, one after the other, and nothing of the first is served to the second after they sign
out (it needs a running front desk and two invite links; see the file's header).

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

A restore is `copy.sh restore <name> <archive>`. It first backs the copy up as
it is, beside its other backups (and prints that archive's path), so a restore
from the wrong archive is undone by restoring that one. That needs
`TM_BACKUP_DIR` set in `hosted/.env`, also on a new server. A library whose
last restore never finished is not backed up (it cannot be, and this restore
is the repair); for one too damaged to back up, `--no-backup` goes on without
the backup. Try one before you need one;
`hosted/rehearse.sh` deletes a project, restores the backup and checks it is
back.

## Zero retention

A learner's notes, photos and passages go to the model. OpenRouter decides
per request whether a provider may keep them, so a hosted copy (and every
library of a site) asks on every chat, picture and embedding request:

```json
{ "provider": { "zdr": true, "data_collection": "deny" } }
```

From OpenRouter's documentation: "When `zdr` is set to `true`, the request
will only be routed to ZDR endpoints", and `data_collection: "deny"` excludes
"providers that may store data"
([Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection)).
The copy adds both itself; `AI_EXTRA_BODY` can add other fields but cannot
switch these off, and one that tries is named in the log at start. A copy on
someone's own computer is unchanged.

**The model needs a zero-retention endpoint, and so does the embedding model**
(and on a site, `AI_FUSE_SMALL_MODEL`, which every call of a person past the switch uses;
check it with the same command below).
When none serves it, OpenRouter refuses the request and the request is not sent
anywhere else. For the model, the copy shows "No zero-retention endpoint on
OpenRouter serves the model ..."; for the embedding model, search and related
topics quietly go without, and the log says why. List the endpoints that qualify (no key needed):

```sh
curl -sS https://openrouter.ai/api/v1/endpoints/zdr \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s).data)if(e.model_id===process.argv[1])console.log(e.provider_name,e.tag,"safety_retention:",e.safety_retention)})' \
  anthropic/claude-sonnet-5.5
```

On 24 November 2026 that printed two endpoints for
`anthropic/claude-sonnet-5.5` (Google Vertex and Amazon Bedrock) and two for
`qwen/qwen3-embedding-8b`, the embedding model a copy on OpenRouter uses unless
told otherwise (Nebius and DeepInfra), all with `safety_retention: false`.
Run it again for your model before you start a copy; the list changes.

**Set your OpenRouter account to "ZDR only".** OpenRouter also has "Safety
Retention" endpoints, where "OpenRouter or a provider may retain prompts and
responses from any request, whether flagged or not, only to detect,
investigate, and prevent abuse", and `zdr: true` admits them unless the
account or a guardrail excludes them: "If you haven't chosen, self-serve
accounts allow Safety Retention"
([Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr)). A
request cannot exclude them itself, so choose **ZDR only** for both groups
(Google, and all other models) in the
[privacy settings](https://openrouter.ai/settings/privacy). The same page says
OpenRouter screens all requests, ZDR ones included, for child sexual abuse
material, and flagged content "may be retained for human review, reporting,
and preservation where required by law".

**Only OpenRouter takes these fields.** With `AI_BASE_URL` pointing anywhere
else the copy sends none of them (a strict API refuses a field it does not
know), says so in the log at start, and retention is whatever you have agreed
with that provider. A local model (`AI_PROVIDER=ollama`) keeps everything on
the server.

## The model and its cost

Every copy uses the model in `hosted/.env` (`AI_PROVIDER`, `AI_BASE_URL`,
`AI_MODEL`) with a key of its own, so one person's use cannot spend another's
budget and a leaked key is one key. (A site, "Many people at one address",
has one key for everyone: its limit is the site's, and the limit per person is
the app's own fuse, `AI_FUSE_*`.) With OpenRouter, a **management key**
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
  require a Management API key in the Authorization header." A management key
  manages keys and makes no model calls itself
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

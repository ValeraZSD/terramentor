# Security

## What this app is, in security terms

A **local-first** study engine. It runs as a single-user Express server on your own machine,
stores everything in one SQLite file next to the code, and talks to a language model at an
endpoint **you** configure. There is no vendor and no account, and nobody else holds your
data.

That shapes the whole threat model. The security claim here is **architectural, not
cryptographic**: it is not "we encrypt your data so we can't read it", it is "we never receive
your data at all." Those are different claims and we only make the second one.

## What is protected

- **Your study data never leaves your machine** unless you send it somewhere. The only outbound
  connections the app makes are (a) to the AI endpoint configured in Settings and, if you
  set one, to a separate embedding endpoint; (b) **resource curation while the AI creates a
  project**, which is **on by default** (Settings → AI & Models → "Find resources") and sends
  search queries the model writes from each topic's *title*, never your notes or documents,
  to DuckDuckGo, Wikipedia and GitHub,
  plus your own SearXNG if you configured one, then probes the candidate links; (c) fetching a
  URL you explicitly asked it to fetch; (d) the update check described below, which is **off
  by default**; and (e) web search for an ANSWER, described next, which is also **off by
  default**. Nothing else. There is **no telemetry, no analytics and no crash reporting**;
  see "Verifying the no-telemetry claim" below, because you should not take our word for it.
- **No model or asset is fetched at first use.** The one thing that could be: PDF math recovery
  falls back to OCR, and tesseract.js downloads its language model from a CDN unless it is told
  where the model already is. This app ships the English model inside the install
  (`@tesseract.js-data/eng`, pointed at by `server/pdfRecovery.js`) and there is deliberately no
  CDN fallback: a fallback would fire on the machine least able to want it. That is what lets
  the "OCR only" recovery mode call itself fully offline.
- **The server binds `127.0.0.1` by default.** It is not reachable from your network unless you
  deliberately put something in front of it.
- **Only pages served from a name you could plausibly be reaching the app by may call `/api`**
  (`server/originGuard.js`). Every request is checked twice: the `Origin` header answers "which
  page is asking", and the `Host` header answers "what name did they arrive by", which is what
  stops a public DNS name being pointed at your loopback address to make a hostile page
  same-origin (the ranges are matched against IP **literals** only: a DNS name like
  `10.evil.com` begins with the characters "10." but resolves wherever its owner points it).
  An `Origin` must also answer to the request: a page from *another* device of your network
  (`http://192.168.1.50:8080`, a sibling machine's mDNS name) does **not** get the API just by
  being local: your browser can always reach your own loopback, so such a page is a real
  drive-by. What is trusted: loopback (`localhost`, `127.0.0.0/8`, `::1`), the private LAN
  ranges (`10/8`, `192.168/16`, `172.16/12`), link-local, `*.local` (mDNS), `*.ts.net` (a
  Tailscale tailnet), and, always, the very host the request itself arrived on, which covers
  the phone on your tailnet, the laptop on your LAN, and the single-origin standalone build.
  A reverse proxy that rewrites `Host` (`tailscale serve`) is recognised by its
  `X-Forwarded-Proto` header, which a browser cannot set. A request carrying neither header is
  not a browser (`curl`, the repo's own `tools/*.mjs` scripts) and is unaffected. If your
  deployment needs a different name, `ALLOWED_ORIGINS` and `ALLOWED_HOSTS` (comma-separated)
  extend the list; setting them does not narrow the defaults, so a deployment that must trust
  *less* than a private LAN should be reached over a private network and put behind the auth
  gate rather than by editing that list.
- **Every response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`,
  plus a report-only Content-Security-Policy.** The CSP ships in `Content-Security-Policy-Report-Only`
  so it can be read from the console while the app is exercised, and is only promoted to
  enforcing once nothing in a real session reports a violation.
- **An optional single-user auth gate** (scrypt-hashed password, HMAC-signed session cookie,
  bearer API key for scripted access, brute-force throttling) covers every `/api` route. It is
  **off by default**, because on a loopback-only bind there is nothing to authenticate against.
  Turn it on before exposing the app by any means.
- **The settings dump carries no credentials.** `GET /api/settings` returns preferences (theme,
  model choice, feed dials) and nothing credential-shaped: the auth secrets sit behind their own
  `/api/auth/*` endpoints, and the cloud provider key is write-only: `/api/ai/key` stores and
  clears it, `/api/ai/status` answers only whether one is saved. The key itself never travels
  back to a client, in the dump or anywhere else.
- **AI-generated visuals run sandboxed.** p5 sketches and compiled widgets execute in
  `<iframe sandbox="allow-scripts">` with no same-origin access.
- **Uploaded archives are validated** against zip-bomb and path-traversal patterns before
  extraction (`assertZipSafe`), with entry-count and total-size bounds.

## What is NOT protected

- **The database is not encrypted at rest.** `server/terramentor.db` is a plain SQLite
  file. Anyone with read access to your disk or your backups can read everything in it,
  including your private notes. If you need encryption at rest, use full-disk encryption
  (BitLocker, FileVault, LUKS). We do not currently offer application-level encryption.
- **There is no multi-user model.** No roles, no per-user data separation, no audit log. One
  person, one machine. Do not run this as a shared service for a class.
- **The auth gate is a gate, not a hardened perimeter.** It is designed to stop a casual passerby
  on your LAN or a mesh network, not a determined attacker. Prefer a private network
  (Tailscale/WireGuard) over port-forwarding, always.
- **Your prompts go to whatever endpoint you configure.** If you point the app at a hosted API,
  your lesson content, questions, notes-in-context and photographed paper go to that provider
  under *their* terms. Local models (Ollama, llama.cpp) keep it on the machine. The app cannot
  make a remote provider private and does not pretend to. What it can do is pass on a term you
  set yourself: `AI_EXTRA_BODY` (see `.env.example`) merges a JSON object into every request to
  an OpenAI-compatible endpoint, chat and embeddings alike, which is how you send something like
  OpenRouter's `{"provider":{"zdr":true,"data_collection":"deny"}}`; retention there is decided
  per request, not by an account setting. It is unset by default, it can only add fields and
  never change the app's own, and it is your provider that honours it, not us.
- **Choosing a provider in Settings does not change who can read your prompts.** *AI & Models →
  Which machine serves this model* lists the companies your router says can serve the model, and
  your choice is sent as a *preference*: if the one you picked is busy the router uses another,
  because a slower answer beats a failed lesson. So it is a speed, price and consistency control,
  never a privacy one: if it matters that a particular company never sees your material, that is
  `AI_EXTRA_BODY` above, which can say `zdr` and `data_collection` and can refuse rather than fall
  back. Building that list asks the endpoint you configured and no other host, and it asks only
  when you open that panel.
- **AI output can be wrong.** The quality gates in `server/feedQuality.js` reduce this and are
  deliberately readable so you can judge them for yourself, but a mastery estimate is built from
  model-generated assessment and inherits its errors. Both chat surfaces say so under their
  input, and every AI-written row records which model wrote it (`generated_by`).

## The update check

The app can tell you when a new version has been released. It is the only thing here that
would reach the network without you asking for something, so it is built to be checkable:

- **"Check now"** (Settings → General → About) is a **button**. A press is you asking, so it
  is allowed to make the request.
- **"Check daily"** is a separate toggle and **ships off**. Turning it on is you accepting one
  outbound request a day. Nothing else in the app enables it.
- **What it sends:** an HTTP GET to `https://api.github.com/repos/<owner>/<repo>/releases/latest`
  with a `User-Agent` naming the app and its version. No install identifier, no machine name,
  no library contents, no request body. GitHub can see that some copy of the app asked what
  the newest release is, from your IP address (the same thing it would see if you opened the
  releases page in a browser).
- **Who makes it:** the server process, once, cached for a day, not once per page load. So the
  number of requests does not depend on how many devices or tabs you have open.
- **It cannot install anything.** There is no endpoint that updates the app: the banner shows
  the command for your kind of install and you run it. An app that could update itself on
  request would be a remote-code-execution feature.
- **Turning it off stops it immediately**: the timer is cancelled, not merely ignored.

## Web search for answers

The tutor and the assistant can look something up while answering. It is the only thing in the
app that sends **what you typed** rather than a title the app already holds, so it is gated
twice and described here in the same detail as the update check.

- **It ships off.** Settings → AI & Models → "Let answers use the web", which has three
  settings: **Never** (the default), **Ask each question**, and **Whenever it helps**. On
  Never, no code path here opens a socket.
- **Who decides, on each of the other two.** On *Ask each question* a "Search web" switch
  appears beside the tutor and the assistant, **off for each new question**; nothing is
  searched unless it is on when you press send. On *Whenever it helps* the switch is there and
  starts **on**, so any single question can still be kept to yourself by turning it off before
  you send.
- **What it sends.** Your question itself is never sent verbatim. The model is asked first
  whether answering needs anything looked up, and if so it writes its own search terms: up to
  three per round, two rounds, six in total for one question, and for most questions none at
  all. Those terms go to DuckDuckGo, Wikipedia, GitHub and (when you have
  configured one) your own SearXNG instance, followed by an ordinary page fetch of the top
  result or two. The same code and the same URL vetting as resource curation
  (`server/netSafety.js`: private and loopback addresses refused, every redirect re-checked).
- **So you watch it happen, and it stays there.** Each lookup appears in the conversation the
  moment it is asked for (`Searched the web “…”`) and fills in with what came back. It is
  stored with the answer, so reopening the conversation next week still shows exactly which
  queries were sent, and copying the answer takes them along: a model choosing the words is
  exactly why that record is kept.
- **What it does with the result:** the pages become numbered SOURCES the model must cite, not
  text it may quietly absorb. An answer that used a page ends with a link to it, so you can
  check the claim. Unattributed web text in a tutor answer would be worse than no web at all:
  it would look exactly like the model's own knowledge.
- **Nothing about you is attached.** No account, no library contents, no history: the search
  terms and a page fetch, from your IP, the same as typing them into that search engine
  yourself.
- **The assistant can also search your OWN library** (project names, topic titles, resources
  and vault documents) to answer questions about what you already have. That is a query
  against your own SQLite file: it opens no socket and is not part of anything above.

## Verifying the no-telemetry claim

Do not trust this file. Trust a packet capture. The claim is designed to be falsifiable in
about ten minutes:

1. Stop the app. Turn **off** AI features in Settings (or point them at a local endpoint).
   Leave "Check daily" off; it is off unless you turned it on.
2. Start a capture: `tcpdump`/Wireshark, or your OS firewall's outbound logging.
3. Start the app, use it hard: browse the feed, open projects, add notes, run a review. Upload a
   PDF whose equations came out as empty brackets and let recovery run in "OCR only"; that is
   the path that would download a language model if this file were lying to you.
4. You should see **zero** outbound connections beyond loopback.
5. Now turn AI features on and repeat. You should see connections to your configured endpoint
   and to nothing else, with one exception you can switch off: creating a project with
   "Find resources" on adds DuckDuckGo, Wikipedia, GitHub (and your SearXNG) for the duration
   of that creation, and nothing after it.
6. Optional, to check the last paragraph rather than believe it: turn "Check daily" on. You
   should see exactly one connection, to `api.github.com`, and no others. Turn it off again
   and the connection should not recur.

If you observe an outbound connection that is not explained above, that is a security bug;
please report it as one.

## Reporting a problem that is not a vulnerability

Settings → General → About → **Report a problem** assembles the version, commit, install kind
and configured model, shows you the text, and opens a pre-filled GitHub issue form. It sends
nothing itself; GitHub receives it when you press Submit there. The block deliberately
contains no project names, topics, notes or file paths, because a public issue tracker is not
the place for them. Read it before you submit; it is on screen for exactly that reason.

## The activity log

Settings → Data → **Activity log** keeps a local record of what the app did: model calls (which
provider, which model id, which operation, how long, how much came back), background jobs and
their failures, projects created, imported and deleted, and each server start. It is written to
your own database, it is capped at 20,000 events and it is never sent anywhere: the Download
button hands the file to your browser, and what happens to it after that is your decision.

What it does **not** contain is the point of it: no topic titles, no questions, no answers, no
notes, no model output, no file names, no paths. A row is a fact about the software, and where
it refers to something of yours it stores the numeric id. That is the same rule the bug-report
block follows, and for the same reason: a file you might hand to a stranger for help should
not need to be read line by line first.

You can switch the recording off in that panel, and Clear deletes every row. The rule is
enforced in the code, not just here: `tools/activity-log-gates.mjs` scans every call site that
writes to the log and fails the build if one passes something the learner wrote.

## Reporting a vulnerability

Report privately, not as a public issue: **valerazsd@gmail.com**. Include what you did, what
happened, and what you expected. You will get an acknowledgement within a few days.

This is a single-maintainer project. There is no bug bounty and no formal SLA. What you will
get is an honest answer about whether it is a real problem, and if it is, a fix and a public
note about it.

Please do not test against anyone else's instance.

## Supported versions

Single maintainer: support means the latest release and the current `main`. Security fixes are
not backported to older tags.

## Dependency advisories

`npm audit` reports advisories against this project's dependency tree. Rather than leave you to
guess which of them matter, here is every one currently open, what it is, and whether it is
reachable in this app. This list is checked before each release; if it is out of date relative
to `npm audit`, that is a bug; please report it.

The standing rule: an advisory is fixed promptly when it is reachable, and a major-version bump
is not taken on the eve of a release to clear an advisory that provably is not.

| Package | Severity | Reachable here? |
|---|---|---|
| `vite` | high | **No.** Dev-server only: path traversal in optimized-dep `.map` handling, a `server.fs.deny` bypass on Windows alternate paths, and an NTLMv2 hash disclosure via `launch-editor`. `vite` is a devDependency and never runs in a deployed instance; production is `node server/index.js` serving the prebuilt `dist/`. It does affect a **contributor** running `npm run dev` with a malicious page open in the same browser. |
| `esbuild` | moderate | **No.** Same class and the same boundary: any website can send requests to the dev server and read the response. Dev-only, and pulled in both directly (the guard scripts in `tools/` bundle TypeScript with it) and transitively by `vite`. |
| `react-router` / `react-router-dom` | moderate | **No.** Two issues: an open redirect via a backslash in `<Link>`/`useNavigate`, and arbitrary constructor injection in `deserializeErrors()` during SSR hydration. This app does **no** SSR, and it renders **no** `<Link>` at all: every navigation target is a string literal or a template built from an integer node/project id (`/project/92/tree/108`), so no attacker-controlled string reaches the router. |

Fixing any of the three requires a major-version upgrade (`vite` 5 → 8, `react-router-dom`
6 → 7). Both are planned, and both are the kind of change that wants its own release rather
than being bundled into a security note.

**Fixed rather than documented.** Everything that could be closed without a major-version bump
has been. A fresh `npm ci` reports
**4 advisories, all of them in the table**, and every one of those four is printed in full
above, so the count and the explanation cannot drift apart.

Closed by a lockfile bump (no API change, nothing to explain): `browserslist` (unbounded memory
growth, and a prototype write via untrusted custom stats, the only *high* outside the table),
`@xmldom/xmldom` (XML fragment injection during well-formed serialization), and
`postcss-selector-parser` (denial of service through uncontrolled AST recursion). All three are
build-time only.

Closed by an `overrides` entry, because a transitive pin held them back:

- `qs` (array-limit bypass via bracket-key comma parsing, and denial of service via an
  attacker-controlled `isBuffer`), reached through `express` → `body-parser`. This one *is*
  reachable: Express parses a query string on every request, and Express 4 pins a
  `body-parser` that pins a vulnerable `qs`, so the fix was `overrides: { "qs": "^6.16.0" }`
  rather than waiting for an Express 5 migration.
- `uuid` (missing buffer bounds check in v3/v5/v6 when a `buf` argument is supplied), reached
  through `exceljs`. Not reachable, since `exceljs` calls only `uuid.v4()` with no arguments,
  but the fix was one line with no API change, so it was taken.

## Search providers, and add-ons later

**Search providers** (`docs/SEARCH_PROVIDERS.md`) are the only extension point that exists, and
they run no code: a name, an icon and an https URL template that is inert until you click it.
`validateUrlTemplate` is the boundary: https only (which is what blocks `javascript:` reaching
an `href`), no embedded credentials, no unknown placeholders.

A real add-on system is designed but **not built** (`docs/ADDONS.md`), and it will be
capability-based on purpose. Declarative add-ons would execute no code at all; anything that does
run code would run sandboxed with no ambient
network or filesystem access. This is a deliberate departure from the Obsidian/VS Code model,
where extensions inherit the host's full privileges. In an app whose core promise is that your
data stays put, an add-on that could exfiltrate it would void the promise for everyone. If a
proposed add-on capability cannot be granted without breaking the guarantees above, the answer
is no.

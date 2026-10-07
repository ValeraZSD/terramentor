# Security

## What this app is, in security terms

A study app that runs as a single-user Express server on your own machine, stores everything in
one SQLite file in a folder you can open from Settings, and talks to a language model at an
endpoint **you** configure, usually a hosted one under your own key. There is no Terramentor
server and no account, so this project never receives your data. The model provider you choose
receives what each request needs, under its own terms (see "What is NOT protected").

That shapes the whole threat model. The security claim here is **architectural, not
cryptographic**: it is not "we encrypt your data so we can't read it", it is "we never receive
your data at all." Those are different claims and we only make the second one.

## What is protected

- **Your study data never leaves your machine** unless you send it somewhere. The only outbound
  connections the app makes are (a) to the AI endpoint configured in Settings (embeddings go
  to the same endpoint, or to your Ollama address if you route them there), plus the one key
  exchange of *Connect OpenRouter* when you press it (below); (b) **resource curation while
  the AI creates a project**, which is **on by default** (Settings → AI & Models → "Find
  resources"), and the same curation for one topic when you press **Find resources** on it,
  whether that switch is on or not; it sends
  search queries the model writes from each topic's *title*, never your notes or documents,
  to DuckDuckGo, Wikipedia and GitHub,
  plus your own SearXNG if you configured one, plus any hosted search engine whose API key you
  saved in Settings (Tavily, Brave, Jina — see "Web search for answers"; a host is reached only
  if its key is saved), then probes the candidate links; (c) fetching a
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
  drive-by. What is trusted: loopback (`localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`), the private
  LAN ranges (`10/8`, `192.168/16`, `172.16/12`, IPv6 `fc00::/7`), link-local, `*.local` (mDNS),
  a Tailscale tailnet (`*.ts.net`, and the `100.64.0.0/10` addresses it hands out), and, always,
  the very origin the request itself arrived on, which covers
  the phone on your tailnet, the laptop on your LAN, and the single-origin standalone build.
  "The very origin" is the whole of it, scheme and port included: a second web service on
  another port of the same machine shares the name `localhost` and nothing else, and a page it
  serves does not get this API for that.
  A reverse proxy that rewrites `Host` (`tailscale serve`) is recognised by its
  `X-Forwarded-Proto` header. A page may add that header itself, but a custom header makes the
  browser ask first (a CORS preflight), and the app refuses that for any origin not on its
  list, so a foreign page cannot use it to get in. A plain `<img>` or `<script>` on another site
  sends no `Origin` at all, so a third label is read too: the browser's `Sec-Fetch-Site`, which
  must say the request came from this app's own page (`same-origin`) or from an address you typed
  (`none`). Every current browser sends it; one too old to (Safari before 16.4, Firefox before
  90) gets the older protection only. A request carrying none of these headers is not a browser
  (`curl`, the repo's own `tools/*.mjs` scripts) and is unaffected. If your
  deployment needs a different name, `ALLOWED_ORIGINS` and `ALLOWED_HOSTS` (comma-separated)
  extend the list; setting them does not narrow the defaults, so a deployment that must trust
  *less* than a private LAN should be reached over a private network and put behind the auth
  gate rather than by editing that list.
- **Every response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`,
  plus a Content-Security-Policy that is mostly report-only.** Four directives are enforced
  (`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`),
  because no feature uses what they forbid. The rest ships in `Content-Security-Policy-Report-Only`
  so it can be read from the console while the app is exercised, and is only promoted to
  enforcing once nothing in a real session reports a violation.
- **Content the app did not write does not make the browser fetch.** An image in a lesson, a
  chat answer or an imported course that points at another host is shown as a button naming that
  host and loads only when pressed; one that points at this app loads by itself only from the
  media store and the built files, never from an API route that does work when asked; a chart
  draws only the data written into it, fetching no address at all; and a diagram keeps no
  picture, image shape or stylesheet address. An AI-drawn animation keeps no link, `url()` or `image-set()`
  that leaves the drawing, and its stylesheet is rewritten to reach only that drawing, so it cannot
  restyle the page it sits in.
- **An optional single-user auth gate** (scrypt-hashed password, HMAC-signed session cookie,
  bearer API key for scripted access, brute-force throttling) covers every `/api` route except
  the sign-in endpoints themselves, the desktop launcher's status and heartbeat probe, and the
  app icon and manifest (none of which carries library data). It is
  **off by default**, because on a loopback-only bind there is nothing to authenticate against.
  Turn it on before exposing the app by any means. **Until it is on, the app answers only its
  own machine:** a request from anywhere else (judged by the client address; for a request
  relayed by a local proxy, the address the proxy reports in `X-Forwarded-For`) is refused,
  and setting the first password
  from another device takes a one-time setup code printed in the server's log, so whoever
  reaches an unlocked app first cannot choose its password. A container always sees its
  requests arrive from outside, so the Docker image asks for the code on first use
  (`docker compose logs app`). `AUTH_ALLOW_OPEN_REMOTE=1` turns this off.
- **The settings dump carries no credentials.** `GET /api/settings` returns preferences (theme,
  model choice, feed dials) and nothing credential-shaped: the auth secrets sit behind their own
  `/api/auth/*` endpoints, and the cloud provider key is write-only: `/api/ai/key` stores and
  clears it, `/api/ai/status` answers only whether one is saved. The key itself never travels
  back to a client, in the dump or anywhere else.
- **The provider key goes only to the address it was saved for.** It is stored with the origin
  (scheme, host and port) of the base URL it was entered against, and a model call to any other
  origin carries no key. The base URL is an ordinary setting, so without this anything able to
  change one setting could point the app at its own server and collect the key on the next call.
  A key from the environment belongs to `AI_BASE_URL`, or to the base URL the process started with.
- **Connect OpenRouter makes one request, and only when pressed.** The button (the welcome screen,
  Settings → AI & Models, the feed's setup card) sends your browser to `openrouter.ai/auth` with a
  PKCE challenge and this app's own address to come back to. You sign in and approve there;
  openrouter.ai sends the browser back with a one-time code, and the server makes one POST to
  `https://openrouter.ai/api/v1/auth/keys` with that code and the verifier it kept in memory.
  The key it receives is stored like a key typed by hand (bound to `https://openrouter.ai`,
  write-only) and never passes through the page. An attempt lapses after ten minutes, and each
  code and verifier is spent once.
- **AI-generated visuals run sandboxed.** p5 sketches and compiled widgets execute in
  `<iframe sandbox="allow-scripts">` with no same-origin access.
- **An upload is bounded in the aggregate, not only per file** (`server/uploadGuard.js`). A
  multipart body is judged on its `Content-Length` before any of it is read: over the route's
  cap it is refused, and a body that declares no length at all (a chunked upload) is refused
  outright, because the per-file caps alone would let a hundred files sit in memory at once.
  Browsers always declare the length of a file upload, so no supported client meets that refusal.
- **Course and deck archives are bounded where they are decompressed.** Every ZIP-based input
  is first checked for its entry count (`assertZipSafe`), which an archive cannot understate: it
  is how many records its own directory holds. The SIZES an archive declares are written by
  whoever built it, so they are a cheap pre-filter and never the bound. For a `.studyvault`
  course and an `.apkg` deck the bound is applied while the bytes are produced: every entry is
  read through `readZipEntry`, which stops inflating at a per-entry ceiling and refuses the
  file, and every zstd frame inside an `.apkg` is decompressed under a ceiling of its own. An
  uploaded `.docx` or `.xlsx` is unzipped again inside its parser, so every entry is first
  inflated through the same reader under a 300 MB total and discarded. That bounds the bytes, not
  what the parser builds from them, which can be a hundred times larger; so the parser runs in a
  separate process with a 1 GB memory ceiling and a two-minute limit, and a document that needs
  more is refused while the app keeps running.
  Archive entry names are never used as filesystem paths — media files and vault originals are
  stored under the SHA-256 of their own bytes.

## What is NOT protected

- **The database is not encrypted at rest.** `terramentor.db` is a plain SQLite file, kept in
  `%LOCALAPPDATA%\Terramentor`, `~/Library/Application Support/Terramentor` or
  `~/.local/share/Terramentor` by the desktop app, in `/data` in Docker and in `server/` when run
  from source. Anyone with read access to your disk or your backups can read everything in it,
  including your private notes. If you need encryption at rest, use full-disk encryption
  (BitLocker, FileVault, LUKS). We do not currently offer application-level encryption.
- **There is no multi-user model.** No roles, no per-user data separation, no record of who did
  what (the Activity log below records what the app did, for one person). One person, one
  machine. Do not run this as a shared service for a class.
- **The auth gate is a gate, not a hardened perimeter.** It is designed to stop a casual passerby
  on your LAN or a mesh network, not a determined attacker. Prefer a private network
  (Tailscale/WireGuard) over port-forwarding, always.
- **Your prompts go to whatever endpoint you configure.** If you point the app at a hosted API,
  your lesson content, questions, notes-in-context, photographed paper and your learner profile
  (the lines you wrote about yourself, which ride along with every request) go to that provider
  under *their* terms. So do passages from your own documents: the tutor's excerpts from your
  vault, and, when a course keeps documents with text, up to four passages of that course's
  documents (about 3,200 characters) with each feed lesson written for it, so the lesson can
  teach from them (`server/lessonSources.js`). Only that course's documents are searched, never
  the rest of your library, and a course with no documents sends nothing new. With embeddings
  on, the topic and part title of each such lesson also goes to the embedding endpoint to rank
  the passages. A file you attach in the assistant goes there too: a picture as itself, to the
  chat model, in the message it was attached to and again in the next messages while it is
  among the newest pictures of that conversation (or when the assistant reopens it), and a
  document as its extracted text. A phone photo is redrawn in the browser before it is
  uploaded, which leaves the camera's location data behind. Attached files are stored on your
  machine with their conversation and deleted with it. Local models (Ollama, llama.cpp) keep it
  on the machine. The app cannot
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
- **"Check daily"** is a separate toggle and **ships off**. Turning it on checks once straight
  away; after that it is one request each time the app starts (15 seconds in) and one a day
  while it runs, plus a single retry ten minutes later if a scheduled check fails. Nothing
  else in the app enables it.
- **What it sends:** an HTTP GET to `https://api.github.com/repos/<owner>/<repo>/releases/latest`
  with a `User-Agent` naming the app and its version. No install identifier, no machine name,
  no library contents, no request body. GitHub can see that some copy of the app asked what
  the newest release is, from your IP address (the same thing it would see if you opened the
  releases page in a browser).
- **Who makes it:** the server process, on the schedule above, never once per page load. So
  the number of requests does not depend on how many devices or tabs you have open.
- **It cannot install anything.** There is no endpoint that updates the app: the banner shows
  the command for your kind of install and you run it. An app that could update itself on
  request would be a remote-code-execution feature.
- **Turning it off stops it immediately**: the timer is cancelled, not merely ignored.

## Web search for answers

The tutor and the assistant can look something up while answering. It is the only thing in the
app that sends **what you typed** rather than a title the app already holds, so it ships off
and is described here in the same detail as the update check.

- **It ships off.** Settings → AI & Models → "Let answers use the web" is one switch, and it
  starts off. Off, no code path here opens a socket.
- **Who decides, once it is on.** The model does, for each question: it is asked whether
  answering needs anything looked up, and most of the time the answer is no. The switch is
  the permission; the model chooses the occasion. Each chat says under its message box
  whether it can search at all, so the state is not something to remember. To keep a
  question to yourself, turn the switch off before you ask it.
- **What it sends.** The app never sends your question. The model decides, while it answers,
  whether anything needs looking up, and if so it writes its own search terms: up to
  three per round, never more than twelve for one question however many rounds it takes, and
  for most questions none at all. Those terms go to DuckDuckGo, Wikipedia, GitHub and (when
  you have configured one) your own SearXNG instance, followed by an ordinary page fetch of
  the top result or two. The same code and the same URL vetting as resource curation
  (`server/netSafety.js`: private and loopback addresses refused, every redirect re-checked,
  and the connection made to the very address that was checked, so a name that answers
  differently the second time it is asked still cannot reach your own machine or network).
- **What comes back is read as material, never as instruction.** A fetched page, like an
  imported course or a document in your vault, is text that neither you nor this app wrote, and
  the model picked the page out of search results. Each arrives labelled as reference material, with the model told that a
  page addressing it, telling it to ignore its instructions, or asking it to repeat anything
  else from the conversation is the page being quoted rather than anyone to obey. That is a
  prompt instruction, not a proof: it is why the queries are shown to you and kept with the
  answer, and why the switch exists at all.
- **The engines are extendable by key, and only by key.** Settings → AI & Models →
  "Answering with the web" accepts an API key for a hosted search engine (Tavily, Brave, Jina).
  A saved key adds exactly that engine's host — `api.tavily.com`, `api.search.brave.com`,
  `s.jina.ai` — to the outbound set. What each host receives is the search terms the model
  wrote and your key, and nothing else about you; the key is stored in your database and is
  sent to its own service and nowhere else. No key saved, no connection to that host — the
  built-in sources above are the whole set until you add one.
- **So you watch it happen, and it stays there.** Each lookup appears in the conversation the
  moment it is asked for (`Searched the web “…”`) and fills in with what came back. It is
  stored with the answer, so reopening the conversation next week still shows exactly which
  queries were sent, and copying the answer takes them along: a model choosing the words is
  exactly why that record is kept.
- **A page the assistant offers to save is opened once first, under the same switch.** When
  it prepares a link to keep on a topic, the app fetches that one address before it offers
  Save — to refuse a page that does not exist and to read the page's own title — through the
  same `server/netSafety.js` path, reading at most the first 64 KB and giving up after
  10 seconds (`server/assistantChecks.js`). With the switch off the page is not opened, and
  the preview says it was not checked.
- **What it does with the result:** the pages become numbered SOURCES the model must cite, not
  text it may quietly absorb. An answer that used a page ends with a link to it, so you can
  check the claim. Unattributed web text in a tutor answer would be worse than no web at all:
  it would look exactly like the model's own knowledge.
- **The app attaches nothing about you.** No account, no history: the search terms and a page
  fetch, from your IP, the same as typing them into that search engine yourself. The terms are
  written by the model, which has your question and any library text the turn read in front of
  it, and nothing checks a query against that text, so a query can carry words from it. The
  model is told never to put your notes or library text into a search, and every query is shown
  to you as it runs.
- **The assistant can also search your OWN library** (project names, topic titles, resources
  and vault documents) and read one course in depth to answer questions about what you already
  have. That is a query against your own SQLite file: it opens no socket and is not part of
  anything above.
- **Nothing the model says writes to your library.** What the assistant proposes (a mastery
  check, a flashcard, a note for the Inbox, a problem report) is a button under its answer,
  and only your press adds it. The one thing it changes by itself is a short list of
  appearance and locale settings (theme, tint, accent, interface size, week start, interface
  language, number format), each shown at once with an Undo; it can never change the AI,
  sign-in or learning settings.

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
   "Find resources" on adds DuckDuckGo, Wikipedia, GitHub (and your SearXNG, and any hosted
   search engine you saved a key for) for the duration of that creation, and nothing after it.
   Pressing **Find resources** on one topic reaches the same hosts, for that topic only.
6. Optional, to check the update-check paragraph rather than believe it: turn "Check daily"
   on. You should see exactly one connection, to `api.github.com`, and no others. Turn it off
   again and the connection should not recur.

If you observe an outbound connection that is not explained above, that is a security bug;
please report it as one.

## Reporting a problem that is not a vulnerability

Settings → General → About → **Report a problem** assembles the version, commit, install kind,
Node version, platform and build time, the configured AI provider and model, your browser's
user-agent string and window size; it shows you the text and opens a pre-filled GitHub issue
form. It sends
nothing itself; GitHub receives it when you press Submit there. The block deliberately
contains no project names, topics, notes or file paths, because a public issue tracker is not
the place for them. Read it before you submit; it is on screen for exactly that reason.

What you type into its fields, and a report the assistant drafts from a conversation, travel
the same way: in the link you open, after you have seen them in editable boxes. The assistant
cannot send a report and the app makes no request for it; nothing leaves until you press
Submit on GitHub.

## The activity log

Settings → Data → **Activity log** keeps a local record of what the app did: model calls (which
provider, which model id, which operation, how long, how much came back), background jobs and
their failures, projects created, imported and deleted, and each server start. It is written to
your own database, it is capped at 20,000 events and the app never sends it anywhere: the
Download button hands the file to your browser, and what happens to it after that is your decision.

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
guess which of them matter, this section lists every one that is open, what it is, and whether
it is reachable in this app. It is checked before each release; if it is out of date relative
to `npm audit`, that is a bug; please report it.

The standing rule: an advisory is fixed promptly when it is reachable, and one that provably is
not is still closed, in a release of its own if it needs a major-version bump.

**None is open.** A fresh `npm ci` reports **0 advisories**.

Closed by an upgrade: `vite` 5 → 6.4.3 and `esbuild` 0.21 → 0.25 (dev-server only: path
traversal in optimized-dep `.map` handling, a `server.fs.deny` bypass on Windows alternate
paths, an NTLMv2 hash disclosure via `launch-editor`, and any website reading the dev server's
responses; none of it runs in a deployed instance, which is `node server/index.js` serving the
prebuilt `dist/`, but a **contributor** running `npm run dev` was exposed),
`react-router-dom` 6 → 7 (an open redirect via a backslash in
`<Link>`/`useNavigate`, and constructor injection during SSR hydration; neither was reachable,
since the app does no SSR and renders no `<Link>`), `multer` 2.3 → 2.4 (orphaned disk writes on
an aborted upload; every upload here uses memory storage) and `undici` 8.10 → 8.11 (a WebSocket
decompression crash; undici is also the app's own outbound HTTP client now, and it opens no
WebSocket).

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

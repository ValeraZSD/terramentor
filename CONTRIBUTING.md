# Contributing

Thanks for looking. This is a single-maintainer project, so read this before writing code; it will save you work.

## Licence and the CLA, up front

The project is **AGPL-3.0-or-later** (`LICENSE`). Contributions are accepted under a
**Contributor Licence Agreement** (`CLA.md`), which asks you to grant the maintainer the right
to also license your contribution under other terms.

**Why a CLA.** The plan is open core: the engine stays AGPL and local forever;
a future optional hosted relay / sync tier may be commercial. That requires the ability to
license the shared code under other terms. Adding a CLA now costs nothing; retrofitting one
after real contributions exist means tracking down every past contributor, and projects have
been stuck for years on exactly that. If you object to a CLA on principle (a reasonable
position), say so in the issue and we can discuss keeping your change in a separate,
AGPL-only module. (An add-on would need no CLA at all, but the add-on system is a design and
not something you can ship against yet; see `docs/ADDONS.md`.)

Sign through the CLA Assistant bot's one-click link on your first PR; the signature sticks to
your GitHub account for every pull request after.

Every commit must also carry a `Signed-off-by:` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/), `git commit -s`.

**Do not paste AGPL-incompatible code into this repo**, and if you used an AI assistant to write
a non-trivial chunk, say so in the PR. It is allowed; provenance matters for a copyleft
project, and it is easier to say now than to reconstruct later.

## Reporting something without writing code

This is a real contribution and the issue tracker is set up for it. You do not need to be able
to read the code to file a report that saves someone an afternoon.

The easiest route is inside the app: **Settings → General → About → Report a problem**. It fills
in the version, the commit, how the app was installed and which model is configured: the facts
that make a report actionable and that nobody can look up. It asks the same questions the GitHub
form does, shows you exactly what it collected, and opens the right form filled in. It sends
nothing itself. You can also just tell the assistant what went wrong: it asks what it needs and
prepares the same report for you to check.

There are three forms, and the second is the one most worth knowing about:

- **Something is broken**: a button that does nothing, a page that looks wrong, an error.
- **The AI got something wrong**: a lesson, question, visual or grade that is factually wrong.
  Every generated item passes the checks in `server/feedQuality.js` before it is shown, so
  something wrong that reached a learner is by definition something those checks miss. That is
  a gate to be written, and the report is valuable with no fix attached. Include the model:
  a 4B and a 30B are not the same product.
- **An idea or request**: read `ROADMAP.md`'s "Not doing" list first; it is short and specific.

Questions ("is it meant to do this?") belong in Discussions rather than the tracker, and a
security problem goes to the private email address in `SECURITY.md`, never the tracker.

## Before you build something

**Open an issue first for anything non-trivial.** This project has strong opinions that are not
obvious from the code, and a PR that fights one of them gets rejected no matter how well it is
written. The opinions live in:

- `CoreIdea.md`: the philosophy. Seven design principles. Read at least these.
- `docs/ARCHITECTURE.md`: the engineering conventions, and the *reasons* behind them.
- `ROADMAP.md`: where the project is going, what is deferred and why, and what it will
  deliberately never do.

Things that will be declined regardless of quality:

- **Gamification.** No streaks, no badges, no leaderboards, no "don't break your chain". This is
  a mastery engine for adults who chose to be here; the whole point is that the feedback is
  honest rather than motivating.
- **Telemetry, analytics, crash reporting.** The no-outbound-traffic claim in `SECURITY.md` is
  verifiable and must stay that way. The one exception, and the shape any future outbound
  feature has to take: the update check is a **button**, plus a **daily poll that ships off**,
  it sends the version and nothing else, and it is named in `SECURITY.md` with a procedure for
  catching it lying. An unconditional ping, an install identifier, or anything counted per user
  is still declined.
- **A required cloud service** for any core loop.
- **Anything that makes the app lie about mastery**: inflating an estimate, hiding a failure,
  softening a wrong answer into a right one.

## Setup

```bash
npm install
npm run dev
```

Three dependencies ship native code (`better-sqlite3`, `@napi-rs/canvas` and the
`sqlite-vec` extension), and `npm install` normally takes a prebuilt binary for
your platform and Node version. Only `better-sqlite3` can fall back to compiling
from source (an unusual platform, a Node its prebuild does not cover), and then
you need a C++ toolchain for node-gyp: build-essential and python3 on Linux, the
Xcode command line tools on macOS, Visual Studio Build Tools on Windows. The other
two come only as per-platform packages and have no source build: without
`sqlite-vec` the app runs with semantic search off (keyword search still works),
but `@napi-rs/canvas` draws the app's icons, so the server does not start on a
platform it publishes no binary for.

Vite on 5173, Express on 3001. A new library opens on the welcome screen; connect a model there
(any OpenAI-compatible endpoint, such as OpenRouter, OpenAI, llama.cpp or LM Studio, or Ollama),
or press *Set up later*. `npm test` needs no model. One hard requirement: when the model is
unreachable the app degrades to less, never to a broken screen, so saved courses, lessons,
questions and flashcards still open.

For a production-shaped run: `npm run standalone` (builds, then serves the SPA and API from a
single origin on 3001).

### Several branches at once

Each branch can have its own checkout, a git worktree, with its own dev servers:

```bash
git fetch origin
git worktree add --no-track -b my-fix ../terramentor-my-fix origin/main
cd ../terramentor-my-fix
npm run setup:worktree    # own ports, a scratch library, npm ci
npm run dev               # prints its own ports; the page is on VITE_PORT
```

`setup:worktree` writes the worktree's `.env`: a `PORT` and `VITE_PORT` derived from the
folder's path and checked free, and a `DATA_DIR` inside the worktree, so a dev server started
there never opens your everyday library. Vite's `/api` proxy follows `PORT`, and `npm run dev`
stops both halves if the server cannot start, so a page never ends up talking to some other
checkout's server. A `.env` you wrote yourself is left alone; `--refresh` picks new ports and
keeps whatever you added below the generated lines. Untracked files you want in every worktree
(your own notes, editor settings) go in a `.worktreeinclude` in the main checkout, one path per
line, a file or a folder; a `.env` or `.certs` there is never copied. T3 Code runs the same setup
by itself for a thread started in a new worktree (`t3.json`).

## Before you open a PR

```bash
npm test                            # every guard suite; prints the live per-suite counts
npm run check                       # frontend types (tsc --noEmit)
node --check server/app.js          # and each server file you touched
```

`npm test` is exactly what CI runs on your pull request, on Node 22 and 24 on Linux and on
Node 24 on Windows. Nothing in it calls a model or the network: each suite drives the real
modules against a scratch database or a stub, so it runs the same way on your machine as on
a runner. If you write a guard that reads a file and compares it to something built, compare
the CONTENT and normalise `\r\n` first: `.gitattributes` checks text out with CRLF on
Windows, so a byte comparison goes red on a Windows checkout while CI stays green.
`npm run test:quick` skips the four jsdom harnesses if you want the fast half.

The suite asks a little more of Node than the app does: the app runs on the `engines` floor in
`package.json` (22.19), while `jsdom`, which only the tests load, declares 22.22.2 or 24.15 and
later. Use a current 22 or 24 (`.nvmrc` says 22) and `npm ci` will not warn.

Six tools work on your own library rather than a fixture, so `npm test` does not run them
(the list is in the header of `tools/run-gates.mjs`). Run the ones that cover what you
touched. Two of them also call a model (`feed-regen` the one configured in the app,
`quiz-audit` the endpoint named in its `AI_*` variables), and four can write to the
library, so stop the server before any of those and read the tool's header first:

```bash
node tools/leaf-invariant.mjs       # tree and progress counts, recounted independently (read-only)
node tools/feed-audit.mjs           # scores cached feed content against the quality rules (read-only)
node tools/feed-regen.mjs           # rebuilds chosen topics' cached lessons (model; writes)
node tools/quiz-audit.mjs           # re-checks saved questions, --repair rewrites them (model; writes with --repair)
node tools/fsrs-optimize.mjs        # fits FSRS parameters to your reviews (writes with --write)
node tools/anki-refresh-text.mjs    # refreshes imported card text in place (writes with --write)
```

Frontend changes also want the advisory linters. They report findings for a human to judge
rather than passing or failing, which is why CI does not gate on them:

```bash
node tools/contrast-audit.mjs       # WCAG AA/AAA, light + dark
node tools/style-lint.mjs           # hardcoded colours, accent misuse
node tools/a11y-lint.mjs            # keyboard + screen reader
```

The `tools/*-gates.mjs` scripts are the safety net; if you add a subtle invariant, add a check
to one of them. A new `*-gates.mjs` file is picked up by `npm test` automatically.

## House style

- **Match the surrounding code.** Comment density here is higher than most projects because the
  comments record *why*: the constraint a shape satisfies, the alternative that was considered
  and what ruled it out. A comment explaining what a line does is noise; a comment explaining
  why it must be that way is the point.
- **Colour comes from the theme.** Use the `accent` Tailwind colour; it is driven by a CSS
  variable and is per-project, where a fixed palette colour would ignore the learner's choice.
- **Input capability is not a width breakpoint.** Use the `can-hover:` / `touch:` variants and
  the helpers in `src/utils/platform.ts`. A phone held sideways clears `sm:`.
- **Dates are `YYYY-MM-DD`, parsed as UTC midnight**, and date maths stays in UTC; the reason
  is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#4-data-model).
- **A route goes in its area's file in `server/routes/`**, registered as `app.get(...)` on the
  file's `routeTable` and inside one of its exported blocks. A new area is a new file plus an
  import and a `mount(...)` line in `createApp` (`server/app.js`), placed where its order
  matters: Express answers in registration order, so a static path must come before a
  `:param` that matches it. `tools/route-table-gates.mjs` catches a file that is never
  mounted, a route above the password check, and a route an earlier one answers first.
- **Commits**: short subject (≤70 chars), imperative, one logical change. Split bundled work by
  file, never by editing files to shape a commit.
- **The author is a person.** Use whatever tools you like, agents included, and say so in the
  pull request as asked above. But strip the `Co-Authored-By: Claude`-style trailers some of
  them append. GitHub builds its contributor list from those trailers and links a name to a profile only when
  the email belongs to a real account, so an agent's no-reply address shows up as an unclickable
  name with no commits behind it, or, when someone happens to have registered that address,
  credits a stranger who had nothing to do with the change. Authorship records who is answerable
  for the code. Run `npm run hooks` once and a `commit-msg` hook strips them for you; CI
  (`tools/no-ai-attribution.mjs`) fails a PR that carries them.

## What is genuinely wanted

- **Search providers.** The smallest useful contribution: a few lines of JSON, and a one-line
  pull request to add a built-in. Adding one to your own copy needs nothing; for a pull request
  that changes only a manifest, you may skip the CLA by saying so in it (`CLA.md`, "Add a search
  provider"). See `docs/SEARCH_PROVIDERS.md`.
- **Language support.** Adding a language to `server/language.js` (closer patterns, refusal
  patterns in `server/paper.js`) is contained, high-value, and verifiable with
  `tools/language-gates.mjs`. A native speaker's eye is the scarce input.
- **Breaking the quality gates.** If you can produce feed content that is wrong and passes
  `server/feedQuality.js`, that is a valuable bug report even without a fix.
- **Packaging**: a signed desktop build (see `ROADMAP.md`). The install barrier is the single
  biggest problem the project has.

## Releasing (maintainer)

Three channels, and no infrastructure beyond what GitHub gives you:

- **`main`** is green at all times; CI runs the full guard suite on every push and pull
  request, on Node 22 and 24. This is the contributor channel.
- **Nightly** is `main` published as a GitHub prerelease named `X.Y.Z-nightly.YYYYMMDD.N` by
  `.github/workflows/nightly.yml`. Every hour it checks two things: `main` has commits the last
  nightly lacks, and that nightly is at least six hours old. When both hold, it publishes.
  X.Y.Z is the next minor after the newest stable tag, or `package.json`'s version when that is
  further ahead. The image is tagged `nightly`, never `latest`, and only installs set to the
  Nightly update channel are offered it. A commit whose nightly failed is not retried every
  hour; the next commit is. Run the workflow by hand with **nightly** to skip the six-hour wait
  or to retry a failed commit; `node tools/release.mjs plan` prints what the next scheduled run
  would do. GitHub turns a public repository's schedules off after 60 days without activity,
  so after a quiet spell, re-enable the workflow in the Actions tab.
- **Stable** is what the README tells a stranger to install, and what the in-app update check
  offers by default.

To cut a stable release:

1. Pick the number by one rule: if the release adds a capability or migrates the database it
   is a **minor**, and if it is fixes only it is a **patch**. Nothing derives this for you, so
   the argument to have is about the database, not about the digit.
2. Add the `CHANGELOG.md` section by hand: the heading, then **one line**: a bold headline and
   a sentence. If the release migrates the database, end that line with **Database:** and say
   whether the change can be undone. That is what tells someone whether it is safe to update.
3. Bump `version` in `package.json` to match, in the same pull request as the changelog line.
   CI **fails a release that disagrees with it**, because an app that reports one version while
   the update check compares another leaves every install believing it is permanently out of
   date.
4. Read `README.md` and `docs/` against the app this release ships: every claim, every button
   name, every screenshot and clip. Fix wrong text and re-shoot stale media in the same pull
   request, or in one merged before the release is announced. Nightlies get the same pass
   before a stable is promoted from them.
5. Once that pull request is merged, let a nightly build it (the next scheduled one, or run
   **Nightly** by hand with **nightly**) and try that build.
6. Run **Nightly** by hand with **stable**. It releases the commit of the latest nightly, not
   `main`'s head, so work merged since does not ride along. It rebuilds that commit, because
   the version is part of the build. When `package.json` at that commit is not newer than the
   latest stable tag, or `CHANGELOG.md` there has no section for it, it refuses and names the
   step that is missing. It also refuses when the release pipeline itself
   (`.github/workflows/release.yml`, `tools/release.mjs`, `tools/lib/releaseChannel.mjs`)
   changed on `main` after that nightly, because the workflow from `main` would run the older
   script; let a nightly of the current `main` build (or run **Nightly** by hand), then promote.

`.github/workflows/release.yml` then runs the gates, publishes the container image to GHCR for
amd64 and arm64, and opens the GitHub Release with that changelog section as its body. Beside
the zips it attaches `SHA256SUMS` and `manifest.json`: for each platform, the zip's URL, size
and SHA-256, which is what an updater checks a download against. The release is created as a
draft and made public only once every attached file matches the one built, and the image tags
that move (`latest` and the minor line, or `nightly`) move last.

Pushing a tag by hand (`git tag v1.2.0 && git push origin v1.2.0`) still releases exactly that
commit, for the day the commit to ship is not a nightly's. Every release path refuses a commit
that is not on `main`. A hotfix tagged on an older line (1.2.1 after 1.3.0) is published but
does not become Latest or move the `latest` image. A pull request that changes the release
workflows or the packaging runs all of `release.yml` and publishes nothing.

**A prerelease is how a release stays off the stable channel.** A nightly, or a tag with a
suffix (`v1.3.0-rc.1`), is flagged as a prerelease, which means GitHub's `/releases/latest`
skips it. That endpoint is what the Stable channel's check reads, so a prerelease is published
and installable without being *offered* to a stable install, and it does not move the `latest`
image tag either. The Nightly channel offers nightlies and stable releases only: a release
candidate sorts above every nightly of its version, so an install that took one would never be
offered those nightlies.

**Version numbers.** Semver. A **minor** bump may migrate the database, a **patch** never does,
and the `CHANGELOG.md` entry says which. 1.0.0 is the first public release, and what it settles is
the shape of the things a learner's data lives in: the library and its forward-only migrations,
the export format, Anki import and export, the environment variable names and the compose file.
Breaking one of those costs a major. The HTTP API the frontend talks to is internal and is not
part of that promise.

Nothing below 1.0.0 was ever tagged. `CHANGELOG.md` keeps those versions under **Before 1.0**
as a record of what the program could do, in the order it learned to do it — history, not
something to regenerate.

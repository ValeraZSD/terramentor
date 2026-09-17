# Add-ons — the design, and what "extend the app" can honestly mean

**Nothing in this document is implemented.** It exists so the shape is
decided before the first piece is written, and so a contributor can see *why* a proposed add-on
is a yes or a no before building it.

What *is* built is [search providers](SEARCH_PROVIDERS.md): a list of places the app can send
you to research a topic yourself. Those are pure data and point *out* of the app. An add-on, in
the sense this document uses, **changes how the app behaves** — and it is meant to be written and
shared by the community, not by this project, which is a bigger promise and needs the constraint
below before any of it exists.

---

## What people will ask for, and the answer to each

The requests, in the words they arrive in, and where each one lands. The rest of the document is
the reasoning; this table is the decision.

| the ask | can it be done safely? | how |
|---|---|---|
| "a different theme" | **yes, fully** | data: the app's own colour ladder (12 RGB triplets, an accent, a light/dark axis). No CSS. |
| "change the interface" | **partly** | layout *options* the host already offers (rail order, hidden tabs, density, default views) as declared switches. Not arbitrary CSS or markup — see *what an add-on can never do*. |
| "a different course structure" | **yes, fully** | data: a course template (a curriculum skeleton), a deck, a drill bank, a question bank — the import formats that already exist, minus progress. |
| "different scheduling / feed / mastery behaviour" | **yes, as a bounded policy** | first as configuration bundled and named; where a real algorithm is wanted, pure logic in an isolate with no I/O, whose output the host re-validates. |
| "a new kind of card, minigame, view or practice format" | **yes** | sandboxed UI: an HTML document in the same `<iframe sandbox>` + CSP the widget pipeline already runs, talking to the host over a narrow, capability-gated message API. |
| "new features that change the app substantially" | **yes — inside those boxes; never outside them** | anything expressible as the rows above, composed. An add-on may add a screen, a card face, a policy and a theme at once. |
| "run my code in the app / on the server / reach the network" | **no, and not later either** | this is the one line. See the next section. |

"Substantial" therefore means: **a plugin can add and replace what the learner sees and how the
engine decides, as long as it does so through a boundary the host enforces.** It cannot become
part of the host. That is not a limitation waiting for a later version; it is what makes the app
worth installing add-ons into.

---

## The constraint everything follows from

This app's core promise is that a learner's data never leaves their machine, and `SECURITY.md`
makes that claim **falsifiable with a packet capture**. Any extension system that can break that
promise destroys it for everyone, not just for the person who installed the add-on — because the
claim is about the app, and "it's safe unless you installed something" is not a claim anyone can
verify.

That rules out the dominant extension model. Obsidian's own documentation concedes it *cannot*
restrict plugin permissions — plugins inherit the host's full privileges, including arbitrary
filesystem access and command execution — and 2026 saw that ecosystem used to deliver real
malware. VS Code is the same shape. Both are excellent products; neither makes the promise this
one does.

A community-managed catalogue makes this sharper, not softer. Nobody reviews a bundle, and a
review that did happen is not a security mechanism — it is a reading. **The sandbox is the
security mechanism**; review is for quality. So every design decision below asks one question:
*if this add-on is written by someone who wants to hurt the person installing it, what is the
worst it can do?* — and the answer must be "waste their time".

---

## Where code may run

There are exactly three places an add-on's code could execute, and they have three different
safety stories. Everything else in this document is arranged around them.

**1. In the host — the page's own origin, or the Node process.** The Obsidian model. Full DOM,
full `fetch`, the database, the filesystem. Cannot be made safe by review, signing, permissions
prompts or a CSP, because the code is *us* once it runs. **Never.**

**2. In a sandboxed iframe.** `<iframe sandbox="allow-scripts">` gives the document an opaque
origin (no cookies, no storage, no access to the parent), and an injected
`Content-Security-Policy: default-src 'none'; img-src data:` closes every outbound channel — no
`fetch`, no `<img src=https://…>`, no font, no WebSocket, no form submit. The only door is
`postMessage` to the parent, and the parent decides what it answers. **This already exists**:
`src/components/visuals/renderWidget.ts` builds exactly this document for every ```widget, probes
it in a hidden frame before showing it, and posts theme changes into it while it runs. An add-on
that ships UI ships that HTML directly instead of having a model write it.

**3. In an isolate with no I/O at all.** For logic rather than UI — a scheduling policy, a feed
mix, a card transform — the add-on is a pure function: data in, data out, no DOM, no clock it did
not receive as an argument, no way to reach anything. The candidate mechanism is a WASM build of
QuickJS (`quickjs-emscripten` is the known one; **not yet measured here**) with a memory cap and
an interrupt budget, or a `worker_thread` given no module loader. Node's own `vm` module is
**not** a candidate — its documentation says it is not a security boundary, and it is right. The
host calls the function, times it, clamps and validates the result exactly as it clamps
hand-edited settings today (`FEED_BOUNDS` in `server/feed.js` is the pattern), and uses it or
falls back to the built-in.

Two things follow from this list. **An add-on that needs the network needs place 1 and does not
get built.** And **the surfaces an add-on can occupy are enumerated by the host**, one at a time,
each with a contract — there is no "hook into anything" API, because a hook into anything is
place 1 with extra steps.

---

## The tiers, revised

| Tier | What it is | Runs code? | Where | Status |
|---|---|:---:|---|---|
| **0** | **Declarative.** A manifest names *what*; the host does *how*. Themes, layout switches, resource types, search providers. | no | — | mechanism exists (`search_provider` is its only kind) |
| **1** | **Content packs.** Course templates, decks, drill banks, question banks, rubric sets, a tutor *voice*. | no | — | formats exist (import paths, ```drill); no packaging |
| **2** | **Sandboxed UI.** A card face, a practice format, a panel or tab, a visual renderer. | yes | place 2 (iframe + CSP) | sandbox exists (widgets); no add-on loader, no message API beyond theme/size |
| **3** | **Policies.** A pure function in a host-defined slot: scheduling, feed mix, mastery threshold, card transforms, import mappers. | yes | place 3 (isolate) | not built; needs the isolate dependency |
| — | **Host code.** Filesystem, network, the process. | yes | place 1 | **deliberately never built** |

**Start at the lowest tier that can express the add-on.** "Let me use Google instead of YouTube"
needed no code, and giving it code would have been the mistake. "A different mastery threshold"
is a setting, not a policy. "A card face that draws pitch accent" is a sandbox, not a policy.
Reach for Tier 3 only when the behaviour cannot be written as configuration.

---

## The manifest

One file, `addon.json`, at the root of a folder or a zip. One manifest may declare several
**parts** of different kinds — a subject pack for Japanese might ship a theme, a kana drill bank,
a card face that renders pitch accent, and a search provider for Jisho, and it is one install.

```json
{
  "id": "kana-kit",
  "name": "Kana kit",
  "version": "1.2.0",
  "description": "Hiragana and katakana: drills, a card face with pitch accent, a sepia theme.",
  "author": "someone",
  "license": "MIT",
  "homepage": "https://github.com/someone/kana-kit",
  "minApp": "0.9.0",
  "parts": [
    { "kind": "theme",          "file": "theme.json" },
    { "kind": "drill_bank",     "file": "drills/hiragana.json" },
    { "kind": "card_face",      "file": "faces/pitch.html", "capabilities": ["read:card"] },
    { "kind": "search_provider","file": "providers/jisho.json" }
  ],
  "files": {
    "theme.json":            "sha256-…",
    "drills/hiragana.json":  "sha256-…",
    "faces/pitch.html":      "sha256-…",
    "providers/jisho.json":  "sha256-…"
  }
}
```

Rules, each of which is a gate assertion the day it is built:

- **Every file is hashed, and the manifest is hashed.** What was reviewed is what runs; an
  install whose bytes do not match its manifest is refused before anything is read. A registry
  entry names the manifest hash, so "version 1.2.0" cannot quietly mean two different things.
- **Unknown fields are rejected, not ignored.** A permissive validator is how a declarative tier
  stops being declarative — the same rule `validateManifest` in `server/searchProviders.js`
  already applies.
- **`id` is `[a-z0-9-]`, ≤40, and namespaced by the registry** it came from (`community/kana-kit`),
  so two people cannot ship the same id and one silently replaces the other on update. A local
  install (a folder on disk) is `local/…`.
- **Capabilities are declared per part, granted at install, shown in words** ("This card face can
  read the card it is drawing. It cannot read anything else."). A part that declares none gets
  none. There is no capability for the network, in any form, so none can be asked for.
- **`minApp`** is the only versioning the host honours; the add-on's own `version` is for the
  learner and the registry, and the host never parses it for behaviour.
- **No credentials, ever.** A manifest is stored in plain text and printed in Settings.

Stored in one table, `addons` (`id`, `version`, `manifest`, `files` as a blob store keyed by
hash, `enabled`, `granted` capabilities, `builtin`, `installed_at`, `source` = registry URL or
`local`). `search_providers` stays where it is — it predates this and works; a search-provider
*part* in an add-on is written through the same `saveProvider`, owned by the add-on and removed
with it.

---

## Capabilities

The whole of what an add-on may ask the host for. Short on purpose; each row is a real message
type on the `postMessage` channel (Tier 2) or an argument the isolate receives (Tier 3), and each
is enforced **in the host**, never inside the sandbox.

| capability | grants | notes |
|---|---|---|
| `read:card` | the flashcard being drawn (front, back, extra, media refs, FSRS state) | a card face; the media arrives as blob URLs the host mints, never as paths |
| `read:node` | the topic in view (title, overview, material, resources, mastery summary) | a panel or practice format |
| `read:mastery` | the mastery record of the topics in scope | never the whole library; scope = the current project unless `read:library` |
| `read:library` | project list, topic tree, deck counters | the atlas-shaped read; heavy, shown as a separate grant |
| `read:settings:<key>` | one named setting | key must be on a public list; auth and AI-endpoint keys are not on it |
| `write:evidence` | record a mastery observation for a node in scope | goes through `updateMasteryFromAttempt` with its validation; evidence carries `source: addon:<id>`, so it can be withdrawn on uninstall |
| `write:review` | rate a flashcard | goes through the same `PUT` the review screen uses; `review_log.source = addon:<id>` |
| `write:settings:<key>` | change one named setting | the assistant's whitelist (`theme`, `accent_color`, `ui_scale`, `week_start_day`) is the model — visible instantly, undone in one tap; nothing that changes what the engine measures |
| `storage` | a per-add-on key/value store, capped (256 KB), on the host's SQLite | the sandbox has no storage of its own by design; this is the only place its state survives a reload |
| `ui:panel` / `ui:card_face` / `ui:practice` / `ui:visual` | the surface the part occupies | a surface, not a permission — listed so the install dialog can say *where* the add-on will appear |

Deliberately absent, and each absence is a decision: **no `fetch` and no `open:url`** (a link an
add-on wants the learner to follow is data in its manifest, rendered by the host as a normal
external link with the destination printed, exactly like a search provider); **no `write:node`**
(an add-on does not edit the learner's curriculum or notes — a content pack *adds* a project the
learner can delete, it never edits one); **no `write:settings`** for the AI endpoint, the auth
gate, the mastery gate mode, FSRS/BKT parameters or the daily limits; **no clipboard, no
notifications, no fullscreen**; **no access to another add-on**.

`PUT /api/settings/:key` today accepts any key from any same-origin caller. That is fine for the
app's own screens and wrong for an add-on's writes, which is why `write:settings:<key>` is a
whitelist checked in the host and not a pass-through to that endpoint.

---

## The kinds, v1

Five kinds, chosen because each one is a request that has actually been made and each maps to a
mechanism that exists. Adding a sixth is the moment to reread *where code may run*.

### `theme` (Tier 0)

The app's theme *is* twelve RGB triplets (`--c-white`, `--c-slate-50` … `--c-slate-900`), an
accent pair (`--accent-rgb`, `--accent-fg-rgb`) and an axis (`light` | `dark`), which is exactly
what `[data-theme="warm"]` and `[data-theme="black"]` set in `src/index.css`. A theme part is
that as JSON:

```json
{ "name": "Sepia", "axis": "light", "accent": "#8B5E34",
  "ladder": { "white": "250 246 239", "slate-50": "244 238 228", "...": "…", "slate-900": "33 26 20" } }
```

Validated as **numbers**: each triplet three integers 0–255, the accent a hex colour. The host
then does what it does for `warm` today — writes the variables on `<html>` — and every surface,
every visual (they read the palette live) and every widget (re-themed by message) follows. Two
things a theme part cannot do, and the second is the reason the first is refused: **no CSS**, and
therefore **no `url(...)`** — a stylesheet is a network channel (`background-image`, `@import`,
`@font-face`) and would break the packet-capture claim through the least suspicious file in the
bundle. Contrast is not a validator's job (`tools/contrast-audit.mjs` is a report, not a gate),
but the Settings preview draws the ladder against real text so the learner sees a bad one before
choosing it.

Layout switches ride on the same kind as optional booleans the host already implements (rail
order, default view, density) — a theme is "how the app looks", and a manifest naming a switch
the host does not have is rejected like any unknown field.

### `course_template`, `deck`, `drill_bank`, `question_bank` (Tier 1)

All four are formats the app already reads. A course template is the plain-JSON course the
importer takes (`normalizeImportProject` / `normalizeImportTree`, with the same repairs and the
same `warnings[]`), a deck is a `.studyvault` or `.apkg`, a drill bank is a list of `DrillSpec`
item banks keyed by topic title, a question bank is the quiz shape `finalizeQuiz` writes. A part
of these kinds **creates a project** (or attaches drills/questions to topics matched by title,
the way the material merge matches) and is otherwise inert: no code, no capability, and undo is
the delete the learner already has. Progress never ships — the export contract is unchanged.

A **tutor voice** is the one content-pack part that touches a prompt, and it is bounded on
purpose: a ≤1,500-character block appended to the *learner profile* slot of `buildNodeContext`
("explain with cooking analogies", "use Dutch exam notation", "no emoji"). It is appended, never
substituted — the system prompts, the visual rules, the notation rule and every quality gate stay
the host's — and it is shown in full on the install screen because it is prose the learner can
read. The risk it carries is persuasion, not code: a voice can make the tutor unhelpful, and the
learner sees that in the first lesson and removes it. It cannot make the tutor *act*: the
`[[open:…]]`/`[[set:…]]` markers are validated by the app against ids and a whitelist, and
rendered markdown goes through the sanitizer.

### `card_face`, `practice`, `panel`, `visual` (Tier 2 — sandboxed UI)

One HTML file, run in the widget sandbox, with the same contract a compiled widget has plus a
message API scoped by its capabilities:

- **`card_face`** replaces the front/back rendering of flashcards on a project (or on cards
  carrying a tag). Receives the card through `read:card`; reports "flip" and nothing else. The
  rating buttons, the undo, the audio chain and the keyboard remain the host's — a face that
  could rate cards could rate them wrong. Use: a pitch-accent renderer, a chess-position face, a
  chemical structure face.
- **`practice`** is a practice format the feed and the topic page can offer, the way ```drill is
  offered today: receives a topic through `read:node`, runs its own loop, and reports `{correct,
  total}` through `write:evidence` — the host writes the evidence with the add-on's id on it, and
  weighs it as a **drill** (never clears the gate's raw-assessment clause), because a sandbox's
  word about what the learner knows is a claim, not proof. Use: a typing tutor, a dictation, a
  map quiz, a listening exercise over the card's own audio.
- **`panel`** is a tab in the workspace rail or a card on the project dashboard. Receives what its
  capabilities allow and draws whatever it likes inside its frame. Use: a kanji stroke-order
  panel, a "what did I do this week" chart, a subject-specific reference sheet.
- **`visual`** is a renderer for a new fence language, so the tutor can be told about it and
  emit it. The fence body is passed in, an SVG or the rendered document comes back; the sanitizer
  and the theme adapter apply to the result like any other visual. Use: a guitar-tab renderer,
  a circuit language, a Go board.

**Every sandboxed surface is drawn with the host's own chrome around it** — a border, the
add-on's name, and the *Add-on* badge — and an add-on is never given a full-screen frame or a
frame over a dialog. This is the phishing rule: an iframe that can draw anything can draw a
convincing "enter your password" card or a fake Settings page, and the only defence that does not
depend on the learner's attention is that add-on content is always visibly add-on content.

The probe already used for widgets runs at install and on every load (a document that throws,
renders nothing or sends malformed messages is not shown), and a frame that stops answering is
frozen rather than left spinning. Message handling: the host validates every message against the
part's granted capabilities and the schema of that message type; an unknown type is dropped
silently, a known type without its capability is dropped and counted, and a part that trips the
counter is disabled with the reason shown in Settings.

### `policy` (Tier 3 — the isolate)

A pure function in a **host-defined slot**. The slots are the list, and the list is short:

| slot | receives | returns | host re-validates |
|---|---|---|---|
| `feed.mix` | the candidate queues (lessons, questions, cards, recalls — as ids and metadata, never content) and the feed settings | an ordered list of ids | every id must be a candidate; length clamped; duplicates dropped |
| `schedule.allocate` | open leaves with weights, the study days, the deadline | a date per leaf | dates inside the window, every leaf dated, monotone by position |
| `mastery.threshold` | the topic's evidence summary and the gate settings | a threshold in `[0.5, 0.99]` | clamped; the gate's raw-assessment clause is untouched |
| `card.transform` | a card's text fields | the same fields, rewritten (a furigana style, a different emphasis marker) | length caps; media refs and FSRS state are not inputs, so they cannot be outputs |
| `import.map` | one note of a foreign format the host has already parsed to fields | which fields are front / back / extra | must name fields that exist |

The isolate gets no clock, no randomness it did not receive as a seed, no host object, a memory
cap and a time budget (an overrun aborts the call, the built-in answers instead, and the add-on is
marked as having failed — three failures disable the slot). Because a policy is deterministic
over its inputs, it is **testable by the gate suite with fixtures**, which is how a contributor
proves theirs works without running the app. The isolate dependency is not added until the first
slot has a real second implementation someone wants; an unused extension point is an
unmaintained attack surface.

---

## What an add-on can never do

The list the install screen shows, and the list the gate suite asserts against a hostile bundle:

- reach the network, in any form (fetch, image, font, form, link the host does not render);
- read or write anything it was not granted, including another add-on's storage;
- edit the learner's notes, overviews or curriculum (content packs *add* a project; they never
  edit one);
- rate a card, record evidence or change a setting except through a host-validated message under
  a granted capability, stamped with its id;
- change what the engine measures (the mastery gate mode, FSRS/BKT parameters, daily limits) or
  where the model runs (the AI endpoint, the auth gate);
- draw outside its frame, cover a dialog, go full-screen, or render without the host's chrome;
- run at startup, update itself, or install anything;
- ship CSS, fonts, or a `url(...)` in any file the host reads as style;
- keep running after it is disabled (its frames are unmounted, its policies fall back to the
  built-in, its evidence stays but is tagged and can be withdrawn).

---

## Community distribution and trust

The catalogue is community-managed, so the system has to be safe with a catalogue nobody vets.
Everything above is built on that; this section is the little that remains.

**A registry is a git repository** with one folder per add-on: the manifest, the files, and an
`index.json` the app reads. Searchable, diffable, forkable, a public history for every entry, no
hosting bill, no moderation queue, no account system to defend. In-app browse reads the index;
install downloads the folder, checks every hash against the manifest, checks the manifest hash
against the index, and refuses on any mismatch. The app ships knowing the address of **one**
registry and lets the learner add others — a school's, a study group's, their own.

**Nothing about it runs unasked.** Browsing is an explicit action; install is an explicit action
with the capability list on screen; update is an explicit action showing the diff of
capabilities (a new capability on update is the one case where "update" is refused until the
learner re-approves). Startup fetches nothing — the same rule the version check follows
(`SECURITY.md`, "Check daily" is off unless you turned it on).

**Ratings** are a percentage of positive ratings with the vote count beside it, never stars, and
hidden below a floor of votes. A rating is stored where the learner chooses to send it — the
registry's issue tracker or a discussion — because a rating endpoint is an account system, and
the point of a git registry is not to have one. **Reports** are the same: "report this add-on" is
a link to the registry's issue form, prefilled with the id, version and hash, which is the
information a maintainer needs to pull an entry.

**Pulling an entry** is deleting its folder; the app shows an installed add-on whose registry
entry is gone as *withdrawn* with the reason from the commit, and offers to disable it. It does
not disable it on its own — that would be the app acting on a network answer at startup.

**What review buys** is quality, not safety, and the registry's contribution rules should say so:
a maintainer reads a manifest for what it claims to be, tries it, and rejects what does not work
or lies in its description. The sandbox is what makes that a tolerable job for a volunteer.

---

## The order to build it in

Each step is usable on its own and none of them requires the next. Costs are estimates of
effort, not measurements — there is nothing to measure yet.

1. **The `addons` table, the manifest validator, the install/enable/remove screen, and `theme`
   as the first kind.** Smallest visible win, zero risk, and it forces the manifest, the hashes
   and the Settings UI to exist. A day or two. Ship one built-in theme through it (`warm` or
   `black` re-expressed as a part) so the mechanism is exercised on every install.
2. **Content packs** (`course_template`, `deck`, `drill_bank`, `question_bank`, the tutor voice).
   Mostly plumbing over the import paths; the matching-by-title logic exists in the material
   merge. A few days.
3. **Sandboxed UI**, `card_face` first (the request with the clearest contract and the smallest
   API), then `practice`, then `panel` and `visual`. The sandbox exists; the loader, the message
   API, the capability enforcement and the chrome rule are new. A week or two, with the gate
   suite driving a hostile bundle against every message type.
4. **Policies**, only when a second implementation of a slot is genuinely wanted. The isolate
   dependency, the slot contracts, the fixtures. A week, plus measuring the isolate's overhead on
   the request path.
5. **The registry** — a repository, an index, in-app browse — after steps 1–3 have shipped and
   at least one add-on exists that is not ours. A hosted marketplace with accounts is not on this
   list.

---

## The marketplace of finished projects

Separate from add-ons and needing none of the security machinery, because a finished project is
data the importer already normalises: a completed curriculum or deck someone else built. The
export formats exist (`.studyvault`, the plain JSON course, `.apkg`), the private/public split is
a settled contract (curriculum ships, personal notes are opt-in), and `projects.uuid` +
`projects.version` already answer "is this the same course, and is it newer than mine?".

What projects need that add-ons do not:

- **A rating** — the same percentage-with-count rule as above.
- **Versioning with an upgrade path.** This is the hard part and a real feature: merging a new
  edition into a course the learner holds progress against means deciding what happens to a
  renamed topic, a deleted one, and the mastery evidence attached to it. `POST /api/import`
  deliberately always creates a *new* project today and says when a twin exists.
- **Upload and download**, which is the part that stops being local-first. Publishing is an
  outbound action the learner takes deliberately, on an artifact they can inspect first; nothing
  about it may become automatic, and nothing about it may run at startup.

Same distribution answer: a git repository of exported courses first; find out whether anyone
wants the second before building it.

---

## House rules

- **No CLA required for an add-on.** Add-ons are separate works with their own licence — the best
  place to contribute without signing anything (`CONTRIBUTING.md`).
- **No credentials, ever.** A manifest is stored in plain text.
- **Name it for what it does**, not for a brand.
- **Adding a kind or a capability is a change to this document first** and to
  `tools/addon-gates.mjs` second, and the gate must include a hostile bundle for the new thing.

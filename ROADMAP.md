# Roadmap

What is planned, what is deferred and why, and what this project will not do. If you want to
help, the "Next" list is where contributions land most easily; open an issue first so two
people do not build the same thing.

The loop itself (**Discover → Plan → Study → Prove → Remember → Repeat**) is complete.
Everything below is depth on top of a working product, not missing foundations.

---

## Next

- **More ways to answer.** A graded question is not only "pick one of four": the
  answer formats are a registry (`server/answerFormats.js`, mirrored on the client), and
  three formats that ask the learner to DO the thing shipped with it: write code in a real
  editor, graded on what the program does; put the steps of a procedure in order, graded
  locally; and work out a **number**, typed with the unit shown beside the box and never
  graded, judged against a tolerance with no model in the room, so a calculation can now
  carry an assessment instead of being asked as "pick one of four". The formats the loop
  still lacks, each one file on either side of the registry:
  **assemble**: drop tokens into slots (balance an equation, build a sentence,
  label a diagram); **speak** a sentence, transcribed locally (never the browser's
  speech API, which sends the audio to a cloud provider) and graded as a short
  answer; and a **photographed** answer that
  reuses the paper-practice grader so a sketch or a built thing can carry evidence into an
  assessment, not only practice.
- **Interface translations that a native speaker would sign.** The extraction is done: the
  chrome reads through `t()` across the interface and ships in twelve languages. But the
  locales themselves are a model's first pass, checked for missing keys, broken placeholders
  and layout overflow rather than for register or idiom. Corrections to your own language are
  the single easiest contribution here: edit one file under `src/locales/`. Two known gaps
  behind it: text the *server* writes into a response (a failure record's cause, a feed
  notice) is still English and needs a code-plus-parameters contract rather than string
  replacement, and English rewordings orphan the translations keyed to them
  (`tools/i18n-gates.mjs` reports the orphans; see [docs/I18N.md](docs/I18N.md)).
- **Engine extraction.** Pull the parts that are pure decision-making (scheduling, the
  learner model, the SRS scheduler, the language rules, the feed quality gates) into a
  package with no database import. Most server modules import `database.js`
  directly, so this is dependency injection before it is a file move. The point is that the
  honesty claims become auditable in isolation.
- **An MCP server.** Fully local (stdio, nothing leaves the machine), exposing the engine to
  agent harnesses over modules that already exist. Cheap, and it makes the competing form
  factor a client rather than a rival.
- **Harden ghost selection.** Recall questions are sampled at random from a decaying topic's
  saved quizzes. They should be difficulty-targeted, and a deliberate "cumulative review"
  launcher would make the mechanic visible instead of incidental.
- **Self-healing embeddings.** Documents indexed while no embedding model was reachable are
  marked `unavailable` and stay that way until someone presses "Re-index all". They should
  notice a model appearing.
- **Break up the two monoliths.** `server/index.js` (REST + SSE) and
  `src/components/ProjectsGrid.tsx` are the files a new contributor has the
  hardest time entering.
- **A signed desktop build.** The desktop app ships unsigned, so Windows and macOS warn on
  first launch; signing removes that for people who will not touch Docker.

---

## Deferred, with the reason

These are not "someday" items; each one is blocked on something specific, and naming it is
more useful than a wish.

- **Voice, and a two-tier answer router.** Local speech-to-text plus text-to-speech is its own
  infrastructure, and on a single-GPU machine a resident voice model competes with the model
  doing the teaching. It needs an explicit answer to "what gets evicted while you talk". The
  router (a small model answers instantly while a large one researches) additionally needs a
  cancellation story and a design for an answer that is *replaced* mid-read.
- **Bigger writes from the assistant.** It looks things up mid-answer (the web if you allow
  it, your library, one course in depth) and prepares small writes you press: a mastery check,
  one card with a preview, a note for the Inbox. Generating a whole quiz or deck from a
  conversation needs a review step that scales past one item, because a model that writes on
  a misread changes the library.
- **Video segment jumping.** The app links out to a search for every topic. Deep-linking to
  the timestamp that actually covers it needs a transcript source, and the obvious one is
  brittle to scrape.
- **Narrated lessons and a two-voice "podcast" mode.** The script is just another prompt; the
  blocker is a local speech engine good enough not to be worse than reading, plus an audio
  cache story.
- **Rendered explainer animations (Manim tier).** Needs a local Python toolchain and a
  server-side render cache, and a self-correction loop against pinned API docs.
- **Sharing courses.** The groundwork exists: content-addressed media, a portable id on every
  topic, question and card, and a course file that says which model wrote each item. What is
  still missing is updating an imported course in place when its author publishes a new
  edition, and the moderation questions sharing raises, which should not be answered in a rush.
- **End-to-end encrypted sync, and store apps.** The most-requested thing that genuinely
  cannot be done well without a server.

---

## Not doing

- **Gamification.** No streaks, no XP, no leaderboards, no notifications engineered to pull
  you back. The metric this project optimises is whether you can prove you know the material,
  and every engagement mechanic trades against it. See [CoreIdea.md](CoreIdea.md).
- **Telemetry, analytics, or crash reporting.** [SECURITY.md](SECURITY.md) tells you how to
  verify that with a packet capture rather than asking you to believe it.
- **A cloud-only version.** If a hosted deployment ever exists it will be a deployment option
  for people who cannot or will not self-host: the same product, running somewhere else, not
  a fuller one. The AGPL and the CLA exist to keep that promise checkable.

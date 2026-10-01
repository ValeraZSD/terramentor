# Roadmap

What is planned, what is deferred and why, and what this project will not do. If you want to
help, the "Next" list is where contributions land most easily; open an issue first so two
people do not build the same thing.

The loop itself (**Discover → Plan → Study → Prove → Remember → Repeat**) is complete.
Everything below is depth on top of a working product, not missing foundations.

---

## Next

- **Two more answer formats.** Each is one entry on either side of the answer-format
  registry (`server/answerFormats.js` and `src/components/answer/formats.ts`):
  - **Assemble**: drop tokens into slots, to balance an equation, build a sentence or label a
    diagram.
  - **Photograph**: answer one question of a quiz or mastery check with a photo, marked by
    the grader paper practice already uses. Paper practice already counts as evidence for a
    whole exercise; this would let a sketch or a built thing be one answer among others.

  A third, **speak** (say a sentence, graded as a short answer), waits on the local speech
  engine under *Deferred* below.
- **Native-speaker review of the translations.** The interface ships in twelve languages,
  machine-translated first and corrected where faults were found; nobody has yet read each
  one for register and idiom. Correcting your own language is the easiest contribution
  here: edit one file under `src/locales/` ([docs/I18N.md](docs/I18N.md)).
- **Translate the server's error text.** The reason inside an error the server sends (the
  detail in a failed request's message, the raw error on a failed task's record) is English
  in every language. What is already translated shows the way: a failed task's
  plain-language cause and the feed's notices come from a closed set the client translates,
  and project creation's progress lines travel as a message key plus parameters
  (`messageKey`). The errors need the same contract, not string replacement.
- **Engine extraction.** Pull the parts that are pure decision-making (scheduling, the
  learner model, the SRS scheduler, the language rules, the feed quality gates) into a
  package with no database import. Most server modules import `database.js`
  directly, so this is dependency injection before it is a file move. The point is that the
  honesty claims become auditable in isolation.
- **An MCP server.** Fully local (stdio, nothing leaves the machine), exposing the engine to
  agent harnesses over modules that already exist. Cheap, and it makes the competing form
  factor a client rather than a rival.
- **Better recall questions.** A recall question (the code calls it a *ghost question*) is
  drawn at random from a fading topic's saved quizzes. It should be picked by difficulty, and
  a "cumulative review" you can start on purpose would make the mechanic visible instead of
  incidental.
- **Self-healing embeddings.** Documents indexed while no embedding model was reachable are
  marked `unavailable` and stay that way until someone presses "Re-index all". They should
  notice a model appearing.
- **A signed desktop build.** The desktop app ships unsigned, so Windows and macOS warn on
  first launch; signing removes that for people who will not touch Docker.

---

## Deferred, with the reason

These are not "someday" items; each one is blocked on something specific, and naming it is
more useful than a wish.

- **Voice, and a two-tier answer router.** Local speech-to-text plus text-to-speech is its own
  infrastructure, and on a single-GPU machine a resident voice model competes with the model
  doing the teaching. It needs an explicit answer to "what gets evicted while you talk". A
  spoken answer format waits on the same engine: the audio must be transcribed on the
  learner's own machine, never by the browser's speech API, which sends it to a cloud
  service. The router (a small model answers instantly while a large one researches) additionally needs a
  cancellation story and a design for an answer that is *replaced* mid-read.
- **Bigger writes from the assistant.** It looks things up mid-answer (the web if you allow
  it, your library, whole documents page by page, one course in depth) and prepares small
  things you press: a mastery check, one card with a preview, a note for the Inbox, a problem
  report to check and send. Generating a whole quiz or deck from a
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
  a fuller one. The AGPL keeps that promise checkable: a modified copy offered to others over
  a network must publish its source.

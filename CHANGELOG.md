# Changelog

Every release, one line each. Versions are [semantic](https://semver.org/).
Everything below 1.0.0 predates this repository and was never tagged.

## [1.0.0] - 2026-09-17

**The first public release.** Typed answers in four more formats, questions that can carry a photograph, a turn that looks things up before it answers, a screen for the day you finish a course, a local activity log, an app icon you choose — and a desktop app that behaves like one: an icon in the notification area on Windows, no console window, start when you sign in, and a library you can keep on whichever disk has room.

## Before 1.0

The releases below happened while the project was built privately, between March and September 2026.

## [0.81.0] - 2026-09-10

**One queue, one meaning of due.** Every project gets the card panel, and whether a project is taught becomes a switch.

## [0.80.0] - 2026-09-09

**A page that keeps itself current.** Rebuild, and the window already open notices and moves onto it instead of running last week's code.

## [0.79.0] - 2026-09-09

**Answers from the live web.** Off by default and again per question: the one feature here that sends what you typed.

## [0.78.0] - 2026-09-09

**Cited answers.** An answer names the documents it drew on, resolved into the message before it is stored.

## [0.77.0] - 2026-09-09

**A step you attempt first.** Material can hide a step so you try it before you read the answer.

## [0.76.0] - 2026-09-09

**Study one topic.** The same stream, pointed at a single topic instead of the day's plan.

## [0.75.0] - 2026-09-06

**Twelve languages.** The interface speaks all of them; what you study keeps its own language.

## [0.74.0] - 2026-09-06

**A desktop app.** An in-process server and its own window, packaged per operating system.

## [0.73.0] - 2026-09-05

**An assistant that changes settings.** Four cosmetic settings it may set from the conversation, on a whitelist that excludes anything the engine measures.

## [0.72.0] - 2026-09-05

**A specialist pass for hard visuals.** Animations and sketches are authored from a plain-words brief and cached. **Database:** adds the build cache.

## [0.71.0] - 2026-09-05

**Visuals follow the theme.** Every diagram is repainted for the theme it is read in, not the one it was drawn in.

## [0.70.0] - 2026-09-05

**A plan measured in study days.** Hours per day cancelled out of its own arithmetic, so the unit is the day you study.

## [0.69.0] - 2026-09-04

**Releases, and knowing what you are running.** Version reporting, an optional update check, a bug-report builder, a published container image, and a database snapshot before any upgrade.

## [0.68.0] - 2026-09-04

**Prerequisites, removed.** Order comes from the curriculum and what you know is settled by evidence, so the dependency graph goes. **Database:** its table is dropped.

## [0.67.0] - 2026-09-03

**Authoring briefs.** Briefs you paste into a large cloud model to author a phase of material, and a merge path back in.

## [0.66.0] - 2026-09-03

**Relearning steps.** A card you get wrong comes back in minutes rather than tomorrow.

## [0.65.0] - 2026-09-02

**The FSRS optimiser.** The 21 FSRS parameters fitted to your own review log, applied only when the fit beats the defaults on reviews it never saw. Plus retention measured against prediction.

## [0.64.0] - 2026-09-02

**The review log.** One row per review, undoable, and an imported Anki deck brings its history with it.

## [0.63.0] - 2026-09-02

**Fitted BKT rates.** An assessment counts as one observation rather than N, so the order of the answers stops changing the score. Your own learning rates fitted to your evidence.

## [0.62.0] - 2026-09-01

**The app has a name.** Terramentor — chosen after a 1182-name pass.

## [0.61.0] - 2026-09-01

**One container.** No database server, no account, no API key: `docker compose up -d`.

## [0.60.0] - 2026-09-01

**Decks.** A card collection is a shape of project, structured by the deck’s own order, with the four card states and a daily new-card limit.

## [0.59.0] - 2026-09-01

**Anki export.** The exit door: a project becomes an `.apkg` you can open in Anki.

## [0.58.0] - 2026-09-01

**Anki import.** A deck arrives with its media, its scheduling history and its card templates.

## [0.57.0] - 2026-09-01

**A failure is a record.** A failed generation opens a two-layer record you can paste into an issue, instead of one line saying it failed.

## [0.56.0] - 2026-09-01

**Verifying the Boss Fight bank.** The gate’s own question bank is answer-key verified too, and an offline auditor repairs the questions already saved.

## [0.55.0] - 2026-09-01

**One calendar, one gantt.** Four date views became one scoped calendar and one scoped gantt. On a phone a gantt is a list, not a small chart.

## [0.54.0] - 2026-09-01

**FSRS-6.** A real model of memory replaces SM-2, seeded from the intervals you already earned rather than dumping the whole collection back into today. Undo on a mis-tapped rating.

## [0.53.0] - 2026-09-01

**The Atlas.** Every topic you have studied, on one map, grouped by meaning instead of by course.

## [0.52.0] - 2026-09-01

**The placement probe.** A short probe before you start, so a course does not teach you what you already know.

## [0.51.0] - 2026-09-01

**Mastery transfer.** Prove a topic in one course and the same topic in another starts with a head start — capped so it can never close a gate on its own.

## [0.50.0] - 2026-09-01

**One vector per topic.** An embedding per curriculum topic, which is what makes the library one space instead of N separate trees.

## [0.49.0] - 2026-09-01

**The browser boundary.** Three doors closed: a wildcard CORS policy that let any website read the local API, an unsanitised markdown pipeline, and an unvalidated outbound fetch.

## [0.48.0] - 2026-09-01

**A licence, a CLA and a threat model.** AGPL-3.0-or-later, a CLA, a contributing guide, and a threat model that tells you how to verify the no-telemetry claim with a packet capture.

## [0.47.0] - 2026-08-10

**Paper practice.** Work an exercise by hand, photograph it, and have the page read and marked against a rubric.

## [0.46.0] - 2026-08-10

**Add-ons, and bulk generation.** Declarative add-ons that run no code, and generating study material for many topics at once.

## [0.45.0] - 2026-08-10

**Declare a study language.** A project declares its language, and the generation prompts *and the quality gates* follow it.

## [0.44.0] - 2026-07-28

**Onboarding that teaches itself.** A first-run checklist computed from real data, and a tutorial that teaches the app through the product.

## [0.43.0] - 2026-07-28

**One assistant across every project.** For the questions that have no home in a single topic: what do I do today, what am I looking at, I am behind and what should I drop.

## [0.42.0] - 2026-07-28

**A timeline that survives a big project.** A schedule view that stays readable on a three-year plan and on a phone.

## [0.41.0] - 2026-07-28

**Capture, and the Inbox.** Keep a link, a paragraph or a photo from anywhere with `c`; it becomes a topic like any other.

## [0.40.0] - 2026-07-28

**Diagram questions, and teaching a missed answer.** A question can carry a diagram, and a missed answer can be taught in place on the way out.

## [0.39.0] - 2026-07-27

**A feed that writes ahead of you.** Lessons are appended as the generator writes them, instead of waiting for the whole thing.

## [0.38.0] - 2026-07-27

**Recovering maths from a PDF.** Formulas that a PDF’s text layer drops are recovered from the rendered page by a vision model, or by OCR.

## [0.37.0] - 2026-07-19

**Calendars and capacity.** Swipeable calendars on a phone, and pace reworked as capacity rather than a scold.

## [0.36.0] - 2026-07-19

**Knowing when a new build is ready.** The installed app notices when a newer build is waiting and offers a reload.

## [0.35.0] - 2026-07-19

**A password, if you want one.** An optional single-user password gate over every API route, off by default.

## [0.34.0] - 2026-07-19

**Four themes.** Light, warm, dark and black.

## [0.33.0] - 2026-07-19

**Overview, Material, notes.** Three tiers of content with distinct roles: a public Overview, attached Material, and private notes that only leave the device if you opt in.

## [0.32.0] - 2026-07-19

**One definition of a leaf.** The server and the client agree on what a leaf is, so every progress number agrees too.

## [0.31.0] - 2026-07-16

**The tutor can hand you a Boss Fight.** It proposes a button the app verifies, never a topic name it invented.

## [0.30.0] - 2026-07-16

**Practice drills.** The model writes an item bank; a native player runs the loop.

## [0.29.0] - 2026-07-13

**The learning feed.** The home page becomes a card stream. The algorithm decides what to study; you scroll, read, answer, rate.

## [0.28.0] - 2026-07-13

**Interactive widgets.** A second model pass compiles a spec into a sandboxed app, cached so the feed can build it before you reach it.

## [0.27.0] - 2026-07-08

**Semantic vault search.** Vault retrieval fuses keyword and vector search, and degrades to keyword alone when no embedding model answers.

## [0.26.0] - 2026-07-08

**One page across every project.** What to do today, across every project at once.

## [0.25.0] - 2026-07-08

**Generations survive a reload.** AI work runs in a background queue and survives a reload or navigating away.

## [0.24.0] - 2026-07-08

**Reading what you uploaded.** See the text the app extracted from your uploads, with character counts.

## [0.23.0] - 2026-07-06

**Any OpenAI-compatible endpoint.** Point the app at anything OpenAI-compatible instead of Ollama — llama.cpp, llama-swap, LM Studio, a hosted provider.

## [0.22.0] - 2026-07-05

**The adaptive tutor.** One adaptive prompt, the model’s reasoning shown live, and a learner profile injected into every AI context.

## [0.21.0] - 2026-07-04

**Colour that passes AA.** The configurable accent is clamped to WCAG AA contrast, in both light and dark.

## [0.20.0] - 2026-07-03

**Animations and sketches.** Animated SVG and sandboxed p5 sketches, probe-validated before they render.

## [0.19.0] - 2026-07-03

**Visuals the model writes as code.** Diagrams, charts and formulas the tutor writes as code — sanitised, and repaired automatically when a model gets one wrong.

## [0.18.0] - 2026-07-02

**The URL is the state.** Navigation is driven by the URL, so deep links, refresh and the phone back button all work.

## [0.17.0] - 2026-07-02

**Portable identity.** A portable UUID beside the integer key on projects, nodes and resources, for anything crossing a device boundary.

## [0.16.0] - 2026-06-29

**The remember loop.** Questions from decaying topics are mixed into later quizzes, and answering one resets its timer.

## [0.15.0] - 2026-06-29

**Installable as an app.** Installable as a PWA, served from a single origin over local HTTPS, reachable from a phone.

## [0.14.0] - 2026-06-26

**The Vault, skipped topics, project status.** Per-project file uploads with text extraction. Plus `skipped` as an honest third state, and archiving a project.

## [0.13.0] - 2026-06-18

**Spaced repetition.** Scheduled review, and the foreign-key and full-text-search repairs that made cascade deletes and document search work at all.

## [0.12.0] - 2026-06-17

**Resource curation.** Web search, and per-topic resources the app finds and checks.

## [0.11.0] - 2026-06-06

**The daily plan.** What to do today, generated from the schedule.

## [0.10.0] - 2026-06-06

**Mastery tracking, and the gate.** Bayesian Knowledge Tracing per topic, and completing a topic can require proof.

## [0.9.0] - 2026-06-06

**Prerequisites.** A prerequisite DAG, enforced only where it should be.

## [0.8.0] - 2026-05-16

**Insights and the study dashboard.** Structured insights, and somewhere to see them.

## [0.7.0] - 2026-05-14

**Scheduling.** Set a deadline and study hours; time is allocated across the tree.

## [0.6.0] - 2026-04-06

**Agentic web search.** A search pipeline the model drives, with streaming progress.

## [0.5.0] - 2026-04-04

**The AI writes the curriculum.** Describe a subject and get a phased tree of topics, streamed and cancellable.

## [0.4.0] - 2026-04-03

**Settings, and taking a project with you.** A real settings page, and project import/export.

## [0.3.0] - 2026-03-31

**Quizzes and flashcards.** Both, with AI-checked answers.

## [0.2.0] - 2026-03-23

**Local AI and retrieval.** A local Ollama model, and retrieval over your own material.

## [0.1.0] - 2026-03-17

**The tree.** Projects and a recursive topic tree, drag-and-drop, search.

[1.0.0]: https://github.com/ValeraZSD/terramentor/releases/tag/v1.0.0

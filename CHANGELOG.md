# Changelog

Every release, one line each. Versions are [semantic](https://semver.org/).
Nothing below 1.0.0 was ever tagged.

## [1.0.0] - 2026-09-24

**The first public release.** Typed answers in four more formats, questions that can carry a photograph, a turn that looks things up before it answers, a screen for the day you finish a course, a local activity log, an app icon you choose, and a desktop app that behaves like one: an icon in the notification area on Windows, no console window, start when you sign in, and a library you can keep on whichever disk has room.

## Before 1.0

The releases below happened while the project was built privately, between March and September 2026, and in the days between the repository going public and its announcement.

## [0.99.0] - 2026-09-24

**Fixes before the announcement.** A tutor already open on one device follows a turn started on another; a drill keeps your last full round after a reload, stops its timer bar where you answered and no longer jumps as you answer; a saved question whose answer key cannot be graded is never asked and never counted in a score; a Word or Excel upload is bounded while it is unzipped, like every other archive; and a replay recorded as a video starts and ends on a still frame. From an outside audit: an upgrade that is retried after failing half-way keeps the snapshot taken before the first attempt, a course bundle puts each document back on its own topic even when two topics share a title, and the guard on outbound fetches blocks the whole IPv6 link-local range.

## [0.98.0] - 2026-09-24

**Every question and card has an identity.** Each one gets an id that travels in a course file, the groundwork for updating an imported course in place, and a course file says which model wrote each question and card, a mark an import keeps. **Database:** adds the card id and stamps existing questions and cards.

## [0.97.0] - 2026-09-24

**The assistant can act, when you press.** It reads one course in depth (progress, pace, the open topics in order, recent scores) and prepares three things for you to press: a topic’s mastery check, a card shown as a preview before it is added, and a note saved to the Inbox. On a finished topic the check is a retake that keeps the topic finished and its date. Undo on a card it added removes the card only while you have not studied it.

## [0.96.0] - 2026-09-23

**The atlas makes GIFs, and fixes from a second audit.** A course's replay renders as a GIF as well as a video, for a README or a chat where a video needs a player; the planet follows a replay from its first step instead of sometimes standing still; a PowerPoint file that lies about its size is refused instead of filling memory, a web page that sends its text slowly is dropped after 15 seconds, a second device stops retrying a turn it cannot reach after three tries, the thinking slider keeps the stop you let go on, and the atlas counts a course's topics rather than its section headings.

## [0.95.0] - 2026-09-23

**The assistant follows you between devices.** Open it on a second device while an answer is being written and the answer streams there too, reasoning and lookups included; links in an answer take the readable shade of your accent on every page colour, and the assistant's mark follows the Detailed or Simple icon you chose.

## [0.94.0] - 2026-09-23

**Settings, tidied.** The theme cards and the size slider span their card, a page colour chip shows the page it gives, and every other control is as wide as its label: a deck's Study button sits beside its counts, and Import and Export are two rows instead of two cards. Every tickbox takes a click on the box itself, the table of machines that serve a model lists each provider once, and the security messages are in your language.

## [0.93.0] - 2026-09-23

**Molecules draw themselves atom by atom.** A structure grows outward from one atom and each letter appears as its bond arrives, instead of a bare skeleton followed by every label at once; a chart of a single function or a simulation is drawn in your accent colour.

## [0.92.0] - 2026-09-22

**Fixes from a whole-repo audit.** The deadline suggested for an imported deck no longer counts its stages as topics, one damaged saved quiz no longer stops recall cards everywhere, a question saved without an answer key is no longer asked, and the desktop status check, which answers before the password, no longer names the library’s folder.

## [0.91.1] - 2026-09-22

**Exporting a course in any alphabet.** A project whose name is written in Cyrillic, kana or anything else outside the Latin alphabet now exports; it failed on a header the app built out of that name.

## [0.91.0] - 2026-09-22

**Answering from the web is one switch.** On or off, instead of a setting plus a second permission beside the question; the model decides mid-answer what to look up, and each lookup is shown where it happened.

## [0.90.0] - 2026-09-22

**Settings in plain words.** No shouted labels, long prose behind two disclosures instead of seven, and every control beside its label or under it rather than half-way.

## [0.89.0] - 2026-09-22

**The page colour reaches dark mode.** A colour chosen for the page tints a dark theme the way it already tinted a light one — every swatch but black and white painted the same stock grey-blue there, so the choice did nothing. The swatches are dressed for the mode you are choosing in, and a project's own colour stays readable as text on every one of them. An installed app's splash screen, and the strip above it, are the page and header the app really paints rather than the icon tile and a hardcoded white.

## [0.88.0] - 2026-09-21

**Hardening from the first outside audit.** A page on another port of the same machine is another origin and gets no API; an upload that declares no length is refused instead of buffered; a timestamp in the task record clears AA contrast; two circular imports are gone; the projects grid loads as its own chunk again.

## [0.87.0] - 2026-09-21

**The app icon reaches Windows.** Choosing an icon rewrites the file the notification area and every shortcut read, and that icon's menu opens on the right button alone — a right-click opened the window as well.

## [0.86.0] - 2026-09-21

**A theme is a mode and a tint.** Light or dark, then any colour; Warm and Black become two tints, an untinted page is grey rather than blue-grey, and page tint, accent and icon tile share one palette in one order, with swatches that grow to fill the row.

## [0.85.0] - 2026-09-21

**A calendar topic is drawn once.** A scheduled topic appears on the first day of its span the view contains rather than on every day, and the project legend shows each name in full.

## [0.84.0] - 2026-09-21

**Study a whole course.** The same card stream pointed at one course, so it serves the next unlearned topic without you going to find it. It drops the navigation tree and its own header row to keep the home feed’s shape, and Back on a topic goes up to the course.

## [0.83.0] - 2026-09-21

**The mastery check.** The assessment is named after what it proves, everywhere including what is already stored; its question bank is titled after the topic rather than the word “Quiz” and the day it was made; and the check draws from that whole bank, never-asked questions first, with a retry as a fresh draw and a long practice quiz sat in sittings of fifteen. **Database:** a question log is added and existing evidence rows are migrated.

## [0.82.0] - 2026-09-21

**A course arrives as one file.** A `.studyvault` carries a topic’s flashcards and their audio beside its questions, so a course imports as topics that read, ask and prove in one place.

## [0.81.0] - 2026-09-21

**Material written before you need it.** A taught topic’s mastery check and its flashcards are written in the background, so the check opens instead of generating while you wait.

## [0.80.0] - 2026-09-21

**Twelve complete languages.** The 101 strings that still read in English inside every other language are translated.

## [0.79.0] - 2026-09-21

**A course replay you can keep.** The map’s replay gets its own speed, pause and region names, and will record the journey as a video without leaving the machine.

## [0.78.0] - 2026-09-21

**Settings you can read at a glance.** A vocabulary for a settings row, long prose behind a disclosure, and the endpoint list as a table with both prices and a search key that says whether it works.

## [0.77.0] - 2026-09-21

**Every background task leads somewhere.** A task chip takes you to where you started it, or opens the task’s own record when the app started it by itself, and carries its own project’s colour wherever it is shown.

## [0.76.0] - 2026-09-20

**A failed answer says so.** A chat turn that fails appears in the conversation with your question kept, instead of vanishing.

## [0.75.0] - 2026-09-20

**Settings, restructured.** Fewer walls of grey text, controls that line up, and rows that fit a phone.

## [0.74.0] - 2026-09-10

**One queue, one meaning of due.** Every project gets the card panel, and whether a project is taught becomes a switch.

## [0.73.0] - 2026-09-09

**A page that keeps itself current.** Rebuild, and the window already open notices and moves onto it instead of running last week's code.

## [0.72.0] - 2026-09-09

**Cited answers.** An answer names the documents it drew on, resolved into the message before it is stored, and it can draw on the live web too: off by default and again per question, the one feature here that sends what you typed.

## [0.71.0] - 2026-09-09

**A step you attempt first.** Material can hide a step so you try it before you read the answer.

## [0.70.0] - 2026-09-09

**Study one topic.** The same stream, pointed at a single topic instead of the day's plan.

## [0.69.0] - 2026-09-06

**Twelve languages.** The interface speaks all of them; what you study keeps its own language.

## [0.68.0] - 2026-09-06

**A desktop app.** An in-process server and its own window, packaged per operating system.

## [0.67.0] - 2026-09-05

**An assistant that changes settings.** Four cosmetic settings it may set from the conversation, on a whitelist that excludes anything the engine measures.

## [0.66.0] - 2026-09-05

**Visuals follow the theme, and hard ones get a specialist.** Every diagram is repainted for the theme it is read in, not the one it was drawn in, and animations and sketches are authored from a plain-words brief and cached. **Database:** adds the build cache.

## [0.65.0] - 2026-09-05

**A plan measured in study days.** Hours per day cancelled out of its own arithmetic, so the unit is the day you study.

## [0.64.0] - 2026-09-04

**Releases, and knowing what you are running.** Version reporting, an optional update check, a bug-report builder, a published container image, and a database snapshot before any upgrade.

## [0.63.0] - 2026-09-04

**Prerequisites, removed.** Order comes from the curriculum and what you know is settled by evidence, so the dependency graph goes. **Database:** its table is dropped.

## [0.62.0] - 2026-09-03

**Authoring briefs.** Briefs you paste into a large cloud model to author a phase of material, and a merge path back in.

## [0.61.0] - 2026-09-03

**Relearning steps.** A card you get wrong comes back in minutes rather than tomorrow.

## [0.60.0] - 2026-09-02

**The review log, and the FSRS optimiser.** One row per review, undoable, and an imported Anki deck brings its history with it. The 21 FSRS parameters are fitted to that log, applied only when the fit beats the defaults on reviews it never saw. Plus retention measured against prediction.

## [0.59.0] - 2026-09-02

**Fitted BKT rates.** An assessment counts as one observation rather than N, so the order of the answers stops changing the score. Your own learning rates fitted to your evidence.

## [0.58.0] - 2026-09-01

**The app has a name.** Terramentor, chosen after a 1182-name pass.

## [0.57.0] - 2026-09-01

**One container.** No database server, no account, no API key: `docker compose up -d`.

## [0.56.0] - 2026-09-01

**Anki, and decks.** A deck arrives with its media, its scheduling history and its card templates, and a project leaves as an `.apkg` you can open in Anki. A card collection is a shape of project, structured by the deck’s own order, with the four card states and a daily new-card limit.

## [0.55.0] - 2026-09-01

**A failure is a record.** A failed generation opens a two-layer record you can paste into an issue, instead of one line saying it failed.

## [0.54.0] - 2026-09-01

**Verifying the mastery check bank.** The gate’s own question bank is answer-key verified too, and an offline auditor repairs the questions already saved.

## [0.53.0] - 2026-09-01

**One calendar, one gantt.** Four date views became one scoped calendar and one scoped gantt. On a phone a gantt is a list, not a small chart.

## [0.52.0] - 2026-09-01

**FSRS-6.** A real model of memory replaces SM-2, seeded from the intervals you already earned rather than dumping the whole collection back into today. Undo on a mis-tapped rating.

## [0.51.0] - 2026-09-01

**The Atlas.** One vector per curriculum topic makes the library one space instead of separate trees, and the map draws it: every topic you have studied, grouped by meaning instead of by course.

## [0.50.0] - 2026-09-01

**A head start where you have earned one.** A short placement probe before you start, so a course does not teach you what you already know, and a topic proven in one course starts the same topic in another ahead, capped so it can never close a gate on its own.

## [0.49.0] - 2026-09-01

**The browser boundary.** Requests are checked by origin and host, markdown is sanitised, and outbound fetches are vetted.

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

**The tutor can hand you a mastery check.** It proposes a button the app verifies, never a topic name it invented.

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

**Any OpenAI-compatible endpoint.** Point the app at anything OpenAI-compatible instead of Ollama: llama.cpp, llama-swap, LM Studio, a hosted provider.

## [0.22.0] - 2026-07-05

**The adaptive tutor.** One adaptive prompt, the model’s reasoning shown live, and a learner profile injected into every AI context.

## [0.21.0] - 2026-07-04

**Colour that passes AA.** The configurable accent is clamped to WCAG AA contrast, in both light and dark.

## [0.20.0] - 2026-07-03

**Animations and sketches.** Animated SVG and sandboxed p5 sketches, probe-validated before they render.

## [0.19.0] - 2026-07-03

**Visuals the model writes as code.** Diagrams, charts and formulas the tutor writes as code, sanitised, and repaired automatically when a model gets one wrong.

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

**Spaced repetition.** Scheduled review, with foreign keys and full-text search over documents.

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

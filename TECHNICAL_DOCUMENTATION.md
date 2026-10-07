# Technical Documentation

A subsystem-by-subsystem reference for Terramentor.

This document is organised around **what each module owns and the invariants it
maintains**, not around an exhaustive list of every constant and parameter. An
exhaustive enumeration is the part that changes weekly, and a wrong reference
is worse than no reference. Constants are named here so you can find them;
their current values live in the code.

For the shape of the system and the reasoning behind it, read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.

---

## 1. Stack

| Layer | Choice | Why it matters |
|---|---|---|
| Frontend | React 18 + TypeScript, Vite, Tailwind, Zustand, react-router, @dnd-kit | URL-driven navigation; see §9 |
| Backend | Node + Express | One process; SSE for anything streaming |
| Database | SQLite via `better-sqlite3` | **Synchronous**: no pool, no interleaving, no read/write races |
| Vectors | `sqlite-vec` (`vec0` virtual tables) | Optional; absence degrades, never breaks |
| AI | Ollama, or any OpenAI-compatible endpoint | Optional throughout |
| Search | Wikipedia, DuckDuckGo, GitHub, SearXNG, and any hosted engine you key | See SECURITY.md for the full outbound list |

Run: `npm run dev` (Vite 5173 + Express 3001) · `npm run standalone` (build +
single-origin serve from Express; `standalone:watch` rebuilds on change) ·
`npm run desktop` / `npm run build:desktop` (the desktop window and its zips,
docs/DESKTOP.md). The run shapes and the environment variables that choose where
data lives (`DB_PATH`, `VAULT_ROOT`, `DATA_DIR`) are in ARCHITECTURE §3; every
variable the server reads is listed in `.env.example`.

---

## 2. Database

Single file `terramentor.db`, WAL mode, `foreign_keys = ON`. Where it lives is decided by
`server/paths.js`: the per-user app-data folder for the desktop app, `/data` in Docker,
`server/` in a checkout.
Schema and migrations live in `server/database.js`.

### 2.1 Tables

| Table | Holds |
|---|---|
| `projects` | A course. Colour, icon, schedule window, study days, `baseline_schedule`, `status` (`active`/`completed`/`archived`), `content_language`, `kind` (`curriculum`/`deck`), `version` (the course's edition, free text), `summary`, `insights`. |
| `nodes` | The curriculum tree (`parent_id` recursive). `title`, `description` (public Overview), `notes` (private), `status`, `is_note`, `role` (`topic`, or `pagination` for a deck's "Stage N" slices), scheduling dates, `estimated_weight`, `completed_at`, `chat_draft`. |
| `resources` | Links attached to a node. |
| `settings` | Global key/value. Every tunable lives here. |
| `chat_conversations` | The assistant's conversations: a title (the first question's first line), the topic it began on (`ON DELETE SET NULL`, a label only), `updated_at` for the list's order. |
| `chat_messages` | The assistant's messages, by `conversation_id`. Persists reasoning traces, the turn's lookups (`actions`) and what its setting changes replaced (`settings_before`). `node_id`/`project_id` are only set on rows from before conversations, until the migration files them. |
| `documents`, `document_chunks`, `documents_fts` | The Vault. FTS5 external-content index with sync triggers. |
| `vec_chunks` | sqlite-vec KNN over chunks. Lazily created; rowid = chunk id; **not a real FK**. |
| `node_embeddings`, `vec_nodes` | Topic vectors + their freshness sidecar. See §7. |
| `quizzes`, `quiz_attempts` | Saved assessments and results. |
| `question_log` | One row per question asked, behind the feed, the mastery check and the practice quiz: never-asked first, then least recently asked. |
| `answer_attempts` | One row per submitted answer set, keyed `(surface, attempt_id)`: the client makes one id per presentation and resends it on a retry, so a replay gets the stored outcome and writes nothing (`recordOnce`, `server/mastery.js`). |
| `flashcards` | FSRS-6 state (`stability`, `fsrs_difficulty`, `state`, `lapses`, `learning_steps`), kept in step with the live `next_review` (the due date), `last_interval` and `difficulty` (the 0–5 "higher = harder" value the UI shows); `ease_factor` is the SM-2 history a pre-FSRS card is migrated from. Card content beyond front/back: `extra`, `extra_front`, `media` (files in `media_files`), `generated_by`. |
| `review_log` | One row per review: rating, elapsed/scheduled days, state before, stability and difficulty before and after, `source` (`app` or `anki`), Anki's revlog id. Written by the flashcard update endpoint, removed on undo, imported with a deck. Input to `server/fsrsOptimizer.js`. |
| `node_mastery`, `mastery_evidence` | BKT state and the evidence behind it, plus transfer provenance. |
| `feed_items` | The teaching cache: `plan` / `lesson` / `question` / `practice` rows per node. UNIQUE on `(node_id, kind, seq)`. |
| `paper_attempts` | Worked-by-hand submissions and their grades. |
| `widget_builds` | Compiled sandboxed widgets, cached by spec hash. |
| `search_providers` | Declarative outbound-search manifests. |
| `study_time` | Time actually spent studying, counted by the page's study clock (`src/utils/studyTime.ts`, `src/hooks/useStudyClock.ts`): milliseconds per topic, per UTC hour, per activity (`reading`, `questions`, `cards`, `checks`, `paper`). Written by `POST /api/study-time` (`server/studyTime.js`), once per flush id (`study_time_flushes`); goes with its topic. Read by the topic panel, the project dashboard, the day's ledger and the finished-project screen. Replaced `learning_sessions`, which nothing ever wrote. |
| `activity_log` | What the app DID: model calls, background jobs, projects created or deleted. Metadata only, with no titles, prompts or model output. Ring buffer, no FKs. See §12.1. |
| `media_files` | Content-addressed store for a card's or a question's images and audio. Type sniffed by magic bytes. |
| `visual_builds` | Specialist-authored `animation`/`p5` specs, cached by brief hash + contract version (`widget_builds` is the widget half). |
| `visual_build_failures` | A widget/animation/p5 build the MODEL failed, keyed by the same hash and by model, so an unasked build is not re-run on every render (`server/visualBuilds.js`). An endpoint outage records nothing. |
| `region_names`, `region_name_failures` | The atlas's region names, keyed on the member set, and the per-model failures behind a retry. |
| `placement_probes` | The placement probe's questions and what the learner answered. |

### 2.2 Conventions that are load-bearing

**Dual identity.** `projects`, `nodes`, `resources` and `flashcards` carry an integer
`AUTOINCREMENT` PK *and* a `uuid TEXT UNIQUE`. The integer stays the internal key
for every FK, join and URL; the uuid is for boundaries only (why:
[ARCHITECTURE §4](docs/ARCHITECTURE.md#4-data-model)).
A per-table `AFTER INSERT` trigger fills any NULL uuid, so every insert path is
covered without editing call sites. **Never make uuid a FK or a join key.**

A question has no row of its own (a topic's bank is one JSON array in
`quizzes.questions`), so its `uuid` lives inside the JSON. Two triggers on
`quizzes` stamp every question the topic owns that lacks one, on insert and on
every rewrite, leaving ghost copies of other topics' questions (§4.3) alone. Because
that uuid is a question's only identity, the ask-record (`question_log`) stores it
beside the position and the draw reads it, so a bank the answer check has
rewritten keeps its memory. Import honours a file's question and card uuids; export
writes them. Guard: `node tools/item-identity-gates.mjs`.

**Leaf definition.** A leaf is a **non-note node with no non-note children**
(why notes do not count: [ARCHITECTURE §4](docs/ARCHITECTURE.md#4-data-model)).
Two mirrors must agree: `LEAF_NODE` / `OPEN_LEAF` in `server/today.js` and `isLeafNode` /
`structuralChildren` in `src/utils/tree.ts`. Guard: `tools/leaf-invariant.mjs`.

**A leaf is not automatically work.** An Anki import slices a deck into "Stage N"
leaves by card order (`nodes.role = 'pagination'`, `server/nodeRole.js`); they
carry cards and are never taught, dated or counted as topics. Everything that
counts, plans, schedules, authors or serves work uses the *work* leaf, a leaf whose
role is `topic`: `WORK_LEAF` / `OPEN_WORK_LEAF` in `server/today.js`, `isWorkLeaf`
in `src/utils/tree.ts`. `LEAF_NODE` stays the structural test.

**Node status** is a plain TEXT column, validated in the API
(`VALID_NODE_STATUSES`), not by a CHECK constraint, because SQLite cannot ALTER a
CHECK, so a new enumerated value would force a table rebuild. New enumerated
values belong in an exported constant validated at the single write path.

**Dates** follow the UTC-midnight rule in [ARCHITECTURE §4](docs/ARCHITECTURE.md#4-data-model);
the date helpers are in `src/utils/tree.ts`.

**Vector tables are not FK-reachable.** `vec_chunks` and `vec_nodes` are swept
explicitly on startup against their parent tables. `node_embeddings` *does*
cascade, which is precisely why `vec_nodes` must be swept against `nodes`
**directly**: a cascade deletes the very row a sidecar-driven sweep would have
needed.

### 2.3 The content model: three tiers, and no fourth

| Tier | Column / shape | Author | Exported |
|---|---|---|---|
| **Overview** | `nodes.description` | AI + user | Always |
| **Material** | child nodes with `is_note = 1` | Human / imported | Always |
| **My notes** | `nodes.notes` | User only, never AI | Opt-in (`includeNotes`, default off) |

The curriculum always ships; personal notes leave the device only on an explicit
opt-in. That is the marketplace-share contract. Do not add a fourth prose field.

---

## 3. Scheduling (`server/scheduling.js`)

Allocation is proportional to **leaf weight**, discounted by depth
(`DEPTH_DISCOUNT_FACTOR`, applied once per level) so a deeply-nested topic does not
out-weigh a shallow one purely by being subdivided. A user-set
`estimated_weight` overrides the computed weight.

Allocation is **phase-aware**: a top-level phase gets a contiguous slice of the
window, with a fallback path for a deadline too tight to fit them all.

Initial scheduling and recalibration **share one engine** (`allocatePhaseAware` +
`deriveParentDates` + `computeLeafWeight`). Recalibration simply runs it from
today over the still-open leaves, preserving completed items' dates.

**Pace is schedule-aware, not calendar-linear.** `expectedProgress` is the share,
counted in topics, of leaves whose `scheduled_end` is before today, not elapsed days
over total days (and not their depth-discounted weight, which decides dates only).
Actual progress is `projectProgress` from `server/progress.js`. With no leaf dated,
it falls back to the elapsed share of the window.

Notes never carry schedule dates; a startup repair strips any left by older runs.

**A project measured in cards** (`countsInCards` in `server/progress.js`: nothing
teaches it and it holds cards; client mirror `src/utils/projectShape.ts`) is
scheduled as a window only (`allocateCardWindow` dates no node). Its pace is cards
met against the share of the window's study days gone (`studyDayShare`), and where
each section falls on that line is derived on read (`cardPlan`, returned on
`GET /api/projects/:id/pace` and added to the global calendar). `removeSchedule`
is the one removal path: window, every node date and the baseline go, the study
week stays.

---

## 4. Mastery (`server/mastery.js`)

### 4.1 BKT

Standard Bayesian Knowledge Tracing. Transition (`p_T`) and slip (`p_S`) start from
`BKT_PARAMS` and are replaced by rates fitted to the learner's own history once
`server/bktOptimizer.js` accepts a fit (stored in the `bkt_params` setting; routes
`GET /api/mastery/model`, `POST /api/mastery/optimize`, `DELETE /api/mastery/params`;
Settings → Learning shows it). The **guess parameter is per question format** and is
never fitted: it is each format's `guess` in the answer-format registry
(`GUESS_BY_FORMAT` in `server/answerFormats.js`; `GUESS_BY_QUESTION_TYPE` in
`mastery.js` re-exports it). The values are quoted because they are the design, not
a tuning: true/false 0.5, multiple choice 0.25, code 0.02, and 0.05 for short answer,
fill-in, numeric and sequence. It is read from the stored row rather than from the client, because it
decides mastery, so it cannot be caller-supplied. Why it is per format:
[ARCHITECTURE §5](docs/ARCHITECTURE.md#5-the-gate-how-a-topic-closes).

`updateMasteryFromAttempt(nodeId, score, total, evidenceType, metadata)` is the
**single write path** for all evidence. `VALID_EVIDENCE_TYPES` is validated here,
not per endpoint.

**A single answer starts from 0.0; an assessment starts from `BKT_PARAMS.p_L0`.**
`getNodeMastery` inserts a new row at 0.0, and the per-question path seeds from the
stored score — so an untouched topic answering one question at a time begins at 0.0
and climbs from there one answer at a time. An assessment of
`MIN_GATE_QUESTIONS` or more takes the batch path instead, and a topic never measured
here enters it at the nominal `BKT_PARAMS.p_L0` (or its seeded prior, whichever is higher).
A non-zero start otherwise comes only from a **seeded prior** (§4.4).

Known approximation, on the per-question path alone: the first `score` of `N` answers
is treated as correct, so a short mixed attempt is order-dependent. An assessment is
one observation and one transition (`bktBatchUpdate`), which is what took the ordering
out of it. The approximation feeds the displayed estimate and the decay timer; the
completion gate does not depend on it alone.

### 4.2 The gate

`checkMasteryEligibility(nodeId, threshold, checkPass)` passes when there is
evidence **and** either:

- **(a)** BKT posterior ≥ `mastery_threshold`, **or**
- **(b)** an assessment of type `quiz` / `mastery_check` / `paper`, with at least
  `MIN_GATE_QUESTIONS` items, passed at ≥ `mastery_check_pass` raw accuracy.

`flashcard`, `drill` and `placement` evidence sharpen the estimate and refresh the
decay timer but never satisfy clause (b). Placement is excluded for a structural
reason, not a policy one: a probe asks one question per topic, so it can never be
an assessment of `MIN_GATE_QUESTIONS` items.

**Clause (a) is suspended on any SEEDED node** (transferred §7.3 or placed
§4.4) until it has `MIN_GATE_QUESTIONS` answers of its own.

Modes (`mastery_gate_mode`): `off` never gates; `advisory` lets the
learner mark done anyway; `enforced` (default for a new library) blocks `completed` without proof. **Skip is
allowed in every mode.**

The check **draws** `mastery_check_size` questions (default `DEFAULT_CHECK_SIZE`,
clamped to `MIN_CHECK_SIZE`…`MAX_CHECK_SIZE`, all in `server/questionLog.js`) from every
quiz row the topic owns: never asked first, then least
recently asked, random within a tier, so a retry asks the rest of the bank. A stored
question whose key the grader cannot read (`hasUsableKey`, mirrored on the client) is
never served, so it is never marked wrong and never counted in a score. A completed
topic's check is a retake: no Skip, and it stays completed with its original date.

### 4.3 Decay

`decayedMastery(score, lastUpdated, decayDays)` holds a score fresh through a
grace window of `decayDays`, then applies an exponential forgetting curve with
`decayDays` as the half-life. Everything derives from the one configurable
setting. `getDecayingNodes` has two modes: a broad time-cutoff net for ghost
questions (defined below), and a decayed-estimate mode for "you proved these once".

A **ghost question** is what the interface calls a *recall question*: a saved
question from a topic the learner has answered well (an estimate above one half,
from answers of their own) and not been measured on for `decay_days`. It is served
as a Recall card in the feed (`getGhostQuestions` in `server/dailyPlan.js`) or added
to a practice quiz as a review question from an earlier topic (`includeGhosts`). It
is never part of a mastery check.

### 4.4 Seeded priors (`applySeededPrior`)

Two features hand a topic an estimate the learner did not earn there: mastery
transfer (§7.3) and the placement probe (§4.5). They write their own columns
(`transferred_prior` / `placement_prior`, each with sources + timestamp) but
**`mastery_score` has exactly one author**, `applySeededPrior(nodeId, kind,
prior, sources)`:

- seeds combine with **MAX, never a sum**: two routes to "this looks familiar"
  are one belief described twice, not twice the evidence;
- withdrawing one seed falls back to the other rather than to zero;
- a node with `total_attempts > 0` is **never** re-seeded: measurement owns the
  estimate once it exists.

### 4.5 Placement probe (`server/placement.js`)

A short assessment taken **before** studying, so the feed does not teach from
zero what the learner already knows.

**Selection** is deterministic and model-free: leaves that are open and
unmeasured, apportioned across top-level phases (floor one each, then largest
remainder; when phases outnumber slots the phases are sampled evenly) and spread
*within* each phase. Capped at `MAX_PROBE_QUESTIONS`; a project with fewer
than `MIN_PROBE_CANDIDATES` is reported `too-small` as an answer, not an error. These
and the prior constants below are in `server/placement.js`.

**Propagation follows curriculum ORDER, not embedding similarity.** A course is
written easy-to-hard, so knowledge behaves roughly like a prefix of the leaf
sequence: *correct at k* implies everything at or before k, *wrong at k* implies
everything at or after k. So an unprobed topic is seeded when the **nearest probe
at or after it** was correct, and blocked when the **nearest probe at or before
it** was wrong; a conflict resolves to no seed. Similarity is deliberately not
used: inside one project it points at the successor as readily as the
prerequisite, which is why §7.3 is cross-project only.

**Propagation stops at the top-level section boundary.** The prefix model is a
claim about a *difficulty gradient*, and a section is the largest unit the engine
may assume one of: plenty of real projects are anthologies whose sections are
unrelated subjects sharing one container, and there an answer would vouch for a
different subject purely because it was asked later. So `next`/`prev` are
searched among the probes in the topic's own section only, and a section holding
no probe propagates nothing and is taught from zero, since a probe's handful of
questions cannot place a learner across every section of an anthology, and no
evidence about a subject is not evidence against it. The boundary is deliberately *not* gated on
inter-section similarity: similarity measures topical overlap, the prefix model
needs a difficulty gradient, and on real curricula the two are close to
anti-correlated: a well-ordered course covers *different* material in each
section, which is what the ordering is for. It would also make the one
model-free, assertable part of placement depend on whether an embedding model
answered.

**Priors** are `DIRECT_PRIOR` × (1 − the format's guess floor), times
`PROPAGATION_DISCOUNT` for an implied topic, clamped to `PLACEMENT_CEILING`
and dropped below `PLACEMENT_MIN_PRIOR`. A format guessable at or
above `MAX_GUESSABLE` seeds **nothing**. That is a rule, not an arithmetic
consequence, because at the current constants a correct true/false answer still
clears `PLACEMENT_MIN_PRIOR` after its discount and would otherwise buy a head start.

**Answers are graded server-side** and recorded as `placement` evidence, but do
**not** run a BKT update on top of the seed: the seed *is* that answer's
contribution, and stacking both would carry a topic near the threshold on one
question. The answer key never leaves the server with the question
(`publicProbeQuestion`); it arrives in the answer response. `discardProbe`
removes every seed (on a topic answered since, the seed goes and its answers
are replayed without it, under the learning rates in force at the time of the
discard, so the score is what they alone earn) and every evidence row, and
undoes the schedule change described in §4.6 while nothing in the project has
been closed.

Authoring uses `operation: 'authoring'` (its timeout is the `authoring` entry of
`TIMEOUTS` in `server/ai.js`) and treats a transport failure as
distinct from a bad question: it is not retried, and two consecutive ones stop
the run.

### 4.6 What a head start changes (`server/headStart.js`)

§4.4 is the half of a seed about proof: capped, suspending the BKT clause, never
closing a gate. This is the half about teaching. A topic has a **head start**
while it carries a seed (the larger of `transferred_prior` and
`placement_prior`) that the learner's own answers have not contradicted; once
they have answered there and the estimate sits below the seed, it has none.
Three readers act on it:

- **The lesson plan is a review.** `feedGen` plans it under a lower ceiling
  (`reviewParts` in `server/headStart.js`: `REVIEW_PARTS_STRONG` parts for a seed of
  at least `STRONG_HEAD_START`, which is a correct placement answer on the topic or
  a fresh proven twin; `REVIEW_PARTS` for an inferred one; never more than
  `feed_max_parts`) and tells the planner and the lesson
  writer it is a review. The ceiling is enforced as well as requested. The plan
  records what it was sized for (`meta.headStart`).
- **The mastery check comes first.** The chapter offers it above part 1
  ("Prove it now"), so a review's question bank is written straight after its
  first part instead of at the end of the stream, subject to the same
  `feed_prepare_check` switch. Once the bank exists the review is practised
  from it.
- **The schedule gives it less time.** `computeLeafWeight` multiplies a seeded
  leaf's weight by `1 − prior`, above the usual floor; a learner's own weight
  still wins. Finishing or discarding a placement re-lays the project's dates
  inside the same window, but only while nothing in it has been closed.

A plan is a cache, so a head start that arrives, leaves or is contradicted
after its topic was planned would otherwise change nothing. `planIsStale`
compares the plan's recorded ceiling with the current one and has the plan
rewritten, but only while no card of the topic has been consumed; a sequence
the learner has started keeps its length.

A seed is also not a memory: the ghost-question query (`getDecayingNodes`, and
its copy in `today.js`) only considers topics with answers of their own, since
a seeded 0.52 would otherwise produce a recall question about a topic that was
never taught.

Asserted by `tools/head-start-gates.mjs`, including the planner's prompt and
ceiling end to end against a stub model on loopback.

---

## 5. The learning feed

The home page. `server/feed.js` composes, `server/feedGen.js` generates ahead,
`server/feedQuality.js` gates.

### 5.1 Composition (`feed.js`)

`getFocusNodes()` picks what to teach: worst-pace project first, overdue oldest
first, then today's leaves; getting ahead only when nothing is due anywhere.
Capped per project and in total (`focusPerProject` / `focusTotal` in `FEED_DEFAULTS`,
overridable as the `feed_focus_per_project` and `feed_focus_total` settings).
The Inbox, and any project that holds cards and has no start-to-deadline window
(typically an imported deck), gets a **standing slot**: it is never scheduled, so a
deadline would turn "unread" into "overdue" by tomorrow, and sorting by urgency
would put it last for ever. So up to a third of the focus slots (at least one) are
reserved for standing projects and shared between them in turn.

`composeFeed({limit, excludeKeys, gate, nodeId, projectId})` is deterministic and
pages by exclude key. With no scope it is the whole library by urgency (`/`); with
`projectId` it is one course by the same urgency; with `nodeId` it is one topic or
section with the schedule ignored (`getFocusForNode`), because the learner chose
it. Card kinds: `lesson`, `question`, `flashcard`, `recall`, `checkpoint`,
`practice`, `notice`. Interleave is roughly lesson → question → … with a
flashcard every 3–4 items and a recall about every 8.

Volume caps exist because unbounded queues destroy the format:
`dueReviewsPerDay`, `newCardsPerProjectPerDay` and `recallPerBatch` in `FEED_DEFAULTS`,
plus `NODE_QUESTIONS_PER_DAY`.

**Degradation is mandatory.** Without a model the feed serves node descriptions
and note-children as reading cards, saved quiz questions, flashcards and recalls.

The response also carries `transfers` and `placements` maps keyed by node id (§7.3,
§4.5), rather than copying the payload onto every card in a chapter.

### 5.2 Generation (`feedGen.js`)

Runs on **its own serial chain**, not the tasks FIFO, and yields to any
non-feed task before every model call. Writes into `feed_items`: a `plan` outline
row first, then lesson/question rows, then one paper exercise at `PRACTICE_SEQ`.

The outline sizes itself to the topic (`MIN_PARTS`…`MAX_PARTS`); each part is
generated with the full outline plus the actual text of earlier parts, so parts
build on each other instead of re-teaching. Failures back off exponentially and
never throw.

The lesson writer (and only it) also gets the topic's place in its COURSE
(`server/courseContext.js`): `NEIGHBOURS_BEFORE` topics before and
`NEIGHBOURS_AFTER` after in course order (the tree walk, work leaves only), where
the learner stands on each ("finished 7 weeks ago", "not studied yet"), and the previous topic as the learner was shown
it (its consumed lessons, visuals stripped, else its Overview and Material),
bounded to `PREVIOUS_TOPIC_CHARS`. The block carries its own rules: orientation
only, never "as you just learned", no pre-empting the later topics, never
writing about order, dates or progress. Question, mastery-check and card
authoring stay pinned to their topic.

`feed_items` is a **cache** ([ARCHITECTURE §7](docs/ARCHITECTURE.md#7-the-quality-layer)):
the generator only fills gaps, so re-author with `tools/feed-regen.mjs`.

### 5.3 Quality gates (`feedQuality.js`)

The five gates, what each does and why they fail closed are in
[ARCHITECTURE §7](docs/ARCHITECTURE.md#7-the-quality-layer). Where each lives:

| Gate | Entry points |
|---|---|
| Mechanical | fence and script checks scoped to the project's language, ASCII-art detection, `linearCombinationFaults` (`arithmetic.js`), `stripSelfCertifyingCloser`, `scaffoldingFaults` |
| Answer-key verification | `verifyQuestion` (answers cold; open questions get an arithmetic audit instead); three failures drop the question with its reason |
| Visual coherence | verdicts `ok` / `wrong` / `text-wrong` |
| Audit of the lesson | `auditLesson` on every part: false facts, self-contradiction, conflict with earlier parts, a retraction left in the text, and arithmetic when `hasComputation` says the part computes |
| Drill and card keys | `checkItemKeys` answers each prompt cold from the set's pool of values; `vetLessonDrills` takes failed items out of a ```` ```drill ```` (`drillCheck.js`), `finalizeFlashcards` does not save a failed card |
| Paper reference solution | `generatePaperExercise` audits it with `verifyQuestion`'s open-answer mode; disputed twice means no exercise |
| Lessons stored before these checks | `pendingLessonCheck` / `recheckLesson` (`feedGen.js`), a burst tier after lesson writing: drill items fixed in place, an unread part with a false statement deleted and written again |

Weaknesses that are served with a record rather than vetoed: `keyEchoesStem`,
`keyIsLengthOutlier`, "all of the above", too many eliminable options. A rejection's
reason reaches the retry as `priorFault` (passed by `feedGen.js`), appended as a
trailing instruction.

`server/arithmetic.js` has no imports by design, so read-only tools can apply the
identical rule. Its safety property is *declining on anything it cannot fully
evaluate*.

### 5.4 Paper practice (`server/paper.js`)

One exercise per topic: `{mode, brief, materials, rubric, reference_solution}`.
The rubric has at least `MIN_GATE_QUESTIONS` points, or paper could never clear
the gate.

- **The reference solution is never on the card**: fetched only on submit or an
  explicit "mark it myself". The rubric leaks the same secret if you let it, so
  derived values are forbidden in a rubric point *and* the card keeps the rubric
  collapsed.
- **Scanning is client-side** (`src/utils/scan/warp.ts`): corner ordering →
  homography → per-mode finishing (adaptive threshold for documents; tone
  preserved for drawings, because thresholding destroys what is being marked).
- **Grading is ONE pass**: the model that sees the page marks it. A
  vision→text→grade split loses exactly what a rubric marks (which working sits
  under which question, whether a diagram is labelled). A two-stage fallback
  survives for models that fumble the combined ask.
- **The score is counted from rubric verdicts server-side**, never taken from the
  model.
- An unreadable page returns `status:'unreadable'`, records nothing and does not
  consume the card. A bad photo is not a wrong answer.

---

## 6. AI layer

### 6.1 Provider (`server/ai.js`)

One client abstraction over Ollama and OpenAI-compatible endpoints. Owns
`AI_PROMPTS`, `buildNodeContext`, `chunkText`, URL validation,
`visionAvailability` and the hybrid retrieval fusion.

`buildNodeContext` injects the **learner profile** into every AI context. Chat
surfaces additionally get the project's completed leaf titles; quiz and flashcard
generation deliberately do not: it distracts small models from the current node,
and the mastery check must stay a pure per-node assessment.

**Vision is only trusted when verified.** An OpenAI-compatible endpoint cannot be
capability-probed, and a text-only model handed an image will invent a plausible
transcription. `auto` trusts only verified vision; a failed probe must never be
cached as a definitive "no".

**Connecting a model on first run.** A new library opens on the welcome flow
(`src/components/welcome/`), whose model step can connect OpenRouter in one press
(`src/utils/openRouterConnect.ts`, `/api/ai/openrouter/start|finish`): OAuth with
PKCE, the verifier held server-side for one pending attempt (single use, expiring
after `OPENROUTER_CONNECT_TTL_MS`), and the returned key stored bound to OpenRouter's origin like a key pasted by
hand. A library that already has projects, a chosen model or a profile is marked
welcomed by a migration and never sees the flow.

### 6.2 Retrieval

`searchDocuments` (**async**; callers must `await`) fuses FTS5 keyword ranking
and sqlite-vec KNN via Reciprocal Rank Fusion (`RRF_K = 60`, keyed by chunk id).
Without vectors it silently equals plain FTS5.

Indexing (`server/embeddings.js`) runs on its own serial chain (a large PDF must
not freeze the tutor), mirrored to the TaskDock for visibility only.

**vec0 gotchas:** an INSERT rowid must be a `BigInt` (a plain number throws);
vectors bind as `Buffer.from(new Float32Array(v).buffer)`; a returned blob must be
**copied** before being viewed as a `Float32Array`, because Node's pooled buffers
have arbitrary byte offsets and a typed-array view demands 4-byte alignment; the
table dimension is fixed, so switching models drops and recreates **every** vec
table and forces a re-index.

**Lookups the model decides on** (`server/aiTools.js`). Before it answers, a turn
may make up to `MAX_CALLS_PER_TURN` calls to read-only tools: `search_web` (only
when "Let answers use the web" is on), `find_in_library` (local search over projects, topics, saved links
and documents) and `project_state` (`server/projectState.js`: one course in depth,
its progress, pace, open topics in order with their mastery, due cards and recent
scores). An OpenAI-compatible endpoint gets native `tool_calls`; one that refuses
them, and Ollama, get a short text protocol whose parser is the safety boundary.
The rounds are bounded too: at most `NATIVE_MAX_ROUNDS` with native tools, and
`MAX_ROUNDS` of up to `MAX_CALLS_PER_ROUND` calls on the text protocol, all inside
the one per-turn budget. Only pages and documents are numbered as citable sources.

**Listing and reading the library** (`server/libraryReads.js`). Three more
read-only tools: `list_documents` (every document in a project or the vault, with
its id, type, pages and size, complete or marked as capped), `read_document` (one
document in order, a bounded window at a time, by its PDF pages where the import
recorded them; citable) and `read_topic` (a topic's Overview, Material, the
learner's notes and the topics under it). Reads are capped per call and per turn.
The assistant holds all three on every turn; only the web is a setting.

**One assistant, the page decides** (`server/pageContext.js`). The client sends
where the learner is as ids; the server reads what is there. With a topic open,
the prompt carries that topic's whole context (`buildNodeContext`: Overview,
the learner's notes, subtopics, finished topics, the next topic with its id),
the card on screen and recent wrong answers, and the vault search starts with
that topic's and course's documents before the whole library. The teaching
rules (`TEACHING_RULES` in `server/ai.js`) are in every turn's prompt.

**The turn as a timeline** (`src/utils/turnTimeline.ts`). Each lookup row records
where in the turn it happened (`at`: reasoning and answer characters so far), so
the reasoning panel shows lookups made while thinking between its passes and names
them in its header, and the answer shows lookups made mid-answer between its
paragraphs. Older rows without a position draw above the answer as before.

**Writes the learner presses** (`server/assistantWrites.js`,
`src/utils/assistantWrites.ts`). The assistant never writes on its own. It may
propose a mastery check on a topic, one flashcard (shown as a preview, added by
`POST /api/assistant/cards`, deduplicated on its front), a note for the Inbox, or a
problem report that opens the app's own *Report a problem* dialog prefilled; each
appears as a button under the answer. Separately, it may change seven appearance and
locale settings at once, each with an Undo (`server/assistantSettings.js`,
`SETTABLE_KEYS`), and nothing that changes what the engine measures. Undo on an
added card removes it only while it has no review history.

It may also prepare **changes to the library**, each drawn as before → after with
an Apply button and an Undo: a course's name, icon, colour, description, status
(active, finished, archived) or daily new cards (a ```project block), a topic's
title (```topic), a web page saved on a topic (```link), and a new course, which
only fills in the New course dialog (```course). Every value is judged by one set
of rules on both sides (`server/projectFields.js`: an icon is one of the app's 64
drawings, a colour a palette name or a hex) and applied through one door
(`server/assistantEdits.js`, `POST /api/assistant/edits`), which writes only what
the preview showed (compare-and-set), records each field's before and after in
`assistant_edits`, and undoes only a field that still holds what it wrote.
**Everything prepared is checked before it is offered** (`server/assistantChecks.js`):
a card is answered cold by a second model call that never sees its back, with a
side-by-side second look when the answers differ, and a back that look rejects is
not offered or added; a page is opened once (only with web search on) and saved
under its own title, and a page that does not exist is not saved. Verdicts are
kept by content in `assistant_checks`, so a re-read pays nothing. Deletion, dates,
a course's lesson language and closing a topic are deliberately not on the list.

### 6.3 Visuals

The tutor emits fenced *specs*: `mermaid`, `vega-lite`, `plot`, `smiles`,
`animation` (SVG/SMIL), `p5` (sandboxed iframe), `drill` (minigame item bank),
`widget` (delegated: a second model pass compiles it to sandboxed HTML, cached by
spec hash), plus KaTeX math and `<TimelineEvent>` tags, which are DOM rather
than a picture so their bodies stay markdown.

Rules for adding a kind: a mechanical `sanitizeX.ts`, a `VISUAL_REPAIR_HINTS`
entry, a `VISUALS_GUIDE` line, and a renderer that **throws descriptive errors**;
that text becomes the repair prompt. Prefer a mechanical fix to a repair
round-trip. **Persist a repair wherever the visual lives**, or the model re-runs
on every page load.

Two content rules earned from real failures: **"function, not values"**: the
model must never emit numbers it computed itself, so charts of formulas use
`data.sequence` + `transform.calculate` and the engine computes the data; and
**teach a representation → show that representation**, never a flowchart *about*
the thing when the lesson needs a picture *of* the thing.

Widgets are pre-compiled by `feedGen` so the feed hits a warm cache; the feed
passes `autoBuild={false}`, so a missed pre-build shows a button, never a spinner
mid-scroll. One widget per topic.

A widget and a scene brief (`animation`/`p5`) build on the same terms
(`server/visualBuilds.js`): never while the reply holding them is still
streaming; after a FRESH reply by themselves (`auto`), unless the kind is
switched off, the model gate does not offer it, or this model already failed
this build (`visual_build_failures`) — then the block offers a button that says
why. A press is never declined. A cacheOnly lookup joins a build already running,
so a reload or a second device shows its progress rather than an offer.

### 6.3a Task origin (`server/tasks.js`)

Every background task records WHERE it came from: `origin = { surface, detail?,
job?, projectId?, nodeId?, messageId? }`, normalised to a closed vocabulary and
integer ids (`normalizeOrigin`), so no title or prompt rides on it. Requests say
it (a visual block sends its surface); jobs the app starts itself name the job
(`feed`, `index_document`, `name_regions`, …), and the feed generator moves it
from topic to topic as it works (`setOrigin`). It rides on the dock's snapshot,
on the failure record and, as one word, into the activity log. The client turns
it into a sentence and a place to open (`src/utils/taskPlace.ts`), before any
guess from the task's kind.

### 6.4 Language (`server/language.js`)

`projects.content_language` (ISO code; `''` = follow the material). Declaring
the language is what makes the quality gates enforceable: a gate written
against English fails open the moment the model writes anything else, so the
gates read the declared language and pattern their checks for it.

Traps worth knowing: a learner-reference pattern cannot be a pronoun list
(Spanish, Italian, Portuguese, Polish and Romanian are pro-drop); a script check
is structurally blind to a model reverting to English in a Latin-script project,
so there is a separate English-drift check.

---

## 7. The semantic layer

### 7.1 Topic embeddings (`server/nodeEmbeddings.js`)

One vector per non-note node, over `parent title › title` + Overview, with
curriculum numbering stripped (`server/curriculumLabel.js`). The project name is
deliberately excluded ([ARCHITECTURE §6](docs/ARCHITECTURE.md#6-the-semantic-layer)
says why).

Vectors are **unit-normalised on write and query**, so vec0's L2 distance
converts to cosine exactly (`cos = 1 − d²/2`) independently of the sqlite-vec
build, and callers get a bounded 0..1 number to threshold.

**Freshness is reconciled, not hooked.** `node_embeddings` stores a hash of the
exact text embedded *and the model that embedded it*; `syncNodeEmbeddings`
re-embeds only the drift. A clean sweep costs zero model calls, which is what
makes `scheduleNodeSync()` safe to fire from every node write (debounced, with a
max-wait so a steady write stream cannot starve it). A status change is
deliberately excluded, since it cannot move a topic in the space, and the feed writes
those constantly.

A failed batch is recorded with an **empty hash**, which no real text can
produce, so an unreachable model leaves topics pending and retried rather than
looking permanently done.

Guard: `tools/node-embedding-gates.mjs`.

### 7.2 Atlas (`server/atlas.js`)

Groups topics into **regions** by meaning, names each after its most central
topic (no model call, so the map is deterministic), lays regions out in two stages
(PCA for a starting arrangement, then `refineLayout` against the regions' real
neighbour distances), and lists cross-project **bridges** separately.

The same regions are also placed on a **sphere** for the *Terra* view
(`server/globe.js`, called from `atlas.js`): three principal components, each
axis scaled to its own span, then the same refinement with angles for distances,
and caps separated so none overlap. It costs three numbers per region on the
wire; each topic's flat offset is walked onto its cap by the client
(`src/components/atlas/GlobeMap.tsx`, `globeProjection.ts`), which also draws the
regions as territories with borders and sea (`globeTerritories.ts`). The
dot products, the power iteration and the neighbour lists both layouts use live
in `server/vectors.js`. Guard: `tools/globe-gates.mjs`.

Four things keep it bounded and honest:

- **The region threshold is derived from the library**, not hardcoded: a low
  percentile (`NN_PERCENTILE`, the 20th) of sampled nearest-neighbour similarities. A constant tuned to one
  embedding model produces one region per topic on another, which is not just an
  ugly map but **quadratic**, because leader clustering costs topics × regions.
  A low percentile is required, not the median: a topic joins only if its nearest
  neighbour clears the threshold, so the median guarantees half the library
  becomes a region of one.
- **Oversized and incoherent regions are subdivided.** Assignment places every
  topic in its *nearest* region with no floor on how near that is, which is
  correct, since a topic must be somewhere, and is also how one region becomes a
  landfill of unrelated subjects drawn as a single huge bubble. A region over
  the size cap (`REGION_SIZE_SHARE` of the library, floor `MIN_SPLIT_SIZE`) or
  whose members sit below the threshold that defined it is cut with
  **farthest-first seeding plus three Lloyd passes**. Re-running leader
  clustering at a higher threshold does *not* work: it makes the first item a
  magnet, and the landfill returns as a slightly smaller landfill plus a shower
  of singletons.
- **Two caps, for two different costs.** `MAX_SEED_REGIONS` bounds the global
  assignment (topics × seeds, twice); `MAX_REGIONS` bounds the finished map and
  can be higher because subdivision is local. Either binding sets `stats.capped`.
- **It yields to the event loop** throughout, because the process is
  single-threaded and everything else on it would stall.

Regions also carry a **layout for their own topics** (`topic.x/y`,
`region.topicRadius`): local PCA of the member vectors around their centroid,
packed inside the bubble. That is what the map zooms into.

Region **names** fall back to the medoid's title with curriculum numbering
stripped (`cleanRegionLabel`: "Module 9.5: Advanced Extensions" → "Advanced
Extensions"). The words are then the author's own; the position in one course
is exactly what the atlas has dissolved.

Above that sits `server/regionNaming.js`: a model reads every title in a region
and writes a name that covers all of them, because the medoid can only ever be
ONE member's title and a region spanning a discipline is otherwise named after
one lesson inside it. It is an enrichment, never a step in drawing: no model,
no cached name or a rejected answer leaves the map byte-identical. Names are
cached in `region_names` **by member set alone**; the model that wrote one is
recorded but is not part of the key (a name is validated prose, not a vector in
a model's own space, so switching models must not orphan the library's names).
Failures are counted per region and per model in `region_name_failures`, so a
model that cannot do the job stops being asked. `atlas_naming_model` (Settings
→ AI & Models) runs naming on a different model than chat; empty follows chat.
The learner can rename any region by hand: `PUT`/`DELETE
/api/atlas/regions/:signature/name`, stored under the same key with
`model = 'user'`, and a completed sweep or a rename invalidates the atlas
cache, or the new names would not appear until the library itself changed.

Measured on a large real library: ~1.2 s to build (0.84 s before subdivision),
~1 ms cached, worst event-loop stall under 100 ms. Cached against a signature
of the topic space (vector count, sidecar state, model).

Guard: `tools/atlas-gates.mjs` covers the degenerate libraries (one topic, all
identical/zero-variance PCA, none alike), the landfill (a chain whose ends are
unrelated), topic placement, and the label table.

### 7.3 Mastery transfer (`server/masteryTransfer.js`)

Seeds a topic's BKT **prior** from a semantically identical topic proven in
another project. The boundary *is* the design:

- **It never closes a gate**, enforced twice: `TRANSFER_CEILING` caps a seeded
  prior strictly below any sane threshold, *and* the gate's BKT clause is
  suspended until the node has `MIN_GATE_QUESTIONS` answers of its own.
- **Cross-project only.** Two similar topics inside one course are its author's
  deliberate structure, not the learner's repeated work.
- **Contributions combine with MAX, not a sum.** Two curricula covering the same
  material are the same knowledge twice.
- Each contribution is the twin's **decayed** mastery × similarity, so a head
  start withdraws itself as its source fades.
- Seeding applies only while `total_attempts = 0`. Provenance is kept afterwards
  (`spent`), because it still explains why the estimate did not start at zero.

**An answer that never arrived is never a verdict.** An empty neighbour list
means the twins cannot be *seen*, not that none qualify, so `computeTransfer`
reports `available: false`, and nothing may be withdrawn on it.

Guard: `tools/mastery-transfer-gates.mjs`.

---

## 8. API surface

All routes are under `/api` and behind the optional auth gate, except the ones that
must answer a locked app: `/auth/*` itself, the desktop launcher's status and
heartbeat (`/desktop/status`, `/desktop/ping`), and the app icon (`/icon/:name`;
`/manifest.webmanifest`, outside `/api`, is public for the same reason).
Grouped by area, paths shown without the `/api` prefix; `server/routes/` (plus
`server/desktop.js` and `server/appIcon.js`) is the exhaustive list.

Each file in `server/routes/` holds one area's routes. It records them on a
`routeTable` (`server/routes/routeTable.js`) instead of an Express app and exports
them as blocks; `createApp` in `server/app.js` mounts every block in one list,
because Express answers in registration order and that order is behaviour (a static
path registered after a `:param` that matches it is never reached). `server/app.js`
builds the app without listening; `server/index.js` binds the port and starts the
background work. `tools/route-table-gates.mjs` fails on a route file that is never
mounted, a route before the password check that is not on the public list above,
and a route an earlier one answers first.

| Area | Routes |
|---|---|
| Projects | `/projects`, `/projects/:id`, `/projects/reorder`, `/projects/:id/pace`, `/projects/:id/insights`, `/projects/:projectId/study-dashboard`, `/projects/:projectId/daily-plan`, `/projects/:projectId/completion` (+ `/seen`), `/projects/:projectId/teaching` |
| Nodes | `/projects/:projectId/nodes`, `/nodes` (POST), `/nodes/:id` (PUT/DELETE), `/nodes/:id/move`, `/nodes/:id/weight`, `/nodes/reorder`, `/nodes/labels`, `/nodes/:nodeId/resources`, `/resources`, `/resources/:id`, `/resources/reorder` |
| Scheduling | `/projects/:id/schedule` (POST/DELETE), `/projects/:id/recalibrate`, `/schedule/overview`, `/calendar` |
| Feed | `/feed` (`?projectId=` / `?nodeId=` scopes), `/feed/consume`, `/feed/items/:id`, `/projects/:projectId/ghost-questions` |
| Mastery | `/nodes/:nodeId/mastery`, `/nodes/:nodeId/mastery/quiz`, `/nodes/:nodeId/mastery/drill`, `/nodes/:nodeId/drill-scores`, `/nodes/:nodeId/mastery-check/draw`, `/projects/:projectId/mastery`, `/projects/:projectId/mastery/mastery-check`, `/mastery/model`, `/mastery/optimize`, `/mastery/params` (a card's evidence has no route; it is written on the rating path, `server/cardEvidence.js`) |
| Placement | `/placement/:projectId` (GET/DELETE), `/placement/:projectId/start`, `/placement/probe/:probeId/answer`, `/placement/probe/:probeId/finish` |
| Cards and decks | `/projects/:projectId/flashcards` (+ `/due`), `/flashcards/due`, `/ai/flashcards*`, `/projects/:projectId/deck`, `/deck/queue`, `/deck/settings`, `/srs/status`, `/srs/optimize`, `/srs/params` |
| Quizzes | `/ai/quiz*`, `/ai/quizzes/:nodeId`, `/ai/quizzes/:quizId` (DELETE), `/ai/quizzes/:quizId/attempt`, `/ai/quizzes/:quizId/draw`, `/projects/:projectId/quizzes` |
| Assistant | `/ai/assistant/stream` (one turn; `conversationId` null starts a conversation), `/ai/conversations` (GET the list), `/ai/conversations/:id/messages`, `/ai/conversations/:id` (DELETE), `/ai/chat/message/:id` (PUT a repaired visual back), `/ai/today-briefing/stream`, `/assistant/cards` (POST adds a proposed card, `DELETE /assistant/cards/:id` undoes it only while it has never been reviewed) |
| Paper | `/paper/capability`, `/paper/:feedItemId/grade`, `/self-grade`, `/solution`, `/paper/attempts/:id/image` |
| AI | `/ai/insights*`, `/ai/create-project`, `/ai/cancel-creation`, `/ai/creation-status`, `/ai/generation-status`, `/ai/check-answer`, `/ai/explain-question`, `/ai/nodes/:id/find-resources`, `/ai/bulk` (+ `/projects/:id/bulk-candidates`), `/ai/models*`, `/ai/status`, `/ai/endpoints`, `/ai/key` (write-only), `/ai/openrouter/start\|finish` |
| Visuals | `/ai/repair-visual`, `/ai/widget/compile`, `/ai/visual/author`, `/ai/visual/caption`, `/ai/visual/build-failed`, `/visual-feedback` (+ `/export`) |
| Authoring | `/authoring/outline-brief`, `/projects/:projectId/authoring/phases\|material-brief\|material` |
| Vault | `/documents*`, `/documents/upload`, `/documents/search`, `/documents/:id/text\|original\|recover` |
| Media | `/media/:hash`, `/media/:hash/info`, `/media/:hash/describe`, `/media-descriptions/run\|status\|cancel` |
| Semantic | `/embeddings/status\|settings\|reindex`, `/node-embeddings/status\|reindex`, `/nodes/:id/similar`, `/nodes/:id/transfer`, `/nodes/search-semantic`, `/atlas`, `/atlas/regions/:signature/name` |
| Capture | `/capture`, `/capture/:nodeId/enrich` |
| Tasks | `/tasks`, `/tasks/stream`, `/tasks/:id/stream`, `/tasks/:id/cancel`, `/tasks/:id` |
| Import/export | `/export/:projectId`, `/export/:projectId/bundle`, `/export/:projectId/anki`, `/import`, `/import/bundle`, `/import/anki/inspect`, `/import/anki/commit`, `/import/anki/:stagingId` |
| Search | `/search`, `/search/suggest`, `/search-providers` (GET/POST/PUT/DELETE), `/search/keys` (write-only keys for the hosted engines, + `/test`), `/searxng/test` |
| Auth | `/auth/status\|setup\|login\|logout\|change\|disable\|apikey` |
| Updates | `/version`, `/build`, `/updates`, `/updates/check`, `/updates/auto`, `/updates/channel` (stable or nightly) |
| Desktop | `/desktop/status` and `/desktop/ping` (public), `/desktop/info`, `/desktop/quit`, `/desktop/keep-running`, `/desktop/start-at-login`, `/desktop/autostart-window`, `/desktop/window-mode`, `/desktop/open-data-dir`, `/desktop/restore-library` |
| Misc | `/health`, `/settings`, `/settings/:key` (secret keys refused), `/today`, `/today/activity`, `/today/briefing`, `/onboarding` (+ `/dismiss`), `/languages`, `/sessions`, `/activity` (+ `/export`) |

Streaming endpoints use **SSE**. Long-running generations register in
`server/tasks.js` so they survive a page reload and appear in the TaskDock.

---

## 9. Frontend

### 9.1 Routing

**The URL is the source of truth.** Routes: `/` (feed), `/projects`, `/calendar`,
`/schedule`, `/atlas`, `/settings`, `/project/:projectId/:view?/:nodeId?`.

`useRouterStoreSync` decodes the pathname and calls `applyRoute`, which is the
**only** writer of the mirrored nav fields (`view`, `currentProjectId`,
`workspaceView`, `selectedNodeId`). Navigation *actions* are thin `navigate()`
wrappers. Data loading hangs off `applyRoute`, so a deep link or a refresh
rebuilds full state. **Never `set` those four fields directly.**

### 9.2 Store (`src/store.ts`)

Zustand. Feed cards are **append-only and deduped by key**: on-screen cards are
never reordered and consumed cards keep their size, so the reader's scroll
position is never disturbed.

### 9.3 Shared utilities

`src/utils/tree.ts` (tree build, UTC dates, gantt, calendar) ·
`src/utils/projectShape.ts` (`countsInCards`: is a project measured in cards met;
it also decides that Study opens the review session, `deck/DeckStudy.tsx`) ·
`src/utils/srs.ts` (FSRS-6 via `ts-fsrs`, the single source of interval logic) ·
`src/utils/mathText.ts` (mechanical math-typography repair) ·
`src/utils/color.ts` (accent triplets) · `src/utils/platform.ts` (input
capability) · `src/utils/scan/` (client-side page scanning) ·
`src/utils/escapeKey.ts` (`pageMayTakeEscape`: when a page may act on Escape;
the atlas's layer order) · `src/hooks/useRootFontSize.ts` (the root size
`ui_scale` sets, for code that measures in px) · `src/components/ui/Popover.tsx`
(`placePopover` + `MenuPopover`/`MenuItem`: a menu from a button, on its edge,
inside the screen).

### 9.4 UI invariants

**Input capability is never a width breakpoint.** A phone held sideways clears
`sm:`. Keyboard hints gate on `(pointer: fine)`; hover-revealed controls gate on
the `can-hover:` variant and must also reveal on `focus-visible`.

**Colour comes from the theme.** The accent is a CSS variable
(`--accent-rgb`) set per project inside a workspace and to a neutral default
elsewhere. Use the Tailwind `accent` / `accent-fg` colours, not a fixed palette
class.

**Math renders on every surface.** AI-authored strings go through
`MathText`/`Markdown`, never a bare `{value}`.

`fixMarkdownMathTypography` repairs two rendering artefacts no prompt can
prevent: a formula alone on a line must be promoted to **display** math (and the
three-line `$$` form is load-bearing: `$$x$$` on one line is still parsed as
inline), and punctuation after a formula must be bound with a word joiner or it
starts the next line.

---

## 10. Security

See [SECURITY.md](SECURITY.md) for the full threat model.

- Express binds `127.0.0.1` by default.
- Optional single-user gate: scrypt password + signed cookie, plus a bearer API
  key for scripted clients, and a per-address login throttle. Covers every `/api`
  route except the public ones listed in §8.
- The database is **not encrypted at rest**, and there is no multi-user model.
- **Search providers run no code.** Manifests are declarative; `validateUrlTemplate`
  is the entire attack surface, because its output lands in an `href`:
  https-only (which is what blocks `javascript:`), no embedded credentials, only
  the documented placeholders, and the URL is parsed with placeholders filled by
  inert text so it is judged in its real shape.

---

## 11. Verification

No test runner; deterministic guard scripts against scratch databases, no model
calls. `npm test` discovers them by filename, so this list cannot go stale.

```bash
npm test                       # every guard suite
npm run test:quick             # the same, without the jsdom harnesses
npm run check                  # frontend types
node --check server/app.js     # and each server file you touched
npm run i18n:audit             # translation coverage, report only

# Read your own library or call a live model, so they are not in the suite:
node tools/leaf-invariant.mjs
node tools/feed-audit.mjs
node tools/feed-regen.mjs
node tools/quiz-audit.mjs
node tools/fsrs-optimize.mjs
node tools/anki-refresh-text.mjs

# Advisory, report-only:
node tools/style-lint.mjs
node tools/a11y-lint.mjs
node tools/contrast-audit.mjs
```

---

## 12. Other subsystems

### 12.1 The activity log (`server/activityLog.js`)

A local record of what the app DID: model calls, background jobs, projects created
or deleted. **Metadata only**: no titles, prompts, notes or model output, which is
what makes the file safe to hand to someone helping you debug; ids travel as ids
and a project's name is looked up only on the way to the screen. A ring buffer of
`MAX_ROWS` rows (overridable with the `ACTIVITY_LOG_MAX` environment variable),
switched by `activity_log_enabled`
(absent means on), with no FKs so a deleted project keeps its rows. Read in
Settings → Data, downloaded one event per line (`GET /api/activity`,
`/api/activity/export`, `DELETE /api/activity`). Guard:
`tools/activity-log-gates.mjs`, which also scans every `logActivity(` call site for
learner content.

### 12.2 Module map

The modules the sections above do not cover, one line each.

| Module | Owns |
|---|---|
| `ankiImport.js`, `ankiExport.js`, `ankiFields.js`, `ankiTemplates.js`, `ankiMedia.js` | Anki `.apkg` in and out: both collection schemas, field roles read from names, sides and card count from templates, media with the review history. Import stages first (`/import/anki/inspect`) and always makes a new project |
| `decks.js`, `deckStructure.js`, `nodeRole.js` | A deck as a project: sections from the deck's own order (subdecks, tags, then stages sized from `STAGE_SIZES`), the per-day ration of new cards, and whether a project's topics are taught at all |
| `media_files` via `ankiMedia.js`; `mediaDescribe.js`, `mediaContext.js` | The content-addressed store for card and question media (type sniffed by magic bytes), and vision descriptions of card images on a serial chain of their own |
| `vaultStorage.js`, `extract.js`, `officeProcess.js`, `pdfRecovery.js` | The Vault: originals stored by SHA-256, text extraction (Office files parsed in a child process with its own memory cap), and math recovery for PDFs whose formulas came out empty |
| `studyMaterial.js`, `bulkGen.js` | The one unattended authoring path (`generateMaterial`: mastery-check banks and cards), shared by the feed's look-ahead and bulk generation, which runs on its own chain |
| `questionLog.js` | Which question of a bank is asked next, for the feed, the mastery check and a saved quiz |
| `progress.js`, `completion.js` | What progress means (a closed topic is 1, a card topic earns cards met) and whether a project is finished, with the counts its completion screen shows |
| `fsrsOptimizer.js`, `bktOptimizer.js` | Fitting FSRS weights and BKT rates to the learner's own history; defaults ship until a fit wins on held-out data |
| `visualBuilds.js`, `visualAuthor.js`, `visualFeedback.js` | When a widget or scene is built, the specialist pass that draws `animation`/`p5` from a brief, and the learner's "Fix this" notes kept as a file they can share |
| `webContext.js`, `citations.js`, `searchBackends.js` | Web lookups for an answer, numbered sources resolved into titles and links, and the hosted engines reached only with a saved key |
| `netSafety.js`, `urlSafety.js`, `originGuard.js`, `uploadGuard.js` | Outbound fetch vetting (private addresses refused, every redirect re-checked, the socket pinned to the vetted address through undici's own `fetch` + `Agent`), link sanitising, the same-origin and host check on every request, and the cap on an upload's total size |
| `version.js` | The update check (see SECURITY.md, *The update check*) |

## 13. Known gaps

- BKT's first-`score`-of-N ordering approximation on the per-question path (§4.1).
- Documents marked `embedding_status='unavailable'` do not self-heal when a model
  later appears; Settings → "Re-index all" is required.
- `GET /api/embeddings/status` fires a live probe by default, which with a
  model-swapping proxy can cost a swap just from opening Settings.
- Ghost-question selection is random per decaying node, not difficulty-targeted.
- A lazy route chunk is not precached: the first visit to a route needs the
  network, and the stamped service worker caches the chunk for the next time.

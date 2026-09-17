# Technical Documentation

A subsystem-by-subsystem reference for Terramentor.

This document is organised around **what each module owns and the invariants it
maintains**, not around an exhaustive list of every constant and parameter. An
exhaustive enumeration is the part that changes weekly, and a wrong reference
is worse than no reference. Constants are named here so you can find them;
their current values live in the code.

For the shape of the system and the reasoning behind it, read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. **Where this document and
the code disagree, the code is right.**

---

## 1. Stack

| Layer | Choice | Why it matters |
|---|---|---|
| Frontend | React 18 + TypeScript, Vite, Tailwind, Zustand, react-router, @dnd-kit | URL-driven navigation; see §9 |
| Backend | Node + Express | One process; SSE for anything streaming |
| Database | SQLite via `better-sqlite3` | **Synchronous** — no pool, no interleaving, no read/write races |
| Vectors | `sqlite-vec` (`vec0` virtual tables) | Optional; absence degrades, never breaks |
| AI | Ollama, or any OpenAI-compatible endpoint | Optional throughout |
| Search | Wikipedia, DuckDuckGo, GitHub, SearXNG | Only outbound traffic besides the model |

Run: `npm run dev` (Vite 5173 + Express 3001) · `npm run standalone` (build +
single-origin serve from Express).

---

## 2. Database

Single file `server/terramentor.db`, WAL mode, `foreign_keys = ON`.
Schema and migrations live in `server/database.js`.

### 2.1 Tables

| Table | Holds |
|---|---|
| `projects` | A course. Colour, icon, schedule window, study days, `status` (`active`/`completed`/`archived`), `content_language`. |
| `nodes` | The curriculum tree (`parent_id` recursive). `title`, `description` (public Overview), `notes` (private), `status`, `is_note`, scheduling dates, `estimated_weight`, `completed_at`, `chat_draft`. |
| `resources` | Links attached to a node. |
| `settings` | Global key/value. Every tunable lives here. |
| `chat_messages` | Tutor history per node (`node_id NULL` = the global assistant). Persists reasoning traces. |
| `documents`, `document_chunks`, `documents_fts` | The Vault. FTS5 external-content index with sync triggers. |
| `vec_chunks` | sqlite-vec KNN over chunks. Lazily created; rowid = chunk id; **not a real FK**. |
| `node_embeddings`, `vec_nodes` | Topic vectors + their freshness sidecar. See §7. |
| `quizzes`, `quiz_attempts` | Saved assessments and results. |
| `flashcards` | FSRS-6 state (`stability`, `fsrs_difficulty`, `state`, `lapses`) plus the legacy SM-2 columns (`difficulty`, `ease_factor`, `last_interval`, `next_review`) that a pre-FSRS card is migrated from. |
| `review_log` | One row per review: rating, elapsed/scheduled days, state before/after, `source` (`app` or `anki`), Anki's revlog id. Written by the flashcard update endpoint, removed on undo, imported with a deck. Input to `server/fsrsOptimizer.js`. |
| `node_mastery`, `mastery_evidence` | BKT state and the evidence behind it, plus transfer provenance. |
| `feed_items` | The teaching cache: `plan` / `lesson` / `question` / `practice` rows per node. UNIQUE on `(node_id, kind, seq)`. |
| `paper_attempts` | Worked-by-hand submissions and their grades. |
| `widget_builds` | Compiled sandboxed widgets, cached by spec hash. |
| `search_providers` | Declarative outbound-search manifests (`addons` before 0.69). |
| `learning_sessions` | Study session records. |
| `activity_log` | What the app DID: model calls, background jobs, projects created or deleted. Metadata only — no titles, prompts or model output. Ring buffer, no FKs. See §12. |
| `media_files` | Content-addressed store for a card's or a question's images and audio. Type sniffed by magic bytes. |
| `visual_builds` | Specialist-authored `animation`/`p5` specs, cached by brief hash + contract version (`widget_builds` is the widget half). |
| `region_names`, `region_name_failures` | The atlas's region names, keyed on the member set, and the per-model failures behind a retry. |
| `placement_probes` | The placement probe's questions and what the learner answered. |

### 2.2 Conventions that are load-bearing

**Dual identity.** `projects`, `nodes` and `resources` carry an integer
`AUTOINCREMENT` PK *and* a `uuid TEXT UNIQUE`. The integer stays the internal key
for every FK, join and URL. The uuid exists only for crossing a device or
marketplace boundary, where two databases' autoincrement ids would collide.
A per-table `AFTER INSERT` trigger fills any NULL uuid, so every insert path is
covered without editing call sites. **Never make uuid a FK or a join key.**

**Leaf definition.** A leaf is a **non-note node with no non-note children**.
Notes are material attached to a topic — never scheduled, no status, zero weight
— so a topic whose only children are notes is still a leaf. Two mirrors must
agree: `LEAF_NODE` / `OPEN_LEAF` in `server/today.js` and `isLeafNode` /
`structuralChildren` in `src/utils/tree.ts`. Guard: `tools/leaf-invariant.mjs`.

**Node status** is a plain TEXT column, validated in the API
(`VALID_NODE_STATUSES`), not by a CHECK constraint — SQLite cannot ALTER a
CHECK, so a new enumerated value would force a table rebuild. New enumerated
values belong in an exported constant validated at the single write path.

**Dates** are `YYYY-MM-DD` and always parsed as **UTC midnight**.

**Vector tables are not FK-reachable.** `vec_chunks` and `vec_nodes` are swept
explicitly on startup against their parent tables. `node_embeddings` *does*
cascade, which is precisely why `vec_nodes` must be swept against `nodes`
**directly** — a cascade deletes the very row a sidecar-driven sweep would have
needed.

### 2.3 Content model — three tiers, and no fourth

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
(`DEPTH_DISCOUNT_FACTOR`, currently 0.85 per level) so a deeply-nested topic does
not out-weigh a shallow one purely by being subdivided. A user-set
`estimated_weight` overrides the computed weight.

Allocation is **phase-aware**: a top-level phase gets a contiguous slice of the
window, with a fallback path for a deadline too tight to fit them all.

Initial scheduling and recalibration **share one engine** (`allocatePhaseAware` +
`deriveParentDates` + `computeLeafWeight`). Recalibration simply runs it from
today over the still-open leaves, preserving completed items' dates.

**Pace is schedule-aware, not calendar-linear.** `expectedProgress` is the weight
of leaves whose `scheduled_end` has passed — not elapsed days over total days.

Notes never carry schedule dates; a startup repair strips any left by older runs.

---

## 4. Mastery (`server/mastery.js`)

### 4.1 BKT

Standard Bayesian Knowledge Tracing. The transition and slip parameters are
fixed; the **guess parameter is per question format**
(`GUESS_BY_QUESTION_TYPE`: true/false 0.5, multiple choice 0.25, short answer
0.05), passed from the stored feed row rather than from the client — it decides
mastery, so it cannot be caller-supplied.

`updateMasteryFromAttempt(nodeId, score, total, evidenceType, metadata)` is the
**single write path** for all evidence. `VALID_EVIDENCE_TYPES` is validated here,
not per endpoint.

**The cold start is 0.0, not `BKT_PARAMS.p_L0`.** `getNodeMastery` inserts a new
row at 0.0 and the update loop seeds from the stored score, so the declared
`p_L0 = 0.3` is never read — an untouched topic begins at 0.0, where one correct
multiple-choice answer reaches 0.1. A non-zero start comes only from a **seeded
prior** (§4.4).

Known approximation: the first `score` of `N` questions is treated as correct, so
a mixed attempt is order-dependent. It feeds the displayed estimate and the decay
timer; the completion gate does not depend on it alone.

### 4.2 The gate

`checkMasteryEligibility(nodeId, threshold, bossPass)` passes when there is
evidence **and** either:

- **(a)** BKT posterior ≥ `mastery_threshold`, **or**
- **(b)** an assessment of type `quiz` / `boss_fight` / `paper`, with at least
  `MIN_GATE_QUESTIONS` items, passed at ≥ `boss_fight_pass` raw accuracy.

`flashcard`, `drill` and `placement` evidence sharpen the estimate and refresh the
decay timer but never satisfy clause (b). Placement is excluded for a structural
reason, not a policy one: a probe asks one question per topic, so it can never be
an assessment of `MIN_GATE_QUESTIONS` items.

**Clause (a) is suspended on any SEEDED node** — transferred (§7.3) or placed
(§4.4) — until it has `MIN_GATE_QUESTIONS` answers of its own.

Modes (`mastery_gate_mode`): `off` never gates; `advisory` (default) lets the
learner mark done anyway; `enforced` blocks `completed` without proof. **Skip is
allowed in every mode.**

### 4.3 Decay

`decayedMastery(score, lastUpdated, decayDays)` holds a score fresh through a
grace window of `decayDays`, then applies an exponential forgetting curve with
`decayDays` as the half-life. Everything derives from the one configurable
setting. `getDecayingNodes` has two modes: a broad time-cutoff net for ghost
questions, and a decayed-estimate mode for "you proved these once".

### 4.4 Seeded priors (`applySeededPrior`)

Two features hand a topic an estimate the learner did not earn there: mastery
transfer (§7.3) and the placement probe (§4.5). They write their own columns
(`transferred_prior` / `placement_prior`, each with sources + timestamp) but
**`mastery_score` has exactly one author**, `applySeededPrior(nodeId, kind,
prior, sources)`:

- seeds combine with **MAX, never a sum** — two routes to "this looks familiar"
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
*within* each phase. Capped at `MAX_PROBE_QUESTIONS` (12); a project with fewer
than `MIN_PROBE_CANDIDATES` (6) is reported `too-small` as an answer, not an error.

**Propagation follows curriculum ORDER, not embedding similarity.** A course is
written easy-to-hard, so knowledge behaves roughly like a prefix of the leaf
sequence: *correct at k* implies everything at or before k, *wrong at k* implies
everything at or after k. So an unprobed topic is seeded when the **nearest probe
at or after it** was correct, and blocked when the **nearest probe at or before
it** was wrong; a conflict resolves to no seed. Similarity is deliberately not
used — inside one project it points at the successor as readily as the
prerequisite, which is why §7.3 is cross-project only.

**Propagation stops at the top-level section boundary.** The prefix model is a
claim about a *difficulty gradient*, and a section is the largest unit the engine
may assume one of: plenty of real projects are anthologies whose sections are
unrelated subjects sharing one container, and there an answer would vouch for a
different subject purely because it was asked later. So `next`/`prev` are
searched among the probes in the topic's own section only, and a section holding
no probe propagates nothing and is taught from zero — twelve questions cannot
place a learner across every section of an anthology, and no evidence about a
subject is not evidence against it. The boundary is deliberately *not* gated on
inter-section similarity: similarity measures topical overlap, the prefix model
needs a difficulty gradient, and on real curricula the two are close to
anti-correlated — a well-ordered course covers *different* material in each
section, which is what the ordering is for. It would also make the one
model-free, assertable part of placement depend on whether an embedding model
answered.

**Priors** are `DIRECT_PRIOR` (0.55) discounted by the format's guess floor, times
`PROPAGATION_DISCOUNT` (0.7) for an implied topic, clamped to `PLACEMENT_CEILING`
(0.6) and dropped below `PLACEMENT_MIN_PRIOR` (0.2). A format guessable at or
above `MAX_GUESSABLE` (0.35) seeds **nothing** — a rule, not an arithmetic
consequence, because at the tuned constants true/false discounted to 0.275 and
would otherwise have bought a head start.

**Answers are graded server-side** and recorded as `placement` evidence, but do
**not** run a BKT update on top of the seed — the seed *is* that answer's
contribution, and stacking both would carry a topic near the threshold on one
question. The answer key never leaves the server with the question
(`publicProbeQuestion`); it arrives in the answer response. `discardProbe`
reverses every seed and every evidence row.

Authoring uses `operation: 'authoring'` (300s) and treats a transport failure as
distinct from a bad question — it is not retried, and two consecutive ones stop
the run.

---

## 5. The learning feed

The home page. `server/feed.js` composes, `server/feedGen.js` generates ahead,
`server/feedQuality.js` gates.

### 5.1 Composition (`feed.js`)

`getFocusNodes()` picks what to teach: worst-pace project first, overdue oldest
first, then today's leaves; getting ahead only when nothing is due anywhere.
Capped per project and in total (`FOCUS_MAX_PER_PROJECT`, `FOCUS_MAX_TOTAL`).
The Inbox gets a **standing slot** — it is never scheduled, so a deadline would
turn "unread" into "overdue" by tomorrow.

`composeFeed({limit, excludeKeys, gate})` is deterministic and pages by exclude
key. Card kinds: `lesson`, `question`, `flashcard`, `recall`, `checkpoint`,
`practice`, `notice`. Interleave is roughly lesson → question → … with a
flashcard every 3–4 items and a recall about every 8.

Volume caps exist because unbounded queues destroy the format:
`DUE_REVIEWS_PER_DAY`, `NEW_CARDS_PER_PROJECT_PER_DAY`, `NODE_QUESTIONS_PER_DAY`,
`RECALL_MAX_PER_BATCH`.

**Degradation is mandatory.** Without a model the feed serves node descriptions
and note-children as reading cards, saved quiz questions, flashcards and recalls.

The response also carries a `transfers` map keyed by node id (§7.3), rather than
copying the payload onto every card in a chapter.

### 5.2 Generation (`feedGen.js`)

Runs on **its own serial chain**, not the tasks FIFO, and yields to any
non-feed task before every model call. Writes into `feed_items`: a `plan` outline
row first, then lesson/question rows, then one paper exercise at `PRACTICE_SEQ`.

The outline sizes itself to the topic (`MIN_PARTS`…`MAX_PARTS`); each part is
generated with the full outline plus the actual text of earlier parts, so parts
build on each other instead of re-teaching. Failures back off exponentially and
never throw.

`feed_items` is a **cache**. Changing a prompt does not improve rows already in
it — the generator only fills gaps. Re-author with `tools/feed-regen.mjs`.

### 5.3 Quality gates (`feedQuality.js`)

Four gates, all failing closed toward serving *less*:

1. **Mechanical** — unclosed fences, foreign-script leakage (scoped to the
   project's own language), ASCII art, `linearCombinationFaults` from
   `arithmetic.js`, and `stripSelfCertifyingCloser`.
2. **Answer-key verification** — a second pass answers the question cold; a
   disagreement vetoes it. Open questions switch to an arithmetic audit instead,
   since they cannot be solved cold. Three failures drop the question and record
   the reason.
3. **Visual coherence** — three verdicts: `ok`, `wrong` (remove the visual),
   `text-wrong` (the picture was right — rewrite the *lesson*).
4. **Numeric audit of the lesson** (`auditLessonMath`, gated on `hasComputation`).

**Defects vs weaknesses.** A defect would mislead — never served. A weakness
means the card works but measures less than it claims (`keyEchoesStem`,
`keyIsLengthOutlier`, "all of the above", too many eliminable options) — served,
with the weakness recorded, because a skipped question measures nothing at all.

**A rejection carries its reason into the retry** (`priorFault`, appended as a
trailing instruction).

`server/arithmetic.js` has no imports by design, so read-only tools can apply the
identical rule. Its safety property is *declining on anything it cannot fully
evaluate*.

### 5.4 Paper practice (`server/paper.js`)

One exercise per topic: `{mode, brief, materials, rubric, reference_solution}`.
The rubric has at least `MIN_GATE_QUESTIONS` points, or paper could never clear
the gate.

- **The reference solution is never on the card** — fetched only on submit or an
  explicit "mark it myself". The rubric leaks the same secret if you let it, so
  derived values are forbidden in a rubric point *and* the card keeps the rubric
  collapsed.
- **Scanning is client-side** (`src/utils/scan/warp.ts`): corner ordering →
  homography → per-mode finishing (adaptive threshold for documents; tone
  preserved for drawings, because thresholding destroys what is being marked).
- **Grading is ONE pass** — the model that sees the page marks it. A
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
`SYSTEM_PROMPTS` / `AI_PROMPTS`, `buildNodeContext`, `chunkText`, URL validation,
`visionAvailability` and the hybrid retrieval fusion.

`buildNodeContext` injects the **learner profile** into every AI context. Chat
surfaces additionally get the project's completed leaf titles; quiz and flashcard
generation deliberately do not — it distracts small models from the current node,
and the Boss Fight must stay a pure per-node assessment.

**Vision is only trusted when verified.** An OpenAI-compatible endpoint cannot be
capability-probed, and a text-only model handed an image will invent a plausible
transcription. `auto` trusts only verified vision; a failed probe must never be
cached as a definitive "no".

### 6.2 Retrieval

`searchDocuments` (**async** — callers must `await`) fuses FTS5 keyword ranking
and sqlite-vec KNN via Reciprocal Rank Fusion (`RRF_K = 60`, keyed by chunk id).
Without vectors it silently equals plain FTS5.

Indexing (`server/embeddings.js`) runs on its own serial chain — a large PDF must
not freeze the tutor — mirrored to the TaskDock for visibility only.

**vec0 gotchas:** an INSERT rowid must be a `BigInt` (a plain number throws);
vectors bind as `Buffer.from(new Float32Array(v).buffer)`; a returned blob must be
**copied** before being viewed as a `Float32Array`, because Node's pooled buffers
have arbitrary byte offsets and a typed-array view demands 4-byte alignment; the
table dimension is fixed, so switching models drops and recreates **every** vec
table and forces a re-index.

### 6.3 Visuals

The tutor emits fenced *specs* — `mermaid`, `vega-lite`, `plot`, `smiles`,
`animation` (SVG/SMIL), `p5` (sandboxed iframe), `drill` (minigame item bank),
`widget` (delegated: a second model pass compiles it to sandboxed HTML, cached by
spec hash) — plus KaTeX math and `<TimelineEvent>` tags, which are DOM rather
than a picture so their bodies stay markdown.

Rules for adding a kind: a mechanical `sanitizeX.ts`, a `VISUAL_REPAIR_HINTS`
entry, a `VISUALS_GUIDE` line, and a renderer that **throws descriptive errors** —
that text becomes the repair prompt. Prefer a mechanical fix to a repair
round-trip. **Persist a repair wherever the visual lives**, or the model re-runs
on every page load.

Two content rules earned from real failures: **"function, not values"** — the
model must never emit numbers it computed itself, so charts of formulas use
`data.sequence` + `transform.calculate` and the engine computes the data; and
**teach a representation → show that representation**, never a flowchart *about*
the thing when the lesson needs a picture *of* the thing.

Widgets are pre-compiled by `feedGen` so the feed hits a warm cache; the feed
passes `autoBuild={false}`, so a missed pre-build shows a button, never a spinner
mid-scroll. One widget per topic.

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

One vector per non-note node, over `parent title › title` + Overview. The project
name is **deliberately excluded** — it is the one string guaranteed to differ
between two curricula teaching the same thing.

Vectors are **unit-normalised on write and query**, so vec0's L2 distance
converts to cosine exactly (`cos = 1 − d²/2`) independently of the sqlite-vec
build, and callers get a bounded 0..1 number to threshold.

**Freshness is reconciled, not hooked.** `node_embeddings` stores a hash of the
exact text embedded *and the model that embedded it*; `syncNodeEmbeddings`
re-embeds only the drift. A clean sweep costs zero model calls, which is what
makes `scheduleNodeSync()` safe to fire from every node write (debounced, with a
max-wait so a steady write stream cannot starve it). A status change is
deliberately excluded — it cannot move a topic in the space, and the feed writes
those constantly.

A failed batch is recorded with an **empty hash**, which no real text can
produce, so an unreachable model leaves topics pending and retried rather than
looking permanently done.

Guard: `tools/node-embedding-gates.mjs`.

### 7.2 Atlas (`server/atlas.js`)

Groups topics into **regions** by meaning, names each after its most central
topic (no model call, so the map is deterministic), lays regions out by PCA, and
lists cross-project **bridges** separately.

Four things keep it bounded and honest:

- **The region threshold is derived from the library**, not hardcoded: the 20th
  percentile of sampled nearest-neighbour similarities. A constant tuned to one
  embedding model produces one region per topic on another — which is not just an
  ugly map but **quadratic**, because leader clustering costs topics × regions.
  A low percentile is required, not the median: a topic joins only if its nearest
  neighbour clears the threshold, so the median guarantees half the library
  becomes a region of one.
- **Oversized and incoherent regions are subdivided.** Assignment places every
  topic in its *nearest* region with no floor on how near that is, which is
  correct — a topic must be somewhere — and is also how one region becomes a
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
Extensions"). The words are then the author's own — the position in one course
is exactly what the atlas has dissolved.

Above that sits `server/regionNaming.js`: a model reads every title in a region
and writes a name that covers all of them, because the medoid can only ever be
ONE member's title and a region spanning a discipline is otherwise named after
one lesson inside it. It is an enrichment, never a step in drawing — no model,
no cached name or a rejected answer leaves the map byte-identical. Names are
cached in `region_names` **by member set alone**; the model that wrote one is
recorded but is not part of the key (a name is validated prose, not a vector in
a model's own space, so switching models must not orphan the library's names).
Failures are counted per region and per model in `region_name_failures`, so a
model that cannot do the job stops being asked. `atlas_naming_model` (Settings
→ AI & Models) runs naming on a different model than chat; empty follows chat.
The learner can rename any region by hand — `PUT`/`DELETE
/api/atlas/regions/:signature/name`, stored under the same key with
`model = 'user'` — and a completed sweep or a rename invalidates the atlas
cache, or the new names would not appear until the library itself changed.

Measured on a large real library: ~1.2 s to build (0.84 s before subdivision),
~1 ms cached, worst event-loop stall under 100 ms. Cached against a signature
of the topic space (vector count, sidecar state, model).

Guard: `tools/atlas-gates.mjs` — the degenerate libraries (one topic, all
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
reports `available: false` — and nothing may be withdrawn on it.

Guard: `tools/mastery-transfer-gates.mjs`.

---

## 8. API surface

All routes are under `/api` and all are covered by the optional auth gate.
Grouped by area; read `server/index.js` for the current exhaustive list.

| Area | Routes |
|---|---|
| Projects | `/projects`, `/projects/:id`, `/projects/reorder`, `/projects/:id/pace`, `/insights`, `/study-dashboard`, `/daily-plan` |
| Nodes | `/nodes` (CRUD), `/nodes/:id/move`, `/weight`, `/labels`, `/nodes/:nodeId/resources` |
| Scheduling | `/projects/:id/schedule` (POST/DELETE), `/recalibrate`, `/schedule/overview`, `/calendar` |
| Feed | `/feed`, `/feed/consume`, `/feed/items/:id` |
| Mastery | `/nodes/:nodeId/mastery`, `/mastery/quiz`, `/mastery/drill`, `/projects/:projectId/mastery` (a card's evidence has no route — it is written on the rating path, `server/cardEvidence.js`) |
| Paper | `/paper/capability`, `/paper/:feedItemId/grade`, `/self-grade`, `/solution`, `/attempts/:id/image` |
| AI | `/ai/chat*`, `/ai/quiz*`, `/ai/flashcards*`, `/ai/insights*`, `/ai/create-project`, `/ai/cancel-creation`, `/ai/check-answer`, `/ai/explain-question`, `/ai/repair-visual`, `/ai/widget/compile`, `/ai/bulk`, `/ai/models*` |
| Vault | `/documents*`, `/documents/upload`, `/documents/search`, `/documents/:id/recover` |
| Semantic | `/embeddings/status\|settings\|reindex`, `/node-embeddings/status\|reindex`, `/nodes/:id/similar`, `/nodes/:id/transfer`, `/nodes/search-semantic`, `/atlas` |
| Capture | `/capture`, `/capture/:nodeId/enrich` |
| Tasks | `/tasks`, `/tasks/stream`, `/tasks/:id/stream`, `/tasks/:id` |
| Import/export | `/export/:projectId`, `/export/:projectId/bundle`, `/import`, `/import/bundle` |
| Search providers | `/search-providers` (GET/POST/PUT/DELETE) |
| Auth | `/auth/status\|setup\|login\|logout\|change\|disable\|apikey` |
| Misc | `/health`, `/settings`, `/search`, `/search/suggest`, `/today`, `/today/briefing`, `/onboarding`, `/languages`, `/flashcards/due` |

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

Zustand. Feed cards are **append-only and deduped by key** — on-screen cards are
never reordered and consumed cards keep their size, so the reader's scroll
position is never disturbed.

### 9.3 Shared utilities

`src/utils/tree.ts` (tree build, UTC dates, gantt, calendar) ·
`src/utils/srs.ts` (FSRS-6 via `ts-fsrs` — the single source of interval logic) ·
`src/utils/mathText.ts` (mechanical math-typography repair) ·
`src/utils/color.ts` (accent triplets) · `src/utils/platform.ts` (input
capability) · `src/utils/scan/` (client-side page scanning).

### 9.4 UI invariants

**Input capability is never a width breakpoint.** A phone in landscape clears
`sm:`. Keyboard hints gate on `(pointer: fine)`; hover-revealed controls gate on
the `can-hover:` variant and must also reveal on `focus-visible`.

**Never hardcode an accent colour.** The accent is a CSS variable
(`--accent-rgb`) set per project inside a workspace and to a neutral default
elsewhere. Use the Tailwind `accent` / `accent-fg` colours.

**Math renders on every surface.** AI-authored strings go through
`MathText`/`Markdown`, never a bare `{value}`.

`fixMarkdownMathTypography` repairs two rendering artefacts no prompt can
prevent: a formula alone on a line must be promoted to **display** math (and the
three-line `$$` form is load-bearing — `$$x$$` on one line is still parsed as
inline), and punctuation after a formula must be bound with a word joiner or it
starts the next line.

---

## 10. Security

See [SECURITY.md](SECURITY.md) for the full threat model.

- Express binds `127.0.0.1` by default.
- Optional single-user gate: scrypt password + signed cookie, plus a bearer API
  key for scripted clients. Covers every `/api` route.
- The database is **not encrypted at rest**, and there is no multi-user model.
- **Search providers run no code.** Manifests are declarative; `validateUrlTemplate`
  is the entire attack surface, because its output lands in an `href` —
  https-only (which is what blocks `javascript:`), no embedded credentials, only
  the documented placeholders, and the URL is parsed with placeholders filled by
  inert text so it is judged in its real shape.

---

## 11. Verification

No test runner; deterministic guard scripts against scratch databases, no model
calls.

```bash
npx tsc --noEmit
node --check server/index.js

node tools/leaf-invariant.mjs
node tools/feed-gates.mjs
node tools/language-gates.mjs
node tools/node-embedding-gates.mjs
node tools/mastery-transfer-gates.mjs
node tools/placement-gates.mjs
node tools/srs-gates.mjs
node tools/anki-gates.mjs
node tools/atlas-gates.mjs
node tools/search-provider-gates.mjs

node tools/feed-audit.mjs      # audits cached content (reads the live DB)
node tools/quiz-audit.mjs
node tools/style-lint.mjs
node tools/a11y-lint.mjs
node tools/contrast-audit.mjs
```

---

## 12. Known gaps

- `server/index.js` and `src/components/ProjectsGrid.tsx` are large monoliths.
- BKT's first-`score`-of-N ordering approximation (§4.1).
- Documents marked `embedding_status='unavailable'` do not self-heal when a model
  later appears — Settings → "Re-index all" is required.
- `GET /api/embeddings/status` fires a live probe by default, which with a
  model-swapping proxy can cost a swap just from opening Settings.
- Ghost-question selection is random per decaying node, not difficulty-targeted.
- A lazy route chunk is not precached: the first visit to a route needs the
  network, and the stamped service worker caches the chunk for the next time.

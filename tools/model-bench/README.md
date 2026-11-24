# Model benchmark

Scores a model on the work Terramentor actually gives it. Each case calls the
app's own code (the real prompt, the real parser, the real validators and gates)
with a fixed input, and a deterministic scorer decides pass or fail. A model's
score is the share of cases it passed, out of 100.

Nothing here is a generic quiz: a model that answers trivia well but breaks the
JSON the answer checker reads, drifts into English in a Dutch lesson, or
rubber-stamps a wrong answer key, scores low.

## The cases

102 cases in 16 categories, one file each in `cases/`:

| category | what the app asks the model to do | function the case calls |
|---|---|---|
| verify | solve a question cold and confirm or stop its answer key | `feedQuality.verifyQuestion` |
| grading | grade a typed answer (prose and code) | `ai.checkAnswerWithAI` |
| explain-back | mark a learner's own explanation of a lesson part | `lessonPrompts.markExplanation` |
| paper | mark a transcribed written answer against a rubric | `paper.gradeTranscription` |
| quiz | write a quiz of a requested question type | `studyMaterial.buildQuizPrompt` + `finalizeQuiz` |
| flashcards | write flashcards | `studyMaterial.buildFlashcardPrompt` + the card parser |
| lessons | write one lesson part | the feed's lesson prompt + `lessonDefects` |
| audit | find a planted error in a lesson, pass a sound one | `feedQuality.auditLesson` |
| outline | plan a short course or a course's phases | `creationCalls.structureCall`, `creationStages.planPhases` |
| identity | name and describe a new course | `projectIdentity.decideProjectIdentity` |
| search-words | pick video search words for a course | `searchWords.writeSearchWords` |
| regions | name a region of the atlas | `regionNaming.nameRegion` |
| chat | answer as the tutor | `chatTurn.runChatTurn` |
| assistant-check | re-answer the assistant's proposed cards | `assistantChecks.checkCards` |
| visuals | draw an SVG animation or p5 sketch, build a widget | `visualAuthor.authorVisual`, `widgets.compileWidget` |
| vision | read text from a picture, describe a picture | `ai.transcribeImageToText`, `mediaDescribe.describeMedia` |

Cases cover English, Dutch, Russian and Ukrainian. The 8 vision cases count
only for models that read images; for a text-only model they are N/A, and its
score is out of the 94 cases it can take.

No case is scored by another model. Where a scorer checks a proxy (keywords,
a function-word share for language, a reading of SVG attributes) the case
says so in a comment. Some limits worth knowing when reading a score:

- The quiz, flashcard and lesson cases check what the app needs (the format
  its parser reads, the language, counts, the app's own defect checks), not
  whether every generated fact is true. Fact-checking is what the verify and
  audit cases measure.
- Verify and audit are half "this key is wrong" and half "this key is right",
  so a model that always gives the same verdict scores 50% on them. The score
  only means something above that.
- The animation and widget cases run code the model wrote. They run it in a
  child process under Node's permission model (it reads only the scorer file
  and `node_modules`; no file writes, child processes, workers or addons, and
  `node:sqlite` switched off),
  whose environment holds no API key, with the page's network functions
  removed, killed after 30 s. Node 24's permission model does not fence
  outbound network.

## The hard suite

Strong models score close to full marks on the cases above, so they tell
strong models apart poorly. `--suite hard` runs a second set of 100 cases in
`cases-hard/`, built so that guessing, or always giving the same verdict,
scores close to nothing:

| category | cases | what it asks |
|---|---|---|
| math | 14 | eight close values to order (roots, probabilities, counts, huge powers, areas), exact counts, residues and calendar sums |
| science | 12 | eight tabulated quantities to order, some pairs within one or two per cent |
| code | 10 | what Python and JavaScript code prints or evaluates to, and four audits of a reference solution |
| language | 14 | Dutch, Russian, Ukrainian and English grammar, spelling and stress, six of them the Dutch forms of English loan verbs |
| knowledge | 19 | eight rulers, works, places or sizes a few years or per cent apart, put in order |
| unsound | 8 | questions an expert must refuse: two right options, none, a false premise, an item that does not belong |
| grading | 8 | pairs: a right answer that looks wrong and a wrong one that looks right |
| audit | 8 | pairs: a sound lesson segment and the same segment with one planted error |
| paper | 7 | marking by the rubric's rules: other valid methods, missing working, carried errors |

- **Solve cases** (math to knowledge) go through the answer-key checker
  (`feedQuality.verifyQuestion`). The model never sees the key: it solves the
  question cold and the checker compares its answer with the TRUE key, so a
  case passes exactly when the model solved it. Multiple choice has six options whose
  distractors are what the usual mistake leads to; most orderings have eight
  items, and one wrong pair fails the case. Calling a sound question broken,
  or answering "unsure", fails.
- **Unsound cases** pass only on the verdict "broken"; picking an answer that
  differs from the key is a guess, not a refusal.
- **Pairs** (the four code audits, grading, audit) run the model twice and
  pass only when both verdicts are right.
- The setup of every solve and unsound family (math, science, language,
  knowledge, unsound) checks that no option reads as the key under the app's
  own answer comparison (`sameAnswer`), so a distractor is never scored as a
  right answer, and that no two items of an ordering read as one
  (`sameOption`), so a swapped pair is never scored as the right order.

Every key was computed, run or looked up, not recalled: the numbers by
script, the snippet outputs by running them (Python 3.11, Node 24), the buggy
reference solutions against a brute-force reference, the Dutch verb forms
from the Woordenlijst Nederlandse Taal, and the tabulated values and dates
from reference lists, written into each family's header comment. A case
stays only if one key is defensible under every current standard: where
dictionaries or exam lists disagree (Russian stress varies between them),
the case is left out.
The vision cases have no hard counterpart, so every model takes all 100.

## Checking the scorers

    node tools/model-bench/mutate.mjs [-v] [--family grading] [--suite hard]

Every case carries a `golden` reply (what a sound model could answer) and
`mutants` (replies broken by hand: a wrong verdict, broken JSON, the wrong
language, a planted error let through). The check serves each in place of the
model, through the same app code, and requires the golden to pass and every
mutant to fail. Some cases also carry `variants`, other sound replies (a
different but correct phrasing) that must pass too. It also probes the
code-running child's permission fence. `npm test` runs it for both suites as
`tools/model-bench-gates.mjs`.

## Running it against models

    OPENROUTER_API_KEY=... node tools/model-bench/run.mjs --models free --out <dir>
    node tools/model-bench/run.mjs --models some/model,other/model --out <dir> [--suite hard]
    node tools/model-bench/report.mjs --out <dir> [--noise repeat] [--suite hard]

Both suites write to `<model>.jsonl`; the report counts only the rows of the
suite it is given, so a folder may hold both.

Set the key from a launcher, not a shell history line. `--models free` reads
the live OpenRouter list and takes every model priced at zero with text in and
text out (the `openrouter/free` router is left out). Each model gets its own
worker process with a fresh scratch library (`DB_PATH` and `VAULT_ROOT` in the
system temp folder); the app reaches OpenRouter through the env overrides
`getAISettings()` reads, so no settings row is written.

A model named `anthropic:<id>` (for example `anthropic:claude-haiku-5-5`) goes
to Anthropic's own API instead, through the app's direct Anthropic connection
(`server/anthropicWire.js`), with the key from `ANTHROPIC_API_KEY`. Anthropic
reports tokens, not money, so its cost is priced from the list in
`harness.mjs` (cache writes at 1.25x, cache reads at the read rate); a model
missing from that list is refused before the run starts. Two figures differ
from the OpenRouter rows: the direct wire always streams, so its first-token
time is real even for a call the app makes without streaming (an OpenRouter
non-streaming call records the whole reply time there), and Anthropic does not
report thinking tokens apart, so their reasoning column is 0 and thinking
counts inside the output tokens.

- **Rate limits.** Every model request waits for a slot from the parent,
  which grants one every 60/`--rpm` seconds across all workers (default 16;
  the free tier allows 20 a minute). That wait runs inside the app's own
  per-request timeout, so only `--parallel` models run at once (default
  rpm / 3, a wait under about 20 s). `--shards N` splits one model's cases
  over N workers, for a slow model. A free-model run stops granting after
  `--daily` requests, which defaults to what the key's free daily quota has
  left; a paid run has no default cap.
- **Resuming.** Results go to `<dir>/<model>.jsonl`, one line per case. A case
  already on disk is skipped, so a stopped run picks up where it stopped.
  `--retry-errors` re-runs rows that ended in an upstream error. Each row
  carries the commit it ran on (`rev`).
- **Errors.** A 429, an overloaded upstream, a dropped stream, or a timeout
  the request queue caused is retried twice with a pause. If it still fails,
  the row counts as a fail and the report counts it under errors. The app's
  own timeout on a slow model is not retried: the learner would have met it.
- **Stops.** A refused slot (budget spent, the free daily limit) stops the
  worker without writing the case. So does a reply that says the run cannot
  go on for this model (401, 402, 403, or a 404 from the account's privacy
  settings): if the OpenRouter account requires zero-data-retention
  endpoints, a model with none is stopped at its first request. `run.mjs`
  records which models have a ZDR endpoint in `<dir>/models.json`.
- **Noise.** Run the same model again with `--label repeat` (it writes
  `<model>@repeat.jsonl`), then pass `--noise repeat` to the report to count
  the verdicts that flipped.

Each row records pass or fail and why, wall time, time spent waiting for a
slot, time to first token, model time, tokens in, out and reasoning, cost as
OpenRouter reports it or as priced from Anthropic's token counts (and what all
attempts spent), the serving provider,
and every request error. The report's seconds are model time: how long the
app waited on the model, its own retries included.

## Adding a case

Add it to the family file it belongs to (the contract is at the top of
`cases/index.mjs`), with a golden reply and at least two mutants, and run the
scorer check.

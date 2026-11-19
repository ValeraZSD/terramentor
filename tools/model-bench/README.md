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
  child process whose environment holds no API key, with the page's network
  functions removed, killed after 30 s.

## Checking the scorers

    node tools/model-bench/mutate.mjs [-v] [--family grading]

Every case carries a `golden` reply (what a sound model could answer) and
`mutants` (replies broken by hand: a wrong verdict, broken JSON, the wrong
language, a planted error let through). The check serves each in place of the
model, through the same app code, and requires the golden to pass and every
mutant to fail. `npm test` runs it as `tools/model-bench-gates.mjs`.

## Running it against models

    OPENROUTER_API_KEY=... node tools/model-bench/run.mjs --models free --out <dir>
    node tools/model-bench/run.mjs --models some/model,other/model --out <dir>
    node tools/model-bench/report.mjs --out <dir> [--noise repeat]

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

# The README hero clip

`docs/screenshots/hero.webp` is one continuous take of the app on a scratch library: an empty
library, a new course drafted by the model (as a captioned time-lapse), a topic explained with a
drawing by the assistant, then a question answered and marked. These two scripts film it again
without spending anything on the model.

| file | what it does |
|---|---|
| `serve.mjs` | starts the app on a scratch library (its database, vault and credentials file all inside the folder you name) with the film's settings, and answers every model call from recorded replies |
| `film.mjs` | starts `serve.mjs`, drives the hero flow in a headless browser and records it |

## What you need

- A build: `npm run build` (the server serves `dist/`).
- A screen recorder module exporting `record(options, script)`, with the cursor, caption and
  progress-bar post pass the clip uses. Its path is `--recorder` (or `HERO_RECORDER`).
- Microsoft Edge or Google Chrome; Python 3 with Pillow and NumPy for the recorder's post pass.
- A folder of recorded model replies (`--cassettes`), one `<hash>.json` per call:
  `{ "ms": <how long the real call took>, "label": <the system prompt's text (blocks joined with
  newlines), every run of whitespace made one space, first 90 characters>, "stream": true|false,
  "sse": <the raw reply> }`. The hash is the first 24 hex characters of the SHA-256 of
  `JSON.stringify({ model, system, messages, tools: tools || null })`, so a call without tools
  hashes `"tools":null`. Recordings are not kept in the
  repository; `serve.mjs --record` makes them (see below).

## Filming

```sh
npm run build
node tools/hero/film.mjs --recorder <demo.mjs> --cassettes <dir> \
  --fallback-log <take>/replay.jsonl --order-logs <take>/replay.jsonl \
  --no-fallback "^(You are a curriculum designer|You are a sharp, concrete tutor|You are a subject expert checking|You write ONE question|You audit the MODEL ANSWER)" \
  --wait-feed --stepped --out hero.webp
```

- `--work <dir>` holds the take's library, frames, server log and checks; without it a new
  temporary folder is used. Every take needs a new library.
- `--stepped` films frame by frame on a virtual clock (below). Without it the take is filmed in
  real time and a busy machine shows as stutters in the clip.
- `--wait-feed` cuts, after the course is drafted, until every topic's lesson is written, so the
  feed never shows a writer at work. The cut is invisible: the finished run is the same picture
  before and after it.
- `--until created|opened` stops after that scene (for trying a change quickly).
- `HERO_NAME`, `HERO_DESCRIPTION` change the course typed in; `LAPSE` and `ANSWER_LAPSE` the
  time-lapse speeds (3 and 4).

### Why replies need three ways to match

A call is first looked up by its hash. Some prompts change between takes while meaning the same
thing (today's date, the screen it was asked from); `--fallback-log` names an earlier take's
`replay.jsonl`, and such a call gets the reply the call of the same kind at the same position got
in that take. Checker prompts shuffle their answer options, so their hash never repeats;
`--order-logs` serves them by position. Lessons and questions belong to one topic, and another
topic's lesson is wrong content, so `--no-fallback` names the prompts that must match exactly.

### Recording replies

Without `--record` a call with no recording fails, and nothing reaches the model. With it, a call
with no recording is sent to the model and its reply kept in `--cassettes`:

```sh
ANTHROPIC_API_KEY=... node tools/hero/film.mjs ... --record --max-usd 4 --max-real 400
```

`--max-usd` (default 0) and `--max-real` (default 0) cap the spending; the server refuses calls
past either. Every call is logged in `<work>/library/replay.jsonl` with how it was answered.

`--record` refuses to start without a `--max-usd` above 0. Calls still running count against
the cap at the average cost of the calls so far, so several calls started together cannot pass
it together.

`serve.mjs` only opens a library it made itself (it leaves a `.hero-library` file there), so it
cannot be pointed at a real one. Without `--record`, a call through `fetch` to any host but this
machine is refused; the film's settings turn off the features that fetch pages themselves (web
search, finding resources, update checks). The model list the assistant panel asks for is
answered by `serve.mjs` itself, with and without `--record`, so the panel looks the same in
every take. `HERO_FALLBACK_LOG`, `HERO_ORDER_LOGS` and `HERO_NO_FALLBACK` stand in for the
options of the same names.

A refused call's whole request is saved as `<work>/library/refused/<hash>.json`, and
`--wait-feed` stops at the first one instead of waiting for the feed. Recordings cover the calls
the recording take made and no others: the feed writer works in the background, so a take that
waits for it longer, or films at another pace, can ask for a lesson or question the recording
take never needed. Record such a take once with `--record`; later takes of the same flow replay
it.

## Frame-stepped capture

With `--stepped` the page runs on a virtual clock that moves only when the recorder steps it:
timers, animation frames, `Date`, `performance.now`, CSS animations and transitions, and SVG
animations all follow it. Each step is one frame (1/40 s of film by default, `--fps` to change it, times the time-lapse
speed), then a screenshot. 20 fps is too coarse for the drawing's thin moving lines: they jump
further than their own width each frame. The server's replayed model follows the same clock through
`/__film/clock?t=<seconds>&auto=<0|1>`, so a reply arrives at the same moment of the film however
long each screenshot takes. A slow or busy machine films the same clip, only slower.

Not covered by the virtual clock: `<video>`/`<audio>`, workers' own timers and cross-origin
frames. The app's own server work (database writes, the task queue) runs in real time; before
each frame the recorder waits for the page's pending requests, so their answers land in the frame
they would have.

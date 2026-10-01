<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/terramentor-wordmark-dark.png">
    <img src="brand/terramentor-wordmark.png" alt="Terramentor" height="72">
  </picture>
</p>

<p align="center"><b>An AI tutor for a whole subject. AI gets better, so do you.</b></p>

<p align="center">
  <a href="https://github.com/ValeraZSD/terramentor/releases">Download</a> ·
  <a href="#install">Install</a> ·
  <a href="docs/GETTING_STARTED.md">First steps</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <a href="https://github.com/ValeraZSD/terramentor/releases"><img alt="release" src="https://img.shields.io/github/v/release/ValeraZSD/terramentor?style=flat-square"></a>
  <a href="LICENSE"><img alt="AGPL-3.0" src="https://img.shields.io/github/license/ValeraZSD/terramentor?style=flat-square"></a>
  <a href="SECURITY.md"><img alt="no account · no telemetry" src="https://img.shields.io/badge/no_account-no_telemetry-blueviolet?style=flat-square"></a>
  <img alt="Windows, macOS and Linux" src="https://img.shields.io/badge/platform-Windows_%7C_macOS_%7C_Linux-informational?style=flat-square">
</p>

Tell Terramentor what you want to learn and by when. The model you connect drafts the course
and writes every lesson, diagram and question. Terramentor plans the course against your
deadline, asks you to prove each topic rather than just tick it off, and brings back what you
are starting to forget.

It needs a model to write with: a hosted one under your own key, or one running on your computer
([which to choose](#the-model-is-the-teacher)). The app itself is free and has no account.

![From an empty library to a marked answer: a course on waves and light is drafted, a topic's tutor draws an animated standing wave, its lesson opens, and a question is answered.](docs/screenshots/hero.webp)

The clip starts from an empty library, with GLM-5.3-Flash as the model. Drafting the course took
it two minutes, the first lessons three more, and the tutor's animation about ten seconds. Those
waits are cut from the clip.

## How it works

One loop: **Discover → Plan → Study → Prove → Remember**. The pictures below come from one course,
physics for VWO (the Dutch pre-university exam).

### Discover

Describe the subject in a sentence and the model drafts a course, as in the clip above: phases,
then topics, each with an overview, in the language you wrote the description in unless you pick
another. The draft runs in the background with an estimate of the time left, so you can keep
studying or start a second course meanwhile. You can also import a course file, a `.studyvault`
bundle with its media, or an Anki deck. Press `c` anywhere to drop a link, a paragraph or a photo into
your Inbox.

### Plan

Give it a start date, a deadline and the days of the week you study. The time is spread across
the topics by weight, and pace is measured against that plan, not against the calendar. The dates
are the control: change them and whatever is still open is planned again.

![October in the course's calendar, with the topics planned for each study day and the course on track.](docs/screenshots/plan.webp)

### Study

The home page is a stream: lessons in short parts, a question after each part, flashcards, and
questions from earlier topics you are starting to forget. Diagrams, charts and animations are
written by the model as code and checked before you see them. When a course has documents of its
own, such as lecture notes or past papers, its lessons are written from them and name the
document they used. A tutor for each topic, and an assistant across the whole library, answer
from your own files.

![A lesson on total internal reflection with an animation of one ray refracting out of glass and one reflecting back.](docs/screenshots/study.webp)

### Prove

A topic is proven when you pass its mastery check (numbers you work out, answers you type, steps
you put in order), or when you work an exercise on paper, photograph it and have it marked
against a rubric. Before you see a question, the same model answers it again without the key; a
key it disputes is thrown out, and a question it could not check is marked on screen and never
counts as proof. That catches slips, not a misconception the model holds both times, so a check
is only as good as the model behind it. You can always skip a topic, and a skipped topic stays
marked as skipped, not as known.

![A passed mastery check, 8 of 9, with one worked answer and one wrong answer explained.](docs/screenshots/prove.webp)

### Remember

Flashcards are scheduled with FSRS-6, fitted to your own reviews once there are enough of them.
Anki decks come in with their media and review history and go back out as `.apkg`.

![A flashcard review: the seven base SI units, with four rating buttons and the next interval on each.](docs/screenshots/remember.webp)

### The atlas

Every topic in your library, placed by what it is about rather than which course it belongs to,
on a planet you can turn. Pick a course and it replays the order you finished its topics in, and
can save that replay as a video or a GIF.

![The course's topics as named territories on a planet, darker where more is proven, beside a list of regions.](docs/screenshots/atlas.webp)

## Why not a chatbot and Anki?

A chatbot will explain anything you ask, but it keeps no plan, does not know what you have
already proved, and never asks you about last month's topic. Anki keeps what you put in it, but
you write the cards. NotebookLM answers from your sources and can quiz you on them, but it keeps
no deadline and does not bring a topic back when you start to forget it. This app puts those in
one loop: the course, the date, the proof, the review.

## The model is the teacher

Lessons and questions are written by the model you connect, pitched at the few lines you wrote
about yourself. Switch to a newer model and the next lessons it writes are better, with no
update to the app. Lessons already written stay as they are until you regenerate them.

A hosted model is the right choice for most people. The open models an 8 GB graphics card can
run write weaker lessons and write them slowly; the ones that teach well want 24 GB or more of
video memory. Hosted is also cheap here, because a lesson is written once and kept: the
maintainer's own study with a fast, low-cost model (GLM-5.3-Flash on OpenRouter) cost about
US$0.20 per day of study, about US$4.40 a month, read from the key's usage on 24 September 2026.

The first screen connects one: **Connect OpenRouter** signs you in and brings back a key you own,
or paste a key for OpenAI or any OpenAI-compatible service, or point it at Ollama, LM Studio or
llama.cpp. Without a model the app still opens your courses, their saved lessons and questions,
and your flashcards, and writes nothing new.

## Your data

Your library is one SQLite file on your own disk. There is no account, and nothing reports back
to this project. What leaves the machine is what a lesson or an answer needs, sent to the model
provider you chose under your own key; and, while the model drafts a new course, search queries
written from its topic titles, to find reading for them (on by default, one switch in Settings).
Web search inside answers and a daily update check stay off until you turn them on.
[SECURITY.md](SECURITY.md) lists every outbound connection and how to check the list with a
packet capture.

## Install

**Desktop.** Download the zip for your system from the
[releases page](https://github.com/ValeraZSD/terramentor/releases), unpack it and start
`Terramentor.exe` (Windows), `Terramentor.app` (macOS, Apple Silicon) or `./terramentor.sh`
(Linux). It carries its own runtime. The launcher is unsigned, so Windows asks once
(*More info → Run anyway*) and macOS wants a right-click → *Open* the first time.

**Docker**, for a server or an always-on machine:

```bash
curl -O https://raw.githubusercontent.com/ValeraZSD/terramentor/main/docker-compose.yml
docker compose up -d
```

Then open <http://127.0.0.1:3001>.

**From source** (Node.js 22.19 or newer):

```bash
git clone https://github.com/ValeraZSD/terramentor.git
cd terramentor
npm install
npm run standalone
```

Updates, the Docker password, reaching your library from a phone and what 1.0 promises are in
[docs/INSTALL.md](docs/INSTALL.md). The interface comes in twelve languages; English aside, each
began as a machine translation, and corrections are welcome ([docs/I18N.md](docs/I18N.md)).

## Documentation

- [First steps](docs/GETTING_STARTED.md): a five-minute tour for a new learner.
- [Install and update](docs/INSTALL.md): desktop, Docker, from source, phone access, upgrades.
- [Why it exists](CoreIdea.md): what this is for, and what it is not.
- [Architecture](docs/ARCHITECTURE.md): how it is built and why. Start here to contribute.
- [Technical reference](TECHNICAL_DOCUMENTATION.md): schema, engines, API.
- [Security](SECURITY.md): threat model and every outbound connection.
- [Contributing](CONTRIBUTING.md), [Roadmap](ROADMAP.md), [Changelog](CHANGELOG.md).

Found a wrong lesson or a bug? **Settings → General → About → Report a problem** fills in GitHub's
form for you to check and send. A factually wrong lesson is one of the most useful reports this
project gets.

## Licence

Copyright © 2026 Valerii Kozhevets (ValeraZSD). **AGPL-3.0-or-later**, see [LICENSE](LICENSE);
third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The running app
links to its own source under Settings → General → About, as AGPL §13 asks of software used over
a network.

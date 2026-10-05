# Getting started

A five-minute tour of the study loop: **Discover → Plan → Study → Prove → Remember**. The words
it uses are defined in the [glossary](#glossary) at the end.

## Before you start

**Install.** Download the zip for Windows, macOS (Apple Silicon) or Linux from the
[releases page](https://github.com/ValeraZSD/terramentor/releases), unpack it anywhere and start
it; it carries its own runtime, so nothing else is installed. Its window is drawn by a
Chromium-family browser already on the computer (Edge, Chrome and the like); with none, it opens
in your default browser as a tab and works the same. The steps for each system, and
where your data is kept, are in [DESKTOP.md](DESKTOP.md). Docker and running from source are in
the README's [Install](../README.md#install) section.

**What a model costs.** The app is free; the model is paid to whoever runs it. With a hosted
model you pay the provider per use, under your own key. One measurement, not a promise: the
maintainer's own study with a fast, low-cost hosted model (GLM-5.3-Flash on OpenRouter) cost
about US$0.20 per day of active study, about US$4.40 a month, read from the key's usage on 24
September 2026. Your cost depends on the model, the subject and how much you study. A lesson is
written once and kept, so reading it again costs nothing, and the provider's dashboard shows
what you have spent.

**What a local model needs.** A model on your own computer costs nothing per lesson but needs
the hardware. A typical 8 GB graphics card runs only smaller models, which write weaker lessons
and write them slowly; the open models that teach well want 24 GB or more of video memory, or a
large amount of system memory, and then they run slowly. For most people a hosted model is the
better start.

## The welcome screen

A new library opens on four short steps before anything else:

1. **Language and theme.**
2. **About you**: what the tutor should call you, what you do, what you already know and where
   you are weaker, and how you like things explained. Every question is optional. The answers
   are stored on your computer and sent with each request to the model provider you connect, so
   lessons start at your level. Edit them later in Settings → Learning → *Learner profile*.
3. **A model.** The model writes every lesson, diagram and question, so this is the step that
   matters. **Connect OpenRouter** signs you in at openrouter.ai and brings back a key you own
   (you can cap or revoke it there); or paste a key for OpenAI or another OpenAI-compatible
   service; or point it at a server on your own computer (Ollama, LM Studio, llama.cpp), which
   only teaches well on a large graphics card. Then pick a model from the list: a recent one from
   a major lab, and a fast, low-cost one is enough for most subjects.
4. **Done**, and on to your first project.

Every step can be skipped, and Settings changes any of it later. Skipping the model step means
the app opens your courses, lessons and flashcards but writes nothing new until a model is
connected. After that, the *Getting
started* checklist at the top of the feed is the short version of this page: five steps, each
ticked by doing the thing.

## The feed

The home page is a **learning feed**. The app decides what comes next and you scroll; a course
or a single topic streams the same way from its own **Study** button.

Cards come in a few kinds:

- **Lesson**: a short piece of teaching for the topic you are due to study. Long topics arrive as
  several parts, in order.
- **Question**: a check right after the lesson. Answer it; being wrong is useful information, not
  a penalty.
- **Flashcard**: a spaced-repetition review of something you learned earlier.
- **Recall**: a question from a topic you did well on earlier, resurfaced before you forget it.
- **Paper practice**: near the end of a topic, an exercise to work by hand. Photograph the page and
  it is marked against a rubric, or mark it yourself. It can be switched off in Settings →
  Learning.
- **Checkpoint**: the end of a topic, where you can complete it or take its mastery check.

Overdue work is served first. That is the whole catch-up mechanism: no nagging banner, the feed
gives you what you are behind on.

## Projects and the tree

A **project** is one learning goal: a course, an exam, a skill. Open one from the Projects tab.

Inside, topics form a tree. Two rules are worth knowing:

1. **A leaf is what gets proved.** A leaf is a topic with no sub-topics under it. Parents just roll
   up their children's progress.
2. **Notes are material, not structure.** A topic can carry note children (readings, worked
   examples) and still be a leaf. Notes are never scheduled and have no status of their own: they
   are what the topic is *made of*.

You can build a project by hand, or describe it and let the AI draft the whole curriculum. The
draft is written in the language you chose, else the one your description is in, and it runs in
the background: its screen shows each stage and an estimate of the time left, closing it does not
stop it, and the task bar at the bottom of every page shows how far it has got. Up to three drafts
run at once on a hosted model; on a model running on your own computer the next one waits its turn.

## Scheduling and pace

Set a start date and a deadline with **Set Schedule**, and the app spreads the work across your
topics, weighted by depth, so a topic with ten sub-topics gets more days than a single idea.

**Pace** compares what you have actually closed against what the schedule expected by today. It is
not calendar-linear: being on track means you have finished the topics that were scheduled to be
finished by now.

Fallen behind? Two honest options, and no third:

- **Catch up**: the feed already serves overdue topics first.
- **Recalibrate**: redistribute the *remaining* topics over the *remaining* time. It lives in the
  workspace, deliberately not on the home page: moving a deadline should be a decision, not a
  reflex.

## Proving it: the mastery gate

Marking a topic complete can be intercepted by the **mastery gate**, which offers a **mastery
check**: a short quiz on that topic alone.

Three modes, in Settings → Learning → *Proving a topic*:

- **Just track**: completion is never questioned.
- **Ask me**: you are asked to prove it, but "mark done anyway" is always there.
- **Require proof** (the default, marked *Recommended*): completion needs proof.

**Skip** is available in every mode. Skipped means *"I moved on without proving it"*: it counts as
closed for progress and pace, but it is tracked separately from a verified completion. The point is
that the app never has to lie to you about what you actually know.

Got a question wrong? On the review screen every missed answer offers **Teach me this** and a video
search, so you can close the gap without leaving the app.

## Remembering: reviews and recall

Learning something once is not knowing it. Two mechanisms fight the forgetting curve:

- **Flashcards**, scheduled by **FSRS-6**. Rate a card by how hard it was; easy cards come back in
  weeks, hard ones tomorrow, and "Again" means minutes. The scheduler fits itself to your own
  review history once there is enough of it.
- **Recall cards**: saved questions from topics you did well on and have not practised for a
  while. Answering one refreshes both the estimate and the timer.

This is what makes the plan cumulative instead of a checklist you sweep once and forget.

## The Vault, capture, and the assistant

Three ways to bring things in and out:

- **The Vault**: upload PDFs, notes and documents to a project. They are indexed and searched when
  the AI answers questions about that project, so the tutor works from *your* material, not only
  its own knowledge.
- **Capture** (the inbox icon in the header, or press **c**): paste an article or a link you want
  to keep. It lands in your Inbox project, gets an overview, flashcards and a couple of questions
  written for it, and joins the feed and your reviews the same day.
- **The assistant** (the speech-bubble icon, press **a**, or **Ask the assistant** in a topic): it
  sees every project at once. Ask what to do today, what to drop when you are behind, or about
  whatever is on screen; with a topic open it knows that topic, your notes on it and its
  documents, and teaches it. It can look up a course's progress for itself and read the documents
  in your library page by page, and it can prepare a mastery check, a flashcard, a note for your
  Inbox or a problem report, but nothing is added or sent until you press the button under its
  answer. **New chat** starts a fresh conversation; the clock icon lists the earlier ones.

All of it is written by the model you connected on the welcome screen; change it in Settings → AI
& Models. Your library itself stays on this machine.

## What to do next

1. Go to **Projects** and create your first one: describe what you want to learn and let the AI
   draft the curriculum, or build it yourself.
2. Give it a deadline.
3. Come back to the feed tomorrow.

## Glossary

The words the app and these documents use, each in one place.

- **Project** (also *course*): one learning goal, such as an exam, a subject or a deck.
- **Phase**: a top-level part of a project's tree, planned as one block of the schedule.
- **Section**: any entry in the tree that has topics under it. A deck's rows are sections too.
- **Topic**: an entry with no topics under it; the unit that is taught, scheduled and proved.
  The technical documents call it a *leaf* (a *work leaf* when the distinction from a deck's
  page-sized slices matters).
- **Note** (*Material*): reading attached to a topic, such as a worked example. A note is part
  of its topic, never a topic of its own, and is never scheduled.
- **Overview**: the short text that introduces a topic, usually written by the model.
- **Lesson part**: one card of a topic's lesson. A long topic is taught as several parts, shown
  as "Part 2 of 4".
- **Question**: a check in the feed right after a lesson part. Practice only; one answer never
  closes a topic.
- **Mastery check**: a set of questions drawn from a topic's bank. Passing it is what makes the
  topic **proven**.
- **Proven, done, skipped**: proven means passed a mastery check (or the evidence reached the
  same bar); done means closed; skipped means closed without proof, and stays visibly different.
- **Recall question** (a *Recall* card in the feed): a question from a topic you did well on and
  have not practised for a while, brought back before you forget it. Practice quizzes add the
  same kind as "review questions from earlier topics". The code and the technical documents
  call them *ghost questions*.
- **Flashcard**: a card reviewed on the FSRS-6 schedule; "Again" brings it back in minutes.
- **Head start**: a topic the placement check or another project suggests you already know. It
  is taught as a shorter review and offers the mastery check first; it never counts as proof.
- **Pace**: what you have closed against what the plan expected by today.
- **Inbox**: the permanent project that captured links, text and photos land in.
- **Vault**: the documents you upload, to a project or to the whole library, which the tutor
  and the assistant can read.

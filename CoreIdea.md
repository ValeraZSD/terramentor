# Core Idea

Terramentor plans a course in a subject you choose, teaches it, checks that you know it, and
brings it back before you forget. An AI model you connect does the teaching; the app plans,
checks and keeps the record. It is open source, and your library stays on your own machine: what
a lesson or an answer needs goes to the model you connect, and every other connection the app can
make is listed in `SECURITY.md`.

## Why it exists

Learning something large on your own, such as machine learning, organic chemistry or a language
to C1, takes months. The usual tools each cover one part of that. Anki schedules reviews but does
not teach. Video courses teach but do not check what stayed. Streak apps count whether you
opened them.

The whole job has five parts: decide what to learn, plan it against a deadline, study it, prove
you know it, and still know it next month. Terramentor does all five in one place.

## Who it is for

People learning something deep in their own time: a resident preparing for boards, someone
moving into software after another career, a student with an exam a year away. They have jobs and
families, so the plan has to survive missed days. They want to know the material, not to watch a
counter go up. And they want their notes and answers to stay theirs.

## The loop

```
Discover → Plan → Study → Prove → Remember → Repeat
```

**Discover.** Describe what you want to learn. The model drafts a curriculum while you watch,
with resources for each topic. Everything in it stays editable.

**Plan.** Set a start date, a deadline and the days you study. The scheduler spreads the topics
over those days, gives broader topics more of them, and puts foundations first. When you fall
behind, one click re-plans from today.

**Study.** The home page is one stream of cards: the lesson that matters most today, questions
on it, and the reviews that are due. You can also open one course or one topic and study only
that. Read, take notes, ask the assistant, or work a problem on paper and photograph it.

**Prove.** When you think you know a topic, take its mastery check: a set of questions drawn from
the topic's bank. Pass, and the topic counts as proven. You can still close a topic without it,
and it stays unproven, so you can always tell the two apart.

**Remember.** Flashcards are scheduled with FSRS-6. A proven topic starts to fade after a set
number of days, and questions from fading topics come back as recall questions, in the feed
and in your practice quizzes.

**Repeat.** The schedule adjusts, and the reviews keep coming.

## Principles

1. **You decide.** Close, skip, reorder or edit anything. The app advises; it does not lock.
2. **It tells you where you stand.** If you are behind, it says so. If you scored 45%, you see
   45%. The atlas shows what is proven separately from what is ticked off.
3. **Missed days are expected.** Re-planning, soft gates and review scheduling exist because
   life interrupts study.
4. **Your data stays yours.** One SQLite file on your disk. No account, no telemetry. The model
   is a hosted one you pick or one you run yourself, and every outbound connection the app can
   make is listed in `SECURITY.md`.
5. **You can leave with everything.** Courses export as JSON or as one bundle file, decks as Anki
   `.apkg`, and the database opens in any SQLite tool.
6. **Hard subjects get structure.** Phases, foundations first, and review mixed in with new
   material.
7. **AI gets better, so do you.** No model is built in. The lessons are as good as the model
   you connect, and the next ones get better when you switch to a better model.

## What it is not

- **A folder for material you already have.** It does the whole job: the model you connect
  writes the course, its lessons, visuals, questions and cards, so you need no material to start.
  If you do have some, bring it in: a course file or an Anki deck becomes a course, and the
  assistant reads the documents you upload (a textbook, past papers, your notes).
- **Only flashcards.** Cards are for what has to be memorised. Understanding is taught and
  checked separately.
- **Streaks and points.** It tracks what you learned, not how often you opened it.
- **A classroom.** There is no teacher and no class. You set the curriculum.
- **A shortcut.** It plans, schedules and tests. The learning is still yours to do.

## In one sentence

An open-source AI tutor that plans, teaches and checks what you learn, keeps it from fading, and
keeps your library on your own machine.

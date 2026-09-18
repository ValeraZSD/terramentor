# Core Idea

## Why This Exists

Every serious learner eventually hits the same wall. You decide to learn something real, machine learning or organic chemistry or systems programming or constitutional law, and the tools available to you were designed for something else entirely.

Duolingo teaches you to maintain a streak, not to achieve fluency. Coursera teaches you to watch videos, not to retain knowledge. Anki teaches you to memorize flashcards, not to understand concepts. Notion teaches you to organize notes, not to internalize them.

Each of these tools solves one narrow problem and ignores the rest. None of them help you with the full arc: **figuring out what to learn, planning how to learn it, practicing it daily, proving you know it, and remembering it next month.**

That full arc is what this app is for.

---

## The Problem in One Sentence

**Self-directed learners of complex subjects have no single tool that respects their intelligence, protects their time, and tells them the truth about what they actually know.**

---

## Who This Is For

Not the casual learner who wants to "pick up some Spanish." Not the student who just needs to pass tomorrow's exam.

This is for the person who:

- Wants to learn something **deep**: a domain that takes months, not minutes
- Is willing to work hard but hates wasting time on the wrong material
- Has a full life (job, family, other commitments) and needs a plan that survives reality
- Cares about **knowing** the material, not just checking boxes
- Values their privacy and doesn't want their learning data training someone else's model
- Will share good study materials but refuses to be locked into a platform

They are the medical resident studying for boards at 2 AM. The career-changer learning to code between shifts. The PhD student mapping out a literature review. The autodidact who has always learned better outside classrooms than inside them.

They don't need gamification. They need **architecture**: a structure that makes their self-directed effort work.

---

## The Three Lies of Modern Learning Apps

### Lie 1: "You're making progress!"

Progress indicators that measure **activity** (lessons completed, hours logged, streaks maintained) instead of **knowledge** (can you explain it? can you apply it? will you remember it in a week?). These apps make you feel productive while you forget everything.

**Our counter**: Progress is measured by **verified mastery**, not task completion. You can mark a topic done whenever you want; the app won't stop you, but it will tell you the truth about whether you've proven you know it. A hollow checkmark means "I moved on." A solid one means "I earned this."

### Lie 2: "Stay motivated with streaks and rewards!"

Extrinsic motivation (streaks, hearts, leaderboards, arbitrary level locks) creates brittle habits. When the streak breaks, and it always does, the learner quits. The app becomes another source of guilt rather than a source of learning.

**Our counter**: We build for **intrinsic motivation**: the satisfaction of genuinely understanding something, the pride of passing a challenge you weren't sure you could handle, the relief of a schedule that forgives you when life interrupts. Recalibration isn't a workaround; it's a core feature. Falling behind isn't failure; it's information.

### Lie 3: "Trust the algorithm."

Black-box systems that decide what you study next, when you study it, and whether you've learned it, without letting you see the reasoning or override the decision. The learner is a passenger, not a driver.

**Our counter**: You own the plan. You can reorder topics, add your own resources, skip what you already know, spend extra time on what's hard, and override any suggestion. The AI is your research assistant and study partner, not your boss. Every decision is visible and editable.

---

## How It Works: The Learning Loop

The app implements a single, repeating loop that mirrors how real learning actually happens:

```
Discover → Plan → Study → Prove → Remember → Repeat
```

### Discover

You describe what you want to learn. The AI thinks out loud (you can watch), then builds a structured curriculum with real, verified resources. You see the tree before it's committed. You can edit, reorder, or delete anything before accepting.

### Plan

You set your constraints: start date, deadline, study days. The scheduler allocates the calendar proportionally, giving more days to broader topics and fewer to narrow sub-topics, and reports the plan as topics per study day. How long a topic takes you is yours to judge, and an app that guessed it would only be guessing. It phases the schedule so you learn foundational concepts before advanced ones. And when life happens, one click recalibrates from today forward, no guilt and no manual rescheduling.

### Study

Each day, the app tells you what to focus on right now: one thing, not fifty. You study your way: read the resources, take notes, chat with the Socratic tutor, write code, solve problems. The app doesn't prescribe a study method. It just makes sure the right topic is in front of you at the right time.

### Prove

When you think you know a topic, the app offers to verify. This is the "Boss Fight": a quiz drawn from the material. It's not a tollbooth blocking your path. It's an invitation: *"You think you've got this? Prove it."* If you pass, you earn a verified completion. If you don't, you know exactly what to review. And if you need to move on anyway, you can; the topic gets marked as "skipped," not "completed," so you always know what you've mastered versus what you've merely encountered.

### Remember

Everything decays. The app knows this. Completed topics enter a review schedule based on spaced repetition, covering entire concepts and not just flashcards. The daily study queue mixes new material with review of older topics, forcing interleaved practice. Ghost questions from decaying areas appear in current quizzes, mimicking cumulative exams. The question isn't "did you learn this?" but "do you still know it?"

### Repeat

The loop continues. The schedule adapts. The review queue keeps you honest. And gradually, through structured effort and honest self-assessment, you build genuine expertise.

---

## Design Principles

These are the rules that keep the product honest. Every feature decision is measured against them.

### 1. The Learner Is Sovereign

The user can always override the system. They can mark anything complete, skip anything, reorder anything, edit anything. The app advises; it never commands. Hard locks and forced paths are antithetical to self-directed learning.

### 2. Honesty Over Comfort

The app tells you the truth, even when it's uncomfortable. Your pace is behind. Your retention has decayed. You scored 45% on that quiz. This information is a gift, not a punishment: you can't fix what you don't know is broken.

### 3. Forgiveness Is a Feature

Real life interrupts study. The app anticipates this. Recalibration, soft gates, and review scheduling all exist because humans are human. A learning tool that punishes imperfection is a tool people abandon.

### 4. Privacy Is Non-Negotiable

All data stays on your machine. SQLite, not the cloud. A local model by default; if you point the app at a cloud model instead, that is a choice you make in Settings, with the app telling you what it sends. Your notes, your quiz answers and your study habits are yours. The app never trains on your data and never requires an account.

### 5. Open Means Open

The code is readable. The database is a single SQLite file you can inspect with any tool. The export format is plain JSON. There is no vendor lock-in, no proprietary format, no "export your data" button that gives you half the information. If you ever want to leave, everything comes with you.

### 6. Complexity Demands Structure

For simple subjects, any approach works. For complex ones, the kind this app targets, you need structure. Phases before topics. Prerequisites before advanced material. Review before new content. The app provides the scaffolding; you provide the effort.

### 7. Verification Distinguishes Confidence from Competence

Confidence is feeling like you understand something. Competence is demonstrating it under pressure. The app helps you close that gap. Not by blocking you, but by offering you the chance to prove yourself, and by being honest when you haven't yet.

---

## What This Is Not

- **Not a course platform.** We don't host content. We organize your learning around content that already exists: textbooks, documentation, videos, papers, whatever works for you.
- **Not a flashcard app.** Flashcards are one tool in the toolkit, not the toolkit itself. We use them for memorization but don't reduce all learning to memorization.
- **Not a habit tracker.** Streaks and daily goals are motivational theater. We care about whether you learned, not whether you showed up.
- **Not an LMS.** There's no teacher, no classroom, no grades. You are both the student and the headmaster of your own curriculum.
- **Not a replacement for effort.** No app can learn for you. This one structures your effort, schedules your time, and tests your knowledge, but you still have to do the work.

---

## The Open-Source Promise

This project is public now, and it will attract a specific kind of person: someone who has been waiting for a tool that takes their self-education seriously.

They will come because:

- **Their data is theirs.** SQLite on their disk, Ollama on their GPU, and no cloud, account or tracking anywhere.
- **Their curriculum is theirs.** AI-generated but fully editable. Exportable as JSON. Shareable on GitHub. A medical student can curate the perfect anatomy tree and let a thousand others import it.
- **Their model is theirs.** Run Llama locally for privacy. Switch to a cloud model for heavy work. Swap the "brain" without changing the workspace.
- **Their progress is honestly tracked.** Not gamified, not inflated, not manipulated. Verified completions are verifiable. Skipped topics are marked as skipped. The dashboard tells the truth.
- **Their schedule forgives them.** Recalibrate whenever you need. No guilt. No rebuilt streaks. Just a fresh plan from today forward.

This is a tool built by learners, for learners. It exists because the people who made it needed it themselves. Every feature was born from a real frustration: *I want to learn this complex thing, and nothing out there actually helps me do it right.*

---

## The One Sentence

**A local-first, open-source mastery engine that helps self-directed learners plan, practice, prove, and retain complex knowledge, with full control and total honesty.**

---

## The Deeper Sentence

We believe that the most important learning in a person's life happens outside of institutions, driven by curiosity and necessity, not by syllabi and grades. The tools for that kind of learning should be as rigorous as a university, as forgiving as a friend, and as honest as a mirror. This app is our attempt to build those tools.
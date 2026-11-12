# Roadmap

Terramentor is a free study app that runs on your own computer. An AI model you connect writes
the course, its lessons and questions; the app plans the course against your deadline, tests
whether you know each topic, and brings back what you are starting to forget. That works today.
This page is the direction from here, not a schedule.

## Where it is going

**Your library on every device.** Today it lives on one computer, and a phone reaches it over
your own network. Next, the app runs on each of your devices, and they keep each other up to date
through a server that stores only encrypted copies it has no key to. Reviews will then work on a
phone with no connection, and after that the app can go into the app stores.

**Catching the model's mistakes.** The lessons and questions a model writes are checked before
you see them; one that fails a check is thrown away, not shown, and anything wrong that gets
through can be flagged where it appears. Every kind of mistake that gets through is a check
still to be written. Recall questions will get better at finding what you have started to
forget. A tutor you can talk to is planned too, with your speech turned into text on your own
computer, not in someone else's cloud.

**More languages.** The interface comes in twelve languages, all machine-translated first. Next
are more languages, the server's messages in yours, and native speakers reading the translations.

**Courses you can share.** A course can already be exported as one file, and each item in it
says which model wrote it. Next, a course you imported can receive its author's corrections and
new editions.

## Not doing

- **Requiring an account to learn.** The app runs on your computer and your library is a file on
  your disk. Syncing between devices will be something you switch on, not a condition of use.
- **Tracking how you use it.** No telemetry, analytics or crash reporting. [SECURITY.md](SECURITY.md)
  shows how to check this with a packet capture instead of taking our word for it.
- **Gamification.** No streaks, points or leaderboards. The app sends no notifications, and how
  often you open it is not something it tries to raise. The measure is whether you can prove you
  know the material ([CoreIdea.md](CoreIdea.md)).
- **Rationing learning.** No daily lesson limit, no locked topics, no feature held back to sell
  an upgrade.
- **Lock-in.** Courses export as files, decks as Anki packages, and the database opens in any
  SQLite tool.
- **A cloud-only version.** If Terramentor runs on a server for people who cannot install it, it
  is the same app, and the AGPL means any copy offered over a network publishes its source.

## Where help counts most

Read the interface in a language you speak natively and fix what sounds wrong: one file per
language, see [docs/I18N.md](docs/I18N.md). For anything bigger, open an issue first so two
people do not build the same thing.

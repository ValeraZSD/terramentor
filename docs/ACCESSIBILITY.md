# Accessibility

Last reviewed: 18 November 2026. This page describes the code on `main` on that date.

## In short

- **Seeing.** In the app, Settings → General → Text & interface size makes everything up to
  160% of its usual size. Settings → Accessibility → Contrast → Higher gives darker text and stronger
  lines. Zoom beyond that has not been tested.
- **Reading.** Settings → Accessibility has wider letter, word and line spacing and a reading
  line (a band under the line you point at, like a ruler). Read aloud speaks cards, questions,
  lessons, notes and assistant answers with your computer's own voices, at 50 to 200% speed.
  No screen has been checked for cut-off text at the widest spacing.
- **Keyboard only.** Studying, card review and quizzes work from the keyboard, and lists and
  cards move without a drag. Resizing the sidebar and the detail panel still needs a mouse. In
  a card review a digit key rates the card even when a button has focus; Confirm before
  grading makes every answer and rating take two presses.
- **Screen reader.** Card review, quiz answers and maths are read out; this is checked with
  NVDA, and no other screen reader has been tried. Results of drills and quizzes are shown but
  not read out yet.
- **Time and attention.** Motion → Reduced stops movement. Timed drills can have two or three
  times as long, or no clock; quizzes have no clock; a mock exam's clock is optional and can
  be paused. In a drill, a right answer moves on by itself after a short pause. The app sends
  no reminders or notifications. Notices on screen close by themselves after 4 seconds (8 for
  an error) unless the pointer or focus is on them. Animations a model writes are not checked
  for flashing.
- **Something does not work for you?** See [Reporting a barrier](#reporting-a-barrier).

The rest of this page has the detail: what helps, what does not work yet, how it is checked,
and a report against each WCAG 2.2 rule.

## The target

Terramentor aims at [WCAG 2.2](https://www.w3.org/TR/WCAG22/) level AA. It **does not conform
yet**: some parts of the app itself do not meet every success criterion. The report below
records how far it has come and what is still missing.

The main reasons, each described under [Known gaps](#known-gaps):

- Some structures are drawn for the eye and not described to assistive technology: the outline
  tree, the calendar grid, and the status icons on topics.
- Some results are shown but not announced: drill verdicts, quiz results and the result of a
  mastery check.
- Much of what you study is written by a model (lessons, diagrams, charts, animations,
  assistant answers), and the app cannot promise that every piece of it is accessible.

The [conformance report](#conformance-report-wcag-22) at the end goes through every criterion.

## What helps

**Settings → Accessibility** has four groups:

- Seeing: Contrast (Standard, Higher, or System) and Motion (Full, Reduced, or System).
  Higher gives darker text and stronger borders and lines. Reduced stops movement in the app;
  only the ring that fades out round a dropped item stays.
- Reading: letter, word and line spacing, each in three steps. The widest step uses at least
  the spacing that WCAG 1.4.12 names. Reading line puts a band under the line you point at in
  lessons and notes.
- Listening: Read aloud adds a speaker button to cards, questions, lessons, notes and
  assistant answers, using the voices installed on the computer; nothing is sent anywhere.
  Reading speed goes from 50 to 200%. Play card recordings by themselves can be switched off.
- Time and answers: Time limits gives timed drills normal time, twice or three times as long,
  or no clock. Confirm before grading makes the first press on an answer or a rating select
  it and the second grade it.

On a device with a keyboard, the same section lists every keyboard shortcut and has a
Single-key shortcuts switch that turns off every shortcut that is a single letter or digit.

Elsewhere in the app:

- Settings → General: the theme can follow the system's light or dark mode, and Text &
  interface size goes from 80 to 160%.
- Settings → Learning → Forgive spelling slips (off by default) marks a typed answer right
  when a word of five letters or more has one letter dropped, doubled or added, or two
  neighbouring letters swapped (two such slips from nine letters), and shows the right
  spelling. Words under five letters, numbers, a changed first or last letter, and words in
  scripts written without spaces (Chinese, Japanese, Thai) are never forgiven.
- Settings → AI & Models → Describe card pictures lists every card picture beside its
  description, so a description a model wrote can be checked and corrected.
- A Skip to content link leads past the header. Each area (a course, Settings, the
  dashboard) sets its own page title, each screen has one main heading, and moving to another screen is announced.
- In a card review session, each new card and, on Reveal answer, its answer are read out
  once. Space on a focused button presses that button instead of turning the card.
- In the feed, Enter submits a typed answer and the verdict is announced.
- The assistant labels each message with who wrote it and announces an answer once, when it
  has finished streaming.
- A list item or card that can be dragged can also be moved without a drag: Move earlier and Move later
  in an item's menu, or the arrow keys on its handle, with the item and its new place
  announced.
- Course text (lessons, feed cards, flashcards) carries the course's language, so a screen
  reader reads a Dutch course with a Dutch voice in an English interface.
- Maths is drawn by KaTeX, which also writes it as MathML for screen readers. Copying a
  formula gives its TeX.
- An AI chart or diagram is named by its title and has a text version: a chart's rows as a
  table, a diagram's arrows as a list.
- A card picture is read by its alt text from the deck or by its stored description, never by
  its file name.
- The atlas map can be moved and zoomed with the keyboard and with buttons, and its index
  lists the same regions, courses and topics as text.
- In Windows High Contrast and other forced-colour modes, the current page, the chosen option
  and a switch that is on are marked with an outline in a system colour.
- Quizzes and the mastery check have no clock. A mock exam drawn from a course's own
  questions has an optional clock of 1 to 600 minutes, and every mock exam clock can be
  paused.

## Known gaps

Each of these is in the code on the date above.

- The outline tree has arrow keys but is not marked up as a tree. A topic's status (done, in
  progress, overdue, skipped) is an icon with no text, and the status button does not say the
  current status.
- The month calendar's days are buttons named by their full date, but the grid is not
  exposed as a table of weeks, today is marked only by colour and a ring, and on a phone a
  day's dots tell courses apart by colour alone.
- Drill verdicts, a quiz's "Question N of M", quiz results and the mastery check's result are
  shown but not announced.
- During a card review, keyboard focus stays in the session, but a screen reader's browse mode
  can still move into the page behind it.
- In a topic's own card list, turning a card over is read only as "pressed"; the answer has to
  be read by moving to it. In a review session, a rating and Undo are not announced, and a
  digit key rates the card even while a button has focus.
- The search box and the notes box are named only by their placeholder text. Search results
  are not exposed as a list that a screen reader can follow while the arrow keys move through
  them.
- The code editor in code questions has no accessible name.
- The sidebar and the detail panel can only be resized by dragging with a mouse. The corners of a photographed
  page in paper practice move by dragging or with the arrow keys, with no single-tap way.
- On a primary (accent-coloured) button the keyboard focus ring is the button's own colour,
  so focus there shows only as a slightly larger button.
- Notices and the task dock are fixed to the screen and can cover the control that has focus.
- Notices close after 4 seconds, or 8 for an error, unless hovered or focused. In a drill, a
  correct choice moves on to the next item after a short pause.
- Few form errors are tied to their field for assistive technology; most are shown as text
  beside it.
- Paper practice is written on paper and either photographed for marking or marked by
  yourself against the solution. There is no way to answer it on screen.
- Card recordings have a play button, but a card has no place for a transcript.
- Content a model writes is not guaranteed to be accessible: lessons, diagrams, charts,
  animations and widgets, and assistant answers. A chart or diagram has a text version; a
  p5 sketch or a widget built from code has only its name. Animations are not checked for
  flashing. A model may use colour alone to tell things apart.
- Assistant answers, and the text of a course with no language set, are marked with the
  interface language even when written in another.
- The atlas map is drawn for the eye. Its index carries the same information as text, but
  topics cannot be picked on the map itself from the keyboard.
- The desktop app opens in its own browser profile, so settings and extensions from your
  everyday browser (a minimum font size, a high-contrast or reading extension) do not carry
  over, and the browser's page translation is switched off in it.
- Videos and recordings that a course links to or imports come with whatever captions or
  transcripts their author gave them.

## Reporting a barrier

Open the
[accessibility form](https://github.com/ValeraZSD/terramentor/issues/new?template=accessibility.yml)
on GitHub. It asks what you were trying to do and what got in the way; the tools you use, your
system and the screen are optional. You do not need to know which rule it breaks. Filing an
issue needs a GitHub account.

A report is treated as a bug and labelled `accessibility`. The tracker is public, so leave out
anything private.

[SECURITY.md](../SECURITY.md) is for security vulnerabilities only. An accessibility barrier is
not one; use the form above.

## How it is checked

These run without a person and without a model. Each gate fails when what it checks gets worse.
The NVDA run is the exception for speech: what NVDA did not say is recorded as a miss, and only
a page that did not do the thing fails it.

**axe in a real browser.** `tools/axe-gates.mjs` builds the app, opens it in headless Edge or
Chrome on an invented course, and runs [axe-core](https://github.com/dequelabs/axe-core) with
the WCAG 2.0, 2.1 and 2.2 A and AA rules plus Deque's best practices. It covers 22 screens:
Today, Projects, a new course, a course's dashboard, its outline, a topic with its quizzes and
cards tabs, a lesson, the timeline, the course calendar, the course's files, the calendar for
all courses, the atlas, the front and back of a flashcard in review, the assistant, and the
General, Accessibility, Learning, AI & Models and Web & research sections of Settings. Each is
scanned in light and dark, at desktop width (1,280 px) and phone width (390 px): 88 scans. The
allowed failures are listed in `tools/axe-allowlist.json`, which may only shrink; it is empty,
so one failure on any screen fails the gate. Before trusting a scan, the gate shows axe a
broken button and checks that axe reports it. It runs in `npm test` and on the Windows leg of
the checks on every pull request.

**Lint rules for the source.** `tools/a11y-lint-gates.mjs` runs oxlint's `jsx-a11y` rules over
`src/`. Findings beyond `tools/a11y-lint-allowlist.json` fail it, and that list may only
shrink; the file holds the current counts. Many are a rule that cannot see
what a shared component renders, such as a `role="switch"` on the app's checkbox, which is a
real checkbox underneath. Two rules that ask for a different tag rather than flag a barrier are
off, with the reason in the gate. A comment that switches a rule off in one place fails it too,
unless the gate lists that place with a reason (one does today). Before trusting a run, the
gate checks that oxlint reports a planted image with no alt text.

**A real screen reader.** `.github/workflows/screen-reader.yml` starts NVDA on a Windows
runner and drives it with Guidepup through a flashcard review, a quiz question, a card with
maths and a keyboard reorder. What NVDA spoke is kept as an artifact of the run. It runs when
started by hand or when its own files change; it is not part of every build. It needs a
Windows machine where a screen reader may take over the screen and the speakers for several
minutes, which is why it runs on a CI runner and not in `npm test`.

Latest result, 18 November 2026, NVDA 2026.3 with Microsoft Edge:

- Card review: after Reveal answer NVDA reads the answer ("A lens"); a rating is not confirmed
  aloud, but the next question is read. In browse mode it also reads, and can press, the page behind
  the review.
- Quiz: an option is read with its text and its pressed state, and choosing one is answered
  by "Correct". The first option is 22 presses of Tab from the top of the page; Skip to content shortens
  that.
- Maths: ten to the power minus two is read as "10 to the negative 2 power" and one
  thousandth as "1 over 1000". In a topic's own card list, turning a card over says only "pressed".
- Reordering: the handle explains how to move it, and each move ("is over Light and
  telescopes") and the drop ("Dropped The night sky at Light and telescopes") are read.

**Behaviour tests.** These suites in `tools/` run in `npm test`:

- `a11y-behaviour-gates.mjs`: where focus goes and what is announced when something changes,
  such as an answered question, the first card of a review, the end of an assistant answer
  and an item moved from the keyboard.
- `dialog-gates.mjs`: a modal dialog has a name, takes focus, keeps Tab inside, closes only
  the top dialog on Escape and gives focus back; notices sit in a live region.
- `keyboard-gates.mjs`: one Escape press is answered by one surface, the atlas steps back one
  layer per press, and a menu hands focus back to its button.
- `accessibility-settings-gates.mjs`: the Motion setting reaches every animation, the widest
  spacing is at least the values in WCAG 1.4.12, read aloud uses only the computer's own
  voices and makes no request, and Confirm before grading reaches every screen that grades.
- `alt-text-gates.mjs`: a card picture is read as the deck's alt text, then the stored
  description, never as nothing; a model-written description says so; a learner's correction
  is kept.
- `text-twin-gates.mjs`: every AI chart and diagram has a name and a text version read from
  its source, every `role="img"` in the app has a name, and the atlas points to its text index.
- `typography-gates.mjs`: the size of text drawn by maths, diagrams, animations and widgets,
  against the prose beside it.
- `toast-gates.mjs`: an error notice stays 8 seconds and any other 4, and the countdown stops
  while a notice is hovered or holds focus.
- `tolerant-grading-gates.mjs`: spelling slips are forgiven only when the setting is on, and
  the same way on the device and the server.
- `theme-ramp-gates.mjs` and `color-gates.mjs`: every colour theme keeps body and muted text
  above their contrast floors in light and dark, and a project colour is darkened until white
  text on it meets AA.
- `control-gates.mjs`: buttons and fields take their size and shape from the shared controls,
  so the same action looks the same everywhere.

**What these do not cover.** The axe gate does not open the mastery check, a quiz in
progress, drills, mock exams, paper practice, the search dialog, the welcome steps of a new
library, the sign-in screen, or the Devices & security and Library & about sections of
Settings. No check runs the app at 200% zoom, at 320 px wide, or with the widest text spacing
on. The gates that mount components (`a11y-behaviour-gates.mjs`, `keyboard-gates.mjs`,
`dialog-gates.mjs`, `toast-gates.mjs`) do it in a simulated page (jsdom); others, such as
`accessibility-settings-gates.mjs`, read source and CSS and mount no page. Only the NVDA run
uses a screen reader.

## Conformance report (WCAG 2.2)

**Covers:** the Terramentor web app and the desktop app, which opens the same pages in a
browser window, on `main` on 18 November 2026.

**Does not cover:** content written by a course's author or by a model (lessons, cards,
diagrams, charts, animations, widgets, assistant answers, imported media, and the recordings and
transcripts an author supplies). It does cover what the app gives for such content: whether a
recording can carry a transcript, and whether a generated chart or diagram gets a text version.
The known gaps that come from such content are listed above.

**How it was evaluated:** the automated checks described above, and a review of the source
code. A criterion neither has reached is marked "Not evaluated", and its remark says what was
checked.

**Terms:** Supports: no known failure. Partially supports: some parts fail. Does not support:
most of it fails. Not evaluated: not tested yet, so no claim is made. Not applicable: the app
has nothing the criterion is about.

### Level A

| Criterion | Conformance level | Remarks |
|---|---|---|
| 1.1.1 Non-text Content | Partially supports | Card pictures and AI charts have text; outline status icons and code-built sketches do not. |
| 1.2.1 Audio-only and Video-only (Prerecorded) | Partially supports | Card recordings have a play button but no place for a transcript. |
| 1.2.2 Captions (Prerecorded) | Not applicable | The app has no video with sound of its own; linked videos play on their own site. |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | Not applicable | The app has no prerecorded video of its own. |
| 1.3.1 Info and Relationships | Partially supports | Headings, landmarks and labels are marked up; the outline tree and calendar grid are not. |
| 1.3.2 Meaningful Sequence | Supports | Reading order follows the screen. (Browse mode reaching the page behind a card review is under Known gaps.) |
| 1.3.3 Sensory Characteristics | Supports | Instructions name controls by their words, for example "drag or use arrow keys". |
| 1.4.1 Use of Color | Partially supports | On a phone's month calendar, dots tell courses apart by colour alone. |
| 1.4.2 Audio Control | Supports | Card recordings have a play and stop button; playing by themselves can be switched off. |
| 2.1.1 Keyboard | Partially supports | Resizing the sidebar and the detail panel needs a mouse; reordering and dialogs use the keyboard; the atlas map moves and zooms by keyboard, and its topics are picked from its index. |
| 2.1.2 No Keyboard Trap | Supports | Dialogs keep and return focus; Escape then Tab leaves the code editor. |
| 2.1.4 Character Key Shortcuts | Supports | Single-key shortcuts can be switched off in Settings → Accessibility. |
| 2.2.1 Timing Adjustable | Partially supports | Drill clocks scale or switch off; notices close after 4 to 8 seconds unless hovered or focused. |
| 2.2.2 Pause, Stop, Hide | Supports | Animations have a pause button and stop when Motion is Reduced. |
| 2.3.1 Three Flashes or Below Threshold | Supports | Nothing the app itself draws flashes more than three times a second. Animations a model writes are outside this report and are not checked (see Known gaps). |
| 2.4.1 Bypass Blocks | Supports | A Skip to content link and landmarks on every screen. |
| 2.4.2 Page Titled | Supports | Each area sets its own page title; the tabs inside a course share the course name. |
| 2.4.3 Focus Order | Supports | Dialogs take focus and give it back; a new screen moves focus to its content. |
| 2.4.4 Link Purpose (In Context) | Supports | Links and buttons are named by the words they show. |
| 2.5.1 Pointer Gestures | Supports | Pinch and drag on the atlas have zoom buttons and keys. |
| 2.5.2 Pointer Cancellation | Supports | Controls act on release; Confirm before grading adds a second press for answers. |
| 2.5.3 Label in Name | Supports | Buttons are named by the words they show. |
| 2.5.4 Motion Actuation | Not applicable | Nothing responds to moving or shaking the device. |
| 3.1.1 Language of Page | Supports | The page language is set to the interface language before the page loads. |
| 3.2.1 On Focus | Supports | No control acts on focus alone. |
| 3.2.2 On Input | Supports | Changing a setting does not move to another screen. |
| 3.2.6 Consistent Help | Supports | The assistant is in the header of every screen; Report a problem is always in Settings. |
| 3.3.1 Error Identification | Not evaluated | Errors are shown in text; whether each names its field has not been checked form by form. Few are tied to their field in code (a technique, not this criterion). |
| 3.3.2 Labels or Instructions | Partially supports | The search box and the notes box rely on placeholder text. |
| 3.3.7 Redundant Entry | Supports | No step was found that asks again for something already entered. |
| 4.1.2 Name, Role, Value | Partially supports | Outline rows do not state their status; search results are not exposed as a list. |

4.1.1 Parsing was removed in WCAG 2.2 and is not listed.

### Level AA

| Criterion | Conformance level | Remarks |
|---|---|---|
| 1.2.4 Captions (Live) | Not applicable | The app has no live audio or video. |
| 1.2.5 Audio Description (Prerecorded) | Not applicable | The app has no prerecorded video of its own. |
| 1.3.4 Orientation | Supports | Works in portrait and landscape; no orientation is locked. |
| 1.3.5 Identify Input Purpose | Supports | Password and one-time code fields declare their purpose. |
| 1.4.3 Contrast (Minimum) | Supports | No contrast failure in the axe scans, light and dark; Higher contrast is in Settings. |
| 1.4.4 Resize Text | Not evaluated | Text size goes to 160% and browser zoom is allowed; 200% is not tested. |
| 1.4.5 Images of Text | Supports | Text, maths included, is real text. |
| 1.4.10 Reflow | Not evaluated | Phone layouts are scanned at 390 px wide; 320 px is not tested. |
| 1.4.11 Non-text Contrast | Not evaluated | Only text and accent fills are measured; borders and icons are not. |
| 1.4.12 Text Spacing | Not evaluated | The widest spacing setting meets these values; no screen is checked for clipped text at it. |
| 1.4.13 Content on Hover or Focus | Not evaluated | Tooltips are the browser's own; the atlas's hover card has not been checked. |
| 2.4.5 Multiple Ways | Supports | The header, search (Ctrl+K, or Cmd+K on a Mac) and the atlas index. |
| 2.4.6 Headings and Labels | Supports | One main heading per screen; settings rows and fields are labelled. |
| 2.4.7 Focus Visible | Partially supports | A ring shows keyboard focus; on an accent-coloured button it is the button's own colour. |
| 2.4.11 Focus Not Obscured (Minimum) | Not evaluated | Pop-up notices and the task dock sit over the page and can cover part of the focused control; no state has been found yet where one hides it fully. |
| 2.5.7 Dragging Movements | Partially supports | Lists have Move earlier and Move later; panel resizing and photo corners need a drag. |
| 2.5.8 Target Size (Minimum) | Supports | axe reports no target-size failure on the scanned screens (a smaller target passes it when spaced apart). |
| 3.1.2 Language of Parts | Partially supports | Course text carries its course's language; assistant answers do not. |
| 3.2.3 Consistent Navigation | Supports | The header and its tabs are the same on every screen. |
| 3.2.4 Consistent Identification | Supports | One set of shared controls, held by `control-gates.mjs`. |
| 3.3.3 Error Suggestion | Not evaluated | Not yet reviewed form by form. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Supports | Deleting asks first; a card rating and an assistant change can be undone. |
| 3.3.8 Accessible Authentication (Minimum) | Supports | Password fields accept pasting and password managers; there is no puzzle. |
| 4.1.3 Status Messages | Partially supports | A review session's cards and answers, feed verdicts and assistant answers are announced; a rating, Undo, a topic's own card list, and drill and quiz results are not. |

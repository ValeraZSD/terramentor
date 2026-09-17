You are writing the **outline** of a rigorous self-study course, as a single JSON file, for a
local-first learning app. Someone will study from it for weeks or months.

This is **pass one of two**, and the split is the whole point. A chat reply holds roughly five
to ten thousand words. A course with real teaching in it needs well over a hundred thousand.
Asked for both at once, a model spends its budget on titles and every lesson comes out as a
one-line summary — a table of contents wearing the costume of a course.

So: **you are writing the skeleton only.** Topic names, a short signpost paragraph on each, and
verified links. The teaching gets written later, one phase per reply, with a whole reply's
budget behind it. Your job is to build a frame worth filling.

## 1. Output contract

Output **one JSON object and nothing else** — no prose before it, no explanation after it, no
markdown fence around it. It must parse with a strict JSON parser on the first try.

```json
{
  "project": {
    "name": "string, required, max 500 chars",
    "description": "string, max 5000 chars — what this course covers and who it is for",
    "color": "#RRGGBB",
    "icon": "an emoji, or a key from the list in section 6",
    "content_language": "ISO code — see section 7",
    "version": "the edition of this course — see below",
    "uuid": "omit — see below"
  },
  "nodes": [ /* array of Node objects, section 2 */ ]
}
```

Any field not listed here is discarded silently. Do not invent fields — put the information
where it will actually be read.

**`version` is the course's own edition, not a schema version.** Write something short and
human: `"1.0"`, `"2026-08"`, `"spring term"`. It is free text the app never parses; its whole
job is to answer "is the copy I was just sent newer than the one I already have?". For a new
course, `"1.0"`.

**`uuid` identifies which course this is, across machines.** Omit it — the app mints one. It
appears in files exported *from* the app so a later edition can be recognised as the same
course. If you are revising a course that was exported from the app, keep every `uuid` exactly
as it was and raise `version`.

## 2. The Node object

Nodes nest recursively through `children` and form the whole curriculum tree.

| field | type | notes |
|---|---|---|
| `title` | string, **required** | max 500 chars. The field that matters most in this pass — see section 3. |
| `description` | string | max 10 000 chars. Markdown. In this pass: 2–5 sentences, not an essay. |
| `children` | Node[] | omit if empty |
| `resources` | Resource[] | omit if empty. Attach only to leaf topics. See section 5. |
| `is_note` | boolean | **omit — do not use it in this pass.** It marks teaching material, which pass two writes. See section 4. |
| `questions` | Question[] | **omit — do not use it in this pass.** Graded practice the app turns into a real quiz on that topic. It is written against material that does not exist yet, so there is nothing here to write it from. |
| `status` | string | omit. (The importer accepts `not_started`/`in_progress`/`completed`/`skipped`; a new course is all `not_started`.) |
| `notes` | string | **never write this.** It is the learner's own private field, excluded from sharing by default. Anything you put there is misfiled. |
| `uuid` | string | omit. Round-trip identity, minted by the app — see section 1. |

## 3. What you are actually producing

Two things, and both are read by a machine later, so precision pays.

**A tree of topics.** A **leaf** — a topic with no topic children — is one study session, 30–90
minutes of work. It gets scheduled, it gets a deadline, it accumulates a mastery estimate, and
in pass two it gets its teaching written. Everything above a leaf is grouping.

The tree has **three levels, and the leaves are on the third**:

- **Level 1** — phases, in study order, titled `"Phase 1: …"`, `"Phase 2: …"`. Usually 4–10.
- **Level 2** — topics within the phase. Usually 3–8 per phase. A topic is a *grouping*: a
  chapter, a week, a theme. It is not studied directly.
- **Level 3** — the leaves: the study sessions inside a topic. **2–6 per topic.** This is the
  level that gets scheduled, proven and taught.
- Level 4 only when the subject genuinely has that structure (a leaf that itself needs
  splitting). Rare.

A level-2 topic with no children is the exception, allowed only when the topic really is a
single sitting. **A phase whose topics all lack children is a tree cut one level short** —
the app will schedule and test the chapter headings as if they were lessons. Walk each phase
before you output: if its topics have no leaves, split them.

**A short Overview on each node** (`description`): 2–5 sentences saying what it covers, why it
matters, and what knowing it looks like. A signpost, not the teaching. Resist writing more —
prose here is prose not spent on the tree, and on every leaf pass two REPLACES it with the
full reading.

Rules that decide whether pass two can succeed:

1. **Leaf titles must be specific, and they are an identifier.** Pass two is asked for material
   for the leaves of one phase, by title, and the app matches what comes back against what you
   wrote here. A title that says nothing gets material about nothing. `"Fundamentals"`,
   `"Overview"`, `"Theory"`, `"Advanced Topics"`, `"Miscellaneous"`, `"Introduction"` and
   `"Key Concepts"` are banned as leaf titles. `"Why the small-angle approximation fails past
   15°"` is a title.
2. **No two leaves may share a title**, anywhere in the course, even across phases. Identical
   titles are ambiguous to the matcher, and usually mean the same lesson got written twice.
3. **Order strictly by dependency.** Nothing may require an idea taught later. Walk your own
   tree before you output and confirm it.
4. **One idea, one leaf.** Before you write a leaf, check no earlier one already covers it.
5. **Cover the real subject, including the unglamorous parts.** If the standard treatment
   includes tedious mechanics, they go in. A course that skips them is a tour.
6. **Size it to the brief, and do not pad.** A two-week primer is 15–25 leaves; a semester
   course 60–120; "everything there is" may run past 200. Because you are not writing lesson
   bodies, a large tree is affordable here — but every leaf you invent is a leaf someone has to
   fill and study, so each one must earn its place.

## 4. Do not write teaching material in this pass

The real teaching — 600–2000 words per leaf, derivations, worked examples, failure modes —
is written in **pass two**, straight into each leaf's Overview. Pass two receives your leaf
titles and writes against them, with a full reply per phase, and it does that job far better
than anything you could fit in here alongside a whole tree.

**None of it belongs in this reply.** Do not emit `is_note` anywhere — it marks a separate
attached reading, which is rare and not yours to add. Do not compensate by writing long
Overviews. Do not attach a summary of what will be taught.

If you find yourself wanting to explain a topic rather than name it, that is the signal the
split exists for. Name it precisely and move on.

## 5. Resources — use web search, and verify

**Search the web for every leaf's resources. Do not write a URL from memory.**

A fabricated URL is worse than no URL: it looks authoritative, 404s later, and the learner
cannot tell which of your links were checked.

- **Search for each leaf topic**, open what you find, confirm it is really about that topic and
  really at that address.
- **Prefer primary and stable sources**: official documentation, university course pages,
  standards bodies, textbook author sites, well-known reference sites.
- **2–4 resources per leaf.** Zero is an acceptable, honest answer for a leaf where you found
  nothing good. Padding with generic links is worse than an empty array.
- **No search-engine result URLs**, no link shorteners, no paywalled PDFs.
- Attach resources **only to leaf topics** — never to a phase.

| field | type | notes |
|---|---|---|
| `title` | string, **required** | display name of the page, max 500 chars |
| `url` | string | max 2000 chars. **`http` or `https` only** — see below. |
| `type` | string | one of: `article` `video` `book` `documentation` `tutorial` `tool` `course` `practice` `link` |
| `completed` | boolean | omit. The learner's own tick, not yours. |
| `uuid` | string | omit. Round-trip identity, minted by the app. |

An unrecognised `type` is imported as a plain link, and the import reports that it did so.

**A URL that is not `http` or `https` is dropped on import** — the resource is kept, so its
title still tells the learner what to look for, but the link is gone. This is not about your
output; it is because a shared course is exactly the kind of file that arrives from someone you
do not know, and its links are rendered as real links.

## 6. Project icon and colour

`icon` accepts **any emoji** (preferred — pick one that suits the subject) or one of these keys:

`folder` `book` `graduation` `idea` `target` `star` `heart` `smile` `zap` `fire` `check`
`trophy` `brain` `code` `calculator` `testtube` `microscope` `dna` `planet` `rocket` `tools`
`robot` `palette` `camera` `music` `theater` `museum` `globe` `leaf` `pen` `history`
`briefcase` `chart` `money` `car` `hospital` `scale` `chef` `gamepad`

`color` is a hex string used as the project's accent. Pick something legible, not neon.

## 7. Language

Write **every** `title` and `description` in the course language, and set `content_language` to
its ISO code, from:

`en` `nl` `de` `fr` `es` `it` `pt` `pl` `ro` `uk` `ru` `cs` `sv` `da` `nb` `fi` `hu` `el` `tr`
`bg` `sr` `ja` `zh` `ko` `ar` `he` `hi`

Omit the field only if you genuinely do not know; the app then infers the language from your
titles, which is less reliable. Established technical terms and proper nouns keep their standard
form; everything else is in the course language.

## 8. Honesty rules

These matter more than anything above, because the learner will study this as if it were true.

1. **Never invent a specific.** A number, a date, a citation, an author, a version, an exam
   weighting — if you are not sure, say less. An omitted detail costs nothing; an invented one
   is undetectable to a learner who does not yet know the subject.
2. **Never describe a tool's interface you have not seen** — buttons, menus, screens, scoring.
3. **Say when something is contested.** If practitioners disagree, or a convention is regional,
   say so in a clause rather than picking one and sounding certain.
4. **Do not certify the learner.** No "You can now…", "You should now be able to…",
   "Congratulations". End on the substance. The app strips these and should find nothing.
5. **No filler.** No "In this section we will explore…", no restating the title as a sentence.

## 9. Worked example

A complete, valid reply — abbreviated only in that a real course has many more phases,
topics and leaves. Note the shape: **phase → topic → leaves**, every level-2 topic carrying
its leaves. Note what is *absent*: no `is_note` node anywhere, no long descriptions, resources
on the leaf and nowhere else.

```json
{
  "project": {
    "name": "Wave Optics for First-Year Physics",
    "description": "Interference, diffraction and polarisation, built from Huygens' principle up to multi-slit gratings, at the level of a first-year university exam. Assumes single-variable calculus and a working knowledge of simple harmonic motion; assumes no prior optics.",
    "color": "#4F46E5",
    "icon": "🌊",
    "content_language": "en",
    "version": "1.0"
  },
  "nodes": [
    {
      "title": "Phase 1: Light as a Wave",
      "description": "The wave model, and the two experiments that force you to accept it.",
      "children": [
        {
          "title": "Huygens' principle",
          "description": "Every point on a wavefront acts as a source of secondary wavelets, and the next wavefront is their envelope. This is the construction every later result is derived from — refraction, diffraction and the grating equation all fall out of it. Knowing it means being able to draw the construction for an arbitrary wavefront and read the new one off the drawing.",
          "children": [
            {
              "title": "Constructing a plane wavefront from wavelets",
              "description": "The geometric construction in its simplest case, where the envelope of equal-radius wavelets is another plane. Knowing it means producing the next wavefront with a compass and straightedge, and being able to say why the spacing comes out as it does.",
              "resources": [
                {
                  "title": "Huygens' Principle — HyperPhysics",
                  "url": "http://hyperphysics.phy-astr.gsu.edu/hbase/phyopt/huygen.html",
                  "type": "documentation"
                }
              ]
            },
            {
              "title": "Why the backward wavelet does not appear",
              "description": "The construction as stated predicts a wave travelling backwards as well as forwards, which is not observed. The obliquity factor is the standard repair, and it is worth seeing that it is a patch rather than a derivation — this is where Huygens' principle stops being fundamental and starts being a useful approximation.",
              "resources": []
            }
          ]
        },
        {
          "title": "Refraction at a boundary",
          "description": "What the construction predicts when the wavefront crosses into a medium where it travels at a different speed. The sine relation, which quantity is conserved across the boundary, and the limit where the transmitted wave disappears.",
          "children": [
            {
              "title": "Deriving Snell's law from the construction",
              "description": "Refraction as a consequence of the wavefront travelling at different speeds either side of a boundary. Knowing it means deriving the sine relation from the geometry rather than quoting it, and being able to say which quantity is conserved across the boundary and why.",
              "resources": [
                {
                  "title": "Refraction of Light — The Physics Classroom",
                  "url": "https://www.physicsclassroom.com/class/refrn/Lesson-1/Refraction-and-Sight",
                  "type": "article"
                }
              ]
            },
            {
              "title": "Total internal reflection and the critical angle",
              "description": "The angle beyond which Snell's law has no real solution, read off the same construction. Knowing it means computing the critical angle for a given pair of media and explaining why it exists only going from the slower medium to the faster one.",
              "resources": []
            }
          ]
        }
      ]
    }
  ]
}
```

## 10. Before you output, check

- [ ] It is one JSON object, parses strictly, no fence, no commentary.
- [ ] **No `is_note` field appears anywhere in the file.**
- [ ] **Three levels: phase → topic → leaves.** Every level-2 topic has leaf children, bar a
      genuine single-sitting exception; no phase's topics are all childless.
- [ ] Every `title` is present, non-empty, and specific; no banned generic leaf titles.
- [ ] No two leaves share a title.
- [ ] Every `description` is 2–5 sentences, not an essay.
- [ ] No `notes`, `uuid`, `completed` or `status` fields anywhere.
- [ ] `project.version` is the edition you are writing (`"1.0"` for a new course).
- [ ] Every URL was found by searching, not recalled, and every one is `http`/`https`.
- [ ] Resources only on leaf topics; `type` is from the allowed list.
- [ ] Nothing depends on a topic that appears later in the tree.
- [ ] Every `title` and `description` is in the course language.
- [ ] Node `description` ≤ 10 000 chars, project `description` ≤ 5000.

---

## BRIEF

{{BRIEF}}

Now write the outline.

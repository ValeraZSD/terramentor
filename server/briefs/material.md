You are writing the **teaching material** for one phase of a self-study course that already
exists. Someone will study from it for weeks or months, and will treat what you write as true.

This is **pass two of two**. The outline (the tree of topics, in study order) is already
written and imported. Your job now is the part that could not fit alongside it: the actual
lessons. One phase per reply, so that a whole reply's budget lands on a dozen topics instead of
being spread across a whole course.

**The single most important instruction in this brief:** if you cannot fit every topic below,
write complete material for as many as you can and stop cleanly. **Do not thin the material to
make it fit.** Short lessons for all of them is the one outcome that makes this pass pointless,
the learner will simply ask you for the rest, and can do that as many times as it takes.

## 1. What you are writing for

{{CONTEXT}}

## 2. The topics

Write material for these topics, in this order. **Echo each title back exactly as written
here**, character for character. The app matches your reply against the course by title, and a
title you have reworded is a lesson that lands nowhere.

{{LEAVES}}

## 3. Output contract

Output **one JSON object and nothing else**: no prose before it, no explanation after it, no
markdown fence around it. It must parse with a strict JSON parser on the first try.

```json
{
  "leaves": [
    {
      "title": "the topic title, echoed exactly from section 2",
      "overview": "the teaching itself, markdown, 600–2000 words"
    }
  ]
}
```

- **The reading goes in `overview`.** It replaces the short signpost pass one wrote there,
  so open with what the topic is and why it matters, then teach it end to end. One reading per
  topic: a derivation, worked examples, the failure modes, all in one piece of prose with
  headings.
- Include only topics you actually wrote for. Omitting the rest is the correct way to stop; a
  topic with a stub in it is worse than a topic left for the next reply.
- Each `overview` is **600–2000 words**, max 10 000 characters. This is the number that
  matters. A 200-word entry is a summary of a lesson, not a lesson.
- **Rarely**, a topic needs a second, separable piece: a long reference table, a worked
  exam paper, a case study that would break the flow of the reading. Only then add
  `"material": [{"title": "…", "description": "…"}]` beside `overview`: each entry becomes a
  separate attached reading under the topic. Most topics have none. Never use it instead of
  `overview`.
- Do not include `is_note`, `uuid`, `status`, `notes`, `resources` or `children`; the app adds
  what it needs. Links were gathered in pass one.

## 4. How to write a reading

Write like a good textbook section, not like an encyclopedia entry and not like a summary.

- **Explain, derive, and work examples end to end.** Show the steps. A derivation with a step
  elided is a derivation the learner cannot follow when it fails.
- **State the failure modes and the boundary cases.** Where does this stop being true? What is
  the standard mistake? This is usually the most valuable paragraph and the first one a thin
  lesson drops.
- **Use the learner's level as the floor**, not the ceiling; assume what section 1 says they
  know, and nothing beyond it.
- **Notation follows the subject's own conventions.** Do not invent an index or a symbol scheme;
  if you find yourself explaining how your notation relates to the standard one, use the
  standard one.
- **Teach a representation by showing that representation.** If the skill is reading a diagram,
  a graph, a structure or a notation, the reading must contain one with the feature visible in
  it, not a description of the procedure for reading it.

## 5. Visuals

Material is rendered by the app, which understands fenced *specs* and draws them. Use one where
a picture genuinely carries the idea, never as decoration. Roughly one visual per two or three
readings; most good teaching is prose.

- ` ```mermaid `: relationships, processes, taxonomies, timelines, state machines.
- ` ```vega-lite `: charts.
- ` ```plot `: function plots (`fn` strings).
- ` ```animation `: an SVG using **SMIL** (`<animate>`, `<animateTransform>`) for something
  that changes over time. A still SVG is not an animation and will be flagged as broken.
- ` ```smiles `: chemical structures.
- ` ```drill `: a JSON item bank for a memorisation minigame (symbols, vocabulary, dates).
- `$…$` and `$$…$$`: KaTeX. Every formula gets its own delimiters. A formula alone on a line
  should use `$$` on its own lines. Keep units inside the span with their quantity
  (`$550\ \text{nm}$`), and never put `^` or `_` inside `\text{}`.

Do **not** emit ` ```p5 ` or ` ```widget `: those are compiled by the learner's own local model
and would arrive as an unbuilt placeholder.

**One hard rule for any chart of a formula: never write numbers you computed yourself.** Use
Vega-Lite `data.sequence` + `transform.calculate`, or `plot`'s `fn` strings, so the app computes
the curve. Inline `data.values` is only for measured or given data. A hand-computed data array
is the most common way a generated visual ends up confidently showing the wrong shape.

## 6. Honesty rules

These matter more than anything above, because the learner cannot yet tell when you are wrong.

1. **Never invent a specific.** A number, a date, a citation, an author, a version, a function
   signature, an exam weighting; if you are not sure, teach at the level you *are* sure of. An
   omitted detail costs nothing; an invented one is undetectable to someone learning this.
2. **Never describe a tool's interface you have not seen**: buttons, menus, screens, scoring.
   For a "go and do this with X" topic, write what the learner should *do* and how they will
   know they succeeded.
3. **Say when something is contested.** If practitioners disagree, or a convention is regional,
   say so in a clause rather than picking one and sounding certain.
4. **Do not certify the learner.** Material must not end with "You can now…", "You should now
   be able to…", "Congratulations" or any variant. End on the substance. The app strips these
   automatically and should find nothing to strip.
5. **No filler.** No "In this section we will explore…", no restating the title as a sentence,
   no closing paragraph repeating what was just said.
6. **Arithmetic you show must be right.** The app re-checks the arithmetic in worked examples
   against the surrounding prose. If a number is awkward to carry through, choose a cleaner one
   rather than rounding silently mid-derivation.

## 7. Worked example

One topic, its reading written out **at full length**, so the length and density expected
are unambiguous. Real output has one `overview` of this size per topic.

```json
{
  "leaves": [
    {
      "title": "Constructing a plane wavefront from wavelets",
      "overview": "Huygens' principle states that every point on a wavefront may be treated as a point source of a secondary spherical wavelet, and that the wavefront at a later time is the surface tangent to all of those wavelets, their *envelope*. The principle is a construction rather than a law: it does not follow from anything more fundamental in this treatment, and its justification here is that it reproduces the observed behaviour of light in every case covered in this phase.\n\nTake a plane wavefront travelling through a homogeneous medium in which light has speed $v$. At time $t$ the wavefront is a flat surface; call it $W_t$. Mark a row of points along it, evenly spaced, and treat each as a source. After an interval $\\Delta t$, each of those wavelets has grown into a sphere of radius\n\n$$r = v\\,\\Delta t$$\n\nEvery one of those spheres has the same radius, because the medium is homogeneous: $v$ does not depend on position, and it is isotropic, because $v$ does not depend on direction either. Both conditions matter, and section 4 of this reading is about what happens when the second one fails.\n\nNow construct the envelope: the surface that touches every sphere exactly once. For a row of equal spheres whose centres lie on a plane, that surface is a second plane, parallel to the first and displaced from it by exactly one radius. So the new wavefront $W_{t+\\Delta t}$ is plane, parallel to $W_t$, and a distance $v\\,\\Delta t$ further along. This is the result the construction has to give if it is to be believed at all, since a plane wave that stayed plane and moved at speed $v$ is precisely what a plane wave is observed to do.\n\nThe spacing between successive wavefronts follows immediately. If the source oscillates with period $T$, then wavefronts of equal phase are emitted one period apart, so consecutive crests are separated by\n\n$$\\lambda = v\\,T = \\frac{v}{f}$$\n\nNotice which quantity changed and which did not. When this wave later crosses into a different medium, $f$ is fixed by the source and cannot change, since the boundary cannot emit or swallow oscillations, so a change in $v$ must appear entirely as a change in $\\lambda$. That observation is doing all the work in the derivation of Snell's law later in this phase, so it is worth being able to state on its own.\n\n### A numeric case to check your drawing against\n\nLight travels from vacuum into a glass of refractive index $n = 1.50$. Inside the glass its speed is\n\n$$v = \\frac{c}{n} = \\frac{3.00 \\times 10^{8}\\ \\text{m/s}}{1.50} = 2.00 \\times 10^{8}\\ \\text{m/s}$$\n\nDraw the wavefront inside the glass and let it advance for $\\Delta t = 5.0\\ \\text{ns}$. Each wavelet has radius\n\n$$r = v\\,\\Delta t = (2.00 \\times 10^{8}\\ \\text{m/s})(5.0 \\times 10^{-9}\\ \\text{s}) = 1.0\\ \\text{m}$$\n\nso the new wavefront is parallel to the old one and $1.0\\ \\text{m}$ beyond it. If the light has frequency $5.00 \\times 10^{14}\\ \\text{Hz}$, its wavelength inside the glass is $\\lambda = v/f = 4.00 \\times 10^{-7}\\ \\text{m}$, or $400\\ \\text{nm}$, shorter than the $600\\ \\text{nm}$ it had in vacuum, in the same ratio $n$ by which the speed dropped.\n\n### Where the equal-radius assumption fails\n\nThe step that carried the whole construction was that every wavelet has the *same* radius. Drop isotropy and it fails. In a birefringent crystal such as calcite, the speed of light depends on the direction of travel relative to the crystal axis, so each wavelet grows as an ellipsoid rather than a sphere. The envelope of a row of ellipsoids is still a plane, but it is in general **not** parallel to the wavefront that generated it: the wave's energy travels in a direction different from the normal to its own wavefront. That is not a defect in the construction; it is the correct prediction, and it is why a calcite crystal laid over a printed line shows two displaced images.\n\nOne limit worth stating plainly: this construction predicts where wavefronts *are*, and says nothing about how bright they are. Getting amplitudes right requires Kirchhoff's diffraction theory, which is outside this course. When a later topic asks for the position of a fringe, this construction is enough; when it asks for the intensity of one, it is not."
    }
  ]
}
```

## 8. Before you output, check

- [ ] It is one JSON object, parses strictly, no fence, no commentary.
- [ ] Every `title` under `leaves` is echoed **exactly** from section 2.
- [ ] Every topic you included has an `overview`; `material` appears only for a genuinely
      separate extra piece, and rarely.
- [ ] **Every `overview` is at least 600 words.** If one is not, you thinned it to fit, and
      delete that topic from the reply and leave it for the next one instead.
- [ ] No `is_note`, `uuid`, `status`, `notes`, `resources` or `children` fields anywhere.
- [ ] Every formula is inside `$…$` or `$$…$$`; no `^` or `_` inside `\text{}`.
- [ ] No hand-computed data arrays in any chart spec.
- [ ] No self-certifying closers, no filler openers, no invented specifics.
- [ ] Everything is written in the course language named in section 1.

Now write the material.

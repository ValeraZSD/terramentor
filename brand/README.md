# The Terramentor mark

A planet with two courses flown across it. One rises over the horizon at the
bottom, climbs to the right, and ends at the step proven last — the brightest
point on the mark. The other is the same route turned half a revolution: it comes
over the top and descends on the left, still running, with no landing of its own.
Two heads would be two endings, and the mark would have no answer to where it
finishes.

It is the app's own Terra view rather than a stock ed-tech mortarboard. The
library really is drawn as a sphere with regions as caps on it
(`src/components/atlas/GlobeMap.tsx`), a course really is traced over it as a
great circle, and the newest step really is the brightest
(`src/components/atlas/coursePaths.ts`). The mark is built with the same maths,
which is why the route bends the way a route on a sphere bends and breaks at the
horizon instead of running across the face as a chord.

## The files

| file | what it is |
|---|---|
| `terramentor-mark.svg` | the mark, nothing behind it — the web, a header, a slide |
| `terramentor-mark-small.svg` | the same mark cut for 16–32 px: no shading, a heavier route |
| `terramentor-mono.svg` | one colour, route knocked out, `currentColor` — print, stencil, a tint |
| `terramentor-icon.svg` | the app icon: a night tile with a margin (macOS, Windows, PWA `any`) |
| `terramentor-icon-maskable.svg` | full bleed, planet inside the 80% safe circle (Android `maskable`) |
| `terramentor-wordmark.svg` | the lockup on a light ground |
| `terramentor-wordmark-dark.svg` | the lockup on a dark ground |

Rasters ship from these into `public/icons/`: `icon-192.png`, `icon-512.png`,
`icon-maskable-512.png`, `apple-touch-icon.png`, `favicon.svg`, `favicon-32.png`,
`favicon-16.png`. `tools/build-desktop.mjs` resizes `icon-512.png` into the
Windows `.ico` and the macOS `.icns`, so that one file is the desktop icon too —
and is why it carries a transparent margin rather than bleeding to the edge.

## Regenerating

```
node tools/brand.mjs --apply    # write brand/*.svg and public/icons/*
node tools/brand.mjs --check    # the four things that fail silently
node tools/brand.mjs --proof    # a picture of all of it, in temp/brand
```

Nothing here is hand-drawn: `tools/brand.mjs` computes the geometry, so a change
is a parameter, not a redraw. Edit the SVGs by hand and the next `--apply`
overwrites them.

How the second route is inked is the one word `TWIN` in `tools/brand.mjs`:
`'same-open'` (shipped — drawn like the first, no landing), `'same'` (a landing
too), `'yin'` / `'yin-open'` (the twin as the dark half, literally yin-yang),
`'ghost'` (faded behind the first), or `null` for one route. `--sheet` draws all
of them at every size.

Yin-yang symmetry is a 180° rotation, and on a sphere that is a turn about the
view axis — `psi + 180`, which leaves `z` alone, so the near half stays the near
half and the twin's bend and trims are the original's exactly (measured deviation
6e-16). A *mirror* would not do this: reflecting the drawing flips the route's
handedness, so the two would bow the same way and read as a bracket rather than a
turn.

`--check` covers the failures that ship a picture instead of an error: a stencil
whose route has cut the silhouette open, a maskable icon Android crops the head
off, a desktop tile with no margin (right on Android, wrong in a macOS dock), and
a wordmark that rendered without its word.

## Colour and clear space

The planet is `#0E7490`, the app's default accent (`ACCENT_COLORS[0]` in
`src/components/ui/ColorField.tsx`). The tile behind the app icon is `#0B1220`.
The route is white; on the one-colour cut it is whatever `currentColor` is not.

The mark is drawn at radius 23 in a 64 box, so it already carries a clear space
of 9 units — a little over a third of its own radius. Keep at least that much
around it, and do not put it on a mid-tone between `#0E7490` and white.

The wordmark sets "Terra" at 600 and "mentor" at 400 in the same system stack the
UI uses, as LIVE text — so it renders as the app's own type and stays editable.
Where the font cannot be trusted (a README on someone else's machine, a printer),
render it first: `node tools/brand.mjs --proof` draws it, or open the SVG and
export. Two things the rasteriser is strict about and a browser is not: the first
family in the stack must be a real named face, and no member of the stack may be
quoted — either one silently drops the text and leaves the planet alone.

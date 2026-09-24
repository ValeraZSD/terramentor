# The Terramentor mark

An open book inside a wireframe globe — terra and mentor as one drawing. The
planet's crown rises in the V between the two page tops, its gridded lower half
hangs below them, and one line runs the full height: the book's spine through the
middle, the planet's axis above and below it. The book is not a smaller picture
placed on a ball — it spans the globe's full width, and that integration is the
mark.

**The book hides the globe by geometry, not by paint.** The globe and its grid
are clipped to everything outside the two page quadrilaterals — an outer box with
the pages punched out of it as holes, `clip-rule="evenodd"`. A `<mask>` is the
obvious tool and renders as *nothing at all* under the rasteriser this project
ships (`@napi-rs/canvas`). Because the occlusion is in the drawing and not in a
fill, it survives a mark with no fill: the stencil and the wordmark's mark still
read as a book in front of a planet, not a transparent wireframe ball.

**Two cuts, not one picture at two scales.** The full cut keeps the globe's grid;
the small cut drops it and strokes heavier. Below about 32 px those grid lines go
sub-pixel and turn the middle of the mark to grey mud.

## The files

| file | what it is |
|---|---|
| `terramentor-mark.svg` | the mark alone: black line on white pages, grid kept — a light ground |
| `terramentor-mark-small.svg` | the same mark cut for 16–32 px: no grid, a heavier line |
| `terramentor-mono.svg` | one colour, `currentColor`, no fill at all — print, a stencil, a patch |
| `terramentor-icon.svg` | the app icon: a tile with a transparent margin (Windows, macOS, the manifest's `any`) |
| `terramentor-icon-maskable.svg` | full bleed, never rounded, inside the 80 % circle Android crops to |
| `terramentor-favicon.svg` | full bleed, rounded, the heavier line: the browser tab |
| `terramentor-wordmark.svg` | the lockup on a light ground |
| `terramentor-wordmark-dark.svg` | the lockup on a dark ground |

`public/icons/` is rastered from the three tiled cuts:
`icon-192.png`/`icon-512.png` from the app icon, `icon-maskable-512.png` and
`apple-touch-icon.png` from the maskable one (iOS masks and composites that one
itself, so it must not be the transparent mark), and
`favicon.svg`/`favicon-32.png`/`favicon-16.png` from the favicon. Each PNG is drawn from the artwork **at its own size**, never from one
64 px document rasterised twice — that is what lets the 16 px file drop the grid.
`tools/build-desktop.mjs` resizes `icon-512.png` into the Windows `.ico` and the
macOS `.icns`, which is why the tile carries a margin rather than bleeding to the
edge.

## Regenerating

```
node tools/brand.mjs --apply    # write brand/*.svg and public/icons/*
node tools/brand.mjs --check    # writes nothing; the six silent failures
```

Nothing here is hand-drawn: the mark is computed, so a change is a parameter and
not a redraw. Edit the SVGs by hand and the next `--apply` overwrites them.

The geometry is **not** in `tools/brand.mjs` — it is `server/iconArt.js`, the one
copy for the three places that draw the mark: these files, the PNGs
`server/appIcon.js` renders for whatever icon the learner chose, and the live
preview in Settings. It sits under `server/` because the Docker image ships
`server`, `dist` and `public` and nothing else. `tools/brand.mjs` owns the set of
files a build ships and the assertions about them.

`--check` catches the failures that ship a picture instead of an error — a logo
that rasterises to a blank tile looks exactly like one that works. Six
assertions: the favicon still lays ink down at 16 px; so does the transparent
small mark; nothing but tile crosses the maskable safe circle; a grid line
resolves at 64 px and smudges at 16, which puts the reason for two cuts as
something that can fail; the grid adds real ink at 64 px, so the full cut earns
its file; and the 512 px icon is rendered at 512 rather than stretched from 64,
with the stretch rendered beside it as the failing control.

## Colour and clear space

The mark is line art. Alone it is black on white pages; the stencil takes
`currentColor` and fills nothing. On a tile the default ground is `#0b1220` and
the ink `#e2e8f0` (`DEFAULT_BACKGROUND` and `INK_LIGHT` in `server/iconArt.js`),
and the ink is never chosen — it is derived from the tile by contrast (`inkFor`),
because the learner can recolour that tile. Put the mark on a surface its ink
reads against, never on a mid-tone that swallows the line.

Standing alone the mark is drawn 46 units wide in a 64-unit box, so it already
carries 9 units of clear space on every side, about a fifth of its own width.
Keep at least that much around it.

## The wordmark

The lockup sets "Terra" at weight 600 and "mentor" at 400 in the same system
stack the UI uses, as **live text**, so it renders in the app's own type wherever
it is opened and stays editable. Where the font cannot be trusted — a README on
someone else's machine, a printer — render it first and ship the raster.

Two things the rasteriser is strict about and a browser is not: the first family
in the stack must be a real named face, and no member may be quoted. Either one
silently drops the text and leaves the mark standing alone — 654 ink pixels
unquoted against 0 quoted.

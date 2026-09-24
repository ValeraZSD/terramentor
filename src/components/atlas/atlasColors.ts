/**
 * The atlas map's one data encoding: how much of a region the learner has
 * proven, as a five-step ordinal ramp.
 *
 * Two decisions behind it, both deliberate:
 *
 * **Colour carries mastery, not project.** Project is identity — categorical —
 * and a library of eighteen courses would need eighteen hues, which is twice
 * past the point where adjacent classes stop being distinguishable. Project
 * identity is carried instead by the chips in the region list, where names do
 * the work colour can't. What colour encodes here is the one continuous
 * magnitude on the map: the fraction of a region the learner has closed.
 *
 * **The steps ARE the app accent.** The accent is user-configurable, so the
 * ramp is derived from it at runtime: the hue is the accent's hue and the five
 * steps are lightness gradations of it. The accent stays on the interactive
 * chrome (selection ring, buttons) too, so "this is data" and "this is a
 * control" share the same family — the map reads as part of the app, not as a
 * blue island in it.
 *
 * The switch beside the legend chooses where that hue comes from: the app's own
 * colour for the whole map, or each course's. It is not only a hue swap —
 * ONE hue and TWELVE need different ladders, and the two are tuned separately
 * for that reason (`ramp` against `RUNGS`/`CHROMA` below).
 *
 * Dark mode is not an inversion of light: each theme has its own steps, because
 * a fill has to be visible against the surface it is drawn on at BOTH ends of
 * the ladder, and the two surfaces are at opposite ends of the range. Every
 * bottom end is validated against every theme's real surface
 * (`atlas-gates.mjs`), except the light ramp's deliberately pale one.
 */
import { hexToRgb, rgbToHsl, hslToRgb, relLum } from '../../utils/color';
import { k } from '../../i18n';
import type { AtlasColorMode } from '../../types';

/** `k()` marks these as translation keys: as bare strings in a module table no
 *  extractor could see them, so the mastery legend under the map read
 *  "none proven → all proven" in English under every other language. The render
 *  site does `t(STEP_LABELS[0])`. */
export const STEP_LABELS = [k('none proven'), k('a little'), k('some'), k('most'), k('all proven')];

/**
 * Build the five-step mastery ramp from the app accent.
 *
 * The accent is user-configurable, so the ramp is derived from it at runtime:
 * the hue is the accent's hue, and the five steps are lightness gradations of
 * that hue. The saturated end (step 4) is the accent itself in light mode, and
 * a brightened accent in dark mode (where the raw accent would be too dark to
 * see against the dark surface).
 *
 * It is NOT the luminance-and-chroma ladder course mode uses, and the reason is
 * that this ramp has ONE hue in it. Pinning a rung to a luminance exists to make
 * a rung mean the same thing across a dozen different hues; inside a single hue
 * HSL lightness already runs pale → saturated in order, and the pale end reads
 * as "nothing here yet" at a glance — which is the thing the map is for. Held
 * up side by side against a luminance-pinned version of itself, this one won
 * (2026-09-15).
 *
 * The one thing it takes from the other ladder is a FLOOR on a dark theme.
 * Lightness is not brightness, so a dark accent puts the untouched end wherever
 * its hue happens to land: measured on deep violet, step 0 comes out at
 * luminance 0.012 against a 0.009 surface, 1.05:1, a bubble you cannot
 * see. Any step below the floor is solved for the floor instead, which leaves
 * every accent that was already clear of it exactly as it was.
 */
export function ramp(accentHex: string, dark: boolean): string[] {
    const rgb = hexToRgb(accentHex) || [14, 116, 144];
    const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const sat = Math.max(s, 0.5);

    // Dark themes: dark → bright, so every step clears the dark surface, the
    // brightest being the accent lifted to a readable lightness. Light themes:
    // pale → saturated, so the darkest step is the accent (clamped to stay dark
    // enough for the light surface).
    const ls = dark
        ? [0.18, 0.32, 0.46, 0.62, 0.78]
        : [0.9, 0.78, 0.64, 0.5, Math.min(Math.max(l, 0.4), 0.45)];
    return ls.map(li => {
        const step = hslToRgb(h, sat, li);
        return dark && relLum(step) < DARK_RAMP_FLOOR
            ? fillAtLuminance(h, sat, DARK_RAMP_FLOOR)
            : `rgb(${step[0]}, ${step[1]}, ${step[2]})`;
    });
}

/**
 * The dimmest a step of the accent ramp may be on a dark theme: 1.5:1 against
 * the dark card surface, the same line course mode's bottom rung is held to.
 * A light theme has no equivalent — its pale end is the palest thing the app
 * draws on purpose, and darkening it would be darkening the picture this ramp
 * is for.
 */
const DARK_RAMP_FLOOR = 0.04;

/**
 * Which of the five steps a region sits on. Bucketed rather than continuous
 * because the reader compares a bubble to a legend, not to a gradient — and a
 * five-way comparison is one a person can actually make.
 *
 * The floor is exact: a region with nothing proven is step 0 even if the
 * rounding would have lifted it, so "I have not started here" always reads as
 * the palest bubble on the map.
 */
function masteryStep(proven: number, size: number): number {
    if (size <= 0 || proven <= 0) return 0;
    if (proven >= size) return 4;
    const frac = proven / size;
    return Math.min(3, Math.max(1, Math.ceil(frac * 4)));
}

export function regionFill(proven: number, size: number, accentHex: string, dark: boolean): string {
    return ramp(accentHex, dark)[masteryStep(proven, size)];
}
// ---- colouring by COURSE instead of by mastery ------------------------------
//
// The ramp above answers *how much of this have I proven?* and is the map's
// default for the reason stated at the top: one continuous magnitude, five
// ordinal steps, a legend a person can actually read against.
//
// It cannot answer *whose material is this?* — and once the map can trace a
// course through its regions, that becomes a question worth asking of the
// whole map at once. So colour has a second mode, opt-in: **hue says which
// course, lightness still says how proven**. Both dimensions survive, and the
// legend changes with the mode rather than lying about it.
//
// Two things make this honest rather than merely colourful:
//
// **Hues are SEPARATED, not taken as stored.** Measured on the real library:
// 17 active projects carry 11 distinct colours, six of them share one blue
// exactly, and six more are neighbouring blues and indigos. Painting the map
// with `projects.color` as authored would draw a third of the library in one
// colour and call it three different courses. So the authored hue is a
// STARTING POSITION that is then pushed apart until neighbours are far enough
// to read as different, keeping each course as close to its own colour as the
// wheel allows and keeping the ORDER of the hues intact, so relationships the
// learner chose survive.
//
// **A shared region goes GREY rather than inventing a third course.** A bubble
// holding two courses is mixed on the hue CIRCLE, weighted by how many topics
// each contributes, and the saturation is scaled by how much the members agree
// (the resultant length of that circular mean). Mixing red and green on a line
// gives yellow, which is a lie — a third course. Mixing them on the circle
// gives a desaturated grey, which is the truth: no one course owns this place.
// A region that is 90% one course keeps that course's colour.

export type { AtlasColorMode };

/**
 * The five rungs course mode ladders through, as RELATIVE LUMINANCE — how
 * bright the bubble actually comes out — not as HSL lightness.
 *
 * This is where the two modes part company. The accent ramp above walks ONE
 * hue, where lightness is already an order a reader can follow; here a rung has
 * to mean the same thing in a dozen different hues at once, and lightness
 * cannot do that.
 *
 * HSL lightness is not brightness, and across a dozen hues it is not even
 * close: at L = 0.34 a saturated yellow-green lands at luminance 0.29 and a
 * saturated indigo at 0.03, a tenfold difference that says nothing about
 * anything. Measured on the real library (2026-09-15, 18 courses, `ramp`'s
 * old fixed-L rungs): an UNTOUCHED bubble spanned luminance 0.029 → 0.326, the
 * brightest thing on the whole map was an untouched green course, and two
 * courses' untouched colour outshone another course's fully proven one. So the
 * second dimension was not a second dimension — it was hue, wearing a caption
 * that claimed otherwise.
 *
 * Fixing the rung to a luminance and solving for the lightness each hue needs
 * to reach it makes "paler = less proven" true BETWEEN courses, which is the
 * only place it was ever read. It also keeps the range honest at the bottom:
 * an untouched bubble is genuinely dark on a dark map, which is what 59% of
 * this library's drawn area is.
 *
 * The ladder is EASED, not evenly spaced, and that is about what the buckets
 * really hold. Step 1 is "up to a quarter proven", and on this library it is
 * 38.9% of the drawn area — earned, in eight of its twenty-four regions, by
 * fewer than one topic in twenty (Natural Sciences: 1 of 72; measured
 * 2026-09-15). Spaced evenly, two-fifths of the map claimed a quarter of the
 * way up the ramp for a single answered question. So the first two rungs sit
 * close together and the gaps widen toward the proven end, where the
 * difference between half and all of a region is what the reader is actually
 * comparing.
 *
 * How far the bottom rung can go down is set by the surface, not by taste: a
 * fill has to clear 1.5:1 against the palest paper and the blackest theme the
 * app has. In light themes that is the binding constraint at the untouched end
 * (0.55 against warm paper is 1.50:1 — the line itself), which is why the light
 * ladder gets its extra separation from chroma rather than from lightness.
 */
const RUNGS = {
    dark: [0.045, 0.085, 0.17, 0.34, 0.62],
    light: [0.54, 0.475, 0.39, 0.25, 0.12],
};

/**
 * How much of its own hue a bubble is allowed to show at each rung — the
 * SECOND half of the proof encoding, and the half that was missing.
 *
 * Luminance alone made the ladder true but not loud. On this library 2,192 of
 * 2,287 topics are untouched, so a map with chroma pinned flat painted 59% of
 * its area in fully saturated reds, greens and violets (measured on the real
 * canvas, 2026-09-15: the three largest fills were `rgb(153,13,13)`,
 * `rgb(132,47,5)` and `rgb(4,88,4)`, all at step 0, all at saturation 0.84 and
 * above). The most vivid thing on the map was the part the learner has not
 * touched, and the handful of proven regions had nowhere left to stand out.
 *
 * So colour STRENGTH climbs with proof beside brightness: untouched is a
 * tinted grey, proven is the course's colour at full chroma. The two
 * dimensions move together, which is what makes the difference between the
 * ends of the ladder big enough to see across a whole map rather than in a
 * legend. Hue survives at the bottom — enough to tell a warm region from a
 * cool one — because it is still what says whose material this is; it is just
 * no longer shouting it.
 *
 * The bottom rung is a floor, not zero: a course whose colour has drained away
 * entirely is a course the map cannot identify at all.
 */
const CHROMA = [0.18, 0.30, 0.55, 0.80, 1];

/**
 * The colour of hue `h` at saturation `s` whose relative luminance is
 * `target` — found by bisecting HSL lightness, which luminance is monotone in
 * (L = 0 is black and L = 1 is white for every hue, so every target in between
 * is reachable).
 *
 * Memoised because the map asks for this per region AND per topic dot on every
 * frame: a pan over this library is ~2,400 calls a frame, and the answers
 * repeat — one course's hue at one rung is one colour.
 */
const solved = new Map<string, string>();
function fillAtLuminance(h: number, s: number, target: number): string {
    const key = `${h.toFixed(4)}|${s.toFixed(3)}|${target}`;
    const hit = solved.get(key);
    if (hit) return hit;
    let lo = 0, hi = 1;
    for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        if (relLum(hslToRgb(h, s, mid)) < target) lo = mid; else hi = mid;
    }
    const css = `rgb(${hslToRgb(h, s, (lo + hi) / 2).join(', ')})`;
    solved.set(key, css);
    return css;
}

/**
 * How far apart two courses' hues must sit before they read as two courses.
 * ~26°, which is about where adjacent categorical hues stop being confusable.
 * Above roughly fourteen courses this cannot be honoured and the gap shrinks to
 * whatever the wheel has left — which is the point at which the legend, not the
 * colour, is doing the identifying.
 */
const MIN_HUE_GAP = 1 / 14;
/** A course whose colour is a grey still needs a hue to be told apart by. */
const MIN_COURSE_SAT = 0.55;
/** A thoroughly mixed region is grey, but never invisible against the surface. */
const MIN_MIX_SAT = 0.05;

export interface CourseHue {
    /** 0..1 around the wheel. */
    h: number;
    s: number;
}

export interface CourseSwatch {
    id: number;
    name: string;
    /** The colour this course is actually drawn in, after separation. */
    color: string;
    /**
     * The whole ladder this course is painted through, none proven → all
     * proven, which is the same five steps the map uses.
     *
     * The legend used to show ONE colour per course while the map painted five
     * of them, so the second half of the encoding — lightness still says how
     * much is proven, in both modes — was stated in a caption and shown
     * nowhere. A key that leaves out a dimension the picture uses is a key you
     * have to be told how to read.
     */
    steps: string[];
}

/**
 * A hue per project, far enough apart to tell apart.
 *
 * Deterministic in the input, and the input is ordered by project id by the
 * caller, so the same library always draws the same colours — the atlas's
 * determinism claim covers this the way it covers the layout.
 */
export function courseHues(
    projects: { id: number; color: string | null }[],
): Map<number, CourseHue> {
    const seen = new Map<number, { id: number; h: number; s: number }>();
    for (const p of [...projects].sort((a, b) => a.id - b.id)) {
        if (seen.has(p.id)) continue;
        const rgb = hexToRgb(p.color || '') || null;
        const [h, s] = rgb ? rgbToHsl(rgb[0], rgb[1], rgb[2]) : [0, 0, 0.5];
        seen.set(p.id, {
            id: p.id,
            // No colour, or a grey one: spread by id rather than piling every
            // such course onto hue 0. The golden angle keeps successive ids far
            // apart instead of adjacent.
            h: rgb && s > 0.05 ? h : (p.id * 0.381966) % 1,
            s: Math.max(s, MIN_COURSE_SAT),
        });
    }

    const list = [...seen.values()].sort((a, b) => a.h - b.h || a.id - b.id);
    const n = list.length;
    const out = new Map<number, CourseHue>();
    if (n === 0) return out;

    // The largest gap that fits, capped at the one worth having.
    const gap = Math.min(MIN_HUE_GAP, 1 / n);
    const placed = list.map(c => c.h);
    for (let i = 1; i < n; i++) placed[i] = Math.max(placed[i], placed[i - 1] + gap);
    // Pushing forward can run the last one into the first one the long way
    // round. Nothing local fixes that, so the whole ring is spaced evenly —
    // the hues keep their ORDER, which is the part of the author's choice that
    // can still be honoured.
    if (placed[n - 1] + gap > placed[0] + 1) {
        for (let i = 0; i < n; i++) placed[i] = placed[0] + i / n;
    }
    list.forEach((c, i) => out.set(c.id, { h: ((placed[i] % 1) + 1) % 1, s: c.s }));
    return out;
}

/** One course's colour at one of the five mastery steps. */
export function courseFill(hue: CourseHue | undefined, step: number, dark: boolean): string {
    const rung = Math.max(0, Math.min(4, step));
    const target = (dark ? RUNGS.dark : RUNGS.light)[rung];
    // No hue at all is a grey at the same rung, so an unattributed region sits
    // on the ladder beside the courses rather than beside nothing.
    return fillAtLuminance(hue?.h ?? 0, (hue?.s ?? 0) * CHROMA[rung], target);
}

/**
 * The hue of a region drawn from several courses: a circular mean weighted by
 * how many topics each course put there, desaturated by how much they disagree.
 */
export function mixCourseHue(
    members: { id: number; count: number }[],
    hues: Map<number, CourseHue>,
): CourseHue | undefined {
    let x = 0, y = 0, weight = 0, sat = 0;
    for (const m of members) {
        const hue = hues.get(m.id);
        if (!hue || m.count <= 0) continue;
        const a = hue.h * Math.PI * 2;
        x += Math.cos(a) * m.count;
        y += Math.sin(a) * m.count;
        sat += hue.s * m.count;
        weight += m.count;
    }
    if (!weight) return undefined;
    const resultant = Math.hypot(x, y) / weight;
    return {
        h: ((Math.atan2(y, x) / (Math.PI * 2)) % 1 + 1) % 1,
        s: Math.max(MIN_MIX_SAT, (sat / weight) * resultant),
    };
}

/** What a region is painted in, in either mode. */
export function regionColor(
    region: { mastery: { proven: number }; size: number; projects: { id: number; count: number }[] },
    mode: AtlasColorMode,
    hues: Map<number, CourseHue>,
    accentHex: string,
    dark: boolean,
): string {
    const step = masteryStep(region.mastery.proven, region.size);
    if (mode !== 'course') return ramp(accentHex, dark)[step];
    return courseFill(mixCourseHue(region.projects, hues), step, dark);
}

/** The legend's swatches: every course on the map, in the colour it is drawn. */
export function courseSwatches(
    projects: { id: number; name: string; color: string | null }[],
    hues: Map<number, CourseHue>,
    dark: boolean,
): CourseSwatch[] {
    return projects.map(p => {
        const hue = hues.get(p.id);
        return {
            id: p.id,
            name: p.name,
            // The saturated end of the ladder is the colour that NAMES the
            // course — the one a reader matches against the map's biggest
            // bubbles — and the ladder beside it says what its lightness means.
            color: courseFill(hue, dark ? 4 : 3, dark),
            steps: [0, 1, 2, 3, 4].map(step => courseFill(hue, step, dark)),
        };
    });
}

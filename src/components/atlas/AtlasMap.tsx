import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { AtlasRegion, AtlasTopic } from '../../types';
import { AtlasColorMode, courseFill, CourseHue, ramp, regionColor } from './atlasColors';
import {
    CourseTrace, DEFAULT_PACE, Flight, Leg, ReplayPace, advanceFlight, flightMs, flightPath, headMorph,
    legAt, legParam, legUpTo, newFlight,
} from './coursePaths';
import { AtlasCapture, captureRatio } from './atlasCapture';
import { atlasSurfaces } from '../../utils/themeSurfaces';
import { spring, MAX_STEP_MS } from './cameraSpring';
import {
    CLICK_SLOP, JOURNEY_MIN_ALPHA, JOURNEY_MIN_WIDTH, JOURNEY_MAX_WIDTH, JOURNEY_HALO_WIDTH,
    JOURNEY_HALO_ALPHA, ARROW_MIN_LENGTH, ARROW_SIZE, TRACE_REGION_DIM, TRACE_TOPIC_DIM, TRACE_DOT_MIN, LOOK_AHEAD, FIT_AHEAD,
    ZOOM_DEAD_OUT, ZOOM_DEAD_IN, ZOOM_OUT_OMEGA, ZOOM_IN_OMEGA, END_OMEGA, END_ZOOM_OMEGA,
    IDLE_GAP_MS, paintHead,
} from './journeyStyle';
import {
    createLabeller, VISIBLE_ALPHA, labelPx, refreshRootFontScale,
    MIN_LABEL_PX, MAX_NAME_PX, TOPIC_NAME_PX, MIN_NAMED_RADIUS, NAME_FADE_START, NAME_EASE,
} from './mapLabels';
import AtlasCard from './AtlasCard';
import MapControls from './MapControls';
import { Locate, Maximize2, Minimize2, Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface AtlasMapHandle {
    /** Centre the map on a region (and zoom in if it is too small to read). */
    flyTo: (regionId: number) => void;
    fit: () => void;
    /**
     * Move the camera so every one of these world points is on screen.
     *
     * What a replay needs and `flyTo` cannot give it: a journey runs across
     * several regions, and the thing worth watching is the line crossing the
     * map — which is only watchable if the whole of it is in frame before the
     * first step is drawn.
     */
    frameOn: (points: { x: number; y: number }[]) => void;
    /**
     * Put a whole course in front of the reader.
     *
     * What the PAGE asks for, which is why it is a course rather than a box:
     * the atlas has two surfaces and framing means something different on each
     * — a pan and a zoom here, a turn on the planet — and the page has no
     * business knowing which one it is drawing. `frameOn` above is this
     * surface's own primitive, still there because the camera harness drives it
     * directly.
     */
    frameOnCourse: (trace: CourseTrace, opts?: { instant?: boolean }) => void;
    /**
     * The replay is over: let go, and drift out until the whole course is in
     * frame.
     *
     * The same destination as `frameOnCourse` and deliberately not the same
     * move. A course picked off the list is a cut — one place, then another,
     * and the sooner it is over the better. This is the end of something the
     * reader has been riding for half a minute, and handing it to that brisk
     * arm is a snap: the camera comes off a soft suspension that was drifting
     * after an arrow and is suddenly on a spring stiff enough to cross the
     * library in a fifth of a second. So the ending keeps the following
     * camera's weight and spends a second and a half pulling back.
     */
    endJourney: (trace: CourseTrace) => void;
    /**
     * Ride with the replay: the camera follows the arrow, close enough in that
     * the topics it visits are separate places with names on them.
     *
     * Watched from the whole-journey framing, most of a replay is not visible:
     * a run of topics finished in one part of the library is a run of steps a
     * few pixels long. Framing the route and then watching it from there shows
     * the shape of the course; it does not show the journey. The course's shape
     * is what picking it in the list already draws.
     *
     * Any pan, zoom or fit hands the camera back — the reader taking hold of
     * the map always wins, and the replay goes on running where they left it.
     */
    followJourney: () => void;
    /**
     * Where the arrow actually is, in steps, as a float — or null when no
     * course is being drawn.
     *
     * The step is an integer the page owns and the panel prints; this is the
     * value BETWEEN two of them, and it lives here because the canvas is what
     * eases it (React is never re-rendered per frame). The panel's timeline
     * reads it the same way the canvas does — by asking, on its own frame —
     * so the line on the bar and the arrow on the map are one number rather
     * than two clocks that agree at 60Hz and nowhere else.
     */
    journeyAt: () => number | null;
    /**
     * Where the camera is, right now — for anything measuring the MOVE rather
     * than the picture.
     *
     * A replay that "jiggles" is a fault in a number over time, and the only
     * way to see it is to record that number every frame and look at the trace:
     * the zoom oscillation this exists to catch was invisible in any single
     * drawn frame and obvious the moment `k` was plotted (`tools/cam-trace.mjs`).
     */
    camera: () => { x: number; y: number; k: number };
    /**
     * The canvas itself — for `captureStream`, and for nothing else.
     *
     * Handed over rather than queried out of the DOM by the recorder, because
     * "the first canvas inside the map" is a fact about markup that a future
     * overlay would quietly change into the wrong element, and the failure
     * would be a video of something else.
     */
    canvas: () => HTMLCanvasElement | null;
    /** Nothing is moving, fading or flying, and no frame is waiting to be drawn. */
    settled: () => boolean;
}

interface Props {
    regions: AtlasRegion[];
    selectedId: number | null;
    onSelect: (id: number | null) => void;
    onOpenTopic: (topic: AtlasTopic) => void;
    /** Topic ids matching the current search, or null when nothing is typed. */
    matches: Set<number> | null;
    dark: boolean;
    /**
     * The theme TINT, not merely the light/dark axis — and it is a dependency
     * rather than an input.
     *
     * The surfaces this canvas paints are read off the document's own ramp
     * (`utils/themeSurfaces.ts`), which is resolved INSIDE a memo: without
     * something that changes when the ramp does, it is resolved once and never
     * again, and the map goes on painting the old page colour inside the new
     * one. The theme's NAME cannot be that something — it says only light or
     * dark, and two tints share a mode.
     */
    themeTint: string;
    /** The app accent hex — the ramp is derived from it. */
    accent: string;
    /**
     * What colour MEANS on this map: how much is proven (the default), or which
     * course a topic belongs to. Lightness carries mastery in both, so the
     * course mode adds a dimension rather than trading one away.
     */
    colorMode: AtlasColorMode;
    /**
     * A hue per course, assigned once for the whole library by `AtlasView` and
     * handed to both surfaces and the legend — the separation pass sorts every
     * project on the map, so two copies of it is two answers to "which course is
     * this colour".
     */
    hues: Map<number, CourseHue>;
    /**
     * The course being traced, or null when none is. Carries its topics and
     * the journey through them; everything outside it is dimmed, never removed
     * — the same rule search follows, and for the same reason.
     */
    trace: CourseTrace | null;
    /**
     * How far along the journey to draw: null draws all of it, a number draws
     * the first N steps. This is the replay, and it is a PROP rather than
     * internal state because the panel beside the map has to say which step is
     * on screen — two renderings of one number cannot be allowed to disagree.
     */
    journeyStep: number | null;
    /**
     * How fast the replay runs and how long it stands on each topic — the
     * reader's own dials, the same object on both surfaces. Absent is the
     * built-in pace, which is what the camera harness drives it at.
     */
    pace?: ReplayPace;
    /**
     * Whether the regions print their names. A map with a course drawn across
     * it is sometimes wanted as a PICTURE of the route, and a hundred place
     * names is what is between the reader and that picture.
     */
    regionNames?: boolean;
    /**
     * Set when this surface is a video frame being recorded rather than a map
     * being read: the canvas is sized to it, and the chrome, the card and the
     * pointer all stand down. See `atlasCapture.ts`.
     */
    capture?: AtlasCapture | null;
    fullscreen: boolean;
    onToggleFullscreen: () => void;
    /**
     * Chrome that floats over the canvas, top-left. Passed in rather than built
     * here because its state belongs to the page (which course, which step),
     * and full screen lifts this component out of the page — so a control
     * rendered beside the map would vanish exactly when the map is largest.
     */
    children?: ReactNode;
}

/** Half-extent of the world at zoom 1 — the layout lives in [-1, 1] plus air. */
const WORLD = 1.1;
const MIN_K = 0.7;
const MAX_K = 30;
/** Topics fade in between these zoom levels. */
const TOPIC_FADE_START = 1.7;
const TOPIC_FADE_FULL = 2.9;
/**
 * How far into that fade the topics become the layer being pointed at: past
 * here a click picks a topic before its region, and a HOVER picks a topic or
 * nothing at all (`pick`). One number for both, because "which layer is this
 * reader in" is one question.
 */
const TOPIC_PICK_DETAIL = 0.35;
// Region names, the floor, the fade and the ease all live in `mapLabels.ts` —
// the sphere draws the same type and a second copy is a map whose legibility
// depends on which surface you are looking at.
/**
 * A topic dot narrower than `NAME_DOT_MIN` px on screen carries no name — a
 * name beside a 4px dot belongs to nothing in particular. Between there and
 * `NAME_DOT_FULL` the name fades in with the dot.
 *
 * One threshold is what "the small blobs' text appears in an instant" is:
 * the region names ride a zoom ramp a full 1.7× wide, but with one threshold
 * every topic name in a region switches on together the moment its dots cross
 * 4.5px. On a phone that crossing lands well after the opacity ramp has
 * already reached the top, so they arrive at full strength — a page of text
 * appearing between one frame and the next.
 */
const NAME_DOT_MIN = 4.5;
const NAME_DOT_FULL = 7;
// `NAME_EASE` — how far a topic name moves toward its target opacity each frame
// (~0.25 s to settle) — is in `mapLabels.ts` with the rest of the type: the zoom
// ramps alone are only smooth if the zoom is, a pinch crosses the whole of
// `NAME_FADE_START`→1 in a couple of frames, and a name that wins its ground
// from a neighbour has no ramp at all. Easing the drawn value is what makes
// both of those a fade rather than a switch.

// ---- the traced course ------------------------------------------------------
//
// ONE layer: the route the learner walked. It is drawn in the map's INK, not in
// the accent — the accent is already the mastery ramp (every bubble and every
// dot is a step of it), so a coloured path would compete with the one encoding
// the map has.
//
// ONE layer — the route the learner walked, never the curriculum's tree: a
// faint web of parent→child links under the path is a hundred hairlines
// running off every edge of the screen, most of them between topics the
// learner has never opened, behind the one line that is about them. The map
// dissolves courses on purpose; what a reader wants back is not the syllabus,
// it is their own path through it, which is why that path arrives a leg at a
// time and STAYS.
// The ink, the arrows and the head marker are in `journeyStyle.ts`: the globe
// draws the same journey, and one replay cannot have two sets of numbers.

// ---- the flight -------------------------------------------------------------
//
// A slideshow — the path growing by one whole segment every time the clock
// ticks and the head marker simply somewhere else — is not travel: nothing
// moves, so nothing reads as travel, and travel is the only thing a journey
// has to say that a finished path does not.
//
// So the drawn position is CONTINUOUS and the data stays discrete. The step
// count is still the integer the panel shows; this component eases its own
// drawn progress toward it at a constant speed, the same way the camera eases
// toward a fly-to target and a topic name eases toward its opacity. The arrow
// flies the curve between two topics, arrives, rests for the remainder of the
// beat, and leaves again.
//
// How long one step owns the screen is `stepDurationMs` in `coursePaths.ts` —
// the distance it has to cover buys it — and the page's step clock schedules on
// the same function, so the two cannot drift apart: an arrow flying slower than
// the steps arrive never lands, and one flying faster stands still. How much of
// that beat is spent flying rather than landed is `FLIGHT_SHARE`, which lives
// beside it for the same reason.
/**
 * How close the camera rides while it is following the arrow.
 *
 * Well past `TOPIC_FADE_FULL`, which is only where topic names START being
 * drawn: at the fade's own end every bubble on screen prints every name it
 * holds, and the arrow crosses a page of text. This is close enough that the
 * topics it visits are a handful of separate places with room around them, and
 * far enough that the region names are still there to say where in the library
 * this is happening.
 */
const FOLLOW_K = 5;
/** How much wider than the window itself the framing is — the room around it. */
const LEG_MARGIN = 1.45;
// How wide a window of the journey the camera holds (`LOOK_AHEAD`, `FIT_AHEAD`),
// how far apart two zooms must be before it moves (`ZOOM_DEAD_OUT`/`_IN`) and how
// fast it travels between held shots: `journeyStyle.ts`, with the camera traces
// that set them.
/**
 * How far into the frame the arrow must stay — the share of the half-screen.
 *
 * Measured against the arm it has to rescue, not chosen: on the physics journey
 * at `FOLLOW_OMEGA`, 0.78 let the drawn head touch the edge once and 0.72 never
 * does. Below that it starts costing zoom for nothing — at 0.66 the cap binds
 * often enough to become the thing deciding the shot, and the reversals it was
 * built to prevent come back (3 of them at 0.72, 7 at 0.66).
 */
const KEEP_IN_FRAME = 0.72;
/**
 * The furthest out a leg may push the camera.
 *
 * `TOPIC_FADE_START` is 1.7, so at this zoom a hop across the library is drawn
 * between the two BUBBLES rather than between two dots nobody can see — which
 * is the same reading the map gives that hop at rest.
 */
const LEG_MIN_K = 1.7;
/**
 * The stiffness of the arm the following camera hangs on, in radians a second.
 *
 * Softer than a fly-to on purpose: the target it is chasing MOVES, and moves
 * smoothly, so this is the amount of drift behind it rather than a move that
 * has to be over before the next one starts. Critically damped, so "softer"
 * buys weight and never a wobble.
 *
 * 4.5 is about 0.9s to settle, and the floor under it is not taste: the softer
 * the arm, the further the camera trails on a fast leg, and below about 4 the
 * arrow starts reaching the edge of the frame before the zoom has pulled out
 * for it (at 3.5 it left the frame on three of 741 in-flight frames, by 22px).
 * The picture also moves LESS as the arm softens — 156 screen px/s at 6 against
 * 137 here — because a camera with more weight cuts the corners of the journey
 * rather than tracing them.
 */
const FOLLOW_OMEGA = 4.5;
// The zoom's two arms, the ending's two, the dimming of everything outside the
// traced course and the idle-gap cut are all in `journeyStyle.ts` — shared with
// the globe, which ends a replay the same way.
/** A segment whose ends are this close on screen is a point, not a line. */
const MIN_SEGMENT = 1;
/** The stiffness of a fly-to: brisk, because it is a move with an end to it. */
const FLY_OMEGA = 14;
type Cam = {
    x: number; y: number; k: number;
    /** The stiffness of the arm to pull it here on; `FLY_OMEGA` when absent. */
    omega?: number;
    /** …and the zoom's own, which is asymmetric while a replay is followed. */
    kOmega?: number;
};
/** How fast the camera is moving, and in what: world units and log-zoom, per second. */
type CamVel = { x: number; y: number; lk: number };
type Hit =
    | { kind: 'region'; region: AtlasRegion; topic: null }
    | { kind: 'topic'; region: AtlasRegion; topic: AtlasTopic };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const hitKey = (h: Hit | null) => (h ? `${h.kind}:${h.topic ? h.topic.id : h.region.id}` : '');

/**
 * The atlas map: the whole library on one canvas you can move around in.
 *
 * It was an SVG with a fixed viewBox, which meant the library was drawn once at
 * one scale and that was the only view of it there would ever be. On a real
 * library — 1885 topics in a hundred-odd regions — that produced a square of
 * overlapping circles with ninety labels printed on top of one another and no
 * way to get closer to any of it. A map you cannot move around in is a picture
 * of a map.
 *
 * So: pan, zoom, and two levels of detail. Zoomed out it is regions; zoom in
 * and each opens into its own topics, laid out by meaning inside the bubble
 * (server/atlas.js). Labels are collision-tested and drawn at a constant size
 * ON SCREEN rather than scaled with the world — a label is chrome, and chrome
 * that scales with the zoom is either unreadable or enormous, never right.
 *
 * Canvas rather than SVG for a reason that isn't performance dogma: label
 * collision needs text measurement and a painter's algorithm, both native to a
 * canvas and neither of which the DOM will do for you. The accessible twin is
 * `RegionList`, which carries every region and topic as real focusable controls
 * — this canvas is the visual index, not the only way in.
 */
const AtlasMap = forwardRef<AtlasMapHandle, Props>(function AtlasMap(
    {
        regions, selectedId, onSelect, onOpenTopic, matches, dark, themeTint, accent,
        trace, journeyStep, colorMode, hues, fullscreen, onToggleFullscreen, children,
        pace = DEFAULT_PACE, regionNames = true, capture = null,
    }, ref,
) {
    const { t: tr } = useTranslation();
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const camRef = useRef<Cam>({ x: 0, y: 0, k: 1 });
    const targetRef = useRef<Cam | null>(null);
    /**
     * The camera's own momentum, which is what makes it a camera on an arm
     * rather than a value being interpolated. Zeroed wherever the reader moves
     * the map themselves: a drag that ends does not fling it.
     */
    const velRef = useRef<CamVel>({ x: 0, y: 0, lk: 0 });
    const sizeRef = useRef({ w: 0, h: 0 });
    const frameRef = useRef(0);
    /** The last frame drawn asked for no other: nothing moving, fading or flying. */
    const stillRef = useRef(false);
    const hoverRef = useRef<Hit | null>(null);
    const pinnedRef = useRef<Hit | null>(null);
    const drawRef = useRef<() => void>(() => { });
    const topicsShownRef = useRef(false);
    // The opacity each topic name is CURRENTLY drawn at, by topic id, eased
    // toward the opacity the zoom asks for. Lives across frames because that is
    // what a fade is; pruned every frame to what is on screen.
    const nameAlphaRef = useRef<Map<number, number>>(new Map());
    // Where the replay's arrow actually is, in steps, and when that was last
    // advanced. Lives across frames for the same reason the name fades do: a
    // flight is a value moving through time, and React is told about the steps,
    // not about the frames between them.
    // `rest` is the milliseconds the arrow has been standing on the topic it
    // reached — the tail of the beat, which the flight itself does not use and
    // the CAMERA does: the camera moves on the beat rather than on the flight,
    // so it needs to know about the part of the beat where nothing flies.
    const flightRef = useRef<Flight>(newFlight());
    // When the last frame was drawn. ONE clock for the whole draw, read by the
    // camera and by the flight: two of them drifted apart in the obvious way —
    // the camera easing per FRAME while the arrow moved per MILLISECOND meant
    // the two agreed only at 60Hz, and the gap between them is what a phone
    // sees as the map juddering along behind the arrow.
    const clockRef = useRef(0);
    // Whether the camera is riding with the arrow. A ref, not state: it is read
    // and cleared by the gesture handlers, which are bound once and must never
    // re-bind, and nothing in the render depends on it.
    const followRef = useRef(false);
    /**
     * The zoom the following camera is HOLDING — not the one the window asks
     * for this frame.
     *
     * The window's answer changes with every leg, and a camera that takes it is
     * the yo-yo the trace recorded. This is the held shot: pulled out at once
     * when the journey needs more room, allowed back in only slowly, and moved
     * not at all for anything inside the dead band. Null when no replay is
     * being followed, so the next one starts from the shot it is given.
     */
    const followKRef = useRef<number | null>(null);

    const [hover, setHover] = useState<Hit | null>(null);
    const [pinned, setPinned] = useState<Hit | null>(null);
    const [showingTopics, setShowingTopics] = useState(false);
    // Where the open card is anchored, in SCREEN pixels: the CENTRE of the thing
    // it describes, plus the radius to clear. Updated by the draw loop rather
    // than captured when the card opened, or a pan would leave the card
    // floating over whatever moved underneath it.
    //
    // The centre and the radius travel separately because the card has two
    // sides to choose from: it sits above the dot when there is room above and
    // below it when there is not, and that decision needs the dot, not a point
    // already displaced in one direction.
    const [anchor, setAnchor] = useState<{ x: number; y: number; r: number } | null>(null);
    const anchorRef = useRef<{ x: number; y: number; r: number } | null>(null);
    // The card's own measured box, so the flip above can be decided against the
    // real thing rather than a guessed height.

    // Which bubbles the traced course reaches. Derived once per trace rather
    // than per frame: it is a walk over every topic in the course, and the
    // biggest course on a real library is 1,271 of them — sixty times a second
    // is sixty times too often for an answer that cannot have changed.
    const tracedRegions = useMemo(() => {
        if (!trace) return null;
        const ids = new Set<number>();
        for (const p of trace.points.values()) ids.add(p.regionId);
        return ids;
    }, [trace]);

    // Live values for the event handlers and the draw loop, which are bound
    // once and must not close over a stale render.
    const live = useRef({ regions, selectedId, matches, onSelect, onOpenTopic, trace, tracedRegions, journeyStep, colorMode, hues, pace, regionNames });
    live.current = { regions, selectedId, matches, onSelect, onOpenTopic, trace, tracedRegions, journeyStep, colorMode, hues, pace, regionNames };
    /**
     * How many canvas pixels one CSS pixel is, decided by the sizing observer
     * and read by the draw. One value rather than two computations of the same
     * rule: while capturing it is not the screen's ratio at all, and a draw
     * that worked it out for itself would paint at the wrong scale.
     */
    const dprRef = useRef(captureRatio(capture, 0));

    const reduceMotion = useMemo(
        () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
        [],
    );

    // ---- palette ------------------------------------------------------------
    // Resolved once per theme, never per frame: `getComputedStyle` forces style
    // resolution, and doing that inside a draw call turns a pan into thrash.
    const palette = useMemo(() => {
        let accentRgb = dark ? '96 165 250' : '37 99 235';
        if (typeof getComputedStyle === 'function') {
            const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
            if (raw) accentRgb = raw;
        }
        const acc = (a: number) => `rgba(${accentRgb.split(/\s+/).join(',')},${a})`;
        // The canvas, its hairlines and its text, READ OFF THE RAMP the rest of
        // the app is painted from (`utils/themeSurfaces.ts`). One RUNG per
        // value rather than one hex per theme, because a theme is a colour and
        // a table of names cannot hold the answer.
        const { surface, ring, ink, grid } = atlasSurfaces(dark);
        return {
            surface,
            grid,
            ring,
            ink,
            steps: ramp(accent, dark),
            acc,
        };
        // `themeTint` is not read here — it is read by the DOCUMENT, and this
        // asks the document. It is a dependency all the same, because it is what
        // says the answer has changed.
    }, [dark, themeTint, accent]);

    // ---- camera -------------------------------------------------------------
    const baseScale = useCallback(() => {
        const { w, h } = sizeRef.current;
        return Math.min(w, h) / (2 * WORLD) || 1;
    }, []);

    const requestDraw = useCallback(() => {
        if (frameRef.current) return;
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = 0;
            drawRef.current();
        });
    }, []);

    const toScreen = useCallback((wx: number, wy: number) => {
        const { w, h } = sizeRef.current;
        const cam = camRef.current;
        const s = baseScale() * cam.k;
        return { x: (wx - cam.x) * s + w / 2, y: (wy - cam.y) * s + h / 2 };
    }, [baseScale]);

    const toWorld = useCallback((sx: number, sy: number) => {
        const { w, h } = sizeRef.current;
        const cam = camRef.current;
        const s = baseScale() * cam.k;
        return { x: (sx - w / 2) / s + cam.x, y: (sy - h / 2) / s + cam.y };
    }, [baseScale]);

    const dismissCard = useCallback(() => {
        if (hoverRef.current) { hoverRef.current = null; setHover(null); }
        if (pinnedRef.current) { pinnedRef.current = null; setPinned(null); }
    }, []);

    const zoomAt = useCallback((factor: number, sx: number, sy: number) => {
        const cam = camRef.current;
        const before = toWorld(sx, sy);
        const k = clamp(cam.k * factor, MIN_K, MAX_K);
        const { w, h } = sizeRef.current;
        const s = baseScale() * k;
        // Pin the world point under the cursor to the cursor.
        camRef.current = { k, x: before.x - (sx - w / 2) / s, y: before.y - (sy - h / 2) / s };
        targetRef.current = null;
        velRef.current = { x: 0, y: 0, lk: 0 };
        followRef.current = false;
        followKRef.current = null;
        requestDraw();
    }, [baseScale, requestDraw, toWorld]);

    const flyToCam = useCallback((next: Cam, instant = false) => {
        followRef.current = false;
        followKRef.current = null;
        if (reduceMotion || instant) {
            camRef.current = next;
            targetRef.current = null;
            velRef.current = { x: 0, y: 0, lk: 0 };
        } else {
            targetRef.current = next;
        }
        requestDraw();
    }, [reduceMotion, requestDraw]);

    const fit = useCallback(() => flyToCam({ x: 0, y: 0, k: 1 }), [flyToCam]);

    const flyToRegion = useCallback((regionId: number) => {
        const region = live.current.regions.find(r => r.id === regionId);
        if (!region) return;
        const { w, h } = sizeRef.current;
        const s = baseScale();
        // Zoom so the region fills a comfortable share of the shorter side —
        // but never zoom OUT to do it: picking something in the list should not
        // undo the reader's own zoom.
        const want = (Math.min(w, h) * 0.42) / (2 * region.radius * s);
        const k = clamp(Math.max(camRef.current.k, Math.min(want, 8)), MIN_K, MAX_K);
        flyToCam({ x: region.x, y: region.y, k });
    }, [baseScale, flyToCam]);

    const frameOn = useCallback((
        points: { x: number; y: number }[],
        ease?: { omega: number; kOmega: number },
        instant = false,
    ) => {
        if (!points.length) return;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const p of points) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
            y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        }
        if (!Number.isFinite(x0)) return;
        const { w, h } = sizeRef.current;
        const s = baseScale();
        // A floor on the span, because a journey inside ONE bubble has a
        // bounding box of nearly zero and dividing by it asks for MAX_K — a
        // one-region path would slam the camera to maximum zoom on a point.
        const spanX = Math.max(x1 - x0, 0.12);
        const spanY = Math.max(y1 - y0, 0.12);
        const k = clamp(Math.min((w * 0.78) / (spanX * s), (h * 0.78) / (spanY * s)), MIN_K, MAX_K);
        flyToCam({
            x: (x0 + x1) / 2, y: (y0 + y1) / 2, k,
            omega: ease?.omega, kOmega: ease?.kOmega,
        }, instant);
    }, [baseScale, flyToCam]);

    const followJourney = useCallback(() => {
        // Nothing is snapped here. The next frame sees the flag, sets the
        // camera's target to wherever the arrow is, and the easing that every
        // other fly-to uses carries the reader in — a cut to the start of a
        // journey would lose the connection between the map they were looking
        // at and the one they are now in.
        followRef.current = true;
        // The held shot starts from what the journey asks for, so resuming
        // rides in from wherever the reader left the map rather than from a
        // zoom the last replay happened to settle on.
        followKRef.current = null;
        requestDraw();
    }, [requestDraw]);

    const coursePoints = (course: CourseTrace) =>
        // The topics' OWN places, not their bubbles': that is the box which
        // decides whether the course is legible, so a course living in one or
        // two regions zooms in until its dots separate.
        [...course.points.values()].map(p => ({ x: p.x, y: p.y }));

    const frameOnCourse = useCallback((course: CourseTrace, opts?: { instant?: boolean }) => {
        frameOn(coursePoints(course), undefined, !!opts?.instant);
    }, [frameOn]);

    const endJourney = useCallback((course: CourseTrace) => {
        // The same box, released rather than flown to. Nothing is zeroed on the
        // way past: the camera keeps whatever it was still carrying from the
        // journey, and a spring that is handed a new target without losing its
        // velocity leaves the old move along a curve instead of turning on the
        // spot.
        frameOn(coursePoints(course), { omega: END_OMEGA, kOmega: END_ZOOM_OMEGA });
    }, [frameOn]);

    useImperativeHandle(ref, () => ({
        flyTo: flyToRegion, fit, frameOn, frameOnCourse, endJourney, followJourney,
        journeyAt: () => (flightRef.current.target == null ? null : flightRef.current.at),
        camera: () => ({ ...camRef.current }),
        canvas: () => canvasRef.current,
        settled: () => stillRef.current && frameRef.current === 0 && targetRef.current == null,
    }), [flyToRegion, fit, frameOn, frameOnCourse, endJourney, followJourney]);

    // ---- picking ------------------------------------------------------------
    /**
     * What is under the pointer — and `forHover` is not a detail.
     *
     * Zoomed in, the topics ARE the layer and the bubble behind them is
     * scenery. The gap between two dots is not a place the reader is pointing
     * at; it is the ground they cross on the way to the next dot, and answering
     * it with the REGION's card put a panel over the topics at every step of
     * dot → gap → dot → gap, which interferes badly with moving across a
     * region. So above the zoom where topics are pickable, a hover is a
     * question about topics or about nothing.
     *
     * A press is not a hover and keeps the region: it is deliberate, it opens
     * no card (a region tap selects and unpins), and selecting the bubble you
     * are inside is a thing to be able to do at any zoom.
     */
    const pick = useCallback((sx: number, sy: number, forHover = false): Hit | null => {
        const s = baseScale() * camRef.current.k;
        const detail = clamp((camRef.current.k - TOPIC_FADE_START) / (TOPIC_FADE_FULL - TOPIC_FADE_START), 0, 1);
        const world = toWorld(sx, sy);

        if (detail > TOPIC_PICK_DETAIL) {
            let best: Hit | null = null;
            let bestD = Infinity;
            for (const region of live.current.regions) {
                // Cheap reject: a bubble the pointer is nowhere near cannot
                // hold the nearest topic.
                if (Math.hypot(world.x - region.x, world.y - region.y) > region.radius + 0.05) continue;
                const grab = Math.max(region.topicRadius * s, 7) + 4;
                for (const topic of region.topics) {
                    const p = toScreen(topic.x, topic.y);
                    const d = Math.hypot(p.x - sx, p.y - sy);
                    if (d <= grab && d < bestD) { bestD = d; best = { kind: 'topic', region, topic }; }
                }
            }
            if (best) return best;
            // …and nothing else, for a hover. See above.
            if (forHover) return null;
        }

        // Smallest region wins, so a small bubble overlapping a big one is
        // still reachable.
        let best: Hit | null = null;
        let bestR = Infinity;
        for (const region of live.current.regions) {
            const p = toScreen(region.x, region.y);
            const r = Math.max(region.radius * s, 10);
            if (Math.hypot(p.x - sx, p.y - sy) <= r && region.radius < bestR) {
                bestR = region.radius;
                best = { kind: 'region', region, topic: null };
            }
        }
        return best;
    }, [baseScale, toScreen, toWorld]);

    // ---- drawing ------------------------------------------------------------
    drawRef.current = () => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        // How long since the last frame, once, for everything that moves. A
        // gap longer than a few frames is the loop having been IDLE — a paused
        // replay, a tab in the background, a map nobody has touched — and time
        // that passed while nothing was drawn is not time anything travelled
        // through.
        const now = performance.now();
        const frameMs = clockRef.current && now - clockRef.current < IDLE_GAP_MS
            ? now - clockRef.current : 0;
        clockRef.current = now;

        // ---- the replay's flight, settled BEFORE anything is painted -----
        //
        // Where the arrow is decides where the camera is, so it cannot be
        // worked out halfway down the draw: the map would be painted from one
        // frame's camera and the arrow from the next one's, and that
        // disagreement is a whole frame of judder on every frame of a replay.
        const { trace: tracing, journeyStep: stepNow, pace: paceNow } = live.current;
        // Integrated in `coursePaths.ts`, because the atlas has TWO surfaces
        // and a replay has to mean the same thing on both: the same beat, the
        // same share of it spent flying, the same rule for what counts as
        // travel and what counts as a cut. What is drawn between two topics is
        // this component's business; WHEN the arrow is between them is not.
        const flown = advanceFlight(flightRef.current, tracing, stepNow, frameMs, reduceMotion, paceNow);
        const flying = flown?.flying ?? false;
        // No course traced: nothing is being held for one either.
        if (!flown) followKRef.current = null;

        // ---- the camera looks AHEAD, and drifts -----------------------------
        //
        // TWO cameras, deliberately, because the two things a camera does are
        // not the same kind of decision.
        //
        // WHERE it points follows a WINDOW of the journey — where the eye is
        // now, and the next few places it is going — each point fading in and
        // out by weight as the eye approaches and leaves it, so the target
        // moves continuously and a pan runs across several legs instead of
        // restarting at each one. And the eye is NOT the arrow: it runs the
        // same journey at a constant one step per beat while the arrow covers
        // its leg in 72% of the beat and then waits, so the picture keeps
        // gliding through every arrival.
        //
        // HOW MUCH it holds is settled once per STEP and then defended: out at
        // once when the journey needs the room, back in only over seconds, and
        // not at all for a difference too small to be worth a move.
        //
        // The separation is not a preference. Every earlier arrangement tied
        // them together and each failed as its own kind of lurch: chasing the
        // arrow every frame slid the map under it (five to one in screen speed
        // inside one leg); flying the camera to the same place on the same
        // clock cancelled the arrow's motion almost exactly; framing the leg
        // being flown held beautifully still and then reframed between every
        // pair of topics. That last one is what shipped, and on a real course
        // — whose legs run from 0.02 to 1.3 world units, alternating — it meant
        // the zoom changing direction 25 times in 18 seconds, ×1.7 to ×5 and
        // back, with the picture's speed peaking at five times its own median.
        // None of which is visible in a frame: it is a shape in a line on a
        // chart, which is why `tools/harness/cam-trace.mjs` exists and why the
        // harness now asserts the shape rather than the frames.
        if (tracing && flown && followRef.current && stepNow != null && flown.landed > 0) {
            const cam0 = camRef.current;
            // Where the journey's topics are — which is also where they are
            // drawn, and the reason that matters is worth keeping: while the
            // drawn place ran from a region's centre to the topic on the zoom's
            // own ramp, reading it here put the camera in a loop with itself —
            // the zoom eased a little, every point in the window slid a little,
            // the centre being aimed at moved, and the pan surged. Measured at
            // an arrival where the zoom was easing out by 2.7%: 231 → 595
            // screen px/s between two frames. The ramp is gone; a topic is one
            // place, and there is only one reading of it left to take.
            const placeOf = (step: number) => {
                const p = tracing.points.get(tracing.journey[step - 1]);
                return p ? { x: p.x, y: p.y } : null;
            };
            // Where the camera's own eye is, on the chord of the leg rather
            // than its curve — which differs by the bulge and never by enough
            // to frame differently.
            const at = flown.eyeAt;
            const leaving = Math.floor(at);
            const from = placeOf(leaving);
            const to = placeOf(leaving + 1);
            const arrow = from && to
                ? { x: lerp(from.x, to.x, at - leaving), y: lerp(from.y, to.y, at - leaving) }
                : from;
            if (arrow) {
                // The window: the eye at full weight, the topic it is leaving
                // fading out behind it, and the ones ahead fading in — so no
                // point ever enters or leaves the framing as a step change.
                const seen: { x: number; y: number; w: number; away: number }[] =
                    [{ ...arrow, w: 1, away: 0 }];
                for (let step = leaving - 1; step <= leaving + LOOK_AHEAD; step++) {
                    if (step < 1 || step > tracing.journey.length) continue;
                    const p = placeOf(step);
                    if (!p) continue;
                    const away = step - at;
                    const w = away < 0
                        // Behind: gone one whole step after it was left.
                        ? clamp(1 + away, 0, 1)
                        // Ahead: full weight for the leg being flown, then
                        // fading over the rest of the look-ahead.
                        : clamp((LOOK_AHEAD - away) / Math.max(1e-6, LOOK_AHEAD - 1), 0, 1);
                    if (w > 0) seen.push({ ...p, w, away });
                }
                let sum = 0;
                let cx = 0;
                let cy = 0;
                for (const p of seen) { cx += p.x * p.w; cy += p.y * p.w; sum += p.w; }
                cx /= sum || 1;
                cy /= sum || 1;
                // ---- the room the journey needs, which is its OWN window ----
                //
                // Measured once per STEP, from the topics, and never from the
                // camera. Both halves of that are things the trace caught:
                //
                // Read every frame, the answer breathes. The room a set of
                // points needs, measured from a centre that is gliding through
                // them, is widest when the camera sits on one end of a leg and
                // half that when it is in the middle — so the zoom pulls out at
                // every arrival and creeps back in between, twice a second, for
                // ever. How far apart the next few topics are is a fact about
                // the journey; asking it of the camera's own position is what
                // made it a fact about the camera.
                //
                // And measured on the DRAWN places it is a feedback loop, since
                // where a topic is drawn runs from its region's centre to its
                // own place on the zoom's own ramp. The two differ by less than
                // a bubble — on the real journey the two framings agree to
                // within a few per cent — so the zoom reads the topics and the
                // loop is simply not there.
                const room: { x: number; y: number; w: number }[] = [];
                for (let step = leaving; step <= leaving + FIT_AHEAD; step++) {
                    if (step < 1 || step > tracing.journey.length) continue;
                    const p = tracing.points.get(tracing.journey[step - 1]);
                    if (!p) continue;
                    const ahead = step - leaving;
                    // This leg at full weight, then the steps beyond it fading:
                    // a long hop three steps away starts buying its room early,
                    // which is what stops the camera being surprised by it.
                    room.push({
                        x: p.x, y: p.y,
                        w: ahead <= 1 ? 1 : clamp((FIT_AHEAD - ahead) / (FIT_AHEAD - 1), 0, 1),
                    });
                }
                let rsum = 0, rx = 0, ry = 0;
                for (const p of room) { rx += p.x * p.w; ry += p.y * p.w; rsum += p.w; }
                rx /= rsum || 1;
                ry /= rsum || 1;
                let reach = 0;
                for (const p of room) reach = Math.max(reach, p.w * Math.hypot(p.x - rx, p.y - ry));
                const box = sizeRef.current;
                // That room, as a zoom: nothing in the window off the screen —
                // a path whose end the reader cannot see says nothing about
                // where it went — and nothing pulls the camera further in than
                // `FOLLOW_K`, which is the distance the topics are separate
                // places at.
                // A window with no room in it is the END of the journey, not a
                // reason to close in. On the last step there is nothing ahead,
                // so the window is one point, `reach` is zero — and reading
                // that as "this needs no room" drove the camera in to `FOLLOW_K`
                // on the final topic, at `ZOOM_IN_OMEGA`, for the whole of the
                // hold, and then the ending pulled it straight back out. Nobody
                // asked for that push in; it is only the window running out.
                //
                // So the shot stands — and it is the shot the camera is IN,
                // not the one the last window asked for. The two differ at
                // exactly this moment: the final leg frames two topics close
                // together, that pull inward is still travelling on the slow
                // arm going in, and it would spend the whole hold creeping
                // closer and then be reversed by the ending.
                // The journey is over when the ARROW has landed on the last
                // topic, not when the camera's eye finally catches up with it:
                // the eye trails the arrow by the landing's share of a beat and
                // spends another third of a second arriving, and for all of
                // that the window still holds the final leg and still asks to
                // close in on it. Measured: ×1.03 in, and then held there for
                // the whole of the hold by a spring still converging on it.
                const ended = reach <= 0 || flown.landed >= tracing.journey.length;
                const fit = ended
                    ? cam0.k
                    : Math.min(box.w, box.h) / (baseScale() * reach * 2 * LEG_MARGIN);
                // What the window asks for — and then the shot the camera is
                // actually HOLDING, which is the thing a reader watches. It
                // changes only when the window has moved outside the dead band,
                // so it is a step function of the journey and not a value being
                // chased; the travel between two of them belongs to the spring
                // below, which is where the asymmetry lives too.
                //
                // The end of the journey goes STRAIGHT through that band: the
                // band exists to stop the camera correcting itself over
                // differences too small to be worth a move, and here there is
                // nothing left to correct toward. Left to the band, the last
                // framing move finishes itself during the hold — up to ×1.2 in
                // on the real courses, every bit of it undone a second later by
                // the ending.
                //
                // Nor is the shot at the end held to `LEG_MIN_K`/`FOLLOW_K`:
                // those are what a LEG may ask for, and there is no leg. A
                // camera that ended the journey further out than `LEG_MIN_K`
                // would otherwise be pulled in to it during the hold.
                const need = ended ? fit : clamp(fit, LEG_MIN_K, FOLLOW_K);
                const held = followKRef.current;
                let hold = ended || held == null
                    || need < held / ZOOM_DEAD_OUT || need > held * ZOOM_DEAD_IN
                    ? need : held;
                // …and one thing the held shot may never argue with: the arrow
                // itself has to be inside the frame. What the window asks for is
                // a judgement about a good picture, and a good picture with the
                // subject outside it is not one — so the shot is capped at
                // whatever keeps the arrow on screen from where the camera
                // actually is. It fires about twice in a journey, each time a
                // step into a pull-out that has not finished, and it is the
                // difference between a camera that is behind and one that has
                // lost the thing it is following.
                //
                // Two things about it, each of which was wrong once. It is
                // folded INTO the held shot rather than applied over it every
                // frame: applied over it, the camera's own lag is in the answer
                // — a soft arm trails further on a fast leg than a slow one —
                // and the zoom wobbled some 5% within a step, following the
                // lag. And it may go below `LEG_MIN_K`, down to `MIN_K`: a poor
                // picture of the arrow beats a good picture of somewhere else.
                // (It used to ask this of two readings of where the arrow is,
                // its topic's place and its region's centre, because the drawn
                // arrow was between them and which one depended on the very
                // zoom being set. One place, one reading.)
                const half = baseScale();
                let cap = Infinity;
                {
                    const p = arrow;
                    const outX = Math.abs(p.x - cam0.x);
                    const outY = Math.abs(p.y - cam0.y);
                    if (outX > 1e-6) cap = Math.min(cap, (box.w / 2 * KEEP_IN_FRAME) / (half * outX));
                    if (outY > 1e-6) cap = Math.min(cap, (box.h / 2 * KEEP_IN_FRAME) / (half * outY));
                }
                if (cap < hold) hold = clamp(cap, MIN_K, FOLLOW_K);
                followKRef.current = hold;
                const k = hold;
                // A journey that has ended takes the zoom's momentum with it.
                // The arm is what stops the camera turning on the spot, and
                // everywhere else on this map that weight is the point — but
                // the last thing the zoom was doing was closing in on the final
                // leg, and coasting on for another 2% of it over the hold is a
                // picture still creeping toward something nobody is going to.
                // The PAN keeps its weight: the eye is still arriving.
                if (ended) velRef.current.lk = 0;
                if (Math.abs(cam0.x - cx) > 1e-4 || Math.abs(cam0.y - cy) > 1e-4
                    || Math.abs(cam0.k - k) > 1e-3) {
                    targetRef.current = {
                        x: cx, y: cy, k,
                        omega: FOLLOW_OMEGA,
                        kOmega: k < cam0.k ? ZOOM_OUT_OMEGA : ZOOM_IN_OMEGA,
                    };
                } else {
                    // Nowhere to go — and saying nothing here left the camera
                    // flying to wherever it was last sent. That is how the end
                    // of a journey closed in even once the window had stopped
                    // asking it to: the pan arrives, no new target is written,
                    // and the STALE one still holds the inward zoom of the last
                    // leg's framing. Measured at ×1.03 through the whole hold.
                    targetRef.current = null;
                }
            }
        }

        // ---- the camera has WEIGHT ------------------------------------------
        //
        // It hangs on an arm and is pulled toward the target, rather than being
        // interpolated toward it. The difference is momentum, and it is the
        // whole of what "sharp changes of direction" was: an exponential ease
        // is first-order, its speed is proportional to how far it has left to
        // go, so the instant the target turns the picture turns with it — in
        // ONE frame, with no radius. Measured on the physics journey before
        // this: the camera's heading changed by more than 42 degrees between
        // two frames on 1% of them, and by 94 — a reversal on the spot — at
        // worst. Nothing with mass moves like that, which is why it read as
        // wrong however smooth each individual motion was.
        //
        // The time is bought by the CLOCK rather than by the frame, for the
        // same reason as everything else here: at a fixed share per frame a
        // 30Hz phone moves at half the speed of a 60Hz desktop.
        const target = targetRef.current;
        if (target) {
            const cam = camRef.current;
            const vel = velRef.current;
            const dt = Math.min(frameMs, MAX_STEP_MS) / 1000;
            const omega = target.omega ?? FLY_OMEGA;
            const sx = spring(cam.x, vel.x, target.x, omega, dt);
            const sy = spring(cam.y, vel.y, target.y, omega, dt);
            // The zoom swings in LOG space, because zoom is a ratio: 5 → 1.7
            // moved linearly spends its first frames covering most of the
            // ground and then crawls, which reads as the map falling away and
            // catching itself. Halfway between 5 and 1.7 is 2.9, not 3.35.
            const sk = spring(Math.log(cam.k), vel.lk, Math.log(target.k),
                target.kOmega ?? omega, dt);
            const done = Math.abs(target.x - sx.x) < 1e-4
                && Math.abs(target.y - sy.x) < 1e-4
                && Math.abs(Math.log(target.k) - sk.x) < 1e-3
                && Math.hypot(sx.v, sy.v) < 1e-3 && Math.abs(sk.v) < 1e-3;
            if (done) {
                camRef.current = { x: target.x, y: target.y, k: target.k };
                velRef.current = { x: 0, y: 0, lk: 0 };
                targetRef.current = null;
            } else {
                camRef.current = { x: sx.x, y: sy.x, k: Math.exp(sk.x) };
                velRef.current = { x: sx.v, y: sy.v, lk: sk.v };
            }
        }

        const { w, h } = sizeRef.current;
        const cam = camRef.current;
        const s = baseScale() * cam.k;
        const detail = clamp((cam.k - TOPIC_FADE_START) / (TOPIC_FADE_FULL - TOPIC_FADE_START), 0, 1);
        // Topic NAMES are not the topic dots: a dot at 30% opacity is a hint
        // that there is something in there, a name at 30% opacity is unreadable
        // text in the way. So they get their own ramp, starting where the dots
        // are already solid enough to own a label.
        const nameFade = clamp((detail - NAME_FADE_START) / (1 - NAME_FADE_START), 0, 1);
        const dpr = dprRef.current;
        // The canvas is not laid out by the document, so `ui_scale` only reaches
        // the labels if the map asks for it. Same cadence as the pixel ratio.
        refreshRootFontScale();
        const { steps, acc } = palette;
        const {
            regions: all, selectedId: selected, matches: matched,
            trace: traced, tracedRegions: tracedIn, journeyStep: journeyAt,
            colorMode: paint, hues: courseHue, regionNames: showNames,
        } = live.current;
        const hovered = hoverRef.current;
        const focus = hovered || pinnedRef.current;
        // What the card is describing, which is not the same question as what
        // the pointer is over: a pin outlives the hover that created it.
        const carded = pinnedRef.current || focus;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = palette.surface;
        ctx.fillRect(0, 0, w, h);

        // A faint dot grid, purely so panning has something to move against: on
        // an empty stretch of flat surface a drag reads as nothing happening.
        const step = 0.1;
        if (step * s > 14) {
            const x0 = Math.floor((cam.x - w / 2 / s) / step) * step;
            const y0 = Math.floor((cam.y - h / 2 / s) / step) * step;
            ctx.fillStyle = palette.grid;
            for (let gx = x0; gx < cam.x + w / 2 / s + step; gx += step) {
                for (let gy = y0; gy < cam.y + h / 2 / s + step; gy += step) {
                    const p = toScreen(gx, gy);
                    ctx.fillRect(p.x, p.y, 1, 1);
                }
            }
        }

        const regionMatches = (r: AtlasRegion) => !matched || r.topics.some(t => matched.has(t.id));
        // Tracing a course dims the rest of the library the way searching does.
        // It multiplies with the search dim rather than replacing it: both
        // questions can be asked at once, and a region that answers neither
        // should be fainter than one that answers one of them.
        const traceDim = (r: AtlasRegion) => (tracedIn && !tracedIn.has(r.id) ? TRACE_REGION_DIM : 1);

        // Largest first, so a small region is never buried by a big one.
        const ordered = [...all].sort((a, b) => b.radius - a.radius);
        const visible: AtlasRegion[] = [];
        for (const region of ordered) {
            const p = toScreen(region.x, region.y);
            const r = region.radius * s;
            if (p.x + r < -40 || p.x - r > w + 40 || p.y + r < -40 || p.y - r > h + 40) continue;
            visible.push(region);

            const isSelected = region.id === selected;
            const isHovered = focus?.region.id === region.id;
            const dim = (regionMatches(region) ? 1 : 0.16) * traceDim(region);

            ctx.globalAlpha = dim * (1 - 0.62 * detail);
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fillStyle = regionColor(region, paint, courseHue, accent, dark);
            ctx.fill();
            ctx.globalAlpha = dim * (0.35 + 0.45 * detail);
            ctx.strokeStyle = palette.ring;
            ctx.lineWidth = 1;
            ctx.stroke();

            if (isSelected || isHovered) {
                ctx.globalAlpha = dim;
                ctx.beginPath();
                ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
                ctx.strokeStyle = acc(isSelected ? 0.95 : 0.6);
                ctx.lineWidth = isSelected ? 2.5 : 1.5;
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
        }

        // ---- the traced course: the route walked through it. Drawn here,
        // after the bubbles and before every label, so the line sits under the
        // text and under the topic dots it runs between — a path over its own
        // endpoints hides the thing it is about.
        //
        // A topic is drawn WHERE IT IS, at every zoom. Running the path from
        // each topic's region centre out to its own place on the same `detail`
        // ramp the dots fade in on makes the route a function of the camera:
        // every leg swings between two different shapes as you zoom, legs
        // inside one bubble grow out of nothing, and the line you were looking
        // at is not the line you get back. A map you can zoom is a map whose
        // contents hold still — so the journey is one fixed shape in world
        // coordinates, and zooming only ever makes it bigger. The traced
        // course's own dots are drawn at every zoom to go with it (see the
        // topic layer below), or the ends of the line would be places with
        // nothing marking them.
        // What the reader is being asked to look at right now: the topic the
        // arrow has reached, and — while it is in the air — the one it is
        // heading for. The two cross-fade, so neither name blinks.
        let journeyHead: { x: number; y: number; topic: AtlasTopic; alpha: number } | null = null;
        let journeyNext: { x: number; y: number; topic: AtlasTopic; alpha: number } | null = null;
        /** The replay's arrow, held back until every label has been painted. */
        let drawHead: (() => void) | null = null;
        /**
         * The place a running replay is about, lit — and how brightly.
         *
         * Two entries while the arrow is in the air, cross-fading exactly as
         * the two names do: the light drains out of the place being left and
         * fills the one being approached, so an arrival is something the map
         * does gradually and finishes ON the beat, rather than a lamp that
         * switches on after the fact. One entry at full strength while it
         * rests. Empty when no replay is running: on a finished path the head
         * is "the last thing you closed", and a spotlight left burning there
         * would be a permanent mark on the map.
         */
        let journeyLit: Map<number, number> | null = null;
        if (traced && flown) {
            const at = (p: { x: number; y: number }) => toScreen(p.x, p.y);
            // A segment whose bounding box misses the viewport cannot cross it.
            const offScreen = (a: { x: number; y: number }, b: { x: number; y: number }) =>
                Math.max(a.x, b.x) < -40 || Math.min(a.x, b.x) > w + 40
                || Math.max(a.y, b.y) < -40 || Math.min(a.y, b.y) > h + 40;

            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = palette.ink;

            // The journey: one curve through the topics in the order they were
            // finished, so an arrow flying it turns into each corner rather
            // than pivoting on the spot. The points are the topics themselves,
            // so the curve is the same shape at every zoom and a pan or a zoom
            // moves the reader over it rather than redrawing it.
            // Where the arrow is was settled at the top of this draw, with the
            // camera that rides on it. How many topics have been REACHED, and
            // how far into the leg out of the last one it has got.
            const { landed, frac, inAir } = flown ?? { landed: 0, frac: 0, inAir: false };

            const places = traced.journey.map(id => {
                const p = traced.points.get(id);
                return p ? at(p) : null;
            });
            // A missing point would break the curve's neighbour arithmetic, so
            // the route is built from what is actually drawable. It cannot
            // happen from `traceCourse` (the journey is built from the same map
            // the points are) — this is what keeps that true rather than
            // assumed.
            const drawable = places.every(p => p !== null);
            const legs: Leg[] = drawable ? flightPath(places as { x: number; y: number }[]) : [];

            // Every leg is its own stroke because every leg is drawn at its own
            // weight: the path fades back as it recedes into the past, so
            // "where I am now" is the brightest thing on the map and "where I
            // started" is still there to be traced back to. A single path at
            // one alpha says only that a route exists, not which way it runs.
            const legBox = (l: Leg) => ({
                a: { x: Math.min(l.x0, l.x1, l.x2, l.x3), y: Math.min(l.y0, l.y1, l.y2, l.y3) },
                b: { x: Math.max(l.x0, l.x1, l.x2, l.x3), y: Math.max(l.y0, l.y1, l.y2, l.y3) },
            });
            const strokeLeg = (l: Leg) => {
                ctx.beginPath();
                ctx.moveTo(l.x0, l.y0);
                ctx.bezierCurveTo(l.x1, l.y1, l.x2, l.y2, l.x3, l.y3);
                ctx.stroke();
            };
            // A CUT still fading (a restart takes a finished path back to step
            // one in one frame): the route as it stood, and the marker at its
            // end, drawn going away rather than vanishing.
            const cut = flown?.cut ?? null;
            let ghostHead: { x: number; y: number; angle: number; p: number } | null = null;
            if (cut && legs.length) {
                const was = Math.max(0, Math.round(cut.from));
                const fade = 1 - cut.p;
                for (let i = 1; i <= was - 1 && was > landed; i++) {
                    const whole = legs[i - 1];
                    if (!whole) continue;
                    const box = legBox(whole);
                    if (offScreen(box.a, box.b)) continue;
                    const age = was > 2 ? (i - 1) / (was - 2) : 1;
                    const width = lerp(JOURNEY_MIN_WIDTH, JOURNEY_MAX_WIDTH, age);
                    const alpha = lerp(JOURNEY_MIN_ALPHA, 1, age) * fade;
                    ctx.globalAlpha = alpha * JOURNEY_HALO_ALPHA;
                    ctx.strokeStyle = palette.surface;
                    ctx.lineWidth = width + JOURNEY_HALO_WIDTH;
                    strokeLeg(whole);
                    ctx.globalAlpha = alpha;
                    ctx.strokeStyle = palette.ink;
                    ctx.lineWidth = width;
                    strokeLeg(whole);
                }
                const wasPoint = was !== landed && was > 0 ? places[was - 1] : null;
                if (wasPoint) ghostHead = { x: wasPoint.x, y: wasPoint.y, angle: 0, p: cut.p };
                ctx.globalAlpha = 1;
            }

            // The last leg drawn is the one being flown, if any.
            const lastLeg = inAir ? landed : landed - 1;
            for (let i = 1; i <= lastLeg; i++) {
                const whole = legs[i - 1];
                if (!whole) continue;
                const box = legBox(whole);
                if (offScreen(box.a, box.b)) continue;
                // By DISTANCE along the leg, not by the curve's parameter:
                // the two are not the same axis, and flying the second is
                // what made the arrow crawl out of a topic and then bolt.
                const flown = i === lastLeg && inAir ? legUpTo(whole, legParam(whole, frac)) : whole;
                if (Math.abs(flown.x3 - flown.x0) + Math.abs(flown.y3 - flown.y0) < MIN_SEGMENT
                    && Math.abs(flown.x1 - flown.x0) + Math.abs(flown.y1 - flown.y0) < MIN_SEGMENT) continue;
                // Age, as a fraction: 0 is the first step ever taken, 1 the
                // last one drawn. With a single step there is no ramp to run,
                // and the one leg is the newest by definition.
                const age = lastLeg > 1 ? (i - 1) / (lastLeg - 1) : 1;
                const width = lerp(JOURNEY_MIN_WIDTH, JOURNEY_MAX_WIDTH, age);
                const alpha = lerp(JOURNEY_MIN_ALPHA, 1, age);
                ctx.globalAlpha = alpha * JOURNEY_HALO_ALPHA;
                ctx.strokeStyle = palette.surface;
                ctx.lineWidth = width + JOURNEY_HALO_WIDTH;
                strokeLeg(flown);
                ctx.globalAlpha = alpha;
                ctx.strokeStyle = palette.ink;
                ctx.lineWidth = width;
                strokeLeg(flown);

                // Which way. A journey without direction is a shape; with it,
                // it is an order of events — and the order is the only reason
                // to draw it. The mark goes at the midpoint rather than the end
                // so it is never buried under the dot it points at, only on a
                // leg long enough on screen to hold one, and never on the leg
                // the arrow itself is flying — two arrowheads on one line is
                // one too many.
                if (i === lastLeg && inAir) continue;
                if (Math.hypot(whole.x3 - whole.x0, whole.y3 - whole.y0) < ARROW_MIN_LENGTH) continue;
                const mid = legAt(whole, 0.5);
                const ux = Math.cos(mid.angle), uy = Math.sin(mid.angle);
                ctx.beginPath();
                ctx.moveTo(mid.x + ux * ARROW_SIZE, mid.y + uy * ARROW_SIZE);
                ctx.lineTo(mid.x - ux * ARROW_SIZE - uy * ARROW_SIZE * 0.7, mid.y - uy * ARROW_SIZE + ux * ARROW_SIZE * 0.7);
                ctx.lineTo(mid.x - ux * ARROW_SIZE + uy * ARROW_SIZE * 0.7, mid.y - uy * ARROW_SIZE - ux * ARROW_SIZE * 0.7);
                ctx.closePath();
                ctx.fillStyle = palette.ink;
                ctx.fill();
            }

            // The two ends: a hollow ring where the course was started, and the
            // head — an arrow while it is travelling, a marker once it has
            // landed. Both are drawn at every zoom, so even at the smallest
            // scale the map says where this began and where it has got to.
            const first = traced.points.get(traced.journey[0]);
            const landedPoint = traced.points.get(traced.journey[Math.max(0, landed - 1)]);
            const nextPoint = inAir ? traced.points.get(traced.journey[landed]) : null;
            if (first && landed > 0) {
                const p = at(first);
                ctx.globalAlpha = 0.55;
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = palette.ink;
                ctx.beginPath();
                ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
                ctx.stroke();
            }
            if (landedPoint && landed > 0) {
                const p = at(landedPoint);
                journeyHead = { x: p.x, y: p.y, topic: landedPoint.topic, alpha: 1 - frac };
                if (nextPoint) {
                    const q = at(nextPoint);
                    journeyNext = { x: q.x, y: q.y, topic: nextPoint.topic, alpha: frac };
                }
                // Only while a replay is actually running: on a finished path
                // the head is "the last thing you closed", and marking that
                // permanently would put a spotlight on the map for as long as
                // the course was traced.
                if (journeyAt != null) {
                    journeyLit = new Map([[landedPoint.topic.id, 1 - frac]]);
                    if (nextPoint) journeyLit.set(nextPoint.topic.id, frac);
                }
                // Where the arrow is and which way it points: on the curve it
                // is flying, or resting on the topic it reached.
                const leg = inAir ? legs[landed - 1] : null;
                const head = leg ? legAt(leg, legParam(leg, frac)) : { x: p.x, y: p.y, angle: 0 };

                // Drawn LAST, after every label on the map — not here, where
                // the rest of the trace is. The path belongs under the names it
                // runs between, but the head is the one thing the reader is
                // following, and down here a topic name printed across it wins.
                // It did: on a real library the arrow spent half the replay
                // behind other topics' labels.
                // A glow in the accent, which is this app's "you are here"
                // everywhere else on this map, under an arrow in the air and a
                // dot on the ground — the two crossing over at each end of the
                // leg (`paintHead`). A cut fades the new head in while the old
                // one fades out.
                const arrow = leg ? headMorph(frac, flightMs(traced, landed + 1, paceNow)) : 0;
                const cutIn = cut ? cut.p : 1;
                const ghost = ghostHead;
                drawHead = () => {
                    const look = { ink: palette.ink, outline: palette.surface, acc };
                    if (ghost) paintHead(ctx, ghost, look, 0, 1 - ghost.p, 1 - 0.4 * ghost.p);
                    paintHead(ctx, head, look, arrow, cutIn, 0.6 + 0.4 * cutIn);
                };

            } else if (ghostHead) {
                const ghost = ghostHead;
                drawHead = () => paintHead(ctx, ghost, { ink: palette.ink, outline: palette.surface, acc }, 0, 1 - ghost.p, 1 - 0.4 * ghost.p);
            }
            ctx.globalAlpha = 1;
        }

        // Label placement lives in `mapLabels.ts` — measured text, collision
        // testing and the inside-the-bubble rule are the parts of this map that
        // can be wrong without throwing anything, so they are kept somewhere a
        // script can draw them and a person can look.
        // Deferred: every name is PLACED here, in the order that decides which
        // one wins a contested spot, and PAINTED at the end — over the dots and
        // the bubbles rather than under whatever happens to be drawn next. The
        // region names and the replay's own label are placed before the topic
        // dots exist, and without this they were painted before them too.
        const labeller = createLabeller(ctx, {
            width: w, height: h, ink: palette.ink, halo: palette.surface, defer: true,
        });

        // The step the journey has reached is named BEFORE anything else on the
        // map, because it is the one label the reader is actually waiting for
        // during a replay — and in this labeller, first placed is first served.
        // Only while a replay is running: on a finished path the head is "the
        // last thing you closed", which the topic card already answers on hover
        // and which would otherwise print a permanent label over the map.
        // While the arrow is in the air both ends are named, cross-fading: the
        // topic it left goes as it goes, the one it is arriving at is readable
        // before it lands. The stronger of the two is placed first, because in
        // this labeller first placed is first served — the name being arrived
        // at must not lose its ground to the one being left.
        if (journeyAt != null && journeyHead) {
            const both = journeyNext ? [journeyHead, journeyNext] : [journeyHead];
            both.sort((a, b) => b.alpha - a.alpha);
            for (const label of both) {
                if (label.alpha <= VISIBLE_ALPHA) continue;
                // Clear of the mark under it: the place being arrived at is lit
                // with a 22px halo, and a name set 14px above the dot was
                // printed across its own spotlight.
                labeller.wrapLabel(label.topic.title, label.x, label.y - 30,
                    { size: 13, weight: 700, alpha: label.alpha }, Math.min(w * 0.6, 260), 2);
            }
        }

        // Region names FIRST, because a label that is painted later is the
        // one that gets dropped on a collision — the old code said region names
        // won and did the opposite. At any zoom the place names are what keep
        // the reader oriented, so they claim their ground before the topic
        // names fill in around them.
        const named = [...visible].sort((a, b) => {
            const rank = (r: AtlasRegion) => (r.id === selected ? 2 : r.id === focus?.region.id ? 1 : 0);
            return rank(b) - rank(a) || b.size - a.size;
        });
        // Turned off, the whole pass is skipped rather than drawn at zero alpha:
        // it measures and wraps every visible region's name every frame, and a
        // reader who has switched the names off has asked for exactly that work
        // not to happen. The SELECTED region keeps its name — it is the one
        // place the reader has pointed at, and a selection with no name is a
        // ring round an anonymous blob.
        for (const region of named) {
            if (!showNames && region.id !== selected) continue;
            const p = toScreen(region.x, region.y);
            const r = region.radius * s;
            if (r < MIN_NAMED_RADIUS && region.id !== selected) continue;
            const isSelected = region.id === selected;
            // Type size tracks the bubble, the way it does on any map: a big
            // region carries a big name, a small one a small name. It is also
            // what lets the small bubbles be named at all — at one fixed size
            // their names would collide with everything around them and be
            // dropped, which is how most of the map ended up nameless.
            const size = labelPx(clamp(Math.round(r * 0.34), MIN_LABEL_PX, MAX_NAME_PX));
            // The region name fades out as the reader zooms in: the bubble it
            // names is itself fading (its fill goes to `1 - 0.62 * detail`),
            // and once the topics inside are on screen the name is chrome
            // floating over them. It must not outlive the bubble it belongs to.
            // A traced course dims the region NAMES with the regions they
            // belong to. Without it the picture is the one thing the reader
            // asked for — one line across the library — under a hundred place
            // names at full strength, all of them about somewhere else. The
            // course's own regions stay bright, which is what makes the route
            // legible as a route.
            const nameAlpha = (regionMatches(region) ? 1 : 0.3) * (1 - detail) * traceDim(region);
            // An invisible name is not a name. The labeller refuses one anyway,
            // but the whole measure-and-wrap pass behind it is per region per
            // frame, and at this zoom most of the map is faded out.
            //
            // Carrying the name on past the fade was tried and is WRONG, for a
            // reason that is about paint order rather than taste: region names
            // are painted before the topic dots, so a name still on screen once
            // the topics have risen is not merely competing with them, it is
            // UNDER them — grey text behind a field of circles. It also bought
            // nothing at the zooms where names are drawn: pulling a name toward
            // the visible part of its bubble, measured across both viewports and
            // every zoom from 0.7 to 2.6, placed exactly zero extra names while
            // moving up to seven of them off centre. So the name belongs to the
            // regions layer and dies with it, and the reader who has zoomed past
            // it is oriented by the region list and the topic card instead.
            if (nameAlpha < 0.04) continue;
            labeller.placeRegion(region.label, p.x, p.y, r, {
                size: isSelected ? size + 2 : size,
                weight: isSelected ? 800 : 700,
                alpha: nameAlpha,
            }, { maxLines: r > 26 ? 3 : 2 });
        }

        // Is a name still on its way in or out? The draw loop is on demand, so
        // a fade has to ask for the frames it needs.
        let fading = false;

        // Topics, once the reader is close enough for them to mean anything —
        // and the traced course's own topics at every distance, because the
        // journey is drawn between them at every distance. A line whose ends
        // are nothing is the fault the old collapse-onto-the-bubble ramp was
        // there to avoid, and drawing the dozen or so places the route actually
        // visits is the cheaper half of that bargain: it costs one small mark
        // per step and keeps the route honest about where it goes.
        if (detail > 0.01 || traced) {
            const wanted: { topic: AtlasTopic; p: { x: number; y: number }; rank: number; slot: number; dot: number }[] = [];
            for (const region of visible) {
                const rr = Math.max(region.topicRadius * s, 1.5);
                // Per TOPIC once a course is traced, not per region: a bubble
                // the course reaches is usually shared with other courses, and
                // dimming it wholesale would hide the very dots the path runs
                // between while leaving their neighbours just as bright.
                const dim = regionMatches(region) ? 1 : 0.16;
                for (const topic of region.topics) {
                    const p = toScreen(topic.x, topic.y);
                    if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) continue;
                    const isMatch = matched ? matched.has(topic.id) : false;
                    // Ringed if the pointer is on it OR the card is about it.
                    // Reaching for the card's button takes the pointer off the
                    // dot, and the dot the card describes going unmarked at
                    // exactly that moment is the same bug as the card moving.
                    const isFocused = focus?.topic?.id === topic.id
                        || carded?.topic?.id === topic.id;
                    const inTrace = !traced || traced.points.has(topic.id);
                    // The place the replay is about, lit like a stage: a disc
                    // of accent under the dot, wider than the dot, at full
                    // strength however far the rest of this bubble has been
                    // dimmed. The arrow lands ON it, so the mark has to be
                    // readable from under the marker — an outline alone
                    // disappears beneath the head.
                    const lit = journeyLit?.get(topic.id) ?? 0;
                    if (lit > 0.01) {
                        ctx.globalAlpha = lit;
                        // Sized in PIXELS with the dot as a floor, not as a
                        // margin around it: a dot is ~5px across at the zoom a
                        // replay is watched from, and a halo four pixels wider
                        // than that disappears under the arrow standing on it.
                        const halo = Math.max(rr + 11, 22);
                        for (const [r, a] of [[halo, 0.14], [Math.max(rr + 5, 13), 0.34]]) {
                            ctx.beginPath();
                            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
                            ctx.fillStyle = acc(a);
                            ctx.fill();
                        }
                        // A drawn edge on it, because a glow alone reads as
                        // something the map is doing to the light rather than
                        // as a mark on a place — and on a bubble whose own
                        // colour is already bright it barely reads at all.
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, halo, 0, Math.PI * 2);
                        ctx.strokeStyle = acc(0.6);
                        ctx.lineWidth = 1.5;
                        ctx.stroke();
                    }
                    // How much of the topic layer this dot gets. The traced
                    // course's own topics keep a floor, because the path is
                    // drawn between them however far out the reader is; every
                    // other dot still fades in only as they arrive.
                    const solid = traced && inTrace ? Math.max(detail, TRACE_DOT_MIN) : detail;
                    const alpha = solid * (matched && !isMatch ? 0.14 : dim)
                        * (inTrace ? 1 : TRACE_TOPIC_DIM);
                    // Zoomed out with a course traced, everything not on the
                    // route is invisible — and painting two thousand invisible
                    // discs a frame is what the floor above would otherwise
                    // cost, on every frame of every replay.
                    if (alpha <= 0.004) continue;
                    ctx.globalAlpha = alpha;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
                    // The same encoding the regions use, one step down the same
                    // ladder: the saturated end is proven, the pale end
                    // untouched — in the accent's hue, or in this topic's own
                    // course's, depending on what colour means right now.
                    const topicStep = topic.status === 'completed'
                        ? 4
                        : (topic.attempts > 0 || topic.status === 'in_progress') ? 2 : 0;
                    ctx.fillStyle = paint === 'course'
                        ? courseFill(courseHue.get(topic.projectId), topicStep, dark)
                        : steps[topicStep];
                    ctx.fill();
                    if (isMatch || isFocused || lit > 0.01) {
                        if (lit > 0.01) ctx.globalAlpha = lit;
                        ctx.strokeStyle = acc(0.95);
                        ctx.lineWidth = 2;
                        ctx.stroke();
                    } else if (rr > 3) {
                        ctx.globalAlpha = solid * 0.5 * dim * (inTrace ? 1 : TRACE_TOPIC_DIM);
                        ctx.strokeStyle = palette.ring;
                        ctx.lineWidth = 1;
                        ctx.stroke();
                    }
                }
                ctx.globalAlpha = 1;

                // Topic names, but only once a dot is big enough that a name
                // beside it belongs to it unambiguously — AND only once they
                // can be drawn solidly. Fading them in on the same ramp as the
                // dots meant that through the whole middle of the zoom the map
                // carried a layer of near-invisible grey text: too faint to
                // read, too present to see past. They have their own, later
                // ramp, and below it they are simply not drawn.
                //
                // "Big enough" is itself a ramp, not a line: see NAME_DOT_MIN.
                const dot = clamp((rr - NAME_DOT_MIN) / (NAME_DOT_FULL - NAME_DOT_MIN), 0, 1);
                if (dot > 0 && nameFade > 0) {
                    // Collect, don't paint. Two things went wrong here. The
                    // loop walked EVERY topic in the region including the ones
                    // far off screen — `free()` rejects those, but only after
                    // measuring and wrapping them, once per frame of every pan.
                    // And it painted region by region in array order, which in
                    // this labeller IS the priority order, so a topic the reader
                    // had just searched for lost its name to whichever unrelated
                    // dot happened to sit earlier in an earlier region.
                    let slot = 0;
                    for (const topic of region.topics) {
                        const p = toScreen(topic.x, topic.y);
                        if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) continue;
                        wanted.push({
                            topic, p, slot: slot++, dot,
                            rank: focus?.topic?.id === topic.id ? 2 : matched?.has(topic.id) ? 1 : 0,
                        });
                    }
                }
            }

            // One pass over the whole screen, in the order the reader cares
            // about: what they are pointing at, then what they searched for,
            // then everything else — and WITHIN that, one name per bubble
            // before any bubble gets a second.
            //
            // The dots inside a region are packed about six dot-widths apart
            // while a name is ten times that wide, so at any zoom most names
            // lose and the only question is which. Walking region by region
            // answered it with "whichever the array listed first", which spent
            // the whole budget on the earliest bubbles and left later ones
            // completely unlabelled. Sorting by slot deals the names out round
            // robin instead. Measured on the real library at phone width, k=4:
            // every one of the 18 visible bubbles carries a name, against 15
            // before, and 42 names are drawn rather than 37.
            wanted.sort((a, b) => b.rank - a.rank || a.slot - b.slot);

            // Each name is drawn at its own eased opacity rather than at the
            // one the zoom asks for, so it arrives the way the region names do
            // — including the names that arrive without any zoom at all, when
            // the neighbour that was sitting on their ground moves away.
            const fades = nameAlphaRef.current;
            const onScreen = new Set<number>();
            for (const { topic, p, dot } of wanted) {
                onScreen.add(topic.id);
                const target = nameFade * dot
                    * (matched && !matched.has(topic.id) ? 0.3 : 1)
                    * (traced && !traced.points.has(topic.id) ? 0.25 : 1)
                    // While a replay is running the map carries ONE topic name:
                    // the place being flown to, printed by the journey's own
                    // label pass above. Zeroing the target here rather than
                    // skipping the collection means the forty names already on
                    // screen fade out on their own ramp when Play is pressed,
                    // instead of being cut off mid-sentence.
                    * (journeyAt != null ? 0 : 1);
                const prev = fades.get(topic.id) ?? 0;
                const next = reduceMotion ? target : prev + (target - prev) * NAME_EASE;
                // Nothing to draw and nothing left to fade: skip the measuring
                // and the collision test entirely. During a replay EVERY topic
                // name is asked for at zero (the journey prints the one name
                // that matters), so once they have faded out this is the whole
                // label pass — dozens of `measureText` calls and a collision
                // test each, every frame, for text at opacity 0. On a phone
                // that is the frame budget the flight is supposed to be
                // spending on moving.
                if (target === 0 && next < 0.01) { fades.set(topic.id, 0); continue; }
                // The first frames of a fade are below the opacity the labeller
                // will draw at all, so ask AT that floor while climbing: a
                // refusal has to mean "no room", never "too faint", or the name
                // would fade in to nothing.
                const ask = Math.max(next, Math.min(target, VISIBLE_ALPHA + 0.01));
                // Same wrapping as region names: measured, greedy, up to two
                // lines, ellipsized if it still doesn't fit. A topic name is
                // chrome over its dot, and a wrapped name reads better than a
                // truncated one.
                const placed = labeller.wrapLabel(topic.title, p.x, p.y, {
                    size: labelPx(TOPIC_NAME_PX), weight: 500, alpha: ask,
                }, Math.min(w * 0.5, 210), 2);
                // A name with nowhere to go is back to nothing, so when the
                // neighbour sitting on its ground moves away it fades in rather
                // than snapping on. It also settles there: only a name being
                // DRAWN can hold the loop open, or a crowded map — where most
                // names lose, every frame, forever — would repaint at 60Hz for
                // as long as it was on screen.
                fades.set(topic.id, placed ? next : 0);
                if (placed && Math.abs(target - next) > 0.01) fading = true;
            }
            for (const id of fades.keys()) if (!onScreen.has(id)) fades.delete(id);
        } else if (nameAlphaRef.current.size) {
            nameAlphaRef.current.clear();
        }

        // Every name is placed; now it is painted, over every bubble and every
        // dot. The arrow goes over all of it.
        labeller.flush();
        drawHead?.();

        // Keep the open card pinned to the thing it describes. Guarded on real
        // movement: this runs inside the draw loop, and an unguarded setState
        // here would re-render React on every animation frame of a pan.
        // Anchored on `carded`, not on `focus`. Anchoring it on the hover meant
        // that reaching for the card's own button moved the card: the pointer
        // leaves the dot, crosses the parent bubble on the way up, the region
        // becomes the focus, and the card jumps to the middle of the parent.
        // See `card` in the render for the other half of this.
        if (carded) {
            const at = carded.topic
                ? toScreen(carded.topic.x, carded.topic.y)
                : toScreen(carded.region.x, carded.region.y);
            const off = carded.topic
                ? Math.max(carded.region.topicRadius * s, 3) + 8
                : carded.region.radius * s + 8;
            const next = { x: at.x, y: at.y, r: off };
            const prev = anchorRef.current;
            if (!prev || Math.abs(prev.x - next.x) > 0.5 || Math.abs(prev.y - next.y) > 0.5
                || Math.abs(prev.r - next.r) > 0.5) {
                anchorRef.current = next;
                setAnchor(next);
            }
        }

        const topicsOn = cam.k > TOPIC_FADE_START;
        if (topicsShownRef.current !== topicsOn) {
            topicsShownRef.current = topicsOn;
            setShowingTopics(topicsOn);
        }

        // A cut still fading keeps the loop alive too: the old path is going away.
        const busy = !!targetRef.current || fading || flying || !!flown?.cut;
        stillRef.current = !busy;
        if (busy) requestDraw();
    };

    // Redraw whenever what is drawn changes.
    useEffect(() => { requestDraw(); }, [regions, selectedId, matches, palette, trace, journeyStep, colorMode, hues, requestDraw]);

    // ---- sizing -------------------------------------------------------------
    useEffect(() => {
        const wrap = wrapRef.current;
        const canvas = canvasRef.current;
        if (!wrap || !canvas) return;
        const ro = new ResizeObserver(() => {
            const rect = wrap.getBoundingClientRect();
            const dpr = captureRatio(capture, rect.width);
            refreshRootFontScale();
            dprRef.current = dpr;
            sizeRef.current = { w: rect.width, h: rect.height };
            // While capturing, the frame's size is the ANSWER and the box is
            // only where it is drawn: rounding the backing store off the CSS
            // width would put a 1919 or a 1081 in the file.
            canvas.width = capture ? capture.width : Math.max(1, Math.round(rect.width * dpr));
            canvas.height = capture ? capture.height : Math.max(1, Math.round(rect.height * dpr));
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
            requestDraw();
        });
        ro.observe(wrap);
        return () => ro.disconnect();
    }, [requestDraw, capture]);

    // ---- pointer interaction ------------------------------------------------
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const active = new Map<number, { x: number; y: number }>();
        let panning = false;
        let moved = 0;
        let last = { x: 0, y: 0 };
        let pinchDist = 0;
        let pinchMid: { x: number; y: number } | null = null;

        const local = (e: PointerEvent) => {
            const rect = canvas.getBoundingClientRect();
            return { x: e.clientX - rect.left, y: e.clientY - rect.top };
        };

        const panBy = (dx: number, dy: number) => {
            const s = baseScale() * camRef.current.k;
            camRef.current = { ...camRef.current, x: camRef.current.x - dx / s, y: camRef.current.y - dy / s };
            targetRef.current = null;
            velRef.current = { x: 0, y: 0, lk: 0 };
            followRef.current = false;
        };

        /** Re-arm a one-finger drag from where that finger IS right now. */
        const armPan = (from: { x: number; y: number }, tap: boolean) => {
            panning = true;
            last = { ...from };
            moved = tap ? 0 : CLICK_SLOP + 1;
        };

        const onDown = (e: PointerEvent) => {
            canvas.setPointerCapture(e.pointerId);
            active.set(e.pointerId, local(e));
            if (active.size === 1) {
                armPan(local(e), true);
            } else if (active.size === 2) {
                const [a, b] = [...active.values()];
                pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
                pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                // A second finger ends the drag the first one was doing, and it
                // can never end as a tap.
                panning = false;
                moved = CLICK_SLOP + 1;
                if (hoverRef.current) { hoverRef.current = null; setHover(null); }
            }
        };

        const onMove = (e: PointerEvent) => {
            const p = local(e);
            if (active.has(e.pointerId)) active.set(e.pointerId, p);

            if (active.size === 2) {
                const [a, b] = [...active.values()];
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                if (pinchDist > 0 && d > 0) zoomAt(d / pinchDist, mid.x, mid.y);
                // Two fingers move the map as well as scale it — a pinch is
                // never purely radial, and ignoring the drift meant the map
                // slid out from under the fingers holding it.
                if (pinchMid) panBy(mid.x - pinchMid.x, mid.y - pinchMid.y);
                pinchDist = d;
                pinchMid = mid;
                moved = CLICK_SLOP + 1;
                requestDraw();
                return;
            }

            if (panning) {
                const dx = p.x - last.x, dy = p.y - last.y;
                moved += Math.hypot(dx, dy);
                if (moved > CLICK_SLOP && hoverRef.current) { hoverRef.current = null; setHover(null); }
                panBy(dx, dy);
                last = p;
                canvas.style.cursor = 'grabbing';
                requestDraw();
                return;
            }

            const hit = pick(p.x, p.y, true);
            canvas.style.cursor = hit ? 'pointer' : 'grab';
            if (hitKey(hit) !== hitKey(hoverRef.current)) {
                hoverRef.current = hit;
                setHover(hit);
            }
            requestDraw();
        };

        const onUp = (e: PointerEvent) => {
            const p = local(e);
            active.delete(e.pointerId);

            // Lifting one finger out of a pinch leaves the other one still on
            // the glass, and the drag has to pick up from where THAT finger is.
            // It used to resume from `last` — the position of a different
            // finger, recorded before the pinch began — so the first move after
            // the lift applied that whole stale gap as a pan and the map jumped
            // sideways. Which finger stayed is not knowable in advance, so the
            // fix is to re-read the survivor rather than to guess.
            if (active.size === 1) {
                pinchDist = 0;
                pinchMid = null;
                const [only] = [...active.values()];
                armPan(only, false);
                return;
            }

            // Same trap one finger up: with three down, the pair being measured
            // changes when one leaves, so the gesture is re-based on whichever
            // two are left rather than compared against a span that no longer
            // exists.
            if (active.size === 2) {
                const [a, b] = [...active.values()];
                pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
                pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                return;
            }

            if (active.size === 0) { pinchDist = 0; pinchMid = null; }
            if (panning && active.size === 0) {
                panning = false;
                canvas.style.cursor = 'grab';
                if (moved <= CLICK_SLOP) {
                    const hit = pick(p.x, p.y);
                    if (!hit) {
                        pinnedRef.current = null;
                        setPinned(null);
                        live.current.onSelect(null);
                    } else if (hit.kind === 'region') {
                        pinnedRef.current = null;
                        setPinned(null);
                        live.current.onSelect(hit.region.id);
                    } else {
                        // A topic is pinned rather than opened: opening a page
                        // on a single tap of a 6px dot is a trap, and the card
                        // carries the button that does it deliberately.
                        pinnedRef.current = hit;
                        setPinned(hit);
                        live.current.onSelect(hit.region.id);
                    }
                    requestDraw();
                }
            }
        };

        const onLeave = () => {
            if (hoverRef.current) { hoverRef.current = null; setHover(null); }
            requestDraw();
        };

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            // deltaMode 1 is lines, not pixels — a mouse wheel in Firefox
            // reports 3 lines a notch and would otherwise barely move.
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
            zoomAt(Math.exp(-e.deltaY * unit * 0.0012), e.clientX - rect.left, e.clientY - rect.top);
        };

        const onDouble = (e: MouseEvent) => {
            const rect = canvas.getBoundingClientRect();
            zoomAt(1.9, e.clientX - rect.left, e.clientY - rect.top);
        };

        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('pointercancel', onUp);
        canvas.addEventListener('pointerleave', onLeave);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('dblclick', onDouble);
        return () => {
            canvas.removeEventListener('pointerdown', onDown);
            canvas.removeEventListener('pointermove', onMove);
            canvas.removeEventListener('pointerup', onUp);
            canvas.removeEventListener('pointercancel', onUp);
            canvas.removeEventListener('pointerleave', onLeave);
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('dblclick', onDouble);
        };
    }, [baseScale, pick, requestDraw, zoomAt]);

    // ---- keyboard -----------------------------------------------------------
    const onKeyDown = (e: ReactKeyboardEvent) => {
        const { w, h } = sizeRef.current;
        const nudge = 60 / (baseScale() * camRef.current.k);
        const pan = (dx: number, dy: number) => {
            camRef.current = { ...camRef.current, x: camRef.current.x + dx, y: camRef.current.y + dy };
            velRef.current = { x: 0, y: 0, lk: 0 };
            followRef.current = false;
        };
        const acts: Record<string, () => void> = {
            ArrowLeft: () => pan(-nudge, 0),
            ArrowRight: () => pan(nudge, 0),
            ArrowUp: () => pan(0, -nudge),
            ArrowDown: () => pan(0, nudge),
            '+': () => zoomAt(1.3, w / 2, h / 2),
            '=': () => zoomAt(1.3, w / 2, h / 2),
            '-': () => zoomAt(1 / 1.3, w / 2, h / 2),
            '_': () => zoomAt(1 / 1.3, w / 2, h / 2),
            '0': () => fit(),
            f: () => onToggleFullscreen(),
            // Escape backs out one layer at a time: the open card, then the
            // selection, then full screen — never all three at once.
            Escape: () => {
                if (hoverRef.current || pinnedRef.current) dismissCard();
                else if (live.current.selectedId != null) live.current.onSelect(null);
                else if (fullscreen) onToggleFullscreen();
            },
        };
        const act = acts[e.key];
        if (!act) return;
        e.preventDefault();
        if (e.key !== '0') targetRef.current = null;
        act();
        requestDraw();
    };

    // ---- the floating card --------------------------------------------------
    // A pin beats a hover, and the ORDER is the point: `pinned || hover`, not
    // `hover || pinned`. With hover first, the moment the pointer leaves a
    // pinned dot to reach the card's "Open topic" button it crosses the parent
    // bubble, the region wins the card, and the button is replaced by the
    // region's summary — which also flips `isPinnedTopic` false and sets the
    // card to `pointerEvents: 'none'`, putting it out of reach entirely: the
    // only way through is to cross the gap faster than a pointermove can fire.
    // A pinned card holds the surface until it is dismissed (empty space,
    // Escape, or clicking something else), which is what pinning means.
    const card = pinned || hover;
    const isPinnedTopic = !!(pinned?.topic && card?.topic?.id === pinned.topic.id);


    // A frame being recorded is not a map being read: no controls to press, no
    // hint to read, no card to open, and nothing the pointer can move. A single
    // branch rather than five props, because they are one decision.
    if (capture) {
        return (
            <div ref={wrapRef} className="relative w-full h-full overflow-hidden">
                <canvas
                    ref={canvasRef}
                    aria-hidden="true"
                    className="block w-full h-full pointer-events-none select-none"
                />
            </div>
        );
    }

    return (
        <div
            ref={wrapRef}
            className="relative w-full h-full rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900"
        >
            <canvas
                ref={canvasRef}
                tabIndex={0}
                role="application"
                aria-label={tr("Topic map. Drag to move, scroll or pinch to zoom, arrow keys to pan, plus and minus to zoom, 0 to fit, f for full screen. The region list beside the map carries the same information as text.")}
                onKeyDown={onKeyDown}
                className="block w-full h-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-inset"
                style={{ cursor: 'grab' }}
            />

            {/* The chrome slot spans the map's width so its contents can be as
                wide as the map is — on a phone that is the difference between a
                course name and a title cut to two words. The strip itself must not
                eat the drag it covers, so it passes pointer events through and
                each child takes its own back. */}
            {children && (
                <div className="absolute top-3 left-3 right-3 z-10 pointer-events-none">{children}</div>
            )}

            <MapControls controls={[
                { icon: Plus, name: tr("Zoom in"), act: () => zoomAt(1.4, sizeRef.current.w / 2, sizeRef.current.h / 2) },
                { icon: Minus, name: tr("Zoom out"), act: () => zoomAt(1 / 1.4, sizeRef.current.w / 2, sizeRef.current.h / 2) },
                { icon: Locate, name: tr("Fit the whole map"), act: fit },
                {
                    icon: fullscreen ? Minimize2 : Maximize2,
                    name: fullscreen ? tr("Leave full screen") : tr("Full screen"),
                    act: onToggleFullscreen,
                },
            ]} />

            <p className="absolute bottom-3 left-3 max-w-[calc(100%-4.5rem)] text-xs text-slate-500 dark:text-slate-400 bg-white/75 dark:bg-slate-900/75 backdrop-blur px-2 py-1 rounded-lg pointer-events-none">
                {showingTopics ? tr("Every dot is a topic — tap one to open it") : tr("Drag to move · scroll or pinch to zoom in on topics")}
            </p>

            {card && anchor && (
                <AtlasCard
                    focus={card}
                    anchor={anchor}
                    size={sizeRef.current}
                    interactive={isPinnedTopic}
                    onOpenTopic={t => live.current.onOpenTopic(t)}
                />
            )}
        </div>
    );
});

export default AtlasMap;

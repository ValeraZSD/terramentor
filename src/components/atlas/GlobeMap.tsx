import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { AtlasRegion, AtlasTopic } from '../../types';
import { AtlasColorMode, courseFill, CourseHue, ramp, regionColor } from './atlasColors';
import { CourseTrace, DEFAULT_PACE, Flight, ReplayPace, advanceFlight, flightMs, headMorph, newFlight } from './coursePaths';
import { AtlasCapture, captureRatio } from './atlasCapture';
import { atlasSurfaces } from '../../utils/themeSurfaces';
import {
    SphereLeg, meanDirection, slerp, sphereLegAt, sphereLegParam, spherePath,
} from './globeFlight';
import { spring } from './cameraSpring';
import {
    createLabeller, VISIBLE_ALPHA, labelPx, refreshRootFontScale,
    MIN_LABEL_PX, MAX_NAME_PX, TOPIC_NAME_PX, MIN_NAMED_RADIUS, NAME_FADE_START, NAME_EASE,
} from './mapLabels';
import {
    CLICK_SLOP, JOURNEY_MIN_ALPHA, JOURNEY_MIN_WIDTH, JOURNEY_MAX_WIDTH, JOURNEY_HALO_WIDTH,
    JOURNEY_HALO_ALPHA, ARROW_MIN_LENGTH, ARROW_SIZE, TRACE_REGION_DIM, TRACE_TOPIC_DIM, TRACE_DOT_MIN, LOOK_AHEAD, FIT_AHEAD,
    ZOOM_DEAD_OUT, ZOOM_DEAD_IN, ZOOM_OUT_OMEGA, ZOOM_IN_OMEGA, END_OMEGA, END_ZOOM_OMEGA,
    IDLE_GAP_MS, paintHead,
} from './journeyStyle';
import AtlasCard, { AtlasFocus } from './AtlasCard';
import MapControls from './MapControls';
import {
    CAP_FILL, Vec3, angleBetween, capEllipse, capPoint, faceOn, project, rotate,
    tangentBasis, topicOffset, unit3, unrotate,
} from './globeProjection';
import { Maximize2, Minimize2, Minus, Orbit, Pause, Plus, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Terra — the library as a planet.
 *
 * The flat atlas answers "what do I know?" by laying the whole library on a
 * sheet, and a sheet has an edge. Whatever the projection pushes to the margin
 * reads as peripheral, the corners are dead ground, and a region can only ever
 * have neighbours in the directions the paper allows. None of that is a fact
 * about the material — it is a fact about paper.
 *
 * A sphere has no edge and no corner. Every region sits in the middle of its
 * own view, "what is next to this?" has the same answer from every side, and a
 * subject bordering four others is drawn bordering four others. That is worth a
 * second surface rather than a replacement: the flat map is still the one you
 * can take in at a glance, and it is the one the course replay runs on.
 *
 * **This is not the flat map wrapped around a ball.** The regions are projected
 * onto the sphere from the embedding space directly — three components rather
 * than two, refined against the real distances between centroids
 * (`server/globe.js`), and measured against the plane in `tools/globe-gates.mjs`
 * rather than asserted here. Inside a region nothing changes: a cap is locally
 * flat, so the topics keep the arrangement the flat map gives them, walked onto
 * the cap's tangent plane. One library, two projections, one set of numbers on
 * the wire.
 *
 * Drawn on a plain 2D canvas with an orthographic projection, which is what a
 * globe actually looks like and what a telescope sees. No WebGL and no 3D
 * library: this is a few hundred ellipses and a few thousand dots, the app
 * ships no CDN scripts, and a renderer the size of a dependency is not a
 * dependency worth having.
 */

export interface GlobeMapHandle {
    /** Turn the planet until this region faces the reader. */
    flyTo: (regionId: number) => void;
    /** Back to the opening view. */
    reset: () => void;
    /**
     * Turn to a whole course and pull back until all of it is in front of the
     * reader — the planet's answer to the plane's `frameOn`.
     *
     * Not the same instruction: a plane frames a box, and a sphere cannot, since
     * a course spread over more than a hemisphere has no view that contains it.
     * What this does is put the middle of the course under the middle of the
     * disc and come out far enough that as much of it as the horizon allows is
     * facing the reader.
     */
    frameOnCourse: (trace: CourseTrace, opts?: { instant?: boolean }) => void;
    /**
     * The replay is over: let go, and drift out to the whole course.
     *
     * The same destination as `frameOnCourse`, on a much softer arm. Choosing a
     * course is a cut with a destination; this is the camera the reader has
     * been riding letting go, and it is the move the ending is made of.
     */
    endJourney: (trace: CourseTrace) => void;
    /** Ride with the replay: the planet turns under the arrow as it flies. */
    followJourney: () => void;
    /** Where the arrow is, in steps, as a float — or null when nothing is flying. */
    journeyAt: () => number | null;
    /** Where the camera is, for anything measuring the MOVE rather than the picture. */
    camera: () => { yaw: number; pitch: number; k: number };
    /** The canvas itself — for `captureStream`, and for nothing else. */
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
    /** The theme TINT — a dependency, not an input: the surfaces are read off
     *  the document's own ramp inside a memo, so this is what says the answer
     *  has changed. See the same prop on `AtlasMap`. */
    themeTint: string;
    accent: string;
    colorMode: AtlasColorMode;
    /** Course hues, shared with the flat map so one legend reads both. */
    hues: Map<number, CourseHue>;
    /**
     * The course being traced, or null. Everything outside it is dimmed, never
     * removed — the same rule search follows here and on the plane.
     */
    trace: CourseTrace | null;
    /**
     * How far along the journey to draw: null draws all of it, a number draws
     * the first N steps. A PROP rather than internal state because the panel
     * beside the map prints the same number, and two renderings of one number
     * cannot be allowed to disagree.
     */
    journeyStep: number | null;
    /** The reader's replay dials — the same object the flat map takes. */
    pace?: ReplayPace;
    /** Whether the regions print their names over the planet. */
    regionNames?: boolean;
    /** Set when this planet is a video frame being recorded. `atlasCapture.ts`. */
    capture?: AtlasCapture | null;
    fullscreen: boolean;
    onToggleFullscreen: () => void;
    children?: ReactNode;
}

/** How much of the shorter side the planet spans at rest. */
const BASE_FILL = 0.44;
const MIN_K = 0.85;
/**
 * The furthest in the reader may come.
 *
 * Lower than the flat map's 30, and the reason is the camera rather than the
 * picture: a plane is panned, so at any zoom you can go and find the thing you
 * want, while a planet is only turned — the middle of the disc is the only
 * place you can look at. Past about this the region under the middle has
 * outgrown the screen and everything else is over the horizon, so the view is
 * an empty body with a few dots at one edge. At 4.5 the biggest cap fills most
 * of the frame and its topics are separate, named places, which is what coming
 * in is for.
 */
const MAX_K = 4.5;
/** Topics fade in between these zoom levels — a cap is small until you come in. */
const TOPIC_FADE_START = 1.15;
const TOPIC_FADE_FULL = 2.1;
/**
 * …and how far into it the topics become the layer being pointed at: past here
 * a click picks a topic before its cap, and a hover picks a topic or nothing
 * (`pick`). Lower than the sheet's, because this fade is shorter.
 */
const TOPIC_PICK_DETAIL = 0.25;
// Region-name type, the floor, the fade and the ease come from `mapLabels.ts`,
// shared with the sheet: one library, one legibility floor, whichever surface it
// is read on.
/** Below this dot size a name beside it belongs to nothing in particular. */
const NAME_DOT_MIN = 4;

/**
 * How the planet looks opening: a little above the equator, which is how every
 * globe anyone has handled sits on its stand. Dead-on reads as a circle.
 */
const DEFAULT_PITCH = 0.3;
/** Pitch stops just short of the pole, where yaw degenerates into roll. */
const MAX_PITCH = 1.5;

/**
 * Idle drift, in radians a second. A full turn in about eighty seconds: enough
 * that the planet reads as a planet rather than a printed circle, slow enough
 * that nothing the reader is looking at moves out from under them before they
 * have read it. It stops the moment they touch the globe and does not resume
 * on its own — a camera that starts moving again after you let go is a camera
 * you are fighting.
 */
const IDLE_SPIN = 0.078;
/** A flick keeps going, and this is how fast it dies away (per second). */
const SPIN_DECAY = 2.6;
/**
 * How fast the HAND has to be moving at the moment of release for the planet to
 * keep going, in screen pixels a second.
 *
 * The hand rather than the planet, though it is the planet that carries on: how
 * far the camera turns per pixel dragged depends on where on the disc the drag
 * is and how far in the zoom is, so a threshold read off the camera calls the
 * same gesture a throw near the limb and a placement across the middle.
 * Measured against real drags: a careful 200px placement over four tenths of a
 * second is 500px/s at the hand (and by its end 770px/s at the planet, which is
 * the foreshortening, not the reader's intent); a flick is several times that.
 */
const FLICK_MIN_PX = 900;
/**
 * …and a release is only a throw if the planet was still moving when the hand
 * came off. A hand that stops on the thing it was looking for sends no further
 * pointer events, so the last one measured stays on the books: without this,
 * holding still for a moment and then letting go threw the planet at whatever
 * speed it had been travelling at before it stopped. Two frames of a 60Hz
 * mouse, which is about as still as a hand that has not stopped ever gets.
 */
const FLICK_STILL_MS = 80;
/** Below this the flick has stopped; anything less is a loop running for nothing. */
const SPIN_FLOOR = 0.012;
/** How hard the camera pulls toward a fly-to target, in radians a second. */
const EASE_OMEGA = 7;
/**
 * The last stretch of the near side, where a cap is edge-on and a dot is a
 * point. Everything fades out across it instead of vanishing at the silhouette,
 * because the alternative is a rim of things blinking out as the planet turns.
 */
const LIMB_FADE = 0.16;

// ---- the traced course, on a planet -----------------------------------------
//
// Same layer and the same encoding as the flat map's: ONE line, the route the
// learner walked, drawn in the map's INK rather than in the accent (the accent
// is the mastery ramp, and a coloured path would compete with the one encoding
// the map has), fading back as it recedes into the past, stroked twice so it
// survives crossing a dark cap and a pale one.
//
// What the sphere changes is only the geometry: the route is a great-circle
// curve (`globeFlight.ts`), it disappears over the horizon rather than off the
// edge of a viewport, and "framing" a course is a turn rather than a pan.
// The ink, the arrows, the head and the dimming are `journeyStyle.ts`, shared
// with the sheet — one journey, one set of numbers.
/**
 * How many pieces a leg is stroked in. Enough that a curve a quarter of the way
 * round the planet is smooth, and it is also where the path is cut at the
 * horizon — a leg running round the back is broken between two samples, so this
 * is the resolution of that break as well as of the curve.
 */
const LEG_SAMPLES = 24;

/**
 * How close the camera rides while it follows the arrow.
 *
 * Past `TOPIC_FADE_FULL`, so the topics being visited are separate places with
 * names, and well short of `MAX_K`, where the cap under the middle has outgrown
 * the screen and the next hop would be over the horizon before it started.
 */
const FOLLOW_K = 3.4;
/** Nothing pulls the camera further out than this while following. */
const LEG_MIN_K = 1.15;
/** How hard the camera turns toward the journey — softer than a fly-to, which
 *  is a move with an end to it; this one is chasing something that moves. */
const FOLLOW_OMEGA = 3.2;
// The window it holds, its dead bands and the zoom's and the ending's arms are
// `journeyStyle.ts`: the numbers are the plane's measured ones, and the planet
// now reads them from the same place rather than repeating them. The ending is
// still the softest arm here, and its zoom still the stiffer half, so the planet
// widens slightly ahead of the turn.
/**
 * How much of the visible disc the journey's window is allowed to fill.
 *
 * Lower than a plane's margin would be, and not for taste: a sphere
 * foreshortens, so a point 60° from the middle is drawn at 87% of the radius
 * and is edge-on. Holding the window inside this keeps the legs being flown on
 * the part of the planet that still reads as a surface.
 */
const FOLLOW_FILL = 0.62;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** A smooth 0→1 over [edge0, edge1] — the limb fade, and the zoom ramps. */
const ramped = (v: number, edge0: number, edge1: number) => {
    const t = clamp((v - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
};

/** A region, everything about it that the sphere needs, worked out once. */
interface Placed {
    region: AtlasRegion;
    u: Vec3;
    cap: number;
    /** Angular radius of one topic dot inside this cap. */
    dotAngle: number;
    topics: { topic: AtlasTopic; u: Vec3 }[];
}

type Hit =
    | { kind: 'region'; region: AtlasRegion; topic: null }
    | { kind: 'topic'; region: AtlasRegion; topic: AtlasTopic };

const GlobeMap = forwardRef<GlobeMapHandle, Props>(function GlobeMap({
    regions, selectedId, onSelect, onOpenTopic, matches, dark, themeTint, accent,
    colorMode, hues, trace, journeyStep, fullscreen, onToggleFullscreen, children,
    pace = DEFAULT_PACE, regionNames = true, capture = null,
}, ref) {
    const { t: tr } = useTranslation();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    const sizeRef = useRef({ w: 0, h: 0 });

    // The camera. Kept in a ref and never in state: it changes every frame
    // while the planet turns, and a React render per frame is a render loop,
    // not an animation.
    const camRef = useRef({ yaw: 0, pitch: DEFAULT_PITCH, k: 1 });
    /**
     * Where a move is taking the camera — and the ZOOM is part of it.
     *
     * It was not: a fly-to eased the turn and assigned `k` outright, so every
     * move that also changed the zoom cut it in a single frame while the planet
     * turned smoothly under it. On the ending of a replay that is the whole
     * fault in one line — the globe snaps from the shot the journey held to the
     * shot the course needs and then leisurely turns to face it.
     *
     * `omega` is how hard the camera is pulled, and `kOmega` the zoom's own, so
     * an ending can be softer than a fly-to without either of them being a
     * different kind of move.
     */
    const targetRef = useRef<
        { yaw: number; pitch: number; k?: number; omega?: number; kOmega?: number } | null
    >(null);
    /**
     * How fast the camera is moving — radians a second in yaw and pitch, and
     * log-zoom a second — whatever it was that moved it.
     *
     * The planet's answer to the sheet's `velRef`, and it is kept for every
     * branch rather than only for the spring: a camera let go of at the end of
     * a replay was being turned by the replay, and the whole point of the arm
     * is that it does not start from nothing.
     */
    const camVelRef = useRef({ yaw: 0, pitch: 0, lk: 0 });
    const spinRef = useRef(0);
    /** The last frame drawn asked for no other: nothing moving, fading or flying. */
    const stillRef = useRef(false);
    /**
     * The drift starts on, unless the reader has asked for less motion — in which
     * case it must also start OFF rather than merely not move: the control draws
     * itself held down while `spinning` is true, so a reader with reduced motion
     * was shown a Pause button over a planet that was never turning.
     */
    const [spinning, setSpinning] = useState(
        () => !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches),
    );
    const frameRef = useRef(0);
    const lastFrame = useRef(0);
    const nameAlphaRef = useRef(new Map<number, number>());
    /**
     * The replay, integrated in `coursePaths.ts` — the same arithmetic the flat
     * map flies, because a replay must mean the same thing on both surfaces.
     * Only the route between two topics belongs to this component.
     */
    const flightRef = useRef<Flight>(newFlight());
    /** Whether the camera is riding with the arrow. A ref, because the gesture
     *  handlers clear it and they are bound once. */
    const followRef = useRef(false);
    /** The zoom the following camera is HOLDING — not the one the window asks
     *  for this frame. Null when no replay is being followed. */
    const followKRef = useRef<number | null>(null);

    const [hover, setHover] = useState<Hit | null>(null);
    const [pinned, setPinned] = useState<Hit | null>(null);
    const [anchor, setAnchor] = useState<{ x: number; y: number; r: number } | null>(null);
    const hoverRef = useRef<Hit | null>(null);
    const pinnedRef = useRef<Hit | null>(null);
    const anchorRef = useRef<{ x: number; y: number; r: number } | null>(null);
    /** Everything drawn on the near side this frame, for the pointer to hit. */
    const drawnRef = useRef<{ placed: Placed[]; detail: number }>({ placed: [], detail: 0 });

    const reduceMotion = useMemo(
        () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
        [],
    );

    // ---- the sphere's own geometry ------------------------------------------
    // Every topic's direction, worked out once per atlas rather than per frame.
    // The offsets come straight out of the flat coordinates the payload already
    // carries, which is what keeps a bubble's arrangement the same in both
    // views and the globe free on the wire.
    const placed = useMemo<Placed[]>(() => regions.map(region => {
        const u = unit3(region.u as Vec3);
        const cap = region.cap;
        const [e1, e2] = tangentBasis(u);
        return {
            region,
            u,
            cap,
            dotAngle: region.radius > 1e-9
                ? Math.max(0.0015, (region.topicRadius / region.radius) * cap * CAP_FILL)
                : 0.0015,
            topics: region.topics.map(topic => {
                const [ox, oy] = topicOffset(region, topic);
                return { topic, u: capPoint(u, e1, e2, ox, oy, cap) };
            }),
        };
    }), [regions]);

    // Props the draw loop reads. A ref rather than a closure, so the loop is
    // built once and always sees the current values.
    /**
     * Every topic the traced course reaches, with its own direction on the
     * sphere. Built once per course rather than per frame — the lookup is over
     * every region on the planet, and the draw loop asks for it four times a
     * step.
     *
     * One direction per topic, not two. Carrying the region's centre as well
     * draws the journey somewhere between the two on the zoom's own ramp, which
     * makes the route a function of the camera: the same course has a different
     * shape at every distance, and a leg between two topics of one region grows
     * out of a point as you come in. A place is a place.
     */
    const tracePlaces = useMemo(() => {
        if (!trace) return null;
        const byId = new Map<number, { u: Vec3; regionId: number }>();
        for (const p of placed) {
            for (const t of p.topics) {
                if (!trace.points.has(t.topic.id)) continue;
                byId.set(t.topic.id, { u: t.u, regionId: p.region.id });
            }
        }
        return byId;
    }, [placed, trace]);

    /** Which caps the traced course reaches — what the rest of the map dims by. */
    const tracedRegions = useMemo(() => {
        if (!tracePlaces) return null;
        const ids = new Set<number>();
        for (const p of tracePlaces.values()) ids.add(p.regionId);
        return ids;
    }, [tracePlaces]);

    const live = useRef({
        placed, selectedId, matches, colorMode, hues, onSelect, onOpenTopic,
        trace, journeyStep, tracePlaces, tracedRegions, pace, regionNames,
    });
    live.current = {
        placed, selectedId, matches, colorMode, hues, onSelect, onOpenTopic,
        trace, journeyStep, tracePlaces, tracedRegions, pace, regionNames,
    };
    /** Canvas pixels per CSS pixel — set by the sizing observer, read by the
     *  draw, so the two can never scale by different numbers. */
    const dprRef = useRef(captureRatio(capture, 0));

    // ---- palette -------------------------------------------------------------
    // Resolved once per theme, never per frame: `getComputedStyle` forces style
    // resolution, and doing that inside a draw call turns a turn into thrash.
    // Shared with the flat map (`utils/themeSurfaces.ts`) — the two are
    // projections of one library and a reader switches between them, so they
    // cannot disagree about what the page is made of. Including the PLANET's own
    // two tones, which are derived from the page rather than named: on a dark
    // theme the lit side IS the page and the sphere is read from its darkening
    // limb, unless the page is so dark there is nothing below it.
    const palette = useMemo(() => {
        let accentRgb = dark ? '96 165 250' : '37 99 235';
        if (typeof getComputedStyle === 'function') {
            const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
            if (raw) accentRgb = raw;
        }
        const acc = (a: number) => `rgba(${accentRgb.split(/\s+/).join(',')},${a})`;
        const s = atlasSurfaces(dark);
        const { surface, ink, lit, shade, rim } = s;
        const grid = s.globeGrid;
        // The planet's body is two tones — the side facing the light and the
        // side falling away from it — and BOTH are surfaces the mastery ramp
        // gets drawn on, which is the constraint that picks them. They are
        // DERIVED from the page now rather than named per theme; the reasoning
        // that fixes the derivation is in `atlasSurfaces`, and the measurement
        // behind it is `atlas-gates.mjs` holding the ramp's palest rung to
        // 1.5:1 against every surface either map paints.
        return { surface, ink, lit, shade, grid, rim, steps: ramp(accent, dark), acc };
    }, [dark, themeTint, accent]);

    const radius = useCallback(() => {
        const { w, h } = sizeRef.current;
        return Math.min(w, h) * BASE_FILL * camRef.current.k || 1;
    }, []);

    const requestDraw = useCallback(() => {
        if (frameRef.current) return;
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = 0;
            drawRef.current();
        });
    }, []);

    /** Stop whatever the camera was doing by itself. Any real input wins —
     *  including a hand taken to the planet mid-replay, which hands the camera
     *  back and leaves the replay running where the reader left it. */
    const takeCamera = useCallback(() => {
        targetRef.current = null;
        // A camera the reader has taken hold of carries nothing over: a drag
        // that ends does not fling the planet, and the flick that IS meant to
        // is `spinRef`, thrown on purpose by the release.
        camVelRef.current = { yaw: 0, pitch: 0, lk: 0 };
        spinRef.current = 0;
        followRef.current = false;
        followKRef.current = null;
        setSpinning(false);
    }, []);

    const dismissCard = useCallback(() => {
        setHover(null); setPinned(null); setAnchor(null);
        hoverRef.current = null; pinnedRef.current = null; anchorRef.current = null;
        requestDraw();
    }, [requestDraw]);

    // ---- picking -------------------------------------------------------------
    // Done on the SPHERE, not in screen space: the pointer is unprojected onto
    // the near surface and compared by angle. That is exact, it can only ever
    // hit something facing the reader (the far side is simply not on the
    // sphere point the pointer maps to), and it costs one pass over the drawn
    // regions rather than a projection of every topic per pointermove.
    /** Which direction in the library a screen point is over, or null when the
     *  pointer is beside the planet rather than on it. */
    const worldAt = useCallback((px: number, py: number): Vec3 | null => {
        const { w, h } = sizeRef.current;
        const R = radius();
        const nx = (px - w / 2) / R, ny = -(py - h / 2) / R;
        const r2 = nx * nx + ny * ny;
        if (r2 > 1) return null;
        const cam = camRef.current;
        return unrotate([nx, ny, Math.sqrt(1 - r2)], cam.yaw, cam.pitch);
    }, [radius]);

    /**
     * What is under the pointer — and `forHover` is not a detail. The sheet's
     * rule, for the sheet's reason: zoomed in, the topics ARE the layer and the
     * cap behind them is scenery, so the ground between two dots is not a place
     * the reader is pointing at. Answering it with the region's card puts a
     * panel over the topics at every step of dot → gap → dot. A press still
     * takes the region: it is deliberate, and it opens no card of its own.
     */
    const pick = useCallback((px: number, py: number, forHover = false): Hit | null => {
        const world = worldAt(px, py);
        if (!world) return null;                       // off the planet
        const R = radius();
        const { placed: all, detail } = drawnRef.current;

        if (detail > TOPIC_PICK_DETAIL) {
            // A thumb's worth of slack around the dot, converted to an angle so
            // the tolerance shrinks with the foreshortening the way the dot
            // itself does.
            let best: { hit: Hit; a: number } | null = null;
            for (const p of all) {
                if (angleBetween(world, p.u) > p.cap + p.dotAngle) continue;
                const slack = p.dotAngle + 8 / R;
                for (const t of p.topics) {
                    const a = angleBetween(world, t.u);
                    if (a <= slack && (!best || a < best.a)) {
                        best = { hit: { kind: 'topic', region: p.region, topic: t.topic }, a };
                    }
                }
            }
            if (best) return best.hit;
            // …and nothing else, for a hover. See above.
            if (forHover) return null;
        }
        let best: { hit: Hit; a: number } | null = null;
        for (const p of all) {
            const a = angleBetween(world, p.u);
            if (a <= p.cap && (!best || a < best.a)) {
                best = { hit: { kind: 'region', region: p.region, topic: null }, a };
            }
        }
        return best?.hit ?? null;
    }, [radius, worldAt]);

    /** Where on screen the open card should point. */
    const anchorFor = useCallback((hit: Hit) => {
        const { w, h } = sizeRef.current;
        const R = radius();
        const cam = camRef.current;
        const p = live.current.placed.find(x => x.region.id === hit.region.id);
        if (!p) return null;
        if (hit.kind === 'topic') {
            const t = p.topics.find(x => x.topic.id === hit.topic.id);
            if (!t) return null;
            const v = rotate(t.u, cam.yaw, cam.pitch);
            const s = project(v, w / 2, h / 2, R);
            return { x: s.x, y: s.y, r: Math.max(4, p.dotAngle * R) };
        }
        const v = rotate(p.u, cam.yaw, cam.pitch);
        const e = capEllipse(v, p.cap, w / 2, h / 2, R);
        return { x: e.x, y: e.y, r: e.ry };
    }, [radius]);

    // ---- the frame -----------------------------------------------------------
    const drawRef = useRef<() => void>(() => { });
    drawRef.current = () => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        const { w, h } = sizeRef.current;
        if (!w || !h) return;

        const now = performance.now();
        const rawMs = lastFrame.current ? now - lastFrame.current : 0;
        const dt = lastFrame.current ? Math.min(0.05, rawMs / 1000) : 0.016;
        // The same clock in milliseconds, with the idle gaps taken out of it:
        // time that passed while nothing was drawn is not time anything
        // travelled through, and this loop stops between beats on purpose.
        const frameMs = rawMs > 0 && rawMs < IDLE_GAP_MS ? rawMs : 0;
        lastFrame.current = now;
        const cam = camRef.current;
        // Where the camera was when this frame began, so that however it ends
        // up being moved — by the replay, by a flick, by the drift — the speed
        // it was travelling at is known to whatever moves it NEXT. That is what
        // makes the ending of a replay a continuation rather than a new move.
        const wasAt = { yaw: cam.yaw, pitch: cam.pitch, k: cam.k };
        let sprung = false;
        let moving = false;

        // ---- the replay's flight, settled BEFORE anything is painted --------
        //
        // Where the arrow is decides where the camera is, so it cannot be
        // worked out halfway down the draw: the planet would be turned by one
        // frame's reading and the arrow drawn from the next one's.
        const {
            trace: tracing, journeyStep: stepNow, tracePlaces: traceAt,
            tracedRegions: tracedIn, pace: paceNow,
        } = live.current;
        const flown = advanceFlight(flightRef.current, tracing, stepNow, frameMs, reduceMotion, paceNow);
        if (!flown) followKRef.current = null;
        const flying = flown?.flying ?? false;

        // ---- and then the camera FOLLOWS it --------------------------------
        //
        // The same two decisions the plane makes, on a camera that can only
        // turn. WHERE it points is the spherical mean of a WINDOW of the
        // journey - the place the eye is at now and the next few it is going
        // to, each fading in and out by weight - so the target moves
        // continuously and a turn runs across several legs instead of
        // restarting at each one. HOW MUCH it holds is settled once per step
        // and then defended by a dead band, because the room the next few steps
        // need is a fact about the journey, and asking it every frame makes it
        // a fact about the camera, which breathes.
        //
        // And the eye is NOT the arrow: it runs the same journey at one step
        // per beat while the arrow crosses its leg in 72% of the beat and then
        // waits, so the planet keeps turning through every arrival instead of
        // stopping dead on each one.
        if (tracing && flown && traceAt && followRef.current && stepNow != null && flown.landed > 0) {
            const placeOf = (step: number) => traceAt.get(tracing.journey[step - 1]) ?? null;
            const at = flown.eyeAt;
            const leaving = Math.floor(at);
            const from = placeOf(leaving);
            const to = placeOf(leaving + 1);
            // Where the eye is between two topics: along the great circle
            // joining them, which is the chord of the leg rather than its
            // curve — a difference of the bulge, never enough to frame
            // differently.
            const eye = from && to
                ? slerp(from.u, to.u, clamp(at - leaving, 0, 1))
                : from?.u ?? null;
            if (eye) {
                const seen: { u: Vec3; w: number }[] = [{ u: eye, w: 1 }];
                for (let step = leaving - 1; step <= leaving + LOOK_AHEAD; step++) {
                    if (step < 1 || step > tracing.journey.length) continue;
                    const p = placeOf(step);
                    if (!p) continue;
                    const away = step - at;
                    const weight = away < 0
                        ? clamp(1 + away, 0, 1)
                        : clamp((LOOK_AHEAD - away) / Math.max(1e-6, LOOK_AHEAD - 1), 0, 1);
                    if (weight > 0) seen.push({ u: p.u, w: weight });
                }
                const middle = meanDirection(seen) ?? eye;

                // The room the journey needs, measured once per STEP from the
                // topics themselves: the widest weighted angle from the
                // window's own middle, turned into a zoom by the projection's
                // own arithmetic - a point `reach` radians off the middle is
                // drawn `R * sin(reach)` from the centre of the disc.
                const room: { u: Vec3; w: number }[] = [];
                for (let step = leaving; step <= leaving + FIT_AHEAD; step++) {
                    if (step < 1 || step > tracing.journey.length) continue;
                    const p = placeOf(step);
                    if (!p) continue;
                    const ahead = step - leaving;
                    room.push({ u: p.u, w: ahead <= 1 ? 1 : clamp((FIT_AHEAD - ahead) / (FIT_AHEAD - 1), 0, 1) });
                }
                const roomMiddle = meanDirection(room) ?? middle;
                let reach = 0;
                for (const p of room) reach = Math.max(reach, p.w * angleBetween(roomMiddle, p.u));
                // A window with no room in it is the END of the journey, not a
                // reason to close in: on the last step there is nothing ahead,
                // so the window is one point and `reach` is zero. Reading that
                // as "this needs no room" pushed the planet in to `FOLLOW_K` on
                // the final topic and held it there for the hold, and then the
                // ending pulled straight back out.
                //
                // So the shot stands — and it is the shot the planet is IN, not
                // the one the last window asked for: the final leg's pull
                // inward is usually still travelling, and it would spend the
                // whole hold creeping closer only to be reversed a second
                // later. The sheet's fix, for the sheet's measured reason.
                // Over when the ARROW has landed on the last topic, not when the
                // eye catches up with it: the eye trails by the landing's share
                // of a beat, and for all of that the window still holds the
                // final leg and still asks to close in on it. The sheet's rule,
                // for the sheet's measured reason.
                const ended = reach <= 1e-4 || flown.landed >= tracing.journey.length;
                const fit = ended
                    ? cam.k
                    : (FOLLOW_FILL * 0.5) / (BASE_FILL * Math.sin(Math.min(reach, Math.PI / 2)));
                // …and the end of the journey goes straight through the dead
                // band, which is there to stop the camera correcting itself
                // over a difference too small to be worth a move. There is
                // nothing left to correct toward.
                // …nor to `LEG_MIN_K`/`FOLLOW_K`, which are what a LEG may ask
                // for and there is no leg left to ask.
                const need = ended ? fit : clamp(fit, LEG_MIN_K, FOLLOW_K);
                const held = followKRef.current;
                const hold = ended || held == null
                    || need < held / ZOOM_DEAD_OUT || need > held * ZOOM_DEAD_IN
                    ? need : held;
                followKRef.current = hold;

                // A turn, not a pan: the yaw and pitch that bring the window's
                // middle to face the reader, unwrapped to the nearest
                // equivalent so a journey crossing the back of the planet takes
                // the short way round rather than unwinding a whole revolution.
                const want = faceOn(middle);
                const wrapped = want.yaw + Math.round((cam.yaw - want.yaw) / (Math.PI * 2)) * Math.PI * 2;
                const ease = reduceMotion ? 1 : 1 - Math.exp(-FOLLOW_OMEGA * dt);
                cam.yaw += (wrapped - cam.yaw) * ease;
                cam.pitch += (clamp(want.pitch, -MAX_PITCH, MAX_PITCH) - cam.pitch) * ease;
                // The zoom swings in LOG space, because zoom is a ratio:
                // halfway between 3.4 and 1.2 is 2.0, not 2.3.
                const kOmega = hold < cam.k ? ZOOM_OUT_OMEGA : ZOOM_IN_OMEGA;
                const kEase = reduceMotion ? 1 : 1 - Math.exp(-kOmega * dt);
                cam.k = clamp(Math.exp(Math.log(cam.k) + (Math.log(hold) - Math.log(cam.k)) * kEase), MIN_K, MAX_K);
                targetRef.current = null;
                spinRef.current = 0;
                moving = true;
            }
        }

        // The camera: following a replay wins, then a fly-to, then a flick, then
        // the idle drift. One clock for all of them, in seconds, because a share
        // per FRAME is a different speed on every machine.
        const target = followRef.current && flown ? null : targetRef.current;
        if (target) {
            // On a SPRING, never an exponential ease.
            // An ease is fastest on its first frame and slower every frame
            // after, so it cannot begin a move gently and cannot take over one
            // already in progress: the camera that has spent half a minute
            // riding a replay is travelling, and an ease throws that away and
            // starts its own move at full speed. The arm carries it across
            // instead (`cameraSpring.ts`, shared with the sheet).
            const omega = target.omega ?? EASE_OMEGA;
            const vel = camVelRef.current;
            let zoomed = true;
            if (reduceMotion) {
                cam.yaw = target.yaw; cam.pitch = target.pitch;
                if (target.k != null) cam.k = clamp(target.k, MIN_K, MAX_K);
                camVelRef.current = { yaw: 0, pitch: 0, lk: 0 };
            } else {
                const sy = spring(cam.yaw, vel.yaw, target.yaw, omega, dt);
                const sp = spring(cam.pitch, vel.pitch, target.pitch, omega, dt);
                cam.yaw = sy.x;
                cam.pitch = sp.x;
                let lkV = vel.lk;
                // The zoom travels with the turn, in LOG space, because zoom is
                // a ratio — halfway between 3.4 and 1.2 is 2.0, not 2.3 — and
                // it is the same rule the following camera holds itself to. A
                // move that eases the turn and assigns the zoom is two moves,
                // one of which takes a single frame.
                if (target.k != null) {
                    const sk = spring(Math.log(cam.k), vel.lk, Math.log(target.k),
                        target.kOmega ?? omega, dt);
                    cam.k = clamp(Math.exp(sk.x), MIN_K, MAX_K);
                    lkV = sk.v;
                    zoomed = Math.abs(Math.log(target.k / cam.k)) < 1e-3 && Math.abs(sk.v) < 1e-3;
                }
                camVelRef.current = { yaw: sy.v, pitch: sp.v, lk: lkV };
                zoomed = zoomed && Math.hypot(sy.v, sp.v) < 1e-3;
            }
            sprung = true;
            if (zoomed && Math.abs(target.yaw - cam.yaw) < 1e-4 && Math.abs(target.pitch - cam.pitch) < 1e-4) {
                cam.yaw = target.yaw; cam.pitch = target.pitch;
                if (target.k != null) cam.k = clamp(target.k, MIN_K, MAX_K);
                camVelRef.current = { yaw: 0, pitch: 0, lk: 0 };
                targetRef.current = null;
            } else moving = true;
        } else if (Math.abs(spinRef.current) > SPIN_FLOOR) {
            cam.yaw += spinRef.current * dt;
            spinRef.current *= Math.exp(-SPIN_DECAY * dt);
            moving = true;
        } else if (spinning && !reduceMotion && !pinnedRef.current) {
            spinRef.current = 0;
            cam.yaw += IDLE_SPIN * dt;
            moving = true;
        } else {
            spinRef.current = 0;
        }
        // Whatever moved it, that is how fast it is going. The spring keeps its
        // own exact velocity; everything else — the replay, a flick, the drift
        // — is read off the frame it just drew.
        if (!sprung && dt > 0) {
            camVelRef.current = {
                yaw: (cam.yaw - wasAt.yaw) / dt,
                pitch: (cam.pitch - wasAt.pitch) / dt,
                lk: Math.log(cam.k / wasAt.k) / dt,
            };
        }

        const R = radius();
        const cx = w / 2, cy = h / 2;
        const dpr = dprRef.current;
        // The canvas is not laid out by the document, so `ui_scale` only reaches
        // the labels if the map asks for it. Same cadence as the pixel ratio.
        refreshRootFontScale();
        const detail = ramped(cam.k, TOPIC_FADE_START, TOPIC_FADE_FULL);
        const nameFade = clamp((detail - NAME_FADE_START) / (1 - NAME_FADE_START), 0, 1);
        const {
            placed: all, selectedId: selected, matches: matched,
            colorMode: paint, hues: courseHue, regionNames: showNames,
        } = live.current;
        const { steps, acc } = palette;
        const focus = hoverRef.current || pinnedRef.current;
        const carded = pinnedRef.current || focus;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = palette.surface;
        ctx.fillRect(0, 0, w, h);

        // ---- the body. Two tones on a radial gradient offset toward the
        // light, and nothing else: the shading says "sphere" and stays out of
        // the way of the data, which is the only thing on here that means
        // anything. A textured planet would be a picture of a planet.
        const body = ctx.createRadialGradient(
            cx - R * 0.35, cy - R * 0.38, R * 0.05, cx, cy, R * 1.12);
        body.addColorStop(0, palette.lit);
        body.addColorStop(1, palette.shade);
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = body;
        ctx.fill();

        // Everything from here on is on the ball, so nothing can spill past the
        // silhouette — a cap straddling the limb has half of itself round the
        // back, and the ellipse that draws it does not know that.
        ctx.save();
        ctx.clip();

        // ---- the graticule. Purely so the turn has something to read against:
        // on a plain shaded ball a slow rotation is invisible, and the planet
        // reads as a still picture with a gradient on it.
        ctx.strokeStyle = palette.grid;
        ctx.lineWidth = 1;
        const arc = (pt: (t: number) => Vec3, steps2 = 72) => {
            ctx.beginPath();
            let down = false;
            for (let i = 0; i <= steps2; i++) {
                const v = rotate(pt(i / steps2), cam.yaw, cam.pitch);
                if (v[2] <= 0) { down = false; continue; }
                const s = project(v, cx, cy, R);
                if (down) ctx.lineTo(s.x, s.y); else { ctx.moveTo(s.x, s.y); down = true; }
            }
            ctx.stroke();
        };
        for (let m = 0; m < 6; m++) {
            const lon = (m / 6) * Math.PI * 2;
            arc(t => {
                const lat = (t - 0.5) * Math.PI;
                return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
            });
        }
        for (const lat of [-Math.PI / 3, -Math.PI / 6, 0, Math.PI / 6, Math.PI / 3]) {
            const r = Math.cos(lat), z = Math.sin(lat);
            arc(t => [r * Math.cos(t * Math.PI * 2), r * Math.sin(t * Math.PI * 2), z]);
        }

        // ---- the regions, back to front, so a nearer cap paints over a
        // further one exactly the way the sphere would occlude it.
        const regionMatches = (r: AtlasRegion) => !matched || r.topics.some(t => matched.has(t.id));
        const facing = all.map(p => ({ p, v: rotate(p.u, cam.yaw, cam.pitch) }));
        const visible = facing
            .filter(f => f.v[2] > -Math.sin(f.p.cap))
            .sort((a, b) => a.v[2] - b.v[2]);

        for (const { p, v } of visible) {
            const e = capEllipse(v, p.cap, cx, cy, R);
            const isSelected = p.region.id === selected;
            const isHovered = focus?.region.id === p.region.id;
            // Fading over the last stretch of the near side rather than cutting
            // at the silhouette: a rim of caps blinking out as the planet turns
            // is the one thing that makes a globe read as a trick.
            const edge = ramped(e.facing, 0, LIMB_FADE);
            // Tracing a course dims the rest of the library the way searching
            // does, and the two multiply rather than replacing each other: both
            // questions can be asked at once, and a region answering neither
            // should be fainter than one answering one of them.
            const dim = (regionMatches(p.region) ? 1 : 0.16) * edge
                * (tracedIn && !tracedIn.has(p.region.id) ? TRACE_REGION_DIM : 1);
            if (dim < 0.01) continue;

            ctx.globalAlpha = dim * (1 - 0.4 * detail);
            ctx.beginPath();
            ctx.ellipse(e.x, e.y, Math.max(e.rx, 0.2), e.ry, e.rotation, 0, Math.PI * 2);
            ctx.fillStyle = regionColor(p.region, paint, courseHue, accent, dark);
            ctx.fill();
            ctx.globalAlpha = dim * (0.3 + 0.4 * detail);
            ctx.strokeStyle = palette.rim;
            ctx.lineWidth = 1;
            ctx.stroke();

            if (isSelected || isHovered) {
                ctx.globalAlpha = dim;
                ctx.beginPath();
                ctx.ellipse(e.x, e.y, Math.max(e.rx, 0.2) + 3, e.ry + 3, e.rotation, 0, Math.PI * 2);
                ctx.strokeStyle = acc(isSelected ? 0.95 : 0.6);
                ctx.lineWidth = isSelected ? 2.5 : 1.5;
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
        }

        // ---- the traced course: the route walked through it -----------------
        //
        // Drawn here, after the caps and before every label and every topic dot,
        // so the line sits UNDER the things it runs between — a path over its
        // own endpoints hides what it is about.
        //
        // A topic is drawn where it is, at every zoom, exactly as on the plane.
        // Running the drawn place from the region's centre out to the topic on
        // the same `detail` ramp the dots fade in on makes the route a function
        // of the camera — one course, a different shape at every distance, legs
        // growing out of a point as you zoom — and a map you can zoom has to
        // hold still. The traced course's own topics are drawn at every zoom to
        // match (see the dot layer below).
        /** The replay's arrow, held back until every label has been painted. */
        let drawHead: (() => void) | null = null;
        /** The place a running replay is about, and how brightly it is lit. */
        let journeyLit: Map<number, number> | null = null;
        /** What the reader is being asked to look at: the topic being arrived
         *  at, and — while the arrow is in the air — the one it left. */
        const journeyNames: { topic: AtlasTopic; x: number; y: number; alpha: number }[] = [];
        if (tracing && flown && traceAt) {
            const { landed, frac, inAir } = flown;
            /** A step's place on the sphere. */
            const dirOf = (id: number): Vec3 | null => traceAt.get(id)?.u ?? null;
            const dirs = tracing.journey.map(dirOf);
            // A missing point would break the curve's neighbour arithmetic, so
            // the route is built from what is actually drawable. It cannot
            // happen — the journey is built from the same map these places come
            // from — and this is what keeps that true rather than assumed.
            const drawable = dirs.every(d => d !== null);
            const legs: SphereLeg[] = drawable ? spherePath(dirs as Vec3[]) : [];

            const view = (u: Vec3) => rotate(u, cam.yaw, cam.pitch);
            const screen = (u: Vec3) => project(view(u), cx, cy, R);

            /**
             * Stroke a leg by walking its curve and BREAKING it at the horizon.
             *
             * A journey on a planet goes round the back — that is what having
             * no edge means — and the far half of a leg must not be drawn
             * across the face of the globe as a chord. Sampling and dropping
             * everything with `z <= 0` cuts it exactly at the silhouette, which
             * is also where the reader's eye expects a line to disappear.
             */
            const strokeLeg = (leg: SphereLeg, upTo = 1) => {
                ctx.beginPath();
                let down = false;
                for (let i = 0; i <= LEG_SAMPLES; i++) {
                    const v = view(sphereLegAt(leg, (i / LEG_SAMPLES) * upTo));
                    if (v[2] <= 0) { down = false; continue; }
                    const pt = project(v, cx, cy, R);
                    if (down) ctx.lineTo(pt.x, pt.y);
                    else { ctx.moveTo(pt.x, pt.y); down = true; }
                }
                ctx.stroke();
            };
            /** Both ends well round the back: nothing of this leg is on screen. */
            const behind = (leg: SphereLeg) =>
                view(leg.p0)[2] < -0.3 && view(leg.p3)[2] < -0.3;

            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            // A CUT still fading (a restart takes a finished path back to step
            // one in one frame): the route as it stood, and the marker at its
            // end, drawn going away rather than vanishing.
            const cut = flown.cut;
            let ghostHead: { x: number; y: number; angle: number; p: number } | null = null;
            if (cut && legs.length) {
                const was = Math.max(0, Math.round(cut.from));
                const fade = 1 - cut.p;
                for (let i = 1; i <= was - 1 && was > landed; i++) {
                    const whole = legs[i - 1];
                    if (!whole || behind(whole)) continue;
                    const age = was > 2 ? (i - 1) / (was - 2) : 1;
                    const width = JOURNEY_MIN_WIDTH + (JOURNEY_MAX_WIDTH - JOURNEY_MIN_WIDTH) * age;
                    const alpha = (JOURNEY_MIN_ALPHA + (1 - JOURNEY_MIN_ALPHA) * age) * fade;
                    ctx.globalAlpha = alpha * JOURNEY_HALO_ALPHA;
                    ctx.strokeStyle = palette.lit;
                    ctx.lineWidth = width + JOURNEY_HALO_WIDTH;
                    strokeLeg(whole);
                    ctx.globalAlpha = alpha;
                    ctx.strokeStyle = palette.ink;
                    ctx.lineWidth = width;
                    strokeLeg(whole);
                }
                const d = was !== landed && was > 0 ? dirs[was - 1] : null;
                const v = d ? view(d) : null;
                if (v && v[2] > 0) {
                    const pt = project(v, cx, cy, R);
                    ghostHead = { x: pt.x, y: pt.y, angle: 0, p: cut.p };
                }
                ctx.globalAlpha = 1;
            }

            // Every leg is its own stroke because every leg is drawn at its own
            // weight: the path fades back as it recedes into the past, so
            // "where I am now" is the brightest thing on the planet and "where
            // I started" is still there to be traced back to.
            const lastLeg = inAir ? landed : landed - 1;
            for (let i = 1; i <= lastLeg; i++) {
                const whole = legs[i - 1];
                if (!whole || behind(whole)) continue;
                // By DISTANCE along the leg, not by the curve's own parameter:
                // the two are not the same axis, and flying the second is what
                // makes an arrow crawl out of a topic and then bolt. The tail
                // is the WHOLE leg walked up to the arrow's own parameter, so
                // the line it leaves behind is the curve the arrow is on rather
                // than a second curve fitted to the same two ends.
                const upTo = i === lastLeg && inAir ? sphereLegParam(whole, frac) : 1;
                const age = lastLeg > 1 ? (i - 1) / (lastLeg - 1) : 1;
                const width = JOURNEY_MIN_WIDTH + (JOURNEY_MAX_WIDTH - JOURNEY_MIN_WIDTH) * age;
                const alpha = JOURNEY_MIN_ALPHA + (1 - JOURNEY_MIN_ALPHA) * age;
                // Stroked twice — a halo in the surface's own colour, then the
                // ink over it — because this line crosses every cap in the
                // library by design, and a dark line over a dark cap and a pale
                // one over pale paper both disappear into what they cross.
                ctx.globalAlpha = alpha * JOURNEY_HALO_ALPHA;
                ctx.strokeStyle = palette.lit;
                ctx.lineWidth = width + JOURNEY_HALO_WIDTH;
                strokeLeg(whole, upTo);
                ctx.globalAlpha = alpha;
                ctx.strokeStyle = palette.ink;
                ctx.lineWidth = width;
                strokeLeg(whole, upTo);

                // Which way. A journey without direction is a shape; with it,
                // it is an order of events — and the order is the only reason
                // to draw it. The mark goes at the midpoint so it is never
                // buried under the dot it points at, only on a leg with room
                // for one, and never on the leg the arrow is flying: two
                // arrowheads on one line is one too many.
                if (i === lastLeg && inAir) continue;
                const midV = view(sphereLegAt(whole, 0.5));
                if (midV[2] <= 0.05) continue;
                const aheadV = view(sphereLegAt(whole, 0.54));
                if (aheadV[2] <= 0) continue;
                const mid = project(midV, cx, cy, R);
                const ahead = project(aheadV, cx, cy, R);
                const endA = screen(whole.p0), endB = screen(whole.p3);
                if (Math.hypot(endB.x - endA.x, endB.y - endA.y) < ARROW_MIN_LENGTH) continue;
                // The heading is taken from the PROJECTED curve rather than
                // from the tangent on the sphere: the mark is drawn in screen
                // space, and the projection foreshortens, so a direction that
                // is right on the globe points somewhere else on the glass.
                const len = Math.hypot(ahead.x - mid.x, ahead.y - mid.y);
                if (len < 1e-3) continue;
                const ux = (ahead.x - mid.x) / len, uy = (ahead.y - mid.y) / len;
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
            // landed. Both are drawn at every zoom, so even from furthest
            // out the planet says where this began and where it has got to.
            const firstDir = dirs[0];
            if (firstDir && landed > 0) {
                const v = view(firstDir);
                if (v[2] > 0) {
                    const pt = project(v, cx, cy, R);
                    ctx.globalAlpha = 0.55;
                    ctx.lineWidth = 1.5;
                    ctx.strokeStyle = palette.ink;
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }

            const landedId = tracing.journey[Math.max(0, landed - 1)];
            const landedDir = landed > 0 ? dirs[Math.max(0, landed - 1)] : null;
            const nextDir = inAir ? dirs[landed] : null;
            if (landedDir) {
                // Only while a replay is actually RUNNING: on a finished path
                // the head is "the last thing you closed", and a spotlight left
                // burning there would be a permanent mark on the planet.
                const running = stepNow != null;
                const landedTopic = tracing.points.get(landedId)?.topic ?? null;
                const nextTopic = inAir ? tracing.points.get(tracing.journey[landed])?.topic ?? null : null;
                if (running && landedTopic) {
                    journeyLit = new Map([[landedTopic.id, 1 - frac]]);
                    if (nextTopic) journeyLit.set(nextTopic.id, frac);
                    // Both ends are named while the arrow is in the air, cross-
                    // fading: the topic it left goes as it goes, the one it is
                    // arriving at is readable before it lands.
                    for (const [topic, dir, alpha] of [
                        [landedTopic, landedDir, 1 - frac] as const,
                        ...(nextTopic && nextDir ? [[nextTopic, nextDir, frac] as const] : []),
                    ]) {
                        const v = view(dir);
                        if (v[2] <= 0) continue;
                        const pt = project(v, cx, cy, R);
                        journeyNames.push({ topic, x: pt.x, y: pt.y, alpha });
                    }
                }

                // Where the arrow is and which way it points: on the curve it
                // is flying, or resting on the topic it reached.
                const leg = inAir ? legs[landed - 1] : null;
                const t = leg ? sphereLegParam(leg, frac) : 0;
                const headDir = leg ? sphereLegAt(leg, t) : landedDir;
                const headV = view(headDir);
                if (headV[2] > 0) {
                    const head = project(headV, cx, cy, R);
                    // A nudge further along the same curve, projected, for the
                    // heading — for the same reason the midpoint marks take
                    // theirs that way.
                    const nose = leg ? project(view(sphereLegAt(leg, Math.min(1, t + 0.04))), cx, cy, R) : null;
                    const angle = nose && Math.hypot(nose.x - head.x, nose.y - head.y) > 1e-3
                        ? Math.atan2(nose.y - head.y, nose.x - head.x) : 0;
                    // Drawn LAST, after every label — the path belongs under
                    // the names it runs between, but the head is the one thing
                    // the reader is following, and a topic name printed across
                    // it wins wherever it is drawn earlier.
                    // An arrow in the air, a dot on the ground, and the two
                    // crossing over at each end of the leg. A cut fades the
                    // new head in while the old one (below) fades out.
                    const arrow = leg ? headMorph(frac, flightMs(tracing, landed + 1, paceNow)) : 0;
                    const cutIn = cut ? cut.p : 1;
                    const ghost = ghostHead;
                    drawHead = () => {
                        const look = { ink: palette.ink, outline: palette.lit, acc };
                        if (ghost) paintHead(ctx, ghost, look, 0, 1 - ghost.p, 1 - 0.4 * ghost.p);
                        paintHead(ctx, { x: head.x, y: head.y, angle }, look, arrow, cutIn, 0.6 + 0.4 * cutIn);
                    };
                }
            }
            // The new head round the back of the planet: the old one still goes.
            if (!drawHead && ghostHead) {
                const ghost = ghostHead;
                drawHead = () => paintHead(ctx, ghost, { ink: palette.ink, outline: palette.lit, acc }, 0, 1 - ghost.p, 1 - 0.4 * ghost.p);
            }
            ctx.globalAlpha = 1;
        }

        // ---- the topics, once the reader is close enough for them to mean
        // anything. Same encoding as the flat map, one step down the same
        // ladder, so a dot means the same thing on both surfaces.
        let fading = false;
        const labeller = createLabeller(ctx, {
            width: w, height: h, ink: palette.ink, halo: palette.lit, defer: true,
        });

        // The step a replay has reached is named BEFORE anything else, because
        // it is the one label the reader is waiting for — and in this labeller,
        // first placed is first served. The stronger of the two goes first, so
        // the name being arrived at never loses its ground to the one being left.
        for (const label of [...journeyNames].sort((a, b) => b.alpha - a.alpha)) {
            if (label.alpha <= VISIBLE_ALPHA) continue;
            // Clear of the mark under it: the place being arrived at carries a
            // 19px glow, and a name set just above the dot is printed across it.
            labeller.wrapLabel(label.topic.title, label.x, label.y - 30,
                { size: 13, weight: 700, alpha: label.alpha }, Math.min(w * 0.6, 260), 2);
        }

        // The topic dots, once the reader is close enough for them to mean
        // anything — and the traced course's own at every distance, because the
        // journey is drawn between them at every distance and the ends of a
        // line have to be somewhere.
        if (detail > 0.01 || traceAt) {
            const wanted: { topic: AtlasTopic; x: number; y: number; slot: number; dot: number }[] = [];
            for (const { p, v: cv } of visible) {
                if (cv[2] < -0.02) continue;
                const dim = regionMatches(p.region) ? 1 : 0.16;
                const rr = Math.max(p.dotAngle * R, 1.4);
                let slot = 0;
                for (const { topic, u } of p.topics) {
                    const v = rotate(u, cam.yaw, cam.pitch);
                    if (v[2] <= 0) continue;
                    const s = project(v, cx, cy, R);
                    const edge = ramped(v[2], 0, LIMB_FADE);
                    const isMatch = matched ? matched.has(topic.id) : false;
                    const isFocused = focus?.topic?.id === topic.id || carded?.topic?.id === topic.id;
                    // Per TOPIC once a course is traced, not per cap: a cap the
                    // course reaches is usually shared with other courses, and
                    // dimming it wholesale would hide the very dots the path
                    // runs between while leaving their neighbours just as bright.
                    const onCourse = !traceAt || traceAt.has(topic.id);
                    const lit = journeyLit?.get(topic.id) ?? 0;

                    // The traced course's own topics keep a floor; every other
                    // dot still fades in only as the reader arrives.
                    const solid = traceAt && onCourse ? Math.max(detail, TRACE_DOT_MIN) : detail;
                    const alpha = solid * edge
                        * (matched && !isMatch ? 0.14 : dim)
                        * (onCourse ? 1 : TRACE_TOPIC_DIM);
                    // Zoomed out with a course traced, everything off the route
                    // is invisible — and painting the whole library's worth of
                    // invisible discs is what the floor above would otherwise
                    // cost on every frame of every replay.
                    if (alpha <= 0.004 && lit <= 0.02) continue;
                    ctx.globalAlpha = alpha;
                    ctx.beginPath();
                    ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
                    const step = topic.status === 'completed' ? 4
                        : (topic.attempts > 0 || topic.status === 'in_progress') ? 2 : 0;
                    ctx.fillStyle = paint === 'course'
                        ? courseFill(courseHue.get(topic.projectId), step, dark)
                        : steps[step];
                    ctx.fill();
                    if (lit > 0.02) {
                        // The place the replay is arriving at, lit — and the one
                        // it is leaving, draining. Both at once while the arrow
                        // is in the air, so an arrival is something the planet
                        // does gradually and finishes ON the beat, rather than a
                        // lamp that switches on after the fact.
                        ctx.globalAlpha = solid * edge * lit;
                        ctx.strokeStyle = acc(0.95);
                        ctx.lineWidth = 2.5;
                        ctx.beginPath();
                        ctx.arc(s.x, s.y, rr + 4, 0, Math.PI * 2);
                        ctx.stroke();
                    } else if (isMatch || isFocused) {
                        ctx.strokeStyle = acc(0.95);
                        ctx.lineWidth = 2;
                        ctx.stroke();
                    } else if (rr > 3) {
                        ctx.globalAlpha = solid * edge * 0.5 * dim;
                        ctx.strokeStyle = palette.rim;
                        ctx.lineWidth = 1;
                        ctx.stroke();
                    }
                    if (rr > NAME_DOT_MIN && nameFade > 0 && edge > 0.5) {
                        wanted.push({ topic, x: s.x, y: s.y, slot: slot++, dot: edge });
                    }
                }
            }
            ctx.globalAlpha = 1;

            // One name per bubble before any bubble gets a second — the same
            // round-robin the flat map deals its names out with, and for the
            // same reason: walking region by region spends the whole budget on
            // whichever ones the array listed first.
            wanted.sort((a, b) => {
                const rank = (t: AtlasTopic) => (focus?.topic?.id === t.id ? 2 : matched?.has(t.id) ? 1 : 0);
                return rank(b.topic) - rank(a.topic) || a.slot - b.slot;
            });
            const fades = nameAlphaRef.current;
            const onScreen = new Set<number>();
            for (const { topic, x, y, dot } of wanted) {
                onScreen.add(topic.id);
                const want = nameFade * dot * (matched && !matched.has(topic.id) ? 0.3 : 1)
                    // While the planet is TURNING it carries no topic names.
                    // Two reasons, and either would do on its own. Text sliding
                    // across a globe is not readable, so what it costs the
                    // reader is a screenful of moving words in the way of the
                    // shapes they are actually watching — the same call the
                    // flat map makes during a replay. And it is what the drift
                    // costs: measured on the real library at 1100x760 (headless
                    // Edge, dpr 2), placing every visible topic name on every
                    // frame of a turn was 36% of one core, against 6% with only
                    // the region names to place. Zeroing the target rather than
                    // skipping the collection means they fade out on their own
                    // ramp and fade back in when it stops, instead of being cut
                    // off mid-word.
                    * (moving ? 0 : 1)
                    // One subject per beat. While a replay is running the only
                    // topic name on the planet is the place it is arriving at,
                    // which was placed before any of these — the same call the
                    // flat map makes, for the same reason: a replay is a
                    // sentence being read out, and every other name on screen
                    // is something else asking to be read instead.
                    * (stepNow != null ? 0 : 1);
                const prev = fades.get(topic.id) ?? 0;
                const next = reduceMotion ? want : prev + (want - prev) * NAME_EASE;
                if (want === 0 && next < 0.01) { fades.set(topic.id, 0); continue; }
                const placedName = labeller.wrapLabel(topic.title, x, y, {
                    size: labelPx(TOPIC_NAME_PX), weight: 500, alpha: Math.max(next, 0.05),
                }, Math.min(w * 0.5, 210), 2);
                fades.set(topic.id, placedName ? next : 0);
                if (placedName && Math.abs(next - want) > 0.01) fading = true;
            }
            for (const id of [...fades.keys()]) if (!onScreen.has(id)) fades.delete(id);
        }

        // ---- region names. Placed AFTER the topic names would be placed is
        // wrong in this labeller — first placed is first served — so they go
        // first, largest and most relevant first, and the topic names fill in
        // around whatever ground is left. Except that the topic pass above has
        // already run, so these are placed against it: the order below is the
        // one that matters, and it is why the region names are collected here
        // and painted with everything else on `flush()`.
        const named = [...visible].sort((a, b) => {
            const rank = (p: Placed) => (p.region.id === selected ? 2 : p.region.id === focus?.region.id ? 1 : 0);
            return rank(b.p) - rank(a.p) || b.p.region.size - a.p.region.size;
        });
        // Off means the measure-and-wrap pass does not happen, not that it
        // happens and paints nothing. The selected cap keeps its name: it is
        // the one place the reader pointed at.
        for (const { p, v } of named) {
            if (!showNames && p.region.id !== selected) continue;
            const e = capEllipse(v, p.cap, cx, cy, R);
            if (e.facing <= 0) continue;
            // How big the cap is AS DRAWN — the geometric mean of the two
            // axes, which is the radius of a circle with the same area. Taking
            // the tangential axis alone (the one that never foreshortens) gave
            // a full-size name to every sliver at the limb, so the rim of the
            // planet carried a ring of text belonging to shapes two pixels
            // wide.
            const on = Math.sqrt(Math.max(e.rx, 0.2) * e.ry);
            if (on < MIN_NAMED_RADIUS && p.region.id !== selected) continue;
            const isSelected = p.region.id === selected;
            const size = labelPx(clamp(Math.round(on * 0.34), MIN_LABEL_PX, MAX_NAME_PX));
            // A traced course dims the region NAMES with the regions they
            // belong to. Without it the picture is the one thing the reader
            // asked for — one line across the library — under a hundred place
            // names at full strength, all of them about somewhere else. The
            // course's own regions stay bright, which is what makes the route
            // legible as a route.
            const alpha = (regionMatches(p.region) ? 1 : 0.3) * (1 - detail)
                * ramped(e.facing, 0, 0.3)
                * (tracedIn && !tracedIn.has(p.region.id) ? TRACE_REGION_DIM : 1);
            if (alpha < 0.04) continue;
            labeller.placeRegion(p.region.label, e.x, e.y, on, {
                size: isSelected ? size + 2 : size,
                weight: isSelected ? 800 : 700,
                alpha,
            }, { maxLines: on > 26 ? 3 : 2 });
        }
        // The clip comes off BEFORE the names are painted. A name is chrome
        // FOR a place, not paint on it — the flat map lets one overflow its
        // own bubble for exactly this reason — and clipping the text to the
        // silhouette cut every name near the limb in half: "ombinator Deal",
        // "tup Longevity", a whole rim of words with their first letters
        // behind the edge of the world.
        ctx.restore();
        labeller.flush();

        // ---- the rim, painted last and OUTSIDE the clip, so the silhouette is
        // a clean edge rather than a half-pixel of whatever ended up under it.
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.strokeStyle = palette.rim;
        ctx.lineWidth = 1;
        ctx.stroke();

        // The arrow, over everything — including every label, which is why it
        // was held back this far.
        drawHead?.();

        drawnRef.current = { placed: all, detail };

        // The card follows whatever it is anchored to, because the thing it is
        // anchored to MOVES: on a turning planet a card that stayed put would
        // be pointing at open ocean within a second.
        const held = pinnedRef.current || hoverRef.current;
        if (held) {
            const next = anchorFor(held);
            const prev = anchorRef.current;
            if (next && (!prev || Math.abs(prev.x - next.x) > 0.5 || Math.abs(prev.y - next.y) > 0.5
                || Math.abs(prev.r - next.r) > 0.5)) {
                anchorRef.current = next;
                setAnchor(next);
            }
        }

        // `flying` keeps the loop alive through a leg the reader is watching:
        // the camera may be perfectly still — a replay the reader is not
        // following, or a hop inside one cap — and the arrow is still crossing
        // it. Without it the flight stops on whatever frame the camera settled.
        // A cut still fading is the same: nothing may move, and the old path
        // is still going away.
        const busy = moving || fading || flying || !!flown?.cut;
        stillRef.current = !busy;
        if (busy) requestDraw();
        else lastFrame.current = 0;
    };

    // ---- size ---------------------------------------------------------------
    useEffect(() => {
        const canvas = canvasRef.current, wrap = wrapRef.current;
        if (!canvas || !wrap) return;
        const ro = new ResizeObserver(() => {
            const r = wrap.getBoundingClientRect();
            const dpr = captureRatio(capture, r.width);
            refreshRootFontScale();
            dprRef.current = dpr;
            sizeRef.current = { w: r.width, h: r.height };
            // Capturing, the frame's size is the answer and the box is only
            // where it is drawn.
            canvas.width = capture ? capture.width : Math.round(r.width * dpr);
            canvas.height = capture ? capture.height : Math.round(r.height * dpr);
            requestDraw();
        });
        ro.observe(wrap);
        return () => ro.disconnect();
    }, [requestDraw, capture]);

    // `trace` and `journeyStep` too, as on the flat map: the loop stops once
    // nothing moves, and a replay's first step can reach `live` AFTER the frame
    // `followJourney` asked for — that frame sees no step, stops, and without a
    // draw on the step change the planet stood still for a whole GIF render.
    useEffect(() => { requestDraw(); },
        [placed, selectedId, matches, colorMode, hues, palette, spinning, trace, journeyStep, requestDraw]);

    // ---- pointer -------------------------------------------------------------
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        let dragging = false;
        let moved = 0;
        let last = { x: 0, y: 0, t: 0 };
        /**
         * How fast the planet is turning under the hand, in radians a second,
         * read off the CAMERA rather than off the pointer — after the solve the
         * two are not the same number, and the flick a release throws is about
         * the planet. It lives here rather than in `spinRef` on purpose: a
         * velocity the frame loop can see is a velocity the frame loop
         * INTEGRATES, and a drag that both moves the camera itself and feeds a
         * loop that moves it again turns the planet about twice as far as the
         * hand asked for — measured at 192% of the drag — and goes on turning
         * it while a still hand holds the button down.
         */
        let flick = 0;
        /** …and how fast the hand itself was going, which is what decides
         *  whether the release was a throw at all. */
        let handPx = 0;
        let flickAt = 0;
        const pinches = new Map<number, { x: number; y: number }>();
        let pinchBase = 0;

        const local = (e: PointerEvent) => {
            const r = canvas.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        };

        const onDown = (e: PointerEvent) => {
            canvas.setPointerCapture(e.pointerId);
            pinches.set(e.pointerId, local(e));
            if (pinches.size === 2) {
                const [a, b] = [...pinches.values()];
                pinchBase = Math.hypot(a.x - b.x, a.y - b.y);
                return;
            }
            dragging = true;
            moved = 0;
            const p = local(e);
            last = { ...p, t: performance.now() };
            flick = 0;
            handPx = 0;
            flickAt = 0;
            takeCamera();
            canvas.style.cursor = 'grabbing';
        };

        const onMove = (e: PointerEvent) => {
            const p = local(e);
            if (pinches.has(e.pointerId)) pinches.set(e.pointerId, p);
            if (pinches.size === 2) {
                const [a, b] = [...pinches.values()];
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                if (pinchBase > 0) {
                    camRef.current.k = clamp(camRef.current.k * (d / pinchBase), MIN_K, MAX_K);
                    requestDraw();
                }
                pinchBase = d;
                return;
            }
            if (dragging) {
                const dx = p.x - last.x, dy = p.y - last.y;
                moved += Math.hypot(dx, dy);
                const R = radius();
                const cam = camRef.current;
                const wasYaw = cam.yaw;
                // A drag moves the point under the finger, so the angle it
                // turns through is the distance divided by the radius — which
                // is what makes a slow drag near the limb turn the planet
                // further than the same drag across the middle, exactly as a
                // real one would.
                //
                // Deliberately an EVEN turn per pixel, and not the solve that
                // puts the grabbed point exactly under the cursor: that solve
                // is right and it FEELS wrong. Its gain is `1/cos θ` of the
                // grabbed point's angle, so the same hand movement turns the
                // planet gently in the middle of the disc and violently near
                // the rim, and where it cannot oblige at all — a near-polar
                // point, a cursor past the silhouette, the pitch clamp — it has
                // to hand back to this formula and take a fresh hold, so a drag
                // crossing that line changes gain mid-gesture. It was built,
                // measured (the grabbed point tracked the cursor to 2px) and
                // taken out again: it reads as jagged, and differently so
                // depending on where the drag started.
                const turn = dx / Math.max(R, 1);
                cam.yaw -= turn / Math.max(0.35, Math.cos(cam.pitch));
                cam.pitch = clamp(cam.pitch + dy / Math.max(R, 1), -MAX_PITCH, MAX_PITCH);
                const t = performance.now();
                // Nothing here touches `spinRef`: while the hand is on the
                // planet the hand is the only thing moving it.
                if (t > last.t) {
                    const secs = (t - last.t) / 1000;
                    flick = (cam.yaw - wasYaw) / secs;
                    handPx = Math.hypot(dx, dy) / secs;
                }
                flickAt = t;
                last = { ...p, t };
                requestDraw();
                return;
            }
            const hit = pick(p.x, p.y, true);
            canvas.style.cursor = hit ? 'pointer' : 'grab';
            if (pinnedRef.current) return;             // a pin outlives a hover
            const same = hit && hoverRef.current
                && hit.kind === hoverRef.current.kind
                && hit.region.id === hoverRef.current.region.id
                && hit.topic?.id === hoverRef.current.topic?.id;
            if (same) return;
            hoverRef.current = hit;
            setHover(hit);
            const a = hit ? anchorFor(hit) : null;
            anchorRef.current = a;
            setAnchor(a);
            requestDraw();
        };

        const onUp = (e: PointerEvent) => {
            pinches.delete(e.pointerId);
            if (pinches.size < 2) pinchBase = 0;
            if (!dragging) return;
            dragging = false;
            canvas.style.cursor = 'grab';
            if (moved > CLICK_SLOP) {
                // A flick keeps turning. Anything slower than that, or let go
                // of after a pause, has come to rest on purpose and must stay
                // where it was put.
                const still = performance.now() - flickAt > FLICK_STILL_MS
                    || handPx < FLICK_MIN_PX;
                spinRef.current = still ? 0 : flick;
                requestDraw();
                return;
            }
            spinRef.current = 0;
            const p = local(e);
            const hit = pick(p.x, p.y);
            if (!hit) { dismissCard(); live.current.onSelect(null); requestDraw(); return; }
            pinnedRef.current = hit;
            hoverRef.current = hit;
            setPinned(hit); setHover(hit);
            const a = anchorFor(hit);
            anchorRef.current = a; setAnchor(a);
            live.current.onSelect(hit.region.id);
            requestDraw();
        };

        const onLeave = () => {
            if (pinnedRef.current) return;
            hoverRef.current = null; setHover(null);
            anchorRef.current = null; setAnchor(null);
            requestDraw();
        };

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            takeCamera();
            // The whole planet, about its own middle — the scroll changes how
            // close you are and nothing else.
            //
            // A plane's zoom has an anchor: the point you scroll on stays where
            // it is and everything grows around it, and the obvious translation
            // of that to a sphere is to turn the planet toward whatever is
            // under the pointer. It was tried and it is wrong: turning and
            // zooming at once means a scroll does two things, the planet swings
            // under a pointer that was only asking for a closer look, and a
            // reader who scrolls twice ends up somewhere they never chose.
            // Turning is what a drag is for.
            camRef.current.k = clamp(camRef.current.k * Math.exp(-e.deltaY * 0.0015), MIN_K, MAX_K);
            requestDraw();
        };

        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('pointercancel', onUp);
        canvas.addEventListener('pointerleave', onLeave);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            canvas.removeEventListener('pointerdown', onDown);
            canvas.removeEventListener('pointermove', onMove);
            canvas.removeEventListener('pointerup', onUp);
            canvas.removeEventListener('pointercancel', onUp);
            canvas.removeEventListener('pointerleave', onLeave);
            canvas.removeEventListener('wheel', onWheel);
        };
    }, [anchorFor, dismissCard, pick, radius, requestDraw, takeCamera, worldAt]);

    // ---- the handle ----------------------------------------------------------
    /** Turn to face `u`, taking the short way round, and hold the camera there. */
    const turnTo = useCallback((
        u: Vec3, k?: number, ease?: { omega: number; kOmega: number }, instant = false,
    ) => {
        const { yaw, pitch } = faceOn(u);
        // A yaw target two turns away is the same place and three seconds of
        // spinning to reach it.
        const cur = camRef.current.yaw;
        const goal = {
            yaw: yaw + Math.round((cur - yaw) / (Math.PI * 2)) * Math.PI * 2,
            pitch: clamp(pitch, -MAX_PITCH, MAX_PITCH),
            k: k == null ? undefined : clamp(k, MIN_K, MAX_K),
            omega: ease?.omega, kOmega: ease?.kOmega,
        };
        if (instant) {
            // Already there: a film's first frame, which must not be a move.
            camRef.current = { yaw: goal.yaw, pitch: goal.pitch, k: goal.k ?? camRef.current.k };
            camVelRef.current = { yaw: 0, pitch: 0, lk: 0 };
            targetRef.current = null;
        } else {
            targetRef.current = goal;
        }
        spinRef.current = 0;
        setSpinning(false);
        requestDraw();
    }, [requestDraw]);

    const flyTo = useCallback((regionId: number) => {
        const p = live.current.placed.find(x => x.region.id === regionId);
        if (!p) return;
        followRef.current = false;
        const { yaw, pitch } = faceOn(p.u);
        // Take the short way round: a yaw target two turns away is the same
        // place and three seconds of spinning to reach it.
        const cur = camRef.current.yaw;
        const wrapped = yaw + Math.round((cur - yaw) / (Math.PI * 2)) * Math.PI * 2;
        targetRef.current = { yaw: wrapped, pitch: clamp(pitch, -MAX_PITCH, MAX_PITCH) };
        spinRef.current = 0;
        setSpinning(false);
        requestDraw();
    }, [requestDraw]);

    const reset = useCallback(() => {
        // The opening view is a place on the planet, not a number of turns
        // away from one. Yaw accumulates — the idle drift alone adds a full
        // turn every eighty seconds — so easing to a literal 0 spins the globe
        // back through every revolution it has made since the page opened,
        // which on a map left drifting is a good ten seconds of unwinding.
        // `Math.round` picks the equivalent angle nearest where it already is,
        // the same short-way-round the fly-to takes.
        const cur = camRef.current.yaw;
        followRef.current = false;
        followKRef.current = null;
        // The zoom travels with the turn rather than being assigned under it:
        // going back to the opening view is one move, and half of it arriving a
        // frame after the button was pressed is what made it read as two.
        targetRef.current = {
            yaw: Math.round(cur / (Math.PI * 2)) * Math.PI * 2, pitch: DEFAULT_PITCH, k: 1,
        };
        spinRef.current = 0;
        requestDraw();
    }, [requestDraw]);

    /**
     * Put a whole course in front of the reader.
     *
     * A plane frames a bounding box; a sphere cannot, because a course spread
     * over more than a hemisphere has no view containing it. So this is the two
     * things that ARE available: turn the middle of the course to face the
     * reader, and pick the zoom at which its furthest topic from that middle is
     * still comfortably on the disc. A point `reach` radians off the middle is
     * drawn `R · sin(reach)` from the centre, which is what decides the zoom —
     * and past a right angle it is behind the horizon however far out you go,
     * so the zoom bottoms out rather than pretending otherwise.
     */
    const takeInCourse = useCallback((
        course: CourseTrace, ease?: { omega: number; kOmega: number }, instant = false,
    ) => {
        const places = live.current.tracePlaces;
        if (!places) return;
        const seen: { u: Vec3; w: number }[] = [];
        for (const id of course.points.keys()) {
            const p = places.get(id);
            if (p) seen.push({ u: p.u, w: 1 });
        }
        const middle = meanDirection(seen);
        if (!middle) return;
        let reach = 0;
        for (const p of seen) reach = Math.max(reach, angleBetween(middle, p.u));
        const fit = reach > 1e-4
            ? (FOLLOW_FILL * 0.5) / (BASE_FILL * Math.sin(Math.min(reach, Math.PI / 2)))
            : FOLLOW_K;
        followRef.current = false;
        followKRef.current = null;
        turnTo(middle, clamp(fit, MIN_K, FOLLOW_K), ease, instant);
    }, [turnTo]);

    const frameOnCourse = useCallback((course: CourseTrace, opts?: { instant?: boolean }) => {
        takeInCourse(course, undefined, !!opts?.instant);
    }, [takeInCourse]);

    /**
     * …and the same place, arrived at as an ENDING rather than as a choice.
     *
     * The plane's reason, and the planet has one of its own on top of it: the
     * camera that has been riding the arrow is still turning when the last
     * landing is held, and a fly-to at `EASE_OMEGA` takes that turn over at four
     * times the speed it was going. Softer, and the planet keeps rolling the way
     * it was rolling while it widens out.
     */
    const endJourney = useCallback((course: CourseTrace) => {
        takeInCourse(course, { omega: END_OMEGA, kOmega: END_ZOOM_OMEGA });
    }, [takeInCourse]);

    const followJourney = useCallback(() => {
        // Nothing is snapped here. The next frame sees the flag, works out
        // where the arrow is, and turns the planet toward it on the same easing
        // every other move uses — a cut to the start of a journey would lose
        // the connection between the planet the reader was looking at and the
        // one they are now in.
        followRef.current = true;
        // The held shot starts from what the journey asks for, so resuming
        // rides in from wherever the reader left the planet rather than from a
        // zoom the last replay happened to settle on.
        followKRef.current = null;
        setSpinning(false);
        requestDraw();
    }, [requestDraw]);

    useImperativeHandle(ref, () => ({
        flyTo, reset, frameOnCourse, endJourney, followJourney,
        journeyAt: () => (flightRef.current.target == null ? null : flightRef.current.at),
        camera: () => ({ ...camRef.current }),
        canvas: () => canvasRef.current,
        settled: () => stillRef.current && frameRef.current === 0 && targetRef.current == null,
    }), [flyTo, reset, frameOnCourse, endJourney, followJourney]);

    const zoomBy = useCallback((f: number) => {
        takeCamera();
        camRef.current.k = clamp(camRef.current.k * f, MIN_K, MAX_K);
        requestDraw();
    }, [requestDraw, takeCamera]);

    // ---- keyboard ------------------------------------------------------------
    const onKeyDown = (e: ReactKeyboardEvent) => {
        const turn = 0.12;
        const acts: Record<string, () => void> = {
            ArrowLeft: () => { takeCamera(); camRef.current.yaw -= turn; },
            ArrowRight: () => { takeCamera(); camRef.current.yaw += turn; },
            ArrowUp: () => { takeCamera(); camRef.current.pitch = clamp(camRef.current.pitch + turn, -MAX_PITCH, MAX_PITCH); },
            ArrowDown: () => { takeCamera(); camRef.current.pitch = clamp(camRef.current.pitch - turn, -MAX_PITCH, MAX_PITCH); },
            '+': () => zoomBy(1.3),
            '=': () => zoomBy(1.3),
            '-': () => zoomBy(1 / 1.3),
            '_': () => zoomBy(1 / 1.3),
            '0': () => reset(),
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
        act();
        requestDraw();
    };

    const card = pinned || hover;
    const isPinnedTopic = !!(pinned?.topic && card?.topic?.id === pinned.topic.id);

    // A frame being recorded carries no chrome, no card and no pointer — the
    // same branch the flat map takes, for the same reason.
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
                aria-label={tr("The library as a planet. Drag to turn it, scroll or pinch to zoom, arrow keys to turn, plus and minus to zoom, 0 to reset, f for full screen. The region list beside it carries the same information as text.")}
                onKeyDown={onKeyDown}
                className="block w-full h-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-inset"
                style={{ cursor: 'grab' }}
            />

            {children && (
                <div className="absolute top-3 left-3 right-3 z-10 pointer-events-none">{children}</div>
            )}

            <MapControls controls={[
                { icon: Plus, name: tr("Zoom in"), act: () => zoomBy(1.4) },
                { icon: Minus, name: tr("Zoom out"), act: () => zoomBy(1 / 1.4) },
                { icon: RotateCcw, name: tr("Back to the opening view"), act: reset },
                {
                    icon: spinning ? Pause : Orbit,
                    name: spinning ? tr("Stop turning") : tr("Turn on its own"),
                    active: spinning,
                    act: () => { spinRef.current = 0; setSpinning(s => !s); requestDraw(); },
                },
                {
                    icon: fullscreen ? Minimize2 : Maximize2,
                    name: fullscreen ? tr("Leave full screen") : tr("Full screen"),
                    act: onToggleFullscreen,
                },
            ]} />

            <p className="absolute bottom-3 left-3 max-w-[calc(100%-4.5rem)] text-xs text-slate-500 dark:text-slate-400 bg-white/75 dark:bg-slate-900/75 backdrop-blur px-2 py-1 rounded-lg pointer-events-none">
                {tr("Drag to turn the planet · scroll or pinch to zoom in on topics")}
            </p>

            {card && anchor && (
                <AtlasCard
                    focus={card as AtlasFocus}
                    anchor={anchor}
                    size={sizeRef.current}
                    interactive={isPinnedTopic}
                    onOpenTopic={t => live.current.onOpenTopic(t)}
                />
            )}
        </div>
    );
});

export default GlobeMap;

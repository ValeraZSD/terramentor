import { AtlasRegion, AtlasTopic } from '../../types';

/**
 * The course-shaped view of an atlas payload: which courses can be traced, and
 * where one learner's journey through one of them actually runs.
 *
 * Pure arithmetic over the payload, in its own module for the same reason
 * `mapLabels.ts` is: everything in here can be WRONG without throwing anything.
 * A journey sorted by the wrong key draws a plausible path through the wrong
 * topics; a timeline whose span is off puts every finish in the wrong month.
 * Both are pictures, and a picture is not something a canvas test can catch —
 * so the arithmetic lives where a script can call it directly
 * (`tools/atlas-gates.mjs` bundles this module and drives it).
 *
 * Nothing here reads the DOM, the camera or the theme. The renderer decides
 * where a point lands on screen; this decides which points there are and in
 * what order.
 */

/** A course that has topics on the map, with what there is to see in it. */
export interface Course {
    id: number;
    name: string;
    color: string | null;
    /** Mapped topics — not the project's topic count, which includes unmapped ones. */
    topics: number;
    /** Finishes that carry a date, so they have a place on the path. */
    finished: number;
    /** Finishes with no usable date. Drawn nowhere, reported in words. */
    undated: number;
    /** The most recent finish, or null. */
    lastAt: string | null;
    /** When the course itself began — where its timeline starts. */
    startedAt: string | null;
}

/**
 * One topic on the route: where it is, and which bubble it is in.
 *
 * Its own place and nothing else. A `TracePoint` carrying its region's centre
 * too is drawn somewhere between the two depending on the zoom: a course reads
 * as a few region-to-region hops from far away and as the real topics up
 * close. That reads well in a still frame and it makes the route a function of
 * the camera — zooming changes which shape the line has, and legs inside one
 * bubble grow out of a point. The journey is ONE shape, in the map's own
 * coordinates, and the zoom only decides how big it is drawn.
 */
export interface TracePoint {
    id: number;
    topic: AtlasTopic;
    /** The topic's own place inside its bubble. */
    x: number;
    y: number;
    /** Which bubble it lives in — what the renderer dims the rest of the map by. */
    regionId: number;
}

export interface CourseTrace {
    projectId: number;
    name: string;
    points: Map<number, TracePoint>;
    /** Topic ids in the order they were finished — the journey itself. */
    journey: number[];
    /** Finished topics with no usable date: counted, never guessed at. */
    undated: number;
    /** When the course began (ISO, UTC), or null — the timeline's left edge. */
    startedAt: string | null;
}

/**
 * When a course began, read off the region rows rather than the topics: the
 * date belongs to the project, and the payload carries it once per project per
 * region rather than once per topic.
 *
 * The first region that names the project answers — every copy is the same
 * row — and a project the map does not draw answers null, which is what the
 * timeline reads as "no run-up to show".
 */
function startOf(regions: AtlasRegion[], projectId: number): string | null {
    for (const region of regions) {
        for (const project of region.projects) {
            if (project.id === projectId) return project.start ?? null;
        }
    }
    return null;
}

/**
 * Every project with at least one topic on the map, ordered by what there is to
 * watch: the courses with a journey first, then the big ones.
 *
 * Derived from the regions rather than fetched, because the map already holds
 * exactly the topics that can be drawn — asking the server for a project list
 * would offer courses whose topics have no coordinates yet.
 */
export function listCourses(regions: AtlasRegion[]): Course[] {
    const byId = new Map<number, Course>();
    for (const region of regions) {
        for (const topic of region.topics) {
            let course = byId.get(topic.projectId);
            if (!course) {
                course = {
                    id: topic.projectId, name: topic.projectName, color: topic.projectColor,
                    topics: 0, finished: 0, undated: 0, lastAt: null,
                    startedAt: startOf(regions, topic.projectId),
                };
                byId.set(topic.projectId, course);
            }
            // The label counts what the course counts: section headings are
            // mapped and journeyed through, never counted.
            if (topic.leaf === false) continue;
            course.topics++;
            if (topic.completedAt) {
                course.finished++;
                if (!course.lastAt || topic.completedAt > course.lastAt) course.lastAt = topic.completedAt;
            } else if (topic.status === 'completed') {
                course.undated++;
            }
        }
    }
    return [...byId.values()].sort(
        (a, b) => b.finished - a.finished || b.topics - a.topics || a.name.localeCompare(b.name),
    );
}

/**
 * One course's topics and the journey through them, or null when the project
 * has nothing on the map.
 *
 * The curriculum's own tree is deliberately NOT part of this: a faint web of
 * parent→child links drawn under the path is a hundred lines running off the
 * edge of the screen behind the one line that is about the learner. The map
 * already dissolves courses on purpose; what this layer is for is the route
 * somebody actually took through what is left.
 */
export function traceCourse(regions: AtlasRegion[], projectId: number): CourseTrace | null {
    const points = new Map<number, TracePoint>();
    let name = '';
    for (const region of regions) {
        for (const topic of region.topics) {
            if (topic.projectId !== projectId) continue;
            name = name || topic.projectName;
            points.set(topic.id, {
                id: topic.id, topic, x: topic.x, y: topic.y, regionId: region.id,
            });
        }
    }
    if (points.size === 0) return null;

    const finished: AtlasTopic[] = [];
    let undated = 0;
    for (const point of points.values()) {
        if (point.topic.completedAt) finished.push(point.topic);
        else if (point.topic.status === 'completed') undated++;
    }
    // The date first; the id only to break a tie. Two topics closed in the same
    // second is ordinary (one press closes a parent and its last child), and
    // without the tiebreak the path would reorder itself between visits.
    finished.sort((a, b) => (a.completedAt! < b.completedAt! ? -1 : a.completedAt! > b.completedAt! ? 1 : a.id - b.id));

    return {
        projectId, name, points, journey: finished.map(t => t.id), undated,
        startedAt: startOf(regions, projectId),
    };
}

// ---- the journey in TIME ----------------------------------------------------
//
// The map draws the journey in space and the replay counts it in events, and
// neither of those says WHEN. Thirty-six finishes is the same picture whether
// they took a fortnight or two years, and the gaps — the month nothing was
// closed, the weekend that closed nine topics — are the part of a learner's own
// record they cannot get anywhere else in the app.
//
// So the panel draws one more thing: the same journey laid out on a date axis.
// Its arithmetic is here rather than in the component for the reason everything
// in this module is: a bar whose span is wrong is still a bar, drawn confidently
// in the wrong proportions.

export interface JourneyTimeline {
    /** The bar's left edge: the course's own start, or its first finish. */
    startMs: number;
    /** The first finish — a place on the bar, and usually not its start. */
    firstMs: number;
    /** The last finish, and the bar's right edge. */
    lastMs: number;
    /** True when the course began before its first finish — there is a run-up to draw. */
    hasRunUp: boolean;
    /**
     * Where each step of the journey sits on the bar, as a fraction in [0, 1].
     * One entry per journey entry, in the same order, so step N of the replay
     * is `at[N - 1]` and the two renderings of one number cannot disagree.
     */
    at: number[];
    /**
     * The same fractions DEDUPED to a grid fine enough to be worth a pixel —
     * what the bar actually draws. A year-long course with four thousand
     * finishes would otherwise ask the DOM for four thousand marks inside
     * 340px, where a tenth of them are already a solid band.
     */
    marks: number[];
    /** How wide the grid a mark is rounded to — exported so a gate can check it. */
    grid: number;
}

/** Marks land on a 0.5% grid: 200 of them fill a bar of any width this panel has. */
const MARK_GRID = 0.005;

const msOf = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
};

/**
 * The journey's dates, laid out as fractions of one bar — or null when there is
 * no journey to lay out.
 *
 * A start that is missing, unparseable or LATER than the first finish is no
 * start: the bar begins at the first finish instead. The last case is not
 * hypothetical — a project whose start date was edited after the fact, or an
 * import that carried finishes older than the row that holds them — and
 * honouring it would draw the whole journey off the left end of its own bar.
 */
export function journeyTimeline(trace: CourseTrace): JourneyTimeline | null {
    // One entry per journey step, nulls kept in place: a date this cannot read
    // must not shift every step after it one place along the bar.
    const dates = trace.journey.map(id => msOf(trace.points.get(id)?.topic.completedAt));
    const known = dates.filter((ms): ms is number => ms != null);
    if (known.length === 0) return null;
    const firstMs = known[0];
    const lastMs = known[known.length - 1];
    const started = msOf(trace.startedAt);
    const hasRunUp = started != null && started < firstMs;
    const startMs = hasRunUp ? started! : firstMs;
    const span = lastMs - startMs;
    // Everything finished inside one second — a fresh import, a single
    // finish — has no duration to lay out. Every step goes to the right-hand
    // end, which is where "all of it, just now" belongs.
    const fraction = (ms: number) => (span > 0 ? (ms - startMs) / span : 1);

    const at: number[] = [];
    const marks: number[] = [];
    let carried = 0;
    let lastMark = -1;
    for (const ms of dates) {
        // An unreadable date inherits the step before it rather than inventing
        // a place of its own: it is known to have happened after it.
        if (ms != null) carried = fraction(ms);
        at.push(carried);
        const snapped = Math.round(carried / MARK_GRID) * MARK_GRID;
        if (snapped !== lastMark) marks.push(snapped);
        lastMark = snapped;
    }
    return { startMs, firstMs, lastMs, hasRunUp, at, marks, grid: MARK_GRID };
}

// ---- the flight path --------------------------------------------------------
//
// The journey is a list of places and the order they were reached in; what a
// reader watches is something MOVING between them. Those are not the same
// picture, and a straight polyline cannot give the second one: an arrow walking
// a polyline swings its heading through a corner in a single frame, which reads
// as a series of jumps however smoothly its position is interpolated.
//
// So the drawn route is a curve through the same points — centripetal
// Catmull-Rom, converted to cubic Béziers because that is what a canvas can
// stroke. Centripetal (alpha = 0.5) rather than the uniform kind for one
// specific reason: this map hands it coincident and near-coincident points all
// the time (two topics of one course can sit a thousandth of the map apart),
// and uniform Catmull-Rom answers those with a cusp or a loop — an arrow that
// flies backwards through a knot it invented.
//
// The curve still passes exactly through every topic. It is the route between
// them that bends, never the places themselves.

export interface Pt { x: number; y: number }

/** One leg of the flight: a cubic Bézier from (x0,y0) to (x3,y3). */
export interface Leg {
    x0: number; y0: number;
    /** First control handle. */
    x1: number; y1: number;
    /** Second control handle. */
    x2: number; y2: number;
    x3: number; y3: number;
}

/**
 * How long a control handle may be, as a share of the leg's own chord.
 *
 * Catmull-Rom sets a handle from the NEIGHBOURS' spacing, so a short hop
 * between two far-apart neighbours gets a handle far longer than the hop — and
 * a cubic whose handles outrun its chord loops. Half the chord is the usual
 * ceiling for a curve that has to stay recognisably "from here to there".
 */
export const MAX_HANDLE = 0.5;

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** Pull a handle back toward its anchor until it is no longer than the chord allows. */
function capHandle(anchor: Pt, handle: Pt, chord: number): Pt {
    const dx = handle.x - anchor.x, dy = handle.y - anchor.y;
    const len = Math.hypot(dx, dy);
    const max = chord * MAX_HANDLE;
    if (!(len > max) || len === 0) return handle;
    const k = max / len;
    return { x: anchor.x + dx * k, y: anchor.y + dy * k };
}

/**
 * The legs of the flight through these points, one per gap.
 *
 * Returns [] for fewer than two points — a journey of one finished topic is a
 * place, not a route, and the renderer draws it as a marker.
 */
export function flightPath(points: Pt[]): Leg[] {
    const n = points.length;
    if (n < 2) return [];
    const legs: Leg[] = [];
    for (let i = 0; i < n - 1; i++) {
        const p0 = points[i === 0 ? 0 : i - 1];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2 <= n - 1 ? i + 2 : n - 1];
        const chord = dist(p1, p2);
        // Centripetal parameterisation: the knot spacing is the square root of
        // the distance, which is what keeps a coincident pair from dividing by
        // zero in spirit as well as in arithmetic.
        const d1 = Math.sqrt(dist(p0, p1));
        const d2 = Math.sqrt(chord);
        const d3 = Math.sqrt(dist(p2, p3));
        // Barry–Goldman, with the degenerate cases answered by the straight
        // line rather than by a NaN: two points in the same place have no
        // direction to contribute, so the neighbour that does gets the say.
        let c1: Pt;
        if (d1 > 0 && d1 + d2 > 0) {
            const denom = 3 * d1 * (d1 + d2);
            c1 = {
                x: (d1 * d1 * p2.x - d2 * d2 * p0.x + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1.x) / denom,
                y: (d1 * d1 * p2.y - d2 * d2 * p0.y + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1.y) / denom,
            };
        } else {
            c1 = { x: p1.x + (p2.x - p1.x) / 3, y: p1.y + (p2.y - p1.y) / 3 };
        }
        let c2: Pt;
        if (d3 > 0 && d3 + d2 > 0) {
            const denom = 3 * d3 * (d3 + d2);
            c2 = {
                x: (d3 * d3 * p1.x - d2 * d2 * p3.x + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2.x) / denom,
                y: (d3 * d3 * p1.y - d2 * d2 * p3.y + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2.y) / denom,
            };
        } else {
            c2 = { x: p2.x + (p1.x - p2.x) / 3, y: p2.y + (p1.y - p2.y) / 3 };
        }
        const h1 = capHandle(p1, c1, chord);
        const h2 = capHandle(p2, c2, chord);
        legs.push({
            x0: p1.x, y0: p1.y, x1: h1.x, y1: h1.y,
            x2: h2.x, y2: h2.y, x3: p2.x, y3: p2.y,
        });
    }
    return legs;
}

/**
 * Where the flight is at `t` along one leg, and which way it is pointing.
 *
 * The heading is the curve's own derivative, which is the whole reason for the
 * curve: it turns continuously, so an arrow drawn along it banks into a corner
 * instead of snapping round it. Where the derivative vanishes (both handles
 * sitting on their anchors, which is what two coincident topics produce) the
 * chord answers instead, and a leg with no length at all reports 0 rather than
 * NaN.
 */
export function legAt(leg: Leg, t: number): { x: number; y: number; angle: number } {
    const u = 1 - t;
    const x = u * u * u * leg.x0 + 3 * u * u * t * leg.x1 + 3 * u * t * t * leg.x2 + t * t * t * leg.x3;
    const y = u * u * u * leg.y0 + 3 * u * u * t * leg.y1 + 3 * u * t * t * leg.y2 + t * t * t * leg.y3;
    let dx = 3 * u * u * (leg.x1 - leg.x0) + 6 * u * t * (leg.x2 - leg.x1) + 3 * t * t * (leg.x3 - leg.x2);
    let dy = 3 * u * u * (leg.y1 - leg.y0) + 6 * u * t * (leg.y2 - leg.y1) + 3 * t * t * (leg.y3 - leg.y2);
    if (Math.abs(dx) + Math.abs(dy) < 1e-9) { dx = leg.x3 - leg.x0; dy = leg.y3 - leg.y0; }
    const angle = Math.abs(dx) + Math.abs(dy) < 1e-9 ? 0 : Math.atan2(dy, dx);
    return { x, y, angle };
}

// ---- how long a step takes --------------------------------------------------
//
// One fixed beat for every step says every hop is the same journey, and on a
// real course they are nothing like it: two topics finished in the same bubble
// sit a few pixels apart, while "mechanics, then the language deck" crosses the
// whole library. At a fixed beat the near hop dawdles and the far one is a
// blur — the arrow's SPEED becomes the thing that varies, which is the one
// quantity a reader reads as distance.
//
// So the beat is bought by the distance, and the speed is what stays roughly
// put. Three things keep that from turning into a slideshow:
//
// **The ramp is the square root of the distance**, not the distance. Proportional
// timing gives constant speed, which is honest and unwatchable: this map's hops
// span more than two orders of magnitude, so the long ones would each take the
// best part of a minute. Under a square root a hop ten times longer takes about
// three times as long — still visibly further, still finite.
//
// **Both ends are clamped.** A step is never quicker than the eye can register
// as an arrival, and never longer than a viewer will sit through.
//
// **The distance is the DATA's, not the screen's.** Topic places are fixed
// world coordinates; what a hop measures on screen depends on the zoom, and a
// replay that ran faster because someone pinched out would be a clock that
// lies. It also keeps the page's step clock and the canvas's flight reading the
// same number — they both call this.

/**
 * The share of a step's beat spent FLYING; the rest is the landing — the arrow
 * at rest on the topic it has reached, which is when its name is legible and
 * when the eye gets to register an arrival as an event rather than as one frame
 * of a crawl.
 *
 * It lives here, beside the beat it divides, because the two halves are one
 * rule and the renderer is not the only reader: the page's clock hands the
 * canvas a leg every `stepDurationMs`, and the canvas has to cross it in
 * `stepDurationMs × FLIGHT_SHARE` for the landing to exist at all.
 */
export const FLIGHT_SHARE = 0.72;

/** A hop with no distance at all still gets a beat the eye can catch. */
export const STEP_MIN_MS = 320;
/** …and the longest hop in the library is still over in a second and a half. */
export const STEP_MAX_MS = 1200;
/** The world distance that counts as "across the library" — the ramp's top. */
const STEP_FAR = 1.4;

/**
 * How long the last arrival is held before the map pulls back to the whole
 * path — long enough to read the name it landed on, short enough that the
 * ending reads as an ending rather than as the replay having stalled.
 *
 * Here rather than on the page for the reason every other beat is here: it is
 * part of the replay's timing, both surfaces end the same way, and the camera
 * harness has to be able to play the ending exactly as the page plays it.
 */
export const END_HOLD_MS = 900;

/**
 * How long the flight into `step` should take, in ms.
 *
 * `step` counts topics REACHED, the same integer the panel prints and
 * `journeyStep` holds: step 2 is the flight from the first topic to the second.
 * A step with no leg behind it (the first topic, or an id the map cannot place)
 * is an appearance rather than a flight and gets the floor.
 */
function baseBeatMs(trace: CourseTrace, step: number): number {
    const from = trace.points.get(trace.journey[step - 2]);
    const to = trace.points.get(trace.journey[step - 1]);
    if (!from || !to) return STEP_MIN_MS;
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    const ramp = Math.min(1, Math.sqrt(d / STEP_FAR));
    return STEP_MIN_MS + (STEP_MAX_MS - STEP_MIN_MS) * ramp;
}

/**
 * The reader's two dials on the replay, and the only two the timing above
 * accepts from outside.
 *
 * They are separate numbers because they answer separate complaints. `speed`
 * scales the whole beat — a course of 400 topics is six minutes at the built-in
 * pace and nobody watches six minutes — while `holdMs` buys time AT an arrival
 * and nowhere else, which is what someone reading the topic names actually
 * wants. Tied together (one "slower" dial) a reader who wants to read the names
 * also gets an arrow crawling between them, which is the boring half.
 *
 * `speed` is a multiplier so that ×1 is the built-in pace exactly: everything
 * below divides by it, and at the default the arithmetic is the arithmetic that
 * was measured. `holdMs` is ADDED to the landing, so ×1 with no hold is a
 * no-op by construction rather than by luck. Guard: `atlas-gates.mjs`.
 */
export interface ReplayPace {
    /** ×1 is the built-in beat; ×2 is twice as quick. */
    speed: number;
    /** Extra milliseconds standing on each topic, beyond the built-in landing. */
    holdMs: number;
}

export const DEFAULT_PACE: ReplayPace = { speed: 1, holdMs: 0 };
/**
 * The ends of the speed dial — and they are enforced HERE rather than only in
 * the panel, because a stored setting from another build is not a control this
 * code can see. A zero or a NaN divides the beat into an arrow that never
 * arrives, which reads as the replay having hung.
 */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
/** …and of the dwell. Four seconds a topic is already a slideshow. */
export const HOLD_MAX_MS = 4000;

const paceSpeed = (pace: ReplayPace) =>
    (Number.isFinite(pace?.speed) ? Math.max(SPEED_MIN, Math.min(SPEED_MAX, pace.speed)) : 1);
const paceHold = (pace: ReplayPace) =>
    (Number.isFinite(pace?.holdMs) ? Math.max(0, Math.min(HOLD_MAX_MS, pace.holdMs)) : 0);

/**
 * How long the flight into `step` should take, in ms.
 *
 * `step` counts topics REACHED, the same integer the panel prints and
 * `journeyStep` holds: step 2 is the flight from the first topic to the second.
 * A step with no leg behind it (the first topic, or an id the map cannot place)
 * is an appearance rather than a flight and gets the floor.
 *
 * This is the WHOLE beat — the flight plus the landing after it — which is what
 * the page's clock waits and what the panel's bar is drawn against.
 */
export function stepDurationMs(
    trace: CourseTrace, step: number, pace: ReplayPace = DEFAULT_PACE,
): number {
    return baseBeatMs(trace, step) / paceSpeed(pace) + paceHold(pace);
}

/** The flying half of that beat: what the arrow has to cross the leg in. */
export function flightMs(
    trace: CourseTrace, step: number, pace: ReplayPace = DEFAULT_PACE,
): number {
    return (baseBeatMs(trace, step) * FLIGHT_SHARE) / paceSpeed(pace);
}

/**
 * …as a share of the beat, which is what the camera's eye runs on.
 *
 * `FLIGHT_SHARE` is that share only while the reader has added no dwell: the
 * hold lengthens the landing and nothing else, so the share falls as it grows.
 * One function rather than the constant at every call site, because the two
 * surfaces and the page all have to agree about where in the beat the arrow is.
 */
export function flightShare(
    trace: CourseTrace, step: number, pace: ReplayPace = DEFAULT_PACE,
): number {
    return flightMs(trace, step, pace) / stepDurationMs(trace, step, pace);
}

/**
 * How many pieces a leg is chopped into to measure its length. Sixteen is
 * plenty for a curve whose handles cannot outrun its chord, and it is a per-leg
 * cost paid once a frame.
 */
export const ARC_STEPS = 16;

/**
 * The curve parameter at which this leg is `u` of its LENGTH along — the whole
 * difference between an arrow that flies and one that lurches.
 *
 * A cubic is not traversed at a constant speed by its own parameter: at a fixed
 * `t` per millisecond, a leg of this map's real journeys moves between 1.8 and
 * **6.9 times** faster in the middle than at its ends (measured over the shapes
 * a real course produces — a tight cluster, a long hop, a corner, a coincident
 * pair). What that looks like is an arrow that sits still for the first part of
 * its beat and then bolts, which is exactly the "it starts moving already
 * halfway" a reader reports — the fault is not in the timing, it is that
 * distance and time were never the same axis.
 *
 * So the flight is parameterised by ARC LENGTH: chop the curve up, add the
 * pieces, and invert the table linearly. Equal milliseconds then buy equal
 * millimetres.
 */
export function legParam(leg: Leg, u: number): number {
    if (!(u > 0)) return 0;
    if (u >= 1) return 1;
    const lens: number[] = [0];
    let total = 0;
    let prev = legAt(leg, 0);
    for (let i = 1; i <= ARC_STEPS; i++) {
        const p = legAt(leg, i / ARC_STEPS);
        total += Math.hypot(p.x - prev.x, p.y - prev.y);
        lens.push(total);
        prev = p;
    }
    // A leg with no length at all — two topics in one bubble, zoomed out — has
    // no distance to divide by, and its parameter is as good an answer as any.
    if (!(total > 0)) return u;
    const want = u * total;
    for (let i = 1; i <= ARC_STEPS; i++) {
        if (lens[i] < want) continue;
        const span = lens[i] - lens[i - 1];
        const within = span > 0 ? (want - lens[i - 1]) / span : 0;
        return (i - 1 + within) / ARC_STEPS;
    }
    return 1;
}

/**
 * The first `t` of a leg, as its own leg — de Casteljau, so the part already
 * flown is the SAME curve the whole leg would have drawn rather than a
 * straight-line approximation catching up to it.
 */
export function legUpTo(leg: Leg, t: number): Leg {
    const mid = (a: number, b: number) => a + (b - a) * t;
    const ax = mid(leg.x0, leg.x1), ay = mid(leg.y0, leg.y1);
    const bx = mid(leg.x1, leg.x2), by = mid(leg.y1, leg.y2);
    const cx = mid(leg.x2, leg.x3), cy = mid(leg.y2, leg.y3);
    const dx = mid(ax, bx), dy = mid(ay, by);
    const ex = mid(bx, cx), ey = mid(by, cy);
    return {
        x0: leg.x0, y0: leg.y0, x1: ax, y1: ay,
        x2: dx, y2: dy, x3: mid(dx, ex), y3: mid(dy, ey),
    };
}

// ---- the flight, integrated --------------------------------------------------
//
// Where the arrow IS, as a float, given where the data says it should be and
// how long the last frame took.
//
// This lives here rather than in a renderer because there are two renderers.
// The atlas has two surfaces — the sheet and the planet — and a replay has to
// mean the same thing on both: the same beat, the same share of it spent
// flying, the same rule for what counts as travel and what counts as a cut. Two
// copies of that arithmetic would be two clocks, and the first bug would be a
// course that replays at a different speed depending on which way you happen to
// be looking at the library.
//
// It is also the half of a replay that has no picture in it. What is drawn
// between two topics is entirely the surface's business — a Bézier on the plane,
// a great circle on the sphere — but WHEN the arrow is between them is a number,
// and a number can be asserted (`tools/atlas-gates.mjs`).

/** The mutable state one replay carries between frames. */
export interface Flight {
    /** Steps reached, as a float: 3.4 is 40% of the way from the third to the fourth. */
    at: number;
    /** The step the data asked for last frame — how a walk is told from a jump. */
    target: number | null;
    /** How long the arrow has been standing still on the topic it reached, in ms. */
    rest: number;
    /**
     * The last CUT, while it is still being shown: where the arrow was before it
     * was put somewhere else, and how long ago. A restart takes a finished path
     * back to step one in a single frame, and without this the whole route and
     * the marker at its end vanished on that frame — so the surfaces fade what
     * was there out over `CUT_FADE_MS` instead.
     */
    cut: { from: number; ms: number } | null;
    /** The project this flight belongs to: a different course is never a cut. */
    course: number | null;
}

export const newFlight = (): Flight => ({ at: 0, target: null, rest: 0, cut: null, course: null });

/**
 * How long a cut's old picture takes to fade — long enough to read as the path
 * being put away rather than blinking out, short enough that the first leg of
 * the new walk is not flown under a ghost of the last one.
 */
export const CUT_FADE_MS = 420;

/** Where the replay is this frame, and what it needs from the loop. */
export interface Flown {
    /** Topics reached — the integer the panel prints. */
    landed: number;
    /** How far into the leg out of `landed` the arrow has got, 0–1. */
    frac: number;
    /**
     * Where the CAMERA's eye is, which is not where the arrow is: it runs the
     * same journey at a constant one step per beat, flight and landing alike,
     * while the arrow covers its leg in `FLIGHT_SHARE` of the beat and then
     * waits. Two numbers on purpose — tied together, the camera accelerated
     * from nothing at every beat and stopped dead at every arrival.
     */
    eyeAt: number;
    /** True while the arrow is between two topics rather than standing on one. */
    inAir: boolean;
    /** True while it still has ground to cover — the loop must ask for another frame. */
    flying: boolean;
    /**
     * A cut still fading: where the arrow stood before it (in steps, like `at`)
     * and how far the fade has got, 0–1. Null when there is nothing to fade. The
     * loop must keep drawing while it is set.
     */
    cut: { from: number; p: number } | null;
}

/**
 * How many steps the data may advance between two frames and still count as a
 * STEP SEQUENCE the arrow should fly.
 *
 * The question this answers is "did the reader ask to travel, or to be
 * somewhere else?" — choosing a course, rewinding to the whole path, restarting
 * a finished replay are all somewhere-else, and flying one would send the arrow
 * racing across fifty topics nobody asked to watch. Answering by DISTANCE (a
 * target more than 1.5 steps from the arrow is a cut) confuses the two: a
 * browser that skips half a second of frames leaves the arrow far enough
 * behind to look exactly like a jump, so a stutter turns into the map cutting
 * straight from one topic to the next. Two missed beats is a
 * stall and flies; more than that, the reader has lost the thread anyway.
 */
const STEP_LOOKAHEAD = 2;

/**
 * Advance one replay by one frame, in place.
 *
 * `step` is what the page's clock says has been reached (null = the whole path,
 * which is the resting state). `frameMs` is how long the last frame took, ALREADY
 * zeroed by the caller if the gap was long enough to be the loop having been
 * idle — a paused replay, a backgrounded tab — because time that passed while
 * nothing was drawn is not time anything travelled through.
 *
 * Returns null when there is no course to fly, having reset the flight so the
 * next course starts from its own beginning rather than from wherever the last
 * one was left.
 */
export function advanceFlight(
    flight: Flight, trace: CourseTrace | null, step: number | null,
    frameMs: number, reduceMotion: boolean, pace: ReplayPace = DEFAULT_PACE,
): Flown | null {
    if (!trace) {
        flight.at = 0; flight.target = null; flight.rest = 0; flight.cut = null; flight.course = null;
        return null;
    }
    // Another course is a new flight, not a jump within this one: fading the
    // old course's route out over the new one would draw a shape that is not
    // either of them. Told apart by PROJECT, not by object — the atlas is
    // revalidated behind the drawn map and hands back a new trace object for the
    // same course, and treating that as a new course would put a replay in
    // flight straight onto its target.
    if (flight.course !== trace.projectId) {
        if (flight.course != null) { flight.target = null; flight.cut = null; }
        flight.course = trace.projectId;
    }
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const full = trace.journey.length;
    const want = step == null ? full : clamp(step, 0, full);
    // **A new leg starts at its own start.** A surface stops drawing once the
    // arrow has landed and the camera has settled, so the rest of the beat — the
    // landing, up to 28% of it — can pass with no frames at all. That gap used
    // to be charged to the first frame of the NEXT leg, which then jumped
    // `idle / (legMs × FLIGHT_SHARE)` of the way along it before anything was
    // drawn: measured on the real physics journey at up to 22px in a single
    // frame, on legs where the arrow should have moved one. It reads as the
    // arrow teleporting and then flying the rest.
    const elapsed = want === flight.target ? frameMs : 0;
    const walked = flight.target != null
        && want >= flight.target && want - flight.target <= STEP_LOOKAHEAD;
    const wasAt = flight.at;
    let flying = false;
    // A fade already running keeps its own clock, whether or not the arrow moves.
    if (flight.cut) {
        flight.cut.ms += frameMs;
        if (flight.cut.ms >= CUT_FADE_MS) flight.cut = null;
    }
    if (reduceMotion || want <= 1 || want < flight.at || !walked) {
        // Put somewhere else rather than flown there. Remembered so the old
        // picture can fade — but only once there WAS an old picture (a course
        // just picked has none), and never for a reader who asked for less
        // motion.
        if (flight.target != null && want !== flight.at && !reduceMotion) {
            flight.cut = { from: flight.at, ms: 0 };
        }
        flight.at = want;
    } else if (flight.at < want) {
        // The leg being flown right now buys its own time, from the same
        // function the page's step clock schedules on — a far hop is a longer
        // flight, not a faster arrow. Constant within the leg, so the speed
        // changes only where the reader expects it to: at an arrival.
        const legFly = flightMs(trace, Math.floor(flight.at) + 1, pace);
        // Behind by more than a whole step — a frame the browser never gave us,
        // a beat that started before the arrow had landed — and the arrow makes
        // the time up rather than letting the lag grow. Catching up is a speed a
        // reader reads as hurrying; letting it grow was what made the map go
        // "straight from one to another".
        const behind = Math.max(1, want - flight.at);
        flight.at = Math.min(want, flight.at + elapsed * (behind / legFly));
        if (flight.at < want) flying = true;
    }
    // The tail of the beat, which only the camera has any use for.
    //
    // Cleared when the arrow MOVES, not when the step changes. Clearing it on
    // the step is a frame early — the beat arrives, the arrow has not set off
    // yet, and the eye below falls back the 28% it had just gained and then
    // jumps forward again. It was the single roughest thing in the camera
    // trace: ~600 screen px per second of it, in one frame, at every arrival.
    if (flight.at > wasAt) flight.rest = 0;
    else flight.rest += frameMs;
    flight.target = want;

    const landed = clamp(Math.floor(flight.at), 0, full);
    const frac = clamp(flight.at - landed, 0, 1);
    const beatMs = stepDurationMs(trace, Math.max(1, want), pace);
    // The share the READER's pace makes of it, not the built-in constant: a
    // dwell lengthens the landing and leaves the flight alone, so the eye has
    // further to travel in the tail of the beat than `FLIGHT_SHARE` says.
    const share = flightShare(trace, Math.max(1, want), pace);
    const eyeAt = clamp(frac > 0
        ? landed + frac * share
        : landed - (1 - share) + Math.min(flight.rest / beatMs, 1 - share),
        1, full);
    const cut = flight.cut ? { from: flight.cut.from, p: clamp(flight.cut.ms / CUT_FADE_MS, 0, 1) } : null;
    return { landed, frac, eyeAt, inAir: frac > 0 && landed >= 1 && landed < full, flying, cut };
}

/**
 * How much of the head is ARROW rather than parked dot, 0–1, for an arrow `frac`
 * of the way along a leg it crosses in `legMs`.
 *
 * The head is a dot while it stands on a topic and an arrow while it flies, and
 * swapping one for the other on the frame it takes off or lands is a blink the
 * eye catches every single step. So the two cross over at each end of the leg,
 * in MILLISECONDS rather than as a share of it: a share makes a long hop's
 * change slow and a short hop's invisible. Capped at a third of the leg so a
 * short hop is still an arrow somewhere in the middle of it.
 */
export const HEAD_MORPH_MS = 220;
export function headMorph(frac: number, legMs: number): number {
    if (!(frac > 0) || !(frac < 1)) return 0;
    const span = Math.min(HEAD_MORPH_MS, Math.max(1, legMs) / 3);
    const x = Math.max(0, Math.min(1, Math.min(frac * legMs, (1 - frac) * legMs) / span));
    return x * x * (3 - 2 * x);
}

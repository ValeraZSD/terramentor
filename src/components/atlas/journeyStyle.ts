/**
 * The numbers the traced journey is drawn and flown by — ONE copy, read by both
 * surfaces.
 *
 * The sheet and the globe are two projections of one map, and a replay is the
 * same replay on either: the same ink, the same head marker, the same dimming of
 * everything the course does not reach, the same camera window and the same
 * ending. They were two hand-written copies with identical values and nothing
 * pinning them, which is a course that replays differently depending on which
 * way the reader happens to be looking at their library.
 *
 * What stays in each map is what genuinely differs: how a zoom is expressed (a
 * scale on a sheet, an angle on a sphere), how close "close" is, and everything
 * about geometry. Nothing here knows which surface it is on.
 *
 * `stepDurationMs` and `FLIGHT_SHARE` — WHEN the arrow is where — live in
 * `coursePaths.ts` beside the flight itself, and the camera's arm is in
 * `cameraSpring.ts`.
 */

/** A drag shorter than this is a click, not a pan or a turn. */
export const CLICK_SLOP = 5;

// ---- the walked line --------------------------------------------------------

/** The oldest step of the journey, and the newest. Age is drawn as presence. */
export const JOURNEY_MIN_ALPHA = 0.42;
export const JOURNEY_MIN_WIDTH = 2;
export const JOURNEY_MAX_WIDTH = 4.2;
/**
 * The walked path is stroked twice: once in the surface colour, wider, then the
 * ink over it. The same halo every label on this map wears, and for the same
 * reason — a dark line crossing a dark bubble and a pale one crossing pale paper
 * both disappear into what they cross, and this path runs over every bubble in
 * the library by design.
 */
export const JOURNEY_HALO_WIDTH = 3.2;
export const JOURNEY_HALO_ALPHA = 0.7;
/** A segment shorter than this on screen has no room for a direction mark. */
export const ARROW_MIN_LENGTH = 26;
export const ARROW_SIZE = 5.5;
/** The head, while it is flying: a filled arrow, on a soft accent glow. */
export const HEAD_ARROW_LENGTH = 21;
export const HEAD_ARROW_WIDTH = 15;
export const HEAD_GLOW_RADIUS = 19;

// ---- what the traced course does to everything else -------------------------

/** How far the rest of the library fades while one course is traced. */
export const TRACE_REGION_DIM = 0.28;
export const TRACE_TOPIC_DIM = 0.18;
/**
 * How solidly a TRACED course's own topics are drawn when the zoom says the
 * topic layer is not there yet.
 *
 * The journey runs between those places at every distance, so they are marked at
 * every distance — the ends of a line have to be somewhere. Not 1: zoomed right
 * out they are a handful of pinpricks inside their bubbles, and at full strength
 * they read as a second kind of region rather than as the places the line lands
 * on.
 */
export const TRACE_DOT_MIN = 0.85;

// ---- the camera's window on the journey -------------------------------------

/**
 * How many steps ahead the camera is already looking.
 *
 * It is what makes a pan run ACROSS legs rather than restarting at each one: at
 * 1 the camera knows only about the hop being flown and reframes for every
 * single one; much beyond 3 it is framing places the reader has no reason to be
 * looking at yet, and the zoom sits permanently further out than the journey
 * needs.
 */
export const LOOK_AHEAD = 3;
/**
 * …and how many the ZOOM holds. Longer than the pan's look-ahead, which is the
 * opposite of what it was.
 *
 * A camera trace says why (`tools/harness/cam-trace.mjs`, 24 steps of a real
 * journey). The legs of a course are not one size: on that journey they run from
 * 0.02 to 1.3 world units, two orders of magnitude, and they alternate — a hop
 * inside one bubble, then one across the library, then another short one. A zoom
 * that frames the leg being flown therefore tracks that alternation exactly: the
 * recorded trace changed direction 25 times in 18 seconds, ×1.7 to ×5 and back,
 * up to ×2.9 inside a single step. Nothing in it was wrong frame by frame, which
 * is why it survived being looked at; it is only visible as a line on a chart.
 *
 * Framing four steps with a fading weight means a long hop starts pulling the
 * camera out while it is still two steps away, and a short one does not pull it
 * back in — because the zoom is also held by the dead band below.
 */
export const FIT_AHEAD = 4;
/**
 * How far apart two zooms have to be before the camera moves at all — and it is
 * two numbers, because the two directions are not the same bet.
 *
 * The window's reach changes on every step; without a dead band the camera is
 * always correcting, which is the difference between holding a shot and
 * breathing. And the band has to be WIDER on the way in: pulling out is the safe
 * direction (more of the journey on screen, never less), while going in is a bet
 * that the next few steps stay small, and a bet lost is the camera coming
 * straight back out. Measured with one symmetric band of ×1.2: nine reversals,
 * of which five were ×1.05 to ×1.14 — a need that sat right on the edge of the
 * band, crossing it, twice a second, for no gain.
 */
export const ZOOM_DEAD_OUT = 1.15;
export const ZOOM_DEAD_IN = 1.5;
/**
 * The two arms the ZOOM hangs on, which are not one number for the same reason
 * its target is not one number: pulling out is forced by the journey and going
 * back in never is. 1.6 is about two and a half seconds of travel — a course
 * that comes back out again before then never makes the trip at all.
 *
 * The asymmetry is a property of the SPRING, not a filter in front of it.
 * Handing the camera a new zoom outright, which is what this was before the
 * spring, put 7.6% of the zoom range into a single frame at every long hop.
 */
export const ZOOM_OUT_OMEGA = 4.5;
export const ZOOM_IN_OMEGA = 1.6;
/**
 * …and the two the ENDING hangs on, which is the softest arm on this map.
 *
 * Every other move here has a reason to be over: a fly-to is a destination, the
 * follow arm is chasing something that keeps moving, the zoom's rescue is a
 * rescue. The ending is the opposite — nothing is waiting on it, the reader has
 * just watched the whole walk, and the only thing left to say is "and this is
 * where all of that was". At a fly-to's stiffness that sentence took a fifth of
 * a second; this is a second and a half.
 *
 * The zoom is the STIFFER of the two on purpose, which is the whole shape of the
 * move: a pan costs screen pixels in proportion to the zoom it is made at, so
 * widening slightly ahead of the slide carries the picture out along a curve
 * instead of dragging it across the library at the zoom the journey ended on.
 */
export const END_OMEGA = 2.1;
export const END_ZOOM_OMEGA = 2.8;
/**
 * A gap between frames longer than this is the loop having been idle, not a slow
 * frame: nothing may travel through it.
 */
export const IDLE_GAP_MS = 250;

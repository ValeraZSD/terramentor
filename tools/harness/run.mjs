// Headless verification of the atlas map: mounts the REAL component against
// the REAL atlas payload from the project database, with a recording 2-D
// context, and drives real DOM events. Proves behaviour, never pixels.
import { prepareAtlasLibrary } from './atlasFixture.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// jsdom lives in the session scratchpad, not in the project — this harness must
// not add a dependency to the repo just to look at a canvas.
// jsdom is a devDependency, so a plain clone can run this. HARNESS_MODULES stays
// supported for an out-of-tree scratch install (how this ran before it shipped).
const SCRATCH = process.env.HARNESS_MODULES;
const jsdomSpecifier = SCRATCH ? SCRATCH + '/jsdom' : 'jsdom';
const { JSDOM } = require(jsdomSpecifier);

// Decide WHICH library before importing anything under server/ — `database.js`
// opens its connection at import, so the choice cannot be made afterwards.
const library = await prepareAtlasLibrary();
const { buildAtlas } = await import('../../server/atlas.js');

const atlas = await buildAtlas({ refresh: true });
if (!atlas.available) {
    // On a fixture this is only reachable when the build has no sqlite-vec, in
    // which case the atlas is *designed* to be unavailable and there is nothing
    // to draw — a supported build, not a failure.
    const fatal = library.mode === 'real' || library.vecAvailable;
    console.log(`atlas unavailable (${library.mode} library):`, atlas.reason);
    await library.cleanup();
    process.exit(fatal ? 1 : 0);
}
console.log(`atlas built from the ${library.mode} library: ` +
    `${atlas.stats.mapped} topics, ${atlas.regions.length} regions`);

const dom = new JSDOM('<!doctype html><html><body><div id="root" style="width:900px;height:600px"></div></body></html>', {
    pretendToBeVisual: true, url: 'http://localhost/',
});
const { window } = dom;

// --- recording canvas context ------------------------------------------------
// `segs` is how the paths layer is seen at all: the route a learner walked and the
// journey through them are the only things on this canvas drawn with
// moveTo/lineTo, so a recorded segment can have come from nowhere else. The
// bubbles and the dots are arcs, the grid is fillRect, and the direction marks
// are FILLED — none of them reach `stroke()` with a line path, so none of them
// can be mistaken for a path.
const rec = { arcs: [], texts: [], segs: [], rects: 0, calls: 0 };
const ctxState = { globalAlpha: 1, lineWidth: 1 };
let pathPts = [];
// The transform is tracked rather than ignored, because the replay's arrow is
// drawn in its OWN space — translated to where it is and rotated to where it is
// going. Dropping the transform recorded that arrow as a handful of lines
// around the origin, which is both a false record of the arrow and three stray
// segments in every assertion about where the path runs.
let tf = { x: 0, y: 0, cos: 1, sin: 0, k: 1 };
const tfStack = [];
const map = (x, y) => ({
    x: tf.x + (x * tf.cos - y * tf.sin) * tf.k,
    y: tf.y + (x * tf.sin + y * tf.cos) * tf.k,
});
const ctx = new Proxy({
    canvas: null, globalAlpha: 1, font: '', textAlign: '', lineJoin: '', lineCap: '', lineWidth: 1,
    fillStyle: '', strokeStyle: '',
    setTransform() { tf = { x: 0, y: 0, cos: 1, sin: 0, k: 1 }; }, fillRect() { rec.rects++; }, clearRect() { },
    beginPath() { this._path = {}; pathPts = []; },
    arc(x, y, r) { const p = map(x, y); rec.arcs.push({ x: p.x, y: p.y, r, a: ctxState.globalAlpha }); },
    moveTo(x, y) { pathPts.push({ ...map(x, y), move: true }); },
    lineTo(x, y) { pathPts.push({ ...map(x, y), move: false }); },
    // A curve is recorded as ONE segment, from where it starts to where it
    // ends, with its handles beside it. The journey is drawn as curves now, and
    // sampling them into a polyline would report a dozen "segments" whose ends
    // are nowhere in particular — which is exactly what the assertions below
    // are asking about.
    bezierCurveTo(cx1, cy1, cx2, cy2, x, y) {
        const h1 = map(cx1, cy1), h2 = map(cx2, cy2);
        pathPts.push({ ...map(x, y), move: false, curve: { h1, h2 } });
    },
    createRadialGradient() { return { addColorStop() { } }; },
    closePath() { },
    // The planet draws with calls the sheet never makes — an ellipse for every
    // cap, a clip for the body — and this recorder is a written list rather
    // than a Proxy that swallows anything, so they have to be here or the
    // globe's own frame throws. Recorded as arcs at their mean radius: what the
    // assertions ask of a cap is where it is and how big, and nothing here
    // measures its foreshortening.
    ellipse(x, y, rx, ry) {
        const p = map(x, y);
        rec.arcs.push({ x: p.x, y: p.y, r: Math.sqrt(Math.abs(rx * ry)), a: ctxState.globalAlpha });
    },
    clip() { },
    rect() { },
    setLineDash() { },
    createLinearGradient() { return { addColorStop() { } }; },
    // The fill is attached to the arc AFTER the fact, because the map sets
    // `fillStyle` between `arc()` and `fill()` — reading it at arc time records
    // whatever the previous shape was painted in.
    fill() {
        const last = rec.arcs[rec.arcs.length - 1];
        if (last && last.f === undefined) last.f = this.fillStyle;
    },
    stroke() {
        for (let i = 1; i < pathPts.length; i++) {
            if (pathPts[i].move) continue;
            rec.segs.push({
                x1: pathPts[i - 1].x, y1: pathPts[i - 1].y,
                x2: pathPts[i].x, y2: pathPts[i].y,
                a: ctxState.globalAlpha, w: ctxState.lineWidth,
                // Which layer this stroke belongs to. The journey is painted
                // twice — a halo in the paper's own colour, then the ink over
                // it — so "the heaviest stroke" is a question about the ink.
                s: this.strokeStyle,
                curve: pathPts[i].curve || null,
            });
        }
    },
    measureText(t) { return { width: t.length * 6.2 }; },
    strokeText() { },
    // The SIZE is recorded with the text, not assumed: region names are sized
    // from their bubble now, so a box model that guesses 12px reports a label
    // as overlapping itself the moment it wraps at 9px.
    // The ALPHA is recorded too: a label that arrives at full strength and one
    // that fades in are the same pixels a quarter of a second later, and only
    // this tells them apart.
    fillText(t, x, y) {
        rec.texts.push({
            t, x, y, a: ctxState.globalAlpha,
            size: Number((/(\d+(?:\.\d+)?)px/.exec(this.font) || [])[1]) || 12,
        });
    },
    save() { tfStack.push({ ...tf }); },
    restore() { if (tfStack.length) tf = tfStack.pop(); },
    translate(x, y) { const p = map(x, y); tf = { ...tf, x: p.x, y: p.y }; },
    rotate(a) {
        const cos = Math.cos(a), sin = Math.sin(a);
        tf = { ...tf, cos: tf.cos * cos - tf.sin * sin, sin: tf.sin * cos + tf.cos * sin };
    },
    scale(k) { tf = { ...tf, k: tf.k * k }; },
}, {
    get(t, k) { rec.calls++; return t[k]; },
    set(t, k, v) {
        t[k] = v;
        if (k === 'globalAlpha') ctxState.globalAlpha = v;
        if (k === 'lineWidth') ctxState.lineWidth = v;
        return true;
    },
});

window.HTMLCanvasElement.prototype.getContext = () => ctx;
window.devicePixelRatio = 1;
// jsdom reports every element as 0×0; the map sizes itself from the wrapper.
window.Element.prototype.getBoundingClientRect = function () {
    const w = this.tagName === 'CANVAS' || this.id === 'root' || this.dataset?.wrap !== undefined ? 900 : 900;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: 600, width: w, height: 600, toJSON() { } };
};
window.ResizeObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() { this.cb([]); }
    disconnect() { }
};
let rafQueue = [];
/** How far this harness has pushed the clock past the real one. */
let clockOffset = 0;
window.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
window.cancelAnimationFrame = () => { };
/**
 * Run `n` animation frames, each a frame's worth of TIME apart.
 *
 * The clock matters here now: the component eases its camera and flies its
 * arrow by the milliseconds between frames rather than by a fixed share per
 * frame — a fixed share means a 30fps phone and a 144Hz screen move the camera
 * at different speeds, which is half of what "laggy" was. A `flush` that ran
 * sixty callbacks inside one real millisecond therefore moved NOTHING, and a
 * fly-to that never converged left the map wherever it started.
 */
const FRAME = 1000 / 60;
const tick = (ms) => {
    clockOffset += ms;
    const q = rafQueue; rafQueue = [];
    q.forEach(cb => cb(performance.now()));
};
const flush = (n = 6) => {
    const run = () => { for (let i = 0; i < n; i++) tick(FRAME); };
    if (globalThis.__act) globalThis.__act(run); else run();
};
window.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });

// A clock this harness can push forward.
//
// The replay's arrow flies through TIME: the component eases its drawn position
// toward the step it has been given, at so many steps per second. A frame loop
// driven by `flush()` runs every queued callback in a few real milliseconds, so
// on the real clock a replay never moves at all and every assertion about it
// would be asserting the first instant of a flight. The offset is added to the
// real clock rather than replacing it, so React's own scheduler still sees time
// moving forward the way it expects.
const realNow = performance.now.bind(performance);
performance.now = () => realNow() + clockOffset;
/**
 * Move the clock on, in frame-sized pieces, drawing each one.
 *
 * Not in a single jump: the component treats a long gap between frames as the
 * loop having been idle (a paused tab, a course only just chosen) and pointedly
 * does NOT fly through the time that passed while nothing was drawn. Jumping
 * the clock 300ms therefore moves the arrow nowhere, which would make every
 * assertion below pass for the wrong reason.
 */
/**
  * Let time pass with NOTHING drawn — which is what the end of every beat is,
  * once the arrow has landed and the camera has settled and the loop has
  * stopped asking for frames.
  */
const idle = (ms) => { clockOffset += ms; };
const advance = (ms, chunk = 50) => {
    const run = () => {
        for (let left = ms; left > 0; left -= chunk) tick(Math.min(chunk, left));
    };
    if (globalThis.__act) globalThis.__act(run); else run();
};

for (const k of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MouseEvent',
    'KeyboardEvent', 'Event', 'CustomEvent', 'HTMLCanvasElement', 'ResizeObserver',
    'requestAnimationFrame', 'cancelAnimationFrame', 'devicePixelRatio', 'matchMedia', 'getComputedStyle']) {
    Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class PointerEventPolyfill extends window.MouseEvent {
    constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
}
globalThis.PointerEvent = window.PointerEvent = PointerEventPolyfill;
window.HTMLElement.prototype.setPointerCapture = function () { };
window.HTMLElement.prototype.releasePointerCapture = function () { };

// Rebuild the bundle every run. A checked-in bundle is a trap: edit the
// component, forget the build step, and the harness cheerfully verifies the
// previous version.
const here = fileURLToPath(new URL('.', import.meta.url));
require('esbuild').buildSync({
    entryPoints: [join(here, 'entry.tsx')],
    outfile: join(here, 'bundle.cjs'),
    bundle: true, format: 'cjs', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'error',
});
require('./bundle.cjs');

// One hue per course for the whole library, made the way `AtlasView` makes it and
// handed to both surfaces — the separation pass sorts every project on the map,
// so a second copy would be a second answer.
const courseHueMap = globalThis.__courseHues(
    atlas.regions.flatMap(r => r.projects.map(p => ({ id: p.id, color: p.color }))));

// --- mount -------------------------------------------------------------------
const selections = [];
const opened = [];
let fsToggles = 0;
const el = window.document.getElementById('root');
const handle = globalThis.__mountAtlas(el, {
    regions: atlas.regions,
    selectedId: null,
    onSelect: (id) => selections.push(id),
    onOpenTopic: (t) => opened.push(t.id),
    matches: null,
    dark: true,
    trace: null,
    journeyStep: null,
    colorMode: 'mastery',
    hues: courseHueMap,
    fullscreen: false,
    onToggleFullscreen: () => { fsToggles++; },
});
flush(10);
await new Promise(r => setTimeout(r, 60));
flush(10);

const canvas = window.document.querySelector('canvas');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const snapshot = () => ({ arcs: rec.arcs.slice(), texts: rec.texts.slice(), segs: rec.segs.slice() });
const reset = () => { rec.arcs.length = 0; rec.texts.length = 0; rec.segs.length = 0; };

const pointer = (type, x, y, extra = {}) => globalThis.__act(() => canvas.dispatchEvent(
    new PointerEventPolyfill(type, { clientX: x, clientY: y, bubbles: true, ...extra })));
const wheel = (dy, x, y) => {
    const e = new window.Event('wheel', { bubbles: true, cancelable: true });
    Object.assign(e, { deltaY: dy, deltaMode: 0, clientX: x, clientY: y });
    globalThis.__act(() => canvas.dispatchEvent(e));
};

console.log(`\n--- the map draws (${atlas.regions.length} regions, ${atlas.stats.mapped} topics) ---`);
check('the canvas mounted', !!canvas);
const first = snapshot();
// Against the region count, not a magic number: "more than ten circles" was a
// threshold borrowed from one large library, and it fails on a small one for
// being small rather than for being wrong. Every region is a circle; that is
// the invariant.
check('regions are drawn as circles', first.arcs.length >= atlas.regions.length,
    `${first.arcs.length} arcs for ${atlas.regions.length} regions`);
check('region names are drawn', first.texts.length > 3, `${first.texts.length} labels`);
check('no label is drawn on top of another', (() => {
    // Re-derive the collision test from the drawn output: no two label boxes
    // may overlap. This is the whole reason the old map was unreadable.
    // The box height is the LINE height (0.85 + 0.31 = 1.16 x size), not a
    // guess around the baseline: a region name that wraps to two lines inside
    // its bubble is two fillText calls one line apart, and a taller box makes
    // a label overlap itself and reports a collision that is not there.
    const boxes = first.texts.map(t => ({
        x0: t.x - (t.t.length * 6.2) / 2 - 3, x1: t.x + (t.t.length * 6.2) / 2 + 3,
        y0: t.y - t.size * 0.85, y1: t.y + t.size * 0.31,
    }));
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            // EPS, because the two lines of one wrapped name abut EXACTLY —
            // the second baseline is one line-height below the first — and in
            // floating point "exactly" lands either side of the boundary at
            // random. A tenth of a pixel of contact is not an overlap.
            const EPS = 0.5;
            if (a.x0 < b.x1 - EPS && a.x1 > b.x0 + EPS && a.y0 < b.y1 - EPS && a.y1 > b.y0 + EPS) {
                if (process.env.DBG) console.log('   overlap:', JSON.stringify(first.texts[i]), JSON.stringify(first.texts[j]));
                return false;
            }
        }
    }
    return true;
})());
check('every drawn label is inside the frame',
    first.texts.every(t => t.x > -200 && t.x < 1100 && t.y > -60 && t.y < 660));

console.log('\n--- it moves ---');
reset();
pointer('pointerdown', 450, 300);
pointer('pointermove', 250, 200);
pointer('pointerup', 250, 200);
flush(4);
const panned = snapshot();
const movedBy = (() => {
    const a = first.arcs[0], b = panned.arcs[0];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
})();
check('dragging pans the map', movedBy > 100, `moved ${movedBy.toFixed(0)}px`);
check('a drag does NOT select anything (it is a pan, not a click)', selections.length === 0,
    JSON.stringify(selections));

console.log('\n--- it zooms ---');
reset();
const beforeZoom = panned.arcs[0];
wheel(-600, 450, 300);
flush(4);
const zoomed = snapshot();
const grew = zoomed.arcs.length && beforeZoom
    ? Math.max(...zoomed.arcs.map(a => a.r)) > Math.max(...panned.arcs.map(a => a.r))
    : false;
check('the wheel zooms in', grew,
    `${Math.max(...panned.arcs.map(a => a.r)).toFixed(1)} → ${Math.max(...zoomed.arcs.map(a => a.r)).toFixed(1)}`);

// Fly to a real region and zoom in far enough that its topics must appear.
const biggest = [...atlas.regions].sort((a, b) => b.size - a.size)[0];
globalThis.__act(() => handle.ref.current.flyTo(biggest.id));
flush(80);
// One clean frame at the settled camera: the draw loop only re-queues itself
// while a fly-to is in flight, so after it lands nothing is pending.
reset();
pointer('pointermove', 1, 1);
flush(3);
const deep = snapshot();
check('zooming into a region reveals its individual topics',
    deep.arcs.length >= biggest.size,
    `${biggest.label} holds ${biggest.size} topics; ${deep.arcs.length} marks drawn`);
check('topic names appear once the dots are big enough to name',
    deep.texts.some(t => biggest.topics.some(tp => tp.title.startsWith(t.t.replace(/…$/, '')))),
    `${deep.texts.length} labels: ${deep.texts.slice(0, 3).map(t => t.t).join(' | ')}`);
check('every topic is packed INSIDE its own region',
    atlas.regions.every(r => r.topics.every(t =>
        Math.hypot(t.x - r.x, t.y - r.y) <= r.radius + 1e-6)));

// ---- a hover asks about ONE layer ---------------------------------------
//
// Reported from the map (2026-09-15, "do not show that note popup thingy on the
// top of the parent node on hover, interferes a lot when moving across the
// node"): zoomed in among a region's topics, the pointer spends half its time
// between dots, and every one of those in-between frames answered with the
// REGION's card — a panel over the topics, appearing and vanishing at
// dot → gap → dot. The bubble down there is scenery; the topics are the layer.
//
// Read off the DOM rather than the canvas, because the card IS the DOM: the
// only text in this mount is whatever the card is showing.
console.log('\n--- a hover asks about the layer the reader is in ---');
{
    // What the card is answering ABOUT, not what it says: `region`, `topic`, or
    // nothing at all. The text would work too and would be asserting the copy.
    const card = () => el.querySelector('[data-testid="atlas-card"]')?.dataset.kind ?? 'none';
    // A dot is anything the fly-to left inside the frame that is not the
    // region's own bubble. Sized RELATIVE to that bubble rather than in pixels:
    // how big a topic is drawn depends on how many of them share the region, so
    // a hardcoded ceiling reads the author's 1,885-topic library and nothing
    // else — on the fixture the same dots come out at r=14.14 and an `r < 14`
    // filter found none of them.
    const bubble = deep.arcs.reduce((a, b) => (b.r > a.r ? b : a), deep.arcs[0]);
    const dots = deep.arcs
        .filter(a => a.r > 1 && a.r < bubble.r / 2 && a.x > 20 && a.x < 880 && a.y > 20 && a.y < 580)
        .sort((a, b) => a.r - b.r);
    check('there are topic dots to point at', dots.length > 3 && bubble.r > 60,
        `${dots.length} dots, biggest arc r=${bubble.r?.toFixed(0)}`);
    // Somewhere inside the bubble that is NOT a dot: the ground the pointer
    // crosses. Taken from the drawn frame, so it is a real gap in the real
    // picture rather than a place the harness believes is empty.
    const gap = (() => {
        for (let ring = 0.35; ring <= 0.8; ring += 0.15) {
            for (let a = 0; a < 360; a += 11) {
                const x = bubble.x + Math.cos(a * Math.PI / 180) * bubble.r * ring;
                const y = bubble.y + Math.sin(a * Math.PI / 180) * bubble.r * ring;
                if (x < 20 || x > 880 || y < 20 || y > 580) continue;
                if (dots.every(d => Math.hypot(d.x - x, d.y - y) > 26)) return { x, y };
            }
        }
        return null;
    })();
    pointer('pointermove', dots[0].x, dots[0].y);
    flush(3);
    check('hovering a topic still opens its card', card() === 'topic', `card is ${card()}`);
    if (gap) {
        pointer('pointermove', gap.x, gap.y);
        flush(3);
        check('hovering the ground between two topics opens nothing',
            card() === 'none', `card is ${card()}`);
    } else {
        check('a gap between the dots was findable', false);
    }
    // …and zoomed out, where the bubbles ARE the layer, the region's card is
    // exactly what a hover should give.
    globalThis.__act(() => handle.ref.current.fit());
    flush(80);
    reset();
    pointer('pointermove', 1, 1);
    flush(3);
    const out = snapshot();
    const wide = out.arcs.reduce((a, b) => (b.r > a.r ? b : a), out.arcs[0]);
    pointer('pointermove', wide.x, wide.y);
    flush(3);
    check('zoomed out, hovering a region opens its card', card() === 'region',
        `card is ${card()}`);
    pointer('pointermove', 1, 1);
    flush(3);
}

console.log('\n--- topic names arrive by fading, never in one frame ---');
// Reported from a phone: "the main blobs' names fade out slow, nice — the small
// blobs' text appears in an instant, wrong". It did: the names rode a zoom ramp,
// but they were gated on a hard 4.5px dot threshold, so every name in a region
// switched on together the moment the dots crossed it — and on a narrow screen
// that crossing happens after the opacity ramp is already at the top.
//
// Zoom in one jump (a wheel notch is instant, exactly like a pinch), then walk
// the frames: the names must climb, not appear.
globalThis.__act(() => handle.ref.current.fit());
flush(80);
const isTopicName = (t) => atlas.regions.some(r => r.topics.some(
    tp => tp.title.startsWith(t.t.replace(/…$/, '')) && t.t.length > 3));
const nameAlphas = () => snapshot().texts.filter(isTopicName).map(t => t.a);

// Zoom AT a bubble, not at the middle of the canvas. The map's centre after a
// fit is whatever the layout put at the world origin, and on a real library
// that is usually the gap between regions: the old `wheel(-4000, 450, 300)`
// asked for a 121x jump (clamped to MAX_K) into empty space inside one bubble,
// where 1 arc is drawn, no topic dot is on screen and no name CAN appear. It
// was asserting the renderer draws names in a place there is nothing to name.
//
// Where the bubbles are is read from the renderer's own output rather than by
// recomputing its projection here — a second copy of `toScreen` in the harness
// is exactly the kind of mirror that drifts.
reset();
pointer('pointermove', 1, 1);
flush(3);
const fitted = snapshot();
const bubble = fitted.arcs.reduce((a, b) => (b.r > a.r ? b : a), fitted.arcs[0] || { x: 450, y: 300, r: 0 });
check('the fitted map draws its bubbles', fitted.arcs.length > 0 && bubble.r > 0,
    `${fitted.arcs.length} arcs`);

reset();
// One notch, sized to land in the middle of the name ramp (k≈4: past
// TOPIC_FADE_FULL, nowhere near the 30x ceiling) — instant, exactly like a
// pinch, which is the state the fade has to survive.
wheel(-Math.log(4) / 0.0012, bubble.x, bubble.y);
const arrival = [];
for (let i = 0; i < 14; i++) {
    reset();
    flush(1);
    const alphas = nameAlphas();
    arrival.push(alphas.length ? Math.max(...alphas) : 0);
}
const firstDrawn = arrival.findIndex(a => a > 0);
const settled = Math.max(...arrival);
check('the names do turn up', firstDrawn >= 0 && settled > 0.5,
    `frames: ${arrival.map(a => a.toFixed(2)).join(' ')}`);
check('the first frame that shows one shows it FAINT, not finished',
    firstDrawn >= 0 && arrival[firstDrawn] < settled * 0.5,
    `first ${arrival[firstDrawn]?.toFixed(2)} vs settled ${settled.toFixed(2)}`);
check('and it climbs over several frames',
    arrival.filter((a, i) => i > 0 && a > arrival[i - 1] + 0.01).length >= 3,
    `frames: ${arrival.map(a => a.toFixed(2)).join(' ')}`);
check('the fade settles, and then stops asking for frames',
    Math.abs(arrival.at(-1) - settled) < 0.02,
    `last ${arrival.at(-1)?.toFixed(2)}, settled ${settled.toFixed(2)}`);

// And it must actually STOP. The draw loop is on demand; a fade that never
// converges holds it open at 60Hz for as long as the map is on screen, which on
// a phone is a battery bug rather than a visual one. Most names lose their
// ground to a neighbour EVERY frame — those must settle at nothing, not keep
// asking. Measured in a real browser at 121 draws per 2 idle seconds before
// this was true.
flush(60);
const paintedBefore = rec.rects;
flush(12);
check('a settled map is not still repainting', rec.rects === paintedBefore,
    `${rec.rects - paintedBefore} surface fills over 12 frames with nothing happening`);

console.log('\n--- it selects ---');
globalThis.__act(() => handle.ref.current.fit());
flush(80);
reset();
// Aim at the centre of the biggest region, in screen coordinates.
const base = Math.min(900, 600) / (2 * 1.1);
const sx = (biggest.x - 0) * base + 450, sy = (biggest.y - 0) * base + 300;
pointer('pointerdown', sx, sy);
pointer('pointerup', sx, sy);
flush(4);
check('clicking a bubble selects that region', selections.at(-1) === biggest.id,
    `expected ${biggest.id} (${biggest.label}), got ${selections.at(-1)}`);

pointer('pointerdown', 8, 8);
pointer('pointerup', 8, 8);
flush(2);
check('clicking empty space clears the selection', selections.at(-1) === null);

console.log('\n--- keyboard ---');
reset();
globalThis.__act(() => canvas.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
flush(4);
const keyPanned = snapshot();
check('arrow keys pan', keyPanned.arcs.length > 0
    && Math.abs(keyPanned.arcs[0].x - first.arcs[0].x) > 1, 'no movement');

console.log('\n--- controls ---');
const buttons = [...window.document.querySelectorAll('button')];
const named = (re) => buttons.find(b => re.test(b.getAttribute('aria-label') || ''));
check('zoom in, zoom out, fit and full screen are all real buttons',
    !!named(/^Zoom in$/) && !!named(/^Zoom out$/) && !!named(/^Fit/) && !!named(/^Full screen$/),
    buttons.map(b => b.getAttribute('aria-label')).join(' | '));
check('every control clears the 44px touch-target floor',
    buttons.filter(b => /Zoom|Fit|Full screen/.test(b.getAttribute('aria-label') || ''))
        .every(b => /w-11/.test(b.className) && /h-11/.test(b.className)));
check('the controls sit at the BOTTOM of the map, clear of the region names', (() => {
    const panel = named(/^Zoom in$/)?.parentElement;
    return !!panel && /bottom-3/.test(panel.className) && !/top-3/.test(panel.className);
})());
globalThis.__act(() => named(/^Full screen$/).dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
check('the full-screen button reports back to the page that owns the layout', fsToggles === 1,
    `${fsToggles} toggles`);
globalThis.__act(() => canvas.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f', bubbles: true })));
check('and "f" does the same from the keyboard', fsToggles === 2, `${fsToggles} toggles`);

console.log('\n--- search lights up the map ---');
// A search must HIGHLIGHT rather than filter: a map that deletes everything you
// did not search for stops being a map, and "where is this in my library" is
// exactly the question being asked.
const target = atlas.regions.find(r => r.size >= 5);
const matchIds = new Set(target.topics.slice(0, 2).map(t => t.id));
globalThis.__act(() => handle.root.render(globalThis.__element({
    regions: atlas.regions, selectedId: null, onSelect: () => { },
    onOpenTopic: () => { }, matches: matchIds, dark: true, ref: handle.ref,
    fullscreen: false, onToggleFullscreen: () => { fsToggles++; },
})));
flush(6);
reset();
pointer('pointermove', 2, 2);
flush(3);
const searched = snapshot();
check('every region is still drawn while searching',
    searched.arcs.length >= atlas.regions.length - 5,
    `${searched.arcs.length} marks for ${atlas.regions.length} regions`);
check('non-matching regions are dimmed rather than removed',
    searched.arcs.some(a => a.a < 0.3) && searched.arcs.some(a => a.a > 0.8),
    `alphas ${Math.min(...searched.arcs.map(a => a.a)).toFixed(2)}..${Math.max(...searched.arcs.map(a => a.a)).toFixed(2)}`);


console.log('\n--- tracing a course across the map ---');
// The paths layer answers the one question the atlas deliberately cannot: the
// map groups by MEANING, so a course is scattered across it and nothing says
// how that course runs or how far the learner has got. Every fault in it is a
// picture — a line to a topic with no coordinates, a journey walked in the
// wrong order, a path drawn inside a bubble that is still a dot on screen — so
// what is asserted here is where the strokes actually landed.
const renderWith = (props) => globalThis.__act(() => handle.root.render(globalThis.__element({
    regions: atlas.regions, selectedId: null, onSelect: () => { },
    onOpenTopic: () => { }, matches: null, dark: true, ref: handle.ref,
    trace: null, journeyStep: null, colorMode: 'mastery', hues: courseHueMap,
    fullscreen: false, onToggleFullscreen: () => { fsToggles++; },
    ...props,
})));
/** A clean frame at the settled camera: nothing in flight, nothing half-faded. */
const settle = () => {
    flush(80);
    reset();
    pointer('pointermove', 3, 3);
    flush(3);
    return snapshot();
};

const courses = globalThis.__coursePaths.listCourses(atlas.regions);
const traceable = [...courses].sort((a, b) => b.finished - a.finished)[0];
const trace = globalThis.__coursePaths.traceCourse(atlas.regions, traceable.id);
console.log(`  tracing "${traceable.name}": ${traceable.topics} topics, ${trace.journey.length} finished`);

renderWith({ trace: null });
globalThis.__act(() => handle.ref.current.fit());
const untraced = settle();
check('nothing is drawn between the dots until a course is traced',
    untraced.segs.length === 0, `${untraced.segs.length} segments`);

renderWith({ trace });
globalThis.__act(() => handle.ref.current.fit());
const tracedOut = settle();
check('tracing a course draws lines the untraced map does not',
    tracedOut.segs.length > 0, `${tracedOut.segs.length} segments`);
// ---- the route is one shape, and the zoom only decides how big it is drawn --
//
// The line used to collapse onto the region bubbles as the reader pulled back,
// each point sliding from its topic to its region's centre on the zoom's own
// ramp. Every leg then had a different shape at every distance, legs inside one
// bubble grew out of nothing, and the line you were looking at was not the line
// you got back — which is what this replaces: at any camera, every end of every
// stroke of the path is a TOPIC OF THIS COURSE, in the map's own coordinates.
//
// Un-projected rather than compared on screen, because that is the claim: the
// same world point, wherever the camera happens to be.
const WORLD = 1.1;                       // AtlasMap's own half-extent
const unproject = (seg, cam) => {
    const base = Math.min(900, 600) / (2 * WORLD);
    const s = base * cam.k;
    return [
        { x: (seg.x1 - 450) / s + cam.x, y: (seg.y1 - 300) / s + cam.y },
        { x: (seg.x2 - 450) / s + cam.x, y: (seg.y2 - 300) / s + cam.y },
    ];
};
/** Every end of every stroke, in world coordinates, with how far it is off the
 *  nearest topic of the course — in PIXELS at the camera that drew it. */
const endsOffTopics = (shot, cam) => {
    const pts = [...trace.points.values()];
    const base = Math.min(900, 600) / (2 * WORLD) * cam.k;
    return shot.segs.flatMap(seg => unproject(seg, cam)).map(e => {
        let best = Infinity;
        for (const p of pts) best = Math.min(best, Math.hypot(p.x - e.x, p.y - e.y));
        return best * base;
    });
};
{
    const cam = handle.ref.current.camera();
    const off = endsOffTopics(tracedOut, cam);
    check('zoomed out, every end of every line is a topic of the course itself',
        off.length > 0 && off.every(d => d < 1.5),
        `${off.length} ends, worst ${Math.max(0, ...off).toFixed(2)}px off at k=${cam.k.toFixed(2)}`);
}
// …and the dots at those ends are drawn, however far out the reader is. A line
// whose ends are nothing is the fault the old collapse was avoiding.
check('and those topics are marked at that distance, not just joined up', (() => {
    const onMark = (s) => tracedOut.arcs.some(a => Math.hypot(a.x - s.x1, a.y - s.y1) < 2.5)
        && tracedOut.arcs.some(a => Math.hypot(a.x - s.x2, a.y - s.y2) < 2.5);
    const inside = (s) => s.x1 > 0 && s.x1 < 900 && s.y1 > 0 && s.y1 < 600
        && s.x2 > 0 && s.x2 < 900 && s.y2 > 0 && s.y2 < 600;
    const seen = tracedOut.segs.filter(inside);
    return seen.length > 0 && seen.every(onMark);
})(), `${tracedOut.segs.length} segments over ${tracedOut.arcs.length} marks`);
check('the rest of the library is dimmed, not deleted',
    tracedOut.arcs.length >= atlas.regions.length - 5
    && tracedOut.arcs.some(a => a.a < 0.35) && tracedOut.arcs.some(a => a.a > 0.6),
    `${tracedOut.arcs.length} marks, alphas ` +
    `${Math.min(...tracedOut.arcs.map(a => a.a)).toFixed(2)}..${Math.max(...tracedOut.arcs.map(a => a.a)).toFixed(2)}`);

// Frame the journey the way the replay button does, so every step of it is on
// screen at once — which is the only state in which "the path grows" is a
// thing anyone can watch.
const journeyPoints = trace.journey.map(id => trace.points.get(id));
globalThis.__act(() => handle.ref.current.frameOn(journeyPoints.map(p => ({ x: p.x, y: p.y }))));
const framed = settle();
check('the whole journey can be framed at once', framed.segs.length > 0,
    `${framed.segs.length} segments`);
// Age is drawn as presence: the newest step is solid, the oldest is a trace.
// It is the only encoding this layer has left now that the branch web is gone,
// so it is the only thing that says which way the route runs.
check('the journey fades back into the past rather than being one flat line',
    trace.journey.length < 3
    || (framed.segs.some(s => s.a > 0.9) && framed.segs.some(s => s.a < 0.4)),
    `alphas ${Math.min(...framed.segs.map(s => s.a)).toFixed(2)}..${Math.max(...framed.segs.map(s => s.a)).toFixed(2)}`);
// The walked path is stroked twice — a halo in the paper's colour, then the ink
// over it — so every journey stroke is IMMEDIATELY PRECEDED by a wider twin
// with the same two ends and a different colour.
//
// Paired by order rather than by endpoints, because endpoints are not unique:
// zoomed out the whole map collapses onto its bubbles, and a run of steps
// through one region is a dozen strokes between the same two centres. Grouping
// by position put four strokes in one "pair" and reported a missing halo that
// was there.
const haloed = (segs) => {
    const halo = new Set();
    for (let i = 0; i + 1 < segs.length; i++) {
        const a = segs[i], b = segs[i + 1];
        if (a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2
            && a.w > b.w && a.s !== b.s) halo.add(i + 1);
    }
    return halo;
};
/** Every stroke that is not somebody's halo. */
const inkOf = (segs) => {
    const under = new Set([...haloed(segs)].map(i => i - 1));
    return segs.filter((_, i) => !under.has(i));
};
// Below the oldest leg's own alpha (`JOURNEY_MIN_ALPHA`, 0.42), so every
// stroke of the path clears it and a halo — drawn at 0.7 of its leg's alpha —
// mostly does not.
const WALKED = 0.35;
const walkedInk = (segs) => {
    // A halo is itself a stroke, and a bright leg's halo clears this threshold
    // too — so the halos have to come out before the ink is counted, or the
    // question becomes "does every halo have a halo".
    const ink = haloed(segs);
    const under = new Set([...ink].map(i => i - 1));
    return segs.map((seg, i) => ({ seg, i })).filter(({ seg, i }) => seg.a > WALKED && !under.has(i));
};
check('every step of the journey is laid on a halo of the paper it crosses', (() => {
    const ink = haloed(framed.segs);
    const walked = walkedInk(framed.segs);
    return walked.length >= Math.min(3, trace.journey.length - 1)
        && walked.every(({ i }) => ink.has(i));
})(), `${walkedInk(framed.segs).filter(({ i }) => !haloed(framed.segs).has(i)).length} bare of ` +
    `${walkedInk(framed.segs).length} walked strokes`);
check('and the newest step is the heaviest stroke of ink on the map',
    trace.journey.length < 3
    || Math.max(...inkOf(framed.segs).filter(s => s.a > 0.9).map(s => s.w))
    >= Math.max(...inkOf(framed.segs).map(s => s.w)) - 1e-6);

// The same claim from somewhere else entirely: fly into one region the course
// reaches, several times closer, and the ends of the strokes are the same
// topics to within a pixel. This is where a camera-dependent place would show
// — on the old ramp these points sat most of the way back at their region's
// centre in the framed shot above and on their topics here.
{
    const byRegion = new Map();
    for (const id of trace.journey) {
        const r = trace.points.get(id).regionId;
        byRegion.set(r, (byRegion.get(r) ?? 0) + 1);
    }
    const busiest = [...byRegion.entries()].sort((a, b) => b[1] - a[1])[0];
    globalThis.__act(() => handle.ref.current.flyTo(busiest[0]));
    const near = settle();
    const cam = handle.ref.current.camera();
    const off = endsOffTopics(near, cam);
    const framedCam = { ...cam };
    check('zoomed in, the line still runs between exactly those topics',
        off.length > 0 && off.every(d => d < 1.5),
        `${off.length} ends, worst ${Math.max(0, ...off).toFixed(2)}px off at k=${framedCam.k.toFixed(2)}`);
    // Back to the whole journey: everything below is written from that shot,
    // and a camera left inside one region hides most of the course from it.
    globalThis.__act(() => handle.ref.current.frameOn(journeyPoints.map(p => ({ x: p.x, y: p.y }))));
    settle();
}

// The replay: step 1 is a single point, so no journey segment may be drawn yet.
// Anything still on screen is the course's own shape, which does not move.
renderWith({ trace, journeyStep: 1 });
const atStart = settle();
renderWith({ trace, journeyStep: trace.journey.length });
const atEnd = settle();
check('a replay at its first step has walked nowhere yet',
    atStart.segs.length < atEnd.segs.length,
    `${atStart.segs.length} vs ${atEnd.segs.length} segments`);
// And nothing else is: the curriculum's own tree used to be drawn under the
// path, so a replay opened on a map already covered in lines. The layer is the
// walk now, which means step one is a map with a dot on it and no lines at all.
check('a replay at its first step draws no line at all',
    atStart.segs.length === 0, `${atStart.segs.length} segments`);
check('a replay at its last step draws the whole path', (() => {
    renderWith({ trace, journeyStep: null });
    const whole = settle();
    return whole.segs.length === atEnd.segs.length;
})(), 'the finished replay and the resting path disagree');
check('the step on screen is named while the replay runs', (() => {
    renderWith({ trace, journeyStep: 2 });
    const mid = settle();
    const head = trace.points.get(trace.journey[1]).topic.title;
    return mid.texts.some(t => head.startsWith(t.t.replace(/…$/, '')) && t.t.length > 3);
})(), 'the current step has no label');

renderWith({ trace: null });
globalThis.__act(() => handle.ref.current.fit());
settle();

console.log('\n--- the replay flies, it does not cut ---');
// The thing a replay has to say is that one topic was reached AFTER another,
// and the only way a picture says "after" is by moving. This is the difference
// between the two versions of that: a step used to be a new segment appearing
// whole, with the marker somewhere else; now the drawn path grows along its
// curve as time passes and the arrow is at the end of what has been drawn.
//
// Everything here is measured off the newest stroke of ink — the one drawn at
// full strength — whose far end IS the arrow's position.
renderWith({ trace, journeyStep: null });
globalThis.__act(() => handle.ref.current.frameOn(journeyPoints.map(p => ({ x: p.x, y: p.y }))));
settle();
/** Draw one measured frame, `ms` of flight after the last one. */
const flightFrame = (ms) => {
    if (ms) advance(ms);
    reset();
    // A settled map stops asking for frames — by design, and asserted higher up
    // — so the measured frame is provoked the way `settle` provokes one rather
    // than hoped for. Without this, every sample taken after a flight had
    // finished recorded an empty canvas.
    pointer('pointermove', 3, 3);
    flush(1);
    return snapshot();
};
/** The newest stroke of ink: where the drawn path ends is where the arrow is. */
const head = (snap) => inkOf(snap.segs).filter(s => s.a > 0.95).sort((a, b) => b.w - a.w)[0] || null;
const away = (seg) => (seg ? Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) : 0);

/**
 * Long enough that ANY leg has finished flying.
 *
 * 600ms was a guess, and the worst case is `STEP_MAX_MS × FLIGHT_SHARE` = 864ms
 * — so a long leg was sampled MID-LANDING and "it lands exactly on the topic"
 * failed by half a pixel in roughly two runs out of three. It passed at all only
 * because `advance` adds real elapsed time to the clock it pushes, and a slow
 * machine bled in the missing milliseconds. Asked of the module rather than
 * typed, so a change to either constant cannot quietly un-fix this.
 */
const FLOWN = Math.ceil(globalThis.__coursePaths.STEP_MAX_MS * globalThis.__coursePaths.FLIGHT_SHARE) + 200;

// A step the flight has completed, to measure the others against.
renderWith({ trace, journeyStep: 1 });
flightFrame(FLOWN);
renderWith({ trace, journeyStep: 2 });
const whole = head(flightFrame(FLOWN));
check('a completed step draws a leg with two ends', !!whole && away(whole) > 2,
    whole ? `${away(whole).toFixed(1)}px` : 'no stroke at full strength');

// The same step again, sampled while it is being flown.
renderWith({ trace, journeyStep: 1 });
flightFrame(FLOWN);
renderWith({ trace, journeyStep: 2 });
const t0 = head(flightFrame(0));
const t1 = head(flightFrame(100));
const t2 = head(flightFrame(100));
const t3 = head(flightFrame(FLOWN));
const walked = [t0, t1, t2, t3].map(away);
check('the first instant of a step has gone almost nowhere',
    !!whole && walked[0] < away(whole) * 0.25, `${walked[0].toFixed(1)} of ${away(whole).toFixed(1)}px`);
check('...and it is further along at every later instant',
    walked[1] > walked[0] && walked[2] > walked[1] && walked[3] >= walked[2],
    walked.map(v => v.toFixed(1)).join(' → '));
check('mid-flight the arrow is between the two topics, at neither',
    !!whole && walked[1] > 1 && walked[1] < away(whole) - 1 && walked[2] < away(whole) - 1,
    `${walked[1].toFixed(1)}, ${walked[2].toFixed(1)} of ${away(whole).toFixed(1)}px`);
check('and it lands exactly on the topic, not near it',
    !!whole && !!t3 && Math.hypot(t3.x2 - whole.x2, t3.y2 - whole.y2) < 0.5,
    t3 && whole ? `${Math.hypot(t3.x2 - whole.x2, t3.y2 - whole.y2).toFixed(2)}px off` : 'nothing drawn');
// The route bends. A polyline turns its corners in a single frame however
// smoothly the position is interpolated, which is the jump this replaced.
check('the route between two topics is a curve, not a straight line',
    !!whole && !!whole.curve && Math.hypot(
        (whole.curve.h1.x + whole.curve.h2.x) / 2 - (whole.x1 + whole.x2) / 2,
        (whole.curve.h1.y + whole.curve.h2.y) / 2 - (whole.y1 + whole.y2) / 2) > 0.5,
    whole?.curve ? 'handles sit on the chord' : 'no curve recorded');
// ---- the camera DRIFTS with the journey ---------------------------------
// It follows a window — where the arrow is and the next few places it is going
// — so it moves while the arrow flies, and moves across several legs rather
// than restarting at each one. What it must never do is JUMP: every earlier
// arrangement failed as a different kind of jump, from a chase that surged
// whenever the error grew to a per-leg framing that reframed between every
// pair of topics. And whatever it is doing, the hop being flown has to stay on
// screen — a leg the reader cannot see the end of says nothing about where it
// went.
globalThis.__act(() => handle.ref.current.followJourney());
renderWith({ trace, journeyStep: 1 });
flightFrame(FLOWN);
renderWith({ trace, journeyStep: 2 });
const drifting = [];
for (let i = 0; i < 8; i++) drifting.push(flightFrame(50));
/**
 * How far the MAP moved between two frames, measured on a label both of them
 * drew — a name is identified by its own text, where "the biggest bubble" is a
 * different circle the moment the zoom drifts.
 */
const mapHop = (a, b) => {
    for (const t of a.texts) {
        const twin = b.texts.find(o => o.t === t.t);
        if (twin) return Math.hypot(twin.x - t.x, twin.y - t.y);
    }
    return null;
};
const hops = [];
for (let i = 1; i < drifting.length; i++) {
    const d = mapHop(drifting[i - 1], drifting[i]);
    if (d != null) hops.push(d);
}
const sortedHops = hops.slice().sort((a, b) => a - b);
check('the camera drifts rather than jumping', (() => {
    if (hops.length < 4) return false;
    const median = sortedHops[Math.floor(sortedHops.length / 2)];
    // Nothing moves the map more than a few pixels in a frame's worth of time,
    // and no single frame is wildly unlike its neighbours.
    return Math.max(...hops) < 40 && Math.max(...hops) <= median * 4 + 2;
})(), hops.map(v => v.toFixed(1)).join(' / ') + 'px between frames');
check('the hop being flown stays on screen from end to end', (() => {
    const inside = (x, y) => x > -10 && x < 910 && y > -10 && y < 610;
    return drifting.every(snap => {
        const h = head(snap);
        return !h || (inside(h.x1, h.y1) && inside(h.x2, h.y2));
    });
})());

// ---- a beat nobody drew is not a beat the arrow flew --------------------
// The map stops drawing once the arrow has landed and the camera has settled,
// so the rest of the beat passes with no frames at all. Charging that gap to
// the first frame of the next leg is what made the arrow appear a third of the
// way along it before anything moved.
//
// The camera is handed back first (`fit` cancels the follow), because these two
// samples are measured in PIXELS and a replay that reframes between legs would
// be comparing two different zooms.
globalThis.__act(() => handle.ref.current.fit());
globalThis.__act(() => handle.ref.current.frameOn(journeyPoints.map(p => ({ x: p.x, y: p.y }))));
settle();
// On the FIRST leg, where the only ink on the map is the leg being flown: on a
// later one the newest stroke at rest is the leg before it, and "the arrow has
// not set off" and "the arrow is a whole leg along" measure the same length.
renderWith({ trace, journeyStep: 1 });
flightFrame(FLOWN);
idle(200);
renderWith({ trace, journeyStep: 2 });
const afterIdle = head(flightFrame(0));
const wholeLeg = head(flightFrame(FLOWN));
// Nothing drawn at all is the ideal answer here — the leg has not begun — so
// the absence of a stroke passes, and only a stroke that is already a real part
// of the leg fails.
check('a beat that passed with the loop idle is not flown through',
    !!wholeLeg && away(wholeLeg) > 20 && away(afterIdle) < away(wholeLeg) * 0.25,
    `${away(afterIdle).toFixed(1)} of ${away(wholeLeg).toFixed(1)}px on the first frame`);

// ---- equal milliseconds buy equal millimetres ---------------------------
// A cubic is not traversed evenly by its own parameter — the middle of a leg
// runs up to seven times faster than its ends — so an arrow advanced in `t`
// crawls out of a topic and then bolts, which is what "it starts moving already
// halfway" describes. The flight is parameterised by arc length; this measures
// the result the only way that means anything, by watching one leg in four
// equal slices of its own beat.
// On the LEAST even leg this course has, not on whichever one comes first:
// a near-straight hop is traversed almost evenly by its parameter too, so
// testing one of those asks nothing.
const worldLegs = globalThis.__coursePaths.flightPath(journeyPoints.map(p => ({ x: p.x, y: p.y })));
const unevenness = (leg) => {
    const gaps = [];
    for (let i = 0; i < 12; i++) {
        const a = globalThis.__coursePaths.legAt(leg, i / 12);
        const b = globalThis.__coursePaths.legAt(leg, (i + 1) / 12);
        gaps.push(Math.hypot(b.x - a.x, b.y - a.y));
    }
    const sorted = gaps.slice().sort((x, y) => x - y);
    return sorted[11] / (sorted[0] || 1e-9);
};
let bendiest = 2;
let bendiestBy = 0;
worldLegs.forEach((leg, i) => {
    const e = unevenness(leg);
    if (e > bendiestBy) { bendiestBy = e; bendiest = i + 2; }
});
renderWith({ trace, journeyStep: bendiest - 1 });
flightFrame(FLOWN);
renderWith({ trace, journeyStep: bendiest });
const quarter = globalThis.__coursePaths.stepDurationMs(trace, bendiest)
    * globalThis.__coursePaths.FLIGHT_SHARE / 4;
// The frame a step ARRIVES on carries no travel — that is the design, so that
// the landing's idle is flown through on it — and counting it inside the first
// slice measures the harness's own starting line rather than the flight. On a
// 1.2s leg it is 5% of a quarter and hides; on a short one it is a fifth of it,
// and a flight measured flat to a pixel per eighth read as 1.9x uneven.
const startLine = away(head(flightFrame(FRAME)));
const along = [flightFrame(quarter), flightFrame(quarter), flightFrame(quarter)].map(f => away(head(f)));
const slices = [along[0] - startLine, along[1] - along[0], along[2] - along[1]];
check('equal slices of the beat cover equal stretches of the leg',
    Math.min(...slices) > 1 && Math.max(...slices) / Math.min(...slices) < 1.7,
    `step ${bendiest}, ${bendiestBy.toFixed(1)}x uneven by parameter: `
    + slices.map(v => v.toFixed(1)).join(' / ') + 'px');

// A jump is a cut, not a flight: choosing a course, rewinding, restarting. The
// reference is taken in the SAME camera, for the same reason.
renderWith({ trace, journeyStep: trace.journey.length });
const drawnWhole = settle();
renderWith({ trace, journeyStep: 1 });
flightFrame(FLOWN);
renderWith({ trace, journeyStep: trace.journey.length });
const cut = flightFrame(0);
check('a jump of many steps is drawn at once, never flown through',
    cut.segs.length === drawnWhole.segs.length,
    `${cut.segs.length} vs ${drawnWhole.segs.length} segments`);

renderWith({ trace: null, journeyStep: null });
globalThis.__act(() => handle.ref.current.fit());
settle();

// ---- the camera HOLDS A SHOT --------------------------------------------
//
// The replay's camera is a number moving through time, and the way it goes
// wrong is invisible in any one frame: every frame of a camera that zooms in
// and out twice a second is a perfectly reasonable picture. So this plays a
// stretch of the journey at 60Hz, writes down where the camera was on every
// frame, and asks the questions a chart of it would answer.
//
// The shape it is defending, measured on this journey before and after the
// change that introduced it (`tools/harness/cam-trace.mjs` prints all of it):
// the zoom changed direction 25 times in 18 seconds and swung x2.9 inside a
// single step, and the picture's speed peaked at five times its own median —
// because the legs of a real course run from 0.02 to 1.3 world units, and a
// camera that frames the leg being flown tracks that alternation exactly.
console.log('\n--- the camera holds a shot ---');
const FRAME_MS = 1000 / 60;
const camRun = [];
{
    globalThis.__act(() => handle.ref.current.fit());
    settle();
    renderWith({ trace, journeyStep: 1 });
    globalThis.__act(() => handle.ref.current.followJourney());
    const last = Math.min(14, trace.journey.length);
    let step = 1;
    let left = globalThis.__coursePaths.stepDurationMs(trace, step);
    while (step <= last) {
        flush(1);
        camRun.push(handle.ref.current.camera());
        left -= FRAME_MS;
        if (left <= 0) {
            step += 1;
            if (step > last) break;
            renderWith({ trace, journeyStep: step });
            // The beat a step owns is the one the PAGE gives it: at journeyStep
            // s it waits `stepDurationMs(trace, s)` before asking for s + 1.
            left += globalThis.__coursePaths.stepDurationMs(trace, step);
        }
    }
}
/** The hand-over into the replay is a fly-to, and is meant to be brisk. */
const SETTLED = 40;
const ride = camRun.slice(SETTLED);
const zoomTurns = (() => {
    let dir = 0, turns = 0;
    for (let i = 1; i < ride.length; i++) {
        const d = ride[i].k - ride[i - 1].k;
        // A change too small to see is not a change of direction.
        if (Math.abs(d) < ride[i].k * 0.002) continue;
        const sign = Math.sign(d);
        if (dir && sign !== dir) turns++;
        dir = sign;
    }
    return turns;
})();
check('the zoom holds still rather than breathing', zoomTurns <= 4,
    `${zoomTurns} changes of direction over ${(ride.length * FRAME_MS / 1000).toFixed(1)}s`);
// How fast the PICTURE moved, pan and zoom together, in screen pixels: a camera
// can hold a sensible zoom and still lurch, and what a reader calls jerky is
// one frame moving many times what its neighbours did.
const shot = [];
for (let i = 1; i < ride.length; i++) {
    const a = ride[i - 1], b = ride[i];
    const px = Math.min(900, 600) / 2.2 * ((a.k + b.k) / 2);
    shot.push((Math.hypot(b.x - a.x, b.y - a.y) * px
        + Math.abs(Math.log(b.k / a.k)) * px * 0.5) / (FRAME_MS / 1000));
}
const sortedShot = shot.slice().sort((a, b) => a - b);
const medShot = sortedShot[Math.floor(sortedShot.length / 2)];
const peakShot = sortedShot[sortedShot.length - 1];
// Asked of each frame against ITS OWN NEIGHBOURHOOD, which is what the sentence
// above actually says. Against the median of the whole ride it is not a measure
// of jerk at all but of the zoom's RANGE: screen speed scales with the zoom,
// this camera legitimately holds ×1.9 crossing the library and ×4.1 inside one
// region, and the same smooth journey measured 3.18 to 3.80 peak-over-median
// across runs — a coin toss against the 3.5 it was pinned at. A frame that
// moves 2.5 times what the frames either side of it moved is a lurch at any
// zoom, and nothing else is.
const jerk = shot.map((v, i) => {
    const win = shot.slice(Math.max(0, i - 15), i + 16).sort((a, b) => a - b);
    return v / (win[Math.floor(win.length / 2)] || 1e-6);
});
const worstJerk = Math.max(...jerk);
check('no frame of it lurches', worstJerk < 2.5,
    `worst frame is ${worstJerk.toFixed(2)}x its own neighbourhood; ` +
    `peak ${peakShot.toFixed(0)}px/s against a ride median of ${medShot.toFixed(0)}`);
const stalled = shot.filter(v => v < medShot * 0.15).length;
// 1%, because 3.4% is what standing still for the tail of every beat looks
// like: the arrow lands at 72% of its beat and rests, and a camera tied to the
// arrow rests with it. This one is only green because the camera runs on the
// BEAT instead — it is still moving toward the next place while the arrow waits.
check('and it never stops dead in the middle of the journey',
    stalled < shot.length * 0.01,
    `${stalled} of ${shot.length} frames under a sixth of the median`);

// ---- …and then it LETS GO ------------------------------------------------
//
// The last thing a replay does is pull back to the whole course, and it was the
// one move on this map nobody had put a clock on. Three faults lived in that
// gap, each of them invisible in a frame and plain in the trace
// (`tools/harness/cam-trace.mjs`, which plays the same ending on either
// surface):
//
//  * the camera closed IN during the hold on the last arrival, because the
//    window the zoom is bought from runs out of steps at the end of a journey
//    and a window with nothing in it asks for the closest shot there is — up to
//    x1.2 in, reversed a second later;
//  * the pull-out was a fly-to, which is a stiff spring meant for a
//    destination: the whole library crossed in 0.4s, the handover frame moving
//    64 times what the frame before it moved;
//  * and on the planet it was an exponential ease, whose first frame is its
//    fastest — 1479px/s against 6px/s the frame before it.
//
// What replaces them is one idea: the ending is the camera the reader has been
// riding LETTING GO, so it keeps that camera's weight and its speed.
console.log('\n--- the ending is a move, not a cut ---');
const { END_HOLD_MS } = globalThis.__coursePaths;
/**
 * Ride the last few steps of a journey, hold, let go — and hand back every
 * frame of the hold and of the pull-out.
 *
 * The last steps rather than all of them because the fault is at the END: the
 * window running out, and the handover between two arms. The beats before it
 * are what the section above measures.
 */
const rideToTheEnd = ({ renderStep, follow, end, camera }) => {
    const total = trace.journey.length;
    const from = Math.max(1, total - 3);
    renderStep(from);
    follow();
    flush(30);
    let step = from;
    let left = globalThis.__coursePaths.stepDurationMs(trace, step);
    for (; ;) {
        flush(1);
        left -= FRAME_MS;
        if (left <= 0) {
            if (step >= total) break;
            step += 1;
            renderStep(step);
            left += globalThis.__coursePaths.stepDurationMs(trace, step);
        }
    }
    const hold = [];
    for (let i = 0; i < Math.round(END_HOLD_MS / FRAME_MS); i++) { flush(1); hold.push(camera()); }
    renderStep(null);
    globalThis.__act(() => end());
    const out = [];
    for (let i = 0; i < Math.round(3000 / FRAME_MS); i++) { flush(1); out.push(camera()); }
    return { hold, out };
};
/** What the ending has to be, on whichever surface is being asked. */
const checkEnding = (where, { hold, out }, speed) => {
    // Two numbers, because a camera with weight is allowed to COAST: the last
    // framing move of the journey may still have some speed in it when the
    // journey ends, and a spring handed a target where it already is drifts a
    // little past and comes back. What the fault was is a NEW move — the zoom
    // climbing for the whole hold and finishing it further in than it started
    // (x1.13 and x1.20 on the real courses). So: never far, and never ending
    // closer than it began.
    const closedIn = Math.max(...hold.map(c => c.k)) / hold[0].k;
    const finishedAt = hold[hold.length - 1].k / hold[0].k;
    // `CAM_DEBUG=1` prints the shape rather than the verdict: which frames of
    // the hold moved is the difference between a coast and a fresh move, and
    // the numbers above cannot say which one a failure is.
    if (process.env.CAM_DEBUG) {
        console.log(`  ${where} hold k: ` +
            hold.filter((_, i) => i % 6 === 0).map(c => c.k.toFixed(3)).join(' '));
    }
    check(`${where}: the hold on the last arrival does not close in`,
        closedIn <= 1.05 && finishedAt <= 1.005,
        `x${closedIn.toFixed(3)} at its closest, x${finishedAt.toFixed(3)} by the end ` +
        `of the ${(hold.length * FRAME_MS / 1000).toFixed(1)}s hold`);
    const speeds = [];
    for (let i = 1; i < out.length; i++) speeds.push(speed(out[i - 1], out[i]));
    const first = speed(hold[hold.length - 1], out[0]);
    const peak = Math.max(...speeds);
    // A spring from rest starts at nothing and builds; an ease starts at its
    // own maximum and decays. That difference IS the snap, and it is the one
    // number that tells the two apart without knowing which is in the file.
    check(`${where}: the pull-out begins gently rather than at full speed`,
        first < peak * 0.25,
        `first frame ${first.toFixed(0)}px/s of a ${peak.toFixed(0)}px/s peak`);
    let settled = speeds.length - 1;
    while (settled > 0 && speeds[settled - 1] < peak * 0.05) settled--;
    const took = (settled + 1) * FRAME_MS / 1000;
    check(`${where}: and it takes a second or more to get there`, took >= 0.8,
        `${took.toFixed(2)}s`);
    const jerks = speeds.map((v, i) => {
        const win = speeds.slice(Math.max(0, i - 15), i + 16).sort((a, b) => a - b);
        return v / (win[Math.floor(win.length / 2)] || 1e-6);
    });
    check(`${where}: no frame of it lurches`, Math.max(...jerks) < 2.5,
        `worst ${Math.max(...jerks).toFixed(2)}x its own neighbourhood`);
    let dir = 0, turns = 0;
    for (let i = 1; i < out.length; i++) {
        const d = out[i].k - out[i - 1].k;
        if (Math.abs(d) < out[i].k * 0.002) continue;
        const sign = Math.sign(d);
        if (dir && sign !== dir) turns++;
        dir = sign;
    }
    check(`${where}: the zoom goes out and stays out`, turns === 0,
        `${turns} changes of direction`);
    check(`${where}: it ends further out than the journey was watched from`,
        out[out.length - 1].k < hold[0].k,
        `k ${hold[0].k.toFixed(2)} → ${out[out.length - 1].k.toFixed(2)}`);
};
const planeSpeed = (a, b) => {
    const px = Math.min(900, 600) / 2.2 * ((a.k + b.k) / 2);
    return (Math.hypot(b.x - a.x, b.y - a.y) * px
        + Math.abs(Math.log(b.k / a.k)) * px * 0.5) / (FRAME_MS / 1000);
};
{
    globalThis.__act(() => handle.ref.current.fit());
    settle();
    const run = rideToTheEnd({
        renderStep: (s) => renderWith({ trace, journeyStep: s }),
        follow: () => globalThis.__act(() => handle.ref.current.followJourney()),
        end: () => handle.ref.current.endJourney(trace),
        camera: () => handle.ref.current.camera(),
    });
    checkEnding('the sheet', run, planeSpeed);
    // The move has a destination as well as a shape: the whole course, in
    // frame. A beautifully weighted pull-out to the wrong place is still wrong.
    const cam = run.out[run.out.length - 1];
    const s = Math.min(900, 600) / (2 * 1.1) * cam.k;
    const off = [...trace.points.values()].filter(p => {
        const x = (p.x - cam.x) * s + 450, y = (p.y - cam.y) * s + 300;
        return x < 0 || x > 900 || y < 0 || y > 600;
    }).length;
    check('the sheet: and every topic of the course is in frame when it stops',
        off === 0, `${off} of ${trace.points.size} off screen`);
}

// The same ending, on the planet — which is the surface it was worst on, and
// which cannot borrow the sheet's arithmetic: a camera that turns moves the
// picture by the drawn radius times the angle, and the drawn radius is what the
// zoom decides.
{
    const el2 = window.document.createElement('div');
    window.document.body.appendChild(el2);
    const globeProps = {
        regions: atlas.regions, selectedId: null, onSelect: () => { },
        onOpenTopic: () => { }, matches: null, dark: true, theme: 'dark',
        accent: '#8b5cf6', hues: courseHueMap, trace: null, journeyStep: null,
        colorMode: 'mastery', fullscreen: false, onToggleFullscreen: () => { },
    };
    const globe = globalThis.__mountGlobe(el2, globeProps);
    const renderGlobe = (props) => globalThis.__act(() => globe.root.render(
        globalThis.__globeElement({ ...globeProps, ref: globe.ref, ...props })));
    flush(30);
    const R = Math.min(900, 600) * 0.44 / 2;
    const globeSpeed = (a, b) => {
        const k = (a.k + b.k) / 2;
        const dyaw = (b.yaw - a.yaw) * Math.cos((a.pitch + b.pitch) / 2);
        return (Math.hypot(dyaw, b.pitch - a.pitch) * R * k
            + Math.abs(Math.log(b.k / a.k)) * R * k) / (FRAME_MS / 1000);
    };
    const run = rideToTheEnd({
        renderStep: (s) => renderGlobe({ trace, journeyStep: s }),
        follow: () => globalThis.__act(() => globe.ref.current.followJourney()),
        end: () => globe.ref.current.endJourney(trace),
        camera: () => globe.ref.current.camera(),
    });
    checkEnding('the planet', run, globeSpeed);
    globalThis.__act(() => globe.root.unmount());
    el2.remove();
}

// --- the planet follows the hand ---------------------------------------------
//
// A drag is the one gesture this surface is made of, and every way it can be
// wrong is a FEEL: the planet answers with roughly the right move, or goes on
// moving after the hand has stopped. Measured on the pre-fix component, a 200px
// drag across the middle turned the planet 385px of surface — 192% of the drag
// — because the pointer handler moved the camera AND fed a velocity that the
// frame loop integrated again; the same velocity kept the planet sliding for as
// long as a still hand held the button down, and threw it on release.
//
// So this drives a drag the way a mouse drives one — pointer events between
// frames, on their own clock — and measures what the camera did with it.
//
// It asks about the SIZE of the move and never about where the grabbed point
// landed: an even turn per pixel is the mapping this surface wants (the exact
// solve was built, measured and rejected as jagged), and under it the point
// under the cursor falls behind as it approaches the limb, by the
// foreshortening and on purpose.
console.log('\n--- dragging the planet ---');
{
    const el3 = window.document.createElement('div');
    window.document.body.appendChild(el3);
    const props = {
        regions: atlas.regions, selectedId: null, onSelect: () => { },
        onOpenTopic: () => { }, matches: null, dark: true, theme: 'dark',
        accent: '#8b5cf6', hues: courseHueMap, trace: null, journeyStep: null,
        colorMode: 'mastery', fullscreen: false, onToggleFullscreen: () => { },
    };
    const g = globalThis.__mountGlobe(el3, props);
    flush(20);
    const canvas3 = el3.querySelector('canvas');
    const at = (type, x, y) => globalThis.__act(() => canvas3.dispatchEvent(
        new PointerEventPolyfill(type, { clientX: x, clientY: y, bubbles: true })));
    const frame = () => globalThis.__act(() => tick(FRAME_MS));
    const BASE_FILL = 0.44, CX = 450, CY = 300;
    const cam = () => g.ref.current.camera();
    const R = () => Math.min(900, 600) * BASE_FILL * cam().k;
    /** How far the camera has turned since `was`, in pixels of surface. */
    const moved = (was) => Math.hypot((cam().yaw - was.yaw) * Math.cos(was.pitch),
        cam().pitch - was.pitch) * R();

    /** One drag: `steps` moves of `dx`, one per frame, from (x, y). */
    const dragFrom = (x, y, dx, steps) => {
        globalThis.__act(() => g.ref.current.reset());
        for (let i = 0; i < 90; i++) frame();
        const from = cam();
        at('pointerdown', x, y);
        let px = x;
        for (let i = 0; i < steps; i++) {
            px += dx;
            at('pointermove', px, y);
            frame();
        }
        return { from, x: px, y };
    };

    const slow = dragFrom(450, 300, 200 / 24, 24);          // 200px over 24 frames
    const gain = moved(slow.from) / 200;
    check('a drag turns the planet by what the hand asked for, not twice it',
        gain > 0.9 && gain < 1.15, `${(gain * 100).toFixed(0)}% of the drag`);

    // A hand that has found what it was looking for stops moving, and the
    // button is still down. Nothing may move.
    const holding = cam();
    for (let i = 0; i < 18; i++) frame();                    // 300ms of holding still
    check('a still hand holds the planet still',
        moved(holding) < 0.5, `${moved(holding).toFixed(1)}px while the hand did not move`);

    // …and letting go of a drag that was placing something leaves it placed.
    at('pointerup', slow.x, slow.y);
    const released = cam();
    for (let i = 0; i < 60; i++) frame();
    check('letting go of a slow drag does not fling the planet',
        moved(released) < 1, `${moved(released).toFixed(1)}px after the hand came off`);

    // The one release that SHOULD keep going, so the flick is not quietly dead.
    const fast = dragFrom(380, 300, 300 / 4, 4);             // 300px in four frames
    at('pointerup', fast.x, fast.y);
    const thrown = cam();
    for (let i = 0; i < 60; i++) frame();
    check('…but a flick still throws it',
        moved(thrown) > 100, `${moved(thrown).toFixed(0)}px of coast after a throw`);

    globalThis.__act(() => g.root.unmount());
    el3.remove();
}

console.log('\n--- colour by course ---');
// Mastery is five ordinal steps of ONE hue, so five fills is all the map can
// ever paint with. Colour by course is one hue per project, so a library with
// seventeen of them cannot come out looking the same — and if it does, the mode
// is not reaching the canvas.
renderWith({ trace: null, colorMode: 'mastery' });
globalThis.__act(() => handle.ref.current.fit());
const byMastery = settle();
renderWith({ trace: null, colorMode: 'course' });
const byCourse = settle();
const fills = (snap) => new Set(snap.arcs.map(a => a.f).filter(Boolean));
const projectCount = new Set(atlas.regions.flatMap(r => r.projects.map(p => p.id))).size;
check('mastery paints from the five-step ramp and no more',
    fills(byMastery).size <= 5, `${fills(byMastery).size} distinct fills`);
check('colour by course paints more colours than the ramp has',
    projectCount < 2 || fills(byCourse).size > fills(byMastery).size,
    `${fills(byCourse).size} vs ${fills(byMastery).size} distinct fills over ${projectCount} courses`);
check('every bubble is still painted — no mode leaves a region colourless',
    byCourse.arcs.every(a => typeof a.f === 'string' && a.f.length > 0));
check('switching back restores exactly the ramp', (() => {
    renderWith({ trace: null, colorMode: 'mastery' });
    const back = settle();
    return [...fills(back)].every(f => fills(byMastery).has(f));
})());

renderWith({ trace: null, colorMode: 'mastery' });
settle();

console.log('\n--- two fingers ---');
// The pinch. Every fault here is a FEEL rather than an error: the map lurches,
// or slides out from under the fingers holding it, and nothing throws. The one
// that mattered: a two-finger gesture left `last` holding the position of the
// finger that started the drag, so the moment one finger came up the next move
// of the OTHER finger applied that whole stale gap as a pan.
globalThis.__act(() => handle.root.render(globalThis.__element({
    regions: atlas.regions, selectedId: null, onSelect: () => { },
    onOpenTopic: () => { }, matches: null, dark: true, ref: handle.ref, hues: courseHueMap,
    fullscreen: false, onToggleFullscreen: () => { fsToggles++; },
})));
globalThis.__act(() => handle.ref.current.fit());
flush(80);
reset();
pointer('pointermove', 1, 1);
flush(3);
const before2 = snapshot();

pointer('pointerdown', 400, 300, { pointerId: 11 });
pointer('pointerdown', 500, 300, { pointerId: 12 });
pointer('pointermove', 350, 300, { pointerId: 11 });
pointer('pointermove', 550, 300, { pointerId: 12 });
flush(4);
reset();
pointer('pointermove', 550, 300, { pointerId: 12 });
flush(3);
const pinched = snapshot();
check('spreading two fingers zooms in',
    Math.max(...pinched.arcs.map(a => a.r)) > Math.max(...before2.arcs.map(a => a.r)) * 1.3,
    `${Math.max(...before2.arcs.map(a => a.r)).toFixed(1)} -> ${Math.max(...pinched.arcs.map(a => a.r)).toFixed(1)}`);

// Two fingers sliding together must carry the map with them, not just scale it.
reset();
pointer('pointermove', 380, 340, { pointerId: 11 });
pointer('pointermove', 580, 340, { pointerId: 12 });
flush(4);
const dragged = snapshot();
check('two fingers moving together carry the map with them', (() => {
    const a = pinched.arcs[0], b = dragged.arcs[0];
    return a && b && Math.abs((b.y - a.y) - 40) < 8;
})(), `moved ${(dragged.arcs[0].y - pinched.arcs[0].y).toFixed(1)}px for a 40px drag`);

// The lurch: lift one finger, nudge the one that stayed.
reset();
pointer('pointerup', 380, 340, { pointerId: 11 });
pointer('pointermove', 586, 340, { pointerId: 12 });
flush(4);
const resumed = snapshot();
const jump = (() => {
    const a = dragged.arcs[0], b = resumed.arcs[0];
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
})();
check('lifting one finger does not jerk the map', jump < 20,
    `a 6px nudge moved the map ${jump.toFixed(0)}px`);
check('and the finger that stayed keeps panning', jump > 1, `${jump.toFixed(1)}px`);

// A pinch must never end as a tap on whatever was under a finger.
const selectionsBefore = selections.length;
pointer('pointerup', 586, 340, { pointerId: 12 });
flush(3);
check('a pinch never counts as a tap', selections.length === selectionsBefore,
    JSON.stringify(selections.slice(selectionsBefore)));

console.log(`\n${pass} passed, ${fail} failed`);
await library.cleanup();   // a fixture run leaves a scratch database and a stub server behind
process.exit(fail ? 1 : 0);

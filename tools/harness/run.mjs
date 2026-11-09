// Headless verification of the atlas map: mounts the REAL component against
// the REAL atlas payload from the project database, with a recording 2-D
// context, and drives real DOM events. Proves behaviour, never pixels.
import { prepareAtlasLibrary } from './atlasFixture.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// jsdom is a devDependency, so a plain clone can run this. HARNESS_MODULES
// points at an out-of-tree scratch install instead.
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
// The map strokes a great many lines — the graticule, coasts, borders, cities —
// so a line is told apart by what it is drawn IN: `strokes` keeps every
// `stroke()` whole, with its colour, width, alpha and points, and the walked
// route is the strokes in the page's ink (`INK` below), each laid on a halo in
// its paper (`LIT`). `fills` does the same for every `fill()`: a territory is
// filled twice over one path, bare ground and then its colour, which is how its
// colour is found among the sea, the cities and the marks.
const rec = { arcs: [], texts: [], segs: [], strokes: [], fills: [], rects: 0, calls: 0 };
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
        rec.fills.push({
            f: this.fillStyle, a: ctxState.globalAlpha, n: pathPts.length,
            x0: pathPts[0]?.x, y0: pathPts[0]?.y,
        });
    },
    stroke() {
        if (pathPts.length) {
            rec.strokes.push({
                s: this.strokeStyle, w: ctxState.lineWidth, a: ctxState.globalAlpha,
                pts: pathPts.map(p => ({ x: p.x, y: p.y, move: p.move })),
            });
        }
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
// would be asserting the first instant of a flight. The clock is SYNTHETIC — a
// fixed base plus the offset — never the real one plus an offset: the real
// clock keeps running between two ticks, so a runner's hiccup (a GC pause, a
// slow CI box) landed in the frame's own dt and drew a lurch the camera never
// makes (worst 2.72x on the Windows runner, 1.6x here, same code). React's
// scheduler only needs the clock to be monotonic, which a stepped one is.
const clockBase = performance.now();
performance.now = () => clockBase + clockOffset;
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
// The Map: the one renderer (`GlobeMap`) with the planet unrolled onto a sheet.
// Everything below is read off what it DREW and off the camera it reports, never
// off a second copy of its projection here: that copy is the mirror that drifts.
const selections = [];
const opened = [];
let fsToggles = 0;
const el = window.document.getElementById('root');
/** The journey's ink and its halo, on the dark page this mount draws. */
const { ink: INK, lit: LIT } = globalThis.__atlasSurfaces(true);
const sheetProps = {
    regions: atlas.regions,
    selectedId: null,
    onSelect: (id) => selections.push(id),
    onOpenTopic: (t) => opened.push(t.id),
    matches: null,
    dark: true,
    themeTint: '',
    accent: '#8b5cf6',
    trace: null,
    journeyStep: null,
    colorMode: 'mastery',
    hues: courseHueMap,
    fullscreen: false,
    onToggleFullscreen: () => { fsToggles++; },
};
const handle = globalThis.__mountAtlas(el, sheetProps);
flush(10);
await new Promise(r => setTimeout(r, 60));
flush(10);

const canvas = window.document.querySelector('canvas');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const snapshot = () => ({
    arcs: rec.arcs.slice(), texts: rec.texts.slice(), segs: rec.segs.slice(),
    strokes: rec.strokes.slice(), fills: rec.fills.slice(),
});
const reset = () => {
    rec.arcs.length = 0; rec.texts.length = 0; rec.segs.length = 0;
    rec.strokes.length = 0; rec.fills.length = 0;
};

const pointer = (type, x, y, extra = {}) => globalThis.__act(() => canvas.dispatchEvent(
    new PointerEventPolyfill(type, { clientX: x, clientY: y, bubbles: true, ...extra })));
const wheel = (dy, x, y) => {
    const e = new window.Event('wheel', { bubbles: true, cancelable: true });
    Object.assign(e, { deltaY: dy, deltaMode: 0, clientX: x, clientY: y });
    globalThis.__act(() => canvas.dispatchEvent(e));
};
/** The wheel turn that takes the zoom from where it is to `k` (the renderer's
 *  own rate: a notch multiplies the zoom by `exp(-deltaY × 0.0015)`). */
const wheelTo = (k, x, y) => wheel(-Math.log(k / cam().k) / 0.0015, x, y);
/** The camera, as the renderer reports it. */
const cam = () => handle.ref.current.camera();
/** A clean frame at the settled camera: nothing in flight, nothing half-faded. */
const settle = () => {
    flush(120);
    reset();
    pointer('pointermove', 3, 3);
    flush(3);
    return snapshot();
};
/** Back to the opening view, and a clean frame of it. */
const home = () => {
    globalThis.__act(() => handle.ref.current.reset());
    return settle();
};
/** What the card is answering ABOUT: `region`, `topic`, or nothing at all. */
const card = () => el.querySelector('[data-testid="atlas-card"]')?.dataset.kind ?? 'none';
/**
 * Each territory's colour. A territory is filled twice over one path, bare
 * ground and then its colour at however present it is, so its colour is the
 * second of two fills over the same outline — which nothing else on the map is.
 */
const landColours = (snap) => snap.fills.filter((f, i) => {
    const g = snap.fills[i - 1];
    return !!g && f.n > 8 && g.n === f.n && g.x0 === f.x0 && g.y0 === f.y0;
});
/** A region's name as drawn, and the region it names. Names wrap and shorten
 *  (`…`), so a drawn line is matched as the start of a label. The biggest
 *  region's when it is there: the most ground around its name. */
const regionLabel = (snap) => {
    const named = snap.texts.map(t => {
        const stem = t.t.replace(/…$/, '');
        const region = stem.length > 3 ? atlas.regions.find(r => (r.label || '').startsWith(stem)) : null;
        return region ? { x: t.x, y: t.y, region } : null;
    }).filter(Boolean);
    return named.sort((a, b) => b.region.size - a.region.size)[0] || null;
};
/** How far the MAP moved between two frames, on a label both of them drew — a
 *  name is identified by its own text. */
const labelShift = (a, b) => {
    for (const t of a.texts) {
        const twin = b.texts.find(o => o.t === t.t);
        if (twin) return { dx: twin.x - t.x, dy: twin.y - t.y };
    }
    return null;
};
const inFrame = (p, m = 0) => p.x > -m && p.x < 900 + m && p.y > -m && p.y < 600 + m;

console.log(`\n--- the map draws (${atlas.regions.length} regions, ${atlas.stats.mapped} topics) ---`);
check('the canvas mounted', !!canvas);
const first = settle();
// The whole sheet is in frame at the opening view, so every territory is.
check('every region is drawn as land', landColours(first).length >= atlas.regions.length - 5,
    `${landColours(first).length} territories painted for ${atlas.regions.length} regions`);
check('region names are drawn', first.texts.length > 3, `${first.texts.length} labels`);
check('no label is drawn on top of another', (() => {
    // Re-derive the collision test from the drawn output: no two label boxes
    // may overlap. The box height is the LINE height (0.85 + 0.31 = 1.16 x
    // size), not a guess around the baseline: a name that wraps to two lines
    // is two fillText calls one line apart, and a taller box makes a label
    // overlap itself and reports a collision that is not there.
    const boxes = first.texts.map(t => ({
        x0: t.x - (t.t.length * 6.2) / 2 - 3, x1: t.x + (t.t.length * 6.2) / 2 + 3,
        y0: t.y - t.size * 0.85, y1: t.y + t.size * 0.31,
    }));
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            // EPS, because the two lines of one wrapped name abut EXACTLY, and
            // in floating point "exactly" lands either side of the boundary at
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
pointer('pointerdown', 450, 300);
pointer('pointermove', 250, 200);
pointer('pointerup', 250, 200);
const panned = settle();
const dragShift = labelShift(first, panned);
check('dragging pans the map', !!dragShift && Math.hypot(dragShift.dx, dragShift.dy) > 100,
    dragShift ? `moved ${Math.hypot(dragShift.dx, dragShift.dy).toFixed(0)}px` : 'no label drawn in both frames');
check('a drag does NOT select anything (it is a pan, not a click)', selections.length === 0,
    JSON.stringify(selections));

console.log('\n--- it zooms ---');
const kBefore = cam().k;
wheel(-600, 450, 300);
flush(4);
check('the wheel zooms in', cam().k > kBefore * 1.5,
    `k ${kBefore.toFixed(2)} → ${cam().k.toFixed(2)}`);

// Fly to a real region, then come in far enough that its topics must appear: a
// fly-to on the sheet comes close enough to see the country and no closer.
const biggest = [...atlas.regions].sort((a, b) => b.size - a.size)[0];
globalThis.__act(() => handle.ref.current.flyTo(biggest.id));
flush(120);
wheelTo(8, 450, 300);
const deep = settle();
const deepDots = deep.arcs.filter(a => a.r > 1 && inFrame(a));
check('zooming into a region reveals its individual topics',
    deepDots.length >= Math.min(biggest.size, 4),
    `${biggest.label} holds ${biggest.size} topics; ${deepDots.length} dots in frame at k=${cam().k.toFixed(1)}`);
check('topic names appear once the dots are big enough to name',
    deep.texts.some(t => biggest.topics.some(tp => tp.title.startsWith(t.t.replace(/…$/, '')))),
    `${deep.texts.length} labels: ${deep.texts.slice(0, 3).map(t => t.t).join(' | ')}`);
check('every topic is packed INSIDE its own region',
    atlas.regions.every(r => r.topics.every(t =>
        Math.hypot(t.x - r.x, t.y - r.y) <= r.radius + 1e-6)));

// ---- a hover asks about ONE layer ---------------------------------------
//
// Zoomed in among a region's topics, the pointer spends half its time between
// dots, and every one of those in-between frames must not answer with the
// REGION's card — a panel over the topics, appearing and vanishing at
// dot → gap → dot. The country down there is scenery; the topics are the layer.
//
// Read off the DOM rather than the canvas, because the card IS the DOM.
console.log('\n--- a hover asks about the layer the reader is in ---');
{
    const middle = { x: 450, y: 300 };
    const dots = deepDots
        .filter(a => a.x > 20 && a.x < 880 && a.y > 20 && a.y < 580)
        .sort((a, b) => Math.hypot(a.x - middle.x, a.y - middle.y) - Math.hypot(b.x - middle.x, b.y - middle.y));
    check('there are topic dots to point at', dots.length > 3, `${dots.length} dots`);
    // Somewhere near the middle that is NOT a dot: the ground the pointer
    // crosses. Taken from the drawn frame, so it is a real gap in the real
    // picture rather than a place the harness believes is empty.
    const gap = (() => {
        for (let ring = 30; ring <= 260; ring += 20) {
            for (let a = 0; a < 360; a += 11) {
                const x = middle.x + Math.cos(a * Math.PI / 180) * ring;
                const y = middle.y + Math.sin(a * Math.PI / 180) * ring;
                if (x < 20 || x > 880 || y < 20 || y > 580) continue;
                if (dots.every(d => Math.hypot(d.x - x, d.y - y) > 26)) return { x, y };
            }
        }
        return null;
    })();
    if (dots.length) {
        pointer('pointermove', dots[0].x, dots[0].y);
        flush(3);
        check('hovering a topic still opens its card', card() === 'topic', `card is ${card()}`);
    }
    if (gap) {
        pointer('pointermove', gap.x, gap.y);
        flush(3);
        check('hovering the ground between two topics opens nothing',
            card() === 'none', `card is ${card()}`);
    } else {
        check('a gap between the dots was findable', false);
    }
    // …and zoomed out, where the countries ARE the layer, the region's card is
    // exactly what a hover should give.
    const out = home();
    const name = regionLabel(out);
    if (name) {
        pointer('pointermove', name.x, name.y);
        flush(3);
    }
    check('zoomed out, hovering a region opens its card', !!name && card() === 'region',
        name ? `card is ${card()} over "${name.region.label}"` : 'no region name drawn');
    pointer('pointermove', 3, 3);
    flush(3);
}

console.log('\n--- topic names arrive by fading, never in one frame ---');
// Reported from a phone: "the main blobs' names fade out slow, nice — the small
// blobs' text appears in an instant, wrong". Zoom in one jump (a wheel notch is
// instant, exactly like a pinch), then walk the frames: the names must climb,
// not appear.
const isTopicName = (t) => atlas.regions.some(r => r.topics.some(
    tp => tp.title.startsWith(t.t.replace(/…$/, '')) && t.t.length > 3));
const nameAlphas = () => snapshot().texts.filter(isTopicName).map(t => t.a);
// Zoom AT a country's name: the sheet keeps the ground under the pointer where
// it is, so its topics come in around it instead of the gap between countries.
const fitted = home();
const zoomAt = regionLabel(fitted);
check('the opening view names its countries', !!zoomAt, `${fitted.texts.length} labels`);
reset();
// One notch, past the end of the topics' fade-in — instant, exactly like a
// pinch, which is the state the fade has to survive.
wheelTo(8, zoomAt?.x ?? 450, zoomAt?.y ?? 300);
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

// And it must actually STOP. The draw loop is on demand; a fade that never
// converges holds it open at 60Hz for as long as the map is on screen, which on
// a phone is a battery bug rather than a visual one.
flush(90);
const paintedBefore = rec.rects;
flush(12);
check('a settled map is not still repainting', rec.rects === paintedBefore,
    `${rec.rects - paintedBefore} surface fills over 12 frames with nothing happening`);

console.log('\n--- it selects ---');
{
    const out = home();
    const name = regionLabel(out);
    if (name) {
        pointer('pointerdown', name.x, name.y);
        pointer('pointerup', name.x, name.y);
        flush(4);
    }
    check('clicking a country selects that region', !!name && selections.at(-1) === name.region.id,
        name ? `expected ${name.region.id} (${name.region.label}), got ${selections.at(-1)}` : 'no region name drawn');
    // The corner is off the sheet at the opening view: nothing there to select.
    pointer('pointerdown', 8, 8);
    pointer('pointerup', 8, 8);
    flush(2);
    check('clicking off the land clears the selection', selections.at(-1) === null,
        `got ${selections.at(-1)}`);
}

console.log('\n--- keyboard ---');
{
    const before = cam();
    globalThis.__act(() => canvas.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    flush(40);
    check('arrow keys move the map', Math.abs(cam().yaw - before.yaw) > 1e-3,
        `yaw ${before.yaw.toFixed(3)} → ${cam().yaw.toFixed(3)}`);
}

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
    // The box that places them: the nearest positioned ancestor of the cluster
    // (`MapOverlay`'s bottom strip, which it shares with the player).
    let panel = named(/^Zoom in$/)?.parentElement;
    while (panel && !/\babsolute\b/.test(panel.className)) panel = panel.parentElement;
    return !!panel && /bottom-3/.test(panel.className) && !/top-3/.test(panel.className);
})());
globalThis.__act(() => named(/^Full screen$/).dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
check('the full-screen button reports back to the page that owns the layout', fsToggles === 1,
    `${fsToggles} toggles`);
globalThis.__act(() => canvas.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f', bubbles: true })));
check('and "f" does the same from the keyboard', fsToggles === 2, `${fsToggles} toggles`);

const renderWith = (props) => globalThis.__act(() => handle.root.render(globalThis.__element({
    ...sheetProps, ref: handle.ref, ...props,
})));

console.log('\n--- search lights up the map ---');
// A search must HIGHLIGHT rather than filter: a map that deletes everything you
// did not search for stops being a map, and "where is this in my library" is
// exactly the question being asked.
{
    const target = atlas.regions.find(r => r.size >= 5);
    const matchIds = new Set(target.topics.slice(0, 2).map(t => t.id));
    renderWith({ matches: matchIds });
    const searched = home();
    const land = landColours(searched);
    check('every region is still drawn while searching',
        land.length >= atlas.regions.length - 5,
        `${land.length} territories for ${atlas.regions.length} regions`);
    check('non-matching regions are dimmed rather than removed',
        land.some(f => f.a < 0.3) && land.some(f => f.a > 0.8),
        `alphas ${Math.min(...land.map(f => f.a)).toFixed(2)}..${Math.max(...land.map(f => f.a)).toFixed(2)}`);
    renderWith({ matches: null });
}

console.log('\n--- tracing a course across the map ---');
// The paths layer answers the one question the atlas deliberately cannot: the
// map groups by MEANING, so a course is scattered across it and nothing says
// how that course runs or how far the learner has got. Every fault in it is a
// picture, so what is asserted here is where the strokes actually landed.
const courses = globalThis.__coursePaths.listCourses(atlas.regions);
const traceable = [...courses].sort((a, b) => b.finished - a.finished)[0];
const trace = globalThis.__coursePaths.traceCourse(atlas.regions, traceable.id);
console.log(`  tracing "${traceable.name}": ${traceable.topics} topics, ${trace.journey.length} finished`);

/** The walked route: every stroke in the page's ink. */
const inkOf = (snap) => snap.strokes.filter(s => s.s === INK);
const samePts = (a, b) => a.pts.length === b.pts.length
    && a.pts.every((p, i) => p.x === b.pts[i].x && p.y === b.pts[i].y);
/** From where a stroke starts to where it has got to. */
const away = (s) => (s ? Math.hypot(s.pts.at(-1).x - s.pts[0].x, s.pts.at(-1).y - s.pts[0].y) : 0);
/** Does every end of a leg that is on screen sit on a drawn dot? A leg that
 *  crosses the seam is drawn in two pieces, and its inner ends are the sheet's
 *  edges rather than topics, so only whole legs are asked. */
const endsOnDots = (snap) => {
    const onDot = (p) => snap.arcs.some(a => Math.hypot(a.x - p.x, a.y - p.y) < 2.5);
    const ends = inkOf(snap)
        .filter(s => !s.pts.slice(1).some(p => p.move))
        .flatMap(s => [s.pts[0], s.pts.at(-1)])
        .filter(p => inFrame(p));
    return { seen: ends.length, bare: ends.filter(p => !onDot(p)).length };
};
const frameCourse = () => {
    globalThis.__act(() => handle.ref.current.frameOnCourse(trace));
    return settle();
};

renderWith({ trace: null });
const untraced = home();
check('nothing is drawn in ink until a course is traced',
    inkOf(untraced).length === 0, `${inkOf(untraced).length} strokes`);

renderWith({ trace });
const framed = frameCourse();
check('tracing a course draws the route it walked', inkOf(framed).length > 0,
    `${inkOf(framed).length} strokes`);
check('framing the course puts every step of the route on screen',
    inkOf(framed).every(s => s.pts.every(p => inFrame(p, 1))),
    `${inkOf(framed).filter(s => !s.pts.every(p => inFrame(p, 1))).length} strokes leave the frame`);
{
    const { seen, bare } = endsOnDots(framed);
    check('every leg runs from one marked topic to the next', seen > 0 && bare === 0,
        `${bare} of ${seen} leg ends on screen are away from a dot`);
}
{
    const land = landColours(framed);
    check('the rest of the library is dimmed, not deleted',
        land.some(f => f.a < 0.35) && land.some(f => f.a > 0.6),
        `${land.length} territories, alphas ` +
        `${Math.min(...land.map(f => f.a)).toFixed(2)}..${Math.max(...land.map(f => f.a)).toFixed(2)}`);
}
// Age is drawn as presence: the newest step is solid, the oldest is a trace.
// It is the only thing that says which way the route runs.
check('the journey fades back into the past rather than being one flat line',
    trace.journey.length < 3
    || (inkOf(framed).some(s => s.a > 0.9) && inkOf(framed).some(s => s.a < 0.5)),
    `alphas ${Math.min(...inkOf(framed).map(s => s.a)).toFixed(2)}..${Math.max(...inkOf(framed).map(s => s.a)).toFixed(2)}`);
// The walked path is stroked twice — a halo in the paper's colour, then the ink
// over it — so every stroke of ink is IMMEDIATELY PRECEDED by a wider stroke in
// the paper's colour along exactly the same points.
check('every step of the journey is laid on a halo of the paper it crosses', (() => {
    const s = framed.strokes;
    const bare = s.filter((x, i) => x.s === INK
        && !(i > 0 && s[i - 1].s === LIT && s[i - 1].w > x.w && samePts(s[i - 1], x)));
    return inkOf(framed).length > 0 && bare.length === 0;
})());
check('and the newest step is the heaviest stroke of ink on the map',
    trace.journey.length < 3
    || Math.max(...inkOf(framed).filter(s => s.a > 0.9).map(s => s.w))
    >= Math.max(...inkOf(framed).map(s => s.w)) - 1e-6);

// The same claim from somewhere else entirely: fly into one region the course
// reaches and come in close, and the ends of the strokes are still the dots of
// the same topics. A place that depended on the camera would show here.
{
    const byRegion = new Map();
    for (const id of trace.journey) {
        const r = trace.points.get(id).regionId;
        byRegion.set(r, (byRegion.get(r) ?? 0) + 1);
    }
    const busiest = [...byRegion.entries()].sort((a, b) => b[1] - a[1])[0];
    globalThis.__act(() => handle.ref.current.flyTo(busiest[0]));
    flush(120);
    wheelTo(8, 450, 300);
    const near = settle();
    const { seen, bare } = endsOnDots(near);
    check('zoomed in, the line still runs between the dots of those topics',
        seen > 0 && bare === 0, `${bare} of ${seen} leg ends on screen are away from a dot at k=${cam().k.toFixed(1)}`);
    frameCourse();
}

// The replay: step 1 is a single point, so no journey segment may be drawn yet.
renderWith({ trace, journeyStep: 1 });
const atStart = settle();
renderWith({ trace, journeyStep: trace.journey.length });
const atEnd = settle();
check('a replay at its first step draws no line at all',
    inkOf(atStart).length === 0, `${inkOf(atStart).length} strokes`);
check('a replay at its last step draws the whole path', (() => {
    renderWith({ trace, journeyStep: null });
    const whole = settle();
    return inkOf(whole).length === inkOf(atEnd).length && inkOf(atEnd).length > 0;
})(), 'the finished replay and the resting path disagree');
check('the step on screen is named while the replay runs', (() => {
    renderWith({ trace, journeyStep: 2 });
    const mid = settle();
    const title = trace.points.get(trace.journey[1]).topic.title;
    return mid.texts.some(t => title.startsWith(t.t.replace(/…$/, '')) && t.t.length > 3);
})(), 'the current step has no label');

console.log('\n--- the replay flies, it does not cut ---');
// The thing a replay has to say is that one topic was reached AFTER another,
// and the only way a picture says "after" is by moving. A step is therefore not
// a new leg appearing whole: the drawn path grows along its curve as time
// passes and the arrow is at the end of what has been drawn.
//
// Everything here is measured off the newest stroke of ink — the one drawn at
// full strength, last — whose far end IS the arrow's position.
renderWith({ trace, journeyStep: null });
frameCourse();
/** Draw one measured frame, `ms` of flight after the last one. */
const flightFrame = (ms) => {
    if (ms) advance(ms);
    reset();
    // A settled map stops asking for frames — by design, and asserted higher up
    // — so the measured frame is provoked the way `settle` provokes one.
    pointer('pointermove', 3, 3);
    flush(1);
    return snapshot();
};
/** The leg being flown: the newest stroke of ink at full strength. */
const head = (snap) => inkOf(snap).filter(s => s.a > 0.95).at(-1) || null;

/**
 * Long enough that ANY leg has finished flying: the worst case is
 * `STEP_MAX_MS × FLIGHT_SHARE`. Asked of the module rather than typed, so a
 * change to either constant cannot quietly un-fix this.
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
    !!whole && !!t3 && Math.hypot(t3.pts.at(-1).x - whole.pts.at(-1).x, t3.pts.at(-1).y - whole.pts.at(-1).y) < 0.5,
    t3 && whole ? `${Math.hypot(t3.pts.at(-1).x - whole.pts.at(-1).x, t3.pts.at(-1).y - whole.pts.at(-1).y).toFixed(2)}px off` : 'nothing drawn');
// The route bends. A polyline turns its corners in a single frame however
// smoothly the position is interpolated, which is the jump this replaced.
check('the route between two topics is a curve, not a straight line', (() => {
    if (!whole) return false;
    const a = whole.pts[0], b = whole.pts.at(-1);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const off = (p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
    return Math.max(...whole.pts.map(off)) > 0.5;
})(), 'every point of the leg sits on its chord');

// ---- the camera DRIFTS with the journey ---------------------------------
// It follows a window — where the arrow is and the next few places it is going
// — so it moves while the arrow flies, and moves across several legs rather
// than restarting at each one. What it must never do is JUMP. And whatever it is
// doing, the hop being flown has to stay on screen.
//
// Measured on the CAMERA: the names that would show it move are the ones a
// replay quiets, and the picture's own movement is what the camera reports.
const FRAME_MS = 1000 / 60;
const { FLAT_DX_DLON, FLAT_HALF_W, FLAT_HALF_H } = globalThis.__proj;
/** About how many pixels one unit of the sheet is at zoom 1 in this frame. */
const SHEET_UNIT = Math.min(900 / (2 * FLAT_HALF_W), 600 / (2 * FLAT_HALF_H));
/** How far the PICTURE moves between two cameras, pan and zoom together, in
 *  screen pixels: a turn slides the sheet by the unit times the angle across
 *  (`FLAT_DX_DLON`) or down. */
const sheetPx = (a, b) => {
    const R = SHEET_UNIT * (a.k + b.k) / 2;
    const across = (b.yaw - a.yaw) * Math.cos((a.pitch + b.pitch) / 2) * FLAT_DX_DLON;
    return Math.hypot(across, b.pitch - a.pitch) * R + Math.abs(Math.log(b.k / a.k)) * R * 0.5;
};
/** …and as a speed, for a pair of consecutive frames. */
const sheetSpeed = (a, b) => sheetPx(a, b) / (FRAME_MS / 1000);
{
    globalThis.__act(() => handle.ref.current.followJourney());
    renderWith({ trace, journeyStep: 1 });
    flightFrame(FLOWN);
    renderWith({ trace, journeyStep: 2 });
    const drifting = [];
    const cams = [];
    for (let i = 0; i < 8; i++) { drifting.push(flightFrame(50)); cams.push(cam()); }
    const hops = [];
    for (let i = 1; i < cams.length; i++) hops.push(sheetPx(cams[i - 1], cams[i]));
    const sortedHops = hops.slice().sort((a, b) => a - b);
    check('the camera drifts rather than jumping', (() => {
        const median = sortedHops[Math.floor(sortedHops.length / 2)];
        // Nothing moves the map more than a few pixels in a frame's worth of
        // time, and no single frame is wildly unlike its neighbours.
        return Math.max(...hops) < 40 && Math.max(...hops) <= median * 4 + 2;
    })(), hops.map(v => v.toFixed(1)).join(' / ') + 'px between frames');
    check('the hop being flown stays on screen from end to end',
        drifting.every(snap => { const h = head(snap); return !h || h.pts.every(p => inFrame(p, 10)); }));
}

// ---- a beat nobody drew is not a beat the arrow flew --------------------
// The map stops drawing once the arrow has landed and the camera has settled,
// so the rest of the beat passes with no frames at all. Charging that gap to
// the first frame of the next leg is what made the arrow appear a third of the
// way along it before anything moved.
//
// The camera is handed back first (going home cancels the follow), because
// these two samples are measured in PIXELS.
home();
frameCourse();
// On the FIRST leg, where the only ink on the map is the leg being flown.
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
// A curve is not traversed evenly by its own parameter, so an arrow advanced in
// `t` crawls out of a topic and then bolts. The flight is parameterised by
// arc length; this measures the result by watching one leg in equal slices of
// its own beat — on the LEAST even leg this course has, because a near-straight
// hop is traversed almost evenly by its parameter too and asks nothing.
//
// Which leg that is, is read off the resting path: every leg is drawn at equal
// steps of its parameter, so the spacing of its drawn points IS its unevenness.
renderWith({ trace, journeyStep: null });
const resting = settle();
let bendiest = 2;
let bendiestBy = 0;
inkOf(resting).forEach((s, i) => {
    if (away(s) < 40 || s.pts.slice(1).some(p => p.move)) return;
    const gaps = [];
    for (let j = 1; j < s.pts.length; j++) gaps.push(Math.hypot(s.pts[j].x - s.pts[j - 1].x, s.pts[j].y - s.pts[j - 1].y));
    const e = Math.max(...gaps) / (Math.min(...gaps) || 1e-9);
    if (e > bendiestBy) { bendiestBy = e; bendiest = i + 2; }
});
renderWith({ trace, journeyStep: bendiest - 1 });
flightFrame(FLOWN);
renderWith({ trace, journeyStep: bendiest });
const quarter = globalThis.__coursePaths.stepDurationMs(trace, bendiest)
    * globalThis.__coursePaths.FLIGHT_SHARE / 4;
// The frame a step ARRIVES on carries no travel — that is the design — and
// counting it inside the first slice measures the harness's own starting line
// rather than the flight.
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
    inkOf(cut).length === inkOf(drawnWhole).length && inkOf(cut).length > 0,
    `${inkOf(cut).length} vs ${inkOf(drawnWhole).length} strokes`);

renderWith({ trace: null, journeyStep: null });
home();

// ---- the camera HOLDS A SHOT --------------------------------------------
//
// The replay's camera is a number moving through time, and the way it goes
// wrong is invisible in any one frame: every frame of a camera that zooms in
// and out twice a second is a perfectly reasonable picture. So this plays a
// stretch of the journey at 60Hz, writes down where the camera was on every
// frame, and asks the questions a chart of it would answer
// (`tools/harness/cam-trace.mjs` prints all of it).
console.log('\n--- the camera holds a shot ---');
const camRun = [];
{
    renderWith({ trace, journeyStep: 1 });
    globalThis.__act(() => handle.ref.current.followJourney());
    const last = Math.min(14, trace.journey.length);
    let step = 1;
    let left = globalThis.__coursePaths.stepDurationMs(trace, step);
    while (step <= last) {
        flush(1);
        camRun.push(cam());
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
for (let i = 1; i < ride.length; i++) shot.push(sheetSpeed(ride[i - 1], ride[i]));
const sortedShot = shot.slice().sort((a, b) => a - b);
const medShot = sortedShot[Math.floor(sortedShot.length / 2)];
const peakShot = sortedShot[sortedShot.length - 1];
// Asked of each frame against ITS OWN NEIGHBOURHOOD: against the median of the
// whole ride it measures the zoom's RANGE, not jerk. A frame that moves 2.5
// times what the frames either side of it moved is a lurch at any zoom.
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
// arrow rests with it. The camera runs on the BEAT instead.
check('and it never stops dead in the middle of the journey',
    stalled < shot.length * 0.01,
    `${stalled} of ${shot.length} frames under a sixth of the median`);

// ---- …and then it LETS GO ------------------------------------------------
//
// The last thing a replay does is pull back to the whole course. Three faults
// can live in that move, each of them invisible in a frame and plain in the trace
// (`tools/harness/cam-trace.mjs`, which plays the same ending on either
// surface):
//
//  * the camera closed IN during the hold on the last arrival, because the
//    window the zoom is bought from runs out of steps at the end of a journey
//    and a window with nothing in it asks for the closest shot there is;
//  * the pull-out was a fly-to, which is a stiff spring meant for a
//    destination: the whole library crossed in under half a second;
//  * and on the planet it was an exponential ease, whose first frame is its
//    fastest.
//
// What avoids them is one idea: the ending is the camera the reader has been
// riding LETTING GO, so it keeps that camera's weight and its speed.
console.log('\n--- the ending is a move, not a cut ---');
const { END_HOLD_MS } = globalThis.__coursePaths;
/**
 * Ride the last few steps of a journey, hold, let go — and hand back every
 * frame of the hold and of the pull-out.
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
    // journey ends. What the fault was is a NEW move — the zoom climbing for
    // the whole hold and finishing it further in than it started. So: never
    // far, and never ending closer than it began.
    const closedIn = Math.max(...hold.map(c => c.k)) / hold[0].k;
    const finishedAt = hold[hold.length - 1].k / hold[0].k;
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
    const firstFrame = speed(hold[hold.length - 1], out[0]);
    const peak = Math.max(...speeds);
    // A spring from rest starts at nothing and builds; an ease starts at its
    // own maximum and decays. That difference IS the snap.
    check(`${where}: the pull-out begins gently rather than at full speed`,
        firstFrame < peak * 0.25,
        `first frame ${firstFrame.toFixed(0)}px/s of a ${peak.toFixed(0)}px/s peak`);
    let settledAt = speeds.length - 1;
    while (settledAt > 0 && speeds[settledAt - 1] < peak * 0.05) settledAt--;
    const took = (settledAt + 1) * FRAME_MS / 1000;
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
{
    renderWith({ trace: null, journeyStep: null });
    home();
    renderWith({ trace, journeyStep: null });
    const run = rideToTheEnd({
        renderStep: (s) => renderWith({ trace, journeyStep: s }),
        follow: () => globalThis.__act(() => handle.ref.current.followJourney()),
        end: () => handle.ref.current.endJourney(trace),
        camera: () => cam(),
    });
    checkEnding('the sheet', run, sheetSpeed);
    // The move has a destination as well as a shape: the whole course, in
    // frame. A beautifully weighted pull-out to the wrong place is still wrong.
    const stopped = settle();
    const off = inkOf(stopped).filter(s => !s.pts.every(p => inFrame(p, 1))).length;
    check('the sheet: and the whole route is in frame when it stops',
        inkOf(stopped).length > 0 && off === 0,
        `${off} of ${inkOf(stopped).length} legs leave the frame`);
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
// moving after the hand has stopped. A pointer handler that moves the camera
// AND feeds a velocity the frame loop integrates again turns the planet about
// twice the drag, keeps it sliding for as long as a still hand holds the
// button down, and throws it on release.
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
// Mastery is a few ordinal steps of ONE hue, so that is all the map can ever
// paint its land with. Colour by course is one hue per project, so a library
// with seventeen of them cannot come out looking the same — and if it does, the
// mode is not reaching the canvas.
renderWith({ trace: null, journeyStep: null, colorMode: 'mastery' });
const byMastery = home();
renderWith({ trace: null, journeyStep: null, colorMode: 'course' });
const byCourse = settle();
const paints = (snap) => new Set(landColours(snap).map(f => f.f));
const projectCount = new Set(atlas.regions.flatMap(r => r.projects.map(p => p.id))).size;
check('mastery paints from the five-step ramp and no more',
    paints(byMastery).size <= 5, `${paints(byMastery).size} distinct fills`);
check('colour by course paints more colours than the ramp has',
    projectCount < 2 || paints(byCourse).size > paints(byMastery).size,
    `${paints(byCourse).size} vs ${paints(byMastery).size} distinct fills over ${projectCount} courses`);
check('every territory is still painted — no mode leaves a region colourless',
    landColours(byCourse).length === landColours(byMastery).length
    && landColours(byCourse).every(f => typeof f.f === 'string' && f.f.length > 0),
    `${landColours(byCourse).length} vs ${landColours(byMastery).length} territories`);
check('switching back restores exactly the ramp', (() => {
    renderWith({ trace: null, journeyStep: null, colorMode: 'mastery' });
    const back = settle();
    return [...paints(back)].every(f => paints(byMastery).has(f));
})());

console.log('\n--- two fingers ---');
// The pinch. Every fault here is a FEEL rather than an error: the map lurches,
// or slides out from under the fingers holding it, and nothing throws. Two that
// mattered: lifting one finger of a pinch counted as a TAP on whatever was
// under it, and the finger that stayed down carried a stale starting point, so
// its next move applied the whole gap to the other finger as a pan.
renderWith({ trace: null, journeyStep: null, colorMode: 'mastery' });
home();
const k2 = cam().k;
const tapsBefore = selections.length;

pointer('pointerdown', 400, 300, { pointerId: 11 });
pointer('pointerdown', 500, 300, { pointerId: 12 });
pointer('pointermove', 350, 300, { pointerId: 11 });
pointer('pointermove', 550, 300, { pointerId: 12 });
flush(4);
reset();
pointer('pointermove', 550, 300, { pointerId: 12 });
flush(3);
const pinched = snapshot();
check('spreading two fingers zooms in', cam().k > k2 * 1.3,
    `k ${k2.toFixed(2)} -> ${cam().k.toFixed(2)}`);

// Two fingers sliding together must carry the map with them, not just scale it.
reset();
pointer('pointermove', 380, 340, { pointerId: 11 });
pointer('pointermove', 580, 340, { pointerId: 12 });
flush(4);
const dragged = snapshot();
const carried = labelShift(pinched, dragged);
check('two fingers moving together carry the map with them',
    !!carried && Math.abs(carried.dx - 30) < 8 && Math.abs(carried.dy - 40) < 8,
    carried ? `moved ${carried.dx.toFixed(1)}, ${carried.dy.toFixed(1)}px for fingers moved 30, 40px` : 'no label drawn in both frames');

// The lurch: lift one finger, nudge the one that stayed.
reset();
pointer('pointerup', 380, 340, { pointerId: 11 });
pointer('pointermove', 586, 340, { pointerId: 12 });
flush(4);
const resumed = snapshot();
const nudge = labelShift(dragged, resumed);
const jump = nudge ? Math.hypot(nudge.dx, nudge.dy) : 0;
check('lifting one finger does not jerk the map', !!nudge && jump < 20,
    `a 6px nudge moved the map ${jump.toFixed(0)}px`);
check('and the finger that stayed keeps panning', jump > 1, `${jump.toFixed(1)}px`);

// A pinch must never end as a tap on whatever was under a finger — the first
// finger up included.
pointer('pointerup', 586, 340, { pointerId: 12 });
flush(3);
check('a pinch never counts as a tap', selections.length === tapsBefore,
    JSON.stringify(selections.slice(tapsBefore)));

console.log(`\n${pass} passed, ${fail} failed`);
await library.cleanup();   // a fixture run leaves a scratch database and a stub server behind
process.exit(fail ? 1 : 0);

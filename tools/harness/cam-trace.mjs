/**
 * Record the REPLAY CAMERA, frame by frame, and write the trace out.
 *
 * A replay that "moves in and out" is a fault in a number over time: no single
 * drawn frame is wrong, and a screenshot of any one of them looks fine. So this
 * mounts the real map against a generated library, plays a course the way the page
 * plays it — the same step clock, the same 60Hz frames — and writes down where
 * the camera was on every one of them.
 *
 *   node tools/harness/cam-trace.mjs                 # the longest course
 *   node tools/harness/cam-trace.mjs --course=12     # a project id
 *   node tools/harness/cam-trace.mjs --steps=20      # how many to fly
 *   node tools/harness/cam-trace.mjs --surface=globe # Terra instead of the Map
 *
 * Output: temp/camtrace/trace.json  (and a summary on stdout).
 */
import { prepareAtlasLibrary } from './atlasFixture.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const SCRATCH = process.env.HARNESS_MODULES;
const { JSDOM } = require(SCRATCH ? SCRATCH + '/jsdom' : 'jsdom');

const arg = (name, fallback) => {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const library = await prepareAtlasLibrary();
const { buildAtlas } = await import('../../server/atlas.js');
const atlas = await buildAtlas({ refresh: true });
if (!atlas.available) {
    console.log('atlas unavailable:', atlas.reason);
    await library.cleanup();
    process.exit(1);
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true, url: 'http://localhost/',
});
const { window } = dom;

// A canvas that swallows everything: this run is about the camera, not the
// picture, and the drawn frame is asserted elsewhere.
const noop = () => { };
const ctx = new Proxy({
    canvas: null,
    measureText: (t) => ({ width: t.length * 6.2 }),
    createRadialGradient: () => ({ addColorStop: noop }),
}, {
    get: (t, k) => (k in t ? t[k] : noop),
    set: (t, k, v) => { t[k] = v; return true; },
});
window.HTMLCanvasElement.prototype.getContext = () => ctx;
window.devicePixelRatio = 1;
const VIEW = { w: Number(arg('w', 900)), h: Number(arg('h', 600)) };
window.Element.prototype.getBoundingClientRect = function () {
    return {
        x: 0, y: 0, top: 0, left: 0, right: VIEW.w, bottom: VIEW.h,
        width: VIEW.w, height: VIEW.h, toJSON() { },
    };
};
window.ResizeObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() { this.cb([]); }
    disconnect() { }
};
window.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });

let rafQueue = [];
let clockOffset = 0;
window.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
window.cancelAnimationFrame = () => { };
const realNow = performance.now.bind(performance);
performance.now = () => realNow() + clockOffset;
let drewLast = 0;
const tick = (ms) => {
    clockOffset += ms;
    const q = rafQueue; rafQueue = [];
    drewLast = q.length;
    q.forEach(cb => cb(performance.now()));
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
window.HTMLElement.prototype.setPointerCapture = noop;
window.HTMLElement.prototype.releasePointerCapture = noop;

const here = fileURLToPath(new URL('.', import.meta.url));
require('esbuild').buildSync({
    entryPoints: [join(here, 'entry.tsx')],
    outfile: join(here, 'bundle.cjs'),
    bundle: true, format: 'cjs', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'error',
});
require('./bundle.cjs');

// Either surface, because the page gives both the same instructions and a
// replay is meant to mean the same thing on each: `--surface=globe` traces
// Terra's camera instead of the sheet's.
const SURFACE = arg('surface', 'map');
const onGlobe = SURFACE === 'globe';
const baseProps = {
    regions: atlas.regions, selectedId: null, onSelect: noop, onOpenTopic: noop,
    matches: null, dark: true, theme: 'dark', accent: '#8b5cf6', hues: new Map(),
    trace: null, journeyStep: null,
    colorMode: 'mastery', fullscreen: false, onToggleFullscreen: noop,
};
const el = window.document.getElementById('root');
const handle = (onGlobe ? globalThis.__mountGlobe : globalThis.__mountAtlas)(el, baseProps);
const act = globalThis.__act;
const element = onGlobe ? globalThis.__globeElement : globalThis.__element;
const render = (props) => act(() => handle.root.render(element({
    ...baseProps, ref: handle.ref, ...props,
})));
act(() => { for (let i = 0; i < 10; i++) tick(1000 / 60); });
await new Promise(r => setTimeout(r, 60));
act(() => { for (let i = 0; i < 10; i++) tick(1000 / 60); });

const { listCourses, traceCourse, stepDurationMs, END_HOLD_MS } = globalThis.__coursePaths;
const courses = listCourses(atlas.regions);
console.log('courses on the map: ' + [...courses]
    .sort((a, b) => b.finished - a.finished)
    .map(c => `${c.id}:${c.name.slice(0, 28)} (${c.finished})`).join(', '));
const wanted = arg('course', null);
const course = wanted
    ? courses.find(c => String(c.id) === wanted)
    : [...courses].sort((a, b) => b.finished - a.finished)[0];
if (!course) { console.log('no course to trace'); await library.cleanup(); process.exit(1); }
const trace = traceCourse(atlas.regions, course.id);
const total = trace.journey.length;
const asked = arg('steps', 'all');
const steps = asked === 'all' ? total : Math.min(total, Number(asked));
console.log(`tracing "${course.name}": ${total} finished topics, flying ${steps}`);

// Play it the way the page plays it: the camera is handed to the replay, the
// step clock counts one beat per step on `stepDurationMs`, and the frames run
// at 60Hz in between.
render({ trace, journeyStep: null });
act(() => handle.ref.current.followJourney());
let step = 1;
render({ trace, journeyStep: step });

const FRAME = 1000 / 60;
const frames = [];
let t = 0;
let phase = 'ride';
let beatLeft = stepDurationMs(trace, 1);
const sample = () => {
    // The camera both surfaces share: a pair of angles and a zoom.
    const cam = handle.ref.current.camera();
    frames.push({
        t: Math.round(t), step, phase,
        at: handle.ref.current.journeyAt(),
        ...cam, drew: drewLast,
    });
};
for (let n = 0; ; n++) {
    act(() => tick(FRAME));
    t += FRAME;
    sample();
    beatLeft -= FRAME;
    if (beatLeft <= 0) {
        if (step >= steps) break;
        step += 1;
        render({ trace, journeyStep: step });
        // The beat a step owns is the one the PAGE gives it: at journeyStep s
        // the page waits `stepDurationMs(trace, s)` before asking for s+1.
        beatLeft += stepDurationMs(trace, step);
    }
    if (n > 20000) break;
}

// ---- and then it ENDS ------------------------------------------------------
//
// Which is a camera move like any other and goes wrong the same way: the page
// holds the last arrival for `END_HOLD_MS`, hands the whole path back, and asks
// the surface to take the course in. Recorded here for the same reason as the
// ride — the fault is in the number over time, and the handover between two
// camera arms is exactly where a number over time can break.
const rideFrames = frames.length;
phase = 'hold';
for (let i = 0; i < Math.round(END_HOLD_MS / FRAME); i++) {
    act(() => tick(FRAME));
    t += FRAME;
    sample();
}
const holdFrames = frames.length - rideFrames;
phase = 'out';
render({ trace, journeyStep: null });
act(() => handle.ref.current.endJourney(trace));
for (let i = 0; i < Math.round(3200 / FRAME); i++) {
    act(() => tick(FRAME));
    t += FRAME;
    sample();
}

// Everything below this line is about the RIDE, and the ending has its own
// section at the bottom: mixing them makes both meaningless, since a pull-out
// legitimately covers more of the zoom range in a second and a half than the
// whole journey does in thirty.
const samples = frames.slice(0, rideFrames);

// How far the PICTURE moved between two frames, in screen pixels — and both
// surfaces have the same camera now, a turn (yaw, pitch) and a zoom, so one
// measure serves both. A turn of dθ carries the ground under the reader by the
// drawn scale times dθ: on the planet the drawn radius, on the sheet about one
// unit of the unrolled map (`FLAT_DX_DLON` of it across). The zoom decides the
// scale.
const TRACE_DIR = resolve(dirname(here), '../temp/camtrace');
const { FLAT_DX_DLON, FLAT_HALF_W, FLAT_HALF_H } = globalThis.__proj;
/** Pixels per radian at zoom 1. */
const UNIT = onGlobe
    ? Math.min(VIEW.w, VIEW.h) * 0.44 / 2
    : Math.min(VIEW.w / (2 * FLAT_HALF_W), VIEW.h / (2 * FLAT_HALF_H));
const ACROSS = onGlobe ? 1 : FLAT_DX_DLON;
/** One frame's movement of the picture: a step in pixels, and the zoom's share. */
const step2d = (a, b) => {
    const R = UNIT * (a.k + b.k) / 2;
    return {
        x: (b.yaw - a.yaw) * Math.cos((a.pitch + b.pitch) / 2) * ACROSS * R,
        y: (b.pitch - a.pitch) * R,
        zoom: Math.abs(Math.log(b.k / a.k)) * R * (onGlobe ? 1 : 0.5),
    };
};
const pictureSpeed = (a, b) => {
    const s = step2d(a, b);
    return (Math.hypot(s.x, s.y) + s.zoom) / (FRAME / 1000);
};

mkdirSync(TRACE_DIR, { recursive: true });
const payload = {
    course: course.name, courseId: course.id, total, steps, surface: SURFACE,
    view: VIEW, frameMs: FRAME, samples: frames, rideFrames, holdFrames,
    /** Where each step began, in ms — the beats, for the plot's gridlines. */
    beats: (() => {
        const marks = [];
        let acc = 0;
        for (let s = 1; s <= steps; s++) { marks.push({ step: s, t: Math.round(acc) }); acc += stepDurationMs(trace, s); }
        return marks;
    })(),
};
writeFileSync(join(TRACE_DIR, 'trace.json'), JSON.stringify(payload));

// ---- what the trace says, in numbers ---------------------------------------
// Whether the hop being flown stays on screen is read off the drawn strokes in
// `run.mjs`, which sees the picture; this sees only the camera.
const ks = samples.map(s => s.k);
const turns = [];           // every time the zoom changes direction
let dir = 0;
for (let i = 1; i < ks.length; i++) {
    const d = ks[i] - ks[i - 1];
    if (Math.abs(d) < 1e-4) continue;
    const sign = Math.sign(d);
    if (dir && sign !== dir) turns.push({ t: samples[i].t, k: ks[i], step: samples[i].step });
    dir = sign;
}
const span = (a) => `${Math.min(...a).toFixed(2)}..${Math.max(...a).toFixed(2)}`;
console.log(`frames ${samples.length} over ${(t / 1000).toFixed(1)}s`);
console.log(`zoom ${span(ks)} — ${turns.length} reversals ` +
    `(${(turns.length / (t / 1000)).toFixed(1)} per second)`);
// How much of the zoom range one beat covers, worst case: the "in and out".
let worst = { swing: 0, step: 0 };
for (let s = 1; s <= steps; s++) {
    const inStep = samples.filter(v => v.step === s).map(v => v.k);
    if (inStep.length < 2) continue;
    const swing = Math.max(...inStep) / Math.min(...inStep);
    if (swing > worst.swing) worst = { swing, step: s };
}
console.log(`worst single-step zoom swing ×${worst.swing.toFixed(2)} (step ${worst.step})`);
const perStep = [];
for (let s = 1; s <= steps; s++) {
    const inStep = samples.filter(v => v.step === s).map(v => v.k);
    if (inStep.length) perStep.push(`${s}:${Math.min(...inStep).toFixed(1)}-${Math.max(...inStep).toFixed(1)}`);
}
console.log('per step  ' + perStep.join('  '));
const drawn = samples.filter(s => s.drew).length;
console.log(`frames actually drawn: ${drawn} of ${samples.length} ` +
    `(${(100 * drawn / samples.length).toFixed(0)}%) — a replay should draw every one`);
// How the PICTURE moved, which is the other half of "weird": a camera can hold
// a perfectly sensible zoom and still lurch, if it keeps stopping and starting.
const speed = [];
// The hand-over into the replay is a fly-to and is meant to be brisk; it is not
// what "jiggle" is about, so the first half-second is not counted.
const SETTLE = 30;
for (let i = SETTLE; i < samples.length; i++) speed.push(pictureSpeed(samples[i - 1], samples[i]));
const sorted = speed.slice().sort((x, y) => x - y);
const pct = (q) => sorted[Math.floor(q * (sorted.length - 1))];
const med = pct(0.5);
const stalls = speed.filter(v => v < med * 0.15).length;
console.log(`screen speed px/s: median ${med.toFixed(0)}, p95 ${pct(0.95).toFixed(0)}, ` +
    `max ${sorted[sorted.length - 1].toFixed(0)} (peak/median ×${(sorted[sorted.length - 1] / med).toFixed(1)})`);
console.log(`near-stalls (under 15% of median): ${stalls} frames, ` +
    `${(100 * stalls / speed.length).toFixed(0)}%`);
// How sharply the camera TURNS, and how sharply the zoom changes its mind.
// A camera on a suspension arm cannot reverse in one frame: it has momentum, so
// a direction change costs it a curve. These two numbers are that, measured.
const hops = [];
for (let i = 1; i < samples.length; i++) {
    const s = step2d(samples[i - 1], samples[i]);
    hops.push(Math.hypot(s.x, s.y));
}
const busy = hops.slice().sort((a, b) => a - b)[Math.floor(hops.length / 2)];
const turnDeg = [];
for (let i = 2; i < samples.length; i++) {
    const v1 = step2d(samples[i - 2], samples[i - 1]);
    const v2 = step2d(samples[i - 1], samples[i]);
    const m1 = Math.hypot(v1.x, v1.y), m2 = Math.hypot(v2.x, v2.y);
    // Only where the map is MOVING. A turn taken at a standstill is not a turn
    // anyone sees — and a camera with weight reaches a standstill on purpose
    // before it reverses, so measuring the angle there rewards exactly the
    // fault this is looking for.
    if (m1 < busy * 0.3 || m2 < busy * 0.3) continue;
    const cos = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (m1 * m2)));
    turnDeg.push(Math.acos(cos) * 180 / Math.PI);
}
turnDeg.sort((x, y) => x - y);
const zoomTurn = [];
for (let i = 2; i < samples.length; i++) {
    const r1 = Math.log(samples[i - 1].k / samples[i - 2].k);
    const r2 = Math.log(samples[i].k / samples[i - 1].k);
    zoomTurn.push(Math.abs(r2 - r1) / (FRAME / 1000) / (FRAME / 1000));
}
zoomTurn.sort((x, y) => x - y);
if (turnDeg.length) {
    console.log(`camera turn per frame (while moving): ` +
        `median ${turnDeg[Math.floor(turnDeg.length / 2)].toFixed(1)}deg, ` +
        `p99 ${turnDeg[Math.floor(turnDeg.length * 0.99)].toFixed(1)}deg, ` +
        `max ${turnDeg[turnDeg.length - 1].toFixed(1)}deg ` +
        `(over 90deg is a reversal)`);
}
console.log(`zoom acceleration: p99 ${zoomTurn[Math.floor(zoomTurn.length * 0.99)].toFixed(2)}, ` +
    `max ${zoomTurn[zoomTurn.length - 1].toFixed(2)} (ln k per second squared)`);
const jerk = [];
for (let i = 1; i < speed.length; i++) {
    jerk.push({ v: Math.abs(speed[i] - speed[i - 1]), s: samples[i + SETTLE] });
}
const rough = [...jerk].sort((x, y) => y.v - x.v).slice(0, 8);
{   // The neighbourhood of the single roughest frame, printed: a number this
    // big is either the camera being handed a new place to be or the journey
    // changing speed, and the two look nothing alike frame by frame.
    const worstIdx = samples.findIndex(v => v === rough[0]?.s);
    if (worstIdx < 0) console.log('   (frame not found)');
    else {
        console.log('around the roughest frame:');
        for (let i = worstIdx - 4; i <= worstIdx + 3; i++) {
            const a = samples[i - 1], b = samples[i];
            if (!a || !b) continue;
            const s = step2d(a, b);
            console.log(`   t${b.t} step ${b.step} at ${b.at == null ? '-' : b.at.toFixed(3)} ` +
                `k ${b.k.toFixed(3)} moved ${Math.hypot(s.x, s.y).toFixed(2)}px dk ${(b.k - a.k).toFixed(4)}`);
        }
    }
}
console.log('the roughest frames: ' + rough.map(r =>
    `${r.v.toFixed(0)}px/s at step ${r.s.step} (k ${r.s.k.toFixed(2)})`).join(', '));
jerk.splice(0, jerk.length, ...jerk.map(r => r.v));
jerk.sort((x, y) => x - y);
console.log(`change of speed between frames: median ${jerk[Math.floor(jerk.length / 2)].toFixed(0)}, ` +
    `p99 ${jerk[Math.floor(jerk.length * 0.99)].toFixed(0)}, max ${jerk[jerk.length - 1].toFixed(0)} px/s`);

// ---- and the ENDING, which is its own move ---------------------------------
//
// Three questions, and each of them was a fault:
//
//  1. Does the camera go the WRONG WAY while the last arrival is held? The
//     window the zoom is bought from runs out of steps at the end of a journey,
//     and a window with nothing in it asks for the closest shot there is.
//  2. Is the handover a STEP? The following camera and the ending are two
//     different arms, and the frame the target changes on is where the picture
//     either carries its speed across or does not.
//  3. Is the pull-out itself smooth, and does it take long enough to read as a
//     camera moving rather than as a cut?
{
    const pxOf = pictureSpeed;
    const hold = frames.filter(s => s.phase === 'hold');
    const outs = frames.filter(s => s.phase === 'out');
    const lastRide = frames[rideFrames - 1];
    console.log('\n--- the ending ---');
    if (hold.length) {
        const ks = hold.map(s => s.k);
        const into = Math.max(...ks) / hold[0].k;
        console.log(`the hold (${holdFrames} frames): k ${hold[0].k.toFixed(2)} → ` +
            `${hold[hold.length - 1].k.toFixed(2)}, furthest IN x${into.toFixed(2)} ` +
            `(anything over x1 is the camera closing in on a journey that has ended)`);
    }
    if (outs.length) {
        const speeds = [];
        for (let i = 1; i < outs.length; i++) speeds.push(pxOf(outs[i - 1], outs[i]));
        const handover = pxOf(hold[hold.length - 1] ?? lastRide, outs[0]);
        const before = pxOf(hold[hold.length - 2] ?? lastRide, hold[hold.length - 1] ?? outs[0]);
        // Where the pull-out has effectively finished: the first frame after
        // which nothing moves more than a pixel a frame again.
        let settled = outs.length - 1;
        while (settled > 0 && speeds[settled - 1] < 60) settled--;
        const jerks = speeds.map((v, i) => {
            const win = speeds.slice(Math.max(0, i - 15), i + 16).sort((a, b) => a - b);
            return v / (win[Math.floor(win.length / 2)] || 1e-6);
        });
        let dir = 0, turns = 0;
        for (let i = 1; i < outs.length; i++) {
            const d = outs[i].k - outs[i - 1].k;
            if (Math.abs(d) < outs[i].k * 0.002) continue;
            const sign = Math.sign(d);
            if (dir && sign !== dir) turns++;
            dir = sign;
        }
        console.log(`the pull-out: k ${outs[0].k.toFixed(2)} → ${outs[outs.length - 1].k.toFixed(2)} ` +
            `over ${((settled + 1) * FRAME / 1000).toFixed(2)}s, ${turns} changes of direction`);
        console.log(`  the handover frame moved ${handover.toFixed(0)}px/s ` +
            `against ${before.toFixed(0)}px/s the frame before it ` +
            `(x${(handover / Math.max(before, 1e-6)).toFixed(1)})`);
        console.log(`  peak ${Math.max(...speeds).toFixed(0)}px/s; ` +
            `worst frame ${Math.max(...jerks).toFixed(2)}x its own neighbourhood`);
    }
}

console.log(`written ${join(TRACE_DIR, 'trace.json')}`);
await library.cleanup();

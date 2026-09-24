// tools/visual-author-gates.mjs — the animation authoring loop, asserted without a model.
//
// Run:  node tools/visual-author-gates.mjs
//
// What it guards, and where each rule came from (the 36 "Fix this" reports of
// 2026-09-04, read back from visual-feedback.jsonl):
//   - A reader's words about a BRIEF-backed drawing must reach the DRAWER with
//     the previous drawing, not only the brief: 14 reports revised the brief,
//     the specialist redrew blind, and 4 of them asked for something the brief
//     already said ("the cars should start on the sides") — unfixable by words.
//   - A finished animation is revised by the SPECIALIST, not the repair hint:
//     seven hint-driven revisions of one SVG ended in "you broke it completely".
//   - "White" from a reader on a dark page means "the strongest ink": the
//     adapter maps a paper-white fill to the page colour, and one reader asked
//     for white particles five times while the model wrote fill="#ffffff" five
//     times and the adapter erased them five times.
//   - Labels that run off the frame are rescued by GROWING the viewBox
//     ("v-t gra", "sinks wi", "from releas" on real cards) — only text, since
//     shapes are allowed and sometimes told to extend past the edge.
//   - The GIF export's frame trick (every SMIL begin shifted by -t) and the
//     card layout are pure functions and are held to their contract here.
//
// No model, no network, no real database (DB_PATH points at a scratch file
// because ai.js imports database.js, which opens one at import time).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SCRATCH = mkdtempSync(join(tmpdir(), 'visual-author-gates-'));
process.env.DB_PATH = join(SCRATCH, 'gate.db');
process.env.VAULT_ROOT = join(SCRATCH, 'vault');

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
function section(name) { console.log(`\n── ${name}`); }
function check(label, ok, detail = '') {
    if (ok) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

/* ── server: the prompts ─────────────────────────────────────────────────── */

const ai = await import('../server/ai.js');
const { visualAuthorPrompt, reviseVisualPrompt, visualCaptionPrompt } = ai;

section('the specialist carries the motion and design rules the reports earned');
const built = visualAuthorPrompt('animation', 'Shows: a wave.\nDraw: a string.\nMoves: it travels.\nNotice: transverse.');
for (const rule of ['ONE CLOCK', 'EMISSION', 'ATTACHMENT', 'HAND-OFF', 'TRAJECTORIES', 'ACCELERATION', 'LINKED ROTATION', 'CAMERA', 'Z-ORDER', 'SCALE', 'WHITE IS THE PAGE', 'SILHOUETTES', 'SOMETHING MUST MOVE']) {
    check(`animation specialist states ${rule}`, built.system.includes(rule));
}
check('the belt is described as tangent lines, never a rectangle', /never a rectangle/.test(built.system));
check('a trajectory shares one path between guide and motion (mpath)', /mpath/.test(built.system));
check('meshing gears counter-rotate, belt-linked co-rotate', /OPPOSITE directions/.test(built.system) && /SAME direction/.test(built.system));
check('a plain build asks for the drawing without any error framing', /Build the animation now/.test(built.user) && !/FAILED/.test(built.user));

section('a reader\'s note reaches the drawer with the previous drawing');
const noted = visualAuthorPrompt('animation', 'Shows: two cars.', {
    readerNote: 'The cars should start on the sides',
    previousSpec: '<svg viewBox="0 0 600 340"><rect/></svg>',
    theme: 'black',
});
check('the note is quoted to the drawer', noted.user.includes('The cars should start on the sides'));
check('the previous drawing travels with it', noted.user.includes('<svg viewBox="0 0 600 340">'));
check('the drawer is told to REVISE, keeping what was not mentioned', /keep everything they did not mention/.test(noted.user));
check('a dark page is named, and white is explained as the page', /DARK page/.test(noted.user) && /white is the PAGE/.test(noted.user));
check('"more visible" is routed to the strongest ink', /strongest ink or a saturated hue/.test(noted.user));
const notedNoPrev = visualAuthorPrompt('animation', 'Shows: two cars.', { readerNote: 'Make it move', theme: 'light' });
check('without a previous drawing it builds from the brief, honouring the note', /Build the drawing from the brief/.test(notedNoPrev.user));
check('a light page is named as light', /light page/.test(notedNoPrev.user) && !/DARK/.test(notedNoPrev.user));
const errored = visualAuthorPrompt('animation', 'Shows: x.', { error: 'boom', previousSpec: '<svg/>' });
check('a renderer error still takes the repair framing', /FAILED with this error:\nboom/.test(errored.user));
const both = visualAuthorPrompt('animation', 'Shows: x.', { error: 'boom', readerNote: 'wrong', previousSpec: '<svg/>' });
check('when both are present the reader\'s note wins', /A reader looked/.test(both.user) && !/FAILED/.test(both.user));

section('revising a finished animation uses the specialist, not the repair hint');
const svgRev = reviseVisualPrompt('animation', '<svg viewBox="0 0 10 10"></svg>', 'the arrow points the wrong way', { brief: false, theme: 'dark' });
check('system prompt IS the specialist', svgRev.system.startsWith(built.system.slice(0, 80)));
check('with a revision clause appended', /REVISION MODE/.test(svgRev.system));
check('the reader\'s words are quoted', svgRev.user.includes('the arrow points the wrong way'));
check('the colour note rides along on a dark page', /DARK page/.test(svgRev.user));
const p5Rev = reviseVisualPrompt('p5', 'function setup(){} function draw(){}', 'too fast', {});
check('a p5 sketch is revised by its own specialist', /p5\.js sketch engineer/.test(p5Rev.system) && /REVISION MODE/.test(p5Rev.system));
const mermaidRev = reviseVisualPrompt('mermaid', 'flowchart TD', 'add a step', {});
check('mermaid keeps the hint-driven revision', /Wrap EVERY node/.test(mermaidRev.system) && !/REVISION MODE/.test(mermaidRev.system));

section('revising a brief refuses to bloat it');
const briefRev = reviseVisualPrompt('animation', 'Shows: a.\nDraw: b.\nMoves: c.\nNotice: d.', 'start on the sides', { brief: true });
check('the brief hint says to return it UNCHANGED when it already says so', /return it UNCHANGED/.test(briefRev.system) || /UNCHANGED/.test(briefRev.system));
check('and forbids restating in more words', /Never restate/.test(briefRev.system));
check('the user turn repeats the rule', /return it word for word/.test(briefRev.user));
check('a brief revision never carries the SVG rules', !/animateTransform/.test(briefRev.system));

section('the caption prompt');
const cap = visualCaptionPrompt('animation', '<svg/>', 'Doppler effect');
check('asks for strict JSON with title and caption', /"title"/.test(cap.system) && /"caption"/.test(cap.system));
check('plain text only — it is painted onto a canvas', /no markdown, no LaTeX/.test(cap.system));
check('the context is passed', cap.user.includes('Doppler effect'));

/* ── client: label fit and export, bundled from the real source ──────────── */

async function bundle(rel, name) {
    const out = join(SCRATCH, name);
    await esbuild.build({
        entryPoints: [fileURLToPath(new URL(rel, import.meta.url))],
        bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    });
    return import(pathToFileURL(out).href);
}
const fit = await bundle('../src/components/visuals/svgLabelFit.ts', 'fit.mjs');
const exp = await bundle('../src/utils/exportVisual.ts', 'export.mjs');

section('fitViewBox — grow the frame around labels, never move them');
const frame = { x: 0, y: 0, w: 600, h: 340 };
check('nothing overflowing → null', fit.fitViewBox(frame, [{ x: 10, y: 10, w: 100, h: 14 }]) === null);
const right = fit.fitViewBox(frame, [{ x: 560, y: 100, w: 70, h: 14 }]);
check('a label past the right edge widens the frame by the overflow plus padding', right && right.x === 0 && right.w === 636, JSON.stringify(right));
const left = fit.fitViewBox(frame, [{ x: -20, y: -8, w: 50, h: 14 }]);
check('a label past the top-left moves the origin negative', left && left.x === -26 && left.y === -14, JSON.stringify(left));
check('height is untouched when only x overflows', right && right.h === 340);
check('a zero-size box is ignored', fit.fitViewBox(frame, [{ x: 900, y: 0, w: 0, h: 0 }]) === null);
check('a label a whole frame away refuses to grow (scene broken another way)', fit.fitViewBox(frame, [{ x: 1000, y: 0, w: 50, h: 14 }]) === null);
check('growth just under the cap is accepted', fit.fitViewBox(frame, [{ x: 600, y: 0, w: 300, h: 14 }]) !== null);

section('parseClockSeconds — the values SMIL accepts');
check('"2s" → 2', fit.parseClockSeconds('2s') === 2);
check('"500ms" → 0.5', fit.parseClockSeconds('500ms') === 0.5);
check('bare "1.5" → 1.5', fit.parseClockSeconds('1.5') === 1.5);
check('"0:03" → 3', fit.parseClockSeconds('0:03') === 3);
check('"-1s" → -1', fit.parseClockSeconds('-1s') === -1);
check('"indefinite" → null', fit.parseClockSeconds('indefinite') === null);
check('a syncbase "a.end" → null', fit.parseClockSeconds('a.end') === null);

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.XMLSerializer = window.XMLSerializer;
globalThis.DOMPoint = window.DOMPoint || class { constructor(x, y) { this.x = x; this.y = y; } matrixTransform() { return this; } };
const parseSvg = (s) => new window.DOMParser().parseFromString(s, 'image/svg+xml').documentElement;

section('animationLoopSeconds — one loop of the scene');
const svgA = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g><animateTransform attributeName="transform" type="translate" dur="3s" begin="1s" repeatCount="indefinite"/><animate attributeName="r" dur="2s" begin="0s; 0.5s"/></g></svg>');
check('the longest begin + dur wins (1s + 3s)', fit.animationLoopSeconds(svgA) === 4);
const svgLong = parseSvg('<svg xmlns="http://www.w3.org/2000/svg"><g><animate attributeName="r" dur="40s"/></g></svg>');
check('capped at 12s', fit.animationLoopSeconds(svgLong) === 12);
const svgNone = parseSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
check('no animation → the fallback', fit.animationLoopSeconds(svgNone) === 4);

section('svgDocumentAtTime — a frame is the scene with every begin shifted by -t');
const svgT = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 340" class="vb-anim-paused" style="width:100%"><g><animate attributeName="r" dur="3s"/><animate attributeName="cx" begin="1s; 3s" dur="3s"/><animate attributeName="cy" begin="indefinite" dur="3s"/><animateMotion begin="a.end" dur="1s"/></g></svg>');
const doc = exp.svgDocumentAtTime(svgT, 2, 640, 363);
check('a missing begin becomes -t', /begin="-2\.000s"/.test(doc));
check('a begin list is shifted term by term', /begin="-1\.000s; 1\.000s"/.test(doc));
check('"indefinite" is left alone', /begin="indefinite"/.test(doc));
check('a syncbase begin is left alone', /begin="a\.end"/.test(doc));
check('the document is sized for the raster', /width="640"/.test(doc) && /height="363"/.test(doc));
check('the renderer\'s pause class and inline style are gone', !/vb-anim-paused/.test(doc) && !/style="width/.test(doc));
check('xmlns is present so an <img> accepts it', /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(doc));
check('the source element is untouched', svgT.querySelector('animate').getAttribute('begin') === null);

section('wrapLines / layoutCard — the captioned card');
const mono = (s) => s.length * 10;
check('greedy wrap at the width', JSON.stringify(exp.wrapLines('one two three four', 90, mono)) === JSON.stringify(['one two', 'three', 'four']));
check('a word wider than the line is kept, not dropped', JSON.stringify(exp.wrapLines('abcdefghijklmnop', 50, mono)) === JSON.stringify(['abcdefghijklmnop']));
check('blank lines are skipped', exp.wrapLines('a\n\n\nb', 100, mono).length === 2);
const measure = (s, px, bold) => s.length * px * 0.55 * (bold ? 1.1 : 1);
const bare = exp.layoutCard(640, 360, { title: '', caption: '' }, measure);
check('no words → picture sits at the top margin', bare.picture.y === 32 && bare.width === 704 && bare.height === 360 + 64);
const full = exp.layoutCard(640, 360, { title: 'Doppler effect', caption: 'Crests bunch ahead of the source and spread behind it.' }, measure);
check('a title pushes the picture down', full.picture.y > 32 && full.titleLines.length === 1);
check('a caption adds rows below the picture', full.height > full.picture.y + 360 + 32 && full.captionLines.length >= 1);
const longTitle = exp.layoutCard(320, 200, { title: 'word '.repeat(40), caption: 'x '.repeat(400) }, measure);
check('title capped at two lines, caption at six', longTitle.titleLines.length === 2 && longTitle.captionLines.length === 6);

section('captionFromBrief / fileSlug');
const fromBrief = exp.captionFromBrief('Shows: a transverse wave travelling left to right.\nDraw: a string.\nMoves: it travels.\nNotice: the particle only goes up and down.');
check('a brief drafts its own title and caption', fromBrief && fromBrief.title === 'A transverse wave travelling left to right' && /up and down/.test(fromBrief.caption), JSON.stringify(fromBrief));
check('an SVG has no brief to draft from', exp.captionFromBrief('<svg viewBox="0 0 1 1"></svg>') === null);
check('a slug keeps letters of any script and drops the rest', exp.fileSlug('Doppler — effect (v=2)', 'x') === 'doppler-effect-v-2');
check('an empty title falls back', exp.fileSlug('   ', 'animation') === 'animation');

/* ── the trap the prompt now names ───────────────────────────────────────── */

section('why "white" needed a rule: the adapter maps a paper-white fill to the page');
const pal = await bundle('../src/components/visuals/palette.ts', 'palette.mjs');
const darkPalette = { dark: true, bg: '#0f172a', surface: '#1e293b', fg: '#f1f5f9', muted: '#94a3b8', border: '#334155', accent: '#0e7490', series: [] };
check('fill="#ffffff" on an assumed-paper scene becomes the dark page colour (invisible)', pal.adaptColor('#ffffff', darkPalette, 'fill') === '#0f172a');
check('fill="#111111" — the strongest ink — becomes the theme foreground', pal.adaptColor('#111111', darkPalette, 'fill') === '#f1f5f9');

/* ── the timing lists SMIL refuses silently ──────────────────────────────── */

section('sanitizer repairs the timing lists that made cached animations stand still');
const san = await bundle('../src/components/visuals/sanitizeSvgAnim.ts', 'sanitize.mjs');
globalThis.DOMParser = window.DOMParser;
globalThis.NodeFilter = window.NodeFilter;
globalThis.Node = window.Node;
const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;
const anim = (attrs) => wrap(`<g><rect width="10" height="10"/><animateTransform attributeName="transform" type="translate" ${attrs} dur="6s" repeatCount="indefinite"/></g>`);
const firstAnim = (svg) => svg.querySelector('animateTransform, animate');

let s1 = san.sanitizeAnimatedSvg(anim('values="0,0; 180,0; 180,0" keyTimes="0 0.5 1"'));
check('space-separated keyTimes (the cars that never moved) are rewritten with semicolons', firstAnim(s1).getAttribute('keyTimes') === '0;0.5;1');
let s2 = san.sanitizeAnimatedSvg(anim('values="0,0; 50,0; 90,0" keyTimes="0;0.4;0.82"'));
check('a list ending before 1 becomes a hold at the end (values padded to match)', firstAnim(s2).getAttribute('keyTimes') === '0;0.4;0.82;1' && firstAnim(s2).getAttribute('values') === '0,0;50,0;90,0;90,0');
let s3 = san.sanitizeAnimatedSvg(anim('values="0,0; 50,0" keyTimes="0.2;1"'));
check('a list not starting at 0 gets a leading 0 with the first value held', firstAnim(s3).getAttribute('keyTimes') === '0;0.2;1' && firstAnim(s3).getAttribute('values') === '0,0;0,0;50,0');
let s3b = san.sanitizeAnimatedSvg(anim('values="0,0; 50,0; 90,0; 100,0" keyTimes="0;0.3;0.6;0.9;1"'));
check('a count mismatch is cut to the shorter list and still ends at 1 (motion kept)', firstAnim(s3b).getAttribute('keyTimes') === '0;0.3;0.6;1' && firstAnim(s3b).getAttribute('values') === '0,0;50,0;90,0;100,0');
let s3c = san.sanitizeAnimatedSvg(anim('values="0,0; 50,0; 90,0; 100,0; 120,0" keyTimes="0;0.5;1"'));
check('extra values are dropped rather than disabling the animation', firstAnim(s3c).getAttribute('values') === '0,0;50,0;90,0' && firstAnim(s3c).getAttribute('keyTimes') === '0;0.5;1');
let threw = '';
try { san.sanitizeAnimatedSvg(wrap('<g><rect width="10" height="10"/><animateTransform attributeName="transform" type="translate" values="0,0;10,0" repeatCount="indefinite"/></g>')); } catch (e) { threw = e.message; }
check('a missing dur throws (an animation without a duration never runs)', /has no dur/.test(threw), threw);
threw = '';
try { san.sanitizeAnimatedSvg(anim('values="0,0; 50,0; 90,0" keyTimes="0;0.7;0.4"')); } catch (e) { threw = e.message; }
check('decreasing keyTimes throw', /never decrease/.test(threw), threw);
let s4 = san.sanitizeAnimatedSvg(anim('values="0,0; 50,0; 90,0" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.4 0 1 1"'));
check('a keySplines count that does not match the intervals is dropped, motion kept', !firstAnim(s4).hasAttribute('keySplines') && !firstAnim(s4).hasAttribute('calcMode'));
let s5 = san.sanitizeAnimatedSvg(anim('values="0,0; 50,0; 90,0" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.4 0 1 1; 0 0 1 1"'));
check('a matching keySplines is left alone', firstAnim(s5).getAttribute('keySplines') === '0.4 0 1 1; 0 0 1 1');
let s6 = san.sanitizeAnimatedSvg(anim('values="0,0; 50,0; 90,0" keyTimes="0; 0.5; 1"'));
check('a correct list survives byte-for-byte in meaning', firstAnim(s6).getAttribute('keyTimes') === '0;0.5;1' && firstAnim(s6).getAttribute('values') === '0,0;50,0;90,0');

section('the specialist names the defects the second batch of reports earned');
for (const rule of ['CONTACT', 'GROUNDING', 'MESHING', 'TIMING LISTS', 'ANIMATEMOTION ORIGIN']) {
    check(`animation specialist states ${rule}`, built.system.includes(rule));
}

section('the task queue runs in parallel only where the provider can');
const tasksMod = await import('../server/tasks.js');
let limit = 1;
tasksMod.setConcurrencyProvider(() => limit);
const gate = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };
const g1 = gate(), g2 = gate();
const t1 = tasksMod.createTask({ kind: 'test', label: 'one', run: () => g1.p }).task;
const t2 = tasksMod.createTask({ kind: 'test', label: 'two', run: () => g2.p }).task;
await new Promise(r => setTimeout(r, 10));
check('at a limit of 1 the second task waits', t1.status === 'running' && t2.status === 'queued');
limit = 3;
tasksMod.setConcurrencyProvider(() => limit);
await new Promise(r => setTimeout(r, 10));
check('raising the limit starts the queued task without a restart', t2.status === 'running');
g1.release({}); g2.release({});
await new Promise(r => setTimeout(r, 10));
check('a nonsense limit falls back to 1', (tasksMod.setConcurrencyProvider(() => NaN), true));
const conc = (await import('../server/ai.js')).aiConcurrency;
process.env.AI_CONCURRENCY = '';
check('the default provider (ollama) is serial', conc() === 1);
process.env.AI_CONCURRENCY = '4';
check('AI_CONCURRENCY overrides', conc() === 4);
process.env.AI_CONCURRENCY = '';

section('the rebuild percentage: two phases, a soft knee, and a thinking slice');
const prog = await bundle('../src/components/visuals/repairProgress.ts', 'progress.mjs');
const pct = prog.repairPercent;

// A single-pass repair owns the whole bar.
check('nothing yet reads 0%', pct({ phase: 'spec', chars: 0, est: 1000 }) === 0);
check('a single pass at its estimate is past halfway but short of the end',
    pct({ phase: 'spec', chars: 1000, est: 1000 }) > 60 && pct({ phase: 'spec', chars: 1000, est: 1000 }) < 95,
    String(pct({ phase: 'spec', chars: 1000, est: 1000 })));
check('twice its estimate still has not arrived', pct({ phase: 'spec', chars: 2000, est: 1000 }) < 99);
check('ten times its estimate still has not arrived', pct({ phase: 'spec', chars: 10000, est: 1000 }) < 100);
check('but it is still moving out there',
    pct({ phase: 'spec', chars: 10000, est: 1000 }) > pct({ phase: 'spec', chars: 3000, est: 1000 }));

// The thinking stretch is the one that reads as a stall: no answer characters
// exist yet, so without this the bar cannot move at all while the model reasons.
check('reasoning alone moves the bar off zero', pct({ phase: 'draw', thinking: 400, chars: 0, est: 4000 }) > pct({ phase: 'draw', thinking: 0, chars: 0, est: 4000 }));
check('and keeps moving as it reasons', pct({ phase: 'draw', thinking: 4000, chars: 0, est: 4000 }) > pct({ phase: 'draw', thinking: 400, chars: 0, est: 4000 }));
check('reasoning can never fill the phase on its own',
    pct({ phase: 'draw', thinking: 1e6, chars: 0, est: 4000 }) < pct({ phase: 'draw', thinking: 0, chars: 1, est: 4000 }) + 2);

// The two phases of a brief-backed rebuild own separate bands, so the drawing
// (the long call) is not squeezed into the last few percent.
const briefTop = pct({ phase: 'brief', chars: 100000, est: 800 });
const drawFloor = pct({ phase: 'draw', chars: 0, thinking: 0, est: 4000 });
check('the words phase is capped well short of the end', briefTop < 30, String(briefTop));
check('the drawing phase starts where the words phase stopped', drawFloor >= briefTop, `${briefTop} -> ${drawFloor}`);
check('the drawing owns most of the bar', pct({ phase: 'draw', chars: 4000, est: 4000 }) - drawFloor > 40);

// One simulated run, the shape the endpoint actually emits.
const run = [
    { phase: 'brief', chars: 0, thinking: 0, est: 900 },
    { phase: 'brief', chars: 0, thinking: 300, est: 900 },
    { phase: 'brief', chars: 400, thinking: 300, est: 900 },
    { phase: 'brief', chars: 950, thinking: 300, est: 900 },
    { phase: 'draw', chars: 0, thinking: 0, est: 5200 },
    { phase: 'draw', chars: 0, thinking: 2500, est: 5200 },
    { phase: 'draw', chars: 900, thinking: 2500, est: 5200 },
    { phase: 'draw', chars: 5200, thinking: 2500, est: 5200 },
    { phase: 'draw', chars: 9000, thinking: 2500, est: 5200 },
];
const walk = run.map(pct);
check('the whole run is monotone', walk.every((v, i) => i === 0 || v >= walk[i - 1]), walk.join(' '));
check('it never reaches 100 before the render does', walk.every(v => v < 100), walk.join(' '));
check('and it is not pinned at the top for the whole drawing',
    walk[walk.length - 1] - walk[4] > 30, walk.join(' '));

// Degenerate inputs: the server may not know an estimate.
check('a missing estimate is a number, not NaN', Number.isFinite(pct({ phase: 'draw', chars: 500 })));
check('a zero estimate is a number, not Infinity', Number.isFinite(pct({ phase: 'draw', chars: 500, est: 0 })));
check('an unknown phase falls back to the whole bar', pct({ chars: 500, est: 500 }) > 0);
check('nothing is ever negative', pct({ phase: 'spec', chars: -5, thinking: -5, est: 100 }) >= 0);

check('the counter text names what is being counted while it reasons',
    /^thinking 1.234 chars$/.test(prog.progressCounter({ phase: 'draw', chars: 0, thinking: 1234 })));
check('and switches to the answer once it starts writing',
    /^2.140 chars$/.test(prog.progressCounter({ phase: 'draw', chars: 2140, thinking: 1234 })));
check('with nothing to count it says nothing', prog.progressCounter({ phase: 'draw', chars: 0, thinking: 0 }) === '');


// The endpoint writes these four field names and the client reads them; nothing
// at runtime notices a rename, the bar just stops moving. Text parity, the same
// trick the authoring briefs are held to.
section('server and client agree on the progress frame');
const endpointSrc = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
// The rebuild is a background task (2026-09-07): its body lives in
// `runVisualRepair`, defined directly above the route, so the block is sliced
// from the function rather than from the route.
const repairStart = endpointSrc.indexOf('async function runVisualRepair(');
const repairBlock = endpointSrc.slice(repairStart >= 0 ? repairStart : endpointSrc.indexOf("app.post('/api/ai/repair-visual'"), endpointSrc.indexOf("app.post('/api/ai/visual/caption'"));
const apiBlock = apiSrc.slice(apiSrc.indexOf('repairVisual: async ('), apiSrc.indexOf('compileWidget: async ('));
for (const field of ['phase', 'chars', 'thinking', 'est']) {
    check(`the endpoint emits ${field}`, new RegExp(`\\b${field}\\b`).test(repairBlock));
    check(`the client reads ${field}`, new RegExp(`json\\.${field}|${field}: json\\.`).test(apiBlock));
}
check('both phase names the client bands are emitted', /'brief'/.test(repairBlock) && /'draw'/.test(repairBlock));
check('the drawing pass no longer squashes its length into the brief scale', !/progress \/ 8/.test(repairBlock));

/* ── brief-vs-spec: two copies of one test ───────────────────────────────── */
//
// "Is this fence a brief or a finished spec?" is decided by LOOKING, in two
// places that must agree: `isVisualBrief` on the server (the pre-generator) and
// the copy in src/components/visuals/resolveBrief.ts (the renderer). Disagree
// and the feed pre-builds nothing while every card asks the reader to press a
// button, or the renderer sends a finished scene away to be redrawn.
//
// Compared as SOURCE TEXT rather than by bundling the client module, which
// pulls in the api and i18n singletons. The parity that matters is the two
// regexes and the two kind sets — the same shape as visual-registry-gates.
section('the server and the renderer decide "brief or spec" the same way');
const authorSrc = readFileSync(new URL('../server/visualAuthor.js', import.meta.url), 'utf8');
const briefSrc = readFileSync(new URL('../src/components/visuals/resolveBrief.ts', import.meta.url), 'utf8');
const briefTests = (src) => {
    const start = src.indexOf('isVisualBrief(');
    const body = src.slice(start, src.indexOf('\n}', start));
    return [...body.matchAll(/\/(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[gimsuy]*/g)].map(m => m[0]);
};
const serverTests = briefTests(authorSrc);
const clientTests = briefTests(briefSrc);
check('the server states two tests, one per hard kind', serverTests.length === 2, serverTests.join(' '));
check('and the renderer states the same two, character for character',
    serverTests.join('\n') === clientTests.join('\n'),
    `${serverTests.join(' ')}  vs  ${clientTests.join(' ')}`);

const serverKinds = [...(await import('../server/ai.js')).VISUAL_BRIEF_KINDS].sort();
const clientKinds = (briefSrc.match(/BRIEF_KINDS[^=]*=\s*new Set\(\[([^\]]*)\]\)/) || [, ''])[1]
    .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
check('VISUAL_BRIEF_KINDS is the two kinds the specialist authors',
    serverKinds.join(',') === 'animation,p5', serverKinds.join(','));
check('and BRIEF_KINDS on the client is the same set',
    clientKinds.join(',') === serverKinds.join(','), `${clientKinds.join(',')} vs ${serverKinds.join(',')}`);

// ai.js opened the scratch database at import; Windows refuses to delete an
// open file, so close it first and treat a leftover temp dir as cosmetic.
try { (await import('../server/database.js')).default.close(); } catch { /* already closed */ }
try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

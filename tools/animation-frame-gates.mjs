// tools/animation-frame-gates.mjs — an AI-drawn animation fits a phone.
//
// Run:  node tools/animation-frame-gates.mjs
//
// WHY. An animation's stage never lets its smallest label paint under 12px:
// past that it grows wider than the card and the learner swipes sideways inside
// it (renderAnimation.ts). The drawing rules asked for 16-unit text on a frame
// about 600 units wide, and a phone draws the scene about 280-340px wide, so
// 16 units reached the screen at 7-9px and the floor pushed the picture past
// the edge. Measured 1 Nov 2026 in Edge over 40 scenes drawn to those rules:
// 39 had to be swiped on a 390px phone (lesson card), and 82 older cached ones
// pan too. Nothing errors; the picture is simply cut at the right edge.
//
// The fix is in the drawing rules, so the scene is drawn for a phone in the
// first place: a frame whose width and smallest type, put through the
// renderer's own stage rule at the narrowest phone, need no sideways room.
// This gate reads the TEXT the drawing model reads (the specialist prompt and
// the repair hint), takes the numbers it states, and runs them through the
// renderer's stage function. No model, no network, no real database.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'animation-frame-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

// The width the stage is offered on a phone, measured in Edge on 1 Nov 2026
// (`.visual-block-stage` minus its padding and borders, i.e. ctx.width):
//   lesson card at a 360px phone 279, at 390px 309; the assistant drawer at
//   360px 307, at 390px 337; on a 1280px desktop 559 (lesson) and 459 (drawer).
// 360px is the narrowest phone width still in common use, and the lesson card
// is the narrower of the two surfaces, so 279 is the width a scene must fit.
const NARROWEST_STAGE = 279;
const PHONE_STAGES = { 'lesson, 360px phone': 279, 'drawer, 360px phone': 307, 'lesson, 390px phone': 309, 'drawer, 390px phone': 337 };
const DESKTOP_STAGES = { 'lesson, 1280px desktop': 559, 'drawer, 1280px desktop': 459 };

// ---------------------------------------------------------------------------
section('the frame the drawing model is told to draw in');

const ai = await import(pathToFileURL(join(repoRoot, 'server/ai.js')).href);
const specialist = ai.visualAuthorPrompt('animation', 'Shows: a ball.').system;
// VISUAL_REPAIR_HINTS is module-private: read its animation entry from source.
const repairHint = /^\s+animation: '(Output ONE complete[^\n]*)',$/m.exec(read('server/ai.js'))?.[1] ?? '';

// Spaces, commas or both separate a viewBox's numbers; any of them names a frame.
const viewBoxes = (text) => [...text.matchAll(/viewBox="\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*"/g)]
    .map(m => ({ w: +m[1], h: +m[2] }));
const frames = viewBoxes(specialist);
const widths = [...new Set(frames.map(f => f.w))];
check('the specialist names its frame with a viewBox example', frames.length > 0);
check('every viewBox the specialist shows has the same width (one frame, not a suggestion)',
    widths.length === 1, `widths: ${widths.join(', ')}`);
const W = widths[0];

check('the specialist never names another frame width',
    !new RegExp(`\\b(?!${W}\\b)(?:[2-9]\\d\\d|1\\d\\d\\d) units wide`).test(specialist)
    && !/about 600 units wide/.test(specialist),
    'a sentence still describes a wider frame');

const minText = /no text below (\d+) units/.exec(specialist);
check('the specialist states one minimum text size', !!minText);
const S = minText ? Number(minText[1]) : NaN;

// Every size the specialist asks text to be drawn at, single values and ranges
// (`sizes` the low ends, which must clear the minimum; `largest` the top end).
const sizes = [];
let largest = 0;
const asked = (lo, hi) => { sizes.push(Number(lo)); largest = Math.max(largest, Number(hi ?? lo)); };
for (const m of specialist.matchAll(/font-size (\d+)(?:[–-](\d+))?/g)) asked(m[1], m[2]);
for (const m of specialist.matchAll(/labels (\d+)[–-](\d+)/g)) asked(m[1], m[2]);
for (const m of specialist.matchAll(/title (\d+)[–-](\d+)/g)) asked(m[1], m[2]);
check('no text size the specialist asks for is below its own minimum',
    sizes.length > 0 && sizes.every(n => n >= S), `sizes ${sizes.join(', ')} vs minimum ${S}`);

// The animation repair hint fixes a finished spec; when a viewBox is missing
// it suggests one, and that suggestion must be the same frame.
const hintFrames = viewBoxes(repairHint);
check('the animation repair hint suggests the same frame',
    hintFrames.length > 0 && hintFrames.every(f => f.w === W), JSON.stringify(hintFrames));
const sanitizerFrames = viewBoxes(read('src/components/visuals/sanitizeSvgAnim.ts'));
check('the sanitizer\'s "needs a viewBox" error suggests the same frame',
    sanitizerFrames.length > 0 && sanitizerFrames.every(f => f.w === W), JSON.stringify(sanitizerFrames));

// ---------------------------------------------------------------------------
section('a scene drawn to those rules needs no sideways swipe on a phone 360px or wider');

let stage = null;
try {
    const outfile = join(scratch, 'animationStage.mjs');
    await esbuild.build({
        entryPoints: [join(repoRoot, 'src/components/visuals/animationStage.ts')],
        bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
    });
    stage = await import(pathToFileURL(outfile).href);
} catch { stage = null; }
check('the stage rule is a pure function the gate can run (animationStage.ts)',
    typeof stage?.legibleStageWidth === 'function');
const anim = read('src/components/visuals/renderAnimation.ts');
check('renderAnimation sizes its stage with that same function',
    /from '\.\/animationStage'/.test(anim) && /legibleStageWidth\(/.test(anim));
const floorPx = stage?.MIN_LABEL_PX ?? Number(/MIN_LABEL_PX = (\d+)/.exec(anim)?.[1]);
check('the floor it protects is still the app\'s 12px', floorPx === 12, String(floorPx));

const widthFor = (frameW, smallest, ctxWidth) => stage
    ? stage.legibleStageWidth(frameW, smallest, ctxWidth)
    : Math.max(ctxWidth, Math.round(frameW * (floorPx / smallest)));
for (const [where, px] of Object.entries(PHONE_STAGES)) {
    const got = widthFor(W, S, px);
    check(`${where}: the stage stays the card's width (${px}px)`, got === px,
        `the stage asks for ${got}px, a ${got - px}px sideways swipe`);
}
const painted = S * NARROWEST_STAGE / W;
check(`the smallest text paints at ${floorPx}px or more on the narrowest phone`,
    painted >= floorPx, `${S} units on a ${W}-unit frame at ${NARROWEST_STAGE}px = ${painted.toFixed(1)}px`);

// The other side: the same phone-sized frame across a wide desktop card would
// paint its labels at 25px and its title at 31px. The stage stops at the
// ceiling there, and the ceiling never undoes the floor anywhere.
const ceilingPx = stage?.MAX_LABEL_PX;
check('the stage has a label ceiling above the floor', Number.isFinite(ceilingPx) && ceilingPx > floorPx, String(ceilingPx));
for (const [where, px] of Object.entries(DESKTOP_STAGES)) {
    const got = widthFor(W, S, px);
    const paintsAt = S * got / W;
    check(`${where}: the smallest text paints between ${floorPx} and ${ceilingPx ?? '(no ceiling)'}px, no wider than the card`,
        got <= px && paintsAt >= floorPx && paintsAt <= ceilingPx + 0.05,
        `stage ${got}px, smallest text ${paintsAt.toFixed(1)}px`);
}
const ceilingFaults = [];
for (const frameW of [300, 360, 600, 900]) {
    for (const smallest of [6, 8, 10, 12, 16, 20, 24, 32]) {
        for (const ctxWidth of [260, 279, 309, 337, 459, 559, 680, 900]) {
            if (!stage) break;
            const available = stage.availableStageWidth(ctxWidth);
            const noCeiling = Math.max(available, Math.min(
                Math.round(frameW * floorPx / smallest), stage.MAX_OVERFLOW_WIDTH, Math.round(available * stage.MAX_PAN)));
            const got = widthFor(frameW, smallest, ctxWidth);
            const pans = noCeiling > available;
            // A panning stage is exactly what it was; any other stage still
            // paints its smallest label at the floor or above.
            const ok = pans ? got === noCeiling : smallest * got / frameW >= floorPx - 0.05;
            if (!ok) ceilingFaults.push(`${frameW}u/${smallest}u at ${ctxWidth}px: ${got} (was ${noCeiling})`);
        }
    }
}
check('the ceiling never narrows a stage below the floor, nor changes one that pans',
    !!stage && ceilingFaults.length === 0, ceilingFaults.slice(0, 4).join('; '));
// Both limits exist for text. A scene that draws none has no label to keep
// readable or to keep from shouting, so it is the card's width everywhere.
const unlabelled = Object.entries({ ...PHONE_STAGES, ...DESKTOP_STAGES })
    .map(([where, px]) => [where, px, stage ? stage.legibleStageWidth(W, null, px) : NaN])
    .filter(([, px, got]) => got !== px);
check('a scene with no text is the card\'s width on every phone and desktop card',
    !!stage && unlabelled.length === 0, unlabelled.map(([where, px, got]) => `${where}: ${got}px, card ${px}px`).join('; '));
check('renderAnimation tells the stage rule when a scene has no text',
    /legibleStageWidth\([^;]*\?\s*smallestLabelUnits\([^)]*\)\s*:\s*null/.test(anim));
// The ceiling is for wide cards: even a scene whose smallest text is the
// largest size the rules ask for (a title alone) still fills a phone's card.
for (const [where, px] of Object.entries(PHONE_STAGES)) {
    const got = widthFor(W, largest, px);
    check(`${where}: a scene whose only text is ${largest} units still fills the card`, got === px,
        `the stage is ${got}px of ${px}px`);
}

const stated = /drawn about (\d+)px wide on the narrowest/.exec(specialist);
check('the specialist tells the model the phone width the gate assumes',
    !!stated && Math.abs(Number(stated[1]) - NARROWEST_STAGE) <= 5,
    stated ? `says ${stated[1]}px, measured ${NARROWEST_STAGE}px` : 'no "drawn about Npx wide on the narrowest" sentence');

// ---------------------------------------------------------------------------
section('the worked examples fit the frame they are given for');

// A technique written for a wider frame teaches the model to draw past the
// edge of this one. Every coordinate the examples use stays inside it: x
// within the width, y within the tallest frame the rules allow.
const techniques = specialist.slice(specialist.indexOf('TECHNIQUES'));
const tallest = Math.max(...frames.map(f => f.h));
const outside = [];
let points = 0;
for (const [, d] of techniques.matchAll(/ d="([^"]+)"/g)) {
    for (const [, cmd, args] of d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
        const n = [...args.matchAll(/-?\d+(?:\.\d+)?/g)].map(x => Number(x[0]));
        if (cmd === 'Z' || cmd === 'z') continue;
        // Absolute commands only: a relative one teaches no position.
        if (cmd !== cmd.toUpperCase()) { outside.push(`${cmd} is relative`); continue; }
        const xs = cmd === 'H' ? n : cmd === 'V' ? [] : n.filter((_, i) => i % 2 === 0);
        const ys = cmd === 'V' ? n : cmd === 'H' ? [] : n.filter((_, i) => i % 2 === 1);
        points += xs.length + ys.length;
        for (const x of xs) if (x < 0 || x > W) outside.push(`${cmd} x=${x}`);
        for (const y of ys) if (y < 0 || y > tallest) outside.push(`${cmd} y=${y}`);
    }
}
check('every point of every path in the examples is inside the frame',
    points > 0 && outside.length === 0, outside.join(', ') || 'no path found');
const shifts = [...techniques.matchAll(/type="translate" values="([^"]+)"/g)]
    .flatMap(m => m[1].split(';').map(p => Math.abs(Number(p.trim().split(/\s+/)[0]))));
check('no example translates a thing further than the frame is wide',
    shifts.length > 0 && shifts.every(x => x <= W), `shifts ${shifts.join(', ')}`);
const tiles = [...techniques.matchAll(/a tile (\d+) wide/g)].map(m => Number(m[1]));
check('a scrolling tile is no wider than the frame',
    tiles.length > 0 && tiles.every(t => t <= W), tiles.length ? `tiles ${tiles.join(', ')}` : 'no "a tile N wide" example');
const source = /x = (\d+) \+ (\d+)·t over dur="(\d+)s"/.exec(techniques);
const crest = /attributeName="r" values="[\d;]*?;(\d+)"/.exec(techniques);
const [x0, end, r] = source && crest
    ? [Number(source[1]), Number(source[1]) + Number(source[2]) * Number(source[3]), Number(crest[1])]
    : [NaN, NaN, NaN];
check('the emission example\'s crests stay inside the frame: the first and the last, at full size',
    x0 - r >= 0 && end + r <= W,
    source && crest ? `source ${x0} to ${end}, crests grow to r = ${r}: ${x0 - r} to ${end + r} on a ${W}-unit frame` : 'example not found');

// The scratch database is still open (ai.js opened it on import).
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

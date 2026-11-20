// tools/chat-stream-gates.mjs — how often the assistant redraws an arriving answer.
//
// Run:  node tools/chat-stream-gates.mjs
//
// The drawer draws the arriving answer as one markdown document and parses it
// whole on every render. Measured with a stub model (about 14 s per answer, a
// few words a chunk): one render per chunk kept the page's main thread busy
// for 10.7-12.0 s of each answer; painting at most every 80 ms took it to
// 3.6-4.5 s with the same text on screen.
//
// Two rules hold that down:
//   - the arriving text goes through createPaintCoalescer, which paints at most
//     once per interval and always paints the NEWEST text; an empty text paints
//     at once and drops a waiting paint, so the last answer is never painted
//     over the start of the next turn;
//   - a settled message's Markdown gets the same onRepaired function on every
//     render. An arrow written inline in the JSX is a new function each time,
//     which defeats the memo and re-parsed every message above the answer on
//     every chunk.
//
// No DOM, no model: the coalescer is pure and runs on a fake clock here.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok    ${name}`); }
    else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const scratch = mkdtempSync(join(tmpdir(), 'chat-stream-gates-'));
const out = join(scratch, 'paintCoalescer.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/paintCoalescer.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: out,
    logLevel: 'silent',
});
const { createPaintCoalescer } = await import(pathToFileURL(out).href);
rmSync(scratch, { recursive: true, force: true });

// A fake clock: timers run only when the test says time passed.
function fakeTimers() {
    let now = 0;
    let nextId = 1;
    const pending = new Map();
    return {
        timers: {
            set: (fn, ms) => { const id = nextId++; pending.set(id, { fn, at: now + ms }); return id; },
            clear: (id) => { pending.delete(id); },
        },
        advance(ms) {
            now += ms;
            for (const [id, t] of [...pending]) {
                if (t.at <= now && pending.has(id)) { pending.delete(id); t.fn(); }
            }
        },
        waiting: () => pending.size,
    };
}

console.log('\n[paint coalescer]');
{
    const clock = fakeTimers();
    const painted = [];
    const c = createPaintCoalescer((t) => painted.push(t), 80, clock.timers);
    let text = '';
    for (let i = 0; i < 100; i++) { text += `w${i} `; c.push(text); }
    check('100 pieces inside one interval paint nothing yet', painted.length === 0, `painted ${painted.length}`);
    check('...and wait on ONE timer, not one per piece', clock.waiting() === 1, `${clock.waiting()} timers`);
    clock.advance(80);
    check('one paint when the interval ends', painted.length === 1, `painted ${painted.length}`);
    check('...and it is the newest text', painted[0] === text);

    // A steady stream: 60 pieces a second for 2 s.
    painted.length = 0;
    for (let i = 0; i < 120; i++) { text += 'x'; c.push(text); clock.advance(1000 / 60); }
    clock.advance(80);
    check('120 pieces over 2 s paint about 2000/80 times, not 120',
        painted.length >= 20 && painted.length <= 27, `painted ${painted.length}`);
    check('the last paint is the whole text', painted[painted.length - 1] === text);
}
{
    const clock = fakeTimers();
    const painted = [];
    const c = createPaintCoalescer((t) => painted.push(t), 80, clock.timers);
    c.push('old answer');
    c.push('');
    check('an empty text paints at once', painted.length === 1 && painted[0] === '', JSON.stringify(painted));
    check('...and drops the paint that was waiting', clock.waiting() === 0, `${clock.waiting()} timers`);
    clock.advance(200);
    check('the old answer is never painted after the reset', !painted.includes('old answer'), JSON.stringify(painted));
    c.push('new');
    clock.advance(80);
    check('the next turn paints its own text', painted[painted.length - 1] === 'new', JSON.stringify(painted));
}
{
    const clock = fakeTimers();
    const painted = [];
    const c = createPaintCoalescer((t) => painted.push(t), 80, clock.timers);
    c.push('half an answer');
    c.cancel();
    clock.advance(200);
    check('cancel (the drawer unmounting) drops a waiting paint', painted.length === 0, JSON.stringify(painted));
}

console.log('\n[the drawer uses it]');
{
    const src = readFileSync(new URL('../src/components/AssistantDrawer.tsx', import.meta.url), 'utf8');
    check('the arriving text goes through createPaintCoalescer',
        /createPaintCoalescer\(\s*setStreamedNow\s*,/.test(src));
    const direct = (src.match(/\bsetStreamedNow\b/g) || []).length;
    check('nothing else sets the visible text directly (the state + the coalescer only)', direct === 2, `${direct} uses`);
    check('no inline arrow for onRepaired (it defeats the Markdown memo)',
        !/onRepaired=\{\s*\(/.test(src) && !/onRepaired=\{\s*[a-zA-Z_$]+\s*=>/.test(src));
    check('a settled message keeps one onRepaired function per message', /onRepaired=\{repairHandlerFor\(/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

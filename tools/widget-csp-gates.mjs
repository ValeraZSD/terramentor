// tools/widget-csp-gates.mjs — the widget sandbox's network lock is ours,
// whatever the model's markup says.
//
// Run:  node tools/widget-csp-gates.mjs [--builder <path to a renderWidget.ts>] [--ai <path to an ai.js>]
//
// The second half is the PHONE half of the same head (`widgetTouch.ts`): a
// mouse-only build's drag target gets touch-action: none and a finger reaches
// it as mouse events, a build handling pointers itself is left alone, and the
// compiler's prompt asks for pointer events and 44px controls.
//
// Why this exists: a compiled widget is a model-written HTML document run in
// a sandboxed iframe (allow-scripts, opaque origin). What keeps it off the
// network is ONE element — the CSP meta `buildWidgetDoc` adds — and that
// element only counts if the parser puts it in <head> before anything the
// build wrote. The builder used to find the first textual `<head…>` with a
// regex and splice after it, so `<!-- <head> --><head></head>` put the whole
// injection inside a comment, and a `<header>` in a head-less build put it in
// the BODY, where a CSP meta is ignored. Either way the widget could fetch.
//
// This parses the builder's output with a real HTML parser (jsdom, parse5)
// for hostile and ordinary shapes and asserts, for each:
//   - the CSP meta is the FIRST element child of document.head, full policy;
//   - the theme style and the harness script are in <head> as elements;
//   - the theme tail is a real script after the build's own content;
//   - an ordinary widget keeps its own head elements, body and script.
// `--builder` runs the same cases against another copy of the file (the
// control: `git show HEAD:src/components/visuals/renderWidget.ts`).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argAt = process.argv.indexOf('--builder');
const builderPath = argAt !== -1 ? resolve(process.argv[argAt + 1]) : join(root, 'src/components/visuals/renderWidget.ts');
const aiAt = process.argv.indexOf('--ai');
const aiPath = aiAt !== -1 ? resolve(process.argv[aiAt + 1]) : join(root, 'server/ai.js');

const cache = join(root, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'widget-csp-gates-'));
const out = join(scratch, 'bundle.cjs');

// The builder reads the host's root font size off the live document.
const host = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = host.window;
globalThis.document = host.window.document;
globalThis.getComputedStyle = host.window.getComputedStyle.bind(host.window);

const stubs = {
    store: 'export const useStore = () => undefined;',
    api: 'export const api = {};',
    i18n: 'export default { t: (k) => k, language: "en" }; export const currentLocale = () => "en-GB";',
};
// The builder's file is bundled from its CONTENTS with the visuals folder as
// its resolve dir, so a copy of it anywhere on disk resolves the same siblings.
await esbuild.build({
    stdin: {
        contents: readFileSync(builderPath, 'utf8') + '\nexport { WIDGET_THEME_TAIL as __TAIL } from "./widgetTheme";',
        resolveDir: join(root, 'src/components/visuals'),
        loader: 'ts',
        sourcefile: 'renderWidget.ts',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out,
    packages: 'external',
    plugins: [{
        name: 'stubs',
        setup(b) {
            b.onResolve({ filter: /(^|\/)(?:\.\.\/)+(api|store|i18n)$/ }, a => ({ path: a.path.split('/').pop(), namespace: 'stub' }));
            b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: stubs[a.path], loader: 'js' }));
        },
    }],
    logLevel: 'silent',
});
const { buildWidgetDoc, __TAIL: TAIL } = require(out);
rmSync(scratch, { recursive: true, force: true });

const POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;";
const palette = {
    theme: 'light:#ffffff', dark: false, bg: '#ffffff', fg: '#0f172a', muted: '#64748b', border: '#e2e8f0',
    accent: '#0e7490', accentFg: '#0e7490', accent2: '#b45309', series: ['#0e7490', '#b45309', '#7c3aed'],
};
const TOKEN = 'tok-csp-gate';
// What the build itself does: a marked script, so we can find it after parsing.
const BUILD = '<div id="w">widget</div><script>/*BUILD*/window.x=1;</script>';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) pass++; else fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra ? `  — ${extra}` : ''}`);
};

function inspect(label, html, { ownHead = [] } = {}) {
    for (const probe of [false, true]) {
        const doc = buildWidgetDoc(html, TOKEN, { probe, palette });
        const d = new JSDOM(doc).window.document;
        const tag = `${label}${probe ? ' (probe)' : ''}`;
        const first = d.head && d.head.firstElementChild;
        check(`${tag}: the CSP meta is the first element in <head>`,
            !!first && first.localName === 'meta'
            && (first.getAttribute('http-equiv') || '').toLowerCase() === 'content-security-policy',
            first ? `first is <${first.localName}>` : 'no head child');
        check(`${tag}: … with the whole policy`, first?.getAttribute('content') === POLICY, first?.getAttribute('content'));
        check(`${tag}: the theme style and the harness are head elements`,
            d.head.querySelector('style#__w-theme') !== null
            && [...d.head.querySelectorAll('script')].some(s => s.textContent.includes(JSON.stringify(TOKEN))));
        const scripts = [...d.querySelectorAll('script')];
        const build = scripts.findIndex(s => s.textContent.includes('/*BUILD*/'));
        const tail = scripts.findIndex(s => s.textContent === TAIL);
        check(`${tag}: the build's own script survives, and the tail runs after it`,
            build !== -1 && tail > build, `build #${build}, tail #${tail}`);
        check(`${tag}: nothing we inject is left as text`,
            !d.documentElement.textContent.includes('Content-Security-Policy')
            && ![...d.querySelectorAll('*')].some(el => [...el.attributes].some(a => a.value.includes('Content-Security-Policy') && el !== first)));
        for (const sel of ownHead) {
            check(`${tag}: the build's own ${sel} stays in <head>`, d.head.querySelector(sel) !== null);
        }
    }
}

console.log(`builder: ${builderPath}\n`);

// Ordinary shapes the compiler actually produces.
inspect('a full document', `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pendulum</title><style>#w{color:red}</style></head><body>${BUILD}</body></html>`,
    { ownHead: ['title', 'style:not(#__w-theme)', 'meta[charset]'] });
inspect('no <head>', `<!doctype html><html><body>${BUILD}</body></html>`);
inspect('no <html> at all', BUILD);
inspect('upper-case tags', `<!DOCTYPE HTML><HTML><HEAD><STYLE>#w{}</STYLE></HEAD><BODY>${BUILD}</BODY></HTML>`, { ownHead: ['style:not(#__w-theme)'] });
inspect('two <head>s', `<!doctype html><html><head><style>#w{}</style></head><head></head><body>${BUILD}</body></html>`, { ownHead: ['style:not(#__w-theme)'] });
inspect('a leading BOM and whitespace', `﻿  \n<!doctype html><html><head><style>#w{}</style></head><body>${BUILD}</body></html>`, { ownHead: ['style:not(#__w-theme)'] });

// Hostile shapes: the first textual `<head` is not the head.
inspect('<head> inside a comment', `<!doctype html><html><!-- <head> --><head></head><body>${BUILD}</body></html>`);
inspect('<head> inside an attribute value', `<!doctype html><html data-x="<head>"><head></head><body>${BUILD}</body></html>`);
inspect('<head> inside <title>', `<!doctype html><html><title><head></title><body>${BUILD}</body></html>`);
inspect('<head> inside a script string', `<!doctype html><html><script>var s = "<head>";</script><body>${BUILD}</body></html>`);
inspect('a <header> and no <head>', `<!doctype html><html><body><header>Title</header>${BUILD}</body></html>`);
inspect('<head> inside a <textarea>', `<!doctype html><html><body><textarea><head></textarea>${BUILD}</body></html>`);
inspect('</body> inside a trailing comment', `<!doctype html><html><head></head><body>${BUILD}</body></html><!-- </body> -->`);

// ---------------------------------------------------------------------------
// The same head carries the phone half (`widgetTouch.ts`), because a cached
// build is mouse-only and only the host can reach it without a rebuild. Run
// against HEAD's builder, every POSITIVE check below fails (nothing sets
// touch-action, a touch pointer reaches a mouse-only build as nothing). The
// negatives — a mouse, a slider, a pointer-handling build, a list — pass on
// HEAD too: they pin what the touch half must leave alone, not the fix.
// jsdom has no layout and no `elementFromPoint`, so a move lands on the drag's
// own target, and the slider checks stand heights in by hand; what a slider
// looks like grown is measured in Edge (temp/phone-widget), not here.
console.log('\nthe phone half of the head');

// A touch screen by default (`maxTouchPoints`); `{ touch: false }` is a desktop.
async function run(body, beforeParse, { touch = true } = {}) {
    const doc = buildWidgetDoc(`<!doctype html><html><head></head><body>${body}</body></html>`, TOKEN, { probe: false, palette });
    const dom = new JSDOM(doc, { runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(win) {
        Object.defineProperty(win.navigator, 'maxTouchPoints', { value: touch ? 5 : 0, configurable: true });
        beforeParse?.(win);
    } });
    await new Promise((r) => dom.window.addEventListener('load', () => setTimeout(r, 0)));
    return dom.window;
}
const pointer = (w, type, target, init = {}) => {
    const e = new w.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 7, isPrimary: true, pointerType: 'touch', ...init });
    target.dispatchEvent(e);
    return e;
};
// A drag written the way the compiler wrote them: mouse handlers only.
const MOUSE_ONLY = `<input id="r" type="range"><button id="b">Go</button><canvas id="c"></canvas><div id="p"></div>
<script>window.got=[];const c=document.getElementById('c');
c.addEventListener('mousedown',e=>got.push('down@'+e.clientX+':'+e.buttons));
window.addEventListener('mousemove',e=>got.push('move@'+e.clientX+':'+e.buttons));
window.addEventListener('mouseup',e=>got.push('up@'+e.clientX));
document.getElementById('p').onmousedown=()=>got.push('prop');
document.getElementById('b').addEventListener('mousedown',()=>{});
document.addEventListener('mousedown',()=>{});</script>`;

{
    const w = await run(MOUSE_ONLY);
    const d = w.document, c = d.getElementById('c');
    check('a canvas the build drags gets touch-action: none', c.style.touchAction === 'none', `"${c.style.touchAction}"`);
    check('… and so does an element given an onmousedown property', d.getElementById('p').style.touchAction === 'none');
    check('the page, the body and native controls keep their own (the page still scrolls)',
        !d.documentElement.style.touchAction && !d.body.style.touchAction
        && !d.getElementById('r').style.touchAction && !d.getElementById('b').style.touchAction);
    const down = pointer(w, 'pointerdown', c, { clientX: 40, clientY: 10 });
    pointer(w, 'pointermove', c, { clientX: 120, clientY: 12 });
    pointer(w, 'pointerup', c, { clientX: 130, clientY: 12 });
    // A mouse is over a point before it presses there, so a build that reads
    // where the pointer is from its last mousemove picks the right place.
    check('a finger dragging a mouse-only canvas arrives as a mouse: moves there, presses, drags, lifts',
        w.got.join(' ') === 'move@40:0 down@40:1 move@120:1 up@130', w.got.join(' '));
    check('… and its pointerdown is cancelled, so the browser adds no second mousedown on a tap', down.defaultPrevented);
    w.got.length = 0;
    pointer(w, 'pointerdown', c, { pointerType: 'mouse', clientX: 5 });
    pointer(w, 'pointerup', c, { pointerType: 'mouse', clientX: 5 });
    check('a real mouse is left to the browser', w.got.length === 0, w.got.join(' '));
    const onSlider = pointer(w, 'pointerdown', d.getElementById('r'), { clientX: 5 });
    pointer(w, 'pointerup', d.getElementById('r'), { clientX: 5 });
    check('a finger on a native slider is never taken over', !onSlider.defaultPrevented && w.got.length === 0, w.got.join(' '));
    const style = d.getElementById('__w-touch');
    check('the touch sizes sit in the head, under a coarse pointer only, at 44px',
        !!style && style.parentNode === d.head && /@media \(pointer:coarse\)\{[^}]*button[^}]*min-height:44px/.test(style.textContent)
        && /button:not\(:empty\)\{min-width:44px;\}/.test(style.textContent));
    // Nothing outside the media query: a desktop widget must lay out exactly
    // as before, and a canvas is never squeezed (presses map off clientX).
    const css = style ? style.textContent : '';
    check('… and nothing of it applies to a mouse, nor squeezes a canvas',
        css.startsWith('@media (pointer:coarse){') && css.endsWith('}') && css.indexOf('}}') === css.length - 2
        && !/canvas/.test(css), css);

    // A finger lifted off-screen sends pointercancel, often at 0,0: the drag
    // ends where it last was, never at the corner.
    w.got.length = 0;
    pointer(w, 'pointerdown', c, { clientX: 40 });
    pointer(w, 'pointermove', c, { clientX: 120 });
    pointer(w, 'pointercancel', c, { clientX: 0 });
    check('a cancelled drag ends where the finger last was', w.got.join(' ') === 'move@40:0 down@40:1 move@120:1 up@120', w.got.join(' '));
    // A lift that never arrived must not lock out every later drag.
    w.got.length = 0;
    pointer(w, 'pointerdown', c, { clientX: 10 });
    pointer(w, 'pointermove', c, { clientX: 20 });
    pointer(w, 'pointerdown', c, { clientX: 50, pointerId: 8 });
    check('a new finger ends a drag whose lift was lost, then starts its own',
        w.got.join(' ') === 'move@10:0 down@10:1 move@20:1 up@20 move@50:0 down@50:1', w.got.join(' '));
}
{
    // On a computer with no touch screen the head decides nothing.
    const w = await run(MOUSE_ONLY, null, { touch: false });
    const c = w.document.getElementById('c');
    check('with no touch screen nothing is given touch-action', !c.style.touchAction);
    // A screen that reports its touch late (an emulator; a tablet docked into
    // a keyboard) is decided at the first finger instead.
    pointer(w, 'pointerdown', c, { clientX: 1 });
    pointer(w, 'pointerup', c, { clientX: 1 });
    await new Promise((r) => setTimeout(r, 80));
    check('… until a finger touches it, and then the canvas is claimed', c.style.touchAction === 'none', `"${c.style.touchAction}"`);
}
{
    // The drag handler on the DOCUMENT: the canvas under it is the surface,
    // or the browser pans and cancels the synthetic drag after a few pixels.
    const w = await run(`<p>Text</p><canvas id="c"></canvas><script>window.got=[];
document.addEventListener('mousedown',e=>got.push('down@'+e.clientX));
document.addEventListener('mousemove',e=>got.push('move@'+e.clientX));
document.addEventListener('mouseup',e=>got.push('up@'+e.clientX));</script>`);
    const c = w.document.getElementById('c');
    check('a document-level drag claims the canvas under it', c.style.touchAction === 'none', `"${c.style.touchAction}"`);
    check('… and not the text beside it', !w.document.querySelector('p').style.touchAction);
    pointer(w, 'pointerdown', c, { clientX: 4 });
    pointer(w, 'pointerup', c, { clientX: 9 });
    check('… and the finger arrives as the mouse it listens for', w.got.join(' ') === 'move@4 down@4 up@9', w.got.join(' '));
    // A canvas the build adds after the page loaded (a second tab, a redraw).
    const late = w.document.createElement('canvas');
    w.document.body.appendChild(late);
    await new Promise((r) => setTimeout(r, 80));
    check('… and a canvas the build adds after load is claimed too', late.style.touchAction === 'none', `"${late.style.touchAction}"`);
}
{
    // Listeners written into the markup are set by the parser, not through
    // any setter the head can patch, so they are read off the attributes.
    const w = await run(`<div id="i" onmousedown="got.push('inline')"></div><canvas id="t" onmousedown="got.push('mouse')" ontouchstart=""></canvas>
<script>window.got=[];window.addEventListener('mousemove',()=>{});</script>`);
    const d = w.document;
    check('an onmousedown attribute in the markup claims its element', d.getElementById('i').style.touchAction === 'none', `"${d.getElementById('i').style.touchAction}"`);
    pointer(w, 'pointerdown', d.getElementById('i'), { clientX: 2 });
    pointer(w, 'pointerup', d.getElementById('i'), { clientX: 2 });
    const own = pointer(w, 'pointerdown', d.getElementById('t'), { clientX: 2 });
    check('… and an ontouchstart attribute means the build handles the finger itself',
        w.got.join(' ') === 'inline' && !own.defaultPrevented, w.got.join(' '));
}
{
    // A build that adds its move listener inside mousedown has none until the
    // first press, after the browser has read touch-action for that finger.
    const LATE = `<canvas id="c"></canvas><div id="tap">Tap</div><script>window.got=[];const c=document.getElementById('c');
c.addEventListener('mousedown',()=>{window.addEventListener('mousemove',function mv(e){got.push('move@'+e.clientX)});});
document.getElementById('tap').addEventListener('mousedown',()=>got.push('tap'));</script>`;
    const w = await run(LATE);
    const d = w.document, c = d.getElementById('c');
    const touchmove = (el) => { const e = new w.TouchEvent('touchmove', { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
    check('a canvas whose move listener comes with the press is not claimed at load', !c.style.touchAction);
    check('… and a finger on it, not dragging, still scrolls', !touchmove(c).defaultPrevented);
    const tapDown = pointer(w, 'pointerdown', d.getElementById('tap'), { clientX: 1 });
    check('… so does a press on what only listens for presses', tapDown.defaultPrevented && !touchmove(d.getElementById('tap')).defaultPrevented);
    pointer(w, 'pointerup', d.getElementById('tap'), { clientX: 1 });
    pointer(w, 'pointerdown', c, { clientX: 10 });
    check('… but its first drag holds the page still, so the browser does not cancel it', touchmove(c).defaultPrevented);
    pointer(w, 'pointermove', c, { clientX: 30 });
    pointer(w, 'pointerup', c, { clientX: 30 });
    check('… and that first drag arrives', w.got.includes('move@30'), w.got.join(' '));
    await new Promise((r) => setTimeout(r, 80));
    check('… and from then on the canvas has touch-action: none', c.style.touchAction === 'none', `"${c.style.touchAction}"`);
}
{
    // An element the build drops and later puts back is still known.
    const w = await run(`<script>window.got=[];window.x=document.createElement('canvas');x.addEventListener('mousedown',()=>{});
window.addEventListener('mousemove',()=>{});</script>`);
    await new Promise((r) => setTimeout(r, 30));
    w.document.body.appendChild(w.x);
    await new Promise((r) => setTimeout(r, 80));
    check('a canvas put into the page after the head forgot it is claimed when it arrives', w.x.style.touchAction === 'none', `"${w.x.style.touchAction}"`);
}
{
    // On WINDOW, and through an on* property for the move half.
    const w = await run(`<canvas id="c"></canvas><script>window.got=[];
window.addEventListener('mousedown',e=>got.push('down@'+e.clientX));window.onmousemove=e=>got.push('move@'+e.clientX);</script>`);
    const c = w.document.getElementById('c');
    pointer(w, 'pointerdown', c, { clientX: 6 });
    pointer(w, 'pointermove', c, { clientX: 16 });
    pointer(w, 'pointerup', c, { clientX: 16 });
    check('a mousedown listener on window counts, and a move set as onmousemove makes it a drag',
        w.got.join(' ') === 'move@6 down@6 move@16' && c.style.touchAction === 'none', `${w.got.join(' ')} "${c.style.touchAction}"`);
}
{
    // A wrapper with a mousedown handler is not a drag surface; the canvas
    // inside it is. A list that selects on mousedown and drags nothing is
    // left to scroll, and so is anything whose touch-action the build set.
    const w = await run(`<style>.own{touch-action:pan-y}</style>
<ul id="l" style="overflow:auto"><li>One</li><li>Two</li></ul><div id="w"><span>Label</span><canvas id="c"></canvas></div>
<canvas id="o" class="own"></canvas><pre id="s" style="overflow:auto">a long line of text that scrolls</pre>
<svg id="g" viewBox="0 0 10 10"><g><circle id="h" cx="5" cy="5" r="2"></circle></g></svg>
<div id="track" style="cursor:grab"><div id="thumb"></div></div>
<script>window.got=[];document.getElementById('l').addEventListener('mousedown',()=>{});
document.getElementById('track').addEventListener('mousedown',()=>{});
document.getElementById('s').addEventListener('mousedown',()=>{});
document.getElementById('h').addEventListener('mousedown',()=>{});
document.getElementById('w').addEventListener('mousedown',()=>{});
document.getElementById('o').addEventListener('mousedown',()=>{});
window.addEventListener('mousemove',()=>{});</script>`);
    const d = w.document;
    check('a wrapper with a mousedown handler claims the canvas inside it, not itself',
        d.getElementById('c').style.touchAction === 'none' && !d.getElementById('w').style.touchAction);
    check('a scrolling list with a mousedown handler keeps its scroll', !d.getElementById('l').style.touchAction);
    check('… and so does a scrolling block with no children', !d.getElementById('s').style.touchAction);
    check('a handle drawn inside an svg claims the whole svg (the finger may slip off the handle)',
        d.getElementById('g').style.touchAction === 'none');
    check("a canvas whose touch-action the build's stylesheet set keeps it", !d.getElementById('o').style.touchAction);
    check('a wrapper with a grab cursor (a slider built of divs) is the surface itself',
        d.getElementById('track').style.touchAction === 'none' && !d.getElementById('thumb').style.touchAction);
}
{
    // A document-level drag claims the svgs in the page, but not a button's icon.
    const w = await run(`<button id="btn"><svg id="ic" viewBox="0 0 4 4"></svg> Reset</button><svg id="plot" viewBox="0 0 9 9"></svg>
<script>document.addEventListener('mousedown',()=>{});document.addEventListener('mousemove',()=>{});</script>`);
    check('an icon inside a button is not a drag surface',
        !w.document.getElementById('ic').style.touchAction && w.document.getElementById('plot').style.touchAction === 'none');
}
{
    // No move listener anywhere: a mousedown is a press, not a drag.
    const w = await run(`<div id="t">Tap me</div><script>document.getElementById('t').addEventListener('mousedown',()=>{});</script>`);
    check('an element pressed but never dragged keeps the page scrolling', !w.document.getElementById('t').style.touchAction);
}
{
    // A move handler set as a PROPERTY is a pointer handler too.
    const w = await run(`<canvas id="c"></canvas><script>window.got=[];const c=document.getElementById('c');
c.onmousedown=()=>got.push('mouse');c.onpointermove=()=>got.push('pmove');</script>`);
    const down = pointer(w, 'pointerdown', w.document.getElementById('c'), { clientX: 3 });
    check('a build with an onpointermove property is left to its own pointer handling',
        !w.got.includes('mouse') && !down.defaultPrevented, w.got.join(' '));
}
{
    // A build that already handles pointers must not get a second mousedown.
    const w = await run(`<canvas id="c"></canvas><script>window.got=[];const c=document.getElementById('c');
c.addEventListener('pointerdown',()=>got.push('pointer'));c.addEventListener('pointermove',()=>{});c.addEventListener('mousedown',()=>got.push('mouse'));</script>`);
    const c = w.document.getElementById('c');
    const down = pointer(w, 'pointerdown', c, { clientX: 3 });
    pointer(w, 'pointerup', c, { clientX: 3 });
    check('a build with its own pointer handlers is left to them (no synthetic mouse)',
        w.got.join(' ') === 'pointer' && !down.defaultPrevented, w.got.join(' '));
    check('… and its drag target still gets touch-action: none', c.style.touchAction === 'none');
}
{
    // Pointer handling on window alone (the usual move/up half of a drag).
    const w = await run(`<div id="d"></div><script>window.got=[];document.getElementById('d').addEventListener('mousedown',()=>got.push('mouse'));
window.addEventListener('pointermove',()=>{});</script>`);
    const down = pointer(w, 'pointerdown', w.document.getElementById('d'), { clientX: 2 });
    check('… also when it listens for pointers only on window', w.got.length === 0 && !down.defaultPrevented, w.got.join(' '));
}
{
    // The harness listens for pointerdown/touchstart on window itself; those
    // must not read as the build handling fingers.
    const w = await run(`<div id="d"></div><script>window.got=[];document.getElementById('d').addEventListener('mousedown',()=>got.push('down'));</script>`);
    pointer(w, 'pointerdown', w.document.getElementById('d'), { clientX: 1 });
    check("the host's own listeners do not count as the build's", w.got.join(' ') === 'down', w.got.join(' '));
}
{
    // Sliders, with the layout jsdom lacks stood in for: a finger's pointer, a
    // height per slider, and a ResizeObserver the test fires by hand. A slider
    // with no size at load (a closed tab the build opens by setting
    // `style.display`, which no attribute filter sees) is grown once it has one.
    const heights = { now: 16, late: 0 }, observers = [];
    const stub = (coarse) => (win) => {
        win.matchMedia = (q) => ({ matches: coarse && /coarse/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
        win.ResizeObserver = class { constructor(cb) { this.cb = cb; this.els = new Set(); observers.push(this); } observe(el) { this.els.add(el); } unobserve(el) { this.els.delete(el); } disconnect() { this.els.clear(); } };
        const rect = win.HTMLElement.prototype.getBoundingClientRect;
        win.HTMLElement.prototype.getBoundingClientRect = function () {
            return this.id in heights ? { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: heights[this.id], width: 100, height: heights[this.id] } : rect.call(this);
        };
    };
    const SLIDERS = '<input id="now" type="range"><div id="tab" style="display:none"><input id="late" type="range"></div>';
    const w = await run(SLIDERS, stub(true));
    const d = w.document;
    check('under a finger, a native slider is grown to 44px', d.getElementById('now').style.minHeight === '44px', `"${d.getElementById('now').style.minHeight}"`);
    heights.late = 16;
    d.getElementById('tab').style.display = 'block';
    for (const o of observers) if (o.els.size) o.cb([...o.els].map((target) => ({ target })), o);
    await new Promise((r) => setTimeout(r, 80));
    check('… and so is one the build reveals later by setting its style', d.getElementById('late').style.minHeight === '44px', `"${d.getElementById('late').style.minHeight}"`);
    heights.late = 0;
    const desk = await run(SLIDERS, stub(false));
    check('with a mouse no slider is touched', !desk.document.getElementById('now').style.minHeight);
}
{
    const src = readFileSync(aiPath, 'utf8');
    const prompt = src.slice(src.indexOf('const WIDGET_COMPILER_SYSTEM'), src.indexOf('export function widgetCompilePrompt'));
    check('the compiler is told: Pointer Events, touch-action on the dragged element only, 44px, 360px, no hover-only',
        /Pointer Events/.test(prompt) && /touch-action: none on the ONE element/.test(prompt)
        && /44px/.test(prompt) && /360px/.test(prompt) && /hover/.test(prompt));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

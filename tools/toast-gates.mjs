// tools/toast-gates.mjs — how long a notification lives, and what keeps it alive.
//
// Run:  node tools/toast-gates.mjs          (the working tree)
//       node tools/toast-gates.mjs --head   (HEAD's store and Toast, to watch the
//                                            cases fail on the pre-fix code)
//
// WHY. Every toast vanished after 4 s whatever it said (UX-07, outside UI/UX
// review 2026-09-30). An error that explains why a save did not happen is the one
// message the learner must be able to finish reading — and to copy from, which
// means getting a pointer or the keyboard onto it — and a 4 s clock gave a
// second-language reader no time to do either.
//   - an error lives 8 s, anything else 4 s;
//   - the countdown stops while the toast is hovered OR holds focus, and resumes
//     with what was left (never a blink) once neither is true;
//   - an identical toast still collapses into the first and restarts its clock,
//     and a bump during a hover does not start a clock under the pointer.
// The REAL store and the REAL ToastContainer are bundled into jsdom; time is a
// virtual clock installed after the bundle loads (React's scheduler captured the
// real timers at load and keeps them), so a case advances it by hand.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const HEAD = process.argv.includes('--head');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const headFiles = {
    name: 'head-files',
    setup(build) {
        if (!HEAD) return;
        build.onLoad({ filter: /[\\/]src[\\/](store\.ts|components[\\/]Toast\.tsx)$/ }, (args) => {
            const rel = args.path.slice(root.length + 1).replace(/\\/g, '/');
            return {
                contents: execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' }),
                loader: rel.endsWith('.tsx') ? 'tsx' : 'ts',
            };
        });
    },
};
const bundle = (await esbuild.build({
    stdin: {
        contents: `
            import { useStore } from './src/store';
            import ToastContainer from './src/components/Toast';
            import { createElement, act } from 'react'; import { createRoot } from 'react-dom/client';
            const mount = (el) => {
                const root = createRoot(el);
                act(() => root.render(createElement(ToastContainer)));
                return root;
            };
            window.__gate = { useStore, mount, act };`,
        resolveDir: root, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [headFiles],
})).outputFiles[0].text;

/** A fresh store, a mounted container and a virtual clock. `advance(ms)` fires what falls due. */
function fresh() {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    w.IS_REACT_ACT_ENVIRONMENT = true;
    w.MessageChannel = MessageChannel;
    w.eval(bundle);
    const { useStore, mount, act } = w.__gate;
    const root = mount(w.document.getElementById('root'));

    let now = 1_000_000, seq = 0;
    const timers = new Map();
    w.Date.now = () => now;
    w.setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; };
    w.clearTimeout = (id) => { timers.delete(id); };
    const advance = (ms) => {
        const end = now + ms;
        for (;;) {
            let next = null;
            for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
            if (!next) break;
            timers.delete(next.id);
            now = Math.max(now, next.t.at);
            act(() => next.t.fn());
        }
        now = end;
    };
    const fire = (el, type, init = {}) => act(() => { el?.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: null, ...init })); });
    return {
        w, act, advance, pending: () => timers.size,
        add: (type, message, details) => act(() => useStore.getState().addToast(type, message, details)),
        toasts: () => useStore.getState().toasts,
        has: (message) => useStore.getState().toasts.some(t => t.message === message),
        // The box the pointer is over: the live region's child, the card itself.
        card: () => w.document.querySelector('[role="alert"], [role="status"]')?.firstElementChild,
        hover: (el) => fire(el, 'mouseover'),
        unhover: (el) => fire(el, 'mouseout'),
        focus: (el) => act(() => { el?.focus(); }),
        blur: (el) => act(() => { el?.blur(); }),
        dismissButton: () => w.document.querySelector('button[aria-label="Dismiss notification"]'),
        unmount: () => { act(() => root.unmount()); w.close(); },
    };
}

// ---------------------------------------------------------------------------
section('how long a toast lives depends on what it says');
{
    const s = fresh();
    s.add('success', 'Saved'); s.add('info', 'FYI'); s.add('error', 'Could not save');
    s.advance(3900);
    check('at 3.9 s all three are still up', s.has('Saved') && s.has('FYI') && s.has('Could not save'));
    s.advance(200);
    check('a success is gone at 4 s', !s.has('Saved'));
    check('an info is gone at 4 s', !s.has('FYI'));
    check('an error is still up at 4.1 s', s.has('Could not save'));
    s.advance(3800);
    check('an error is still up at 7.9 s', s.has('Could not save'));
    s.advance(200);
    check('an error is gone at 8.1 s', !s.has('Could not save'));
    s.unmount();
}
{
    const s = fresh();
    s.add('error', 'Failed to create item', 'SQLITE_CONSTRAINT: a long reason');
    s.advance(5000);
    check('an error that carries details lives as long as any error', s.has('Failed to create item'));
    s.advance(3100);
    check('…and goes at 8 s', !s.has('Failed to create item'));
    s.unmount();
}

section('a hovered toast does not count down');
{
    const s = fresh();
    s.add('success', 'Saved');
    s.advance(3000);
    s.hover(s.card());
    s.advance(60_000);
    check('a minute under the pointer and it is still there', s.has('Saved'));
    s.unmount();
}
{
    const s = fresh();
    s.add('error', 'Could not save');
    s.advance(7500);
    s.hover(s.card());
    s.advance(30_000);
    s.unhover(s.card());
    s.advance(1400);
    check('after the pointer leaves, what was left is given back (not a blink)', s.has('Could not save'));
    s.advance(300);
    check('…and then it goes', !s.has('Could not save'));
    s.unmount();
}
{
    const s = fresh();
    s.add('success', 'Saved');
    s.advance(1000);
    s.hover(s.card()); s.unhover(s.card());
    s.advance(2900);
    check('a quick hover does not reset the clock: 1 s + 2.9 s and it is still up', s.has('Saved'));
    s.advance(700);
    check('…and gone once the original 4 s has passed', !s.has('Saved'));
    s.unmount();
}

section('a toast holding keyboard focus does not count down');
{
    const s = fresh();
    s.add('success', 'Saved');
    s.advance(3000);
    s.focus(s.dismissButton());
    s.advance(60_000);
    check('focus on its dismiss button keeps it up', s.has('Saved'));
    s.blur(s.dismissButton());
    s.advance(1600);
    check('focus leaving lets it finish', !s.has('Saved'));
    s.unmount();
}
{
    const s = fresh();
    s.add('success', 'Saved');
    s.focus(s.dismissButton());
    s.hover(s.card());
    s.unhover(s.card());
    s.advance(60_000);
    check('the pointer leaving while focus is still inside does not restart the clock', s.has('Saved'));
    s.blur(s.dismissButton());
    s.advance(4100);
    check('…it resumes when focus leaves too', !s.has('Saved'));
    s.unmount();
}

section('an identical toast still collapses into the first and restarts its clock');
{
    const s = fresh();
    s.add('success', 'Saved');
    s.advance(3000);
    s.add('success', 'Saved');
    check('one toast, counted twice', s.toasts().length === 1 && s.toasts()[0].count === 2);
    s.advance(3000);
    check('the bump restarted the clock (6 s in, still up)', s.has('Saved'));
    s.advance(1100);
    check('…and it ends 4 s after the bump', !s.has('Saved'));
    s.unmount();
}
{
    const s = fresh();
    s.add('error', 'Could not save');
    s.advance(2000);
    s.hover(s.card());
    s.advance(5000);
    s.add('error', 'Could not save');
    s.advance(60_000);
    check('a duplicate arriving under the pointer does not start a clock beneath it', s.has('Could not save') && s.toasts()[0].count === 2);
    s.unhover(s.card());
    s.advance(7900);
    check('after the pointer leaves the bump\'s full 8 s is there', s.has('Could not save'));
    s.advance(300);
    check('…and it ends', !s.has('Could not save'));
    s.unmount();
}

section('dismissing leaves nothing behind');
{
    const s = fresh();
    s.add('success', 'Saved');
    s.hover(s.card());
    s.act(() => s.dismissButton()?.click());
    check('the toast is gone', s.toasts().length === 0);
    check('and no timer is left to remove a later one early', s.pending() === 0, `${s.pending()} pending`);
    s.add('success', 'Saved');
    s.advance(3900);
    check('an identical toast added afterwards gets its own full 4 s', s.has('Saved'));
    s.unmount();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

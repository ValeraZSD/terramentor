// tools/overlay-gates.mjs — a dialog belongs to the SCREEN, not to whatever it
// was written inside.
//
// Run:  node tools/overlay-gates.mjs
//
// Why this exists: the archived and completed project grids dim themselves with
// `opacity-70`. `opacity` (like `transform` and `filter`) makes that element the
// stacking context of every `position: fixed` descendant, and the whole subtree
// is composited as one group — so Edit Project, Export and Add material, all
// written inside a `ProjectCard` in that grid, were painted at 70% alpha with
// the cards behind them showing through, under later cards. Unusable, and only
// on archived and completed projects. `Modal` portals to the body now, and this
// mounts the REAL component inside a dimmed wrapper to prove it:
//   - the dialog is in the body and NOT inside the dimmed subtree;
//   - the workspace's project accent still reaches it (the portal leaves the
//     subtree `Layout` themes, so the vars are read where the dialog was
//     WRITTEN and carried across);
//   - Escape still closes it, and closing leaves no orphan node in the body.
// Plus the same invariant for the card's own options menu, which is a popup
// with the same problem and the same fix.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const cache = join(root, 'node_modules', '.cache');
const scratch = mkdtempSync(join(cache, 'overlay-gates-'));
const out = join(scratch, 'bundle.cjs');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });

const stubs = {
    'react-i18next': `const t = (k) => k;
           export const useTranslation = () => ({ t });`,
};
const stubPlugin = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    },
};

await esbuild.build({
    stdin: {
        contents: `
            import * as React from 'react';
            import { createRoot } from 'react-dom/client';
            import Modal from './src/components/Modal';
            const act = React.act;
            globalThis.__act = (fn) => act(fn);
            // The dialog is written INSIDE the dimmed wrapper, exactly as a
            // ProjectCard writes it inside the archived grid.
            globalThis.__mount = (el, props) => {
                const root = createRoot(el);
                const render = (p) => act(() => {
                    root.render(React.createElement(
                        'div',
                        { id: 'dim', style: { opacity: 0.7, '--accent-rgb': '12 133 93' } },
                        React.createElement(Modal, p, React.createElement('p', null, 'body text')),
                    ));
                });
                render(props);
                return { render, unmount: () => act(() => root.unmount()) };
            };`,
        resolveDir: root,
        loader: 'tsx',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out,
    jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' },
    packages: 'external',
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
    plugins: [stubPlugin],
    logLevel: 'silent',
});
require(out);

const act = globalThis.__act;
const doc = window.document;
const host = doc.getElementById('root');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

console.log('\n--- a dialog opened from inside a dimmed grid ---');
let closed = 0;
const m = globalThis.__mount(host, { isOpen: true, onClose: () => { closed++; }, title: 'Edit Project' });
{
    const dialog = doc.querySelector('[role="dialog"]');
    const dim = doc.getElementById('dim');
    check('the dialog renders', !!dialog);
    check('it is NOT inside the dimmed subtree', !!dialog && !dim.contains(dialog),
        'an ancestor with opacity/transform/filter composites the dialog with the page behind it');
    // The overlay is the portal's own root: its parent is the body itself.
    const overlay = dialog?.closest('.fixed');
    check('its overlay is a direct child of the body', overlay?.parentElement === doc.body, overlay?.parentElement?.tagName);
    check('no ancestor of it dims, moves or filters anything', (() => {
        for (let el = overlay; el && el !== doc.body; el = el.parentElement) {
            const cs = window.getComputedStyle(el);
            if ((cs.opacity && cs.opacity !== '1') || (cs.transform && cs.transform !== 'none') || (cs.filter && cs.filter !== 'none')) return false;
        }
        return true;
    })());
    check('the project accent still reaches it', window.getComputedStyle(overlay).getPropertyValue('--accent-rgb').trim() === '12 133 93',
        window.getComputedStyle(overlay).getPropertyValue('--accent-rgb'));
}

console.log('\n--- it still behaves like a dialog ---');
{
    await act(async () => { doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    check('Escape closes it', closed === 1, `onClose called ${closed}×`);
    check('the page is locked while it is open', doc.body.style.overflow === 'hidden', doc.body.style.overflow);
    m.render({ isOpen: false, onClose: () => { closed++; }, title: 'Edit Project' });
    check('closing leaves no orphan overlay in the body', !doc.querySelector('[role="dialog"]'));
    check('and gives the page its scroll back', doc.body.style.overflow === '', JSON.stringify(doc.body.style.overflow));
    m.unmount();
}

console.log('\n--- the project card\'s options menu, same problem ---');
{
    const src = readFileSync(join(root, 'src', 'components', 'ProjectCard.tsx'), 'utf8');
    check('the menu is portalled to the body', /createPortal\(/.test(src) && /document\.body\)\}/.test(src));
    // `fixed` is the wiring: an `absolute` menu inside the card is dimmed with
    // it — permanently on a phone, where nothing hovers. The width beside it is
    // a design choice, and pinning `w-44` made this fail on a restyle that
    // changed nothing about positioning.
    check('and positioned against the viewport, not the card', /className="fixed\b/.test(src),
        'an `absolute` menu inside the card is dimmed with it — permanently on a phone, where nothing hovers');
}

console.log('\n--- the review session, which is a surface and not a dialog ---');
{
    // `inset: 0` is only half of "the whole screen": the element is still a
    // child of whatever it was written in, and a MARGIN still applies to it.
    // The deck screen stacks its panels with Tailwind's `space-y-*` — a margin
    // on every sibling after the first — and a session is written among those
    // siblings (through `CardsPanel`, which returns a fragment, so the stack is
    // its grandparent and no rule inside either file shows it). The session
    // opened with `margin-top: 24px`: the surface began 24px down the screen
    // and the app header showed above it, sliced in half, for every card.
    //
    // The same escape as `Modal`. Asserted at the source because the mount site
    // that breaks it is in a third file: what has to stay true HERE is that the
    // surface is portalled at all, and that it still carries the accent when it
    // goes — a session opened from a project is drawn in that project's colour.
    const src = readFileSync(join(root, 'src', 'components', 'GlobalFlashcardReview.tsx'), 'utf8');
    check('the session surface is portalled to the body', /createPortal\(/.test(src) && /document\.body\)/.test(src));
    check('and carries the project accent across', /usePortalAccent\(/.test(src) && /style=\{accent\}/.test(src));
    // Four screens share it (loading, waiting, complete, the card itself), and
    // one of them left behind is one that renders 24px down the page again.
    check('every one of its screens goes through it', !/className=\{`?\$?\{?SURFACE/.test(src.replace(/function SessionSurface[\s\S]*?\n\}\n/, '')),
        'a surface rendered with SURFACE directly is not portalled');
}

console.log('\n--- a popover names the edge it hangs from ---');
{
    // `absolute right-0 mt-1.5` reads as "under the button, right-aligned" and
    // is only half a position: with no `top`/`bottom`, the box falls back to its
    // STATIC position, which a flex parent decides. `items-center` centres it —
    // so the Vault's export options opened ON TOP of the two buttons that raise
    // them and spilled up over the header, while the same class string one file
    // away, inside a `relative inline-block`, dropped below and looked fine.
    // Nothing in the popover's own markup distinguishes the two cases, and the
    // parent is free to become a flex row at any restyle.
    //
    // So the rule is about the popover and not its parent: an element that
    // anchors itself horizontally must anchor itself vertically too. Horizontal
    // only is the shape that is silently at the mercy of a layout decision made
    // somewhere else.
    const anchored = (cls) => /\babsolute\b/.test(cls) && /\b(left-0|right-0)\b/.test(cls);
    const namesItsEdge = (cls) => /\b(top-|bottom-|inset-|-?inset-y-)/.test(cls);
    const files = [];
    (function walk(d) {
        for (const e of require('node:fs').readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p); else if (p.endsWith('.tsx')) files.push(p);
        }
    })(join(root, 'src'));

    const offenders = [];
    for (const f of files) {
        const src = readFileSync(f, 'utf8');
        for (const m of src.matchAll(/className=\{?[`"]([^`"]*)[`"]/g)) {
            if (!anchored(m[1]) || namesItsEdge(m[1])) continue;
            offenders.push(`${f.slice(root.length + 1)}:${src.slice(0, m.index).split('\n').length}  ${m[1].slice(0, 60)}`);
        }
    }
    check('every horizontally-anchored absolute box also names top or bottom',
        offenders.length === 0, offenders.join('\n        '));

    // The control: the class string as it shipped. A scan that cannot fail on
    // the shape it was written for is a scan over nothing.
    const preFix = 'absolute right-0 mt-1.5 z-20 w-72 p-3 rounded-xl border';
    check('the pre-fix Vault popover is what this rule catches',
        anchored(preFix) && !namesItsEdge(preFix));
    check('and the fixed one passes it',
        namesItsEdge('absolute right-0 top-full mt-1.5 z-20 w-72'));
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS will */ }
console.log(`\noverlay gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

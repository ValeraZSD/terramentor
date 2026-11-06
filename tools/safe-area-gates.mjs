#!/usr/bin/env node
// safe-area-gates.mjs — nothing the app draws at a screen edge sits under a
// phone's status bar, island, home indicator or rounded corners.
//
// `index.html` asks for the whole screen: `viewport-fit=cover`, and an iOS
// status bar of `black-translucent` for the installed app. On a notched or
// island iPhone in standalone mode the page is then drawn edge to edge, and a
// top bar with no inset of its own sits under the clock and the island, its
// buttons under the signal and battery icons. The fix is one vocabulary:
// `--safe-top/right/bottom/left` in `src/index.css` (the env() insets, 0px on a
// plain screen) and the `safe-p*` / `safe-top` / `safe-bottom` utilities in
// `tailwind.config.js` that read them. This gate holds the pieces in place:
//
//   1. the insets — `index.css` defines the four variables from env(), and the
//      REAL Tailwind config compiles each utility to max(base, inset) for
//      padding and base + inset for an offset;
//   2. the status-bar strip — over the light theme the clock (white in a
//      `black-translucent` app) gets the theme's ink colour under it, a fixed
//      layer as tall as the top inset;
//   3. the shell's top bar — Layout's <header> pads its top and sides with the
//      insets and is 3.5rem plus the top inset tall, so its row stays 56px;
//   4. every fixed surface on an edge — an element in src/ whose classes are
//      `fixed` plus an edge (`inset-0`, `inset-x-0`, `inset-y-0`, or a `top-`,
//      `bottom-`, `left-`, `right-` offset of 0 to 3.5rem) covers each edge it
//      touches with a `safe-*` class, on itself or on a direct child (a dialog's
//      panel, a `{panel}` written as a const in the same file), or an inline
//      style that reads `var(--safe-<edge>)`. Only base and `max-sm:` classes
//      count as cover: an `sm:` one is not the phone's. An element with no
//      children at all is a layer (a dim, a click catcher) with nothing to keep
//      clear, and is skipped.
//
// The classes are read from the source (string literals, templates, `cx()`,
// and consts in the same file or imported from a relative path), so a token
// that is only ever built at run time would be missed: write them out. Both
// arms of a conditional count, so a cover that only one arm carries passes.
// Floating menus placed by script (`placePopover`) are not edge surfaces and
// are not read.
//
//   node tools/safe-area-gates.mjs              # this checkout
//   node tools/safe-area-gates.mjs --root DIR   # another checkout (the pre-fix tree must fail)

import { readFileSync, existsSync, statSync, globSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseTsx, childrenOf } from './lib/tsxAst.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.indexOf('--root');
if (rootArg > 0 && !process.argv[rootArg + 1]) { console.error('--root needs a directory'); process.exit(2); }
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : HERE;
const require = createRequire(import.meta.url);

const C = process.stdout.isTTY
    ? { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
    : { r: '', g: '', d: '', b: '', x: '' };
const failures = [];
const fail = (rule, where, detail) => failures.push({ rule, where, detail });
let checks = 0;

// ---------------------------------------------------------------- the reader

const SIDES = ['top', 'right', 'bottom', 'left'];
const EDGE_CLASS = [
    [/^inset-0$/, SIDES],
    [/^inset-x-0$/, ['left', 'right']],
    [/^inset-y-0$/, ['top', 'bottom']],
    // A spacing offset (0 to 3.5rem) still leaves the box inside the strip an
    // inset covers: 59px at the top of an island iPhone, 59px at a side held
    // sideways. `top-1/2`, `top-full`, `auto` and arbitrary values are not edges.
    [/^top-(px|[0-3]\.5|[0-9]|1[0-4])$/, ['top']],
    [/^bottom-(px|[0-3]\.5|[0-9]|1[0-4])$/, ['bottom']],
    [/^left-(px|[0-3]\.5|[0-9]|1[0-4])$/, ['left']],
    [/^right-(px|[0-3]\.5|[0-9]|1[0-4])$/, ['right']],
    [/^safe-top-/, ['top']],
    [/^safe-bottom-/, ['bottom']],
];
const COVER = { '': SIDES, x: ['left', 'right'], y: ['top', 'bottom'], t: ['top'], r: ['right'], b: ['bottom'], l: ['left'] };

/** The edges a set of class tokens pins a fixed box to (base classes only: a `sm:fixed` is not a phone's). */
function edgesOf(tokens) {
    const base = tokens.filter(t => !t.includes(':'));
    if (!base.includes('fixed')) return [];
    const out = new Set();
    for (const t of base) for (const [re, sides] of EDGE_CLASS) if (re.test(t)) sides.forEach(s => out.add(s));
    return [...out];
}

/** The edges a set of class tokens keeps clear ON A PHONE: base classes and `max-sm:` ones; an `sm:` class is not a phone's. */
function coveredBy(tokens) {
    const out = new Set();
    for (const t of tokens) {
        const variants = t.includes(':') ? t.slice(0, t.lastIndexOf(':')).split(':') : [];
        if (!variants.every(v => v === 'max-sm' || v === 'dark')) continue;
        const bare = t.slice(t.lastIndexOf(':') + 1);
        let m = /^safe-p([xytrbl]?)-/.exec(bare);
        if (m) COVER[m[1]].forEach(s => out.add(s));
        m = /^safe-(top|bottom)-/.exec(bare);
        if (m) out.add(m[1]);
        // A hand-written `pt-[env(safe-area-inset-top)]` keeps its side clear too.
        m = /(?:^|:)p([xytrbl]?)-\[[^\]]*(?:safe-area-inset-|--safe-)/.exec(t);
        if (m) COVER[m[1]].forEach(s => out.add(s));
    }
    return out;
}

const parsed = new Map();
function readModule(file) {
    if (parsed.has(file)) return parsed.get(file);
    const text = readFileSync(file, 'utf8');
    const { program, lineOf } = parseTsx(text, file);
    const mod = { file, text, program, lineOf, consts: new Map(), imports: new Map() };
    parsed.set(file, mod);
    // Consts at any depth (a component's `const panel = (<aside …/>)`), the first of a name winning.
    const collect = (n) => {
        if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && !mod.consts.has(n.id.name)) mod.consts.set(n.id.name, n.init);
        for (const c of childrenOf(n)) collect(c);
    };
    collect(program);
    for (const st of program.body) {
        if (st.type === 'ImportDeclaration' && st.source.value.startsWith('.')) {
            for (const s of st.specifiers) {
                if (s.type === 'ImportSpecifier') mod.imports.set(s.local.name, { from: st.source.value, name: s.imported.name });
            }
        }
    }
    return mod;
}
function resolveImport(mod, rel) {
    const base = path.resolve(path.dirname(mod.file), rel);
    for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts', '']) {
        if (existsSync(base + ext) && statSync(base + ext).isFile()) return base + ext;
    }
    return null;
}
/** The node an identifier names: a const in this file, or a const exported by a relative import. */
function lookup(mod, name) {
    if (mod.consts.has(name)) return { mod, node: mod.consts.get(name) };
    const imp = mod.imports.get(name);
    if (!imp) return null;
    const file = resolveImport(mod, imp.from);
    if (!file) return null;
    const other = readModule(file);
    return other.consts.has(imp.name) ? { mod: other, node: other.consts.get(imp.name) } : null;
}

/** Every class token any string in an expression could contribute (both arms of a conditional, a cx() call, a const). */
function tokensIn(mod, node, seen = new Set()) {
    const out = [];
    const walk = (m, n) => {
        if (!n) return;
        if (n.type === 'StringLiteral') { out.push(...n.value.split(/\s+/)); return; }
        if (n.type === 'TemplateElement') { out.push(...(n.value.cooked ?? n.value.raw).split(/\s+/)); return; }
        if (n.type === 'Identifier') {
            const key = `${m.file}#${n.name}`;
            if (seen.has(key)) return;
            seen.add(key);
            const hit = lookup(m, n.name);
            if (hit && hit.node.type !== 'JSXElement' && hit.node.type !== 'ParenthesizedExpression') walk(hit.mod, hit.node);
            return;
        }
        if (n.type === 'JSXElement') return; // another element's classes are its own
        for (const c of childrenOf(n)) walk(m, c);
    };
    walk(mod, node);
    return out.filter(Boolean);
}

const attr = (el, name) => el.openingElement.attributes.find(a => a.type === 'JSXAttribute' && a.name.name === name);
function classTokens(mod, el) {
    const a = attr(el, 'className');
    if (!a?.value) return [];
    return tokensIn(mod, a.value.type === 'JSXExpressionContainer' ? a.value.expression : a.value);
}
function styleCover(mod, el) {
    const a = attr(el, 'style');
    const out = new Set();
    if (!a?.value) return out;
    const text = mod.text.slice(a.value.start, a.value.end);
    for (const s of SIDES) if (text.includes(`var(--safe-${s})`) || text.includes(`env(safe-area-inset-${s}`)) out.add(s);
    return out;
}
const unparen = (n) => (n?.type === 'ParenthesizedExpression' ? unparen(n.expression) : n);
/** Direct child elements, with `{panel}` followed to a `const panel = (<…/>)` in the same file. */
function childElements(mod, el) {
    const out = [];
    for (const c of el.children) {
        if (c.type === 'JSXElement') out.push({ mod, el: c });
        else if (c.type === 'JSXFragment') out.push(...childElements(mod, c));
        else if (c.type === 'JSXExpressionContainer') {
            const e = unparen(c.expression);
            if (e?.type === 'JSXElement') out.push({ mod, el: e });
            else if (e?.type === 'Identifier') {
                const hit = lookup(mod, e.name);
                const jsx = unparen(hit?.node);
                if (jsx?.type === 'JSXElement') out.push({ mod: hit.mod, el: jsx });
            }
        }
    }
    return out;
}

/** Rule 4 on one module: returns [{ line, edges, missing }] for every fixed edge surface. */
function edgeSurfaces(mod) {
    const found = [];
    const visit = (n) => {
        if (n.type === 'JSXElement') {
            const tokens = classTokens(mod, n);
            const edges = edgesOf(tokens);
            const kids = childElements(mod, n);
            const hasContent = n.children.some(c => c.type === "JSXText" ? c.value.trim() !== "" : !(c.type === "JSXExpressionContainer" && c.expression.type === "JSXEmptyExpression"));
            if (edges.length && hasContent) {
                const cover = new Set([...coveredBy(tokens), ...styleCover(mod, n)]);
                for (const k of kids) for (const s of [...coveredBy(classTokens(k.mod, k.el)), ...styleCover(k.mod, k.el)]) cover.add(s);
                found.push({ line: mod.lineOf(n), edges, missing: edges.filter(s => !cover.has(s)) });
            }
        }
        for (const c of childrenOf(n)) visit(c);
    };
    visit(mod.program);
    return found;
}

// ------------------------------------------------- self-test: the reader works

const FIXTURES = [
    { name: 'a full-screen overlay with plain padding', bad: true,
      src: `export const A = () => <div className="fixed inset-0 z-50 flex p-4"><div className="panel">x</div></div>;` },
    { name: 'the same overlay with safe padding', bad: false,
      src: `export const A = () => <div className="fixed inset-0 z-50 flex safe-p-4"><div className="panel">x</div></div>;` },
    { name: 'a sheet: overlay top and sides, panel bottom, through consts', bad: false,
      src: `const O = 'safe-pt-0 safe-px-0 sm:safe-p-4'; const P = 'max-sm:safe-pb-0';
            export const A = () => <div className={\`fixed inset-0 \${O}\`}><div className={cx('w-full', P)}>x</div></div>;` },
    { name: 'a sheet whose panel forgot the home indicator', bad: true,
      src: `export const A = () => <div className="fixed inset-0 safe-pt-0 safe-px-0"><div className="w-full">x</div></div>;` },
    { name: 'a toast pinned near the top', bad: true,
      src: `export const A = () => <div className="fixed top-4 right-0"><span>x</span></div>;` },
    { name: 'a toast offset by the inset', bad: false,
      src: `export const A = () => <div className="fixed safe-top-4" style={{ right: 'calc(1rem + var(--safe-right))' }}><span>x</span></div>;` },
    { name: 'a drawer whose panel is a const', bad: false,
      src: `export function D() { const panel = (<aside className="h-full safe-pt-0 safe-pb-0 safe-pr-0">x</aside>);
            return <div className="fixed inset-0 safe-pl-0"><div className="absolute inset-0" />{panel}</div>; }` },
    { name: 'a cover from sm up only leaves the phone uncovered', bad: true,
      src: `export const A = () => <div className="fixed inset-0 sm:safe-p-4"><div className="panel">x</div></div>;` },
    { name: 'a cover below sm only is the phone', bad: false,
      src: `export const A = () => <div className="fixed inset-0 sm:p-4"><div className="max-sm:safe-p-0">x</div></div>;` },
    { name: 'a box offset 2rem from the right edge', bad: true,
      src: `export const A = () => <div className="fixed bottom-4 right-8 safe-bottom-0"><b>x</b></div>;` },
    { name: 'a stack whose children are a list', bad: true,
      src: `export const A = ({ items }) => <div className="fixed top-4">{items.map(i => <p key={i}>{i}</p>)}</div>;` },
    { name: 'a dim with nothing in it', bad: false,
      src: `export const A = () => <div className="fixed inset-0 bg-black/50" />;` },
    { name: 'a box centred on a line, not on an edge', bad: false,
      src: `export const A = () => <div className="fixed left-1/2 top-1/2"><span>x</span></div>;` },
    { name: 'an edge class only from sm up is still the phone', bad: true,
      src: `export const A = () => <div className={open ? 'fixed inset-0 sm:p-4' : 'hidden'}><b>x</b></div>;` },
];
const selfFailures = [];
{
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const dir = mkdtempSync(path.join((await import('node:os')).tmpdir(), 'safe-area-fixture-'));
    try {
        FIXTURES.forEach((f, i) => {
            const file = path.join(dir, `f${i}.tsx`);
            writeFileSync(file, f.src);
            const bad = edgeSurfaces(readModule(file)).some(s => s.missing.length);
            if (bad !== f.bad) selfFailures.push(`${f.name}: read as ${bad ? 'failing' : 'passing'}, should ${f.bad ? 'fail' : 'pass'}`);
        });
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ------------------------------------------------------------ 1. the insets

const css = readFileSync(path.join(ROOT, 'src', 'index.css'), 'utf8');
for (const s of SIDES) {
    checks++;
    const re = new RegExp(`--safe-${s}\\s*:\\s*env\\(\\s*safe-area-inset-${s}\\b`);
    if (!re.test(css)) fail('insets', 'src/index.css', `--safe-${s} is not defined from env(safe-area-inset-${s})`);
}

{
    const configFile = path.join(ROOT, 'tailwind.config.js');
    const tailwind = require('tailwindcss');
    const postcss = require('postcss');
    const want = {
        'safe-p-4': [['padding-top', 'max(1rem, var(--safe-top))'], ['padding-left', 'max(1rem, var(--safe-left))']],
        'safe-pt-0': [['padding-top', 'max(0px, var(--safe-top))']],
        'safe-px-2': [['padding-left', 'max(0.5rem, var(--safe-left))'], ['padding-right', 'max(0.5rem, var(--safe-right))']],
        'safe-pb-0': [['padding-bottom', 'max(0px, var(--safe-bottom))']],
        'safe-pt-\\[10vh\\]': [['padding-top', 'max(10vh, var(--safe-top))']],
        'safe-top-4': [['top', 'calc(1rem + var(--safe-top))']],
        'safe-bottom-3': [['bottom', 'calc(0.75rem + var(--safe-bottom))']],
    };
    let out = '';
    try {
        // Inside the try: a root whose config cannot load is a failure to report, not a crash.
        const config = require('tailwindcss/loadConfig')(configFile);
        const raw = Object.keys(want).map(k => k.replace(/\\/g, '')).join(' ');
        out = (await postcss([tailwind({ ...config, content: [{ raw, extension: 'html' }], corePlugins: { preflight: false } })])
            .process('@tailwind utilities;', { from: undefined })).css;
    } catch (err) { fail('utilities', 'tailwind.config.js', `did not compile: ${err.message}`); }
    for (const [cls, decls] of Object.entries(want)) {
        checks++;
        const at = out.indexOf(`.${cls} {`);
        const block = at < 0 ? null : out.slice(at, out.indexOf('}', at));
        if (!block) { fail('utilities', 'tailwind.config.js', `.${cls.replace(/\\/g, '')} is not generated`); continue; }
        for (const [prop, value] of decls) {
            if (!block.replace(/\s+/g, ' ').includes(`${prop}: ${value}`)) fail('utilities', 'tailwind.config.js', `.${cls.replace(/\\/g, '')} should set ${prop}: ${value}`);
        }
    }
}

// ----------------------------------------------------- 2. the status-bar strip

{
    checks++;
    const rule = /html:not\(\.dark\)[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const flat = rule.replace(/\s+/g, ' ');
    if (!/position: fixed/.test(flat) || !/height: var\(--safe-top\)/.test(flat) || !/top: 0/.test(flat)) {
        fail('status strip', 'src/index.css', 'no fixed layer as tall as var(--safe-top) under the clock over the light theme');
    }
}

// --------------------------------------------------------- 3. the shell's bar

{
    checks++;
    const mod = readModule(path.join(ROOT, 'src', 'components', 'Layout.tsx'));
    let header = null;
    const find = (n) => {
        if (!header && n.type === 'JSXElement' && n.openingElement.name.name === 'header') header = n;
        for (const c of childrenOf(n)) find(c);
    };
    find(mod.program);
    if (!header) fail('top bar', 'src/components/Layout.tsx', 'no <header> found');
    else {
        const tokens = classTokens(mod, header);
        const cover = coveredBy(tokens);
        const line = `src/components/Layout.tsx:${mod.lineOf(header)}`;
        for (const s of ['top', 'left', 'right']) if (!cover.has(s)) fail('top bar', line, `the app's top bar does not pad its ${s} with the inset (safe-p${s[0]}-*)`);
        // Its height grows by the inset it pads, so the row under the bar stays the
        // 56px the docked assistant's header matches (`box-content` would add the border).
        if (!tokens.includes('h-[calc(3.5rem+var(--safe-top))]')) fail('top bar', line, 'the top bar is not h-[calc(3.5rem+var(--safe-top))], so its inset would come out of its 56px row');
    }
}

// --------------------------------------------- 4. every fixed edge surface

const files = globSync('src/**/*.tsx', { cwd: ROOT }).map(f => path.join(ROOT, f)).sort();
let surfaces = 0;
for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    for (const s of edgeSurfaces(readModule(file))) {
        surfaces++; checks++;
        if (s.missing.length) fail('edge surface', `${rel}:${s.line}`, `fixed on the ${s.edges.join(', ')} edge${s.edges.length > 1 ? 's' : ''}, nothing keeps the ${s.missing.join(', ')} clear`);
    }
}
// A floor, so a reader that stopped finding surfaces cannot pass by finding none.
checks++;
if (surfaces < 20) fail('edge surface', 'src/', `only ${surfaces} fixed edge surfaces found; the reader has stopped seeing them`);

// ------------------------------------------------------------------ report

const failed = failures.length + selfFailures.length;
console.log(`\n${C.b}Safe-area insets${C.x} ${C.d}(${files.length} files, ${surfaces} fixed edge surfaces, ${FIXTURES.length} self-test fixtures${ROOT !== HERE ? `, root ${ROOT}` : ''})${C.x}\n`);
for (const s of selfFailures) console.log(`  ${C.r}self-test${C.x} ${s}`);
for (const f of failures) {
    console.log(`  ${C.r}${f.rule}${C.x} ${C.d}${f.where}${C.x}`);
    console.log(`        ${f.detail}`);
}
console.log(`\n  ${failed ? `${C.r}${failed} failed` : `${C.g}${checks + FIXTURES.length} passed (${FIXTURES.length} self-tests, ${surfaces} surfaces)`}${C.x}\n`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// dialog-footer-gates.mjs — a dialog's buttons never scroll away.
//
// A dialog that scrolled as ONE box carried its action row (Cancel / Save /
// Next) at the bottom of the scrolled content. A long explanation, a long form
// or a short window pushed the row past the dialog's edge: at 1280x800 the
// placement probe showed an explanation and no way on. PR #188 fixed that one dialog by hand; a dozen others had the same shape.
// They are now built from `src/components/ui/Dialog.tsx` (a frame, ONE scrolling
// body, a footer outside it) or from `Modal`'s `footer` prop, and this gate
// reads every dialog in `src/` for the two ways the old shape comes back:
//
//   1. the last row is in the scroll — the last thing a scrolling dialog body
//      draws (the end of `<Modal>`'s children, an element using DIALOG_BODY, or
//      any `overflow-auto` element inside a `role="dialog"`) is a button, found
//      by following the last child down through wrappers and both branches of
//      a conditional. A `.map()` or a component is not followed: that is a list
//      or another file, which is read on its own;
//   2. the frame is sized in vh alone — a `role="dialog"` element capped with
//      `max-h-[NNvh]`/`h-[NNvh]`: on a phone `vh` ignores the address bar, so
//      the bottom of the dialog (its footer) sits under it. DIALOG_SHELL carries
//      the vh-then-dvh pair (`.modal-shell`).
//
// jsdom has no layout, so this reads structure; the pixels were measured in
// Edge for the PR. The gate proves itself on every run: each rule is fed a
// fixture that must fail and one that must pass, before the app is read.
//
//   node tools/dialog-footer-gates.mjs              # this checkout
//   node tools/dialog-footer-gates.mjs --root DIR   # another checkout (the pre-fix tree must fail)

import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTsx, childrenOf, stringText, isStringish, jsxExpressionOf } from './lib/tsxAst.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.indexOf('--root');
if (rootArg > 0 && !process.argv[rootArg + 1]) { console.error('--root needs a directory'); process.exit(2); }
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : HERE;

const BUTTONS = new Set(['Button', 'ButtonLink', 'IconButton', 'IconLink', 'button']);

/**
 * Buttons that end a scrolling body on purpose, with the reason. Matched on
 * the file and a distinctive substring of the button's opening tag. Short and
 * argued, never a habit.
 */
const ALLOWED = [
    { file: 'src/components/PlacementModal.tsx', tag: 'onClick={() => submit(draft)}',
      why: "a typed answer's own submit, under its text box: it sends the answer, it is not the dialog's way on (Next and Skip are in the footer)" },
    { file: 'src/components/QrScanner.tsx', tag: 'onClick={photo.open}',
      why: 'drawn only when the live camera is off, as the dialog\'s whole body: one sentence and this button, which never overflows' },
    { file: 'src/components/atlas/AtlasSettingsModal.tsx', tag: 'isDefaultAtlasSettings(settings)',
      why: "Reset to defaults ends the settings list it resets, like a Settings page's; Render is in its own row above" },
];

const nameOf = (el) => {
    const n = el.openingElement?.name;
    if (!n) return '';
    if (n.type === 'JSXIdentifier') return n.name;
    if (n.type === 'JSXMemberExpression') return `${n.object.name}.${n.property.name}`;
    return '';
};
const attr = (el, name) => el.openingElement?.attributes.find(a => a.type === 'JSXAttribute' && a.name?.name === name);

/** Everything a className attribute says: its string parts and the identifiers it interpolates. */
function classText(el, textOf) {
    const a = attr(el, 'className');
    if (!a?.value) return '';
    if (isStringish(a.value)) return stringText(a.value);
    const e = jsxExpressionOf(a.value);
    if (!e) return '';
    // A template or a call is read as its source: the classes are in it literally.
    return isStringish(e) ? stringText(e) : ` ${textOf(e).replace(/[`{}$]/g, ' ')} `;
}

/** The children that draw something: no whitespace text, no `{/* comments *\/}`. */
const drawn = (el) => (el.children ?? []).filter(c =>
    !(c.type === 'JSXText' && !c.value.trim())
    && !(c.type === 'JSXExpressionContainer' && !jsxExpressionOf(c)));

/** A child that may draw nothing (`{a && <X/>}`), so the one before it may be the last drawn. */
const mayBeEmpty = (c) => {
    const e = c.type === 'JSXExpressionContainer' ? jsxExpressionOf(c) : null;
    return !!e && (e.type === 'LogicalExpression' || e.type === 'ConditionalExpression');
};

/** The file being read: `classText` needs its text, deep inside the walk. */
let textOfFile = () => '';

/**
 * What an element's children END with: from the last drawn child back past every child that may draw nothing.
 * `frame`: el is a DIALOG_SHELL, whose `shrink-0` rows sit beside its DIALOG_BODY and stay put.
 */
function endOf(el, out = [], frame = false) {
    const kids = drawn(el);
    for (let i = kids.length - 1; i >= 0; i--) {
        if (!(frame && kids[i].type === 'JSXElement' && /(?:^|\s)shrink-0\b/.test(classText(kids[i], textOfFile)))) lastThings(kids[i], out);
        if (!mayBeEmpty(kids[i])) break;
    }
    return out;
}

/**
 * A row pinned outside the scroll: the shared footer, a <footer>, a <header>.
 * Never a class: inside a scrolling body a `shrink-0` row scrolls with the rest.
 */
const isPinned = (el) => ['DialogFooter', 'footer', 'header'].includes(nameOf(el));

/** What a body ENDS with: the last drawn child, followed down through wrappers and both arms of a conditional. */
function lastThings(node, out = []) {
    if (!node) return out;
    if (node.type === 'JSXExpressionContainer') return lastThings(jsxExpressionOf(node), out);
    if (node.type === 'ParenthesizedExpression') return lastThings(node.expression, out);
    if (node.type === 'LogicalExpression') return lastThings(node.right, out);
    if (node.type === 'ConditionalExpression') { lastThings(node.consequent, out); return lastThings(node.alternate, out); }
    // `{(() => { …; return <div>…</div>; })()}`: what it returns is drawn here.
    // The mastery check's result screen hid its Continue / Retry in one.
    if (node.type === 'CallExpression' && !node.arguments.length) {
        let fn = node.callee;
        while (fn?.type === 'ParenthesizedExpression') fn = fn.expression;
        if (fn?.type === 'ArrowFunctionExpression' || fn?.type === 'FunctionExpression') {
            if (fn.body.type !== 'BlockStatement') return lastThings(fn.body, out);
            for (const s of fn.body.body) if (s.type === 'ReturnStatement') lastThings(s.argument, out);
        }
        return out;
    }
    if (node.type === 'JSXFragment') return endOf(node, out);
    if (node.type === 'JSXElement') {
        const name = nameOf(node);
        // A disclosure toggle opens content below it; it is not the dialog's way on.
        if (BUTTONS.has(name) && attr(node, 'aria-expanded')) return out;
        if (BUTTONS.has(name)) { out.push(node); return out; }
        if (isPinned(node)) return out;
        // A component is another file's business (read on its own), except the
        // ones that only wrap: a scope, a fragment.
        if (/^[A-Z]/.test(name) && !/Scope$|^Fragment$|^React\.Fragment$/.test(name)) return out;
        return endOf(node, out);
    }
    return out;
}

/** The scrolling bodies in one file. */
function bodiesOf(program, textOf) {
    const bodies = [];
    const visit = (n, inDialog) => {
        let here = inDialog;
        if (n.type === 'JSXElement') {
            const name = nameOf(n);
            const cls = classText(n, textOf);
            const role = attr(n, 'role');
            const isDialog = role && isStringish(role.value) && stringText(role.value) === 'dialog';
            if (name === 'Modal' && !attr(n, 'fill')) bodies.push({ el: n, why: '<Modal> children' });
            else if (/\bDIALOG_(?:BODY|SHELL)\b/.test(cls)) bodies.push({ el: n, why: 'a DIALOG_BODY or DIALOG_SHELL' });
            else if ((inDialog || isDialog) && /(?:^|\s)overflow-(?:y-)?auto\b/.test(cls)) bodies.push({ el: n, why: 'a scroller inside a dialog' });
            if (isDialog) here = true;
        }
        for (const c of childrenOf(n)) visit(c, here);
    };
    visit(program, false);
    return bodies;
}

function checkSource(text, rel) {
    const { program, lineOf, textOf } = parseTsx(text, rel);
    textOfFile = textOf;
    const findings = [];
    const seen = new Set();
    for (const { el, why } of bodiesOf(program, textOf)) {
        for (const b of endOf(el, [], /\bDIALOG_SHELL\b/.test(classText(el, textOf)))) {
            // A button ends both the body and the frame around it: said once.
            if (seen.has(b.start)) continue;
            seen.add(b.start);
            const open = textOf(b.openingElement);
            if (ALLOWED.some(a => a.file === rel && open.includes(a.tag))) continue;
            findings.push({
                file: rel, line: lineOf(b), rule: 'the last row is in the scroll',
                detail: `<${nameOf(b)}> is the last thing ${why} (line ${lineOf(el)}) draws, so a long body scrolls it away — move the row into the footer (Modal's \`footer\`, ui/Dialog's DialogFooter)`,
            });
        }
    }
    const frames = [];
    const visit = (n) => {
        if (n.type === 'JSXElement') {
            const role = attr(n, 'role');
            if (role && isStringish(role.value) && stringText(role.value) === 'dialog') frames.push(n);
        }
        for (const c of childrenOf(n)) visit(c);
    };
    visit(program);
    for (const f of frames) {
        const cls = classText(f, textOf);
        const vh = cls.match(/(?:^|\s)(?:sm:)?(?:max-)?h-\[\d+vh\]/);
        if (vh) findings.push({
            file: rel, line: lineOf(f), rule: 'the frame is sized in vh alone',
            detail: `\`${vh[0].trim()}\` ignores a phone's address bar, which then covers the dialog's foot — use DIALOG_SHELL or \`modal-shell\` (vh, then dvh)`,
        });
    }
    return findings;
}

// --- The gate proves itself first.
const FIXTURES = [
    {
        rule: 'the last row is in the scroll',
        bad: `<Modal isOpen title="x" onClose={c}><p>long</p><div className="flex justify-end"><Button>Cancel</Button><Button variant="primary">Save</Button></div></Modal>`,
        good: `<Modal isOpen title="x" onClose={c} footer={<><Button>Cancel</Button><Button variant="primary">Save</Button></>}><p>long</p></Modal>`,
    },
    {
        rule: 'the last row is in the scroll',
        bad: `<div role="dialog" className="max-w-lg overflow-y-auto"><header>t</header><div className="p-5">{ok && <p>x</p>}{step === 1 ? <div className="flex"><Button>Next</Button></div> : <p>done</p>}</div></div>`,
        good: `<div role="dialog" className={DIALOG_SHELL}><header>t</header><div className={\`\${DIALOG_BODY} p-5\`}><p>x</p><ul className="max-h-40 overflow-y-auto">{items.map(i => <li><Button>{i}</Button></li>)}</ul></div><DialogFooter><Button>Next</Button></DialogFooter></div>`,
    },
    {
        rule: 'the last row is in the scroll',
        bad: `<div role="dialog" className={DIALOG_SHELL}><div className={DIALOG_BODY}>{done && (() => { const n = 1; return <div><p>{n}</p><div className="flex"><Button>Continue</Button></div></div>; })()}</div></div>`,
        good: `<div role="dialog" className={DIALOG_SHELL}><div className={DIALOG_BODY}><p>x</p><button aria-expanded={open}>Details</button>{open && <pre>log</pre>}</div><DialogFooter><Button>Continue</Button></DialogFooter></div>`,
    },
    {
        // `shrink-0` pins a row only beside the body, as the frame's own child:
        // inside the scrolling body it scrolls away with the rest.
        rule: 'the last row is in the scroll',
        bad: `<div role="dialog" className={DIALOG_SHELL}><div className={DIALOG_BODY}><p>long</p><div className="flex shrink-0 gap-2"><Button>Save</Button></div></div></div>`,
        good: `<div role="dialog" className={DIALOG_SHELL}><div className={DIALOG_BODY}><p>long</p></div><div className="shrink-0 border-t flex gap-2"><Button>Save</Button></div></div>`,
    },
    {
        rule: 'the frame is sized in vh alone',
        bad: `<div role="dialog" className="w-full max-h-[90vh] flex flex-col"><p>x</p></div>`,
        good: `<div role="dialog" className={\`w-full \${DIALOG_SHELL}\`}><p>x</p></div>`,
    },
];
const selfFailures = [];
for (const f of FIXTURES) {
    const wrap = (jsx) => `export function F() { return (${jsx}); }`;
    if (!checkSource(wrap(f.bad), 'fixture.tsx').some(x => x.rule === f.rule)) selfFailures.push(`the "${f.rule}" rule passed a fixture it must fail: ${f.bad}`);
    if (checkSource(wrap(f.good), 'fixture.tsx').some(x => x.rule === f.rule)) selfFailures.push(`the "${f.rule}" rule failed a fixture it must pass: ${f.good}`);
}

// --- The app.
const files = globSync('src/**/*.tsx', { cwd: ROOT }).map(f => f.replace(/\\/g, '/'));
const findings = [];
let dialogs = 0;
for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    dialogs += (text.match(/role="dialog"|<Modal\b/g) || []).length;
    findings.push(...checkSource(text, rel));
}
// A run over nothing is not a pass: a wrong --root reads as a clean tree.
if (files.length < 50 || dialogs < 20) findings.push({ file: ROOT, line: 1, rule: 'a tree to check', detail: `${files.length} files, ${dialogs} dialogs — is --root right?` });

const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
console.log(`\n${C.b}Dialog footers${C.x} ${C.d}(${files.length} files, ${dialogs} dialogs, ${FIXTURES.length} self-test fixtures${ROOT !== HERE ? `, root ${ROOT}` : ''})${C.x}\n`);
for (const s of selfFailures) console.log(`  ${C.r}self-test${C.x} ${s}`);
for (const f of findings) {
    console.log(`  ${C.r}${f.rule}${C.x} ${C.d}${f.file}:${f.line}${C.x}`);
    console.log(`        ${f.detail}`);
}
const failed = selfFailures.length + findings.length;
console.log(`\n  ${failed ? `${C.r}${failed} failed` : `${C.g}${FIXTURES.length * 2 + files.length} passed (${FIXTURES.length * 2} self-tests, ${files.length} files)`}${C.x}\n`);
process.exit(failed ? 1 : 0);

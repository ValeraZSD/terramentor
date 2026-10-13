#!/usr/bin/env node
// action-group-gates.mjs — the buttons that sit together look alike.
//
// control-gates.mjs asks whether ONE button takes its shape from `ui/`. That
// is not what a reader sees. A reader sees two buttons side by side and asks
// why one is a full-width 44px slab with an icon and the other a small
// outlined box with none — and every one of those buttons can be a perfectly
// good `<Button>` on its own. (The phone's lock screen, 13 Oct 2026: "they are
// different size, different position, they're just completely looking
// different".) So this gate reads GROUPS:
//
//   1. one action group, one size — every <Button>/<ButtonLink>/<IconButton>
//      that is a direct sibling of another (conditionals and fragments
//      flattened) has the same `size`, so they are the same height;
//   2. one width rule — either every labelled button in the group is `block`
//      or none is;
//   3. icon on all or none — a labelled button with a leading `icon` beside
//      one without reads as two kinds of control;
//   4. at most ONE `primary` in a group (the vocabulary's "one per screen",
//      checked where it is cheap to check);
//
// and one rule about where a shape may be written down at all:
//
//   5. no hand-written class constant on a native control — a
//      `const SUBMIT = "… px-4 py-2.5 bg-accent rounded-lg …"` handed to a
//      `<button className={SUBMIT}>` (or an <a>, <input>, <select>,
//      <textarea>) is the same defect as writing those classes inline, hidden
//      where control-gates' inline scan cannot see it. That is how the lock
//      screens' two buttons drifted apart unseen.
//
// The gate proves itself on every run: each rule is fed a fixture that must
// fail and one that must pass, before the app's own files are read.
//
//   node tools/action-group-gates.mjs              # this checkout
//   node tools/action-group-gates.mjs --root DIR   # another checkout (e.g. the pre-fix tree)
//   node tools/action-group-gates.mjs --json

import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : HERE;

const BUTTONS = new Set(['Button', 'ButtonLink', 'IconButton']);
const NATIVE = new Set(['button', 'a', 'input', 'select', 'textarea']);

/**
 * Groups that are deliberately not one shape, with the reason. Matched on the
 * file and a distinctive substring of the group's opening tag. Like BESPOKE in
 * control-gates: short and argued, never a habit.
 */
const ALLOWED = [];

/** Class constants on a native control that are deliberate, with the reason. */
const ALLOWED_CONSTANTS = [
    // The /schedule card's date editor: two NATIVE date fields that must fit
    // the narrowest card the grid makes. A native date field clips its own year
    // below ~106px and `scrollWidth` never says so; the field's 8px padding
    // (`TextInput` has 12) is part of the width measured by photographing it
    // in that card. Its invalid state is a border on its own surface, not
    // FIELD_BASE's, which `dark:border-slate-600` beats.
    { file: 'src/components/schedule/ScheduleBoard.tsx', name: 'field', why: 'a native date field sized by measurement to the narrowest schedule card' },
    // PR #64 rebuilds both lock screens on `ui/` (TextInput + Button, the
    // FIELD and SUBMIT strings deleted). Leave AuthGate.tsx to that PR; drop
    // these two lines when it merges.
    { file: 'src/components/AuthGate.tsx', name: 'FIELD', why: 'removed by PR #64 (lock screens on shared controls)' },
    { file: 'src/components/AuthGate.tsx', name: 'SUBMIT', why: 'removed by PR #64 (lock screens on shared controls)' },
];

/** Utilities that give a native control its shape (the control-gates set). */
const SIZING = /^(?:can-hover:|touch:|sm:|md:|lg:|dark:|group-hover:|focus-visible:|active:|disabled:)*(?:h-(?!full|auto)[\w.[\]/-]+|min-h-[\w.[\]/-]+|px-[\w.[\]/-]+|py-[\w.[\]/-]+|p-[\w.[\]/-]+|text-(?:xs|sm|base|lg|xl)|rounded(?:-[\w.[\]/-]+)?)$/;

const tagName = (el) => (ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName).getText();
const attrsOf = (el) => (ts.isJsxElement(el) ? el.openingElement.attributes : el.attributes).properties;

/** Every `const NAME = …` in the file whose initializer is an object or a string-ish. */
function constants(sf) {
    const objects = new Map(), strings = new Map();
    const visit = (n) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
            let init = n.initializer;
            while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) || ts.isSatisfiesExpression?.(init)) init = init.expression;
            if (ts.isObjectLiteralExpression(init)) objects.set(n.name.text, init);
            // A class STRING: a literal, a template, a `+` chain or a cx()/clsx()
            // call. An object of strings (`V.button`) is read through a property,
            // which is a colour table, not a shape; control-gates sees the inline rest.
            if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) || ts.isTemplateExpression(init)
                || ts.isBinaryExpression(init) || (ts.isCallExpression(init) && /^(cx|clsx|classNames)$/.test(init.expression.getText()))) {
                const text = [];
                const collect = (x) => {
                    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) text.push(x.text);
                    else if (ts.isTemplateExpression(x)) { text.push(x.head.text); x.templateSpans.forEach(s => text.push(s.literal.text)); }
                    ts.forEachChild(x, collect);
                };
                collect(init);
                if (text.length) strings.set(n.name.text, text.join(' '));
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return { objects, strings };
}

/** One button's shape, read off its props (spreads of a local object literal resolved). */
function shapeOf(el, objects) {
    const name = tagName(el);
    const shape = { name, size: 'md', block: 'false', icon: 'no', variant: name === 'IconButton' ? 'quiet' : 'neutral', line: 0 };
    const set = (key, value) => {
        if (key === 'size') shape.size = value;
        if (key === 'block') shape.block = value;
        if (key === 'icon') shape.icon = 'yes';
        if (key === 'variant') shape.variant = value;
    };
    const valueText = (init) => {
        if (!init) return 'true';
        if (ts.isStringLiteral(init)) return init.text;
        if (ts.isJsxExpression(init) && init.expression) {
            const e = init.expression;
            return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : e.getText();
        }
        return init.getText();
    };
    for (const a of attrsOf(el)) {
        if (ts.isJsxAttribute(a)) set(a.name.getText(), valueText(a.initializer));
        else if (ts.isJsxSpreadAttribute(a) && ts.isIdentifier(a.expression) && objects.has(a.expression.text)) {
            for (const p of objects.get(a.expression.text).properties) {
                if (!ts.isPropertyAssignment(p)) continue;
                const v = p.initializer;
                set(p.name.getText(), ts.isStringLiteral(v) ? v.text : v.getText());
            }
        }
    }
    return shape;
}

/**
 * The members of one group: direct children, through `&&`, `?:`, `()` and
 * fragments. Each member carries the ternary branches it sits in, because the
 * two sides of `a ? <X/> : <Y/>` are never on screen together: a running
 * screen's buttons and a finished screen's are two groups that share a slot.
 */
function members(parent, flattened) {
    const out = [];
    let ternaries = 0;
    const take = (n, path) => {
        if (!n) return;
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) { if (BUTTONS.has(tagName(n))) out.push({ el: n, path }); return; }
        if (ts.isJsxFragment(n)) { flattened.add(n); n.children.forEach(c => take(c, path)); return; }
        if (ts.isJsxExpression(n)) { take(n.expression, path); return; }
        if (ts.isParenthesizedExpression(n)) { take(n.expression, path); return; }
        if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) { take(n.right, path); return; }
        if (ts.isConditionalExpression(n)) {
            const id = ternaries++;
            take(n.whenTrue, [...path, `${id}:T`]);
            take(n.whenFalse, [...path, `${id}:F`]);
        }
    };
    parent.children.forEach(c => take(c, []));
    return out;
}

/** Two members can be on screen together unless they sit on opposite sides of one ternary. */
const together = (a, b) => !a.path.some(p => b.path.some(q => p.split(':')[0] === q.split(':')[0] && p !== q));

/** Check one source text; returns findings. `rel` names it in the report. */
export function checkSource(text, rel) {
    const found = [];
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const { objects, strings } = constants(sf);
    const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

    const flattened = new Set();
    const visit = (n) => {
        if ((ts.isJsxElement(n) || ts.isJsxFragment(n)) && !flattened.has(n)) {
            const group = members(n, flattened);
            if (group.length >= 2) {
                const head = ts.isJsxElement(n) ? n.openingElement.getText() : '<>';
                if (!ALLOWED.some(a => rel.endsWith(a.file) && head.includes(a.match))) {
                    const shapes = group.map(g => ({ ...shapeOf(g.el, objects), line: lineOf(g.el), path: g.path }));
                    const describe = (list) => list.map(s => `${s.name}@${s.line}(size=${s.size}${s.block !== 'false' ? ' block' : ''}${s.icon === 'yes' ? ' icon' : ''}${s.variant === 'primary' ? ' primary' : ''})`).join(', ');
                    const at = lineOf(n);
                    // Pairwise over the members that can be on screen together;
                    // one finding per rule per group, naming the first pair.
                    const rules = {
                        'one size': (a, b) => a.size !== b.size,
                        'one width': (a, b) => a.name !== 'IconButton' && b.name !== 'IconButton' && a.block !== b.block,
                        'icon on all or none': (a, b) => a.name !== 'IconButton' && b.name !== 'IconButton' && a.icon !== b.icon,
                        'one primary': (a, b) => a.variant === 'primary' && b.variant === 'primary',
                    };
                    for (const [rule, differs] of Object.entries(rules)) {
                        let pair = null;
                        for (let i = 0; i < shapes.length && !pair; i++)
                            for (let j = i + 1; j < shapes.length && !pair; j++)
                                if (together(shapes[i], shapes[j]) && differs(shapes[i], shapes[j])) pair = [shapes[i], shapes[j]];
                        if (pair) found.push({ file: rel, line: at, rule, detail: describe(pair) });
                    }
                }
            }
        }
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && NATIVE.has(n.tagName.getText())) {
            for (const a of n.attributes.properties) {
                if (!ts.isJsxAttribute(a) || a.name.getText() !== 'className' || !a.initializer || !ts.isJsxExpression(a.initializer)) continue;
                const used = new Set();
                const scan = (x) => {
                    const viaProperty = x.parent && ts.isPropertyAccessExpression(x.parent) && x.parent.expression === x;
                    if (ts.isIdentifier(x) && strings.has(x.text) && !viaProperty) used.add(x.text);
                    ts.forEachChild(x, scan);
                };
                scan(a.initializer.expression);
                for (const name of used) {
                    if (ALLOWED_CONSTANTS.some(a => a.file === rel && a.name === name)) continue;
                    const sizing = strings.get(name).split(/\s+/).filter(c => SIZING.test(c));
                    if (sizing.length) found.push({ file: rel, line: lineOf(n), rule: 'no hand-written class constant', detail: `<${n.tagName.getText()} className={${name}}> carries ${sizing.join(' ')}` });
                }
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
}

// --- The gate checks itself first: each rule must fail its fixture and pass its control.
const FIXTURES = [
    { rule: 'one size', bad: `<div><Button size="sm">A</Button><Button>B</Button></div>`, good: `<div><Button size="sm">A</Button><Button size="sm">B</Button></div>` },
    { rule: 'one size', bad: `<div><IconButton label="x" icon={i} size="sm" />{open && <Button>B</Button>}</div>`, good: `<div><IconButton label="x" icon={i} />{open && <Button>B</Button>}</div>` },
    { rule: 'one width', bad: `<div><Button block variant="primary">A</Button><Button>B</Button></div>`, good: `<div><Button block variant="primary">A</Button><Button block>B</Button></div>` },
    { rule: 'one width', bad: `const ACTION = { block: true, size: 'lg' } as const;\nconst x = <><Button {...ACTION}>A</Button><Button size="lg">B</Button></>;`, good: `const ACTION = { block: true, size: 'lg' } as const;\nconst x = <><Button {...ACTION}>A</Button><Button {...ACTION}>B</Button></>;` },
    { rule: 'icon on all or none', bad: `<div><Button icon={<X />}>A</Button>{ok ? <Button>B</Button> : null}</div>`, good: `<div><Button icon={<X />}>A</Button>{ok ? <Button icon={<Y />}>B</Button> : null}</div>` },
    { rule: 'one primary', bad: `<div><Button variant="primary">A</Button><Button variant="primary">B</Button></div>`, good: `<div><Button>A</Button><Button variant="primary">B</Button></div>` },
    // The two sides of a ternary are two screens sharing a slot, never siblings.
    { rule: 'one size', bad: `<div><Button size="lg">A</Button>{ok && <Button>B</Button>}</div>`, good: `<div>{done ? <Button size="lg">A</Button> : <Button>B</Button>}</div>` },
    { rule: 'one primary', bad: `<div>{x ? <Button>C</Button> : <Button variant="primary">A</Button>}<Button variant="primary">B</Button></div>`, good: `<div>{done ? <Button variant="primary">A</Button> : <Button variant="primary">B</Button>}</div>` },
    { rule: 'no hand-written class constant', bad: `const SUBMIT = "mt-5 w-full px-4 py-2.5 bg-accent rounded-lg";\nconst x = <button className={SUBMIT}>Go</button>;`, good: `const ROW = "mt-5 flex gap-2";\nconst x = <div className={ROW}><Button>Go</Button></div>;` },
    { rule: 'no hand-written class constant', bad: "const FIELD = 'w-full px-4 py-2.5 rounded-lg border';\nconst x = <input className={`${FIELD} font-mono`} />;", good: "const x = <TextInput className=\"font-mono\" />;" },
];
let selfChecked = 0;
const selfFailures = [];
for (const f of FIXTURES) {
    const bad = checkSource(f.bad, 'fixture.tsx').some(x => x.rule === f.rule);
    const good = checkSource(f.good, 'fixture.tsx').some(x => x.rule === f.rule);
    selfChecked += 2;
    if (!bad) selfFailures.push(`the "${f.rule}" rule passed a fixture it must fail: ${f.bad}`);
    if (good) selfFailures.push(`the "${f.rule}" rule failed a fixture it must pass: ${f.good}`);
}

// --- The app.
const files = globSync('src/**/*.tsx', { cwd: ROOT })
    .map(f => f.replace(/\\/g, '/'))
    .filter(f => !f.startsWith('src/components/ui/'));
const findings = [];
let groups = 0;
for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    findings.push(...checkSource(text, rel));
    groups += (text.match(/<(Button|ButtonLink|IconButton)\b/g) || []).length;
}

const failed = selfFailures.length + findings.length;
const checked = selfChecked + files.length;
if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ root: ROOT, files: files.length, selfFailures, findings }, null, 2));
} else {
    const C = { r: '\x1b[31m', g: '\x1b[32m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
    console.log(`\n${C.b}Action groups${C.x} ${C.d}(${files.length} files, ${groups} shared buttons, ${FIXTURES.length} self-test fixtures${ROOT !== HERE ? `, root ${ROOT}` : ''})${C.x}\n`);
    for (const s of selfFailures) console.log(`  ${C.r}self-test${C.x} ${s}`);
    for (const f of findings) {
        console.log(`  ${C.r}${f.rule}${C.x} ${C.d}${f.file}:${f.line}${C.x}`);
        console.log(`        ${f.detail}`);
    }
    console.log(`\n  ${failed ? '' : C.g}${checked - failed} passed, ${failed} failed${C.x}\n`);
}
process.exit(failed ? 1 : 0);

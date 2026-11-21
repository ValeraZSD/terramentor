// tools/centred-in-parent-gates.mjs — an element centred with `absolute
// left-1/2` is centred on something it sits inside.
//
// Run:  node tools/centred-in-parent-gates.mjs
//
// WHY. `absolute left-1/2 -translate-x-1/2` centres an element on its nearest
// POSITIONED ancestor. The course tree's header put its "In progress — AI
// generation" pill that way in a row that was not positioned, and nothing above
// it was either, so the pill was centred on the page: with the tree in a side
// pane it sat over the title or the Add button instead of in its row.
//
// This reads every component (Babel's TSX parser, `tools/lib/tsxAst.mjs`) and
// fails on an element whose classes hold `absolute` and `left-1/2` unless an
// element around it IN THE SAME FILE is `relative`, `absolute`, `fixed` or
// `sticky`. A component whose root is such an element, positioned by whoever
// renders it, would be flagged too: wrap it, or position it in its own file.
// Deterministic, no model, no network.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTsx } from './lib/tsxAst.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

/** Every literal piece of text inside a className attribute (strings, template parts, cx() arguments). */
function classTokens(attr) {
    const tokens = [];
    const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'StringLiteral') tokens.push(...n.value.split(/\s+/));
        else if (n.type === 'TemplateElement') tokens.push(...(n.value.cooked ?? n.value.raw).split(/\s+/));
        for (const [key, v] of Object.entries(n)) {
            if (key === 'parent' || key === 'loc') continue;
            if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
        }
    };
    walk(attr.value);
    return new Set(tokens.filter(Boolean));
}

const classesOf = (el) => {
    const attr = el.openingElement.attributes.find(a => a.type === 'JSXAttribute' && a.name?.name === 'className');
    return attr ? classTokens(attr) : new Set();
};
const POSITIONED = ['relative', 'absolute', 'fixed', 'sticky'];

/** Elements centred with absolute left-1/2 that have no positioned element around them in the file. */
export function unanchoredCentres(text, name = 'fixture.tsx') {
    const { program, lineOf } = parseTsx(text, name);
    const found = [];
    const visit = (n) => {
        if (n.type === 'JSXElement') {
            const cls = classesOf(n);
            if (cls.has('absolute') && cls.has('left-1/2')) {
                let anchored = false;
                for (let p = n.parent; p && !anchored; p = p.parent) {
                    if (p.type === 'JSXElement' && POSITIONED.some(c => classesOf(p).has(c))) anchored = true;
                }
                if (!anchored) found.push(`${name}:${lineOf(n)}`);
            }
        }
        for (const [key, v] of Object.entries(n)) {
            if (key === 'parent' || key === 'loc') continue;
            if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') visit(x); }
            else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v);
        }
    };
    visit(program);
    return found;
}

console.log('\nthe check itself');
check('a centred pill in an unpositioned row is reported',
    unanchoredCentres('const A = () => <div className="flex"><div className="absolute left-1/2 -translate-x-1/2">x</div></div>;').length === 1);
check('one inside a relative row is not',
    unanchoredCentres('const A = () => <div className="relative flex"><div className="absolute left-1/2 -translate-x-1/2">x</div></div>;').length === 0);
check('a positioned class written in a template or cx() counts',
    unanchoredCentres('const A = () => <div className={cx("flex", `sticky top-0`)}><span className={`absolute left-1/2 ${b}`} /></div>;').length === 0);
check('a variant (after:absolute) is not the element\'s own position',
    unanchoredCentres('const A = () => <div className="flex"><span className="after:absolute after:left-1/2" /></div>;').length === 0);

console.log('\nevery component');
const files = [];
const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.tsx')) files.push(p);
    }
};
walk(join(repoRoot, 'src'));
const offenders = files.flatMap(f => unanchoredCentres(readFileSync(f, 'utf8'), relative(repoRoot, f).replace(/\\/g, '/')));
check(`no element in src/ is centred on an ancestor it does not sit in (${files.length} files read)`, files.length > 50 && offenders.length === 0, offenders.join(', '));
check('the course tree header has no such element', !offenders.some(o => o.startsWith('src/components/NodeTree.tsx')), offenders.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// tools/tsx-ast-gates.mjs — the TSX reader the tools share reads a file the way
// the TypeScript compiler did.
//
// action-group-gates, control-gates and i18n-extract were written against the
// compiler's syntax tree. TypeScript 7 exports no API, so they now read TSX
// through `tools/lib/tsxAst.mjs` (Babel's parser), which keeps the handful of
// compiler habits they depend on. Run over this repository's history, the old
// and new tools agree byte for byte, but most of those habits never come up in
// the app's own code, so breaking one by hand went unnoticed there. This suite
// pins each one:
//
//   1. children in source order (Babel's key order puts a JSX element's
//      closing tag, and a template's text pieces, out of place);
//   2. a JSX text run starts at its first non-blank character;
//   3. a JSX attribute's string is read as written, entities undecoded;
//   4. `{ size }` is one child, not two;
//   5. a destructuring pattern's `a: b` is not a property assignment;
//   6. `(x)` is a node of its own;
//   7. the compiler's line breaks: CR LF, LF, CR, U+2028, U+2029.
//
// Then i18n-extract rewrites a small component in a scratch copy, and the
// result must be what the TypeScript 5.9 version of the tool wrote for the
// same input (`tools/fixtures/tsx-ast/`, captured from that version): the
// reports' line numbers depend on (2), the parenthesised strings it leaves
// alone on (6).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childrenOf, forEachChild, isPropertyAssignment, parseTsx, stringText } from './lib/tsxAst.mjs';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(toolsDir, '..');

let failures = 0;
let passed = 0;
const check = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (ok) passed++; else failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : ` — got ${a}, want ${e}`}`);
};

/** The first node of a type, depth first. */
const find = (node, type) => {
    if (node.type === type) return node;
    return forEachChild(node, (c) => find(c, type));
};
const types = (node) => childrenOf(node).map((c) => c.type);

// --- 1. source order ----------------------------------------------------------
{
    const { program } = parseTsx('const x = <p>a{b}</p>;');
    check('a JSX element: opening tag, children, closing tag', types(find(program, 'JSXElement')),
        ['JSXOpeningElement', 'JSXText', 'JSXExpressionContainer', 'JSXClosingElement']);
    const tpl = parseTsx('const x = `a${b}c`;').program;
    check('a template: text, expression, text', types(find(tpl, 'TemplateLiteral')),
        ['TemplateElement', 'Identifier', 'TemplateElement']);
}

// --- 2. a JSX text run starts at its text ----------------------------------------
{
    const src = 'const x = (\n    <p>\n        Mark done\n    </p>\n);';
    const { program, startOf, lineOf, textOf } = parseTsx(src);
    const run = find(program, 'JSXText');
    check('JSX text starts at its first letter', startOf(run), src.indexOf('Mark'));
    check('…so its line is the line the text is on', lineOf(run), 3);
    check('…and its text does not open with the indentation', textOf(run).startsWith('Mark done'), true);
    check('any other node starts where it starts', startOf(find(program, 'JSXElement')), src.indexOf('<p>'));
}

// --- 3. a JSX attribute's string, as written ------------------------------------
{
    const { program } = parseTsx('const x = <a title="Tom &amp; Jerry" />;');
    check('an attribute keeps its entities', stringText(find(find(program, 'JSXAttribute'), 'StringLiteral')), 'Tom &amp; Jerry');
    const js = parseTsx("const y = 'Tom &amp; Jerry';").program;
    check('a JavaScript string is its value', stringText(find(js, 'StringLiteral')), 'Tom &amp; Jerry');
}

// --- 4. shorthand -----------------------------------------------------------------
{
    const { program } = parseTsx('const o = { size };');
    const prop = find(program, 'ObjectProperty');
    check('`{ size }` has one child', types(prop), ['Identifier']);
    let seen = 0;
    const walk = (n) => { if (n.type === 'Identifier' && n.name === 'size') seen++; forEachChild(n, walk); };
    walk(program);
    check('…so a walk meets `size` once', seen, 1);
}

// --- 5. what counts as a property assignment --------------------------------------
{
    const props = (src) => {
        const out = [];
        const walk = (n) => { if (n.type === 'ObjectProperty') out.push(isPropertyAssignment(n)); forEachChild(n, walk); };
        walk(parseTsx(src).program);
        return out;
    };
    check('`{ a: b }` in an object literal is one', props('const o = { a: b };'), [true]);
    check('`{ a: b }` in a destructuring pattern is not', props('const { a: b } = o;'), [false]);
    check('a shorthand is not', props('const o = { a };'), [false]);
}

// --- 6. parentheses ------------------------------------------------------------------
{
    const { program, textOf } = parseTsx("const x = ('Saved');");
    const init = find(program, 'VariableDeclarator').init;
    check('`(x)` is a node', init.type, 'ParenthesizedExpression');
    check('…whose text has the parentheses', textOf(init), "('Saved')");
}

// --- 7. line breaks -----------------------------------------------------------------
{
    const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
    const src = `const a = 1;\r\nconst b = 2;\rconst c = 3;\nconst d = 4;${LS}const e = 5;${PS}const f = 6;`;
    const { lineOf } = parseTsx(src);
    check('CR LF, CR, LF, U+2028 and U+2029 each end a line',
        ['a', 'b', 'c', 'd', 'e', 'f'].map((v) => lineOf(src.indexOf(`const ${v}`))), [1, 2, 3, 4, 5, 6]);
    check('…and CR LF is one break, not two', lineOf(src.indexOf('const b') - 1), 1);
}

// --- i18n-extract, end to end, against the TypeScript 5.9 tool's output ---------
{
    const fixtures = join(toolsDir, 'fixtures', 'tsx-ast');
    const lf = (s) => s.replace(/\r\n/g, '\n');
    // Inside the repository, so the copied tool resolves @babel/parser.
    const cache = join(repoRoot, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const root = mkdtempSync(join(cache, 'tsx-ast-'));
    try {
        mkdirSync(join(root, 'tools', 'lib'), { recursive: true });
        mkdirSync(join(root, 'src', 'components'), { recursive: true });
        mkdirSync(join(root, 'src', 'locales'), { recursive: true });
        copyFileSync(join(toolsDir, 'i18n-extract.mjs'), join(root, 'tools', 'i18n-extract.mjs'));
        for (const f of ['i18nKeys.mjs', 'tsxAst.mjs']) copyFileSync(join(toolsDir, 'lib', f), join(root, 'tools', 'lib', f));
        const target = join(root, 'src', 'components', 'Fx.tsx');
        copyFileSync(join(fixtures, 'i18n-extract.input.tsx.txt'), target);
        const run = spawnSync(process.execPath, [join(root, 'tools', 'i18n-extract.mjs'), '--report'], { encoding: 'utf8' });
        check('i18n-extract exits 0', run.status, 0);
        check('it rewrites the component as the TypeScript 5.9 tool did',
            lf(readFileSync(target, 'utf8')) === lf(readFileSync(join(fixtures, 'i18n-extract.expected.tsx.txt'), 'utf8')), true);
        const handWork = (run.stdout || '').split('\n').filter((l) => /\[\w[\w-]*\]/.test(l)).map((l) => l.trim().replace(/\\/g, '/'));
        check('…and reports the same hand work, on the same lines', handWork, [
            'src/components/Fx.tsx:4  [k-table]  label: Module level label',
            'src/components/Fx.tsx:21  [code]  Sample output here',
        ]);
        const enFile = join(root, 'src', 'locales', 'en.json');
        const en = existsSync(enFile) ? JSON.parse(readFileSync(enFile, 'utf8')) : {};
        check('…and writes the same keys', Object.keys(en).filter((k) => !/_(one|other)$/.test(k)).sort(), [
            'Closed panel', 'Favourite things', 'Mark done anyway', 'Module level label', 'Opened panel',
            'Plain hint', 'Search all courses', 'Type a course name',
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

// `tools/run-gates.mjs` reads the assertion count out of this line.
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

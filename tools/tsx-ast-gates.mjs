// tools/tsx-ast-gates.mjs — the TSX reader the tools share reads a file the way
// the TypeScript compiler did.
//
// action-group-gates, control-gates and i18n-extract were written against the
// compiler's syntax tree. TypeScript 7 exports no API, so they now read TSX
// through `tools/lib/tsxAst.mjs` (Babel's parser), which keeps the compiler
// habits their output depends on. Most of them never come up in the app's own
// code, so a regression in one would pass every other suite. This one pins them:
//
//   1. children in source order (Babel's key order puts a JSX element's
//      closing tag, and a template's text pieces, out of place);
//   2. a JSX text run starts at its first non-blank character;
//   3. a JSX attribute's string is read as written, entities undecoded;
//   4. `(x)` is a node of its own;
//   5. the compiler's line breaks: CR LF, LF, CR, U+2028, U+2029;
//   6. a file the parser cannot read is a SyntaxError that names the file.
//
// Then i18n-extract rewrites a small component in a scratch copy, and the
// result must equal `tools/fixtures/tsx-ast/i18n-extract.expected.tsx.txt`.
// That file was written by the TypeScript 5.9 version of the tool, before the
// move to Babel; regenerating it from the current tool would make this check
// compare the tool with itself, so it changes only by hand, for a stated
// reason. The reports' line numbers depend on (2), the parenthesised strings
// the tool leaves alone on (4). The copy sits under a folder named `utils`,
// which the tool's skip list names, and beside a file it cannot parse.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childrenOf, forEachChild, parseTsx, stringText } from './lib/tsxAst.mjs';

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

// --- 4. parentheses ------------------------------------------------------------------
{
    const { program, textOf } = parseTsx("const x = ('Saved');");
    const init = find(program, 'VariableDeclarator').init;
    check('`(x)` is a node', init.type, 'ParenthesizedExpression');
    check('…whose text has the parentheses', textOf(init), "('Saved')");
}

// --- 5. line breaks -----------------------------------------------------------------
{
    const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
    const src = `const a = 1;\r\nconst b = 2;\rconst c = 3;\nconst d = 4;${LS}const e = 5;${PS}const f = 6;`;
    const { program, lineOf } = parseTsx(src);
    check('CR LF, CR, LF, U+2028 and U+2029 each end a line, CR LF once',
        program.body.map((statement) => lineOf(statement)), [1, 2, 3, 4, 5, 6]);
}

// --- 6. a file the parser cannot read ------------------------------------------------
{
    const thrown = (fn) => { try { fn(); return null; } catch (err) { return err; } };
    const named = thrown(() => parseTsx('export const X = () => <p>Never closed', 'src/components/X.tsx'));
    check('it throws a SyntaxError', named instanceof SyntaxError, true);
    check('…with the parser\'s code, which i18n-extract catches and nothing else', named?.code, 'BABEL_PARSER_SYNTAX_ERROR');
    check('…whose message names the file', /^src\/components\/X\.tsx: /.test(named?.message ?? ''), true);
    check('…and keeps the position', named?.loc?.line, 1);
    check('without a name, the code is still there', thrown(() => parseTsx('const = ;'))?.code, 'BABEL_PARSER_SYNTAX_ERROR');
}

// --- i18n-extract, end to end, against the TypeScript 5.9 tool's output ---------
{
    const fixtures = join(toolsDir, 'fixtures', 'tsx-ast');
    const lf = (s) => s.replace(/\r\n/g, '\n');
    const failedBefore = failures;
    // Inside the repository, so the copied tool resolves @babel/parser; under a
    // folder named like one the tool skips, which must not matter.
    const cache = join(repoRoot, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const scratch = mkdtempSync(join(cache, 'tsx-ast-'));
    const root = join(scratch, 'utils');
    let run = null;
    try {
        mkdirSync(join(root, 'tools', 'lib'), { recursive: true });
        mkdirSync(join(root, 'src', 'components'), { recursive: true });
        mkdirSync(join(root, 'src', 'locales'), { recursive: true });
        copyFileSync(join(toolsDir, 'i18n-extract.mjs'), join(root, 'tools', 'i18n-extract.mjs'));
        for (const f of ['i18nKeys.mjs', 'tsxAst.mjs']) copyFileSync(join(toolsDir, 'lib', f), join(root, 'tools', 'lib', f));
        const target = join(root, 'src', 'components', 'Fx.tsx');
        copyFileSync(join(fixtures, 'i18n-extract.input.tsx.txt'), target);
        const broken = join(root, 'src', 'components', 'Broken.tsx');
        const brokenText = 'export const Broken = () => <p>Never closed\n';
        writeFileSync(broken, brokenText);
        run = spawnSync(process.execPath, [join(root, 'tools', 'i18n-extract.mjs'), '--report'], { encoding: 'utf8' });
        check('i18n-extract exits 0', run.status, 0);
        check('it rewrites the component as the TypeScript 5.9 tool did',
            lf(readFileSync(target, 'utf8')) === lf(readFileSync(join(fixtures, 'i18n-extract.expected.tsx.txt'), 'utf8')), true);
        const handWork = (run.stdout || '').split('\n').filter((l) => /\[\w[\w-]*\]/.test(l)).map((l) => l.trim().replace(/\\/g, '/'));
        check('…and reports the same hand work, on the same lines', handWork.filter((l) => l.startsWith('src/components/Fx.tsx')), [
            'src/components/Fx.tsx:4  [k-table]  label: Module level label',
            'src/components/Fx.tsx:21  [code]  Sample output here',
        ]);
        const enFile = join(root, 'src', 'locales', 'en.json');
        const en = existsSync(enFile) ? JSON.parse(readFileSync(enFile, 'utf8')) : {};
        check('…and writes the same keys', Object.keys(en).filter((k) => !/_(one|other)$/.test(k)).sort(), [
            'Closed panel', 'Favourite things', 'Mark done anyway', 'Module level label', 'Opened panel',
            'Plain hint', 'Search all courses', 'Type a course name',
        ]);
        check('a file it cannot parse is reported as unparsed', handWork.some((l) => l.startsWith('src/components/Broken.tsx:1  [unparsed]')), true);
        check('…and left as it was', readFileSync(broken, 'utf8'), brokenText);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
    if (failures > failedBefore && run) console.log(`\ni18n-extract said:\n${run.stdout}${run.stderr}`);
}

// `tools/run-gates.mjs` reads the assertion count out of this line.
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

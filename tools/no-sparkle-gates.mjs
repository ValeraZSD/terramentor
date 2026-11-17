#!/usr/bin/env node
// no-sparkle-gates.mjs — no sparkle, star or magic-wand icon anywhere in the app.
//
// Sparkles had become the mark of "AI did this" on seventeen surfaces: the
// task bar, Create with AI, the head-start lines, Find links, the AI settings
// tab, even the Easy rating. Every AI product draws them, so they read as a
// stock tell rather than saying what the control does. Each one was replaced
// by an icon for the action itself (a pen for writing, a magnifier for a
// search, a clock-arrow for "covered before") or by the icon its launcher
// already used. This gate keeps them out:
//
//   1. No file under `src/` imports a lucide icon whose name is a sparkle, a
//      star cluster or a wand (`Sparkles`, `Sparkle`, `WandSparkles`,
//      `PencilSparkles`, `Stars`, `Wand2`, their `…Icon` / `Lucide…` aliases).
//      Every way of reaching one counts: a named or namespace import from the
//      package or any path inside it, an icon's own file, `require()` and
//      `import()`, lucide's `icons` map, and `DynamicIcon`'s `name`.
//      The forbidden set is read from the installed `lucide-react`, so an icon
//      a later lucide adds under such a name is caught without editing this.
//   2. No `✨` in `src/` outside the emoji picker's own table
//      (`src/components/emojiData.ts`), where it is an emoji a learner may
//      pick for their own project, not the app marking AI.
//
//   node tools/no-sparkle-gates.mjs              # this checkout
//   node tools/no-sparkle-gates.mjs --root DIR   # another checkout (a pre-fix tree must fail)

import { readFileSync, globSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : HERE;

const EMOJI_TABLE = 'src/components/emojiData.ts';
const SPARKLE_NAME = /sparkl|^(?:Lucide)?Stars(?:Icon)?$|^(?:Lucide)?Wand(?:2)?(?:Icon)?$/i;

const findings = [];
let checked = 0;
const ok = (name, cond, detail) => { checked++; if (!cond) findings.push({ name, detail }); return cond; };

// The forbidden names, from the lucide this checkout installs.
const lucide = createRequire(path.join(HERE, 'package.json'))('lucide-react');
const FORBIDDEN = new Set(Object.keys(lucide).filter((n) => SPARKLE_NAME.test(n)));
ok('lucide still exports Sparkles (the forbidden set is not empty)', FORBIDDEN.has('Sparkles'),
    `read ${FORBIDDEN.size} names from lucide-react`);

/** A whole-module re-export (`export * from 'lucide-react'`) hands every icon
 *  on under another module's name, so it counts as importing all of them. */
const ALL = '*';
const forbidden = (n) => n === ALL || FORBIDDEN.has(n);

/** A brace list with its comments removed and its string literals kept
 *  (`{ A = 'x//y', Sparkles }` keeps `Sparkles`). */
function withoutComments(list) {
    let out = '';
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < list.length && list[j] !== c) j += list[j] === '\\' ? 2 : 1;
            out += list.slice(i, j + 1);
            i = j;
        } else if (c === '/' && list[i + 1] === '*') {
            const end = list.indexOf('*/', i + 2);
            i = end < 0 ? list.length : end + 1;
            out += ' ';
        } else if (c === '/' && list[i + 1] === '/') {
            const end = list.indexOf('\n', i);
            i = end < 0 ? list.length : end - 1;
        } else {
            out += c;
        }
    }
    return out;
}

/** Every name a file imports or re-exports from lucide-react, by its lucide
 *  name (`X as Y` → X). Comments are not code: a comment that opens a line is
 *  dropped first (only those, so a glob like 'src/**' + '/*.ts' in a string
 *  survives), and comments inside the braces are not names. */
export function lucideImports(source) {
    const src = source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/[^\n]*/gm, '');
    const names = [];
    if (/export\s+\*(?:\s+as\s+\w+)?\s+from\s*['"]lucide-react(?:\/[^'"]*)?['"]/.test(src)) names.push(ALL);
    for (const m of src.matchAll(/(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]lucide-react(?:\/[^'"]*)?['"]/g)) {
        for (const part of withoutComments(m[1]).split(',')) {
            const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
            if (name) names.push(name);
        }
    }
    // Destructured straight off a require() or a dynamic import():
    // `const { Sparkles } = require('lucide-react')`, `= await import(...)`.
    for (const m of src.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${LOAD}`, 'g'))) names.push(...destructured(m[1]));
    // One icon per file: `import Sparkles from 'lucide-react/dist/esm/icons/sparkles'`
    // (or any import, export or load of such a path) is the icon its file is named for.
    for (const m of src.matchAll(/['"]lucide-react\/(?:[^'"]*\/)?([a-z0-9-]+)(?:\.m?js)?['"]/g)) names.push(pascal(m[1]));
    // A whole-module object: `import * as Icons from 'lucide-react[/icons]'`,
    // `const Icons = require(...)` or `await import(...)`, or lucide's own
    // `icons` map (`import { icons as I } from 'lucide-react'`); then
    // `Icons.Sparkles`, `Icons['Sparkles']` or `const { Sparkles: Mark } = Icons`.
    const objects = [
        ...[...src.matchAll(new RegExp(`import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s*${MODULE}`, 'g'))].map(m => m[1]),
        ...[...src.matchAll(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*${LOAD}`, 'g'))].map(m => m[1]),
        ...[...src.matchAll(new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*${MODULE}`, 'g'))]
            .flatMap(m => withoutComments(m[1]).split(','))
            .map(part => part.trim().split(/\s+as\s+/))
            .filter(([name]) => name === 'icons')
            .map(([name, alias]) => (alias || name).trim()),
    ];
    for (const ns of new Set(objects)) {
        for (const use of src.matchAll(new RegExp(`\\b${ns}\\s*(?:\\.\\s*(\\w+)|\\[\\s*['"\`](\\w+)['"\`]\\s*\\])`, 'g'))) names.push(use[1] || use[2]);
        for (const d of src.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${ns}\\b`, 'g'))) names.push(...destructured(d[1]));
    }
    // lucide's DynamicIcon and dynamicIconImports take the file name:
    // `<DynamicIcon name="sparkles" />`, `dynamicIconImports['wand-sparkles']`.
    if (/['"]lucide-react\/dynamic(?:IconImports)?(?:\.m?js)?['"]|\bdynamicIconImports\b/.test(src)) {
        for (const m of src.matchAll(/\bname\s*=\s*\{?\s*['"`]([a-z0-9-]+)['"`]/g)) names.push(pascal(m[1]));
        for (const m of src.matchAll(/\bdynamicIconImports\s*\[\s*['"`]([a-z0-9-]+)['"`]\s*\]/g)) names.push(pascal(m[1]));
    }
    return names;
}

/** `'lucide-react'` or any path inside it, quoted. */
const MODULE = `['"]lucide-react(?:\\/[^'"]*)?['"]`;
/** `require(MODULE)` or `[await] import(MODULE)`. */
const LOAD = `(?:await\\s+)?(?:require|import)\\s*\\(\\s*${MODULE}\\s*\\)`;
/** lucide's file names are its icon names in kebab case: `wand-sparkles` is `WandSparkles`. */
const pascal = (kebab) => kebab.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
/** The source names of a `{ A: B, C = 1, ...rest }` destructuring. */
function destructured(list) {
    return withoutComments(list).split(',')
        .map(part => part.trim().split(/\s*[:=]\s*/)[0].replace(/^\.\.\./, '').trim())
        .filter(Boolean);
}

// The detector catches the shapes it claims to catch (a gate that sees nothing proves nothing).
const sample = [
    "import { ArrowLeft, Sparkles } from 'lucide-react';",
    "import {\n    Check,\n    WandSparkles as Magic,\n} from 'lucide-react';",
    "export { Sparkle as AiMark } from 'lucide-react';",
    "import * as Icons from 'lucide-react'; const I = Icons.Stars; const { Wand2: W, Check } = Icons;",
    "import { Compass, History } from 'lucide-react';",
].join('\n');
const seen = lucideImports(sample).filter(forbidden);
ok('detector: finds a plain, a renamed, a re-exported, a namespaced and a destructured sparkle',
    seen.join(',') === 'Sparkles,WandSparkles,Sparkle,Stars,Wand2', `got ${seen.join(',') || 'nothing'}`);
const commented = lucideImports(
    "import * as Icons from 'lucide-react'; const { /* icon */ Sparkles, Check = 'a//b', Stars } = Icons;",
).filter(forbidden);
ok('detector: a comment or a string inside a destructuring hides no sparkle',
    commented.join(',') === 'Sparkles,Stars', `got ${commented.join(',') || 'nothing'}`);
const otherForms = [
    ["import Mark from 'lucide-react/dist/esm/icons/wand-sparkles';", 'WandSparkles'],
    ["import * as I from 'lucide-react/icons'; const m = I.Sparkle;", 'Sparkle'],
    ["import { icons as all } from 'lucide-react'; const m = all['Sparkles'];", 'Sparkles'],
    ["import { icons } from 'lucide-react'; const { Stars } = icons;", 'Stars'],
    ["import { DynamicIcon } from 'lucide-react/dynamic'; const m = <DynamicIcon name=\"sparkles\" />;", 'Sparkles'],
    ["import dynamicIconImports from 'lucide-react/dynamicIconImports'; dynamicIconImports['pencil-sparkles']();", 'PencilSparkles'],
    ["const { Sparkles } = require('lucide-react');", 'Sparkles'],
    ["const L = await import('lucide-react'); const m = L.WandSparkles;", 'WandSparkles'],
];
for (const [code, name] of otherForms) {
    const got = lucideImports(code);
    ok(`detector: finds ${name} in ${code.slice(0, 60)}`, got.includes(name), `got ${got.join(',') || 'nothing'}`);
}
ok('detector: lucide\'s icon paths and the icons map add no false sparkle',
    !lucideImports("import Compass from 'lucide-react/dist/esm/icons/compass'; import { icons } from 'lucide-react'; icons.History;").some(forbidden));
ok('detector: a whole-module re-export of lucide counts as importing every icon',
    lucideImports("export * from 'lucide-react';").some(forbidden));
ok('detector: passes History and Compass, a commented-out import and a comment naming Sparkles',
    !lucideImports([
        "// import { Sparkles } from 'lucide-react';",
        "/* import { Stars } from 'lucide-react'; */",
        "import {\n    Compass, // was Sparkles\n    History, /* not Stars */\n} from 'lucide-react';",
    ].join('\n')).some(forbidden));

// 1. Every code file under src/: no sparkle import.
const files = globSync('src/**/*.{ts,tsx,js,jsx,mjs,cjs}', { cwd: ROOT }).map((f) => f.replace(/\\/g, '/')).sort();
ok('src/ has source files to scan', files.length > 50, `${files.length} files under ${ROOT}`);
for (const rel of files) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    const bad = lucideImports(src).filter(forbidden);
    ok(`${rel}: no sparkle icon`, bad.length === 0, `imports ${[...new Set(bad)].join(', ')} from lucide-react`);
}
// 2. Every text file under src/ (code, locale JSON, SVG, CSS, HTML): no ✨.
const textFiles = globSync('src/**/*.{ts,tsx,js,jsx,mjs,cjs,json,svg,css,html,md}', { cwd: ROOT }).map((f) => f.replace(/\\/g, '/')).sort();
for (const rel of textFiles) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    if (rel !== EMOJI_TABLE && src.includes('✨')) {
        const line = src.slice(0, src.indexOf('✨')).split('\n').length;
        ok(`${rel}: no ✨`, false, `line ${line}`);
    }
}

// ---------------------------------------------------------------------------
const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
console.log(`\n${C.b}No sparkle icons${C.x} ${C.d}(${files.length} files, ${ROOT === HERE ? 'this checkout' : ROOT})${C.x}\n`);
if (!findings.length) {
    console.log(`  ${C.g}${checked} passed, 0 failed${C.x} ${C.d}· none of lucide's ${FORBIDDEN.size} sparkle, star or wand names imported from lucide-react, no ✨ outside the emoji picker${C.x}\n`);
} else {
    console.log(`  ${checked - findings.length} passed, ${findings.length} failed\n`);
    for (const f of findings) console.log(`  ${C.r}${f.name}${C.x}\n        ${C.d}${f.detail ?? ''}${C.x}`);
    console.log('');
}
process.exit(findings.length ? 1 : 0);

#!/usr/bin/env node
/**
 * Dependency gates — the manifest must describe what the code actually needs.
 *
 *   node tools/dep-gates.mjs
 *
 * Two failure modes, both of which are SILENT until the day they are not, which
 * is what earns them a gate rather than a code review.
 *
 *   1. **Used but not declared** — the phantom dependency. npm hoists a
 *      transitive package to the top of `node_modules`, so `import 'katex'`
 *      resolves and everything works, while `package.json` never asked for it.
 *      Nothing breaks until the package that really pulled it in changes its own
 *      dependency, or npm changes how it flattens — at which point the app stops
 *      building on a fresh clone for a reason nothing in the diff explains.
 *      `esbuild` was one (two gate suites `require` it and only Vite installed
 *      it); `katex` and `hast-util-sanitize` were two more, both on the render
 *      path of every lesson.
 *
 *   2. **Declared but not used** — dead weight in the install, and worse, a name
 *      that looks like a decision somebody made. `highlight.js` and
 *      `rehype-highlight` sat here for months while the app highlighted through
 *      Prism, and `rehype-sanitize` sat DECLARED-and-never-imported while the
 *      markdown pipeline ran with no sanitizer at all — a live XSS hole that a
 *      reader of `package.json` would have concluded was closed.
 *
 * The second direction cannot be answered by scanning imports alone: a build
 * tool is used by being NAMED in a config file or an npm script, never imported.
 * So config files, `package.json` scripts and the Dockerfile are scanned for
 * bare mentions too, `@types/x` counts as used whenever `x` is, and whatever is
 * left over goes on an explicit allowlist WITH A REASON — never quietly.
 *
 * No model, no network, no database. Pure filesystem.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
const ok = (cond, label) => { if (cond) passed += 1; else failures.push(label); };

// --- what counts as "not a package" ---------------------------------------

// `node:fs` and bare `fs` both. A core module is never a dependency.
const CORE = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

// npm's own name rules. Everything the regexes below scrape that is not a real
// package name — a fragment of prose from a comment, a chunk of a template
// literal — fails this and is dropped, which is what keeps the scanner honest
// without needing a JavaScript parser.
const NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
// `temp/` is the scratch directory (harness runs, probes, generated bundles);
// `dist/` and `node_modules/` are output and input, not source.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'temp', '.git', '.claude']);

/** Packages declared on purpose that no scan can see. Each needs a reason. */
const ALLOWLIST = {
    postcss: 'the engine Tailwind and Vite run through; named by neither, required by both',
    typescript: 'invoked as the `tsc` binary by `npm run check` and by the editor, never imported',
    '@tesseract.js-data/eng': 'the English OCR model. It is DATA: `server/pdfRecovery.js` resolves its '
        + 'directory and hands the path to tesseract.js as `langPath`, so nothing imports it. Removing it '
        + 'does not break the build — it sends the first OCR to cdn.jsdelivr.net instead, which is the one '
        + 'outbound connection SECURITY.md promises the app never makes',
};

// --- collect source files --------------------------------------------------

function walk(dir, out = []) {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else if (SOURCE_EXT.has(extname(entry.name))) out.push(p);
    }
    return out;
}

/**
 * Block comments and line-initial line comments come off first. A doc comment
 * in this repo routinely writes prose like "import the deck from Anki", and a
 * scraper that reads that as an import statement reports a package called
 * "the deck from Anki". Only line-INITIAL `//` is stripped, because a `//`
 * inside a string is almost always a URL.
 */
const decomment = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * The specifier forms that create a real dependency at build or run time.
 *
 * Two rules keep a regex scanner from reading prose as code. Every pattern
 * keeps `[^'"();]` between the keyword and the quote, so a match can never run
 * past the end of one statement into the next string in the file; and the three
 * static forms are anchored to the START OF A LINE, because an ES module's
 * `import`/`export … from` is only legal at the top level, while the same words
 * inside a sentence in a string are not ("not an import from 'x'" is text).
 * `require(` and dynamic `import(` are expressions and are matched anywhere.
 */
const PATTERNS = [
    /^[ \t]*import\b[^'"();]*?\bfrom\s*['"]([^'"]+)['"]/gm,   // import x from 'p'
    /^[ \t]*export\b[^'"();]*?\bfrom\s*['"]([^'"]+)['"]/gm,   // export { x } from 'p'
    /^[ \t]*import\s+['"]([^'"]+)['"]/gm,                     // import 'p' (side effect / css)
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                // require('p')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                 // await import('p')
];

/**
 * Specifier → the package it names, or null when it names no package.
 *
 * Subpath imports (`katex/dist/katex.min.css`, `tailwindcss/plugin`) resolve to
 * their package; scoped names keep two segments. Vite query suffixes (`?url`,
 * `?raw`, `?worker`) are cut — `p5/lib/p5.min.js?url` is still a use of p5.
 */
export function packageOf(specifier) {
    const s = String(specifier).split('?')[0].split('#')[0];
    if (!s) return null;
    if (s.startsWith('.') || s.startsWith('/') || s.startsWith('\0')) return null;
    if (/^[a-zA-Z]:[\\/]/.test(s)) return null;             // an absolute Windows path
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith('node:')) return null; // http:, data:, file:
    if (CORE.has(s)) return null;
    const parts = s.split('/');
    const name = s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (CORE.has(name)) return null;
    return NAME.test(name) ? name : null;
}

/** package name → the files that import it. */
function scanImports(files) {
    const used = new Map();
    for (const file of files) {
        const src = decomment(readFileSync(file, 'utf8'));
        for (const re of PATTERNS) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(src))) {
                const name = packageOf(m[1]);
                if (!name) continue;
                if (!used.has(name)) used.set(name, new Set());
                used.get(name).add(relative(root, file).replace(/\\/g, '/'));
            }
        }
    }
    return used;
}

// Source roots. `tools/` is included deliberately: the gate suites are the place
// the last phantom lived, and a suite that stops being runnable takes the guard
// down with it.
// This file is the one deliberate exclusion: it carries a fixture of import
// statements whose whole purpose is to be scanned, and counting those as real
// uses would report six packages that do not exist.
const SELF = join(root, 'tools', 'dep-gates.mjs');
const sourceFiles = [
    ...walk(join(root, 'src')),
    ...walk(join(root, 'server')),
    ...walk(join(root, 'tools')),
].filter((f) => f !== SELF);

// Config files are source too — they import plugins.
const CONFIG_FILES = ['vite.config.ts', 'tailwind.config.js', 'postcss.config.js'];
for (const f of CONFIG_FILES) {
    const p = join(root, f);
    if (existsSync(p)) sourceFiles.push(p);
}

ok(sourceFiles.length > 100, `the scan found source files (${sourceFiles.length})`);

const used = scanImports(sourceFiles);

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const deps = pkg.dependencies || {};
const devDeps = pkg.devDependencies || {};
const declared = new Map([...Object.entries(deps), ...Object.entries(devDeps)]);

// Text a build tool can be *named* in without being imported: PostCSS plugin
// keys, npm scripts, the Dockerfile's own commands, CI workflow steps.
//
// `package.json` contributes its SCRIPTS ONLY, never the whole file. Reading it
// whole is the obvious thing to do and it silently disables this entire half of
// the suite: every declared package is named in `dependencies`, so every
// declared package would count as mentioned, and an unused one could never be
// reported. Caught by adding `left-pad` to the manifest and watching the gate
// stay green.
const WORKFLOWS = join(root, '.github', 'workflows');
const mentionText = [
    ...CONFIG_FILES.map((f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '')),
    existsSync(join(root, 'Dockerfile')) ? readFileSync(join(root, 'Dockerfile'), 'utf8') : '',
    JSON.stringify(pkg.scripts || {}),
    ...(existsSync(WORKFLOWS)
        ? readdirSync(WORKFLOWS).map((f) => readFileSync(join(WORKFLOWS, f), 'utf8'))
        : []),
].join('\n');

/** Is this package named (not imported) somewhere that makes it load-bearing? */
const mentioned = (name) => new RegExp(`(?:^|[^a-zA-Z0-9@/._-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9._-])`)
    .test(mentionText);

// --- 1. used but not declared (the phantom case) ---------------------------

const undeclared = [...used.keys()].filter((n) => !declared.has(n)).sort();
for (const name of undeclared) {
    failures.push(`phantom dependency: ${name} is imported by `
        + `${[...used.get(name)].slice(0, 3).join(', ')} but is in neither dependencies nor devDependencies`);
}
if (!undeclared.length) passed += 1;

// The two that were phantoms until 2026-09-04, asserted by name so the fix
// cannot be undone by a `npm install` that rewrites the manifest.
for (const name of ['katex', 'hast-util-sanitize', 'esbuild']) {
    ok(declared.has(name), `${name} is declared (it was a phantom once)`);
    ok(used.has(name), `${name} is actually imported somewhere`);
}

// A dependency the runtime image needs must be a real `dependency`: the
// Dockerfile's deps stage runs `npm ci --omit=dev`, so a runtime import
// declared under devDependencies builds locally and 500s in the container.
for (const name of ['katex', 'hast-util-sanitize']) {
    ok(name in deps, `${name} is a runtime dependency, not a devDependency`);
}

// Pinned exactly, for the same reason `esbuild`, `pdfjs-dist` and
// `@napi-rs/canvas` are: these are versions we measured against, not a range we
// are inviting npm to reinterpret.
for (const name of ['katex', 'hast-util-sanitize']) {
    ok(/^\d+\.\d+\.\d+/.test(declared.get(name) || ''),
        `${name} is pinned to an exact version (got ${declared.get(name)})`);
}

// --- 2. declared but not used ----------------------------------------------

const unused = [];
for (const name of declared.keys()) {
    if (used.has(name)) continue;
    if (mentioned(name)) continue;                       // named in a config or an npm script
    if (name in ALLOWLIST) continue;                     // documented above, with a reason
    if (name.startsWith('@types/')) {
        // A type package is used exactly when the package it describes is.
        const target = name.slice('@types/'.length).replace('__', '/');
        if (used.has(target) || used.has(`@${target}`) || mentioned(target)) continue;
    }
    unused.push(name);
}
for (const name of unused) {
    failures.push(`declared but unused: ${name} is in package.json but nothing imports, `
        + `configures or scripts it — remove it, or add it to ALLOWLIST with a reason`);
}
if (!unused.length) passed += 1;

// The allowlist is a list of exceptions, not a place to park things: every entry
// must still be installed and must still carry a reason.
for (const [name, reason] of Object.entries(ALLOWLIST)) {
    ok(declared.has(name), `allowlisted ${name} is still declared (drop the entry if it is not)`);
    ok(typeof reason === 'string' && reason.length > 20, `allowlisted ${name} carries a reason`);
}

// --- 3. the scanner itself --------------------------------------------------
// A resolver that quietly stopped recognising a form would make this whole
// suite pass by seeing nothing, so the shapes it must handle are asserted
// directly rather than inferred from a green run.

ok(packageOf('katex/dist/katex.min.css') === 'katex', 'a subpath import resolves to its package');
ok(packageOf('@dnd-kit/sortable') === '@dnd-kit/sortable', 'a scoped package keeps both segments');
ok(packageOf('@dnd-kit/core/dist/x.js') === '@dnd-kit/core', 'a scoped subpath resolves to the scope+name');
ok(packageOf('p5/lib/p5.min.js?url') === 'p5', 'a Vite ?url suffix is not part of the name');
ok(packageOf('./store') === null, 'a relative import is not a package');
ok(packageOf('../../utils/tree') === null, 'a parent-relative import is not a package');
ok(packageOf('node:fs') === null, 'a node: builtin is not a package');
ok(packageOf('crypto') === null, 'a bare builtin is not a package');
ok(packageOf('https://example.com/x.js') === null, 'a URL specifier is not a package');
ok(packageOf('the deck from Anki') === null, 'prose scraped out of a comment is not a package');

// The patterns themselves, driven over a fixture rather than trusted.
const fixture = `
/* import Nonsense from 'block-comment-pkg'; */
// import Nonsense from 'line-comment-pkg';
import React from 'react';
import {
    a,
    b,
} from 'multiline-pkg';
import 'katex/dist/katex.min.css';
export { thing } from 'reexport-pkg';
const x = require('required-pkg');
const y = await import('dynamic-pkg');
const s = "not an import from 'string-pkg'";
`;
const fixtureFile = join(root, 'tools', '.dep-gate-fixture.probe');
const found = (() => {
    const src = decomment(fixture);
    const names = new Set();
    for (const re of PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src))) {
            const n = packageOf(m[1]);
            if (n) names.add(n);
        }
    }
    return names;
})();
for (const name of ['react', 'multiline-pkg', 'katex', 'reexport-pkg', 'required-pkg', 'dynamic-pkg']) {
    ok(found.has(name), `the scanner sees ${name}`);
}
ok(!found.has('block-comment-pkg'), 'an import inside a block comment is not a use');
ok(!found.has('line-comment-pkg'), 'an import inside a line comment is not a use');
ok(!found.has('string-pkg'), 'a quoted mention inside a string is not a use');
void fixtureFile;

// --- report -----------------------------------------------------------------

if (failures.length) {
    console.error(`\n${failures.length} FAILED:`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\n${passed} passed, ${failures.length} failed`);
    process.exit(1);
}
console.log(`\n${passed} passed, 0 failed`);

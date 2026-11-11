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

/** Every name a file imports or re-exports from lucide-react, by its lucide
 *  name (`X as Y` → X). Comments inside the braces are not names. */
export function lucideImports(src) {
    const names = [];
    for (const m of src.matchAll(/(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]lucide-react(?:\/[^'"]*)?['"]/g)) {
        const list = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        for (const part of list.split(',')) {
            const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
            if (name) names.push(name);
        }
    }
    // `import * as Icons from 'lucide-react'` then `Icons.Sparkles`.
    for (const ns of src.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s*['"]lucide-react['"]/g)) {
        for (const use of src.matchAll(new RegExp(`\\b${ns[1]}\\.(\\w+)`, 'g'))) names.push(use[1]);
    }
    return names;
}

// The detector catches the shapes it claims to catch (a gate that sees nothing proves nothing).
const sample = [
    "import { ArrowLeft, Sparkles } from 'lucide-react';",
    "import {\n    Check,\n    WandSparkles as Magic,\n} from 'lucide-react';",
    "export { Sparkle as AiMark } from 'lucide-react';",
    "import * as Icons from 'lucide-react'; const I = Icons.Stars;",
    "import { Compass, History } from 'lucide-react';",
].join('\n');
const seen = lucideImports(sample).filter((n) => FORBIDDEN.has(n));
ok('detector: finds a plain, a renamed, a re-exported and a namespaced sparkle', seen.join(',') === 'Sparkles,WandSparkles,Sparkle,Stars', `got ${seen.join(',') || 'nothing'}`);
ok('detector: passes History and Compass, and a comment naming Sparkles',
    !lucideImports("import {\n    Compass, // was Sparkles\n    History, /* not Stars */\n} from 'lucide-react';").some((n) => FORBIDDEN.has(n)));

// 1 + 2. Every source file.
const files = globSync('src/**/*.{ts,tsx,js,jsx}', { cwd: ROOT }).map((f) => f.replace(/\\/g, '/')).sort();
ok('src/ has source files to scan', files.length > 50, `${files.length} files under ${ROOT}`);
for (const rel of files) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    const bad = lucideImports(src).filter((n) => FORBIDDEN.has(n));
    ok(`${rel}: no sparkle icon`, bad.length === 0, `imports ${[...new Set(bad)].join(', ')} from lucide-react`);
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

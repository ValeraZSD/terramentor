// tools/visual-registry-gates.mjs — the two halves of the visual system agree.
//
// Run:  node tools/visual-registry-gates.mjs
//
// A visual kind exists twice: the SERVER advertises a fence in VISUALS_GUIDE
// (and gates it in VISUAL_KIND_IDS, and carries a repair hint for it), and the
// CLIENT resolves that fence to a renderer in src/components/visuals/registry.
// Nothing connected the two lists, so a kind could be advertised to the model
// with no renderer behind it — and the failure is invisible in review: the
// model writes a perfectly good ```foo block and the learner gets a grey slab
// of source, with no error anywhere, because "no renderer" is indistinguishable
// from "ordinary code fence" by design.
//
// The names deliberately do NOT match across the boundary: the server's id is
// `vega-lite` (what the model types) and the client's canonical kind is `vega`
// (what draws it). So every assertion here goes through `getVisualKind`, the
// real alias table, rather than comparing strings — which is also what makes
// this gate worth having, since a plain string check would have to be wrong.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const scratch = mkdtempSync(join(tmpdir(), 'visual-registry-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
// …and VAULT_ROOT, or the blob store resolves to the learner's real server/vault.
process.env.VAULT_ROOT = join(scratch, 'vault');

const out = join(scratch, 'registry.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/visuals/registry.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
    // The renderers are only ever reached through a lazy import(), and pulling
    // mermaid, vega and p5 into a gate would cost more than the gate saves.
    plugins: [{
        name: 'drop-renderers',
        setup(build) {
            build.onResolve({ filter: /\.\/render[A-Z]/ }, (a) => ({ path: a.path, external: true }));
        },
    }],
});

const { getVisualKind, VISUAL_KIND_LABELS } = await import(pathToFileURL(out).href);

// `drill` is advertised as a fence but is not a drawing: Markdown.tsx resolves
// it with getDrillLang and mounts the practice launcher. It still has to have a
// handler, so the parity question is "does SOMETHING claim this fence".
const drillOut = join(scratch, 'parseDrill.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/drills/parseDrill.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: drillOut, logLevel: 'silent',
    plugins: [{
        name: 'drop-renderers',
        setup(build) { build.onResolve({ filter: /\.\/render[A-Z]/ }, (a) => ({ path: a.path, external: true })); },
    }],
});
const { getDrillLang } = await import(pathToFileURL(drillOut).href);
const { VISUAL_KIND_IDS, buildVisualsGuide, QUIZ_VISUALS_GUIDE } = await import(new URL('../server/ai.js', import.meta.url).href);

const registrySrc = readFileSync(new URL('../src/components/visuals/registry.ts', import.meta.url), 'utf8');
const aiSrc = readFileSync(new URL('../server/ai.js', import.meta.url), 'utf8');

/** Keys of the RENDERERS map — the kinds that can actually draw something. */
const rendererKinds = (() => {
    const body = registrySrc.slice(registrySrc.indexOf('const RENDERERS'), registrySrc.indexOf('/** Fence language'));
    return [...body.matchAll(/^\s{4}([\w-]+):\s*\(\)\s*=>/gm)].map(m => m[1]);
})();

/** Keys of the server's VISUAL_REPAIR_HINTS map. */
const repairHintKinds = (() => {
    const start = aiSrc.indexOf('const VISUAL_REPAIR_HINTS = {');
    const body = aiSrc.slice(start, aiSrc.indexOf('\n};', start));
    return [...body.matchAll(/^\s{4}'?([\w-]+)'?:/gm)].map(m => m[1]);
})();

/** Fence languages the guide advertises, as the model reads them. */
const guideFences = (guide) => [...guide.matchAll(/^- (?:\\`\\`\\`|```)([\w-]+)/gm)].map(m => m[1]);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

section('the lists were actually found (a silent empty list passes everything)');
check('renderers were parsed out of the registry', rendererKinds.length >= 6, JSON.stringify(rendererKinds));
check('repair hints were parsed out of ai.js', repairHintKinds.length >= 6, JSON.stringify(repairHintKinds));
const fullGuide = buildVisualsGuide({ p5: true, widget: true, off: new Set() });
const fences = guideFences(fullGuide);
check('fences were parsed out of the guide', fences.length >= 5, JSON.stringify(fences));

section('everything the model is offered has a handler');
for (const fence of fences) {
    const kind = getVisualKind(fence);
    const handled = (!!kind && rendererKinds.includes(kind)) || getDrillLang(fence) === 'drill';
    check(`\`\`\`${fence} is claimed by a renderer or the drill launcher`, handled, `getVisualKind → ${kind}`);
}
for (const id of VISUAL_KIND_IDS) {
    // `drill` is the one id that is not a drawing: it is practice data, rendered
    // by DrillLauncher rather than by a visual renderer.
    if (id === 'drill') continue;
    const kind = getVisualKind(id);
    check(`the gallery's "${id}" resolves to a renderer`, !!kind && rendererKinds.includes(kind), `getVisualKind → ${kind}`);
}

section('everything that can be drawn can be named and repaired');
for (const kind of rendererKinds) {
    check(`"${kind}" has a label for the streaming placeholder`, typeof VISUAL_KIND_LABELS[kind] === 'string');
    // The hint is looked up by the fence language the block carried, so either
    // the canonical kind or one of the ids the server uses must be present.
    const named = repairHintKinds.some(h => h === kind || getVisualKind(h) === kind);
    check(`"${kind}" has a repair hint`, named, `hints: ${repairHintKinds.join(', ')}`);
}

section('the assessment guide is a subset, not a second vocabulary');
const quizFences = guideFences(QUIZ_VISUALS_GUIDE);
check('the quiz guide advertises something', quizFences.length >= 3, JSON.stringify(quizFences));
for (const fence of quizFences) {
    const kind = getVisualKind(fence);
    check(`quiz \`\`\`${fence} resolves to a renderer`, !!kind && rendererKinds.includes(kind), `getVisualKind → ${kind}`);
    check(`quiz \`\`\`${fence} is also in the full guide`, fences.includes(fence));
}
// A graded question must never sit there compiling a widget or waiting on a
// specialist drawing pass, so the expensive kinds stay out of the quiz guide.
for (const expensive of ['p5', 'widget', 'animation', 'drill']) {
    check(`the quiz guide does not offer \`\`\`${expensive}`, !quizFences.includes(expensive));
}

section('a kind switched off is not advertised');
// p5 and widget are switched off through their own flags, not through `off`:
// they are gated on model SIZE as well as on the gallery, and a caller may
// suppress one while keeping the other (the feed allows one widget per topic,
// so every part after the first asks for the guide with `widget: false`).
// Passing the flag is therefore the real mechanism for those two.
for (const id of VISUAL_KIND_IDS) {
    const opts = id === 'p5' ? { p5: false, widget: true, off: new Set() }
        : id === 'widget' ? { p5: true, widget: false, off: new Set() }
            : { p5: true, widget: true, off: new Set([id]) };
    const trimmed = buildVisualsGuide(opts);
    check(`"${id}" disappears from the guide when switched off`, !guideFences(trimmed).includes(id),
        JSON.stringify(guideFences(trimmed)));
}
check('switching one off leaves the others', guideFences(buildVisualsGuide({ p5: true, widget: true, off: new Set(['smiles']) })).length === fences.length - 1);

// Importing ai.js opens the database, and better-sqlite3 still holds the file
// on Windows, where an open handle makes the directory undeletable. It is in
// the OS temp dir either way.
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

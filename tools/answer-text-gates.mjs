// tools/answer-text-gates.mjs — what Copy puts on the clipboard.
//
// Run:  node tools/answer-text-gates.mjs
//
// Four marker conventions now live in a stored assistant message, because a
// model cannot be trusted to write a control: `[[boss-fight]]` /
// `[[next-topic]]` become the tutor's buttons, `[[open:p:n]]` becomes the
// assistant's topic chips, `[[set:key:value]]` its settings chips, `[[src:N]]`
// a citation. Each surface strips the ones it knows about before RENDERING —
// and that is precisely where this broke: the tutor's Copy handed over
// `msg.content`, the raw row, so an answer pasted into someone's notes arrived
// with `[[next-topic]]` still in it.
//
// So Copy goes through one function that knows all four, and the assertions
// below are as much about what it must NOT remove: a fenced spec is the
// diagram's source and belongs in a paste, and the resolved sources line is
// attribution that should travel with the text it supports.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const scratch = mkdtempSync(join(tmpdir(), 'answer-text-gates-'));
const out = join(scratch, 'answerText.mjs');

await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/answerText.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
    // assistantSettings reaches the store only for its constants.
    plugins: [{
        name: 'stub-store',
        setup(build) {
            build.onResolve({ filter: /\/store$/ }, () => ({ path: 'store-stub', namespace: 'stub' }));
            build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                contents: `
                    export const THEME_IDS = ['light', 'warm', 'dark', 'black'];
                    export const MIN_UI_SCALE = 80;
                    export const MAX_UI_SCALE = 160;
                `,
                loader: 'js',
            }));
        },
    }],
});

const { readableAnswer } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

section('every marker convention is stripped, whichever surface owns it');
const cases = {
    'a tutor action': 'You have this now.\n\n[[next-topic]]',
    'a boss-fight offer': 'Ready when you are.\n\n[[boss-fight]]',
    'an assistant topic chip': 'Start with vectors. [[open:3:41]]',
    'a settings change': 'Switching to dark. [[set:theme:dark]]',
    'a grounding marker': 'The rule is three figures. [[src:2]]',
};
for (const [name, text] of Object.entries(cases)) {
    const copied = readableAnswer(text);
    check(`${name} never reaches the clipboard`, !copied.includes('[['), JSON.stringify(copied));
    check(`${name} leaves its sentence intact`, copied.length > 0 && !copied.endsWith('['));
}
const all = readableAnswer('Done. [[src:1]] Next up. [[open:3:41]] [[set:theme:dark]]\n\n[[next-topic]]');
check('all four in one message', !all.includes('[['), JSON.stringify(all));
check('and the prose survives', all.includes('Done.') && all.includes('Next up.'), JSON.stringify(all));

section('what a paste must KEEP');
const withVisual = 'Here is the shape:\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nRead it top down. [[src:1]]';
const copiedVisual = readableAnswer(withVisual);
check('a fenced spec is the answer, not scaffolding', copiedVisual.includes('```mermaid') && copiedVisual.includes('A --> B'));
const withSources = 'The rule is three figures.\n\n---\nSources: Lecture notes week 3 · [Exam board notice](https://example.org/x)';
check('the resolved sources line travels with the text', readableAnswer(withSources) === withSources,
    JSON.stringify(readableAnswer(withSources)));
check('ordinary markdown is untouched',
    readableAnswer('**Bold**, $x^2$, a [link](https://example.org) and a list:\n\n* one\n* two')
    === '**Bold**, $x^2$, a [link](https://example.org) and a list:\n\n* one\n* two');

section('the edges');
check('empty in, empty out', readableAnswer('') === '');
check('a non-string is survivable', readableAnswer(undefined) === '' && readableAnswer(null) === '');
check('a message that is ONLY a marker copies as nothing',
    readableAnswer('[[next-topic]]') === '', JSON.stringify(readableAnswer('[[next-topic]]')));
// Mid-stream the text can end inside a marker; a Copy offered then must not
// paste half of one.
check('a half-written marker is stripped while streaming',
    readableAnswer('Almost done. [[next-to', true) === 'Almost done.',
    JSON.stringify(readableAnswer('Almost done. [[next-to', true)));
check('trailing whitespace left by a removed marker is trimmed',
    !/\s$/.test(readableAnswer('Answer here.\n\n[[boss-fight]]\n\n')));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

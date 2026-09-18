// tools/citation-gates.mjs — grounding citations, both halves.
//
// Run:  node tools/citation-gates.mjs
//
// The tutor and the assistant retrieve from the learner's own vault and paste
// the winning chunks into the prompt, but the answer used to name nothing: a
// claim built on their lecture notes read exactly like a claim the model
// invented. `[[src:N]]` is the fix, and it follows the rules the app's other
// model-written markers (`[[open:p:n]]`, `[[set:key:value]]`) already have:
//
//   - a marker NEVER survives into the text — leaked into a message it is
//     scaffolding to read past, leaked into a Copy it is nonsense in someone
//     else's document;
//   - a marker naming a source that was not retrieved produces NOTHING, the
//     same contract an invented node id has. Citing a document that was not
//     offered is inventing a provenance, which is worse than offering none;
//   - the resolved form is the message TEXT, so a conversation reopened next
//     week still says where its answer came from.
//
// Pure string in, string out: no model, no database, no network.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const { resolveCitations, formatSourceContext } = await import(new URL('../server/citations.js', import.meta.url).href);

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const scratch = mkdtempSync(join(tmpdir(), 'citation-gates-'));
const out = join(scratch, 'citations.mjs');
await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/utils/citations.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
});
const { stripCitationMarkers } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

const SOURCES = [{ n: 1, title: 'Lecture notes week 3' }, { n: 2, title: 'Textbook ch. 4' }];

section('a cited source becomes a named source');
const one = resolveCitations('Ohm\'s law relates the three. [[src:1]]', SOURCES);
check('the marker is gone', !one.text.includes('[[src:'), JSON.stringify(one.text));
check('the document is named', one.text.includes('Lecture notes week 3'), JSON.stringify(one.text));
check('the sentence is untouched', one.text.startsWith("Ohm's law relates the three."));
check('the marker took its leading space with it', !/three\. \n/.test(one.text) && one.text.includes('three.\n'),
    JSON.stringify(one.text));
check('the cited list is reported', JSON.stringify(one.cited) === JSON.stringify(['Lecture notes week 3']));

const two = resolveCitations('First. [[src:2]]\n\nSecond. [[src:1]]', SOURCES);
check('two sources are both listed', two.text.includes('Textbook ch. 4') && two.text.includes('Lecture notes week 3'));
check('they are listed in the order they were cited',
    two.text.indexOf('Textbook ch. 4') < two.text.indexOf('Lecture notes week 3'), JSON.stringify(two.text));
const repeated = resolveCitations('A. [[src:1]] B. [[src:1]] C. [[src:1]]', SOURCES);
check('one document is listed once however often it is cited',
    (repeated.text.match(/Lecture notes week 3/g) || []).length === 1, JSON.stringify(repeated.text));

section('a source that was not retrieved produces nothing');
const invented = resolveCitations('A confident claim. [[src:7]]', SOURCES);
check('the invented marker is still stripped', !invented.text.includes('[[src:'), JSON.stringify(invented.text));
check('no sources line is written', !invented.text.includes('Sources:'), JSON.stringify(invented.text));
check('nothing is reported as cited', invented.cited.length === 0);
check('a marker with no sources at all cites nothing',
    resolveCitations('Claim. [[src:1]]', []).cited.length === 0);

section('an answer with no markers is returned untouched');
const plain = 'An ordinary answer with **bold**, $x^2$ and a ```mermaid fence.';
check('identical string back', resolveCitations(plain, SOURCES).text === plain);
check('empty input is safe', resolveCitations('', SOURCES).text === '' && resolveCitations(null, SOURCES).text === '');

section('resolving twice does not stack a second list');
const once = resolveCitations('A. [[src:1]]', SOURCES);
const twice = resolveCitations(once.text, SOURCES);
check('the sources line appears once', (twice.text.match(/Sources: /g) || []).length === 1, JSON.stringify(twice.text));

section('the prompt block numbers what it offers');
const ctx = formatSourceContext([
    { content: 'V = IR', title: 'Lecture notes week 3' },
    { content: 'Kirchhoff', title: 'Textbook ch. 4' },
]);
check('each chunk is numbered', ctx.text.includes('[1] Lecture notes week 3') && ctx.text.includes('[2] Textbook ch. 4'));
check('the numbers match the source list', JSON.stringify(ctx.sources.map(s => s.n)) === '[1,2]');
check('the chunk text is carried', ctx.text.includes('V = IR') && ctx.text.includes('Kirchhoff'));
check('the citing instruction rides with the sources', ctx.text.includes('[[src:1]]'));
// A turn that retrieved nothing must never be told about markers — a model
// offered the vocabulary with no sources will cite one anyway.
const empty = formatSourceContext([]);
check('no chunks → no block at all', empty.text === '' && empty.sources.length === 0);
check('an untitled document still gets a name', formatSourceContext([{ content: 'x', title: '' }]).sources[0].title === 'Untitled document');

// --- the web half ----------------------------------------------------------
//
// A vault document and a web page are ONE numbered list, cited the same way,
// and the difference shows up only where it matters: a page has somewhere to
// send the learner, and the whole point of citing one is that the claim can be
// checked at it. A web citation that is not a link is barely a citation.
section('a web source is cited as a link, a document as plain text');
const mixed = formatSourceContext([
    { content: 'V = IR', title: 'Lecture notes week 3' },
    { content: 'The 2026 syllabus drops paper 3.', title: 'Exam board notice', url: 'https://example.org/notice' },
]);
check('the web source carries its url into the prompt', mixed.text.includes('https://example.org/notice'));
check('the url is kept on the source list', mixed.sources[1].url === 'https://example.org/notice');
check('a vault source has no url', mixed.sources[0].url === undefined);

const bothCited = resolveCitations('Local rule. [[src:1]] New rule. [[src:2]]', mixed.sources);
check('the document is named in plain text', bothCited.text.includes('Lecture notes week 3')
    && !bothCited.text.includes('[Lecture notes week 3]'), JSON.stringify(bothCited.text));
check('the page becomes a markdown link',
    bothCited.text.includes('[Exam board notice](https://example.org/notice)'), JSON.stringify(bothCited.text));
// A title with brackets in it would otherwise close the link label early and
// leave the url as visible text.
const bracketed = resolveCitations('Claim. [[src:1]]',
    [{ n: 1, title: 'Notice [2026] update', url: 'https://example.org/x' }]);
check('brackets in a title are escaped, not left to break the link',
    bracketed.text.includes('[Notice \\[2026\\] update](https://example.org/x)'), JSON.stringify(bracketed.text));

section('nothing leaks while the answer is still streaming');
check('a complete marker is stripped', stripCitationMarkers('Done. [[src:1]] Next.') === 'Done. Next.',
    JSON.stringify(stripCitationMarkers('Done. [[src:1]] Next.')));
for (const partial of ['Done. [[', 'Done. [[s', 'Done. [[sr', 'Done. [[src', 'Done. [[src:', 'Done. [[src:1']) {
    check(`a half-arrived "${partial.slice(6)}" never flashes`, stripCitationMarkers(partial) === 'Done.',
        JSON.stringify(stripCitationMarkers(partial)));
}
check('an unrelated double bracket is left alone',
    stripCitationMarkers('Use the [[open:1:2]] marker.') === 'Use the [[open:1:2]] marker.');
check('ordinary text is returned identical', stripCitationMarkers(plain) === plain);
check('a non-string is survivable', stripCitationMarkers(undefined) === undefined);

// The logic above is pure and fully covered; what it cannot see is whether it
// is still WIRED IN. Both chat paths have to resolve against the sources that
// turn actually retrieved — resolving against an empty list silently strips
// every citation and no assertion above would notice.
section('both chat paths still resolve against their own sources');
const indexSrc = (await import('node:fs')).readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
check('the retrieval helper builds the numbered block', /formatSourceContext\(items\)/.test(indexSrc));
// Loosened from the single-line `if (useVault) chunks = await searchDocuments`:
// what has to hold is that the search is reached only through the flag, not
// that the two sit on one line with one statement between them.
check('the vault is only searched when the learner kept it on', /useVault[\s\S]{0,80}searchDocuments/.test(indexSrc));
check('the web is only searched when both the setting and the question allow it',
    /chatTools\(\{ web: webAllowedForTurn\(useWeb\)/.test(indexSrc));
check('the non-streaming turn resolves before it stores', /resolveCitations\(aiResponse, ragSources\)/.test(indexSrc));
check('the streaming turn resolves before it stores', /resolveCitations\(fullResponse, ragSources\)/.test(indexSrc));
check('the resolved answer is handed back in the terminal frame', /content: finalContent \|\| null/.test(indexSrc));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

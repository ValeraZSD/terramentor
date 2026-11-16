// tools/alt-text-gates.mjs — what a screen reader says for a card picture.
//
// A card whose question is a photograph read to a screen reader as its
// filename, even when a vision model had already stored a description of it.
// Now the card reads the stored description, says when a model wrote it, and
// the learner can check and correct it. What can go wrong, and what this
// suite catches:
//
//   * the order of trust broken: the deck author's alt for this card must win
//     over the stored description, which must win over the filename, and the
//     result is never empty (a card picture is content, not decoration);
//   * a model's description read out as if a person wrote it;
//   * a learner's correction overwritten: by the sweep, or by a forced re-run;
//   * an edit that stores noise (control bytes, unbounded length), or reaches
//     a file that is not a picture, or one that does not exist;
//   * the review list not putting the model-written rows first;
//   * the card component going back to the filename.
//
// Scratch library, no model, no network: a forced re-describe of a person's
// text must return before any model is asked, which is what is checked.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'alt-text-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
    if (ok) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (name) => console.log(`\n${name}`);

const S = (f) => pathToFileURL(join(repoRoot, 'server', f)).href;
const { default: db } = await import(S('database.js'));
const {
    cleanDescription, setLearnerDescription, listDescriptions, pendingDescriptions, describeStats, describeMedia,
} = await import(S('mediaDescribe.js'));

const projectId = db.prepare("INSERT INTO projects (name) VALUES ('Pictures')").run().lastInsertRowid;
const hash = (c) => c.repeat(64);
const addFile = (h, name, kind, description = null, by = null, model = null) => db.prepare(
    'INSERT INTO media_files (project_id, hash, filename, mime, kind, size, description, described_by, generated_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
).run(projectId, h, name, kind === 'image' ? 'image/png' : 'audio/mpeg', kind, description, by, model);
const BARE = hash('a');
const AUTHOR = hash('b');
const VISION = hash('c');
const CLIP = hash('d');
addFile(BARE, 'kat.png', 'image');
addFile(AUTHOR, 'hond.png', 'image', 'A brown dog asleep on a rug', 'author');
addFile(VISION, 'boom.png', 'image', 'A tall oak tree in a field', 'vision', 'test-model');
addFile(CLIP, 'kat.mp3', 'audio');
const row = (h) => db.prepare('SELECT description, described_by, generated_by FROM media_files WHERE hash = ?').get(h);

section('a learner corrects a description');
const fixed = setLearnerDescription(VISION, 'A lone oak tree in a green field');
check('the correction is stored as the learner\'s, with no model named',
    fixed.ok && row(VISION).described_by === 'learner' && row(VISION).generated_by === null
    && row(VISION).description === 'A lone oak tree in a green field');
check('control bytes and runs of space are folded away',
    cleanDescription('a\u0007cat\n\n on   a mat\u0000') === 'a cat on a mat');
check('a description is bounded at 600 characters', cleanDescription('x'.repeat(5000)).length === 600);
check('zero-width and direction marks are dropped', cleanDescription('a​cat‮ on⁦ a mat﻿') === 'acat on a mat');
check('...and the cut never splits a character in two', [...cleanDescription('\u{1F600}'.repeat(700))].length === 600
    && !/[\ud800-\udbff]$/.test(cleanDescription('a' + '\u{1F600}'.repeat(700))));
check('a model\'s write lands only where no person has written meanwhile',
    /UPDATE media_files SET description = \?, described_by = \?, generated_by = \?\s+WHERE hash = \? AND \(description IS NULL OR description = '' OR described_by = 'vision'\)/
        .test(readFileSync(join(repoRoot, 'server/mediaDescribe.js'), 'utf8')));
const cleared = setLearnerDescription(BARE, '   ');
check('an empty text clears it, handing the picture back to the sweep',
    cleared.ok && row(BARE).description === null && row(BARE).described_by === null
    && pendingDescriptions().some(p => p.hash === BARE));
check('a sound has no description to write', setLearnerDescription(CLIP, 'meow').ok === false && row(CLIP).description === null);
check('a file that does not exist is refused', setLearnerDescription(hash('e'), 'x').ok === false);

section('a person\'s words are never overwritten by a model');
const forcedLearner = await describeMedia(VISION, { force: true });
check('a forced re-describe of the learner\'s text keeps it, asking no model',
    forcedLearner.reason === 'already described' && row(VISION).described_by === 'learner');
const forcedAuthor = await describeMedia(AUTHOR, { force: true });
check('...and of the deck author\'s alt as well',
    forcedAuthor.reason === 'already described' && row(AUTHOR).description === 'A brown dog asleep on a rug');
check('the sweep does not pick up a described picture', !pendingDescriptions().some(p => p.hash === VISION || p.hash === AUTHOR));
const stats = describeStats();
check('the counts name who wrote what', stats.byLearner === 1 && stats.byAuthor === 1 && stats.byVision === 0 && stats.pending === 1,
    JSON.stringify(stats));

section('the review list');
addFile(hash('f'), 'vis.png', 'image', 'A red apple', 'vision', 'test-model');
const listed = listDescriptions();
check('model-written descriptions come first, the ones to check', listed[0]?.described_by === 'vision', JSON.stringify(listed.map(r => r.described_by)));
check('one row per picture, no sounds', listed.length === 4 && listed.every(r => r.hash !== CLIP));

section('the routes');
const { createApp } = await import(S('app.js'));
const app = createServer(createApp());
const port = await new Promise(ok => app.listen(0, '127.0.0.1', () => ok(app.address().port)));
const call = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
const put = await call(`/api/media/${AUTHOR}/description`, { method: 'PUT', body: JSON.stringify({ description: 'A brown dog on a red rug' }) });
const putBody = await put.json();
check('PUT stores the learner\'s text and says so', put.status === 200 && putBody.described_by === 'learner' && row(AUTHOR).description === 'A brown dog on a red rug');
check('a bad id is refused', (await call('/api/media/not-a-hash/description', { method: 'PUT', body: '{"description":"x"}' })).status === 400);
check('a description that is not text is refused', (await call(`/api/media/${AUTHOR}/description`, { method: 'PUT', body: '{"description":42}' })).status === 400);
check('an unknown picture is a 404', (await call(`/api/media/${hash('9')}/description`, { method: 'PUT', body: '{"description":"x"}' })).status === 404);
const info = await (await call(`/api/media/${AUTHOR}/info`)).json();
check('the card\'s lookup reads the new description', info.description === 'A brown dog on a red rug' && info.described_by === 'learner');
const list = await (await call('/api/media-descriptions')).json();
check('the list route serves the review rows', Array.isArray(list.items) && list.items.length === 4);
await new Promise(ok => app.close(ok));

section('what the card says');
const outfile = join(scratch, 'alt.mjs');
await esbuild.build({ entryPoints: [join(repoRoot, 'src/components/cardImageAlt.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
const { imageAltText, needsStoredDescription } = await import(pathToFileURL(outfile).href);
const ai = (d) => `AI description: ${d}`;
check('the alt the deck carried for this card wins',
    imageAltText({ alt: 'een kat', name: 'kat.png' }, { description: 'A cat', described_by: 'vision' }, ai) === 'een kat');
check('a model\'s stored description is said to be one',
    imageAltText({ name: 'kat.png' }, { description: 'A cat', described_by: 'vision' }, ai) === 'AI description: A cat');
check('a person\'s stored description is read plainly',
    imageAltText({ name: 'kat.png' }, { description: 'Our cat', described_by: 'learner' }, ai) === 'Our cat'
    && imageAltText({ name: 'kat.png' }, { description: 'A cat', described_by: 'author' }, ai) === 'A cat');
check('no description: the filename, often the word itself', imageAltText({ name: 'kat.png' }, null, ai) === 'kat.png');
check('a blank alt does not hide the stored one', imageAltText({ alt: '  ', name: 'k.png' }, { description: 'A cat', described_by: 'learner' }, ai) === 'A cat');
check('never empty', imageAltText({}, { description: '  ', described_by: null }, ai) === 'Card image');
check('a card that carried its own alt does not look anything up', needsStoredDescription({ alt: 'x' }) === false && needsStoredDescription({}) === true);
const cardMedia = readFileSync(join(repoRoot, 'src/components/CardMedia.tsx'), 'utf8');
check('the card picture takes its alt from imageAltText', /alt=\{alt\}/.test(cardMedia) && cardMedia.includes('imageAltText(item, info,'));
check('...and no longer falls straight back to the filename', !cardMedia.includes("item.alt || item.name || 'Card image'"));
check('Settings opens the review of the descriptions',
    readFileSync(join(repoRoot, 'src/components/settings/ModelJobsSection.tsx'), 'utf8').includes('<ImageDescriptionsDialog'));

try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

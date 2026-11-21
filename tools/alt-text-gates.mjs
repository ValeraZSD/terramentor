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

// A vision model that answers whatever `visionSays` holds; nothing else reaches it.
let visionSays = 'UNREADABLE';
const visionStub = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: visionSays }, finish_reason: 'stop' }], usage: { completion_tokens: 20 } }));
    });
});
await new Promise(r => visionStub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${visionStub.address().port}/v1`;
process.env.AI_MODEL = 'stub-vision';
process.env.AI_API_KEY = 'stub-key';

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
check('zero-width and direction marks are dropped', cleanDescription('a\u200Bcat\u202E on\u2066 a mat\uFEFF\u2060') === 'acat on a mat');
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

section('the file itself');
// A clip must answer a byte-range request: Safari will not play or seek one
// that is answered whole, and a shared cache must not keep the learner's files.
const { mediaStorage } = await import(S('vaultStorage.js'));
const SONG = mediaStorage.put(Buffer.from('0123456789abcdef')).hash;
db.prepare("INSERT INTO media_files (project_id, hash, filename, mime, kind, size) VALUES (?, ?, 'klank.mp3', 'audio/mpeg', 'audio', 16)").run(projectId, SONG);
const whole = await call(`/api/media/${SONG}`);
check('a clip is served whole with its type, and says it can be read in ranges',
    whole.status === 200 && whole.headers.get('content-type') === 'audio/mpeg' && whole.headers.get('accept-ranges') === 'bytes'
    && (await whole.text()) === '0123456789abcdef', JSON.stringify([...whole.headers]));
const ranged = await call(`/api/media/${SONG}`, { headers: { Range: 'bytes=2-5' } });
check('a byte-range request is answered with 206 and just those bytes',
    ranged.status === 206 && ranged.headers.get('content-range') === 'bytes 2-5/16' && (await ranged.text()) === '2345',
    `${ranged.status} ${ranged.headers.get('content-range')}`);
const cacheControl = whole.headers.get('cache-control') || '';
check('the file is cached by the browser for good but never by a shared cache',
    /^private,/.test(cacheControl) && /immutable/.test(cacheControl) && !/public/.test(cacheControl), cacheControl);
check('a file the store lost is a 404 that is not cached', await (async () => {
    db.prepare("INSERT INTO media_files (project_id, hash, filename, mime, kind, size) VALUES (?, ?, 'weg.mp3', 'audio/mpeg', 'audio', 1)").run(projectId, hash('8'));
    const lost = await call(`/api/media/${hash('8')}`);
    return lost.status === 404 && !/immutable/.test(lost.headers.get('cache-control') || '');
})());
const pastEnd = await call(`/api/media/${SONG}`, { headers: { Range: 'bytes=100-200' } });
check('a range past the end is a 416 that says how long the file is, with no cache header and no body type',
    pastEnd.status === 416 && pastEnd.headers.get('content-range') === 'bytes */16'
    && !pastEnd.headers.get('cache-control') && !/audio/.test(pastEnd.headers.get('content-type') || ''),
    `${pastEnd.status} ${pastEnd.headers.get('content-range')} ${pastEnd.headers.get('cache-control')} ${pastEnd.headers.get('content-type')}`);

section('the next page, after a correction');
// Four model-written rows, read two at a time. Correcting one on the first
// page moves it to the end of the server's order; the next page is asked for
// by place, so the row that moved up into its slot is still shown.
for (const c of ['1', '2', '3']) addFile(hash(c), `v${c}.png`, 'image', `Picture ${c}`, 'vision', 'test-model');
const first = listDescriptions({ limit: 2 });
check('the first page is two model-written rows', first.length === 2 && first.every(r => r.described_by === 'vision'), JSON.stringify(first));
setLearnerDescription(first[0].hash, 'Corrected by the learner');
const next = await (await call(`/api/media-descriptions?limit=2&after=${encodeURIComponent(first[1].cursor)}`)).json();
const seen = new Set([...first, ...next.items].map(r => r.hash));
const vision = [hash('f'), hash('1'), hash('2'), hash('3')];
check('...the next page holds the two model-written rows not yet shown', vision.every(h => seen.has(h)), JSON.stringify(next.items.map(r => r.filename)));
await new Promise(ok => app.close(ok));

section('one picture in two projects');
// The same bytes imported into a second project is a second ROW, but one
// picture: the counts, the sweep's list and the review list must agree on one.
const before = describeStats();
const projectTwo = db.prepare("INSERT INTO projects (name) VALUES ('Pictures again')").run().lastInsertRowid;
const TWICE = hash('7');
addFile(TWICE, 'tweemaal.png', 'image');
db.prepare('INSERT INTO media_files (project_id, hash, filename, mime, kind, size) VALUES (?, ?, ?, ?, ?, 1)').run(projectTwo, TWICE, 'tweemaal.png', 'image/png', 'image');
const after = describeStats();
check('the counts see one more picture, not two', after.images === before.images + 1 && after.pending === before.pending + 1, JSON.stringify({ before, after }));
check('the sweep is handed the picture once', pendingDescriptions().filter(p => p.hash === TWICE).length === 1);
check('...as the review list shows it once', listDescriptions({ limit: 200 }).filter(r => r.hash === TWICE).length === 1);
check('a project\'s own counts are unchanged', describeStats(projectTwo).images === 1 && describeStats(projectId).images === before.images + 1);

section('two presses of Describe');
// Both requests reach the sweep before the first has finished asking whether a
// vision model exists. Only one may start; the other is told it is running.
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('paper_vision', 'never')").run();
const { startDescribeSweep, describeProgress } = await import(S('mediaDescribe.js'));
const [firstPress, secondPress] = await Promise.all([startDescribeSweep(), startDescribeSweep()]);
check('the second press is refused as already running, not let through beside the first',
    [firstPress, secondPress].filter(r => r.reason === 'already running').length === 1, JSON.stringify([firstPress, secondPress]));
check('a refused sweep leaves nothing marked as running', describeProgress().running === false);
const thirdPress = await startDescribeSweep();
check('...so a later press is answered on its merits', thirdPress.started === false && thirdPress.reason !== 'already running', JSON.stringify(thirdPress));

section('what a model\'s description goes through');
const { mediaStorage: store } = await import(S('vaultStorage.js'));
const modelRow = (name) => {
    const h = store.put(Buffer.from(`picture ${name}`)).hash;
    db.prepare("INSERT INTO media_files (project_id, hash, filename, mime, kind, size) VALUES (?, ?, ?, 'image/png', 'image', 8)").run(projectId, h, name);
    return h;
};
visionSays = 'A​ cat‮ on⁦ a\u0007 mat﻿';
const cleanedHash = modelRow('schoon.png');
const cleanedRes = await describeMedia(cleanedHash);
check('a model\'s reply is cleaned like a learner\'s: control and direction marks dropped',
    cleanedRes.ok && row(cleanedHash).description === 'A cat on a mat' && row(cleanedHash).described_by === 'vision', JSON.stringify([cleanedRes, row(cleanedHash)]));
visionSays = '\u{1F600}'.repeat(700);
const longHash = modelRow('lang.png');
await describeMedia(longHash);
const longText = row(longHash).description || '';
check('...and a long one is cut by characters, never through a pair', [...longText].length === 600 && !/[\ud800-\udbff]$/.test(longText), String(longText.length));
visionSays = 'UNREADABLE';
const blankHash = modelRow('leeg.png');
check('...and "UNREADABLE" stores nothing', (await describeMedia(blankHash)).ok === false && row(blankHash).description === null);
await new Promise(ok => visionStub.close(ok));

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

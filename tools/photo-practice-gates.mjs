// tools/photo-practice-gates.mjs — telling a course's topics apart by their photos.
//
// Run:  node tools/photo-practice-gates.mjs [--server <dir>]
//
// A course learned by sight (Chinese, Japanese, Korean and Vietnamese
// buildings) keeps real, credited photos per topic (server/topicPhotos.js).
// This asserts, against the REAL routes on a scratch library seeded by the
// gate itself (nothing billed, nothing leaves the machine), that:
//
//   1. a course offers photo practice only when two or more of its topics
//      have a found photo; a course with none, or with one such topic, offers
//      none and says so;
//   2. a round asks each photo of the course once, up to the round's size, one
//      topic after another; its options are the course's by-sight topics and
//      nothing else, the photo's own topic always among them; it never puts
//      two photos of one topic side by side when the pool allows, and as few
//      as possible when it does not (checked against the count formula, not
//      against the code's rule); nothing that names the answer goes out with
//      the photo before it is answered (no example name, no credit, no file
//      page);
//   3. an answer is graded on the server by the topic the photo belongs to,
//      writes evidence on that topic and no other, once per attempt id; a
//      photo a vision model confirmed is proof, one nobody looked at is
//      practice; an id sent again for another photo is refused;
//   4. a wrong pick answers with both photos (the one shown and one of the
//      topic picked), each with its example, what to look at and its credit;
//   5. the next round asks photos never asked before the ones already asked;
//   6. "This is wrong" on a photo takes its answers out of the evidence and
//      the photo out of practice; Undo puts both back;
//   7. every found photo gets ONE card (photo on the front, the example's name
//      and what to look at on the back, credit beside the photo once turned),
//      made once: a card the learner deleted or reported is not made again,
//      and a photo found again gives its card the new picture;
//   8. course files leave the photo cards out (they are made from the photos),
//      and a course imported from a bundle gets them made again;
//   9. no model is asked anything for any of this;
//  10. the front of a photo card is never described by its stored description
//      (which names the answer), for a screen reader or as a tooltip.
//
// `--server <dir>` runs the same cases against another copy of server/ (and
// the src/ beside it), e.g. the branch this one stacks on; that code is
// expected to FAIL.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const SERVER_DIR = argOf('--server') ? resolve(argOf('--server')) : null;
const B = SERVER_DIR ? pathToFileURL(SERVER_DIR + '/').href : new URL('../server/', import.meta.url).href;
const SRC = SERVER_DIR ? join(SERVER_DIR, '..', 'src') : new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const scratch = mkdtempSync(join(tmpdir(), 'photo-practice-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 400)}` : ''}`); }
};
const section = (s) => console.log(`\n=== ${s} ===`);

// ---- a model that must never be asked -------------------------------------------
const calls = [];
const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        }
        calls.push({ url: req.url, body: raw.slice(0, 200) });
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"stub: not part of this gate"}}');
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

// ---- the real app on a scratch library -------------------------------------------
const { default: db } = await import(`${B}database.js`);
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('creation_find_resources', 'false');
setSetting.run('creation_find_photos', 'false');
setSetting.run('embedding_enabled', 'false');
setSetting.run('ui_language', 'en');
const { createApp } = await import(`${B}app.js`);
const { mediaStorage } = await import(`${B}vaultStorage.js`);
const practice = await import(`${B}photoPractice.js`).catch(() => null);
const cards = await import(`${B}photoCards.js`).catch(() => null);
ok('the practice module exists (server/photoPractice.js)', !!practice);
ok('the photo card module exists (server/photoCards.js)', !!cards);

const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (path) => {
    const r = await fetch(`${base}${path}`);
    return { status: r.status, body: await r.json().catch(() => null) };
};
const post = async (path, body) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
};

// ---- the fixture: the gate's own record of which photo is which topic -------------
// A `checked` photo is one a vision model confirmed; `none` an example the
// archive had no photo for. The gate seeds the rows itself, with its own
// uuids, so every expected answer below is read from HERE, never from the app.
const COURSES = {
    asia: {
        name: 'East Asian buildings',
        topics: [
            { title: 'Chinese halls', photos: [
                { subject: 'Hall of Supreme Harmony', shows: 'Double-eaved hip roof on a marble terrace.', author: 'Ann Lee', checked: true },
                { subject: 'Temple of Heaven', shows: 'A round hall with three blue roofs.', author: 'Ben Ho' },
                { subject: 'Yingxian Pagoda', shows: 'A wooden pagoda.', status: 'none' },
                { subject: 'Bell Tower of Xi\'an', shows: 'A tower on a brick base.', author: 'Cai Lun' },
            ] },
            { title: 'Japanese temples', photos: [
                { subject: 'Horyu-ji', shows: 'Slender posts and a five-storey pagoda.', author: 'Dai Mori', checked: true },
                { subject: 'Kinkaku-ji', shows: 'A gold pavilion over a pond.', author: 'Emi Sato' },
                { subject: 'Himeji Castle', shows: 'White plaster walls and curved gables.', author: 'Fumi Ito' },
            ] },
            // No photos at all: a topic read, not seen.
            { title: 'Why roofs curve: the history', photos: [] },
            { title: 'Korean palaces', photos: [
                { subject: 'Geunjeongjeon', shows: 'Painted brackets, cooler colours.', author: 'Gil Park' },
            ] },
            { title: 'Vietnamese pagodas', photos: [
                { subject: 'One Pillar Pagoda', shows: 'A small hall on one pillar over water.', author: 'Hoa Tran' },
                { subject: 'Temple of Literature', shows: 'Low halls with steep tiled roofs.', author: 'Hoa Tran' },
            ] },
            // By sight, but nothing was found: no practice, no card.
            { title: 'Lao stupas', photos: [{ subject: 'Pha That Luang', shows: 'A gold stupa.', status: 'none' }] },
        ],
    },
    plain: { name: 'Grammar basics', topics: [{ title: 'Nouns', photos: [] }, { title: 'Verbs', photos: [] }] },
    single: { name: 'One style', topics: [
        { title: 'Gothic cathedrals', photos: [
            { subject: 'Chartres', shows: 'Flying buttresses.', author: 'Ivo Roy' },
            { subject: 'Reims', shows: 'A rose window.', author: 'Jan Roy' },
        ] },
        { title: 'Reading a floor plan', photos: [] },
    ] },
    skewed: { name: 'Mostly one', topics: [
        { title: 'Doric temples', photos: [1, 2, 3, 4, 5].map(i => ({ subject: `Doric ${i}`, shows: 'Plain capitals.', author: 'Kim Ng' })) },
        { title: 'Ionic temples', photos: [{ subject: 'Ionic 1', shows: 'Scroll capitals.', author: 'Lu Ng' }] },
    ] },
};
const jpeg = (seed) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF stub photo ${seed} `.repeat(20))]);
const insProject = db.prepare('INSERT INTO projects (name) VALUES (?)');
const insNode = db.prepare('INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, NULL, ?, ?)');
const hasPhotos = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'node_photos'").get();
const insPhoto = hasPhotos ? db.prepare(`INSERT INTO node_photos (uuid, node_id, position, subject, search, shows, status, hash, width, height,
    file_title, author, licence, licence_url, source_url, checked_by, generated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1600, 1000, ?, ?, ?, ?, ?, ?, ?)`) : null;
const insMedia = db.prepare(`INSERT OR IGNORE INTO media_files (project_id, hash, filename, mime, kind, size, description, described_by)
    VALUES (?, ?, ?, 'image/jpeg', 'image', ?, ?, 'author')`);
const PROVENANCE = JSON.stringify({ provider: 'openai', model: 'stub-model' });
/** uuid -> { course, topic title, topic id, photo }: what each photo IS. */
const photoTruth = new Map();
let seq = 0;
for (const [key, course] of Object.entries(COURSES)) {
    course.id = Number(insProject.run(course.name).lastInsertRowid);
    course.topics.forEach((t, i) => {
        t.id = Number(insNode.run(course.id, t.title, i).lastInsertRowid);
        t.photos.forEach((p, j) => {
            p.uuid = randomUUID();
            const found = p.status !== 'none';
            if (found) {
                const { hash, size } = mediaStorage.put(jpeg(`${key}-${++seq}`));
                p.hash = hash;
                insMedia.run(course.id, hash, `${p.subject.replace(/\W+/g, '_')}.jpg`, size, `${p.subject}. ${p.shows}`);
            }
            p.licence = 'CC BY-SA 4.0';
            p.sourceUrl = `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(p.subject.replace(/ /g, '_'))}.jpg`;
            insPhoto?.run(p.uuid, t.id, j, p.subject, p.subject, p.shows, found ? 'found' : 'none', found ? p.hash : null,
                found ? `File:${p.subject}.jpg` : null, found ? p.author : null, found ? p.licence : null,
                found ? 'https://creativecommons.org/licenses/by-sa/4.0' : null, found ? p.sourceUrl : null,
                p.checked ? PROVENANCE : null, PROVENANCE);
            photoTruth.set(p.uuid, { course: key, topic: t, photo: p, found });
        });
    });
}
// One card the course itself owns, to show course files still carry cards.
const asia = COURSES.asia;
db.prepare(`INSERT INTO flashcards (node_id, front, back) VALUES (?, 'Which dynasty built the Forbidden City?', 'Ming')`).run(asia.topics[0].id);

/** The gate's own definition of a by-sight topic: one with a found photo. */
const sightTopics = (course) => course.topics.filter(t => t.photos.some(p => p.status !== 'none'));
const foundPhotos = (course) => course.topics.flatMap(t => t.photos.filter(p => p.status !== 'none'));
const truthOf = (uuid) => photoTruth.get(uuid);
const evidenceRows = (nodeId) => db.prepare('SELECT * FROM mastery_evidence WHERE node_id = ? ORDER BY id').all(nodeId);
const allEvidence = () => db.prepare('SELECT COUNT(*) AS c FROM mastery_evidence').get().c;
const metaOf = (row) => { try { return JSON.parse(row?.metadata || '{}'); } catch { return {}; } };
const sameTopicNeighbours = (items) => items.reduce((n, it, i) => n + (i > 0 && truthOf(items[i - 1].photo)?.topic === truthOf(it.photo)?.topic ? 1 : 0), 0);
const fewestPossible = (counts) => {
    const n = counts.reduce((a, b) => a + b, 0), max = Math.max(0, ...counts);
    return Math.max(0, max - (n - max) - 1);
};

// ---- 1. which courses offer it --------------------------------------------------
section('1. offered only with two or more topics that have a found photo');
const state = async (course) => (await get(`/api/projects/${course.id}/photo-practice`)).body;
const sAsia = await state(asia);
ok('the course with four by-sight topics offers practice', sAsia?.available === true, JSON.stringify(sAsia));
ok('...counting the topics and photos found (not the ones with none)', sAsia?.topics === sightTopics(asia).length && sAsia?.photos === foundPhotos(asia).length, JSON.stringify(sAsia));
const sPlain = await state(COURSES.plain);
ok('a course with no photos offers none', sPlain?.available === false && sPlain?.topics === 0 && sPlain?.photos === 0, JSON.stringify(sPlain));
const sSingle = await state(COURSES.single);
ok('a course with one by-sight topic offers none (nothing to tell it apart from)', sSingle?.available === false && sSingle?.topics === 1, JSON.stringify(sSingle));
const refused = await get(`/api/projects/${COURSES.plain.id}/photo-practice/round`);
ok('...and asking for a round there is refused, not answered with an empty one', refused.status === 409, refused.status);
const missing = await get('/api/projects/999999/photo-practice');
ok('an unknown course is a 404', missing.status === 404, missing.status);

// ---- 2. a round --------------------------------------------------------------------
section('2. a round: each photo once, options from the course, mixed');
/** Each option's key as a round sent it, by course and the words shown. */
const optionKeys = new Map();
const round = async (course, size) => {
    const r = await get(`/api/projects/${course.id}/photo-practice/round${size ? `?size=${size}` : ''}`);
    const items = r.status === 200 && Array.isArray(r.body?.items) ? r.body.items : [];
    for (const it of items) for (const o of it.options || []) optionKeys.set(`${course.id}:${o.title}`, o.key);
    return items;
};
/** What the screen sends for the option showing these words (a topic's title, or a kind's). */
const keyFor = (course, words) => optionKeys.get(`${course.id}:${words}`) ?? `not offered: ${words}`;
const full = await round(asia, 50);
const asiaFound = foundPhotos(asia);
ok('a round asks every found photo of the course once', full.length === asiaFound.length
    && new Set(full.map(i => i.photo)).size === full.length && full.every(i => truthOf(i.photo)?.course === 'asia' && truthOf(i.photo)?.found),
    JSON.stringify(full.map(i => i.photo)));
const sightTitles = new Set(sightTopics(asia).map(t => t.title));
ok('every option is a by-sight topic of this course (never a topic read only, one with none, or another course\'s)',
    full.length > 0 && full.every(i => Array.isArray(i.options) && i.options.length >= 2 && i.options.every(o => sightTitles.has(o.title))),
    JSON.stringify(full[0]?.options));
ok('...photos with no answer on record are named by their topic\'s own title, each option with a key to send back', full.length > 0
    && full.every(i => i.options.every(o => typeof o.key === 'string' && o.key && asia.topics.some(t => t.title === o.title))));
ok('the photo\'s own topic is always among its options', full.length > 0 && full.every(i => i.options.some(o => o.title === truthOf(i.photo).topic.title)));
ok('...with up to three others, no topic twice', full.length > 0 && full.every(i => i.options.length === Math.min(4, sightTopics(asia).length)
    && new Set(i.options.map(o => o.key)).size === i.options.length && new Set(i.options.map(o => o.title)).size === i.options.length));
ok('never two photos of one topic side by side when the pool allows', full.length > 0
    && sameTopicNeighbours(full) === fewestPossible(sightTopics(asia).map(t => full.filter(i => truthOf(i.photo).topic === t).length)),
    full.map(i => truthOf(i.photo)?.topic.title).join(' | '));
const before = JSON.stringify(full);
const leaks = asiaFound.flatMap(p => [p.subject, p.shows, p.author, p.sourceUrl]).filter(s => before.includes(s));
ok('nothing that names the answer goes out before it is answered (example, what to look at, author, file page)', full.length > 0 && leaks.length === 0, leaks.join(' | '));
ok('...the photo itself does (its stored file)', full.length > 0 && full.every(i => i.hash === truthOf(i.photo).photo.hash));
const four = await round(asia, 4);
ok('a round of four over four by-sight topics asks one photo of each', four.length === 4
    && new Set(four.map(i => truthOf(i.photo)?.topic.id)).size === 4, four.map(i => truthOf(i.photo)?.topic.title).join(' | '));
const skew = await round(COURSES.skewed, 50);
const skewCounts = sightTopics(COURSES.skewed).map(t => skew.filter(i => truthOf(i.photo)?.topic === t).length);
ok('five photos of one topic and one of another: all six asked, as few neighbours as possible', skew.length === 6
    && sameTopicNeighbours(skew) === fewestPossible(skewCounts), skew.map(i => truthOf(i.photo)?.topic.title).join(' | '));
// The rule itself, over every pool of up to nine photos in up to four topics.
let worst = null;
if (practice?.interleave) {
    const rec = (counts) => {
        if (counts.length === 4) {
            const groups = counts.map((c, t) => Array.from({ length: c }, (_, k) => ({ t, k })));
            const out = practice.interleave(groups);
            const n = counts.reduce((a, b) => a + b, 0);
            const neighbours = out.reduce((m, x, i) => m + (i > 0 && out[i - 1].t === x.t ? 1 : 0), 0);
            const perTopicOrder = counts.every((c, t) => out.filter(x => x.t === t).every((x, k) => x.k === k));
            if (out.length !== n || neighbours !== fewestPossible(counts) || !perTopicOrder) worst ??= { counts, out: out.map(x => x.t) };
            return;
        }
        for (let c = 0; c <= 9; c++) rec([...counts, c]);
    };
    rec([]);
}
ok('the order rule gives the fewest neighbours possible for every pool of up to 9 photos in 4 topics, keeping each topic\'s order',
    !!practice?.interleave && worst === null, JSON.stringify(worst));

// ---- 3. answers ---------------------------------------------------------------------
section('3. graded by the photo\'s topic, evidence there only, once per attempt');
const [chinese, japanese, , korean, vietnamese] = asia.topics;
const checkedPhoto = chinese.photos[0];
const plainPhoto = japanese.photos[1];
/** `picked`: a topic of the course (by id, named by its title) or the words of a kind. */
const answer = (course, photo, picked, attemptId = randomUUID()) => post(`/api/projects/${course.id}/photo-practice/answer`, {
    photo: photo.uuid, attemptId,
    picked: keyFor(course, typeof picked === 'number' ? course.topics.find(t => t.id === picked)?.title : picked),
});
const othersBefore = allEvidence() - evidenceRows(chinese.id).length;
const right = await answer(asia, checkedPhoto, chinese.id);
ok('the photo\'s own topic is right', right.status === 200 && right.body?.correct === true, JSON.stringify(right));
const rRow = evidenceRows(chinese.id).at(-1);
ok('...one answer of one, written on that topic', rRow?.score === 1 && rRow?.total === 1 && metaOf(rRow).photo === checkedPhoto.uuid, JSON.stringify(rRow));
ok('...as proof, because a vision model confirmed the photo', rRow?.evidence_type === 'quiz', rRow?.evidence_type);
ok('...and nothing on any other topic', allEvidence() - evidenceRows(chinese.id).length === othersBefore);
ok('...a lucky pick counted as one in the four topics offered', metaOf(rRow).guess === 0.25, JSON.stringify(metaOf(rRow)));
const twice = await answer(asia, checkedPhoto, chinese.id);
const tRow = evidenceRows(chinese.id).at(-1);
ok('the same confirmed photo answered again (a later round) is practice: that picture was seen',
    twice.status === 200 && tRow?.id !== rRow?.id && tRow?.evidence_type === 'drill', JSON.stringify({ s: twice.status, t: tRow?.evidence_type }));
const doric = COURSES.skewed.topics[0];
const two = await answer(COURSES.skewed, doric.photos[0], doric.id);
ok('in a course of two by-sight topics a lucky pick is one in two', two.status === 200 && metaOf(evidenceRows(doric.id).at(-1)).guess === 0.5,
    JSON.stringify(metaOf(evidenceRows(doric.id).at(-1))));
// The floor has to reach the estimate, not only the row: a right pick among
// two is weaker evidence than one among four. Two fresh topics, one answer each.
{
    const { updateMasteryFromAttempt, getNodeMastery } = await import(`${B}mastery.js`);
    const [among2, among4] = [0, 1].map(i => Number(insNode.run(COURSES.plain.id, `Guess floor ${i}`, 900 + i).lastInsertRowid));
    // One like answer first: from an estimate of 0 no floor changes anything.
    for (const id of [among2, among4]) updateMasteryFromAttempt(id, 1, 1, 'drill', { source: 'sight', questionType: 'multiple_choice', guess: 0.25 });
    updateMasteryFromAttempt(among2, 1, 1, 'drill', { source: 'sight', questionType: 'multiple_choice', guess: 0.5 });
    updateMasteryFromAttempt(among4, 1, 1, 'drill', { source: 'sight', questionType: 'multiple_choice', guess: 0.25 });
    const [m2, m4] = [among2, among4].map(id => getNodeMastery(id)?.mastery_score);
    ok('...and the estimate moves less for a right pick among two than among four', typeof m2 === 'number' && m2 < m4, JSON.stringify({ m2, m4 }));
    // The replay a report runs (rescoreNode) reads the same floor from the row.
    const { rescoreNode } = await import(`${B}mastery.js`);
    const [r2, r4] = [among2, among4].map(id => rescoreNode(id));
    ok('...also when the answers are replayed, as a report does', r2 === m2 && r4 === m4, JSON.stringify({ r2, r4, m2, m4 }));
}
const doricRows = evidenceRows(doric.id).length;
const noId = await post(`/api/projects/${COURSES.skewed.id}/photo-practice/answer`, { photo: doric.photos[1].uuid, picked: keyFor(COURSES.skewed, doric.title) });
ok('an answer without an attempt id is refused, and writes nothing', noId.status === 400 && evidenceRows(doric.id).length === doricRows, noId.status);
const emptySize = await get(`/api/projects/${asia.id}/photo-practice/round?size=`);
ok('an empty ?size= gets a round of the usual length, not of one', emptySize.status === 200 && emptySize.body?.items?.length === Math.min(12, foundPhotos(asia).length),
    emptySize.body?.items?.length);
ok('...the verdict names the example and what to look at, with its credit', right.body?.shown?.subject === checkedPhoto.subject
    && right.body?.shown?.shows === checkedPhoto.shows && right.body?.shown?.author === checkedPhoto.author
    && right.body?.shown?.licence === checkedPhoto.licence && right.body?.shown?.sourceUrl === checkedPhoto.sourceUrl, JSON.stringify(right.body?.shown));
const attempt = randomUUID();
const wrong = await answer(asia, plainPhoto, korean.id, attempt);
ok('another topic is wrong', wrong.status === 200 && wrong.body?.correct === false, JSON.stringify(wrong));
ok('...and the answer says which topic it was', wrong.body?.answer?.nodeId === japanese.id && wrong.body?.answer?.title === japanese.title, JSON.stringify(wrong.body?.answer));
const wRow = evidenceRows(japanese.id).at(-1);
ok('...a miss on the photo\'s topic, not on the one picked', wRow?.score === 0 && wRow?.total === 1 && metaOf(wRow).photo === plainPhoto.uuid
    && evidenceRows(korean.id).length === 0, JSON.stringify(wRow));
ok('...as practice: no model looked at this photo', wRow?.evidence_type === 'drill', wRow?.evidence_type);
const again = await answer(asia, plainPhoto, korean.id, attempt);
ok('the same answer sent again (a retry) is written once', again.status === 200 && again.body?.duplicate === true
    && evidenceRows(japanese.id).length === 1, JSON.stringify({ again: again.body?.duplicate, rows: evidenceRows(japanese.id).length }));
const reused = await answer(asia, korean.photos[0], korean.id, attempt);
ok('the same attempt id for another photo is refused', reused.status === 409 && evidenceRows(korean.id).length === 0, reused.status);
const otherCourse = await answer(COURSES.single, checkedPhoto, chinese.id);
ok('a photo of another course is not this course\'s to grade', otherCourse.status === 404, otherCourse.status);
const nonePhoto = await answer(asia, chinese.photos[2], chinese.id);
ok('an example with no photo cannot be answered', nonePhoto.status === 404, nonePhoto.status);
// The title itself, as a stale or forged client would send it: the course's
// own topic, one no photo is named by.
const offList = await post(`/api/projects/${asia.id}/photo-practice/answer`, { photo: korean.photos[0].uuid, attemptId: randomUUID(), picked: asia.topics[2].title });
ok('a pick that is not one of the course\'s by-sight topics is refused', offList.status === 400 && evidenceRows(korean.id).length === 0, offList.status);
const longKey = keyFor(asia, japanese.title);
const tooLong = await post(`/api/projects/${asia.id}/photo-practice/answer`, { photo: korean.photos[0].uuid, attemptId: randomUUID(), picked: longKey + ' '.repeat(300) + 'x' });
ok('a pick longer than any key is refused, not cut down to one', tooLong.status === 400 && evidenceRows(korean.id).length === 0, tooLong.status);

// ---- 4. the comparison --------------------------------------------------------------
section('4. a wrong pick shows both photos, each credited');
const shown = wrong.body?.shown, picked = wrong.body?.picked;
ok('the photo shown, with its example and what to look at', shown?.uuid === plainPhoto.uuid && shown?.hash === plainPhoto.hash
    && shown?.subject === plainPhoto.subject && shown?.shows === plainPhoto.shows, JSON.stringify(shown));
ok('...and a photo of the topic picked', !!picked && truthOf(picked.uuid)?.topic === korean && picked.hash === korean.photos[0].hash
    && picked.subject === korean.photos[0].subject && picked.shows === korean.photos[0].shows, JSON.stringify(picked));
ok('...each with its author, licence and file page', [shown, picked].every((p, i) => p?.author === [plainPhoto, korean.photos[0]][i].author
    && p?.licence === 'CC BY-SA 4.0' && /^https:\/\/creativecommons\.org\//.test(p?.licenceUrl || '') && /^https:\/\/commons\.wikimedia\.org\//.test(p?.sourceUrl || '')));
ok('...each topic named', wrong.body?.shown?.topic === japanese.title && wrong.body?.picked?.topic === korean.title, JSON.stringify({ a: wrong.body?.shown?.topic, b: wrong.body?.picked?.topic }));
ok('a right answer shows no second photo', right.body?.picked == null, JSON.stringify(right.body?.picked));
const viet = await answer(asia, vietnamese.photos[1], chinese.id);
const vPick = viet.body?.picked;
ok('a topic with several photos gives one of its own', viet.body?.correct === false && truthOf(vPick?.uuid)?.topic === chinese
    && truthOf(vPick?.uuid)?.found, JSON.stringify(vPick));

// ---- 5. never asked first -------------------------------------------------------------
section('5. photos never asked come before the ones already asked');
const asked = new Set([checkedPhoto.uuid, plainPhoto.uuid, vietnamese.photos[1].uuid]);
const next = await round(asia, 4);
ok('a round of four picks, per topic, a photo not asked yet', next.length === 4 && next.every(i => !asked.has(i.photo)),
    next.map(i => `${truthOf(i.photo)?.photo.subject}${asked.has(i.photo) ? ' (asked)' : ''}`).join(' | '));
const unasked = new Set(foundPhotos(COURSES.asia).map(p => p.uuid).filter(u => !asked.has(u)));
const six = await round(asia, unasked.size);
ok('...and a round as long as the photos not asked yet holds exactly those', six.length === unasked.size
    && six.every(i => unasked.has(i.photo)) && new Set(six.map(i => i.photo)).size === unasked.size,
    six.map(i => `${truthOf(i.photo)?.photo.subject}${asked.has(i.photo) ? ' (asked)' : ''}`).join(' | '));

// ---- 6. "This is wrong" on a photo --------------------------------------------------
section('6. a reported photo leaves practice and takes its answers with it');
const rep = await post('/api/item-reports', { ref: `photo:${plainPhoto.uuid}`, reason: 'wrong', surface: 'sight' });
ok('a photo can be reported', (rep.status === 200 || rep.status === 201) && rep.body?.report?.kind === 'photo', JSON.stringify(rep));
ok('...its answers are out of the evidence', evidenceRows(japanese.id).filter(r => metaOf(r).photo === plainPhoto.uuid).length === 0,
    JSON.stringify(evidenceRows(japanese.id)));
ok('...the other photos\' answers stay', evidenceRows(chinese.id).filter(r => metaOf(r).photo === checkedPhoto.uuid).length === 2);
const without = await round(asia, 50);
ok('...and it is not asked any more', without.length === asiaFound.length - 1 && !without.some(i => i.photo === plainPhoto.uuid), without.length);
ok('...nor counted', (await state(asia))?.photos === asiaFound.length - 1);
const undone = rep.body?.report?.id ? await fetch(`${base}/api/item-reports/${rep.body.report.id}`, { method: 'DELETE' }) : null;
ok('Undo puts its answer back', undone?.status === 200 && evidenceRows(japanese.id).filter(r => metaOf(r).photo === plainPhoto.uuid).length === 1,
    JSON.stringify(evidenceRows(japanese.id)));
ok('...and the photo back in practice', (await round(asia, 50)).some(i => i.photo === plainPhoto.uuid));

// ---- 7. cards ------------------------------------------------------------------------
section('7. one card per found photo, made once');
cards?.syncAllPhotoCards?.();
// No such column on code from before photo cards: none, and the checks fail rather than throw.
const hasColumn = db.prepare('SELECT name FROM pragma_table_info(\'flashcards\')').all().some(c => c.name === 'photo_uuid');
const photoCards = (course) => (hasColumn ? db.prepare(`SELECT f.* FROM flashcards f JOIN nodes n ON n.id = f.node_id
    WHERE n.project_id = ? AND f.deleted_at IS NULL AND f.photo_uuid IS NOT NULL /* with deleted */ ORDER BY f.id`).all(course.id) : []);
ok('a card knows the photo it was made from', hasColumn);
const asiaCards = hasColumn ? photoCards(asia) : [];
ok('every found photo has one card, on its topic', asiaCards.length === asiaFound.length
    && asiaFound.every(p => asiaCards.filter(c => c.photo_uuid === p.uuid && c.node_id === truthOf(p.uuid).topic.id).length === 1),
    asiaCards.length);
ok('...and no example without a photo has one', hasColumn && !asiaCards.some(c => !truthOf(c.photo_uuid)?.found));
ok('a course with one by-sight topic gets cards too', hasColumn && photoCards(COURSES.single).length === 2);
ok('a course with no photos gets none', hasColumn && photoCards(COURSES.plain).length === 0);
const card = asiaCards.find(c => c.photo_uuid === checkedPhoto.uuid);
const media = (() => { try { return JSON.parse(card?.media || 'null'); } catch { return null; } })();
ok('the back is the topic the photo belongs to; the example and what to look at under it',
    card?.back === truthOf(checkedPhoto.uuid)?.topic.title && card?.extra === `${checkedPhoto.subject}\n${checkedPhoto.shows}`, JSON.stringify(card));
ok('the front is the photo and no words', card?.front === '' && media?.front?.length === 1 && media.front[0].hash === checkedPhoto.hash
    && media.front[0].kind === 'image', JSON.stringify(media));
ok('...marked as the thing asked, so nothing describes it', media?.front?.[0]?.prompt === true && !media.front[0].alt && !media.front[0].name, JSON.stringify(media?.front));
ok('the turned card shows the photo again with its credit', media?.back?.[0]?.hash === checkedPhoto.hash
    && media.back[0].credit?.author === checkedPhoto.author && media.back[0].credit?.licence === checkedPhoto.licence
    && media.back[0].credit?.sourceUrl === checkedPhoto.sourceUrl, JSON.stringify(media?.back));
ok('...named as written with a model, like the photo\'s words', card?.generated_by === PROVENANCE, card?.generated_by);
ok('...and new: never reviewed, no schedule', card && !card.last_reviewed && !card.review_count && card.stability == null, JSON.stringify(card && { r: card.review_count, s: card.stability }));
const countAll = () => db.prepare('SELECT COUNT(*) AS c FROM flashcards WHERE photo_uuid IS NOT NULL /* with deleted */').get().c;
const before7 = hasColumn ? countAll() : -1;
cards?.syncAllPhotoCards?.();
ok('made once: a second pass adds nothing', hasColumn && countAll() === before7, `${before7} -> ${hasColumn ? countAll() : -1}`);
// The learner deletes one card, and reports another the model wrote.
const del = card ? await fetch(`${base}/api/ai/flashcards/${card.id}`, { method: 'DELETE' }) : null;
const other = asiaCards.find(c => c.photo_uuid === plainPhoto.uuid);
const repCard = other ? await post('/api/item-reports', { ref: `card:${other.id}`, reason: 'wrong', surface: 'review' }) : null;
cards?.syncAllPhotoCards?.();
const live = hasColumn ? photoCards(asia) : [];
ok('a card the learner deleted is not made again', del?.ok && !live.some(c => c.photo_uuid === checkedPhoto.uuid), del?.status);
const listed = ((await get('/api/deleted')).body?.items || []).find(i => i.table === 'flashcards' && i.id === card?.id);
ok('Recently deleted names a photo card by its topic, not by its empty front', listed?.title === chinese.title, JSON.stringify(listed?.title));
// ...nor once it is removed for good from Recently deleted: the row is gone.
const gone = card ? await fetch(`${base}/api/deleted/flashcards/${card.id}`, { method: 'DELETE' }) : null;
cards?.syncAllPhotoCards?.();
const purgedGone = hasColumn && !db.prepare('SELECT 1 FROM flashcards WHERE id = ? /* with deleted */').get(card?.id ?? -1);
ok('...nor after it is removed for good from Recently deleted', !!gone?.ok && purgedGone
    && !db.prepare(`SELECT 1 FROM flashcards WHERE ${hasColumn ? 'photo_uuid = ?' : '0 AND ?'} /* with deleted */`).get(checkedPhoto.uuid),
    JSON.stringify({ status: gone?.status, purgedGone }));
ok('a card reported away is not made again', !!repCard?.body?.report && !live.some(c => c.photo_uuid === plainPhoto.uuid), JSON.stringify(repCard?.body?.report?.kind));
// "This is wrong" on a photo takes its card out of review too: the card asks
// the same thing. Korea's one photo, so the topic also leaves practice.
const koreaPhoto = korean.photos[0];
const koreaCard = hasColumn ? photoCards(asia).find(c => c.photo_uuid === koreaPhoto.uuid) : null;
const repPhoto = await post('/api/item-reports', { ref: `photo:${koreaPhoto.uuid}`, reason: 'wrong', surface: 'sight' });
ok('a reported photo\'s card leaves review', !!koreaCard && !!repPhoto.body?.report && !photoCards(asia).some(c => c.photo_uuid === koreaPhoto.uuid),
    JSON.stringify({ card: koreaCard?.id, rep: repPhoto.status }));
cards?.syncAllPhotoCards?.();
ok('...and the next pass does not make it again', !photoCards(asia).some(c => c.photo_uuid === koreaPhoto.uuid));
// A round drawn before the report still offered Korea: picking it is graded, with no photo to set beside.
const lateKorea = await answer(asia, chinese.photos[1], korean.id);
ok('a topic offered before its only photo was reported is still a pick, graded wrong with nothing beside it',
    lateKorea.status === 200 && lateKorea.body?.correct === false && lateKorea.body?.picked == null, JSON.stringify(lateKorea));
const unrep = repPhoto.body?.report?.id ? await fetch(`${base}/api/item-reports/${repPhoto.body.report.id}`, { method: 'DELETE' }) : null;
ok('Undo brings the same card back', unrep?.status === 200 && photoCards(asia).some(c => c.id === koreaCard?.id), unrep?.status);
// A photo reported before any card was made from it gets none.
const lateUuid = randomUUID();
const late = mediaStorage.put(jpeg('a late photo'));
insMedia.run(asia.id, late.hash, 'late.jpg', late.size, 'Thien Mu Pagoda. Seven storeys.');
insPhoto?.run(lateUuid, vietnamese.id, 9, 'Thien Mu Pagoda', 'Thien Mu Pagoda', 'Seven storeys.', 'found', late.hash,
    'File:Thien_Mu.jpg', 'Hoa Tran', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0',
    'https://commons.wikimedia.org/wiki/File:Thien_Mu.jpg', null, PROVENANCE);
const repLate = await post('/api/item-reports', { ref: `photo:${lateUuid}`, reason: 'wrong', surface: 'sight' });
cards?.syncAllPhotoCards?.();
ok('a photo reported before it had a card gets none', !!repLate.body?.report && hasColumn && !photoCards(asia).some(c => c.photo_uuid === lateUuid),
    JSON.stringify(repLate.body?.report?.kind));
if (repLate.body?.report?.id) await fetch(`${base}/api/item-reports/${repLate.body.report.id}`, { method: 'DELETE' });
ok('...and gets it as the report is undone, not at the next start',hasColumn && photoCards(asia).filter(c => c.photo_uuid === lateUuid).length === 1);
if (hasPhotos) db.prepare('DELETE FROM node_photos WHERE uuid = ?').run(lateUuid);
// One card per photo is the database's rule, not only the pass's.
let twin = null;
try { db.prepare("INSERT INTO flashcards (node_id, front, back, photo_uuid) VALUES (?, 'x', 'y', ?)").run(japanese.id, japanese.photos[1].uuid); twin = 'inserted'; }
catch (e) { twin = /UNIQUE/i.test(e.message) ? 'refused' : e.message; }
ok('a second card for one photo is refused by the database', twin === 'refused', twin);
const { derivedUuid } = await import(`${B}syncTables.js`);
const named = hasColumn ? photoCards(asia).find(c => c.photo_uuid === japanese.photos[2].uuid) : null;
ok('a photo card\'s uuid comes from its photo\'s, so two copies of the library name it alike',
    !!named && named.uuid === derivedUuid(['photo-card', japanese.photos[2].uuid]), named?.uuid);

// ---- 8. course files -------------------------------------------------------------------
section('8. course files leave photo cards out; an imported course makes them again');
const exported = await (await fetch(`${base}/api/export/${asia.id}`)).json().catch(() => ({}));
const exCards = (exported.nodes || []).flatMap(n => n.flashcards || []);
ok('the course\'s own card is exported', exCards.some(c => c.back === 'Ming'), JSON.stringify(exCards.map(c => c.back)));
const subjects = new Set(asiaFound.map(p => p.subject));
// A photo card names its example on the first line under the answer (the answer is the topic).
const exampleOf = (c) => String(c.extra || '').split('\n')[0];
ok('...the photo cards are not', exported.nodes && !exCards.some(c => subjects.has(exampleOf(c))), JSON.stringify(exCards.map(c => c.back)));
const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const bundleRes = await fetch(`${base}/api/export/${asia.id}/bundle`);
const bundleBuf = bundleRes.ok ? Buffer.from(await bundleRes.arrayBuffer()) : null;
const zip = bundleBuf ? await JSZip.loadAsync(bundleBuf) : null;
const manifest = zip ? JSON.parse(await zip.file('manifest.json').async('string')) : {};
const bCards = (manifest.nodes || []).flatMap(n => n.flashcards || []);
ok('...nor in a bundle', bundleBuf && !bCards.some(c => subjects.has(exampleOf(c))) && bCards.some(c => c.back === 'Ming'), JSON.stringify(bCards.map(c => c.back)));
let importedId = null;
if (bundleBuf) {
    const form = new FormData();
    form.append('bundle', new Blob([bundleBuf]), 'course.studyvault');
    const r = await fetch(`${base}/api/import/bundle`, { method: 'POST', body: form });
    if (r.ok) importedId = db.prepare('SELECT id FROM projects WHERE name = ? AND id != ? ORDER BY id DESC LIMIT 1').get(asia.name, asia.id)?.id ?? null;
}
const importedCards = importedId && hasColumn ? photoCards({ id: importedId }) : [];
ok('a course imported from a bundle has a photo card for every photo it brought', !!importedId && importedCards.length === asiaFound.length
    && new Set(importedCards.map(exampleOf)).size === subjects.size && importedCards.every(c => subjects.has(exampleOf(c))),
    JSON.stringify({ importedId, n: importedCards.length }));
ok('...each naming, as the file\'s claim, the model that wrote its words', importedCards.length > 0
    && importedCards.every(c => { try { const g = JSON.parse(c.generated_by); return g.model === 'stub-model' && g.via === 'import'; } catch { return false; } }),
    JSON.stringify(importedCards.map(c => c.generated_by).slice(0, 2)));
ok('...each new, made from the imported course\'s own photo', importedCards.length > 0 && importedCards.every(c => !c.review_count
    && !!db.prepare('SELECT 1 FROM node_photos p JOIN nodes n ON n.id = p.node_id WHERE p.uuid = ? AND n.project_id = ?').get(c.photo_uuid, importedId)));
const importedState = importedId ? (await get(`/api/projects/${importedId}/photo-practice`)).body : null;
ok('...and offers the same practice', importedState?.available === true && importedState?.photos === asiaFound.length, JSON.stringify(importedState));

// ---- 9. no model --------------------------------------------------------------------
section('9. nothing here asks a model');
ok('no request reached the model', calls.length === 0, JSON.stringify(calls));

// ---- 10. the card front says nothing ------------------------------------------------
section('10. what the screen says before the answer: the card\'s description, the options\' labels');
let alt = null;
try {
    const esbuild = require('esbuild');
    const out = join(scratch, 'cardImageAlt.mjs');
    await esbuild.build({ entryPoints: [join(SRC, 'components/cardImageAlt.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
    alt = await import(pathToFileURL(out).href);
} catch { alt = null; }
const described = { description: 'Hall of Supreme Harmony. Double-eaved hip roof.', described_by: 'author' };
const front = { hash: 'a'.repeat(64), kind: 'image', prompt: true };
const said = alt ? alt.imageAltText(front, described, d => `AI description: ${d}`, 'Photo to recognise') : '';
ok('a screen reader hears that it is the photo to recognise, not its name', said === 'Photo to recognise', said);
ok('...and its stored description is not even looked up', !!alt && alt.needsStoredDescription(front) === false);
ok('a picture that is not asked about keeps its description', !!alt && alt.imageAltText({ hash: 'a'.repeat(64), kind: 'image' }, described, d => d, 'x') === described.description);

// The options' labels: the words after a colon describe the answer, so they go,
// unless two topics would then read alike.
let short = null;
try {
    const out = join(scratch, 'shortTitles.mjs');
    await require('esbuild').build({ entryPoints: [join(SRC, 'utils/shortTitles.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
    short = (await import(pathToFileURL(out).href)).shortTitles;
} catch { short = null; }
const labelsOf = (titles) => (short ? titles.map(t => short(titles).get(t)) : null);
ok('an option reads as the part of its title before the colon',
    JSON.stringify(labelsOf(['Japanese temples: timber and raised floors', 'Korean palaces: dancheong colours', 'Ming'])) === JSON.stringify(['Japanese temples', 'Korean palaces', 'Ming']),
    JSON.stringify(labelsOf(['Japanese temples: timber and raised floors', 'Korean palaces: dancheong colours', 'Ming'])));
ok('...and every option keeps its whole title when two would read alike',
    JSON.stringify(labelsOf(['Temples: Japan', 'temples: Korea', 'Palaces: Korea'])) === JSON.stringify(['Temples: Japan', 'temples: Korea', 'Palaces: Korea']),
    JSON.stringify(labelsOf(['Temples: Japan', 'temples: Korea', 'Palaces: Korea'])));

// ---- 11. where a topic is named next to the card ---------------------------------------
section('11. a photo card is not served where its topic is named beside it');
// The feed sets each card under its topic's heading, and the agent's review
// view prints the topic: there a photo card would answer itself. The course's
// own card is due too, so an empty answer cannot pass.
const NO_PHOTO = hasColumn ? 'photo_uuid IS NULL' : '1';
const ming = db.prepare(`SELECT id FROM flashcards WHERE back = 'Ming' AND ${NO_PHOTO}`).get();
const duePhoto = hasColumn ? photoCards(asia)[0] : null;
db.prepare("UPDATE flashcards SET next_review = '2020-01-01T00:00:00.000Z', stability = 1, difficulty = 5, review_count = 1, state = 2 WHERE id IN (?, ?)")
    .run(ming?.id ?? -1, duePhoto?.id ?? -1);
const feed = (await get(`/api/feed?projectId=${asia.id}&limit=50`)).body;
const fedCards = (feed?.items || []).filter(i => i.kind === 'flashcard').map(i => i.card?.id);
ok('the feed serves the course\'s own due card', fedCards.includes(ming?.id), JSON.stringify(fedCards));
ok('...and not a due photo card', !!duePhoto && !fedCards.includes(duePhoto.id), JSON.stringify({ photo: duePhoto?.id, fedCards }));
const sittings = await import(`${B}agentSittings.js`);
const target = sittings.reviewTarget(String(asia.id));
const nonPhotoOwed = db.prepare(`SELECT COUNT(*) AS c FROM flashcards f JOIN nodes n ON n.id = f.node_id
    WHERE n.project_id = ? AND f.deleted_at IS NULL AND ${hasColumn ? 'f.photo_uuid IS NULL' : '1'} /* with deleted */`).get(asia.id).c;
ok('an agent\'s card review holds the course\'s own cards and no photo card', target.count === nonPhotoOwed && nonPhotoOwed >= 1,
    JSON.stringify({ count: target.count, nonPhotoOwed }));
// A topic whose only cards are made from its photos still has none for what it
// teaches: the bulk writer and the material step both still offer to write them.
const photoOnly = asia.topics.find(tp => photoCards(asia).some(c => c.node_id === tp.id)
    && !db.prepare(`SELECT 1 FROM flashcards WHERE node_id = ? AND ${hasColumn ? 'photo_uuid IS NULL' : '1'} AND deleted_at IS NULL /* with deleted */`).get(tp.id));
const { bulkCandidates } = await import(`${B}bulkGen.js`);
const cand = photoOnly ? bulkCandidates(asia.id).find(c => c.nodeId === photoOnly.id) : null;
ok('a topic with only photo cards is still one without cards for the bulk writer', !!photoOnly && cand?.flashcards === 0, JSON.stringify({ topic: photoOnly?.title, cand: cand?.flashcards }));
const { pendingMaterial } = await import(`${B}feedGen.js`);
if (photoOnly) db.prepare("INSERT INTO feed_items (node_id, kind, content, meta) VALUES (?, 'plan', '{}', ?)").run(photoOnly.id, JSON.stringify({ skippedCheck: true }));
const material = photoOnly ? pendingMaterial(photoOnly.id) : null;
ok('...and the feed still prepares its cards', material?.kind === 'flashcards', JSON.stringify(material && { type: material.type, kind: material.kind }));
// The day's new cards are counted after the photo cards are left out: with an
// allowance of exactly the course's own new cards, every one of them fits,
// one of the LAST topic too, behind earlier topics' photo cards.
const lastTopic = asia.topics.at(-1);
const lateCard = Number(db.prepare("INSERT INTO flashcards (node_id, front, back) VALUES (?, 'Late front', 'Late back')").run(lastTopic.id).lastInsertRowid);
const { studyQueue } = await import(`${B}decks.js`);
const ownNew = studyQueue(asia.id, { newLimit: 10_000 }).fresh.filter(c => !c.photo_uuid).map(c => c.id).sort((a, b) => a - b);
const served = studyQueue(asia.id, { newLimit: ownNew.length, photoCards: false }).fresh.map(c => c.id).sort((a, b) => a - b);
const photoAhead = studyQueue(asia.id, { newLimit: 10_000 }).fresh.findIndex(c => c.photo_uuid) < studyQueue(asia.id, { newLimit: 10_000 }).fresh.findIndex(c => c.id === lateCard);
ok('...and a photo card never takes the place of the course\'s own new card', photoAhead && ownNew.includes(lateCard)
    && JSON.stringify(served) === JSON.stringify(ownNew), JSON.stringify({ served, ownNew, photoAhead }));

// ---- 12. photos named by what they are ------------------------------------------------
section('12. a photo is named by what it IS: its answer, not its topic');
// A garden-birds course: one topic teaches two look-alikes, one is about how
// to look (its photos are birds of the other topics), and one picture is kept
// under two topics. The answers are the gate's own, seeded here.
const hasAnswer = hasPhotos && db.prepare("SELECT name FROM pragma_table_info('node_photos')").all().some(c => c.name === 'answer');
ok('a photo can record what it is (node_photos.answer)', hasAnswer);
const birds = { name: 'Garden birds', topics: [
    { title: 'Tits: great tit and blue tit', photos: [
        { subject: 'Great tit', answer: 'Great tit', shows: 'Black head, white cheeks, a black stripe down a yellow breast.', author: 'Ann Lee' },
        { subject: 'Great tit at a feeder', answer: 'great tit', shows: 'The stripe widens on a male.', author: 'Ann Lee' },
        { subject: 'Blue tit', answer: 'Blue tit', shows: 'A blue cap and a white face with a dark eye stripe.', author: 'Ben Ho' },
    ] },
    { title: 'Thrushes: blackbird and robin', photos: [
        { subject: 'Blackbird', answer: 'Blackbird', shows: 'All black with a yellow bill.', author: 'Cai Lun' },
        { subject: 'European robin', answer: 'Robin', shows: 'An orange face and breast.', author: 'Dai Mori' },
    ] },
    { title: 'What to look at: size, shape and colour', photos: [
        { subject: 'Blackbird singing', answer: 'Blackbird', shows: 'The yellow eye ring.', author: 'Emi Sato' },
        // The same picture as the great tit above, kept again under this topic.
        { subject: 'Great tit', answer: 'Great tit', shows: 'Compare its size with the blue tit.', author: 'Ann Lee', sameAs: 0 },
    ] },
] };
const BIRD_KINDS = ['Great tit', 'Blue tit', 'Blackbird', 'Robin'];
const setAnswer = hasAnswer ? db.prepare('UPDATE node_photos SET answer = ? WHERE uuid = ?') : null;
birds.id = Number(insProject.run(birds.name).lastInsertRowid);
const firstTit = birds.topics[0].photos[0];
birds.topics.forEach((t, i) => {
    t.id = Number(insNode.run(birds.id, t.title, i).lastInsertRowid);
    t.photos.forEach((p, j) => {
        p.uuid = randomUUID();
        if (p.sameAs === 0) p.hash = firstTit.hash;
        else {
            const { hash, size } = mediaStorage.put(jpeg(`birds-${++seq}`));
            p.hash = hash;
            insMedia.run(birds.id, hash, `${p.subject.replace(/\W+/g, '_')}.jpg`, size, `${p.subject}. ${p.shows}`);
        }
        p.licence = 'CC BY-SA 4.0';
        p.sourceUrl = `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(p.subject.replace(/ /g, '_'))}_${j}.jpg`;
        insPhoto?.run(p.uuid, t.id, j, p.subject, p.subject, p.shows, 'found', p.hash, `File:${p.subject}.jpg`, p.author, p.licence,
            'https://creativecommons.org/licenses/by-sa/4.0', p.sourceUrl, null, PROVENANCE);
        setAnswer?.run(p.answer, p.uuid);
        photoTruth.set(p.uuid, { course: 'birds', topic: t, photo: p, found: true });
    });
});
/** The gate's own name for a photo: its seeded answer, matched without case to the list above. */
const kindOfPhoto = (uuid) => BIRD_KINDS.find(k => k.toLowerCase() === truthOf(uuid)?.photo.answer.toLowerCase());
const birdPictures = new Set(birds.topics.flatMap(t => t.photos.map(p => p.hash)));
const sBirds = await state(birds);
ok('practice counts kinds and pictures, not topics and rows', sBirds?.available === true && sBirds?.kinds === BIRD_KINDS.length
    && sBirds?.photos === birdPictures.size, JSON.stringify(sBirds));
const bRound = await round(birds, 50);
ok('a round asks each picture once, a picture kept under two topics too', bRound.length === birdPictures.size
    && new Set(bRound.map(i => i.hash)).size === bRound.length, JSON.stringify(bRound.map(i => truthOf(i.photo)?.photo.subject)));
ok('the options are what the photos show, never a topic\'s title', bRound.length > 0
    && bRound.every(i => i.options.every(o => BIRD_KINDS.includes(o.title))), JSON.stringify(bRound[0]?.options));
ok('...one spelling per kind ("great tit" is "Great tit")', bRound.length > 0
    && bRound.every(i => new Set(i.options.map(o => o.title.toLowerCase())).size === i.options.length));
ok('the photo\'s own kind is always among its options', bRound.length > 0 && bRound.every(i => i.options.some(o => o.title === kindOfPhoto(i.photo))));
const titHashes = new Set(birds.topics[0].photos.map(p => p.hash));
const titPhotos = bRound.filter(i => titHashes.has(i.hash));
ok('a photo of a topic that teaches two look-alikes always offers the other one', titPhotos.length === 3
    && titPhotos.every(i => i.options.some(o => o.title === (kindOfPhoto(i.photo) === 'Great tit' ? 'Blue tit' : 'Great tit'))),
    JSON.stringify(titPhotos.map(i => i.options.map(o => o.title))));
const sameKindNeighbours = bRound.reduce((n, it, i) => n + (i > 0 && kindOfPhoto(bRound[i - 1].photo) === kindOfPhoto(it.photo) ? 1 : 0), 0);
ok('never two photos of one kind side by side when the pool allows', bRound.length > 0
    && sameKindNeighbours === fewestPossible(BIRD_KINDS.map(k => bRound.filter(i => kindOfPhoto(i.photo) === k).length)),
    bRound.map(i => kindOfPhoto(i.photo)).join(' | '));
// A blackbird on the how-to-look topic: right when named a blackbird.
const lookTopic = birds.topics[2];
const singing = lookTopic.photos[0];
const bRight = await answer(birds, singing, 'Blackbird');
ok('a photo is right when named what it is, whatever topic it sits under', bRight.status === 200 && bRight.body?.correct === true
    && bRight.body?.answer?.title === 'Blackbird', JSON.stringify(bRight.body?.answer ?? bRight));
const bRow = evidenceRows(lookTopic.id).at(-1);
ok('...the answer is written on the photo\'s own topic', metaOf(bRow).photo === singing.uuid && bRow?.score === 1
    && evidenceRows(birds.topics[1].id).length === 0, JSON.stringify(bRow));
ok('...a lucky pick counted as one in the four kinds offered', metaOf(bRow).guess === 0.25, JSON.stringify(metaOf(bRow)));
const bWrong = await answer(birds, singing, 'Robin');
ok('named another kind, it is wrong, and the verdict says what it was', bWrong.status === 200 && bWrong.body?.correct === false
    && bWrong.body?.answer?.title === 'Blackbird' && bWrong.body?.shown?.topic === 'Blackbird', JSON.stringify(bWrong.body));
ok('...beside it, a photo of the kind picked, named by that kind', kindOfPhoto(bWrong.body?.picked?.uuid) === 'Robin'
    && bWrong.body?.picked?.topic === 'Robin', JSON.stringify(bWrong.body?.picked));
const titWrong = await answer(birds, birds.topics[0].photos[2], 'Great tit');
ok('a blue tit named a great tit, from the same topic, is wrong', titWrong.status === 200 && titWrong.body?.correct === false
    && titWrong.body?.answer?.title === 'Blue tit' && kindOfPhoto(titWrong.body?.picked?.uuid) === 'Great tit', JSON.stringify(titWrong.body));
const topicPick = await post(`/api/projects/${birds.id}/photo-practice/answer`, { photo: singing.uuid, attemptId: randomUUID(), picked: lookTopic.title });
ok('a topic\'s title is not an answer when the photos say what they are', topicPick.status === 400, topicPick.status);
// Two kinds in one topic are enough to practise.
const pair = { name: 'Tits only', topics: [{ title: 'Tits', photos: [
    { subject: 'Great tit', answer: 'Great tit', shows: 'Black head.', author: 'Ann Lee' },
    { subject: 'Blue tit', answer: 'Blue tit', shows: 'Blue cap.', author: 'Ben Ho' },
] }] };
pair.id = Number(insProject.run(pair.name).lastInsertRowid);
pair.topics[0].id = Number(insNode.run(pair.id, 'Tits', 0).lastInsertRowid);
pair.topics[0].photos.forEach((p, j) => {
    p.uuid = randomUUID();
    const { hash, size } = mediaStorage.put(jpeg(`pair-${j}`));
    insMedia.run(pair.id, hash, `pair${j}.jpg`, size, p.subject);
    insPhoto?.run(p.uuid, pair.topics[0].id, j, p.subject, p.subject, p.shows, 'found', hash, `File:pair${j}.jpg`, p.author, 'CC BY-SA 4.0',
        'https://creativecommons.org/licenses/by-sa/4.0', `https://commons.wikimedia.org/wiki/File:pair${j}.jpg`, null, PROVENANCE);
    setAnswer?.run(p.answer, p.uuid);
});
const sPair = await state(pair);
ok('one topic whose photos show two kinds offers practice', sPair?.available === true && sPair?.kinds === 2 && sPair?.topics === 1, JSON.stringify(sPair));
// Six kinds, three options beside the photo's own: the look-alike its topic
// pairs it with must be chosen, not left to the draw (3 in 5 by chance).
const sixBirds = { name: 'Six garden birds', topics: [
    ['Tits', ['Great tit', 'Blue tit']], ['Finches', ['Chaffinch', 'Greenfinch']], ['Thrushes', ['Blackbird', 'Robin']],
] };
sixBirds.id = Number(insProject.run(sixBirds.name).lastInsertRowid);
sixBirds.topics = sixBirds.topics.map(([title, kinds], i) => {
    const id = Number(insNode.run(sixBirds.id, title, i).lastInsertRowid);
    kinds.forEach((kind, j) => {
        const uuid = randomUUID();
        const { hash, size } = mediaStorage.put(jpeg(`six-${i}-${j}`));
        insMedia.run(sixBirds.id, hash, `six${i}${j}.jpg`, size, kind);
        insPhoto?.run(uuid, id, j, kind, kind, 'Look.', 'found', hash, `File:six${i}${j}.jpg`, 'Ann Lee', 'CC BY-SA 4.0',
            'https://creativecommons.org/licenses/by-sa/4.0', `https://commons.wikimedia.org/wiki/File:six${i}${j}.jpg`, null, PROVENANCE);
        setAnswer?.run(kind, uuid);
    });
    return { id, title, kinds };
});
// The gate's own record of each photo's kind and its topic partner, from the seed above.
const partnerOf = new Map(sixBirds.topics.flatMap(t => [[t.kinds[0], t.kinds[1]], [t.kinds[1], t.kinds[0]]]));
const sixKindOf = new Map(db.prepare(`SELECT p.uuid, p.subject FROM node_photos p JOIN nodes n ON n.id = p.node_id WHERE n.project_id = ?`)
    .all(sixBirds.id).map(r => [r.uuid, r.subject]));
const sixItems = [];
for (let n = 0; n < 8; n++) sixItems.push(...await round(sixBirds, 6));
ok('with more kinds than options, a photo is always offered the look-alike its topic pairs it with', sixItems.length === 48
    && sixItems.every(i => i.options.length === 4 && i.options.some(o => o.title === partnerOf.get(sixKindOf.get(i.photo)))),
    JSON.stringify(sixItems.filter(i => !i.options.some(o => o.title === partnerOf.get(sixKindOf.get(i.photo))))
        .slice(0, 2).map(i => [sixKindOf.get(i.photo), i.options.map(o => o.title)])));
// Cards: the back is what the photo is; one card per picture.
cards?.syncAllPhotoCards?.();
const bCardsNow = hasColumn ? photoCards(birds) : [];
ok('one card per picture: the picture kept under two topics has one', bCardsNow.length === birdPictures.size
    && new Set(bCardsNow.map(c => JSON.parse(c.media).front[0].hash)).size === bCardsNow.length, bCardsNow.length);
// Spelled as the round spells it: the feeder photo's answer is stored "great tit".
ok('a card\'s back is what its photo is, spelled as the round offers it', bCardsNow.length > 0
    && bCardsNow.every(c => c.back === kindOfPhoto(c.photo_uuid)), JSON.stringify(bCardsNow.map(c => c.back)));
const titCard = bCardsNow.find(c => c.photo_uuid === firstTit.uuid);
ok('...with what to look at under it, and no line that only repeats the back', titCard?.extra === firstTit.shows, JSON.stringify(titCard?.extra));
const robinCard = bCardsNow.find(c => c.photo_uuid === birds.topics[1].photos[1].uuid);
ok('...and the example\'s own name when it says more than the kind', robinCard?.extra === `European robin\n${birds.topics[1].photos[1].shows}`, JSON.stringify(robinCard?.extra));

// A course file carries the answer, and the imported course practises by it.
const bExport = await (await fetch(`${base}/api/export/${birds.id}`)).json().catch(() => ({}));
const exPhotos = (bExport.nodes || []).flatMap(n => n.photos || []);
ok('a course file carries each photo\'s answer', exPhotos.length === birds.topics.flatMap(t => t.photos).length
    && exPhotos.every(p => BIRD_KINDS.some(k => k.toLowerCase() === String(p.answer).toLowerCase())), JSON.stringify(exPhotos.map(p => p.answer)));
const birdBundle = await fetch(`${base}/api/export/${birds.id}/bundle`);
const birdBuf = birdBundle.ok ? Buffer.from(await birdBundle.arrayBuffer()) : null;
let birdCopy = null;
if (birdBuf) {
    const form = new FormData();
    form.append('bundle', new Blob([birdBuf]), 'birds.studyvault');
    const r = await fetch(`${base}/api/import/bundle`, { method: 'POST', body: form });
    if (r.ok) birdCopy = db.prepare('SELECT id FROM projects WHERE name = ? AND id != ? ORDER BY id DESC LIMIT 1').get(birds.name, birds.id)?.id ?? null;
}
const copyRound = birdCopy ? await round({ id: birdCopy }, 50) : [];
ok('...and the imported course asks for the same kinds', copyRound.length === birdPictures.size
    && copyRound.every(i => i.options.every(o => BIRD_KINDS.includes(o.title))), JSON.stringify(copyRound[0]?.options));

await new Promise(r => server.close(r));
await new Promise(r => stub.close(r));
try { db.close(); } catch { }
try { rmSync(scratch, { recursive: true, force: true }); } catch { }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

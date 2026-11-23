// tools/topic-photos-gates.mjs — photos for topics learned by sight.
//
// Run:  node tools/topic-photos-gates.mjs [--server <dir>]
//
// A course about telling things apart by their look (buildings, species,
// artworks) used to get topics whose descriptions promised "a picture quiz",
// and no picture anywhere. Now the app finds real photos in Wikimedia Commons
// after the outline is written, keeps only freely licensed ones with their
// credit, stores them in the library, and the lesson writer places them by
// number. This asserts, against the REAL routes on a scratch library, a stub
// model on loopback and a stub photo archive (nothing billed, nothing leaves
// the machine), that:
//
//   1. the licence and shape filter keeps CC0, public domain, CC BY and
//      CC BY-SA photos of a sensible size and shape, and drops non-commercial,
//      no-derivatives, GFDL-only, non-free and restricted files, a CC BY file
//      with no author, drawings, thin panoramas, tiny files and any address
//      off the archive's two hosts;
//   2. a course created with the setting on (its default) finds photos for
//      the topics the model calls "by sight" and none for the rest: one
//      request at a time, an identifying User-Agent, only the archive's two
//      hosts, the standard 960 px width, never an address a model wrote;
//   3. every kept photo carries its author, licence and source page from the
//      archive, its file is in the library's media store for that course and
//      is served by the app, and the topic route returns them;
//   4. the activity log records the run with numbers only;
//   5. the lesson writer is given the photos by number and no address, a
//      topic with none is told not to point at pictures, any other topic's
//      prompt is unchanged; `[[photo:N]]` is stored as the photo's id, a
//      number not offered and an image the model wrote are dropped, and the
//      lesson card carries the photos with their credit;
//   6. no outline prompt lets a description promise a picture quiz;
//   7. both exports carry the credit, a bundle carries the files, and a
//      bundle imported again has its photos back;
//   8. a 429 is retried once and then the run stops, logged;
//   9. with the setting off, creation asks the archive nothing and the model
//      no photo question; the setting is in the client's registry;
//  10. SECURITY.md names both hosts.
//
// `--server <dir>` runs the same cases against another copy of server/ (the
// pre-change code, e.g. `git archive origin/main server | tar -x -C temp/head`);
// that code is expected to FAIL.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const SERVER_DIR = argOf('--server') ? resolve(argOf('--server')) : null;
const B = SERVER_DIR ? pathToFileURL(SERVER_DIR + '/').href : new URL('../server/', import.meta.url).href;

const scratch = mkdtempSync(join(tmpdir(), 'topic-photos-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${String(extra).slice(0, 400)}` : ''}`); }
};
const section = (s) => console.log(`\n=== ${s} ===`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- the stub model -------------------------------------------------------------
const TOPICS = [
    { title: 'Chinese palace halls', description: 'How the halls of an imperial palace are laid out and roofed.' },
    { title: 'Korean temple roofs', description: 'The roof lines of Korean Buddhist temples.' },
    { title: 'Why roofs curve: the history', description: 'Where the curved roof came from and how it spread.' },
];
const kindOf = (system) => system.includes('You decide what shape a new course takes') ? 'shape'
    : /SHORT COURSE/.test(system) ? 'short'
        : system.includes('learned BY SIGHT') ? 'photo_plan'
            : system.includes('You pick photos for a lesson') ? 'photo_choice'
                : system.includes('curriculum designer') ? 'outline'
                    : system.includes('writing ONE segment') ? 'lesson'
                        : 'other';
const LESSON = `An imperial hall is read from its roof first. The Hall of Supreme Harmony carries a double-eaved hip roof, the highest rank a building could hold, with yellow glazed tiles that only the emperor's buildings used.

[[photo:1]]

Look at the two eaves stacked one above the other and the gentle upward sweep at each corner. Count the small figures on the ridge ends too: their number tells the hall's rank.

![a hall](https://evil.example/c.jpg)

[[photo:5]]

Compare that with a temple hall, whose roof is lower and plainer and which sits on a far smaller platform than the palace hall does.`;
let calls = [];
const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        }
        const body = JSON.parse(raw || '{}');
        const msgs = body.messages || [];
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n');
        const kind = kindOf(system);
        calls.push({ kind, system, user });
        let content = null;
        if (kind === 'shape') content = '{"shape": "short"}';
        else if (kind === 'short') {
            content = JSON.stringify({
                name: 'Telling East Asian buildings apart',
                description: 'Recognise Chinese and Korean buildings by their roofs and halls.',
                topics: TOPICS.map((t, i) => ({ ...t, sections: [Math.min(i + 1, 3)] })),
            });
        } else if (kind === 'photo_plan') {
            content = JSON.stringify({ topics: [
                { topic: 1, examples: [
                    { name: 'Hall of Supreme Harmony', search: 'Hall of Supreme Harmony Forbidden City', shows: 'The double-eaved hip roof and the marble terrace.' },
                    { name: 'Daibutsuden https://evil.example/pic.jpg', search: 'Todai-ji Daibutsuden', shows: 'A wooden hall on a huge scale.' },
                ] },
                { topic: 2, examples: [{ name: 'Bulguksa', search: 'Bulguksa temple', shows: 'The roof lines over the stone terraces.' }] },
                { topic: 9, examples: [{ name: 'Nowhere', search: 'Nowhere at all', shows: '' }] },
            ] });
        } else if (kind === 'photo_choice') {
            content = JSON.stringify({ picks: [
                { example: 1, candidates: [1] },
                { example: 2, candidates: ['https://evil.example/b.jpg', 7, 1] },
            ] });
        } else if (kind === 'outline') {
            content = JSON.stringify({ parts: [{ title: 'Reading a hall by its roof', focus: 'The roof tells the rank.' }] });
        } else if (kind === 'lesson') content = LESSON;
        if (content == null) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end('{"error":{"message":"stub: not part of this gate"}}');
        }
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 20 } }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

// ---- the stub photo archive -----------------------------------------------------
const enc = (t) => encodeURIComponent(t.replace(/ /g, '_'));
const page = (index, title, o = {}) => {
    const w = o.w ?? 1600, h = o.h ?? 1000;
    const meta = {
        LicenseShortName: { value: o.lic ?? 'CC BY-SA 4.0' },
        License: { value: o.code ?? 'cc-by-sa-4.0' },
        LicenseUrl: { value: o.licUrl ?? 'https://creativecommons.org/licenses/by-sa/4.0' },
        Artist: { value: o.artist ?? '<a href="//commons.wikimedia.org/wiki/User:Ann">Ann Lee</a>' },
        ImageDescription: { value: `Photo of ${title}` },
        Categories: { value: 'Forbidden City|Halls' },
    };
    if (o.nonFree) meta.NonFree = { value: 'true' };
    if (o.restrictions) meta.Restrictions = { value: o.restrictions };
    return {
        pageid: index, ns: 6, title: `File:${title}`, index,
        imageinfo: [{
            url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${enc(title)}`,
            descriptionurl: `https://commons.wikimedia.org/wiki/File:${enc(title)}`,
            thumburl: o.thumb ?? `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${enc(title)}/960px-${enc(title)}`,
            thumbwidth: 960, thumbheight: Math.round(960 * h / w), width: w, height: h, mime: o.mime ?? 'image/jpeg', extmetadata: meta,
        }],
    };
};
const HALL = page(2, 'Hall of Supreme Harmony 2019.jpg');
const TODAIJI = page(1, 'Todaiji Daibutsuden.jpg', { lic: 'CC0', code: 'cc0', artist: '', licUrl: 'https://creativecommons.org/publicdomain/zero/1.0' });
const ARCHIVE = {
    'Hall of Supreme Harmony Forbidden City': [
        page(1, 'Taihedian NC.jpg', { lic: 'CC BY-NC-SA 2.0', code: 'cc-by-nc-sa-2.0' }),
        HALL,
        page(3, 'Taihedian plan.svg', { mime: 'image/svg+xml', lic: 'Public domain', code: 'pd' }),
        page(4, 'Forbidden City panorama.jpg', { w: 6000, h: 1500, lic: 'Public domain', code: 'pd' }),
        page(5, 'Taihedian no author.jpg', { lic: 'CC BY 2.0', code: 'cc-by-2.0', artist: '' }),
        page(6, 'Taihedian elsewhere.jpg', { lic: 'CC0', code: 'cc0', thumb: 'https://evil.example/x.jpg' }),
        page(7, 'Taihedian GFDL.jpg', { lic: 'GFDL', code: 'gfdl' }),
        page(8, 'Taihedian small.jpg', { w: 300, h: 200, lic: 'CC0', code: 'cc0' }),
    ],
    'Todai-ji Daibutsuden': [TODAIJI, page(2, 'Todaiji ND.jpg', { lic: 'CC BY-ND 4.0', code: 'cc-by-nd-4.0' })],
    'Bulguksa temple': [
        page(1, 'Bulguksa nonfree.jpg', { nonFree: true }),
        page(2, 'Bulguksa people.jpg', { restrictions: 'personality' }),
        page(3, 'Bulguksa ND.jpg', { lic: 'CC BY-ND 4.0', code: 'cc-by-nd-4.0' }),
    ],
};
const jpeg = (seed) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF stub photo ${seed} `.repeat(20))]);
const archive = { requests: [], inflight: 0, maxInflight: 0, foreign: [], busy: 0 };
async function fakeArchive(url, init = {}) {
    const u = new URL(url);
    archive.inflight++;
    archive.maxInflight = Math.max(archive.maxInflight, archive.inflight);
    try {
        await sleep(3);
        const ua = init.headers?.['User-Agent'] || init.headers?.['user-agent'] || '';
        archive.requests.push({ url: u, ua, redirectChecked: typeof init.allowRedirect === 'function' });
        if (archive.busy > 0) {
            archive.busy--;
            return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
        }
        if (u.hostname === 'commons.wikimedia.org' && u.pathname === '/w/api.php') {
            const q = (u.searchParams.get('gsrsearch') || '').replace(/ filetype:bitmap$/, '');
            const pages = ARCHIVE[q] || [];
            return new Response(JSON.stringify({ batchcomplete: true, query: { pages } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (u.hostname === 'upload.wikimedia.org') {
            return new Response(jpeg(u.pathname), { status: 200, headers: { 'content-type': 'image/jpeg' } });
        }
        archive.foreign.push(url);
        throw new Error(`gate: no such host ${u.hostname}`);
    } finally {
        archive.inflight--;
    }
}

// ---- the real app on a scratch library ------------------------------------------
const { default: db } = await import(`${B}database.js`);
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'true');
setSetting.run('creation_find_resources', 'false');
setSetting.run('embedding_enabled', 'false');
setSetting.run('ui_language', 'en');
const { createApp } = await import(`${B}app.js`);
const tasks = await import(`${B}tasks.js`);
const { AI_PROMPTS } = await import(`${B}ai.js`);
const photos = await import(`${B}topicPhotos.js`).catch(() => null);
ok('the photo module exists (server/topicPhotos.js)', !!photos);
photos?.setPhotoFetchForTest(fakeArchive);

const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'node_photos'").get();
ok('the library has a table for topic photos', hasTable);
const photoRows = (nodeId) => hasTable ? db.prepare('SELECT * FROM node_photos WHERE node_id = ? ORDER BY position, id').all(nodeId) : [];

async function create(name) {
    calls = [];
    const res = await fetch(`${base}/api/ai/create-project`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, description: 'Learn to tell the buildings apart by their look.', content_language: 'en' }),
    });
    const frames = [];
    for (const chunk of (await res.text()).split('\n\n')) if (chunk.startsWith('data: ')) frames.push(JSON.parse(chunk.slice(6)));
    const done = frames.find(f => f.phase === 'complete');
    return { done, id: done?.projectId ?? null, frames };
}
const photoTask = () => tasks.listTasks().filter(t => t.kind === 'find_photos').at(-1);
async function settle(ms = 15_000) {
    const until = Date.now() + ms;
    await sleep(50);
    while (Date.now() < until) {
        const t = photoTask();
        if (!t || t.status !== 'running') return t;
        await sleep(50);
    }
    return photoTask();
}
const topicsOf = (projectId) => projectId
    ? db.prepare('SELECT id, title FROM nodes WHERE project_id = ? AND is_note = 0 ORDER BY position, id').all(projectId)
    : [];

// ---- 1. the licence and shape filter --------------------------------------------
section('1. only free licences, sensible sizes, the archive\'s own hosts');
const kept = (p) => !!photos?.candidateOf(p);
ok('CC BY-SA 4.0 with an author is kept', kept(HALL));
ok('CC0 with no author is kept', kept(TODAIJI));
ok('public domain is kept', kept(page(1, 'pd.jpg', { lic: 'Public domain', code: 'pd', artist: '' })));
ok('CC BY 2.0 with an author is kept', kept(page(1, 'by.jpg', { lic: 'CC BY 2.0', code: 'cc-by-2.0' })));
const dropped = [
    ['non-commercial', page(1, 'a.jpg', { lic: 'CC BY-NC-SA 2.0', code: 'cc-by-nc-sa-2.0' })],
    ['no-derivatives', page(1, 'b.jpg', { lic: 'CC BY-ND 4.0', code: 'cc-by-nd-4.0' })],
    ['GFDL only', page(1, 'c.jpg', { lic: 'GFDL', code: 'gfdl' })],
    ['marked non-free', page(1, 'd.jpg', { nonFree: true })],
    ['restricted (personality rights)', page(1, 'e.jpg', { restrictions: 'personality' })],
    ['CC BY with no author', page(1, 'f.jpg', { lic: 'CC BY 2.0', code: 'cc-by-2.0', artist: '' })],
    ['a drawing (SVG)', page(1, 'g.svg', { mime: 'image/svg+xml', lic: 'CC0', code: 'cc0' })],
    ['a thin panorama', page(1, 'h.jpg', { w: 6000, h: 1500 })],
    ['a tall strip', page(1, 'i.jpg', { w: 800, h: 2400 })],
    ['a tiny file', page(1, 'j.jpg', { w: 300, h: 200 })],
    ['a thumbnail on another host', page(1, 'k.jpg', { thumb: 'https://evil.example/x.jpg' })],
    ['a thumbnail over http', page(1, 'l.jpg', { thumb: 'http://upload.wikimedia.org/x.jpg' })],
    ['a page that is not a file', { ...HALL, title: 'Hall of Supreme Harmony' }],
];
for (const [what, p] of dropped) ok(`dropped: ${what}`, !!photos && !kept(p));
const credit = photos?.candidateOf(HALL);
ok('the author is the archive\'s, as plain text', credit?.author === 'Ann Lee', JSON.stringify(credit?.author));
ok('the source is the file\'s page on the archive', /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/.test(credit?.source || ''), credit?.source);

// ---- 6. outline prompts never promise a picture quiz ----------------------------
section('6. no outline prompt lets a description promise a picture quiz');
const PROMISE = 'never promises how it will be taught or tested';
const outlinePrompts = {
    short_course: AI_PROMPTS.short_course('Buildings', {}),
    generate_categories: AI_PROMPTS.generate_categories('P', 'D', 'T', 'S', {}),
    generate_elements: AI_PROMPTS.generate_elements('P', 'S', 'C', 'D', {}),
    generate_sub_elements: AI_PROMPTS.generate_sub_elements('P', 'S', 'D', 'C', 'CD', 'All', 'E', 'ED', {}),
};
for (const [name, p] of Object.entries(outlinePrompts)) ok(`${name} carries the rule`, p.system.includes(PROMISE));

// ---- 2-4. creation with the setting on ------------------------------------------
section('2. a course created with the setting on finds photos for by-sight topics');
const made = await create('Telling East Asian buildings apart');
ok('the course is created (short)', !!made.done, JSON.stringify(made.frames.at(-1)));
const t = await settle();
ok('a "find_photos" task ran and finished', t?.status === 'done', JSON.stringify(t && { status: t.status, error: t.errorMessage }));
const [hallsTopic, roofsTopic, historyTopic] = topicsOf(made.id);
ok('the model was asked once which topics are learned by sight', calls.filter(c => c.kind === 'photo_plan').length === 1, JSON.stringify(calls.map(c => c.kind)));
ok('...and once to pick, for the one topic with candidates left', calls.filter(c => c.kind === 'photo_choice').length === 1);
const choice = calls.find(c => c.kind === 'photo_choice');
ok('the picker sees only the candidates that passed the filter', !!choice && choice.user.includes('Hall of Supreme Harmony 2019') && !/Taihedian (NC|plan|no author|elsewhere|GFDL|small)/.test(choice.user), choice?.user);
ok('...by number, with no address in its prompt', !!choice && !/https?:\/\//.test(choice.user));

const api = archive.requests.filter(r => r.url.hostname === 'commons.wikimedia.org');
const downloads = archive.requests.filter(r => r.url.hostname === 'upload.wikimedia.org');
ok(`three searches, one per example (got ${api.length})`, api.length === 3);
ok('every request names the app and a contact address in its User-Agent',
    archive.requests.length > 0 && archive.requests.every(r => /^Terramentor\/\S+ \(https:\/\/\S+[;)]/.test(r.ua)), archive.requests[0]?.ua);
ok('...and nothing about the learner or the course', archive.requests.length > 0 && archive.requests.every(r => !/East Asian|buildings|Chinese|Korean|@/i.test(r.ua)));
ok('every search asks for the 960 px thumbnail, with maxlag', api.length > 0 && api.every(r => r.url.searchParams.get('iiurlwidth') === '960' && r.url.searchParams.get('maxlag') === '5'));
ok('every search is a file search for bitmaps', api.length > 0 && api.every(r => r.url.searchParams.get('gsrnamespace') === '6' && /filetype:bitmap$/.test(r.url.searchParams.get('gsrsearch') || '')));
ok('one request at a time', archive.maxInflight === 1, `max in flight ${archive.maxInflight}`);
ok('only the archive\'s two hosts were asked, never an address a model wrote', archive.requests.length > 0 && archive.foreign.length === 0 && archive.requests.every(r => /^(commons|upload)\.wikimedia\.org$/.test(r.url.hostname)), JSON.stringify(archive.foreign));
ok('a redirect is checked against the two hosts', archive.requests.length > 0 && archive.requests.every(r => r.redirectChecked));
ok(`two downloads, both the chosen 960 px thumbnails (got ${downloads.length})`,
    downloads.length === 2 && downloads.every(r => /\/960px-/.test(r.url.pathname)), downloads.map(r => r.url.pathname).join(', '));

section('3. every kept photo is credited, stored for the course and served');
const hallRows = hallsTopic ? photoRows(hallsTopic.id) : [];
const roofRows = roofsTopic ? photoRows(roofsTopic.id) : [];
ok('the palace topic has its two examples, both found', hallRows.length === 2 && hallRows.every(r => r.status === 'found'), JSON.stringify(hallRows.map(r => r.status)));
ok('the temple topic has its example and no photo (nothing free was left)', roofRows.length === 1 && roofRows[0].status === 'none', JSON.stringify(roofRows.map(r => r.status)));
ok('the history topic is not learned by sight: no rows', historyTopic && photoRows(historyTopic.id).length === 0);
const hall = hallRows[0] || {};
ok('credit: the author', hall.author === 'Ann Lee', hall.author);
ok('credit: the licence and its address', hall.licence === 'CC BY-SA 4.0' && hall.licence_url === 'https://creativecommons.org/licenses/by-sa/4.0', `${hall.licence} ${hall.licence_url}`);
ok('credit: the source page', hall.source_url === 'https://commons.wikimedia.org/wiki/File:Hall_of_Supreme_Harmony_2019.jpg', hall.source_url);
ok('a public-domain-style licence needs no author', hallRows[1]?.licence === 'CC0');
ok('no kept photo is under a licence outside the four', hallRows.length > 0 && hallRows.every(r => /^(CC0|Public domain|CC BY(-SA)? \d)/.test(r.licence || '')));
ok('an address inside a name the model wrote is dropped, never fetched', hallRows[1]?.subject === 'Daibutsuden' && archive.foreign.length === 0, hallRows[1]?.subject);
ok('the model that named the examples is recorded', hallRows.length > 0 && hallRows.every(r => /stub-model/.test(r.generated_by || '')));
const media = hall.hash ? db.prepare('SELECT * FROM media_files WHERE hash = ? AND project_id = ?').get(hall.hash, made.id) : null;
ok('the file is in the library\'s media store, for this course', !!media && media.mime === 'image/jpeg' && media.kind === 'image');
const served = hall.hash ? await fetch(`${base}/api/media/${hall.hash}`) : null;
const servedBytes = served ? Buffer.from(await served.arrayBuffer()) : Buffer.alloc(0);
ok('the app serves it', served?.status === 200 && servedBytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), served?.status);
const route = hallsTopic ? await (await fetch(`${base}/api/nodes/${hallsTopic.id}/photos`)).json().catch(() => ({})) : {};
ok('the topic route returns them with their credit', route.state === 'found' && route.photos?.length === 2
    && route.photos[0].author === 'Ann Lee' && route.photos[0].licence === 'CC BY-SA 4.0' && /commons\.wikimedia\.org/.test(route.photos[0].sourceUrl || ''), JSON.stringify(route).slice(0, 300));
const none = roofsTopic ? await (await fetch(`${base}/api/nodes/${roofsTopic.id}/photos`)).json().catch(() => ({})) : {};
ok('..."none" for the topic with no photo', none.state === 'none' && none.photos?.length === 0, JSON.stringify(none));
const notSight = historyTopic ? await (await fetch(`${base}/api/nodes/${historyTopic.id}/photos`)).json().catch(() => ({})) : {};
ok('...and no state for a topic not learned by sight', notSight.state === null, JSON.stringify(notSight));

section('4. the activity log records the run with numbers only');
const logRow = db.prepare(`SELECT * FROM activity_log WHERE event LIKE 'photos.%' ORDER BY id DESC LIMIT 1`).get();
ok('a "photos.done" row', logRow?.event === 'photos.done', JSON.stringify(logRow));
ok('its detail is counts, no titles, names or searches', !!logRow && /^\d+ topics · \d+ found · \d+ none · \d+ requests/.test(logRow.detail || '')
    && !/Hall|Harmony|Bulguksa|Chinese|palace|Todai/i.test(logRow.detail || ''), logRow?.detail);

// ---- 5. the lesson writer --------------------------------------------------------
section('5. lessons place photos by number; the card carries them with credit');
const { generateForNode } = await import(`${B}feedGen.js`);
async function writePartOne(nodeId) {
    calls = [];
    const ac = new AbortController();
    try {
        await generateForNode(nodeId, { signal: ac.signal, onStep: (l) => { if (l !== 'outline' && l !== 'lesson 1') ac.abort(); } });
    } catch { /* the abort, by design */ }
    const lesson = db.prepare(`SELECT content, meta FROM feed_items WHERE node_id = ? AND kind = 'lesson' ORDER BY seq LIMIT 1`).get(nodeId);
    return { prompt: calls.find(c => c.kind === 'lesson')?.system || '', lesson };
}
const w1 = hallsTopic ? await writePartOne(hallsTopic.id) : { prompt: '', lesson: null };
ok('the writer is given the photos by number', w1.prompt.includes('PHOTOS:') && w1.prompt.includes('[[photo:1]] Hall of Supreme Harmony') && w1.prompt.includes('[[photo:2]]'), w1.prompt.slice(-600));
ok('...with no address of any photo', !/wikimedia|https?:\/\/\S+\.(jpe?g|png)/i.test(w1.prompt));
const stored = w1.lesson?.content || '';
ok('[[photo:1]] is stored as the photo\'s id, on a line of its own', !!hall.uuid && new RegExp(`^\\[\\[photo:${hall.uuid}\\]\\]$`, 'm').test(stored), stored.slice(0, 400));
ok('a number not offered is dropped', !stored.includes('[[photo:5]]') && !/\[\[photo:\d+\]\]/.test(stored));
ok('an image the model wrote is dropped', !stored.includes('evil.example') && !/!\[[^\]]*\]\(/.test(stored));
ok('the prose around them is kept', stored.includes('double-eaved hip roof') && stored.includes('Compare that with a temple hall'));
const feed = hallsTopic ? await (await fetch(`${base}/api/feed?nodeId=${hallsTopic.id}`)).json().catch(() => ({})) : {};
const card = (feed.items || []).find(c => c.kind === 'lesson' && c.nodeId === hallsTopic?.id);
ok('the lesson card carries the photo it places, with its credit', card?.photos?.length === 1 && card.photos[0].uuid === hall.uuid
    && card.photos[0].author === 'Ann Lee' && card.photos[0].hash === hall.hash, JSON.stringify(card?.photos));
ok('...and the photo no part places, after the text', card?.photoStrip?.length === 1 && card.photoStrip[0].uuid === hallRows[1]?.uuid, JSON.stringify(card?.photoStrip));
const w2 = roofsTopic ? await writePartOne(roofsTopic.id) : { prompt: '' };
ok('a by-sight topic with no photo is told not to point at pictures', w2.prompt.includes('NO PICTURES') && !w2.prompt.includes('PHOTOS:'));
const w3 = historyTopic ? await writePartOne(historyTopic.id) : { prompt: '' };
ok('a topic not learned by sight gets the prompt it always had', !!w3.prompt && !w3.prompt.includes('NO PICTURES') && !w3.prompt.includes('PHOTOS:'));

// ---- 7. exports and a bundle round trip ------------------------------------------
section('7. exports carry the credit; a bundle carries the files and brings them back');
const exported = made.id ? await (await fetch(`${base}/api/export/${made.id}`)).json().catch(() => ({})) : {};
const exHall = (exported.nodes || []).find(n => n.title === TOPICS[0].title);
ok('the JSON export carries each example and its credit', exHall?.photos?.length === 2 && exHall.photos[0].author === 'Ann Lee'
    && exHall.photos[0].licence === 'CC BY-SA 4.0' && /commons\.wikimedia\.org/.test(exHall.photos[0].source_url || ''), JSON.stringify(exHall?.photos));
const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const bundleRes = made.id ? await fetch(`${base}/api/export/${made.id}/bundle`) : null;
const bundleBuf = bundleRes?.ok ? Buffer.from(await bundleRes.arrayBuffer()) : null;
const zip = bundleBuf ? await JSZip.loadAsync(bundleBuf) : null;
const manifest = zip ? JSON.parse(await zip.file('manifest.json').async('string')) : {};
const bHall = (manifest.nodes || []).find(n => n.title === TOPICS[0].title);
const bName = bHall?.photos?.[0]?.media;
ok('the bundle names each photo\'s file', !!bName && bHall.photos[0].author === 'Ann Lee', JSON.stringify(bHall?.photos));
ok('...and carries it under media/', !!bName && !!zip?.file(`media/${bName}`));
let imported = null;
if (bundleBuf) {
    const form = new FormData();
    form.append('bundle', new Blob([bundleBuf]), 'course.studyvault');
    const r = await fetch(`${base}/api/import/bundle`, { method: 'POST', body: form });
    imported = r.ok ? await r.json() : null;
}
const newProject = db.prepare(`SELECT id FROM projects WHERE name = ? AND id != ? ORDER BY id DESC LIMIT 1`).get('Telling East Asian buildings apart', made.id ?? -1);
const newTopics = topicsOf(newProject?.id);
const backRows = newTopics[0] ? photoRows(newTopics[0].id) : [];
ok('the imported course has its photos back, with their credit', backRows.length === 2 && backRows.every(r => r.status === 'found')
    && backRows[0].hash === hall.hash && backRows[0].author === 'Ann Lee' && backRows[0].licence === 'CC BY-SA 4.0', JSON.stringify({ imported: !!imported, rows: backRows.map(r => r.status) }));
ok('...the file in the new course\'s media store', !!newProject && !!db.prepare('SELECT 1 FROM media_files WHERE project_id = ? AND hash = ?').get(newProject.id, hall.hash));
ok('...and the example with no photo keeps its example', newTopics[1] && photoRows(newTopics[1].id).length === 1 && photoRows(newTopics[1].id)[0].status === 'none');

// ---- 8. a busy archive -----------------------------------------------------------
section('8. a 429 is retried once, then the run stops');
archive.requests = [];
archive.busy = 2;
const again = roofsTopic ? await fetch(`${base}/api/nodes/${roofsTopic.id}/photos/find`, { method: 'POST' }) : null;
ok('"look again" on a topic with no photo starts a run', again?.status === 200);
await settle();
ok('the search was asked twice and no more', archive.requests.length === 2, archive.requests.length);
const busyLog = db.prepare(`SELECT event FROM activity_log WHERE event LIKE 'photos.%' ORDER BY id DESC LIMIT 1`).get();
ok('the run is logged as stopped by the archive', busyLog?.event === 'photos.busy', busyLog?.event);
ok('nothing is left waiting', roofsTopic && photoRows(roofsTopic.id).every(r => r.status !== 'pending'));

// ---- 9. the setting off ----------------------------------------------------------
section('9. with the setting off, nothing is asked');
const put = await fetch(`${base}/api/settings/creation_find_photos`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'false' }),
});
ok('the setting is one a client may write', put.status === 200, put.status);
archive.requests = [];
const tasksBefore = tasks.listTasks().filter(x => x.kind === 'find_photos').length;
const off = await create('Telling East Asian buildings apart, off');
await sleep(300);
ok('the course is created', !!off.done);
ok('no request to the archive', archive.requests.length === 0, archive.requests.length);
ok('no photo question to the model', !calls.some(c => c.kind === 'photo_plan' || c.kind === 'photo_choice'));
ok('no photo task', tasks.listTasks().filter(x => x.kind === 'find_photos').length === tasksBefore);
ok('no photo rows', topicsOf(off.id).every(n => photoRows(n.id).length === 0));

// ---- 10. SECURITY.md -------------------------------------------------------------
section('10. SECURITY.md names the new outbound hosts');
const securityMd = readFileSync(SERVER_DIR ? join(SERVER_DIR, '..', 'SECURITY.md') : new URL('../SECURITY.md', import.meta.url), 'utf8');
ok('commons.wikimedia.org', securityMd.includes('commons.wikimedia.org'));
ok('upload.wikimedia.org', securityMd.includes('upload.wikimedia.org'));

await new Promise(r => server.close(r));
await new Promise(r => stub.close(r));
try { db.close(); } catch { }
try { rmSync(scratch, { recursive: true, force: true }); } catch { }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

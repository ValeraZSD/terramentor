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
//  10. SECURITY.md names both hosts;
//  13. a photo past the 4 MB cap is dropped and its stream is not read past
//      the cap, with or without an announced length;
//  14. a run whose task cannot be registered returns instead of throwing
//      into course creation, and leaves nothing pending or marked running;
//  15. a course file's licence link must be a creativecommons.org deed and
//      its source a Commons file page (no other host, port, path, user name
//      or a link over 600 characters);
//  16. Look again on a topic while the course's run goes on is answered
//      "pending" and searched by a run of its own right after;
//  17. an imported photo naming a sound, a GIF or a file over 4 MB is not
//      kept as a photo and carries no credit.
// Along the way: a model the catalogue only LISTS as seeing images is never
// sent a photo by an unattended run; a busy run's task reads failed; a kept
// or imported photo's file carries the course's words as its description.
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
        // The catalogue says the model takes images ('listed'), as OpenRouter's
        // does: enough for a photo the learner sends, not for an unattended run.
        if (/\/models\/.+\/endpoints$/.test(req.url)) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: { architecture: { input_modalities: ['text', 'image'] } } }));
        }
        const body = JSON.parse(raw || '{}');
        const msgs = body.messages || [];
        const system = msgs.find(m => m.role === 'system')?.content || '';
        const user = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n');
        const kind = kindOf(system);
        calls.push({ kind, system, user, image: JSON.stringify(msgs).includes('image_url') });
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
                    { name: 'Hall of Supreme Harmony', search: 'Hall of Supreme Harmony Forbidden City', shows: 'The double-eaved hip roof and the marble terrace.', answer: 'hall of supreme harmony' },
                    { name: 'Daibutsuden https://evil.example/pic.jpg', search: 'Todai-ji Daibutsuden', shows: 'A wooden hall on a huge scale.', answer: 'Temple hall' },
                ] },
                { topic: 2, examples: [
                    { name: 'Bulguksa', search: 'Bulguksa temple', shows: 'The roof lines over the stone terraces.', answer: '  temple   HALL ' },
                    // Listed under topic 1 already.
                    { name: 'The Hall of Supreme Harmony', search: 'Hall of Supreme Harmony Forbidden City', shows: 'Again.', answer: 'Palace hall' },
                ] },
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
            // As the archive answers since Nov 2026: thumbnails on their own
            // host, tagged with campaign parameters.
            thumburl: o.thumb ?? `https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/${enc(title)}/960px-${enc(title)}?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail`,
            thumbwidth: 960, thumbheight: Math.round(960 * h / w), width: w, height: h, mime: o.mime ?? 'image/jpeg', extmetadata: meta,
        }],
    };
};
const HALL = page(2, 'Hall of Supreme Harmony 2019.jpg');
// A file whose thumbnail is still on the upload host, as before Nov 2026.
const TODAIJI = page(1, 'Todaiji Daibutsuden.jpg', { lic: 'CC0', code: 'cc0', artist: '', licUrl: 'https://creativecommons.org/publicdomain/zero/1.0',
    thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Todaiji_Daibutsuden.jpg/960px-Todaiji_Daibutsuden.jpg' });
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
const archive = { requests: [], inflight: 0, maxInflight: 0, foreign: [], busy: 0, oversize: false, streamed: 0, hold: null, later: {} };
const OVERSIZE = 32 * 1024 * 1024;
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
            // `hold` keeps a search waiting, so a run is still going while the
            // gate asks for more; `later` answers a search asked a second time.
            if (archive.hold) await archive.hold;
            const askedBefore = archive.requests.filter(r => r.url.searchParams.get('gsrsearch')?.startsWith(q)).length > 1;
            const pages = (askedBefore && archive.later[q]) || ARCHIVE[q] || [];
            return new Response(JSON.stringify({ batchcomplete: true, query: { pages } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if ((u.hostname === 'upload.wikimedia.org' || u.hostname === 'thumb.wikimedia.org') && archive.oversize) {
            // A photo far past the cap, streamed in 256 KB pieces: on the
            // thumbnail host with its length announced, on the upload host
            // without one. `streamed` counts what the app pulled.
            const piece = Buffer.alloc(256 * 1024, 7);
            let sent = 0;
            const body = new ReadableStream({
                pull(c) {
                    if (sent >= OVERSIZE) return c.close();
                    sent += piece.length;
                    archive.streamed += piece.length;
                    c.enqueue(new Uint8Array(piece));
                },
            });
            const headers = { 'content-type': 'image/jpeg' };
            if (u.hostname === 'thumb.wikimedia.org') headers['content-length'] = String(OVERSIZE);
            return new Response(body, { status: 200, headers });
        }
        if (u.hostname === 'upload.wikimedia.org' || u.hostname === 'thumb.wikimedia.org') {
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
const ASSUMED = 'No machine-readable author provided. <a href="//commons.wikimedia.org/wiki/User:Kev">Kev Lyfellow</a> assumed (based on copyright claims).';
const assumed = photos?.candidateOf(page(1, 'm.jpg', { artist: ASSUMED }));
ok('the archive\'s note around an assumed uploader is cut: the credit is the name', assumed?.author === 'Kev Lyfellow', JSON.stringify(assumed?.author));
ok('...and the note alone is no author: CC BY with only it is dropped', !!photos
    && !kept(page(1, 'n.jpg', { lic: 'CC BY 2.0', code: 'cc-by-2.0', artist: 'No machine-readable author provided.' })));

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
ok('no photo is sent to a model the catalogue only lists as seeing images (an unattended run)', calls.length > 0 && !calls.some(c => c.image),
    JSON.stringify(calls.filter(c => c.image).map(c => c.kind)));
const choice = calls.find(c => c.kind === 'photo_choice');
ok('the picker sees only the candidates that passed the filter', !!choice && choice.user.includes('Hall of Supreme Harmony 2019') && !/Taihedian (NC|plan|no author|elsewhere|GFDL|small)/.test(choice.user), choice?.user);
ok('...by number, with no address in its prompt', !!choice && !/https?:\/\//.test(choice.user));
const plan = calls.find(c => c.kind === 'photo_plan');
ok('the plan asks what the learner names each example by, in the same words across the course', !!plan && plan.system.includes('"answer": "..."')
    && /SAME words for every example of that kind anywhere in the course/.test(plan.system) && /Never a topic's whole title/.test(plan.system));
ok('...and keeps each example under its own topic, once', !!plan && /never a third added to reach a count/.test(plan.system)
    && /listed under one topic only, never under two/.test(plan.system));
ok('...each answer one of the things the goal tells apart, never a feature they share', !!plan
    && /every answer is one of those things, in every topic, never a feature they share/.test(plan.system));
ok('...and names artworks the free archive can hold: out of copyright', !!plan && /artwork must be out of copyright, by an artist who died more than 70 years ago/.test(plan.system));

const api = archive.requests.filter(r => r.url.hostname === 'commons.wikimedia.org');
const downloads = archive.requests.filter(r => r.url.hostname === 'upload.wikimedia.org' || r.url.hostname === 'thumb.wikimedia.org');
ok('the photos came from both file hosts the archive uses', downloads.some(r => r.url.hostname === 'thumb.wikimedia.org')
    && downloads.some(r => r.url.hostname === 'upload.wikimedia.org'), JSON.stringify(downloads.map(r => r.url.hostname)));
ok('a download carries none of the archive\'s campaign tags', downloads.length > 0 && downloads.every(r => ![...r.url.searchParams.keys()].some(k => /^utm_/i.test(k))),
    JSON.stringify(downloads.map(r => r.url.search)));
ok(`three searches, one per example (got ${api.length})`, api.length === 3);
ok('every request names the app and a contact address in its User-Agent',
    archive.requests.length > 0 && archive.requests.every(r => /^Terramentor\/\S+ \(https:\/\/\S+[;)]/.test(r.ua)), archive.requests[0]?.ua);
ok('...and nothing about the learner or the course', archive.requests.length > 0 && archive.requests.every(r => !/East Asian|buildings|Chinese|Korean|@/i.test(r.ua)));
ok('every search asks for the 960 px thumbnail, with maxlag', api.length > 0 && api.every(r => r.url.searchParams.get('iiurlwidth') === '960' && r.url.searchParams.get('maxlag') === '5'));
ok('every search is a file search for bitmaps', api.length > 0 && api.every(r => r.url.searchParams.get('gsrnamespace') === '6' && /filetype:bitmap$/.test(r.url.searchParams.get('gsrsearch') || '')));
ok('one request at a time', archive.maxInflight === 1, `max in flight ${archive.maxInflight}`);
ok('only the archive\'s own hosts were asked, never an address a model wrote', archive.requests.length > 0 && archive.foreign.length === 0 && archive.requests.every(r => /^(commons|upload|thumb)\.wikimedia\.org$/.test(r.url.hostname)), JSON.stringify(archive.foreign));
ok('a redirect is checked against those hosts', archive.requests.length > 0 && archive.requests.every(r => r.redirectChecked));
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
ok('each example keeps what the learner names it by', hallRows[0]?.answer === 'Hall of Supreme Harmony' && hallRows[1]?.answer === 'Temple hall',
    JSON.stringify(hallRows.map(r => r.answer)));
ok('...an answer that is the example\'s own name takes the name\'s spelling', hallRows[0]?.answer === 'Hall of Supreme Harmony', JSON.stringify(hallRows[0]?.answer));
ok('...in one spelling across the course: the first one written', roofRows[0]?.answer === 'Temple hall', JSON.stringify(roofRows[0]?.answer));
ok('an example the plan lists under a second topic is kept under the first only', roofRows.length === 1 && roofRows[0]?.subject === 'Bulguksa',
    JSON.stringify(roofRows.map(r => r.subject)));
ok('the model that named the examples is recorded',hallRows.length > 0 && hallRows.every(r => /stub-model/.test(r.generated_by || '')));
const media = hall.hash ? db.prepare('SELECT * FROM media_files WHERE hash = ? AND project_id = ?').get(hall.hash, made.id) : null;
ok('the file is in the library\'s media store, for this course', !!media && media.mime === 'image/jpeg' && media.kind === 'image');
ok('...described in the course\'s words, so it reads aloud and is not queued as undescribed',
    media?.description === 'Hall of Supreme Harmony. The double-eaved hip roof and the marble terrace.' && media?.described_by === 'author', media && `${media.description} / ${media.described_by}`);
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
// The run's own end makes a card per kept photo (server/photoCards.js), with no startup pass in between.
const cardCols = db.prepare("SELECT name FROM pragma_table_info('flashcards')").all().map(c => c.name);
const runCards = cardCols.includes('photo_uuid') && hallsTopic
    ? db.prepare('SELECT photo_uuid, back FROM flashcards WHERE node_id = ? AND photo_uuid IS NOT NULL').all(hallsTopic.id) : [];
ok('each photo the run kept has its card when the run ends, its back what the photo is named by', runCards.length === hallRows.length && hallRows.length > 0
    && hallRows.every(r => runCards.some(c => c.photo_uuid === r.uuid && c.back === r.answer)) && runCards.map(c => c.back).join() === 'Hall of Supreme Harmony,Temple hall',
    JSON.stringify(runCards));

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
const backMedia = newProject ? db.prepare('SELECT description, described_by FROM media_files WHERE project_id = ? AND hash = ?').get(newProject.id, hall.hash) : null;
ok('...described in the course\'s words there too', backMedia?.description === 'Hall of Supreme Harmony. The double-eaved hip roof and the marble terrace.'
    && backMedia?.described_by === 'author', JSON.stringify(backMedia));
ok('...and the example with no photo keeps its example', newTopics[1] && photoRows(newTopics[1].id).length === 1 && photoRows(newTopics[1].id)[0].status === 'none');
ok('a course file carries what each photo is named by, and brings it back', exHall?.photos?.[0]?.answer === 'Hall of Supreme Harmony'
    && bHall?.photos?.[1]?.answer === 'Temple hall' && backRows.map(r => r.answer).join() === 'Hall of Supreme Harmony,Temple hall'
    && newTopics[1] && photoRows(newTopics[1].id)[0]?.answer === 'Temple hall', JSON.stringify({ ex: exHall?.photos?.map(p => p.answer), back: backRows.map(r => r.answer) }));

// ---- 8. a busy archive -----------------------------------------------------------
section('8. a 429 is retried once, then the run stops');
archive.requests = [];
archive.busy = 2;
const again = roofsTopic ? await fetch(`${base}/api/nodes/${roofsTopic.id}/photos/find`, { method: 'POST' }) : null;
ok('"look again" on a topic with no photo starts a run', again?.status === 200);
const againBody = again?.ok ? await again.json() : null;
ok('...and its answer already says pending, so the screen keeps checking', againBody?.state === 'pending', againBody?.state);
await settle();
ok('the search was asked twice and no more', archive.requests.length === 2, archive.requests.length);
const busyLog = db.prepare(`SELECT event FROM activity_log WHERE event LIKE 'photos.%' ORDER BY id DESC LIMIT 1`).get();
ok('the run is logged as stopped by the archive', busyLog?.event === 'photos.busy', busyLog?.event);
const busyTask = photoTask();
ok('...and its task says it failed, not finished', busyTask?.status === 'error' && /slow down/.test(busyTask?.error || ''),
    JSON.stringify(busyTask && { status: busyTask.status, error: busyTask.error }));
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
ok('thumb.wikimedia.org', securityMd.includes('thumb.wikimedia.org'));

// ---- 11. the screen reads the markers the server writes --------------------------
section('11. the lesson card finds each placed photo; other renderers drop the line');
const srcRoot = SERVER_DIR ? join(SERVER_DIR, '..', 'src') : new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
let markers = null;
try {
    const esbuild = require('esbuild');
    const out = join(scratch, 'photoMarkers.mjs');
    await esbuild.build({ entryPoints: [join(srcRoot, 'utils/photoMarkers.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
    markers = await import(pathToFileURL(out).href);
} catch { markers = null; }
const twoPhotos = [{ uuid: '11111111-2222-4333-8444-555555555555' }, { uuid: '66666666-7777-4888-9999-000000000000' }];
const written = photos?.placePhotoMarkers
    ? photos.placePhotoMarkers('Look at the roof.\n[[photo:2]]\nNow the hall. [[photo:1]] And its eaves.', twoPhotos).text
    : '';
const segs = markers?.photoSegments ? markers.photoSegments(written) : [];
ok('each placed photo comes back as its own segment, in the order written', segs.length > 0
    && JSON.stringify(segs.filter(s => 'photo' in s).map(s => s.photo)) === JSON.stringify([twoPhotos[1].uuid, twoPhotos[0].uuid]), JSON.stringify(segs));
ok('no segment of text still carries a marker', segs.length > 0 && segs.every(s => !('text' in s) || !s.text.includes('[[photo:')));
const stripped = markers?.stripPhotoMarkers ? markers.stripPhotoMarkers(written) : written;
ok('any other renderer drops the marker lines and keeps the words', written.length > 0 && !stripped.includes('[[photo:')
    && stripped.includes('Look at the roof.') && stripped.includes('And its eaves.'), JSON.stringify(stripped));

// ---- 12. the task says where its result lands ------------------------------------
section('12. the photo task names its course');
const appRun = tasks.listTasks().find(x => x.kind === 'find_photos' && x.origin?.surface === 'app');
ok('a run started by course creation carries the course in its origin', !!appRun && appRun.origin?.job === 'find_photos'
    && Number.isInteger(appRun.origin?.projectId), JSON.stringify(appRun?.origin));

// ---- 13. a photo past the size cap ----------------------------------------------
section('13. a photo past the size cap is dropped, and never read whole');
setSetting.run('creation_find_photos', 'true');
archive.requests = [];
archive.oversize = true;
archive.streamed = 0;
const big = await create('Telling East Asian buildings apart, big');
const bigTask = await settle();
archive.oversize = false;
const [bigHalls] = topicsOf(big.id);
const bigDownloads = archive.requests.filter(r => r.url.hostname === 'upload.wikimedia.org' || r.url.hostname === 'thumb.wikimedia.org');
ok('the run went on to download both photos', bigTask?.status === 'done' && bigDownloads.length === 2, JSON.stringify({ status: bigTask?.status, downloads: bigDownloads.length }));
ok('neither is kept: the topic has no photo and the course no file', !!bigHalls && photoRows(bigHalls.id).length === 2
    && photoRows(bigHalls.id).every(r => r.status === 'none' && !r.hash)
    && !db.prepare('SELECT 1 FROM media_files WHERE project_id = ?').get(big.id ?? -1), JSON.stringify(bigHalls && photoRows(bigHalls.id).map(r => r.status)));
ok(`the app stopped reading at the cap (pulled ${(archive.streamed / 1048576).toFixed(1)} MB of two ${OVERSIZE / 1048576} MB photos)`,
    archive.streamed > 0 && archive.streamed <= 6 * 1024 * 1024, archive.streamed);

// ---- 14. starting a run never throws into its caller ----------------------------
section('14. a run that cannot be registered fails quietly and leaves nothing stuck');
let threw = null, refused = null;
try {
    refused = photos?.startPhotos(big.id, { nodeIds: bigHalls ? [bigHalls.id] : [], origin: { get surface() { throw new Error('the task list broke'); } } });
} catch (err) { threw = err; }
ok('startPhotos returns instead of throwing (course creation calls it)', !threw && refused?.started === false && refused?.reason === 'failed',
    threw ? threw.message : JSON.stringify(refused));
ok('...and logs the failure as facts, not text', db.prepare(`SELECT detail FROM activity_log WHERE event = 'photos.failed' ORDER BY id DESC LIMIT 1`).get()?.detail?.includes('the task list broke') === false);
ok('...and no topic was left pending', !!bigHalls && photoRows(bigHalls.id).every(r => r.status === 'none'));
const retry = bigHalls ? await fetch(`${base}/api/nodes/${bigHalls.id}/photos/find`, { method: 'POST' }) : null;
const retryBody = retry?.ok ? await retry.json() : null;
ok('the course is not left marked as running: Look again starts a run', retryBody?.started === true, JSON.stringify(retryBody));
await settle();

// ---- 15. a course file's links ---------------------------------------------------
section('15. an imported photo keeps only a licence deed and an archive file page');
const schema = await import(`${B}curriculumSchema.js`);
const goodPhoto = {
    subject: 'Hall', media: 'hall.jpg', licence: 'CC BY-SA 4.0', author: 'Ann Lee',
    licence_url: 'https://creativecommons.org/licenses/by-sa/4.0', source_url: 'https://commons.wikimedia.org/wiki/File:Hall.jpg',
};
const importOne = (p) => {
    try { return schema.normalizeImportTree([{ title: 'T', photos: [p] }]).nodes[0].photos[0]; } catch (err) { return { error: err.message }; }
};
const keptImport = importOne(goodPhoto);
ok('a photo with both links on their hosts is kept, links as written', keptImport?.media === 'hall.jpg'
    && keptImport.credit?.licence_url === goodPhoto.licence_url && keptImport.credit?.source_url === goodPhoto.source_url, JSON.stringify(keptImport));
for (const [label, url] of [
    ['on another host', 'https://evil.example/wiki/File:Hall.jpg'],
    ['on the archive outside its file pages', 'https://commons.wikimedia.org/w/index.php?title=Special:Upload'],
    ['on another port', 'https://commons.wikimedia.org:8443/wiki/File:Hall.jpg'],
    ['carrying a user name', 'https://u:p@commons.wikimedia.org/wiki/File:Hall.jpg'],
    ['over 600 characters', `https://commons.wikimedia.org/wiki/File:${'a'.repeat(700)}.jpg`],
]) {
    const p = importOne({ ...goodPhoto, source_url: url });
    ok(`a source page ${label} loses the photo, keeps the example`, p?.subject === 'Hall' && p.media === null && p.credit === null, JSON.stringify(p));
}
for (const [label, url] of [
    ['on another host', 'https://evil.example/licenses/by-sa/4.0'],
    ['on another port', 'https://creativecommons.org:8443/licenses/by-sa/4.0'],
]) {
    const p = importOne({ ...goodPhoto, licence_url: url });
    ok(`a licence link ${label} is dropped, the photo kept`, p?.media === 'hall.jpg' && p.credit?.licence_url === null, JSON.stringify(p?.credit));
}

// ---- 16. Look again while the course's run goes on ------------------------------
section('16. Look again while the course\'s run goes on is searched right after it');
const until = async (check, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = check(); if (v) return v; await sleep(25); }
    return check();
};
let release = () => { };
archive.requests = [];
// The temple's search finds nothing while the course is created, and a free
// photo when it is asked again.
archive.later['Bulguksa temple'] = [page(9, 'Bulguksa free.jpg', { lic: 'CC0', code: 'cc0', artist: 'Kim Min' })];
const busyCourse = await create('Telling East Asian buildings apart, busy');
await settle();
const [busyHalls, busyRoofs] = topicsOf(busyCourse.id);
ok('the temple topic starts with no photo', !!busyRoofs && photoRows(busyRoofs.id).every(r => r.status === 'none'));
// A run for the halls that waits at its first search...
if (busyHalls && hasTable) db.prepare(`UPDATE node_photos SET status = 'none', hash = NULL WHERE node_id = ?`).run(busyHalls.id);
const templeAsks = () => archive.requests.filter(r => r.url.searchParams.get('gsrsearch')?.startsWith('Bulguksa temple')).length;
const templeAtCreation = templeAsks();
const askedSoFar = archive.requests.length;
archive.hold = new Promise(r => { release = r; });
const hallsRes = busyHalls ? await fetch(`${base}/api/nodes/${busyHalls.id}/photos/find`, { method: 'POST' }) : null;
const hallsRun = hallsRes?.ok ? await hallsRes.json() : null;
await until(() => archive.requests.length > askedSoFar, hallsRun?.started ? 15_000 : 0);
// ...and Look again on the temple while it waits.
const asked = busyRoofs ? await fetch(`${base}/api/nodes/${busyRoofs.id}/photos/find`, { method: 'POST' }) : null;
const askedBody = asked?.ok ? await asked.json() : null;
ok('the topic is taken while the run goes on, and its answer says pending', hallsRun?.started === true
    && askedBody?.started === true && askedBody?.state === 'pending', JSON.stringify({ hallsRun, askedBody }));
const tasksAtAsk = tasks.listTasks().filter(x => x.kind === 'find_photos').length;
release();
archive.hold = null;
const foundAfter = await until(() => busyRoofs && photoRows(busyRoofs.id).some(r => r.status === 'found') && photoRows(busyRoofs.id));
const templeSearches = templeAsks();
ok('the topic is searched again after the run, and its photo found', !!foundAfter && templeAtCreation === 1 && templeSearches === 2
    && foundAfter[0].status === 'found' && foundAfter[0].author === 'Kim Min', JSON.stringify({ templeSearches, rows: busyRoofs && photoRows(busyRoofs.id).map(r => r.status) }));
const followUp = tasks.listTasks().filter(x => x.kind === 'find_photos').at(-1);
ok('...by a run of its own, started from the topic', tasks.listTasks().filter(x => x.kind === 'find_photos').length === tasksAtAsk + 1
    && followUp?.origin?.surface === 'topic' && followUp.origin.nodeId === busyRoofs?.id, JSON.stringify(followUp?.origin));
await settle();
ok('nothing is left waiting in the course', topicsOf(busyCourse.id).every(n => photoRows(n.id).every(r => r.status !== 'pending')));
archive.later = {};

// ---- 18. one picture once per course --------------------------------------------
section('18. a picture the course already keeps under one topic is not kept under another');
// Look again on the temple topic of the first course, whose search now offers
// only the palace hall's file: a free photo, but the palace topic holds it.
archive.later['Bulguksa temple'] = [HALL];
const againRes = roofsTopic ? await fetch(`${base}/api/nodes/${roofsTopic.id}/photos/find`, { method: 'POST' }) : null;
await settle();
const againRows = roofsTopic ? photoRows(roofsTopic.id) : [];
const madeHashes = topicsOf(made.id).flatMap(n => photoRows(n.id)).map(r => r.hash).filter(Boolean);
ok('the temple topic stays without a photo rather than repeat the palace hall', againRes?.ok && againRows.length === 1
    && againRows[0].status === 'none' && !againRows[0].hash, JSON.stringify({ s: againRes?.status, rows: againRows.map(r => r.status) }));
ok('...so no picture sits twice in the course', madeHashes.length > 0 && new Set(madeHashes).size === madeHashes.length, madeHashes.length);
archive.later = {};

// ---- 17. a course file naming a file the app does not keep as a photo ------------
section('17. an imported photo naming a sound, a GIF or an oversize file loses the photo');
let oddImport = null;
if (zip && bHall?.photos?.length === 2) {
    const odd = await JSZip.loadAsync(bundleBuf);
    const m = JSON.parse(await odd.file('manifest.json').async('string'));
    const hallNode = (m.nodes || []).find(n => n.title === TOPICS[0].title);
    const credit = { ...hallNode.photos[0] };
    hallNode.photos = [
        { ...credit, media: 'clip.mp3' },
        { ...credit, media: 'moving.gif' },
        { ...credit, media: 'huge.jpg' },
    ];
    odd.file('manifest.json', JSON.stringify(m));
    odd.file('media/clip.mp3', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000, 1)]));
    odd.file('media/moving.gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(2000, 2)]));
    odd.file('media/huge.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5 * 1024 * 1024, 3)]));
    const form = new FormData();
    form.append('bundle', new Blob([await odd.generateAsync({ type: 'nodebuffer' })]), 'odd.studyvault');
    const r = await fetch(`${base}/api/import/bundle`, { method: 'POST', body: form });
    oddImport = r.ok ? await r.json() : { status: r.status, body: await r.text() };
}
const oddProject = db.prepare('SELECT id FROM projects ORDER BY id DESC LIMIT 1').get();
const oddRows = oddProject ? photoRows(topicsOf(oddProject.id)[0]?.id ?? -1) : [];
ok('the course is imported with its three examples', oddRows.length === 3, JSON.stringify({ oddImport, rows: oddRows.length }));
ok('...none of them kept as a photo, and no credit carried', oddRows.length === 3 && oddRows.every(r => r.status === 'none' && !r.hash && !r.author),
    JSON.stringify(oddRows.map(r => ({ s: r.status, h: !!r.hash }))));

await new Promise(r => server.close(r));
await new Promise(r => stub.close(r));
try { db.close(); } catch { }
try { rmSync(scratch, { recursive: true, force: true }); } catch { }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

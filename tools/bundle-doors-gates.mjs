// tools/bundle-doors-gates.mjs — a .studyvault works at EVERY door.
//
// Run:  node tools/bundle-doors-gates.mjs
//
// Import and export must be one question whichever screen you stand at:
// Settings, the project card's Export and the Vault tab all take and give a
// .studyvault — the one format that carries a card's pictures and audio. This
// asserts that shape:
//
//   * one project out as a .studyvault and back in is the same course — topics,
//     questions, cards, the media files themselves (by content hash), links, and
//     the vault's documents;
//   * private notes are opt-in on the bundle door and the JSON door alike, and
//     resources are a switch on the bundle;
//   * a whole-library .studyvault (a zip of per-project bundles, which earlier
//     builds exported) still comes in through the single import door, each
//     project equal to its original, and its export route stays gone;
//   * a library is told apart by what the archive holds, a bad entry costs that
//     project and nothing else, and an entry the manifest does not name, or
//     names with a path, is never opened;
//   * a SOURCE SCAN that no screen calls the JSON export or a file picker's
//     import without the bundle beside it, and that Settings no longer writes
//     private notes without being asked.
//
// No model calls. The real server on a loopback port over a scratch library,
// env set IN-PROCESS, with a guard that it is serving the fixture.

import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'bundle-doors-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
// A port the system hands out: a random one can land in a range Windows reserves,
// and the server then dies with EACCES before the first case (seen on a CI runner).
process.env.PORT = String(await new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
}));
process.env.HOST = '127.0.0.1';
delete process.env.AI_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.AI_BASE_URL;

const ROOT = new URL('../', import.meta.url);
const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
const { default: JSZip } = await import('jszip');
const { serverReady } = await import(B + 'index.js');
const ready = await serverReady;
const { request } = await import(ready.proto === 'https' ? 'node:https' : 'node:http');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const same = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const raw = (path, init = {}) => new Promise((resolve, reject) => {
    const req = request({
        host: '127.0.0.1', port: ready.port, path, method: init.method || 'GET',
        headers: init.headers || {}, rejectUnauthorized: false,
    }, (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => {
            const buf = Buffer.concat(parts);
            let body = null;
            try { body = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
            resolve({ status: res.statusCode, buf, body, headers: res.headers });
        });
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
});
const upload = (buf, name = 'x.studyvault') => {
    const boundary = `----gate${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="${name}"\r\nContent-Type: application/zip\r\n\r\n`),
        buf,
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return raw('/api/import/bundle', {
        method: 'POST', body,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
    });
};
const json = (path, method, body) => raw(path, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

const listed = await raw('/api/projects');
check('guard: the server is serving an empty scratch library', Array.isArray(listed.body) && listed.body.length === 0, JSON.stringify(listed.body)?.slice(0, 120));
if (!Array.isArray(listed.body) || listed.body.length) { console.log('\nRefusing to write: the server is not serving the fixture.'); process.exit(1); }

// ---------------------------------------------------------------------------
// The fixture: a course that carries everything a course can, built as a bundle
// by hand and imported through the real door.
const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(300, 1)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 2)]);
const PRIVATE = 'MY-PRIVATE-NOTE-7f3a';
const manifestA = {
    project: { name: 'Doors: media course', content_language: 'nl', new_per_day: 20, color: '#F97316', icon: '🇳🇱', description: 'fixture' },
    nodes: [{
        title: 'Fase 1', description: 'phase', children: [
            {
                title: 'Het lidwoord', description: 'x'.repeat(1300), notes: PRIVATE,
                resources: [{ title: 'A link', url: 'https://example.org/a' }],
                questions: [
                    { question: 'Welk lidwoord hoort bij "krant"?', type: 'multiple_choice', options: ['de', 'het'], correct_answer: 'de', explanation: 'de-woord' },
                    { question: 'Welk lidwoord hoort bij "huis"?', type: 'multiple_choice', options: ['de', 'het'], correct_answer: 'het', explanation: 'het-woord' },
                ],
                flashcards: [
                    { front: 'de krant', back: 'газета' },
                    { front: 'listen', back: 'Het boek.', media: { front: [{ name: 'clip.mp3', kind: 'audio' }] } },
                    { front: 'picture', back: 'plaatje', media: { back: [{ name: 'pic.png' }] } },
                ],
            },
            { title: 'Reading', is_note: true, description: 'a material note' },
        ],
    }, { title: 'Fase 2', children: [{ title: 'Werkwoorden', description: 'verbs', notes: PRIVATE }] }],
    documents: [],
};
const bundleA = new JSZip();
bundleA.file('manifest.json', JSON.stringify(manifestA));
bundleA.file('media/clip.mp3', mp3);
bundleA.file('media/pic.png', png);
const upA = await upload(await bundleA.generateAsync({ type: 'nodebuffer' }), 'a.studyvault');
check('fixture: the media course imports', upA.status === 200, JSON.stringify(upA.body));
const A = upA.body?.id;
same('...reporting 2 questions, 3 cards, 2 media files', [upA.body?.questionCount, upA.body?.cardCount, upA.body?.mediaCount], [2, 3, 2]);
// A vault document on a topic: the bundle carries the extracted text (and, when
// the upload kept one, the original).
const topicA = db.prepare("SELECT id FROM nodes WHERE project_id = ? AND title = 'Het lidwoord'").get(A).id;
const docRes = await json('/api/documents', 'POST', { nodeId: topicA, title: 'Notes doc', content: 'The vault document travels with the course.' });
check('fixture: a vault document on the topic', docRes.status < 300, `${docRes.status}`);
// Progress, so the option has something to carry.
db.prepare("UPDATE nodes SET status = 'completed' WHERE project_id = ? AND title = 'Werkwoorden'").run(A);

const upB = await json('/api/import', 'POST', { project: { name: 'Doors: second project' }, nodes: [{ title: 'Only topic', description: 'hello', notes: PRIVATE, questions: [{ question: 'Q?', type: 'true_false', options: ['True', 'False'], correct_answer: 'True', explanation: 'e' }] }] });
check('fixture: a second, plain project', upB.status === 200, JSON.stringify(upB.body));
const Bid = upB.body?.id;

// What a project IS, compared without the ids that are meant to differ.
// Options are shuffled on the way in (by design, so a key's position tells
// nothing), so a choice question is compared by its SET of options.
const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'uuid' || k === 'exported_at' ? undefined : (k === 'options' && Array.isArray(x) ? [...x].sort() : x))));
const plain = async (id) => strip((await raw(`/api/export/${id}?includeNotes=false&includeResources=true&includeProgress=false`)).body);
const mediaOf = (id) => db.prepare('SELECT hash, filename, mime, kind FROM media_files WHERE project_id = ? ORDER BY filename').all(id);
const docsOf = (id) => db.prepare(`SELECT title, content FROM documents WHERE project_id = ? OR node_id IN (SELECT id FROM nodes WHERE project_id = ?) ORDER BY title`).all(id, id);
const countOf = (id) => ({
    nodes: db.prepare('SELECT COUNT(*) c FROM nodes WHERE project_id = ?').get(id).c,
    questions: db.prepare('SELECT quizzes.questions q FROM quizzes JOIN nodes ON nodes.id = quizzes.node_id WHERE nodes.project_id = ?').all(id).reduce((n, r) => n + JSON.parse(r.q).length, 0),
    cards: db.prepare('SELECT COUNT(*) c FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ?').get(id).c,
    media: mediaOf(id).length,
    docs: docsOf(id).length,
});
const Acount = countOf(A);
same('fixture counts: 5 nodes, 2 questions, 3 cards, 2 media files, 1 document', Acount, { nodes: 5, questions: 2, cards: 3, media: 2, docs: 1 });

const manifestOf = async (buf) => JSON.parse(await (await JSZip.loadAsync(buf)).file('manifest.json').async('string'));
const walk = (nodes, fn) => nodes.forEach(n => { fn(n); walk(n.children || [], fn); });

// ---------------------------------------------------------------------------
console.log('\n--- one project, out as a .studyvault and back in ---');
{
    const out = await raw(`/api/export/${A}/bundle`);
    check('the bundle exports', out.status === 200 && /studyvault/.test(out.headers['content-disposition'] || ''), `${out.status}`);
    const m = await manifestOf(out.buf);
    let sawNotes = false, sawResources = false;
    walk(m.nodes, n => { if (n.notes) sawNotes = true; if (n.resources?.length) sawResources = true; });
    check('private notes are absent by default', !sawNotes);
    check('...and the private text is nowhere in the archive\'s manifest', !JSON.stringify(m).includes(PRIVATE));
    check('resources ride by default', sawResources);
    const zip = await JSZip.loadAsync(out.buf);
    same('the media files ride under media/', Object.keys(zip.files).filter(f => f.startsWith('media/') && !zip.files[f].dir).sort(), ['media/clip.mp3', 'media/pic.png']);

    const withNotes = await manifestOf((await raw(`/api/export/${A}/bundle?includeNotes=true`)).buf);
    let noteTexts = 0;
    walk(withNotes.nodes, n => { if (n.notes === PRIVATE) noteTexts++; });
    check('...and ARE in it when asked', noteTexts === 2, `${noteTexts}`);
    const noRes = await manifestOf((await raw(`/api/export/${A}/bundle?includeResources=false`)).buf);
    let resCount = 0;
    walk(noRes.nodes, n => { resCount += n.resources?.length || 0; });
    check('resources are a switch on the bundle', resCount === 0, `${resCount}`);
    const noProgress = await manifestOf(out.buf);
    let statuses = 0;
    walk(noProgress.nodes, n => { if (n.status) statuses++; });
    check('progress is off by default', statuses === 0, `${statuses}`);

    const back = await upload(out.buf, 'round.studyvault');
    check('the bundle imports', back.status === 200, JSON.stringify(back.body));
    check('...as a single project, not a library', back.body?.library === undefined);
    same('...with every node, question, card, media file and document', countOf(back.body?.id), Acount);
    same('...the media files are the same BYTES (content hash) under the same names',
        mediaOf(back.body?.id).map(m => [m.filename, m.hash, m.mime, m.kind]), mediaOf(A).map(m => [m.filename, m.hash, m.mime, m.kind]));
    const a = await plain(A), b = await plain(back.body?.id);
    same('...and the course reads the same (topics, questions, cards, links)', b, a);
}

// ---------------------------------------------------------------------------
// The app no longer WRITES a library (the export route had no caller and was
// removed), but a library file from an earlier build must still import. So the
// archive is built here the way that route built it: every project's own
// bundle, stored under projects/NNN-<name>.studyvault, beside a library.json.
console.log('\n--- the whole library, as ONE .studyvault (built as earlier builds wrote it) ---');
let libraryBuf;
{
    const gone = await raw('/api/library/export');
    check('the library export route is gone', gone.status === 404, `${gone.status}`);
    const projects = db.prepare('SELECT id, name FROM projects ORDER BY position, id').all();
    const outer = new JSZip();
    const entries = [];
    for (const [i, p] of projects.entries()) {
        const out = await raw(`/api/export/${p.id}/bundle`);
        const file = `projects/${String(i + 1).padStart(3, '0')}-${p.name.replace(/[^\p{L}\p{N}._ -]+/gu, '_')}.studyvault`;
        outer.file(file, out.buf, { compression: 'STORE' });
        entries.push({ file, name: p.name });
    }
    outer.file('library.json', JSON.stringify({ kind: 'terramentor-library', exported_at: new Date().toISOString(), projects: entries }));
    libraryBuf = await outer.generateAsync({ type: 'nodebuffer' });
}

console.log('\n--- ...and the one import door reads it back ---');
{
    const originals = db.prepare('SELECT id, name FROM projects ORDER BY id').all();
    const res = await upload(libraryBuf, 'library.studyvault');
    check('the library imports through the bundle door', res.status === 200, JSON.stringify(res.body)?.slice(0, 300));
    check('...flagged as a library, nothing failed', res.body?.library === true && (res.body?.failed || []).length === 0, JSON.stringify(res.body?.failed));
    same('...one new project per original', res.body?.imported?.length, originals.length);
    const newIds = (res.body?.imported || []).map(p => p.id);
    same('...in the library\'s own order', (res.body?.imported || []).map(p => p.name), originals.map(o => o.name));
    check('...and the project returned is the first of them (what a one-project screen opens)', res.body?.id === newIds[0]);
    for (const [i, o] of originals.entries()) {
        same(`project "${o.name}": same nodes, questions, cards, media, documents`, countOf(newIds[i]), countOf(o.id));
    }
    same('the media files are the same bytes', mediaOf(newIds[0]).map(m => [m.filename, m.hash]), mediaOf(originals[0].id).map(m => [m.filename, m.hash]));
    const a = await plain(originals[0].id), b = await plain(newIds[0]);
    same('a project out of the library reads the same as the one that went in', b, a);
    check('importing a course already held says so, per project', (res.body?.warnings || []).some(w => /already have this course/.test(w)), JSON.stringify(res.body?.warnings));
    check('the per-project notes name their project', (res.body?.warnings || []).every(w => /^"/.test(w)), JSON.stringify(res.body?.warnings));
}

console.log('\n--- a library is judged by what it holds, and bounded ---');
{
    const lib = async (files, manifest) => {
        const z = new JSZip();
        for (const [name, buf] of Object.entries(files)) z.file(name, buf);
        z.file('library.json', typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
        return z.generateAsync({ type: 'nodebuffer' });
    };
    const goodInner = await (async () => {
        const z = new JSZip();
        z.file('manifest.json', JSON.stringify({ project: { name: 'Doors: survivor' }, nodes: [{ title: 'T' }] }));
        return z.generateAsync({ type: 'nodebuffer' });
    })();
    const projectsBefore = () => db.prepare('SELECT COUNT(*) c FROM projects').get().c;
    const kind = 'terramentor-library';

    let n0 = projectsBefore();
    let r = await upload(await lib({ 'projects/001-ok.studyvault': goodInner, 'projects/002-bad.studyvault': Buffer.from('not a zip') }, {
        kind, projects: [{ file: 'projects/001-ok.studyvault', name: 'ok' }, { file: 'projects/002-bad.studyvault', name: 'bad' }],
    }));
    check('one bad entry costs that project and nothing else', r.status === 200 && r.body?.imported?.length === 1 && r.body?.failed?.length === 1 && r.body.failed[0].name === 'bad', JSON.stringify(r.body)?.slice(0, 240));
    check('...the good one is there', projectsBefore() === n0 + 1);
    check('...and the report says which did not come', (r.body?.warnings || []).some(w => /"bad" was not imported/.test(w)), JSON.stringify(r.body?.warnings));

    n0 = projectsBefore();
    r = await upload(await lib({ 'projects/001-bad.studyvault': Buffer.from('nope') }, { kind, projects: [{ file: 'projects/001-bad.studyvault', name: 'bad' }] }));
    check('a library in which nothing imports is a 400 that says why', r.status === 400 && /Nothing in this library/.test(r.body?.error || ''), JSON.stringify(r.body));
    check('...and added nothing', projectsBefore() === n0);

    r = await upload(await lib({ 'projects/001-ok.studyvault': goodInner }, { kind, projects: [{ file: '../../etc/passwd', name: 'x' }] }));
    check('an entry named with a path is refused, nothing opened', r.status === 400 && /not a project bundle/.test(r.body?.error || ''), JSON.stringify(r.body));
    r = await upload(await lib({ 'projects/001-ok.studyvault': goodInner }, { kind, projects: [{ file: 'projects/sub/001-ok.studyvault', name: 'x' }] }));
    check('...and so is a nested one', r.status === 400, JSON.stringify(r.body));

    n0 = projectsBefore();
    r = await upload(await lib({ 'projects/001-ok.studyvault': goodInner, 'projects/999-unlisted.studyvault': goodInner }, { kind, projects: [{ file: 'projects/001-ok.studyvault', name: 'ok' }] }));
    check('a file the manifest does not name is never read', r.status === 200 && projectsBefore() === n0 + 1, JSON.stringify(r.body)?.slice(0, 200));

    for (const [label, text] of [['null', 'null'], ['an array', '[]'], ['another kind', '{"kind":"something","projects":[]}'], ['projects not a list', `{"kind":"${kind}","projects":5}`], ['not JSON', '{oops']]) {
        r = await upload(await lib({}, text));
        check(`library.json holding ${label} is a 400`, r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
    }
    r = await upload(await lib({}, { kind, projects: [] }));
    check('a library that lists nothing is a 400', r.status === 400 && /lists no projects/.test(r.body?.error || ''), JSON.stringify(r.body));

    // An archive with neither marker is still a refusal that names the manifest.
    const neither = new JSZip(); neither.file('readme.txt', 'hi');
    r = await upload(await neither.generateAsync({ type: 'nodebuffer' }));
    check('an archive that is neither a bundle nor a library is refused', r.status === 400 && /manifest\.json/.test(r.body?.error || ''), JSON.stringify(r.body));
}

console.log('\n--- the other doors: JSON export opt-in, and library with nothing to export ---');
{
    const jsonDefault = (await raw(`/api/export/${A}`)).body;
    check('the JSON export leaves private notes out by default', !JSON.stringify(jsonDefault).includes(PRIVATE));
    const jsonOpt = (await raw(`/api/export/${A}?includeNotes=true`)).body;
    check('...and includes them when asked', JSON.stringify(jsonOpt).includes(PRIVATE));
    const missing = await raw('/api/export/99999/bundle');
    check('a bundle for a project that does not exist is a 404', missing.status === 404, `${missing.status}`);
    // /api/export/library must not be read as a project id.
    const shadow = await raw('/api/export/library');
    check('"library" is never mistaken for a project id on the JSON route', shadow.status === 404, `${shadow.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n--- no screen offers one door without the other (source scan) ---');
{
    const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
    const walkDir = (dir) => readdirSync(new URL(dir, ROOT)).flatMap((f) => {
        const rel = `${dir}${f}`;
        return statSync(new URL(rel, ROOT)).isDirectory() ? walkDir(`${rel}/`) : [rel];
    });
    const srcFiles = walkDir('src/').filter((f) => /\.(tsx?|jsx?)$/.test(f));
    const offenders = (re, allow) => srcFiles.filter((f) => re.test(read(f)) && !allow.some((a) => f.endsWith(a)));

    // A screen that writes a JSON export by itself has chosen a format for the
    // learner. The one writer is utils/projectFiles.ts, which offers both.
    const jsonExporters = offenders(/api\.exportProject\(/, ['src/utils/projectFiles.ts']);
    check('no screen calls the JSON export directly (it goes through projectFiles.ts, beside the bundle)', jsonExporters.length === 0, jsonExporters.join(', '));
    const files = read('src/utils/projectFiles.ts');
    check('projectFiles.ts writes both formats', /api\.exportBundle\(/.test(files) && /api\.exportProject\(/.test(files));
    check('...and reads both', /api\.importBundle\(/.test(files) && /api\.importProject\(/.test(files));
    check('every file picker for a course takes .studyvault as well as .json', /IMPORT_ACCEPT = '\.json,\.studyvault'/.test(files));

    // Every screen that imports a project from a FILE reaches the bundle door.
    const importers = offenders(/api\.importProject\(/, ['src/utils/projectFiles.ts']);
    const withoutBundle = importers.filter((f) => !/importBundle\(|importProjectFile\(/.test(read(f)));
    // ExternalAuthoring takes a chat model's reply pasted into a box: text, not a file.
    const pasted = withoutBundle.filter((f) => !f.endsWith('ExternalAuthoring.tsx'));
    check('no file import is JSON-only (the one exception takes pasted text, not a file)', pasted.length === 0, pasted.join(', '));

    const data = read('src/components/settings/DataSettings.tsx');
    check('Settings → Data imports through projectFiles (both formats)', /importProjectFile\(/.test(data));
    check('Settings → Data exports through the ONE export dialog, not its own copy', /<ExportProjectModal/.test(data) && !/exportProjectToFile\(/.test(data));
    check('Settings no longer writes private notes without being asked', !/includeNotes:\s*true/.test(data));
    const modal = read('src/components/ExportProjectModal.tsx');
    check('the export dialog offers the format choice and writes through projectFiles', /exportProjectToFile\(/.test(modal) && /SegmentedControl/.test(modal));
    check('...with private notes off by default', /useState\(false\)/.test(modal.slice(modal.indexOf('includeNotes'), modal.indexOf('includeNotes') + 120)) || /\[includeNotes, setIncludeNotes\] = useState\(false\)/.test(modal));
    const zone = read('src/components/ProjectImportZone.tsx');
    check('the Projects import zone still takes .studyvault', /IMPORT_ACCEPT = '[^']*\.studyvault/.test(zone));

    // Server side: one bundle parser, one bundle builder (server/routes/bundle.js).
    const index = read('server/routes/bundle.js');
    const fromImport = index.indexOf('async function importBundleZip(');
    const importBody = index.slice(fromImport, index.indexOf('\napp.', fromImport));
    check('one bundle importer, reading every entry through the bounded reader', fromImport > 0 && importBody.includes('readZipEntry(') && !/\.async\('(nodebuffer|string)'\)/.test(importBody));
    const fromLib = index.indexOf('async function importLibraryZip(');
    const libBody = index.slice(fromLib, index.indexOf('\napp.', fromLib));
    check('the library reader hands each entry to that importer and reads through the bounded reader', libBody.includes('importBundleZip(') && libBody.includes('readZipEntry(') && !/\.async\('(nodebuffer|string)'\)/.test(libBody));
    check('the library reader shares ONE inflate budget across projects', /spent/.test(libBody) && /LIBRARY_INFLATE_LIMIT/.test(libBody));
    check('the bundle export goes through buildBundleZip', /buildBundleZip\(req\.params\.projectId/.test(index));
}

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* the server may hold it */ }
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);

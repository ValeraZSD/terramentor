// tools/soft-delete-gates.mjs — a deleted row stays in the library and is
// never shown; Restore brings back exactly what went with it.
//
// Run:  node tools/soft-delete-gates.mjs
//
// Two copies of one library can only agree on a delete if the delete is a row
// they can both see. So the five content tables (projects, nodes, resources,
// flashcards, quizzes) keep a deleted row, marked by `deleted_at`, and every
// read skips it. The cost is that a read which forgets to skip it shows a
// deleted topic again. This asserts:
//
//   * the read filter: no SQL in server/ reads one of the five tables
//     directly. A read goes through its `live_<table>` view, or says on the
//     same line that it means deleted rows too (`/* with deleted */`). Only
//     server/database.js (the migrations) and server/softDelete.js (the one
//     module that writes and reads deleted rows) are exempt; no other module
//     deletes a row of the five outright. The scan reads table NAMES: a table
//     named through a value (`FROM ${t}`) is out of its sight. Those reads
//     today (uuid claims, the course-update undo snapshot, sync backfills,
//     blob holders) mean deleted rows too; the HTTP crawl below covers what
//     a route returns either way;
//   * the schema: both columns on all five tables, the five views, and the
//     schedule-event log;
//   * the app: a course, a topic, a card, a question bank and a link deleted
//     through the HTTP API stay in their tables, keep their history, and their
//     text appears in the answer of NO GET route of the app, asked with live
//     ids or with the deleted ones;
//   * "Recently deleted" lists what the learner deleted (not what went with it,
//     not what the app replaced); Restore brings back exactly the rows that
//     went with the restored row, never one deleted on its own before;
//     removing one listed row (the route the Anki import's undo uses) and
//     "Empty" remove the rows for good, Empty only up to the newest row the
//     learner was shown;
//   * every card schedule change that is not a review (a report parking a
//     card, the edit that unparks it, a schedule written directly, a rating
//     taken back) is written to `schedule_events`.
//
// No model calls, no network. Scratch database and vault, set IN-PROCESS
// before anything is imported.

import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) pass++; else fail++;
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
};

// ============================================================================
console.log('--- the read filter: every read of the five tables skips deleted rows ---');

export const CONTENT_TABLES = ['projects', 'nodes', 'resources', 'flashcards', 'quizzes'];
// A file attached to a course or topic has no mark of its own: it is deleted
// while its course or topic is, so its reads go through `live_documents` too.
// Removing a file outright stays an ordinary delete.
const READ_FILTERED = [...CONTENT_TABLES, 'documents'];
const T = READ_FILTERED.join('|');
// The modules allowed to name the tables directly: the migrations, and the one
// module whose job is the deleted rows.
const EXEMPT = new Set(['server/database.js', 'server/softDelete.js']);
const WITH_DELETED = '/* with deleted */';

function jsFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (!['node_modules', 'vault', 'logs', 'browser-profile', 'views'].includes(name)) out.push(...jsFiles(p));
        } else if (name.endsWith('.js')) out.push(p);
    }
    return out;
}

/** Each line of `src` that reads or deletes one of the five tables without the filter. */
export function unfilteredIn(src) {
    const reads = [], deletes = [];
    src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;          // a comment line names tables in prose
        // A quoted or schema-qualified name ("projects", main.nodes) is the same table.
        const re = new RegExp(`\\b(DELETE\\s+FROM|FROM|JOIN)\\s+(?:main\\.)?["\`\\[]?(${T})\\b(?!\\s*\\()`, 'g');
        let m;
        while ((m = re.exec(line))) {
            if (/^DELETE/.test(m[1])) { if (CONTENT_TABLES.includes(m[2])) deletes.push(`${i + 1}: ${line.trim()}`); }
            else if (!line.includes(WITH_DELETED)) reads.push(`${i + 1}: ${line.trim()}`);
        }
    });
    return { reads, deletes };
}

const scanned = [...jsFiles(join(repoRoot, 'server')), ...jsFiles(join(repoRoot, 'mcp'))]
    .map(p => relative(repoRoot, p).replace(/\\/g, '/'))
    .filter(f => !EXEMPT.has(f));
const unfilteredReads = [], hardDeletes = [];
for (const f of scanned) {
    const { reads, deletes } = unfilteredIn(readFileSync(join(repoRoot, f), 'utf8'));
    unfilteredReads.push(...reads.map(r => `${f}:${r}`));
    hardDeletes.push(...deletes.map(r => `${f}:${r}`));
}
console.log(`        scanned ${scanned.length} modules; ${unfilteredReads.length} unfiltered read(s), ${hardDeletes.length} hard delete(s)`);
ok('no read of a content table in server/ or mcp/ goes past the live_ views', unfilteredReads.length === 0,
    unfilteredReads.slice(0, 12).join('\n        ') + (unfilteredReads.length > 12 ? `\n        … and ${unfilteredReads.length - 12} more` : ''));
ok('no module but softDelete.js deletes a content row outright', hardDeletes.length === 0, hardDeletes.slice(0, 12).join('\n        '));
{
    // The controls: the scan finds what it is meant to find, and nothing else.
    const bad = unfilteredIn([
        "db.prepare('SELECT * FROM nodes WHERE id = ?')",
        '    JOIN flashcards f ON f.node_id = n.id',
        "db.prepare('DELETE FROM quizzes WHERE id = ?')",
        'db.prepare(\'SELECT * FROM "projects" WHERE id = ?\')',
        "db.prepare('SELECT * FROM main.resources')",
        '    JOIN documents d ON d.id = dc.document_id',
    ].join('\n'));
    ok('control: a bare, a quoted and a qualified read, two bare joins and a hard delete are each reported', bad.reads.length === 5 && bad.deletes.length === 1,
        JSON.stringify(bad));
    const good = unfilteredIn([
        "db.prepare('SELECT * FROM live_nodes WHERE id = ?')",
        "db.prepare('SELECT 1 FROM projects WHERE uuid = ? /* with deleted */')",
        '// Read FROM nodes in prose.',
        "db.prepare('SELECT * FROM nodes_fts WHERE nodes_fts MATCH ?')",
        "db.prepare('INSERT INTO nodes (title) VALUES (?)')",
        'FOREIGN KEY (node_id) REFERENCES nodes(id)',
        "db.prepare('SELECT d.title FROM documents_fts fts JOIN live_documents d ON d.id = fts.rowid')",
        "db.prepare('DELETE FROM documents WHERE id = ?')",
    ].join('\n'));
    ok('control: a view, a marked read, prose, another table, a write, a key and a file delete are not', good.reads.length === 0 && good.deletes.length === 0,
        JSON.stringify(good));
}

// ============================================================================
// Everything below needs the build's own modules; on a build without them the
// first import fails, and that is a failure of this gate, not a crash.
const scratch = mkdtempSync(join(tmpdir(), 'soft-delete-gates-'));
process.env.DATA_DIR = scratch;
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
// No model and no search: any outbound call goes to a port nothing listens on.
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.AI_MODEL = 'none';
process.env.AI_API_KEY = 'none';
delete process.env.TERRAMENTOR_DESKTOP;

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');
let SD = null;
try { SD = await import(B + 'softDelete.js'); } catch (e) { ok('server/softDelete.js loads', false, e.message); }

// ============================================================================
console.log('\n--- the schema ---');
const cols = (t) => db.prepare(`SELECT name FROM pragma_table_info(?)`).pluck().all(t);
ok('every content table has deleted_at and deleted_by',
    CONTENT_TABLES.every(t => cols(t).includes('deleted_at') && cols(t).includes('deleted_by')),
    CONTENT_TABLES.filter(t => !cols(t).includes('deleted_at') || !cols(t).includes('deleted_by')).join(', '));
const views = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").pluck().all();
ok('every content table, and documents, has its live_ view', READ_FILTERED.every(t => views.includes(`live_${t}`)),
    READ_FILTERED.filter(t => !views.includes(`live_${t}`)).join(', '));
ok('the schedule-event log exists', cols('schedule_events').length > 0);

if (!SD || fail > 0 && !views.includes('live_nodes')) {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
}

// ============================================================================
console.log('\n--- deleting through the app ---');
const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
set.run('ai_enabled', 'false');
set.run('embedding_enabled', 'false');
set.run('ai_ollama_url', 'http://127.0.0.1:9');
set.run('creation_find_resources', 'false');
set.run('ui_language', 'en');

const GHOST = 'zqghost';          // in the text of every row that gets deleted
const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);
const project = (name) => ins('INSERT INTO projects (name, description) VALUES (?, ?)', name, `${name} description`);
const node = (p, parent, title) => ins('INSERT INTO nodes (project_id, parent_id, title, description) VALUES (?, ?, ?, ?)', p, parent, title, `${title} body`);
const card = (n, front, by = null) => ins(`INSERT INTO flashcards (node_id, front, back, next_review, generated_by) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ?)`, n, front, `${front} back`, by);
const quiz = (n, title) => ins('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)', n, title,
    JSON.stringify([{ type: 'mcq', question: `${title} question`, options: ['a', 'b'], answer: 0 }]));
const link = (n, title) => ins("INSERT INTO resources (node_id, title, url) VALUES (?, ?, 'https://example.org/')", n, title);
const review = (c) => ins(`INSERT INTO review_log (card_id, rating, reviewed_at, source) VALUES (?, 3, '2026-01-02T00:00:00.000Z', 'app')`, c);
// A file with one searchable chunk, attached to a course or to a topic.
const file = (p, n, title) => {
    const d = ins("INSERT INTO documents (project_id, node_id, title, content, status) VALUES (?, ?, ?, ?, 'ready')", p, n, title, `${title} text`);
    ins('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, 0, ?)', d, `${title} text`);
    return d;
};

// The course that stays, with one of everything deleted inside it.
const keep = project('Keep course');
const kPhase = node(keep, null, 'Keep phase');
const kTopic = node(keep, kPhase, 'Keep topic');
const kCard = card(kTopic, 'Keep card');
const kQuiz = quiz(kTopic, 'Keep bank');
link(kTopic, 'Keep link');
const gTopic = node(keep, kPhase, `${GHOST} topic`);
const gTopicCard = card(gTopic, `${GHOST} topic card`);
const gTopicFile = file(keep, gTopic, `${GHOST} topic file`);
file(keep, kTopic, 'Keep file');
const gCard = card(kTopic, `${GHOST} card`);
review(gCard);
const gQuiz = quiz(kTopic, `${GHOST} bank`);
const gLink = link(kTopic, `${GHOST} link`);
// The course that goes, with a topic deleted on its own BEFORE the course.
const ghost = project(`${GHOST} course`);
const gPhase = node(ghost, null, `${GHOST} phase`);
const gLeaf = node(ghost, gPhase, `${GHOST} leaf`);
const gLeafCard = card(gLeaf, `${GHOST} leaf card`);
review(gLeafCard);
quiz(gLeaf, `${GHOST} leaf bank`);
link(gLeaf, `${GHOST} leaf link`);
const gAlone = node(ghost, gPhase, `${GHOST} alone`);
card(gAlone, `${GHOST} alone card`);
const gCourseFile = file(ghost, null, `${GHOST} course file`);
file(ghost, gLeaf, `${GHOST} leaf file`);

const { createApp } = await import(B + 'app.js');
const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
async function call(method, path, body, ms = 8000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
        const res = await fetch(base + path, {
            method, signal: ac.signal,
            headers: body ? { 'content-type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { }
        return { status: res.status, text, json };
    } catch (e) {
        return { status: 0, text: '', json: null, error: e.name };
    } finally { clearTimeout(timer); }
}

const raw = (t, id) => db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id);
const counts = () => Object.fromEntries(CONTENT_TABLES.map(t => [t, db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get()]));
const before = counts();

const r1 = await call('DELETE', `/api/nodes/${gAlone}`);
const r2 = await call('DELETE', `/api/projects/${ghost}`);
const r3 = await call('DELETE', `/api/nodes/${gTopic}`);
const r4 = await call('DELETE', `/api/ai/flashcards/${gCard}`);
const r5 = await call('DELETE', `/api/ai/quizzes/${gQuiz}`);
const r6 = await call('DELETE', `/api/resources/${gLink}`);
ok('each delete answers 200', [r1, r2, r3, r4, r5, r6].every(r => r.status === 200), [r1, r2, r3, r4, r5, r6].map(r => r.status).join(' '));
ok('…and no row left its table', JSON.stringify(counts()) === JSON.stringify(before), `${JSON.stringify(before)} -> ${JSON.stringify(counts())}`);
ok('the deleted rows are marked deleted', [['projects', ghost], ['nodes', gTopic], ['flashcards', gCard], ['quizzes', gQuiz], ['resources', gLink], ['nodes', gLeaf], ['flashcards', gLeafCard]]
    .every(([t, id]) => raw(t, id)?.deleted_at));
ok('a row deleted with its parent names that parent', raw('nodes', gLeaf)?.deleted_by === `projects:${raw('projects', ghost).uuid}`
    && raw('flashcards', gTopicCard)?.deleted_by === `nodes:${raw('nodes', gTopic).uuid}`, `${raw('nodes', gLeaf)?.deleted_by}`);
ok('a row deleted on its own, before its course, keeps its own mark', raw('nodes', gAlone)?.deleted_by === null && !!raw('nodes', gAlone)?.deleted_at);
ok('the reviews of a deleted card are kept', db.prepare('SELECT COUNT(*) FROM review_log WHERE card_id IN (?, ?)').pluck().get(gCard, gLeafCard) === 2);
ok('a second delete of a deleted row is a 404', (await call('DELETE', `/api/projects/${ghost}`)).status === 404);

// ============================================================================
console.log('\n--- no GET route of the app shows a deleted row ---');
const stackOf = (a) => (a.router ?? a._router).stack;
const routesOf = (stack) => stack.flatMap((layer) => {
    if (layer.route) return Object.keys(layer.route.methods).map((m) => ({ method: m, path: layer.route.path }));
    return Array.isArray(layer.handle?.stack) ? routesOf(layer.handle.stack) : [];
});
const gets = [...new Set(routesOf(stackOf(createApp())).filter(r => r.method === 'get' && typeof r.path === 'string'
    && r.path.startsWith('/api/')).map(r => r.path))];
// Routes that hold a stream open or start work no gate should start.
// And Recently deleted itself, whose answer IS the deleted rows (asserted below).
const SKIP = /\/(events|stream|watch)\b|\/tasks\/[^/]+\/stream|\/updates?\b|\/ollama|\/models\b|^\/api\/deleted\b/;
// A bare `:id` is named by the path segment before it (/projects/:id is a
// course, /flashcards/:id a card); a named one by its own name.
const BY_SEGMENT = { projects: 'project', nodes: 'node', flashcards: 'card', cards: 'card', quizzes: 'quiz', resources: 'link', documents: 'doc' };
const fill = (path, ids) => path.replace(/([^/]*)\/:(\w+)\??/g, (m, seg, p) => `${seg}/${idFor(seg, p, ids)}`);
const idFor = (seg, p, ids) => {
    const k = p.toLowerCase();
    if (k === 'id' && BY_SEGMENT[seg]) return ids[BY_SEGMENT[seg]];
    if (/project/.test(k)) return ids.project;
    if (/card|flashcard/.test(k)) return ids.card;
    if (/quiz/.test(k)) return ids.quiz;
    if (/resource|link/.test(k)) return ids.link;
    if (k === 'uuid') return ids.uuid;
    return ids.node;
};
const keepFile = db.prepare("SELECT id FROM documents WHERE title = 'Keep file'").pluck().get();
const liveIds = { project: keep, node: kTopic, card: kCard, quiz: kQuiz, link: 1, doc: keepFile, uuid: raw('nodes', kTopic).uuid };
const deadIds = { project: ghost, node: gTopic, card: gCard, quiz: gQuiz, link: gLink, doc: gCourseFile, uuid: raw('nodes', gTopic).uuid };
const shows = [], timedOut = [], liveShows = [];
let asked = 0;
// The searches, asked for the deleted rows' own words (a file of a deleted
// course or topic is found by its text, not by an id).
for (const url of [`/api/search?q=${GHOST}`, `/api/search/suggest?q=${GHOST}`, `/api/search?q=${GHOST}&projectId=${ghost}`,
    `/api/documents/${gTopicFile}/text`]) {
    const r = await call('GET', url, null, 5000);
    asked++;
    if (r.text.includes(GHOST)) shows.push(`${url} (${r.status})`);
}
ok('control: search finds a live file by its text', (await call('GET', '/api/search?q=Keep')).text.includes('Keep file'));
// A Sources line naming a file: its answer echoes the entry, so the test is
// whether a file is found for it.
const cited = async (title) => (await call('GET', `/api/documents/cited?entry=${encodeURIComponent(title)}`)).json?.[0]?.id ?? null;
ok('a Sources line naming a deleted course\'s or topic\'s file opens nothing',
    await cited(`${GHOST} course file`) === null && await cited(`${GHOST} topic file`) === null);
ok('control: …and one naming a live file opens it', await cited('Keep file') === keepFile);
{
    const all = await call('GET', '/api/documents');
    ok('the file list shows the live file and none of a deleted course or topic',
        all.text.includes('Keep file') && !all.text.includes(GHOST), all.text.slice(0, 300));
}
for (const path of gets) {
    if (SKIP.test(path)) continue;
    for (const ids of [liveIds, deadIds]) {
        const url = fill(path, ids) + (path.includes('?') ? '' : `?projectId=${ids.project}&nodeId=${ids.node}`);
        const r = await call('GET', url, null, 5000);
        asked++;
        if (r.status === 0) timedOut.push(url);
        else if (r.text.includes(GHOST)) shows.push(`${url} (${r.status})`);
        if (ids === liveIds && /Keep (course|topic)/.test(r.text)) liveShows.push(path);
    }
}
console.log(`        asked ${asked} GET requests over ${gets.length} routes; ${timedOut.length} held open past 5 s`);
ok('no answer holds the text of a deleted row', shows.length === 0, shows.slice(0, 15).join('\n        '));
// The control: the same crawl, asked with the live ids, finds the live rows'
// text, on the course's own routes among others.
ok('control: the same crawl finds a live row by its text',
    liveShows.length >= 10 && liveShows.includes('/api/projects/:id') && liveShows.includes('/api/projects/:projectId/flashcards'),
    `${liveShows.length} routes: ${liveShows.slice(0, 12).join(' ')}`);
ok('a deleted course by its id is a 404', (await call('GET', `/api/projects/${ghost}`)).status === 404);

// ============================================================================
console.log('\n--- Recently deleted, Restore, Delete forever ---');
const bin = await call('GET', '/api/deleted');
const listed = (bin.json?.items || []).map(i => `${i.table}:${i.id}`).sort();
ok('lists what the learner deleted and nothing that went with it',
    JSON.stringify(listed) === JSON.stringify([`flashcards:${gCard}`, `nodes:${gTopic}`, `projects:${ghost}`, `quizzes:${gQuiz}`, `resources:${gLink}`].sort()),
    JSON.stringify(listed));
ok('…each with its title and when', (bin.json?.items || []).every(i => i.title && i.deletedAt));
const rs = await call('POST', `/api/deleted/projects/${ghost}/restore`);
ok('restoring the course answers 200', rs.status === 200, rs.text.slice(0, 200));
ok('…and brings back the course and every row that went with it',
    !raw('projects', ghost).deleted_at && !raw('nodes', gLeaf).deleted_at && !raw('flashcards', gLeafCard).deleted_at && !raw('nodes', gPhase).deleted_at);
ok('…but not the topic deleted on its own before it', !!raw('nodes', gAlone).deleted_at);
ok('…which is now listed itself, its course being back',
    ((await call('GET', '/api/deleted')).json?.items || []).some(i => i.table === 'nodes' && i.id === gAlone));
ok('…and the restored course is in the projects list again', (await call('GET', '/api/projects')).text.includes(`${GHOST} course`));
const rt = await call('POST', `/api/deleted/nodes/${gTopic}/restore`);
ok('restoring a topic brings back its card', rt.status === 200 && !raw('nodes', gTopic).deleted_at && !raw('flashcards', gTopicCard).deleted_at);
ok('restoring a row that is not deleted is a 404', (await call('POST', `/api/deleted/nodes/${kTopic}/restore`)).status === 404);
ok('a table that has no bin is a 400', (await call('POST', `/api/deleted/settings/1/restore`)).status === 400);

const gone = await call('DELETE', `/api/deleted/flashcards/${gCard}`);
ok('Delete forever removes the row and its history', gone.status === 200 && !raw('flashcards', gCard)
    && db.prepare('SELECT COUNT(*) FROM review_log WHERE card_id = ?').pluck().get(gCard) === 0);
ok('Delete forever refuses a row that is not deleted', (await call('DELETE', `/api/deleted/flashcards/${kCard}`)).status === 404 && !!raw('flashcards', kCard));
await call('DELETE', `/api/projects/${ghost}`);
ok('Delete forever refuses a row taken along with its course', (await call('DELETE', `/api/deleted/nodes/${gLeaf}`)).status === 404 && !!raw('nodes', gLeaf));
const under = await call('POST', `/api/deleted/nodes/${gAlone}/restore`);
ok('restoring a row whose course is deleted is a 409 naming why', under.status === 409 && under.json?.code === 'parent_deleted' && !!raw('nodes', gAlone).deleted_at,
    `${under.status} ${under.text.slice(0, 120)}`);
// Empty takes only what the learner was shown: a row deleted after the list's
// newest stays.
const shownUpTo = (await call('GET', '/api/deleted')).json?.items?.[0]?.deletedAt;
const late = card(kTopic, 'Deleted after the list was shown');
db.prepare("UPDATE flashcards SET deleted_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(late);
ok('Empty refuses an upTo that is not a time', (await call('DELETE', '/api/deleted?upTo=yesterday')).status === 400 && !!raw('projects', ghost));
const emptied = await call('DELETE', `/api/deleted?upTo=${encodeURIComponent(shownUpTo)}`);
ok('…and leaves a row deleted after the newest it was shown', !!raw('flashcards', late));
SD.purge('flashcards', late);
ok('Empty removes every deleted row, with what went with it', emptied.status === 200 && !raw('projects', ghost) && !raw('nodes', gLeaf)
    && !raw('nodes', gAlone) && !raw('quizzes', gQuiz) && !raw('resources', gLink),
    emptied.text.slice(0, 200));
ok('…and leaves every live row', !!raw('projects', keep) && !!raw('nodes', kTopic) && !!raw('flashcards', kCard) && !!raw('quizzes', kQuiz));
ok('…and the bin is empty', ((await call('GET', '/api/deleted')).json?.items || []).length === 0);

// ============================================================================
console.log('\n--- what the app removes is deleted softly too, and not listed ---');
const mCard = card(kTopic, `${GHOST} model card`, 'stub-model');
const rep = await call('POST', '/api/item-reports', { ref: `card:${mCard}`, reason: 'wrong', note: null, surface: 'review' });
ok('reporting a model-written card takes it away', rep.status === 201 && !!raw('flashcards', mCard)?.deleted_at, rep.text.slice(0, 200));
ok('…as the app, so it is not offered in Recently deleted', raw('flashcards', mCard)?.deleted_by === 'app'
    && !((await call('GET', '/api/deleted')).json?.items || []).some(i => i.id === mCard));
await call('DELETE', '/api/deleted');
ok('…and Empty leaves it, so the report can still be undone', !!raw('flashcards', mCard));
const undoRep = await call('DELETE', `/api/item-reports/${rep.json?.report?.id}`);
ok('undoing the report brings the same card back', undoRep.status === 200 && raw('flashcards', mCard) && !raw('flashcards', mCard).deleted_at);

// ============================================================================
console.log('\n--- schedule changes that are not reviews are logged ---');
const events = (c) => db.prepare('SELECT kind FROM schedule_events WHERE card_id = ? ORDER BY id').pluck().all(c);
const own = card(kTopic, 'Own card');
await call('POST', '/api/item-reports', { ref: `card:${own}`, reason: 'wrong', note: null, surface: 'review' });
ok('a report parking the learner\'s own card is an event', events(own).includes('park'), JSON.stringify(events(own)));
await call('PUT', `/api/ai/flashcards/${own}`, { front: 'Own card, fixed' });
ok('…the edit that unparks it is one', events(own).includes('unpark'), JSON.stringify(events(own)));
const free = card(kTopic, 'Free card');
await call('PUT', `/api/ai/flashcards/${free}`, { next_review: '2027-01-01T00:00:00.000Z', state: 2, stability: 30 });
ok('a schedule written with no rating is an event, with what it set',
    events(free).includes('set') && JSON.parse(db.prepare("SELECT schedule FROM schedule_events WHERE card_id = ? AND kind = 'set'").pluck().get(free) || '{}').next_review === '2027-01-01T00:00:00.000Z');
const stamp = '2026-06-01T10:00:00.000Z';
await call('PUT', `/api/ai/flashcards/${free}`, { rating: 3, last_reviewed: stamp, next_review: '2027-02-01T00:00:00.000Z', state: 2, stability: 40 });
ok('a rating is NOT an event (the review log holds it)', events(free).filter(k => k !== 'set').length === 0, JSON.stringify(events(free)));
const reviewUuid = db.prepare('SELECT uuid FROM review_log WHERE card_id = ? ORDER BY id DESC').pluck().get(free);
await call('PUT', `/api/ai/flashcards/${free}`, { undo_review: true, undo_of: stamp, last_reviewed: null, next_review: '2027-01-01T00:00:00.000Z', state: 2, stability: 30 });
ok('a rating taken back is an event naming the review',
    events(free).includes('undo') && db.prepare("SELECT review_uuid FROM schedule_events WHERE card_id = ? AND kind = 'undo'").pluck().get(free) === reviewUuid);
ok('every event has a uuid and a time', db.prepare('SELECT COUNT(*) FROM schedule_events WHERE uuid IS NULL OR created_at IS NULL').pluck().get() === 0);

// ============================================================================
console.log('\n--- nothing new goes under a deleted row ---');
{
    const refused = (fn) => { try { fn(); return false; } catch (e) { return /was deleted/.test(e.message); } };
    const lateCourse = project('Late course');
    const deadTopic = node(lateCourse, null, 'Late topic');
    SD.softDelete('projects', lateCourse);
    const dead = deadTopic;
    ok('a card, a bank or a link written under a deleted topic is refused',
        refused(() => card(dead, 'Late card')) && refused(() => quiz(dead, 'Late bank')) && refused(() => link(dead, 'Late link')));
    ok('a topic written into a deleted course, or under a deleted topic, is refused',
        refused(() => node(lateCourse, null, 'Late sibling'))
        && refused(() => node(keep, dead, 'Late subtopic')));
    ok('control: a card under a live topic is written', !refused(() => card(kTopic, 'On time card')));
    const before = db.prepare('SELECT COUNT(*) FROM flashcards WHERE node_id = ? /* with deleted */').pluck().get(dead);
    ins("INSERT INTO flashcards (node_id, front, back, deleted_at, deleted_by) VALUES (?, 'Arrives deleted', 'x', '2026-01-03T00:00:00.000Z', 'app')", dead);
    ok('a row that arrives already deleted is allowed', db.prepare('SELECT COUNT(*) FROM flashcards WHERE node_id = ? /* with deleted */').pluck().get(dead) === before + 1);
}

// ============================================================================
console.log('\n--- a delete or a restore reaches what is worked out from the rows ---');
{
    // Topic dates are laid from the live topics: a deleted topic frees its
    // days for the others, and its restore takes them back.
    const { topicDatesOf } = await import(B + 'topicDates.js');
    const day = '2026-03-02';
    const at = { today: day, timeZone: 'UTC' };
    const windowed = ins('INSERT INTO projects (name, start_date, deadline, study_days) VALUES (?, ?, ?, ?)',
        'Window course', day, '2026-03-11', JSON.stringify([1, 2, 3, 4, 5, 6, 7]));
    const wPhase = node(windowed, null, 'Window phase');
    const first = node(windowed, wPhase, 'Window first');
    const second = node(windowed, wPhase, 'Window second');
    db.prepare('UPDATE nodes SET position = id WHERE project_id = ?').run(windowed);
    const laid = topicDatesOf(windowed, at).get(second)?.start;
    SD.softDelete('nodes', first);
    const without = topicDatesOf(windowed, at).get(second)?.start;
    SD.restore('nodes', first);
    const back = topicDatesOf(windowed, at).get(second)?.start;
    ok('deleting a topic re-lays the others\' dates, and its restore lays them back',
        laid > day && without === day && back === laid, `${laid} -> ${without} -> ${back}`);
    const deck = ins("INSERT INTO projects (name, kind, start_date, deadline, study_days) VALUES (?, 'deck', ?, ?, ?)",
        'Window deck', day, '2026-03-11', JSON.stringify([1, 2, 3, 4, 5, 6, 7]));
    const dTopic = node(deck, null, 'Window deck topic');
    const dCard = card(dTopic, 'Window deck card');
    const inCards = topicDatesOf(deck, at).size;
    SD.softDelete('flashcards', dCard);
    const byTopics = topicDatesOf(deck, at).size;
    SD.restore('flashcards', dCard);
    ok('deleting a deck\'s last card re-lays it by topics, and its restore by cards',
        inCards === 0 && byTopics > 0 && topicDatesOf(deck, at).size === 0, `${inCards} -> ${byTopics} -> ${topicDatesOf(deck, at).size}`);

    // A course file's uuid names the course: importing the file again after
    // the course was deleted gives the new copy that uuid, and the deleted one
    // a fresh uuid that still names everything deleted with it.
    const { claimUuid } = await import(B + 'courseFiles.js');
    const old = project('Old copy');
    const oldTopic = node(old, null, 'Old copy topic');
    const fileUuid = raw('projects', old).uuid;
    const PROJECT_DIAL = 'deck_new_per_day_';
    const dial = PROJECT_DIAL + fileUuid;
    set.run(dial, '7');
    ok('control: a live course keeps its uuid from an import', claimUuid('projects', fileUuid) === null && raw('projects', old).uuid === fileUuid);
    SD.softDelete('projects', old);
    ok('…a deleted one gives it up to the import', claimUuid('projects', fileUuid) === fileUuid && raw('projects', old).uuid !== fileUuid);
    const renamed = raw('projects', old).uuid;
    ok('…and what went with it, and its dials, follow its new uuid',
        raw('nodes', oldTopic).deleted_by === `projects:${renamed}`
        && db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(PROJECT_DIAL + renamed) === '7'
        && !db.prepare('SELECT 1 FROM settings WHERE key = ?').get(dial));
    SD.restore('projects', old);
    ok('…so its restore still brings them back', !raw('nodes', oldTopic).deleted_at);
    const loneCard = card(kTopic, 'Card deleted inside a live course');
    const loneUuid = raw('flashcards', loneCard).uuid;
    SD.softDelete('flashcards', loneCard);
    ok('a row deleted inside a live course keeps its uuid from an import', claimUuid('flashcards', loneUuid) === null && raw('flashcards', loneCard).uuid === loneUuid);

    // An Anki deck imported again after the deck was deleted: the review
    // history goes to the new cards. A card deleted inside a live deck keeps
    // its reviews, for its own restore.
    const { importAnkiRevlog } = await import(B + 'reviewLog.js');
    const holder = (id) => db.prepare("SELECT card_id FROM review_log WHERE source = 'anki' AND external_id = ?").pluck().get(String(id));
    const revlog = [{ cid: 1, id: 1_700_000_000_000, ease: 3, type: 1, lastIvl: 1 }];
    const ankiDeck = project('Anki deck');
    const ankiTopic = node(ankiDeck, null, 'Anki deck topic');
    const ankiOld = card(ankiTopic, 'Anki card, first import');
    importAnkiRevlog(revlog, () => ankiOld);
    const ankiNew = card(kTopic, 'Anki card, second import');
    const live = importAnkiRevlog(revlog, () => ankiNew);
    ok('control: a review already on a live card is not imported twice', live.imported === 0 && holder(revlog[0].id) === ankiOld);
    SD.softDelete('flashcards', ankiOld);
    const alone = importAnkiRevlog(revlog, () => ankiNew);
    ok('a review on a card deleted inside a live deck stays with it', alone.imported === 0 && holder(revlog[0].id) === ankiOld, JSON.stringify(alone));
    SD.restore('flashcards', ankiOld);
    SD.softDelete('projects', ankiDeck);
    const again = importAnkiRevlog(revlog, () => ankiNew);
    ok('a review on a card whose deck is deleted moves to the card imported again', again.imported === 1 && holder(revlog[0].id) === ankiNew, JSON.stringify(again));
}

// ============================================================================
console.log('\n--- the operator\'s tool on a library from before soft delete ---');
{
    // hostedCli opens the file raw, without the migrations: a library no newer
    // build has opened yet has no live_ views.
    const dir = mkdtempSync(join(tmpdir(), 'soft-delete-cli-'));
    const oldDb = join(dir, 'old.db');
    const Database = createRequire(join(repoRoot, 'package.json'))('better-sqlite3');
    const o = new Database(oldDb);
    o.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO projects (name) VALUES ('a'), ('b');");
    o.close();
    const env = { ...process.env, DB_PATH: oldDb, VAULT_ROOT: join(dir, 'vault') };
    const cli = (...args) => spawnSync(process.execPath, [join(repoRoot, 'server', 'hostedCli.js'), ...args], { cwd: repoRoot, env, encoding: 'utf8', timeout: 60_000 });
    const backup = cli('backup', join(dir, 'b1'));
    ok('a backup of it succeeds and counts its courses', backup.status === 0 && /backup ok: 2 project/.test(backup.stdout), `${backup.status} ${backup.stdout} ${backup.stderr}`);
    const restored = cli('restore', join(dir, 'b1'));
    ok('…and so does a restore of that backup', restored.status === 0, `${restored.status} ${restored.stdout} ${restored.stderr}`);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

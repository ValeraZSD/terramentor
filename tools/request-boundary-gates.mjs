// tools/request-boundary-gates.mjs — what the REAL routes do with a request
// that is well-formed JSON and wrong.
//
// Run:  node tools/request-boundary-gates.mjs
//
// The real server on a loopback port, against a scratch library (DB_PATH and
// VAULT_ROOT set in-process, a guard that the server is serving the fixture
// before anything is written). Each block is a request that used to do damage
// without raising an error:
//
//   - a deadline in the year 99999 was stored, and every later read walked to
//     it a day at a time with the server blocked (~37 s);
//   - a rating sent twice (a retried request) was counted twice, in the card's
//     review_count and in the log the FSRS optimiser fits on;
//   - an upload to a project that does not exist was never answered;
//   - the provider key followed a changed base URL to whatever host it named;
//   - a node was created under a parent in ANOTHER project (deleting that
//     parent then took the node with it) or under its own predicted id;
//   - a node's note flag, position and weight were stored as sent ("yes",
//     "abc", Infinity), and a boolean note flag was a 500;
//   - a bundle whose manifest.json was `null` was never answered;
//   - a review whose log insert failed still changed the card;
//   - a retried rating arriving after a newer one was applied again, and an
//     undo sent after another device had rated erased that newer review.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'request-boundary-gates-'));
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
// The env key would be the operator's; this suite is about the saved one.
delete process.env.AI_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.AI_BASE_URL;

const B = new URL('../server/', import.meta.url).href;
const { default: db } = await import(B + 'database.js');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const pid = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Fixture: boundaries')`).run().lastInsertRowid);
const topic = Number(db.prepare(`INSERT INTO nodes (project_id, title) VALUES (?, 'Topic')`).run(pid).lastInsertRowid);
const cardId = Number(db.prepare(`INSERT INTO flashcards (node_id, front, back) VALUES (?, 'front', 'back')`).run(topic).lastInsertRowid);

const { serverReady } = await import(B + 'index.js');
const ready = await serverReady;
const { request } = await import(ready.proto === 'https' ? 'node:https' : 'node:http');
const api = (path, init = {}) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = request({
        host: '127.0.0.1', port: ready.port, path, method: init.method || 'GET',
        headers: init.headers || { 'Content-Type': 'application/json' },
        rejectUnauthorized: false,
        timeout: init.timeout || 10_000,
    }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
            let body = null;
            try { body = JSON.parse(text); } catch { /* not JSON */ }
            resolve({ status: res.statusCode, body, ms: Date.now() - t0 });
        });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout', body: null, ms: Date.now() - t0 }); });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
});
const json = (method, body) => ({ method, body: JSON.stringify(body) });

const listed = await api('/api/projects');
const names = Array.isArray(listed.body) ? listed.body.map(p => p.name) : [];
check('guard: the server is serving the scratch library and nothing else', JSON.stringify(names) === '["Fixture: boundaries"]', JSON.stringify(names));
if (JSON.stringify(names) !== '["Fixture: boundaries"]') {
    console.log('\nRefusing to write: the server is not serving the fixture.');
    process.exit(1);
}

console.log('\n--- a schedule window ---');
let r = await api(`/api/projects/${pid}`, json('PUT', { deadline: '99999-01-01' }));
check('PUT refuses a five-digit year', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
r = await api(`/api/projects/${pid}`, json('PUT', { deadline: '2026-02-30' }));
check('PUT refuses a day that does not exist', r.status === 400);
r = await api(`/api/projects/${pid}`, json('PUT', { start_date: '2026-01-01', deadline: '2199-12-31' }));
check('PUT refuses a window past twenty years', r.status === 400 && /20 years/.test(r.body?.error || ''));
r = await api(`/api/projects/${pid}`, json('PUT', { start_date: '2026-01-01', deadline: '2026-06-30' }));
check('PUT keeps a sane window', r.status === 200 && r.body?.deadline === '2026-06-30');
r = await api(`/api/projects/${pid}`, json('PUT', { deadline: null }));
check('PUT still clears a deadline', r.status === 200 && r.body?.deadline == null);
r = await api(`/api/projects/${pid}/schedule`, json('POST', { startDate: '2026-01-01', deadline: '99999-01-01', studyDays: [1, 2, 3, 4, 5] }));
check('the scheduler refuses the far window, and answers at once', r.status === 400 && r.ms < 2000, `${r.status} in ${r.ms} ms`);
// A row written before the check existed: recalibrate must refuse, not walk it.
db.prepare(`UPDATE projects SET start_date = '2026-01-01', deadline = '99999-01-01' WHERE id = ?`).run(pid);
r = await api(`/api/projects/${pid}/recalibrate`, json('POST', {}));
check('recalibrate on a stored far deadline answers with an error, at once', r.status === 400 && r.ms < 2000, `${r.status} in ${r.ms} ms`);
r = await api('/api/today');
check('the home page is not held up by it either', r.status === 200 && r.ms < 5000, `${r.status} in ${r.ms} ms`);
db.prepare(`UPDATE projects SET start_date = NULL, deadline = NULL WHERE id = ?`).run(pid);

// The edit route checked its search words before writing, then wrote them,
// and only then ran the UPDATE that could still fail: `name: null` answered
// 500 with the course's words already replaced. Every field is checked first
// now, and the words commit with the row.
console.log('\n--- a project edit is checked before anything is written ---');
{
    await api(`/api/projects/${pid}`, json('PUT', { search_words: 'learner words' }));
    const wordsNow = () => db.prepare('SELECT name, search_words FROM projects WHERE id = ?').get(pid);
    r = await api(`/api/projects/${pid}`, json('PUT', { name: null, search_words: 'other words' }));
    check('a null name is refused with a 400, not a 500', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
    check('...and the search words in the same edit are not applied',
        JSON.stringify(wordsNow()) === JSON.stringify({ name: 'Fixture: boundaries', search_words: 'learner words' }), JSON.stringify(wordsNow()));
    for (const name of ['', '   ']) {
        r = await api(`/api/projects/${pid}`, json('PUT', { name }));
        check(`a course renamed to ${JSON.stringify(name)} is refused`, r.status === 400);
    }
    r = await api(`/api/projects/${pid}`, json('PUT', { color: '#'.repeat(100_000) }));
    check('a 100 kB colour is refused', r.status === 400);
    for (const body of [{ color: null }, { icon: null }, { icon: '  ' }]) {
        r = await api(`/api/projects/${pid}`, json('PUT', body));
        check(`${JSON.stringify(body)} is refused, not stored`, r.status === 400
            && db.prepare('SELECT color IS NOT NULL AND icon IS NOT NULL AND trim(icon) <> \'\' ok FROM projects WHERE id = ?').get(pid).ok === 1, `${r.status}`);
    }
    r = await api(`/api/projects/${pid}`, json('PUT', { position: 'top' }));
    check('a position that is not a whole number is refused', r.status === 400);
    r = await api('/api/projects/987654', json('PUT', { name: 'Ghost' }));
    check('an edit of a project that does not exist is a 404, not 200 null', r.status === 404, `${r.status} ${JSON.stringify(r.body)}`);
    r = await api(`/api/projects/${pid}`, json('PUT', { name: 'Fixture: boundaries', color: '#10b981', search_words: 'learner words' }));
    check('a sane edit still saves', r.status === 200 && r.body?.color === '#10b981');
    r = await api('/api/projects', json('POST', { name: '  ' }));
    check('a new course needs a name that is not blank', r.status === 400);
    check('the edit left the library its one fixture project', db.prepare('SELECT COUNT(*) c FROM projects').get().c === 1);
}

// Both owner ids were stored as sent: a topic of one course could be filed
// under another course as well, and both courses' exports shipped it.
console.log('\n--- a document belongs to one course ---');
{
    const other = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Fixture: other')`).run().lastInsertRowid);
    const doc = (body) => api('/api/documents', json('POST', { title: 'Doc', content: 'Some text.', ...body }));
    r = await doc({ projectId: other, nodeId: topic });
    check('a topic of one course with another course\'s id is refused', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
    r = await doc({ projectId: 987654 });
    check('a missing project is a 404, not a foreign-key 500', r.status === 404);
    r = await doc({ nodeId: 987654 });
    check('...and so is a missing topic', r.status === 404);
    r = await doc({ projectId: { id: pid } });
    check('an id sent as an object is a 400, not a binding 500', r.status === 400, `${r.status}`);
    r = await doc({ projectId: true });
    check('...and so is one sent as a boolean', r.status === 400, `${r.status}`);
    r = await doc({ projectId: pid, nodeId: topic, title: undefined });
    check('a document needs a title', r.status === 400);
    r = await doc({ projectId: pid, nodeId: topic, content: { text: 'x' } });
    check('...and its text as a string', r.status === 400);
    r = await doc({ projectId: pid, nodeId: topic });
    check('a topic with its own course is accepted, as the vault sends it', r.status === 200 && r.body?.chunks >= 1);
    check('...and filed under that course', db.prepare('SELECT project_id, node_id FROM documents WHERE id = ?').get(r.body?.id)?.project_id === pid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(other);
}

// An imported finished topic keeps the date its file carries, and gets none
// invented: the day's ledger and the days-studied record read `completed_at`,
// so a date stamped at import showed a year of finished topics as done today.
console.log('\n--- an imported finished topic keeps its own date ---');
{
    const when = '2026-03-04T10:00:00.000Z';
    r = await api('/api/import', json('POST', { project: { name: 'Fixture: imported' }, nodes: [
        { title: 'Done', status: 'completed', completed_at: when },
        { title: 'Done, undated', status: 'completed' },
        { title: 'Done in the future', status: 'completed', completed_at: '2999-01-01T00:00:00Z' },
        { title: 'Open', completed_at: when },
        { title: 'Reading', is_note: true, status: 'completed', completed_at: when },
    ] }));
    const imported = r.body?.id;
    const at = (title) => db.prepare('SELECT completed_at c FROM nodes WHERE project_id = ? AND title = ?').get(imported, title)?.c;
    check('the import answers 200', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    check('a finished topic keeps the date its file carries', at('Done') === when, at('Done'));
    check('...one without a date gets none invented', at('Done, undated') == null, at('Done, undated'));
    check('...a date in the future is dropped, with a warning', at('Done in the future') == null
        && r.body?.warnings?.some(w => /completion date/.test(w)), JSON.stringify(r.body?.warnings));
    check('...and an open topic or a note keeps none', at('Open') == null && at('Reading') == null);

    const file = await api(`/api/export/${imported}?includeProgress=true`);
    const done = file.body?.nodes?.find(n => n.title === 'Done');
    check('an export with progress writes the date', done?.completed_at === when, JSON.stringify(done));
    check('...and one without progress does not', !(await api(`/api/export/${imported}`)).body?.nodes?.some(n => n.completed_at));
    r = await api('/api/import', json('POST', file.body));
    check('...so the date survives the round trip', r.status === 200
        && db.prepare('SELECT completed_at c FROM nodes WHERE project_id = ? AND title = ?').get(r.body?.id, 'Done')?.c === when);
    for (const id of [imported, r.body?.id]) if (id) db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// The app could store a blank title, and its export writes it out: the
// import names the row and says so rather than refusing the whole course.
console.log('\n--- a blank title imports named, with a warning ---');
{
    r = await api('/api/import', json('POST', { project: { name: '   ' }, nodes: [{ title: 'Kept' }, { title: '   ' }] }));
    const titles = r.body?.id ? db.prepare('SELECT title FROM nodes WHERE project_id = ? ORDER BY position').all(r.body.id).map(n => n.title) : [];
    check('a blank course name and a blank topic title import', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    check('...named, and said', r.body?.name === 'Untitled course' && titles[1] === 'Untitled'
        && r.body?.warnings?.filter(w => /blank/.test(w)).length === 2, JSON.stringify({ name: r.body?.name, titles, warnings: r.body?.warnings }));
    if (r.body?.id) db.prepare('DELETE FROM projects WHERE id = ?').run(r.body.id);
    r = await api('/api/import', json('POST', { project: { name: 'Fixture: no title' }, nodes: [{ description: 'no title at all' }] }));
    check('a node with no title at all is still not a node', r.status === 400);
}

console.log('\n--- a rating sent twice ---');
const stamp = new Date().toISOString();
const rating = { rating: 3, last_reviewed: stamp, next_review: stamp, stability: 2.5, fsrs_difficulty: 5, state: 2 };
const first = await api(`/api/ai/flashcards/${cardId}`, json('PUT', rating));
const second = await api(`/api/ai/flashcards/${cardId}`, json('PUT', rating));
const logRows = db.prepare('SELECT COUNT(*) c FROM review_log WHERE card_id = ?').get(cardId).c;
check('both answer 200', first.status === 200 && second.status === 200);
check('the review is logged once', logRows === 1, `${logRows} rows`);
check('and counted once', db.prepare('SELECT review_count c FROM flashcards WHERE id = ?').get(cardId).c === 1);
const later = new Date(Date.now() + 1000).toISOString();
await api(`/api/ai/flashcards/${cardId}`, json('PUT', { ...rating, last_reviewed: later }));
check('a real second review (a new stamp) still counts', db.prepare('SELECT COUNT(*) c FROM review_log WHERE card_id = ?').get(cardId).c === 2
    && db.prepare('SELECT review_count c FROM flashcards WHERE id = ?').get(cardId).c === 2);

console.log('\n--- an upload to nowhere ---');
const boundary = '----gate' + Date.now();
const multipart = [
    `--${boundary}\r\nContent-Disposition: form-data; name="projectId"\r\n\r\n987654\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n`,
    `--${boundary}--\r\n`,
].join('');
r = await api('/api/documents/upload', {
    method: 'POST', body: multipart,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(multipart) },
});
check('an upload to a missing project is answered, with a 404', r.status === 404, `${r.status} in ${r.ms} ms`);

console.log('\n--- the provider key and its address ---');
await api('/api/settings/ai_openai_base_url', json('PUT', { value: 'https://openrouter.ai/api/v1' }));
r = await api('/api/ai/key', json('PUT', { apiKey: 'sk-gate', baseUrl: 'https://openrouter.ai/api/v1' }));
check('a saved key is bound to its origin', r.status === 200 && r.body?.apiKeyOrigin === 'https://openrouter.ai');
r = await api('/api/settings/ai_openai_api_key_origin', json('PUT', { value: 'https://attacker.example' }));
check('the origin row cannot be rewritten through the settings writer', r.status === 403);
await api('/api/settings/ai_openai_base_url', json('PUT', { value: 'https://attacker.example/v1' }));
const { getAISettings } = await import(B + 'ai.js');
check('re-aimed, the app has no key to send', getAISettings().apiKey === '');
const dump = await api('/api/settings');
check('the settings dump carries neither the key nor its origin', !('ai_openai_api_key' in (dump.body || {})) && !('ai_openai_api_key_origin' in (dump.body || {})));
await api('/api/ai/key', { method: 'DELETE' });
check('clearing the key clears its origin', !db.prepare(`SELECT 1 FROM settings WHERE key = 'ai_openai_api_key_origin'`).get());

console.log('\n--- rows only the server writes ---');
// The update check's answer, its channel and consent, and the fitted scheduler
// parameters are written by the server alone; the settings writer refuses them
// and the stored row is untouched.
for (const key of ['update_latest', 'update_last_check', 'update_last_error', 'update_answer_channel', 'update_channel',
    'update_check', 'update_check_asked', 'bkt_params', 'bkt_params_meta', 'fsrs_params', 'fsrs_params_meta']) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, 'server-written');
    r = await api(`/api/settings/${key}`, json('PUT', { value: 'client-written' }));
    const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
    check(`${key} cannot be written through the settings writer`, r.status === 403 && stored === 'server-written', `${r.status}, stored ${stored}`);
}
r = await api('/api/settings/theme', json('PUT', { value: 'dark' }));
check('a preference still saves', r.status === 200 && db.prepare(`SELECT value FROM settings WHERE key = 'theme'`).get()?.value === 'dark');

console.log('\n--- this machine, with no password ---');
r = await api('/api/auth/status');
check('loopback with no password is open (the desktop and local use are unchanged)', r.status === 200 && r.body?.enabled === false && !r.body?.setupRequired);

console.log('\n--- a node and its parent ---');
{
    const projA = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Fixture: A')`).run().lastInsertRowid);
    const projB = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Fixture: B')`).run().lastInsertRowid);
    const countIn = (p) => db.prepare('SELECT COUNT(*) c FROM nodes WHERE project_id = ?').get(p).c;
    const parentA = (await api('/api/nodes', json('POST', { project_id: projA, title: 'A parent' }))).body?.id;
    r = await api('/api/nodes', json('POST', { project_id: projA, parent_id: parentA, title: 'A child' }));
    check('a child under a parent in its own project is still created', r.status === 200 && r.body?.parent_id === parentA);
    r = await api('/api/nodes', json('POST', { project_id: projB, title: 'B root' }));
    check('a root node (no parent) is still created', r.status === 200 && r.body?.parent_id == null);
    r = await api('/api/nodes', json('POST', { project_id: projB, parent_id: parentA, title: 'B under A' }));
    check('a parent from another project is refused with a 400', r.status === 400 && /project/i.test(r.body?.error || ''), `${r.status} ${JSON.stringify(r.body)}`);
    // Counted AFTER the attempt: whatever it left in B is what the delete of
    // A's node must not reach.
    const bBefore = countIn(projB);
    r = await api('/api/nodes', json('POST', { project_id: projB, parent_id: 99_999_999, title: 'B under nothing' }));
    check('a parent that does not exist is refused with a 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
    // The id the NEXT insert will take: referencing it passes the foreign key,
    // because the row being inserted is the row it names.
    const next = Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM nodes').get().n);
    r = await api('/api/nodes', json('POST', { project_id: projA, parent_id: next, title: 'self' }));
    const selfRow = db.prepare('SELECT id FROM nodes WHERE id = parent_id').get();
    check('a parent_id naming the predicted next id is refused, and no row is its own parent', r.status === 400 && !selfRow, `${r.status} ${JSON.stringify(r.body)}`);
    // Unbounded walks go through parent_id, so a self-cycle the old code stored
    // is removed here before anything else in this suite reads the tree.
    if (selfRow) db.prepare('DELETE FROM nodes WHERE id = parent_id').run();
    r = await api('/api/nodes', json('POST', { project_id: 987_654, title: 'orphan' }));
    check('a project that does not exist is a 404', r.status === 404, `${r.status} ${JSON.stringify(r.body)}`);
    await api(`/api/nodes/${parentA}`, { method: 'DELETE' });
    check("deleting project A's node no longer reaches project B", countIn(projB) === bBefore, `${bBefore} → ${countIn(projB)}`);
}

console.log("\n--- a node's note flag, position and weight ---");
// PUT /api/nodes/:id stored these three as given: `"yes"` as a note flag,
// `"abc"` as a position (sorted after every number), `"lots"` as a weight
// (PUT /api/nodes/:id/weight refuses the same value), and `true` failed the
// bind with a 500. Each is refused before anything is written.
{
    const node = Number(db.prepare(`INSERT INTO nodes (project_id, title, position) VALUES (?, 'Fields', 4)`).run(pid).lastInsertRowid);
    const row = () => db.prepare('SELECT title, is_note, position, estimated_weight, updated_at FROM nodes WHERE id = ?').get(node);
    const before = JSON.stringify(row());
    const put = (body) => api(`/api/nodes/${node}`, json('PUT', body));
    const refused = [
        ['the cloud review\'s body', { is_note: 'yes', position: 'abc', estimated_weight: 'lots' }],
        ['a note flag that is a word', { is_note: 'yes' }],
        ['a note flag of 2', { is_note: 2 }],
        ['a position that is a word', { position: 'abc' }],
        ['a negative position', { position: -1 }],
        ['a fractional position', { position: 1.5 }],
        ['a weight that is a word', { estimated_weight: 'lots' }],
        ['a negative weight', { estimated_weight: -1 }],
        ['a weight as a numeric string', { estimated_weight: '5' }],
        ['a good title beside a bad weight', { title: 'Renamed', estimated_weight: 'lots' }],
    ];
    for (const [label, body] of refused) {
        r = await put(body);
        check(`${label} is a 400, and the row is untouched`, r.status === 400 && JSON.stringify(row()) === before, `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(row())}`);
    }
    // JSON.parse reads 1e400 as Infinity; JSON.stringify cannot write it, so
    // the body is sent as text. The weight route had the same `>= 0` check.
    for (const path of [`/api/nodes/${node}`, `/api/nodes/${node}/weight`]) {
        r = await api(path, { method: 'PUT', body: '{"estimated_weight":1e400}' });
        check(`an infinite weight is a 400 on PUT ${path.replace(String(node), ':id')}`, r.status === 400 && JSON.stringify(row()) === before, `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(row())}`);
    }
    r = await put({ is_note: 1 });
    check('a note flag of 1 is stored', r.status === 200 && row().is_note === 1, `${r.status} ${JSON.stringify(row())}`);
    r = await put({ is_note: false });
    check('a note flag of false is stored as 0', r.status === 200 && row().is_note === 0, `${r.status} ${JSON.stringify(r.body)}`);
    r = await put({ position: 0 });
    check('a position of 0 is stored', r.status === 200 && row().position === 0, `${r.status} ${JSON.stringify(row())}`);
    r = await put({ estimated_weight: 2.5 });
    check('a weight of 2.5 is stored', r.status === 200 && row().estimated_weight === 2.5, `${r.status} ${JSON.stringify(row())}`);
    r = await put({ estimated_weight: null });
    check('a weight of null clears it back to the default', r.status === 200 && row().estimated_weight === null, `${r.status} ${JSON.stringify(row())}`);

    const count = () => db.prepare('SELECT COUNT(*) c FROM nodes WHERE project_id = ?').get(pid).c;
    const n0 = count();
    r = await api('/api/nodes', json('POST', { project_id: pid, title: 'Noted', is_note: 'yes' }));
    check('a node created with a note flag that is a word is a 400, and nothing is created', r.status === 400 && count() === n0, `${r.status} ${JSON.stringify(r.body)}`);
    r = await api('/api/nodes', json('POST', { project_id: pid, title: 'Noted', is_note: true }));
    check('a node created with a note flag of true is a note', r.status === 200 && r.body?.is_note === 1, `${r.status} ${JSON.stringify(r.body)}`);
}

console.log('\n--- a bundle whose manifest is not an object ---');
{
    const { default: JSZip } = await import('jszip');
    const postBundle = async (manifestText) => {
        const zip = new JSZip();
        zip.file('manifest.json', manifestText);
        const bytes = await zip.generateAsync({ type: 'nodebuffer' });
        const b = '----gate' + Date.now();
        const body = Buffer.concat([
            Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="bundle"; filename="x.studyvault"\r\nContent-Type: application/zip\r\n\r\n`),
            bytes,
            Buffer.from(`\r\n--${b}--\r\n`),
        ]);
        return api('/api/import/bundle', {
            method: 'POST', body, timeout: 5000,
            headers: { 'Content-Type': `multipart/form-data; boundary=${b}`, 'Content-Length': body.length },
        });
    };
    for (const [label, text] of [
        ['null', 'null'], ['an array', '[]'], ['a number', '42'], ['a string', '"course"'],
        ['documents that is not a list', '{"project":{"name":"x"},"documents":5}'],
        ['nodes that is not a list', '{"project":{"name":"x"},"nodes":"x"}'],
    ]) {
        r = await postBundle(text);
        check(`manifest.json holding ${label} is answered with a 400`, r.status === 400, `${r.status} in ${r.ms} ms ${JSON.stringify(r.body)}`);
    }
}

// A fresh card per sequence, so each block reads only its own history.
const mkCard = () => Number(db.prepare(`INSERT INTO flashcards (node_id, front, back) VALUES (?, 'f', 'b')`).run(topic).lastInsertRowid);
const cardRow = (id) => db.prepare('SELECT * FROM flashcards WHERE id = ?').get(id);
const logOf = (id) => db.prepare('SELECT reviewed_at FROM review_log WHERE card_id = ? ORDER BY id').all(id).map(x => x.reviewed_at);
const tA = '2026-09-01T10:00:00.000Z';
const tB = '2026-09-01T10:05:00.000Z';
const rateAt = (stamp, stability) => ({ rating: 3, last_reviewed: stamp, next_review: stamp, stability, fsrs_difficulty: 5, state: 2, lapses: 0, last_interval: 1, difficulty: 2, learning_steps: 0 });
// What `srsSnapshot` sends for a card as it stood before a rating.
const snapshotOf = (row) => ({
    difficulty: row.difficulty ?? null, last_reviewed: row.last_reviewed ?? null, next_review: row.next_review ?? null,
    review_count: row.review_count ?? null, ease_factor: row.ease_factor ?? null, last_interval: row.last_interval ?? null,
    stability: row.stability ?? null, stability_fast: row.stability_fast ?? null,
    fsrs_difficulty: row.fsrs_difficulty ?? null, state: row.state ?? null,
    lapses: row.lapses ?? null, learning_steps: row.learning_steps ?? null, undo_review: true,
});

console.log('\n--- a review whose history cannot be written ---');
{
    const c = mkCard();
    const before = cardRow(c);
    db.exec(`CREATE TRIGGER gate_refuse_log BEFORE INSERT ON review_log BEGIN SELECT RAISE(ABORT, 'gate: log refused'); END;`);
    r = await api(`/api/ai/flashcards/${c}`, json('PUT', rateAt(tA, 1.5)));
    const after = cardRow(c);
    db.exec('DROP TRIGGER gate_refuse_log');
    check('the request reports the failure', r.status >= 500, `${r.status}`);
    check('and the card is unchanged', after.review_count === before.review_count && after.last_reviewed === before.last_reviewed
        && after.stability === before.stability, `review_count ${after.review_count}, last_reviewed ${after.last_reviewed}`);
    r = await api(`/api/ai/flashcards/${c}`, json('PUT', rateAt(tA, 1.5)));
    check('so a retry is applied, with its history', r.status === 200 && logOf(c).length === 1 && cardRow(c).review_count === 1,
        `${r.status}, ${logOf(c).length} rows, review_count ${cardRow(c).review_count}`);
}

console.log('\n--- review A, review B, then A retried ---');
{
    const c = mkCard();
    await api(`/api/ai/flashcards/${c}`, json('PUT', rateAt(tA, 1)));
    await api(`/api/ai/flashcards/${c}`, json('PUT', rateAt(tB, 2)));
    r = await api(`/api/ai/flashcards/${c}`, json('PUT', rateAt(tA, 1)));
    const row = cardRow(c);
    check('the replay is answered 200 with the card as it stands', r.status === 200 && r.body?.last_reviewed === tB, `${r.status} ${r.body?.last_reviewed}`);
    check('and writes nothing: two reviews, B still the schedule', logOf(c).length === 2 && row.review_count === 2
        && row.last_reviewed === tB && row.stability === 2, `${logOf(c).length} rows, count ${row.review_count}, last ${row.last_reviewed}, S ${row.stability}`);
}

console.log('\n--- review A, review B elsewhere, then undo of A ---');
{
    const c = mkCard();
    const before = cardRow(c);
    await api(`/api/ai/flashcards/${c}`, json('PUT', rateAt(tA, 1)));
    const afterA = cardRow(c);
    await api(`/api/ai/flashcards/${c}`, json('PUT', rateAt(tB, 2)));
    r = await api(`/api/ai/flashcards/${c}`, json('PUT', { ...snapshotOf(before), undo_of: tA }));
    let row = cardRow(c);
    check('a stale undo is refused with a 409 and a message', r.status === 409 && typeof r.body?.error === 'string', `${r.status} ${JSON.stringify(r.body)}`);
    check('and changes nothing: the card is still at B, both reviews logged', row.last_reviewed === tB && row.review_count === 2
        && row.stability === 2 && JSON.stringify(logOf(c)) === JSON.stringify([tA, tB]), `last ${row.last_reviewed}, count ${row.review_count}, log ${logOf(c)}`);
    r = await api(`/api/ai/flashcards/${c}`, json('PUT', { ...snapshotOf(afterA), undo_of: tB }));
    row = cardRow(c);
    check('undo of the review the card holds takes exactly that review back', r.status === 200 && row.last_reviewed === tA
        && row.review_count === 1 && JSON.stringify(logOf(c)) === JSON.stringify([tA]), `${r.status}, last ${row.last_reviewed}, log ${logOf(c)}`);
}

console.log('\n--- the FSRS-7 fast trace travels with stability ---');
// FSRS-7 keeps two stabilities. The pair is one memory state: a slow trace
// written without its fast one would be read with whatever fast trace the row
// held before, which belongs to a different review.
{
    const c = mkCard();
    r = await api(`/api/ai/flashcards/${c}`, json('PUT', { ...rateAt(tA, 30), stability_fast: 3 }));
    let row = cardRow(c);
    check('a rating writes the fast trace beside the slow one', r.status === 200 && row.stability === 30 && row.stability_fast === 3,
        `${r.status}, S ${row.stability}, fast ${row.stability_fast}`);
    check('...and the answer carries it, for the feed that requeues the saved row', r.body?.stability_fast === 3, `${r.body?.stability_fast}`);
    await api(`/api/ai/flashcards/${c}`, json('PUT', { front: 'edited' }));
    check('editing the card leaves it alone', cardRow(c).stability_fast === 3, `${cardRow(c).stability_fast}`);
    const afterA = cardRow(c);
    await api(`/api/ai/flashcards/${c}`, json('PUT', { ...rateAt(tB, 40), stability_fast: 5 }));
    r = await api(`/api/ai/flashcards/${c}`, json('PUT', { ...snapshotOf(afterA), undo_of: tB }));
    row = cardRow(c);
    check('undo restores both traces', r.status === 200 && row.stability === 30 && row.stability_fast === 3,
        `${r.status}, S ${row.stability}, fast ${row.stability_fast}`);
    const tC = '2026-09-01T10:10:00.000Z';
    await api(`/api/ai/flashcards/${c}`, json('PUT', rateAt(tC, 12)));
    row = cardRow(c);
    check('stability written alone (a client from before FSRS-7) clears the fast trace, so the card is seeded again',
        row.stability === 12 && row.stability_fast === null, `S ${row.stability}, fast ${row.stability_fast}`);
    // A card FSRS-6 scheduled (stability, no fast trace) whose first FSRS-7
    // review is taken back must read as FSRS-6 again, so it is seeded again
    // rather than carrying the fast trace of a review that no longer exists.
    {
        const s6 = mkCard();
        await api(`/api/ai/flashcards/${s6}`, json('PUT', rateAt('2026-08-01T10:00:00.000Z', 20)));
        const asFsrs6 = cardRow(s6);
        const tFirst = '2026-09-01T11:00:00.000Z';
        await api(`/api/ai/flashcards/${s6}`, json('PUT', { ...rateAt(tFirst, 25), stability_fast: 2 }));
        const rated = cardRow(s6).stability_fast;
        r = await api(`/api/ai/flashcards/${s6}`, json('PUT', { ...snapshotOf(asFsrs6), undo_of: tFirst }));
        const back = cardRow(s6);
        check('undoing the first FSRS-7 review of a card FSRS-6 scheduled puts it back to FSRS-6 (no fast trace)',
            asFsrs6.stability_fast === null && rated === 2 && r.status === 200 && back.stability === 20 && back.stability_fast === null,
            `before ${asFsrs6.stability_fast}, rated ${rated}, undo ${r.status}, S ${back.stability}, fast ${back.stability_fast}`);
    }
    // The scheduler refuses a memory state that is not a finite number, and the
    // rating buttons compute from it while the card is drawn: text in these
    // columns would break the card's next review screen.
    const held = cardRow(c);
    for (const [field, bad] of [['stability_fast', 'abc'], ['stability_fast', -1], ['stability', 'abc'], ['fsrs_difficulty', 'hard'],
        ['last_interval', 'abc'], ['ease_factor', 'x']]) {
        r = await api(`/api/ai/flashcards/${c}`, json('PUT', { ...rateAt('2026-09-02T10:00:00.000Z', 12), stability_fast: 1, [field]: bad }));
        const now = cardRow(c);
        check(`${field}: ${JSON.stringify(bad)} is a 400 and writes nothing`,
            r.status === 400 && now.stability_fast === held.stability_fast && now.stability === held.stability && now.last_reviewed === held.last_reviewed,
            `${r.status}, S ${now.stability}, fast ${now.stability_fast}`);
    }
    r = await api(`/api/ai/flashcards/${c}`, json('PUT', { stability: 9, stability_fast: null, fsrs_difficulty: null }));
    check('null is still accepted (what an undo sends back for a card FSRS-6 scheduled)',
        r.status === 200 && cardRow(c).stability === 9 && cardRow(c).stability_fast === null, `${r.status}`);
    {
        const before = cardRow(c);
        r = await api(`/api/ai/flashcards/${c}`, json('PUT', { stability_fast: 2 }));
        const now = cardRow(c);
        check('a fast trace sent without its slow one is a 400 and writes nothing',
            r.status === 400 && now.stability_fast === before.stability_fast && now.stability === before.stability,
            `${r.status}, S ${now.stability}, fast ${now.stability_fast}`);
    }
    // ts-fsrs also refuses a count that is not a non-negative integer. Counts
    // are coerced, as review_count and learning_steps already were.
    r = await api(`/api/ai/flashcards/${c}`, json('PUT', { lapses: 'x' }));
    const lapsesText = cardRow(c).lapses;
    r = await api(`/api/ai/flashcards/${c}`, json('PUT', { lapses: 2.6 }));
    check('lapses is stored as a non-negative integer: text becomes 0, 2.6 becomes 3',
        lapsesText === 0 && cardRow(c).lapses === 3, `text → ${JSON.stringify(lapsesText)}, 2.6 → ${cardRow(c).lapses}`);
}

console.log('\n--- an empty body on the older routes ---');
// These answered `{}` with a 500 (a TypeError or a NOT NULL failure), where
// PUT /api/nodes/reorder beside them answers a 400.
{
    for (const [method, path] of [
        ['PUT', '/api/projects/reorder'], ['PUT', '/api/resources/reorder'],
        ['POST', '/api/projects'], ['POST', '/api/resources'],
    ]) {
        r = await api(path, json(method, {}));
        check(`${method} ${path} {} is a 400 with a reason`, r.status === 400 && typeof r.body?.error === 'string', `${r.status} ${JSON.stringify(r.body)}`);
    }
    r = await api('/api/resources', json('POST', { node_id: 99_999_999, title: 'x', url: 'https://example.com' }));
    check('a resource on a node that does not exist is a 404', r.status === 404, `${r.status} ${JSON.stringify(r.body)}`);
    const masteryRows = () => db.prepare('SELECT COUNT(*) c FROM node_mastery').get().c;
    const before = masteryRows();
    r = await api('/api/nodes/99999999/mastery');
    check('GET mastery of a node that does not exist is a 404, and writes nothing', r.status === 404 && masteryRows() === before, `${r.status} ${JSON.stringify(r.body)}`);

    r = await api('/api/projects', json('POST', { name: 'Fixture: named' }));
    const named = r.body?.id;
    check('a project with a name is still created', r.status === 200 && r.body?.name === 'Fixture: named');
    r = await api('/api/projects/reorder', json('PUT', { projectIds: [named, pid] }));
    check('a project reorder with a list still applies', r.status === 200
        && db.prepare('SELECT position FROM projects WHERE id = ?').get(named).position === 0
        && db.prepare('SELECT position FROM projects WHERE id = ?').get(pid).position === 1);
    r = await api('/api/resources', json('POST', { node_id: topic, title: 'Link', url: 'https://example.com/a' }));
    const link = r.body?.id;
    check('a resource on a real topic is still created', r.status === 200 && r.body?.node_id === topic);
    r = await api('/api/resources/reorder', json('PUT', { resourceIds: [link] }));
    check('a resource reorder with a list still applies', r.status === 200 && r.body?.success === true);
    r = await api(`/api/nodes/${topic}/mastery`);
    check('GET mastery of a real topic still answers', r.status === 200);
}

console.log('\n--- a note holds no topics ---');
// Notes are material attached to a topic, not containers. Every door that
// re-parents a node or flips its note flag accepted a topic under a note, and
// then the server's leaf rule (a node's own children only) counted it as work
// while the client's tree, which stops at a note, counted it as nothing: the
// project card and the tree on screen disagreed. Replacing a topic's material
// also deletes its notes, and the cascade took any topic filed under them.
{
    const proj = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Fixture: notes')`).run().lastInsertRowid);
    const mk = (title, parent = null, isNote = 0) => Number(db.prepare(
        'INSERT INTO nodes (project_id, parent_id, title, is_note) VALUES (?, ?, ?, ?)').run(proj, parent, title, isNote).lastInsertRowid);
    const section = mk('Section');
    const material = mk('Reading', section, 1);
    const loose = mk('Loose topic');
    const looseNote = mk('Loose note', null, 1);
    const parentOf = (id) => db.prepare('SELECT parent_id p FROM nodes WHERE id = ?').get(id).p;
    const noteOf = (id) => db.prepare('SELECT is_note n FROM nodes WHERE id = ?').get(id).n;
    const topicsUnderNotes = () => db.prepare(`SELECT COUNT(*) c FROM nodes n JOIN nodes p ON p.id = n.parent_id
                                               WHERE p.is_note = 1 AND n.is_note = 0`).get().c;

    let r = await api(`/api/nodes/${loose}/move`, json('PUT', { parent_id: material, position: 0 }));
    check('moving a topic under a note is refused', r.status === 400 && parentOf(loose) == null, `${r.status} ${JSON.stringify(r.body)}`);
    r = await api(`/api/nodes/${loose}`, json('PUT', { parent_id: material }));
    check('...through PUT /api/nodes/:id too', r.status === 400 && parentOf(loose) == null, `${r.status} ${JSON.stringify(r.body)}`);
    r = await api('/api/nodes/reorder', json('PUT', { nodeIds: [loose], parentId: material }));
    check('...and through a reorder', r.status === 400 && parentOf(loose) == null, `${r.status} ${JSON.stringify(r.body)}`);
    r = await api('/api/nodes', json('POST', { project_id: proj, parent_id: material, title: 'New topic' }));
    check('creating a topic under a note is refused', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

    r = await api(`/api/nodes/${looseNote}/move`, json('PUT', { parent_id: material, position: 0 }));
    check('a note may still go under a note', r.status === 200 && parentOf(looseNote) === material, `${r.status} ${JSON.stringify(r.body)}`);
    r = await api('/api/nodes', json('POST', { project_id: proj, parent_id: material, title: 'Appendix', is_note: 1 }));
    check('...and be created there', r.status === 200 && r.body?.parent_id === material, `${r.status} ${JSON.stringify(r.body)}`);
    r = await api(`/api/nodes/${loose}/move`, json('PUT', { parent_id: section, position: 0 }));
    check('a topic still moves under a topic', r.status === 200 && parentOf(loose) === section, `${r.status} ${JSON.stringify(r.body)}`);

    r = await api(`/api/nodes/${section}`, json('PUT', { is_note: 1 }));
    check('a section holding topics cannot become a note', r.status === 400 && noteOf(section) === 0, `${r.status} ${JSON.stringify(r.body)}`);
    r = await api(`/api/nodes/${looseNote}`, json('PUT', { is_note: 0 }));
    check('a note under a note cannot become a topic where it stands', r.status === 400 && noteOf(looseNote) === 1, `${r.status} ${JSON.stringify(r.body)}`);
    r = await api(`/api/nodes/${looseNote}`, json('PUT', { is_note: 0, parent_id: null }));
    check('...but can, moved out in the same request', r.status === 200 && noteOf(looseNote) === 0 && parentOf(looseNote) == null, `${r.status} ${JSON.stringify(r.body)}`);
    r = await api(`/api/nodes/${looseNote}`, json('PUT', { is_note: 1, parent_id: material }));
    check('a topic made a note in the same request may go under a note', r.status === 200 && noteOf(looseNote) === 1 && parentOf(looseNote) === material, `${r.status} ${JSON.stringify(r.body)}`);
    r = await api(`/api/nodes/${material}`, json('PUT', { is_note: 0 }));
    // It holds notes, which a topic may.
    check('a note under a topic holding only notes may still become a topic', r.status === 200 && noteOf(material) === 0, `${r.status} ${JSON.stringify(r.body)}`);
    db.prepare('UPDATE nodes SET is_note = 1 WHERE id = ?').run(material);
    r = await api(`/api/nodes/${loose}`, json('PUT', { title: 'Renamed loose topic' }));
    check('editing an unrelated field asks nothing of the shape', r.status === 200);
    check('no door left a topic under a note', topicsUnderNotes() === 0, `${topicsUnderNotes()} found`);
}

console.log('\n--- a library that already holds a topic under a note ---');
// Written before the doors above refused one. The start-up repair makes the note
// a section, as an import does: nothing moves, and the server's counts (which
// already took the topics as work) do not change. Left alone, every reorder of
// those topics' siblings and every no-op save of their flags was refused.
{
    const { notesHoldingTopicsToSections: repair } = await import(B + 'database.js');
    const proj = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Fixture: legacy notes')`).run().lastInsertRowid);
    const mk = (title, parent = null, isNote = 0) => Number(db.prepare(
        'INSERT INTO nodes (project_id, parent_id, title, is_note) VALUES (?, ?, ?, ?)').run(proj, parent, title, isNote).lastInsertRowid);
    const tools = mk('Essential tools', null, 1);
    const jisho = mk('Dictionary', tools);
    const yomitan = mk('Pop-up dictionary', tools);
    const outer = mk('Outer note', null, 1);
    const inner = mk('Inner note', outer, 1);
    mk('Topic deep inside', inner);
    const reading = mk('Plain reading', null, 1);
    mk('An appendix note', reading, 1);
    const noteOf = (id) => db.prepare('SELECT is_note n FROM nodes WHERE id = ?').get(id).n;
    const converted = typeof repair === 'function' ? repair() : -1;
    check('a note holding topics becomes a section', noteOf(tools) === 0, `is_note ${noteOf(tools)}, repair ${converted}`);
    check('...a note under a note too, and the note above it', noteOf(inner) === 0 && noteOf(outer) === 0, `inner ${noteOf(inner)} outer ${noteOf(outer)}`);
    check('...while a note holding only notes stays a note', noteOf(reading) === 1);
    check('...and a second pass changes nothing', typeof repair === 'function' && repair() === 0);
    const r = await api('/api/nodes/reorder', json('PUT', { nodeIds: [yomitan, jisho], parentId: tools }));
    check('its topics can be reordered afterwards', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
}

console.log('\n--- the tree routes take only what they can store ---');
// Found by the 1 November bug sweep: a topic with no title was a NOT NULL 500 and
// a blank one a nameless row; a missing id answered 200 (or a foreign-key 500
// from the mastery gate); /move and /reorder without a parent moved nodes to the
// top level; a reorder naming part of a group left ties; a re-parent kept its
// old number among its new siblings.
{
    const proj = Number(db.prepare(`INSERT INTO projects (name) VALUES ('Fixture: tree routes')`).run().lastInsertRowid);
    const mk = (title, parent = null, position = 0) => Number(db.prepare(
        'INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, ?, ?, ?)').run(proj, parent, title, position).lastInsertRowid);
    const row = (id) => db.prepare('SELECT parent_id, position, title, description FROM nodes WHERE id = ?').get(id);
    const order = (parent) => db.prepare('SELECT id, position FROM nodes WHERE project_id = ? AND parent_id IS ? ORDER BY position, id').all(proj, parent);
    const a = mk('A', null, 0);
    const b = mk('B', null, 1);
    const a1 = mk('A1', a, 0), a2 = mk('A2', a, 1), a3 = mk('A3', a, 2);
    const b1 = mk('B1', b, 0);

    for (const [label, body] of [
        ['no title', {}], ['a blank title', { title: '   ' }], ['a number for a title', { title: 123 }],
        ['an object for a description', { title: 'T', description: { a: 1 } }],
    ]) {
        r = await api('/api/nodes', json('POST', { project_id: proj, ...body }));
        check(`a new topic with ${label} is a 400`, r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
    }
    r = await api('/api/nodes', json('POST', { project_id: { id: proj }, title: 'T' }));
    check('...and with a project id sent as an object', r.status === 400, `${r.status}`);
    r = await api('/api/nodes', json('POST', { title: 'T' }));
    check('...or none at all', r.status === 400, `${r.status}`);

    r = await api('/api/nodes/987654', json('PUT', { title: 'Ghost' }));
    check('editing a topic that does not exist is a 404, not 200 with no body', r.status === 404, `${r.status}`);
    r = await api('/api/nodes/987654', json('PUT', { status: 'completed' }));
    check('...marking one completed too, not a foreign-key 500', r.status === 404, `${r.status}`);
    for (const title of [null, 5, '  ']) {
        r = await api(`/api/nodes/${b1}`, json('PUT', { title }));
        check(`renaming a topic to ${JSON.stringify(title)} is a 400`, r.status === 400 && row(b1).title === 'B1', `${r.status}`);
    }
    r = await api(`/api/nodes/${b1}`, json('PUT', { description: null }));
    check('a description cleared with null is stored empty', r.status === 200 && row(b1).description === '', `${r.status} ${JSON.stringify(row(b1))}`);
    r = await api('/api/nodes/987654', { method: 'DELETE' });
    check('deleting a topic that does not exist is a 404', r.status === 404, `${r.status}`);

    r = await api(`/api/nodes/${a1}/move`, json('PUT', { position: 0 }));
    check('a move that names no parent is a 400, and the topic stays', r.status === 400 && row(a1).parent_id === a, `${r.status} ${JSON.stringify(row(a1))}`);
    r = await api(`/api/nodes/${a1}/move`, json('PUT', { parent_id: a, position: 'top' }));
    check('...and so is one with a position that is not a number', r.status === 400);
    r = await api(`/api/nodes/${b1}/move`, json('PUT', { parent_id: a }));
    check('a move with no position goes last', r.status === 200 && order(a).at(-1)?.id === b1, JSON.stringify(order(a)));
    r = await api(`/api/nodes/${b1}/move`, json('PUT', { parent_id: b, position: 0 }));

    r = await api('/api/nodes/reorder', json('PUT', { nodeIds: [a3, a1] }));
    check('a reorder that names no parent is a 400, and nothing moves', r.status === 400 && row(a3).parent_id === a, `${r.status} ${JSON.stringify(row(a3))}`);
    r = await api('/api/nodes/reorder', json('PUT', { nodeIds: ['x'], parentId: a }));
    check('...and so is one naming something that is not an id', r.status === 400, `${r.status}`);
    r = await api('/api/nodes/reorder', json('PUT', { nodeIds: [a1, a1], parentId: a }));
    check('...or a node twice', r.status === 400, `${r.status}`);
    // Its own group, so nothing above decides what it starts from.
    const c = mk('C', null, 2);
    const c1 = mk('C1', c, 0), c2 = mk('C2', c, 1), c3 = mk('C3', c, 2);
    r = await api('/api/nodes/reorder', json('PUT', { nodeIds: [c3, c1], parentId: c }));
    const afterPart = order(c);
    check('a reorder naming part of a group leaves no tie', r.status === 200
        && new Set(afterPart.map(n => n.position)).size === afterPart.length, JSON.stringify(afterPart));
    check('...the named rows in their order, the other after them', afterPart.map(n => n.id).join() === [c3, c1, c2].join(), JSON.stringify(afterPart));

    r = await api(`/api/nodes/${b1}`, json('PUT', { parent_id: a }));
    const afterReparent = order(a);
    check('a topic re-parented with no position goes last among its new siblings', r.status === 200
        && afterReparent.at(-1)?.id === b1 && new Set(afterReparent.map(n => n.position)).size === afterReparent.length, JSON.stringify(afterReparent));

    const res = Number(db.prepare(`INSERT INTO resources (node_id, title, url, type, position) VALUES (?, 'Link', 'https://example.com', 'article', 0)`)
        .run(a2).lastInsertRowid);
    r = await api('/api/resources/987654', json('PUT', { completed: 1 }));
    check('ticking a saved link that does not exist is a 404', r.status === 404, `${r.status}`);
    r = await api(`/api/resources/${res}`, json('PUT', { completed: true }));
    check('a link ticked with true is stored as 1, not a binding 500', r.status === 200 && r.body?.completed === 1, `${r.status} ${JSON.stringify(r.body)}`);
    r = await api(`/api/resources/${res}`, json('PUT', { completed: 'yes' }));
    check('...and "yes" is refused, not stored', r.status === 400
        && db.prepare('SELECT completed c FROM resources WHERE id = ?').get(res).c === 1, `${r.status}`);
    r = await api('/api/resources/reorder', json('PUT', { resourceIds: [{ id: res }] }));
    check('a link reorder naming something that is not an id is a 400', r.status === 400, `${r.status}`);

    const nodesSource = readFileSync(new URL('../server/routes/nodes.js', import.meta.url), 'utf8');
    const createRoute = nodesSource.slice(nodesSource.indexOf("app.post('/api/nodes'"), nodesSource.indexOf("app.put('/api/nodes/:id'"));
    check('creating a topic asks for search words (a course built by hand had none until a restart)', /scheduleSearchWords\(\)/.test(createRoute));
    db.prepare('DELETE FROM projects WHERE id = ?').run(proj);
}

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);

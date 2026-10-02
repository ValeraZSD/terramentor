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
//   - a bundle whose manifest.json was `null` was never answered;
//   - a review whose log insert failed still changed the card;
//   - a retried rating arriving after a newer one was applied again, and an
//     undo sent after another device had rated erased that newer review.

import { mkdtempSync, rmSync } from 'node:fs';
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
    stability: row.stability ?? null, fsrs_difficulty: row.fsrs_difficulty ?? null, state: row.state ?? null,
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

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);

// tools/item-identity-gates.mjs — a question and a card have an IDENTITY.
//
// Run:  node tools/item-identity-gates.mjs
//
// A course could only ever be installed beside itself: projects, topics and
// links carried a portable uuid, but the two things a learner's progress hangs
// on did not. A card's schedule is on its row and its history on
// `review_log.card_id`; a question lives inside a JSON array, and the record of
// which ones were asked was keyed by its POSITION in that array — so anything
// that rewrote a bank (the answer check deletes vetoed questions; a future
// edition inserts one) silently moved "asked" onto a different question.
// Updating a course in place (COURSE-UPDATES.md) needs every item to say who
// it is. This asserts that it does:
//
//   * every card row has a uuid, minted by the database whatever inserted it;
//   * every question a topic OWNS has a uuid inside its JSON, stamped by the
//     database on insert and on rewrite, never on a ghost copy of another
//     topic's question, never changing a question that already has one;
//   * the ask-record names the question, so a rewritten bank keeps its memory;
//   * rows written before any of this are given ids by the next boot;
//   * the file carries both ids out and back in, a second copy on the same
//     machine gets fresh card ids instead of a UNIQUE failure, and a ghost is
//     never exported as the topic's own question.
//
// No model calls, no network beyond the loopback server it starts. Scratch
// database and vault, set IN-PROCESS before anything is imported.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const B = new URL('../server/', import.meta.url).href;

// A second boot of the SAME library, in its own process: the migration that
// gives old rows their ids runs when database.js is opened, so that is the
// only honest way to exercise it.
if (process.argv[2] === '--boot-only') {
    process.env.DB_PATH = process.argv[3];
    process.env.VAULT_ROOT = process.argv[4];
    const { default: bootDb } = await import(B + 'database.js');
    bootDb.close();
    process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), 'item-identity-gates-'));
const DB_PATH = join(scratch, 'test.db');
const VAULT_ROOT = join(scratch, 'vault');
process.env.DB_PATH = DB_PATH;
process.env.VAULT_ROOT = VAULT_ROOT;

const { default: db } = await import(B + 'database.js');
const { bankOf, orderForAsking, logAsked, askedCount } = await import(B + 'questionLog.js');

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const stored = (quizId) => JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(quizId).questions);
const withoutUuid = ({ uuid, ...rest }) => rest;

const projectId = db.prepare("INSERT INTO projects (name) VALUES ('Fixture: identity')").run().lastInsertRowid;
const nodeId = db.prepare("INSERT INTO nodes (project_id, title) VALUES (?, 'Lidwoorden')").run(projectId).lastInsertRowid;
const mc = (i) => ({ question: `Q${i}?`, type: 'multiple_choice', options: ['de', 'het'], correct_answer: 'de', explanation: `e${i}` });

console.log('--- a card has a uuid, whatever inserted it ---');
const insertCard = db.prepare('INSERT INTO flashcards (node_id, front, back) VALUES (?, ?, ?)');
const c1 = insertCard.run(nodeId, 'de krant', 'газета').lastInsertRowid;
const c2 = insertCard.run(nodeId, 'het huis', 'дом').lastInsertRowid;
const cardUuid = (id) => db.prepare('SELECT uuid FROM flashcards WHERE id = ?').get(id).uuid;
check('a bare INSERT gets a v4 uuid', UUID_RE.test(cardUuid(c1)), true);
check('...a different one per card', cardUuid(c1) !== cardUuid(c2), true);
check('two cards cannot share one (the column is UNIQUE)', (() => {
    try { db.prepare('UPDATE flashcards SET uuid = ? WHERE id = ?').run(cardUuid(c1), c2); return 'allowed'; }
    catch (e) { return /UNIQUE/.test(e.message) ? 'refused' : e.message; }
})(), 'refused');

console.log('\n--- a question a topic owns has a uuid inside its JSON ---');
const KEPT = '6f1c2a4e-9b3d-4c8e-a1f2-0d9e8b7c6a51';
const ghost = { ...mc(9), isGhost: true, ghostNodeId: 999 };
const raw = [mc(1), { ...mc(2), uuid: KEPT }, ghost, mc(3)];
const quizId = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)')
    .run(nodeId, 'bank', JSON.stringify(raw)).lastInsertRowid;
let qs = stored(quizId);
check('every own question got a v4 uuid on INSERT', [0, 1, 3].map(i => UUID_RE.test(qs[i].uuid || '')), [true, true, true]);
check('...each a different one', new Set([qs[0].uuid, qs[1].uuid, qs[3].uuid]).size, 3);
check('a question that arrived with a uuid keeps it', qs[1].uuid, KEPT);
check('a ghost (a copy of ANOTHER topic’s question) is never given one', 'uuid' in qs[2], false);
check('nothing else about any question changed, and the order held', qs.map(withoutUuid), raw.map(withoutUuid));

// The answer check's rewrite: vetoed questions go, the rest keep their objects.
const first = qs[0].uuid;
db.prepare('UPDATE quizzes SET questions = ? WHERE id = ?').run(JSON.stringify([qs[1], qs[3], mc(4)]), quizId);
qs = stored(quizId);
check('a rewrite keeps the uuids the kept questions already had', [qs[0].uuid, qs[1].uuid !== first], [KEPT, true]);
check('...and a question added by the rewrite is stamped too', UUID_RE.test(qs[2].uuid || ''), true);
check('a row that is not valid JSON is left alone rather than failing the write',
    db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(nodeId, 'broken', '[{"question":').changes, 1);

console.log('\n--- the ask-record names the QUESTION, so a rewritten bank keeps its memory ---');
// Fresh bank of four; ask the third; then delete the first (what vetQuiz does).
const bankId = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)')
    .run(nodeId, 'log', JSON.stringify([mc(11), mc(12), mc(13), mc(14)])).lastInsertRowid;
const before = stored(bankId);
logAsked([{ quizId: bankId, index: 2, correct: true }], 'quiz');
check('the log row carries the uuid of the question that was asked',
    db.prepare('SELECT question_uuid FROM question_log WHERE quiz_id = ? ORDER BY id DESC LIMIT 1').get(bankId).question_uuid, before[2].uuid);
db.prepare('UPDATE quizzes SET questions = ? WHERE id = ?').run(JSON.stringify(before.slice(1)), bankId);
const after = stored(bankId);
check('control: the fixture really moves the asked question (Q13 was at 2, is now at 1)',
    [before[2].question, after[1].question, after[2].question], ['Q13?', 'Q13?', 'Q14?']);
const own = bankOf(nodeId).filter(b => b.quizId === bankId);
const order = orderForAsking(own).map(b => b.question.question);
check('after the rewrite, the question actually asked is still the one drawn LAST', order[order.length - 1], 'Q13?');
check('control: a POSITIONAL record would now name Q14 — a question never asked',
    after[db.prepare('SELECT question_index FROM question_log WHERE quiz_id = ?').get(bankId).question_index].question, 'Q14?');
check('the asked count still counts one question, not one position', askedCount(nodeId), 1);

console.log('\n--- rows written before any of this get their ids on the next boot ---');
db.exec('DROP TRIGGER IF EXISTS quizzes_question_uuid_ai');
db.exec('DROP TRIGGER IF EXISTS quizzes_question_uuid_au');
const oldQuiz = db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)')
    .run(nodeId, 'old', JSON.stringify([mc(21), mc(22)])).lastInsertRowid;
db.prepare(`INSERT INTO question_log (quiz_id, question_index, node_id, surface, asked_at)
            VALUES (?, 1, ?, 'quiz', '2026-01-01T00:00:00.000Z')`).run(oldQuiz, nodeId);
check('control: the old row really has no ids before the boot', stored(oldQuiz).some(q => 'uuid' in q), false);
const boot = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--boot-only', DB_PATH, VAULT_ROOT], { encoding: 'utf8', timeout: 60_000 });
check('a second process opened the same library cleanly', boot.status, 0);
if (boot.status !== 0) console.log(boot.stdout, boot.stderr);
const healed = stored(oldQuiz);
check('the old bank’s questions have uuids now', healed.map(q => UUID_RE.test(q.uuid || '')), [true, true]);
check('...and the old log row was given the uuid of the question at its position',
    db.prepare('SELECT question_uuid FROM question_log WHERE quiz_id = ?').get(oldQuiz).question_uuid, healed[1].uuid);
check('the stamping triggers are back for everything written after the boot',
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'quizzes_question_uuid_%'").get().n, 2);
const healedAgain = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--boot-only', DB_PATH, VAULT_ROOT], { encoding: 'utf8', timeout: 60_000 });
check('a third boot changes nothing (the ids are not re-minted)', [healedAgain.status, stored(oldQuiz).map(q => q.uuid)], [0, healed.map(q => q.uuid)]);

console.log('\n--- the file carries both ids out and back in ---');
// The real routes, on a loopback port, against this scratch library. PORT is
// set in-process like DB_PATH; a taken port makes serverReady reject rather
// than letting some other server answer.
process.env.PORT = String(35000 + Math.floor(Math.random() * 20000));
process.env.HOST = '127.0.0.1';
const { serverReady } = await import(B + 'index.js');
const ready = await serverReady;
// A checkout with `.certs` serves HTTPS with a locally-made certificate that
// Node's own store does not trust; CI has none and serves HTTP. The client is
// node:http(s) rather than fetch because only there can one request accept
// this one loopback server's certificate without loosening TLS process-wide.
const { request } = await import(ready.proto === 'https' ? 'node:https' : 'node:http');
const api = (path, init = {}) => new Promise((resolve, reject) => {
    const req = request({
        host: '127.0.0.1', port: ready.port, path, method: init.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        rejectUnauthorized: false,
    }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
            let body = null;
            try { body = JSON.parse(text); } catch { /* not JSON */ }
            resolve({ status: res.statusCode, body });
        });
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
});
// Guard: nothing below writes until the server has proved it is serving THIS
// scratch library (the rule a write-capable harness learned the hard way).
const listed = await api('/api/projects');
const names = Array.isArray(listed.body) ? listed.body.map(p => p.name) : listed.body;
check('guard: the server is serving the scratch library and nothing else', names, ['Fixture: identity']);
if (JSON.stringify(names) !== JSON.stringify(['Fixture: identity'])) {
    console.log('\nRefusing to write: the server is not serving the fixture.');
    process.exit(1);
}

// Stems long enough to clear the importer's own mechanical gate (the short
// `Q1?` shape above never goes through it).
const lidwoord = (word) => ({
    question: `Welk lidwoord hoort bij het woord "${word}"?`, type: 'multiple_choice',
    options: ['de', 'het'], correct_answer: 'de', explanation: `"${word}" is een de-woord.`,
});
const Q_FILE = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a';
const C_FILE = '2d4f6a8c-1e3b-4d5f-9a7c-8e0b2d4f6a8c';
const course = {
    project: { name: 'Nederlands', version: '1.0', uuid: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d' },
    nodes: [{
        title: 'Lidwoorden', uuid: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        // One of each is marked as a model's in the file; the other is a person's.
        questions: [{ ...lidwoord('krant'), uuid: Q_FILE, generated_by: 'model-from-the-file' }, lidwoord('tafel')],
        flashcards: [{ front: 'de krant', back: 'газета', uuid: C_FILE, generated_by: 'card-model-from-the-file' }, { front: 'het huis', back: 'дом' }],
    }],
};
const imported = await api('/api/import', { method: 'POST', body: JSON.stringify(course) });
check('the course imports, every question and card with it', [imported.status, imported.body?.questionCount, imported.body?.cardCount], [200, 2, 2]);
const newId = imported.body?.id;
const topicId = db.prepare('SELECT id FROM nodes WHERE project_id = ?').get(newId)?.id;
const importedQs = JSON.parse(db.prepare('SELECT questions FROM quizzes WHERE node_id = ?').get(topicId).questions);
check('a question keeps the uuid the file gave it; the one without is minted',
    [importedQs[0].uuid, UUID_RE.test(importedQs[1].uuid || '')], [Q_FILE, true]);
const importedCards = db.prepare('SELECT front, uuid FROM flashcards WHERE node_id = ? ORDER BY id').all(topicId);
check('a card keeps the uuid the file gave it; the one without is minted',
    [importedCards[0].uuid, UUID_RE.test(importedCards[1].uuid || '')], [C_FILE, true]);

// The learner then studies it: THIS app's model writes a practice quiz (which
// carries a ghost from elsewhere) and a card. Both rows name the model the way
// `aiProvenance()` does.
const OUR_CALL = JSON.stringify({ provider: 'openai', model: 'z-ai/glm-5.3-flash' });
db.prepare('INSERT INTO quizzes (node_id, title, questions, generated_by) VALUES (?, ?, ?, ?)')
    .run(topicId, 'practice', JSON.stringify([
        lidwoord('stoel'),
        { ...mc(99), isGhost: true, ghostNodeId: 12345 },
        // A question that names its own model inside a row our model wrote:
        // the item's own mark is the more specific claim, and it wins.
        { ...lidwoord('lamp'), generated_by: 'its-own-model' },
    ]), OUR_CALL);
db.prepare('INSERT INTO flashcards (node_id, front, back, generated_by) VALUES (?, ?, ?, ?)').run(topicId, 'de stoel', 'стул', OUR_CALL);
const exported = await api(`/api/export/${newId}`);
const eNode = exported.body?.nodes?.[0];
check('the export writes every card’s uuid', eNode?.flashcards?.slice(0, 2).map(c => c.uuid), importedCards.map(c => c.uuid));
check('...and every question’s', eNode?.questions?.slice(0, 2).map(q => q.uuid), importedQs.map(q => q.uuid));
check('a ghost copy of another topic’s question is never exported as this topic’s own',
    eNode?.questions?.some(q => q.isGhost || q.question === 'Q99?'), false);

console.log('\n--- the file says which model wrote each item ---');
const marks = (items) => items?.map(i => i.generated_by ?? null);
check('questions: the file’s own mark, none on the person’s, and this app’s model on the one it wrote',
    marks(eNode?.questions), ['model-from-the-file', null, 'z-ai/glm-5.3-flash', 'its-own-model']);
check('cards: the same three cases', marks(eNode?.flashcards), ['card-model-from-the-file', null, 'z-ai/glm-5.3-flash']);
check('the mark is the model id alone — the provider never leaves the machine',
    JSON.stringify(eNode).includes('openai'), false);
check('an imported card the file did NOT mark stays NULL in the column (nobody generated it that we know of)',
    db.prepare('SELECT generated_by FROM flashcards WHERE uuid = ?').get(importedCards[1].uuid).generated_by, null);
check('an imported card the file DID mark records the claim as the file’s, not as a call this app made',
    JSON.parse(db.prepare('SELECT generated_by FROM flashcards WHERE uuid = ?').get(C_FILE).generated_by), { model: 'card-model-from-the-file', via: 'import' });

const second = await api('/api/import', { method: 'POST', body: JSON.stringify(exported.body) });
check('the same file imported again on the same machine is a second copy, not a UNIQUE failure', second.status, 200);
const secondTopic = db.prepare('SELECT id FROM nodes WHERE project_id = ?').get(second.body?.id)?.id;
const secondCards = db.prepare('SELECT uuid FROM flashcards WHERE node_id = ? ORDER BY id').all(secondTopic).map(r => r.uuid);
check('...whose cards get fresh uuids, because the file’s are taken here', secondCards.some(u => importedCards.map(c => c.uuid).includes(u)), false);
check('...and still carries every card', secondCards.length, 3);
const reExported = await api(`/api/export/${second.body?.id}`);
check('importing and exporting again cannot wash a mark out — questions',
    marks(reExported.body?.nodes?.[0]?.questions), ['model-from-the-file', null, 'z-ai/glm-5.3-flash', 'its-own-model']);
check('...nor cards', marks(reExported.body?.nodes?.[0]?.flashcards), ['card-model-from-the-file', null, 'z-ai/glm-5.3-flash']);

console.log('\n--- a bundle document finds its topic by identity, not by title ---');
// Two sibling topics may share a title. A bundle used to record a document's
// topic as a path of titles only, and the import map kept the LAST topic with
// that path, so a document on the first "Same" moved to the second without a
// word (reproduced by the first outside audit, 2026-09-24).
const rawReq = (path, init = {}) => new Promise((resolve, reject) => {
    const req = request({
        host: '127.0.0.1', port: ready.port, path, method: init.method || 'GET',
        headers: init.headers || {}, rejectUnauthorized: false,
    }, (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
});
const uploadBundle = async (buf) => {
    const boundary = `----gate${Date.now()}`;
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="course.studyvault"\r\nContent-Type: application/zip\r\n\r\n`),
        buf,
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await rawReq('/api/import/bundle', {
        method: 'POST', body,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
    });
    let json = null;
    try { json = JSON.parse(r.buf.toString('utf8')); } catch { /* not JSON */ }
    return { status: r.status, body: json };
};
const twins = await api('/api/import', { method: 'POST', body: JSON.stringify({
    project: { name: 'Twins' },
    nodes: [{ title: 'Unit', children: [{ title: 'Same' }, { title: 'Same' }] }],
}) });
const twinIds = db.prepare('SELECT n.id FROM nodes n JOIN nodes p ON p.id = n.parent_id WHERE n.project_id = ? ORDER BY n.position').all(twins.body?.id).map(r => r.id);
check('fixture: two sibling topics share the title "Same"', twinIds.length, 2);
await api('/api/documents', { method: 'POST', body: JSON.stringify({ nodeId: twinIds[0], title: 'Notes on the first', content: 'The first twin carries this document.' }) });
const zipped = await rawReq(`/api/export/${twins.body?.id}/bundle`);
check('the bundle exports', zipped.status, 200);
const JSZip = (await import('jszip')).default;
const manifestOf = async (buf) => JSON.parse(await (await JSZip.loadAsync(buf)).file('manifest.json').async('string'));
const exportedDoc = (await manifestOf(zipped.buf)).documents?.[0] || {};
check('the bundle records the document’s topic by uuid', UUID_RE.test(exportedDoc.node_uuid || ''), true);
const docTopicOf = (projectId) => {
    const row = db.prepare('SELECT d.node_id, d.project_id FROM documents d WHERE d.title = ? AND (d.project_id = ? OR d.node_id IN (SELECT id FROM nodes WHERE project_id = ?))').get('Notes on the first', projectId, projectId);
    if (!row) return 'missing';
    if (!row.node_id) return 'project level';
    return db.prepare('SELECT position FROM nodes WHERE id = ?').get(row.node_id).position;
};
const back = await uploadBundle(zipped.buf);
check('the bundle imports', back.status, 200);
check('the document lands on the FIRST "Same", where it was', docTopicOf(back.body?.id), 0);
// An older bundle has the title path only: two topics answer to it, so the
// document is kept at project level and the import says why.
const legacyZip = await JSZip.loadAsync(zipped.buf);
const legacyManifest = JSON.parse(await legacyZip.file('manifest.json').async('string'));
for (const d of legacyManifest.documents || []) delete d.node_uuid;
legacyZip.file('manifest.json', JSON.stringify(legacyManifest));
const legacy = await uploadBundle(await legacyZip.generateAsync({ type: 'nodebuffer' }));
check('an older bundle with a shared title path keeps the document at project level, not on a guess',
    docTopicOf(legacy.body?.id), 'project level');
check('...and says so in the import warnings',
    (legacy.body?.warnings || []).some(w => /title path is shared/.test(w)), true);

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);

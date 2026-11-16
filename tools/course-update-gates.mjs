// tools/course-update-gates.mjs — a newer file updates the course the learner has.
//
// Run:  node tools/course-update-gates.mjs
//       node tools/course-update-gates.mjs --old-import   (must FAIL: today's door)
//
// POST /api/import makes a NEW project from any file: a newer edition through
// it puts the new text in one project and the learner's mastery, schedule and
// notes in the other. This gate installs an edition, studies it the way the app records
// study, applies a newer file, and asserts on the course the learner now has.
// Each of the seven cases is one rule of the update:
//
//   1. fast-forward      what the author changed arrives; nothing of the learner's moves
//   2. conflict          a field both sides changed keeps the learner's version
//   3. removed+progress  a topic the file dropped is kept when it holds progress
//   4. moved             a topic the file moved keeps its mastery
//   5. second run        the same file again changes nothing
//   6. older file        a file older than the installed edition is refused
//   7. pre-id fallback   a file without item ids is matched by content
//
// `--old-import` sends every update through POST /api/import instead: every
// case must fail there, and the default run proves it once more as a control.
//
// No model calls, no network beyond the loopback server it starts. Scratch
// database and vault, set IN-PROCESS before anything is imported.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const OLD = process.argv.includes('--old-import');
const B = new URL('../server/', import.meta.url).href;

const scratch = mkdtempSync(join(tmpdir(), 'course-update-gates-'));
process.env.DB_PATH = join(scratch, 'test.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.PORT = String(await new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
}));
process.env.HOST = '127.0.0.1';

const { default: db } = await import(B + 'database.js');
const { logAsked } = await import(B + 'questionLog.js');
// The old door needs none of the new code, so `--old-import` runs on a tree without it.
const { planCourseUpdate, fieldHash } = OLD ? {} : await import(B + 'courseMerge.js');

let pass = 0, fail = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else fail++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ---- the planner alone: no database, no files ---------------------------------
if (!OLD) {
    console.log('--- the planner, field by field (dpkg rule + the learner-edit flag) ---');
    const ent = (fields, extra = {}) => ({ kind: 'node', uuid: 'n1', parentUuid: null, position: 0, fields, ...extra });
    const base = (fields, edited = []) => new Map([['node:n1', {
        fields: Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, { hash: fieldHash(v), edited: edited.includes(f) }])),
    }]]);
    const plan = (up, local, b) => planCourseUpdate({
        upstream: { exportedAt: '2026-02-01T00:00:00.000Z', project: { fields: {} }, entities: [ent(up)] },
        local: { project: { fields: {} }, entities: [{ ...ent(local), id: 1, hasState: true }] },
        base: { exportedAt: '2026-01-01T00:00:00.000Z', project: { fields: {} }, entities: b },
    });
    const takenOf = (p) => p.ops.filter(o => o.op === 'update').flatMap(o => Object.keys(o.fields));
    const conflictsOf = (p) => p.conflicts.map(c => c.field);
    let p = plan({ title: 'same' }, { title: 'mine' }, base({ title: 'same' }, ['title']));
    check('upstream unchanged, local edited: nothing to do', [takenOf(p), conflictsOf(p)], [[], []]);
    p = plan({ title: 'new' }, { title: 'old' }, base({ title: 'old' }));
    check('upstream changed, local untouched: take upstream', [takenOf(p), conflictsOf(p)], [['title'], []]);
    p = plan({ title: 'new' }, { title: 'repaired by the app' }, base({ title: 'old' }));
    check('upstream changed, local changed by the APP (no flag): take upstream', [takenOf(p), conflictsOf(p)], [['title'], []]);
    p = plan({ title: 'new' }, { title: 'mine' }, base({ title: 'old' }, ['title']));
    check('upstream changed, learner edited: a conflict, nothing taken', [takenOf(p), conflictsOf(p)], [[], ['title']]);
    p = plan({ title: 'same' }, { title: 'same' }, base({ title: 'old' }, ['title']));
    check('both sides arrived at the same text: nothing to do', [takenOf(p), conflictsOf(p)], [[], []]);
    p = plan({ title: 'new' }, { title: 'old' }, new Map());
    check('no base record (installed before this existed): a difference is a conflict, never a guess', conflictsOf(p), ['title']);
    p = planCourseUpdate({
        upstream: { exportedAt: '2026-01-01T00:00:00.000Z', project: { fields: {} }, entities: [] },
        local: { project: { fields: {} }, entities: [] },
        base: { exportedAt: '2026-02-01T00:00:00.000Z', project: { fields: {} }, entities: new Map() },
    });
    check('a file older than the base is refused by the planner itself', p.refused, 'older');

    console.log('\n--- the planner, whole courses ---');
    const topicFields = (title, description = null) => ({ title, description, is_note: 0, role: 'topic' });
    const upNode = (ref, parentRef, position, fields) => ({ kind: 'node', uuid: null, ref, parentRef, position, fields });
    const locNode = (uuid, id, parentUuid, position, fields, extra = {}) => ({ kind: 'node', uuid, id, parentUuid, position, fields, hasState: false, ...extra });
    /** The base a course installed from a file has: every field as it stands, none edited. */
    const baseOf = (entities, edited = {}) => new Map(entities.map(e => [`${e.kind}:${e.uuid}`, {
        fields: Object.fromEntries(Object.entries({ ...e.fields, parent: e.parentUuid ?? null, ...(e.kind === 'node' ? { position: e.position } : {}) })
            .map(([f, v]) => [f, { hash: fieldHash(v), edited: (edited[e.uuid] || []).includes(f) }])),
    }]));
    const planWhole = (upEntities, locEntities, edited) => planCourseUpdate({
        upstream: { exportedAt: '2026-02-01T00:00:00.000Z', project: { fields: {} }, entities: upEntities },
        local: { project: { fields: {} }, entities: locEntities },
        base: { exportedAt: '2026-01-01T00:00:00.000Z', project: { fields: {} }, entities: baseOf(locEntities, edited) },
    });
    const opsOf = (pl, ...kinds) => pl.ops.filter(o => kinds.includes(o.op)).map(o => `${o.op}:${o.uuid ?? o.ref}`);

    // Two id-less sections share a title and both changed: neither can be told
    // apart, so nothing under them is inserted at the top or deleted.
    let local = [locNode('s1', 1, null, 0, topicFields('S', 'old 1')), locNode('s2', 2, null, 1, topicFields('S', 'old 2')),
        locNode('c1', 3, 's1', 0, topicFields('Child')), locNode('c2', 4, 's2', 0, topicFields('Child'))];
    p = planWhole([upNode('a', null, 0, topicFields('S', 'new 1')), upNode('a1', 'a', 0, topicFields('Child')),
        upNode('b', null, 1, topicFields('S', 'new 2')), upNode('b1', 'b', 0, topicFields('Child'))], local);
    check('an unmatched section holds down its branch: nothing under it inserted or deleted', opsOf(p, 'insert', 'delete'), []);

    // A card the learner edited and the file dropped is theirs now, not deleted.
    const card = { kind: 'card', uuid: 'k1', id: 9, parentUuid: 'n1', fields: { front: 'f', back: 'my back', extra: null, extra_front: null, media: null }, hasState: false };
    local = [locNode('n1', 1, null, 0, topicFields('N')), card];
    p = planWhole([{ ...upNode('n1', null, 0, topicFields('N')), uuid: 'n1' }], local, { k1: ['back'] });
    check('a dropped card the learner edited is kept, never deleted', opsOf(p, 'insert', 'delete', 'keepRemoved'), ['keepRemoved:k1']);

    // Only the order of two topics changed.
    local = [locNode('x', 1, null, 0, topicFields('X')), locNode('y', 2, null, 1, topicFields('Y'))];
    p = planWhole([{ ...upNode('y', null, 0, topicFields('Y')), uuid: 'y' }, { ...upNode('x', null, 1, topicFields('X')), uuid: 'x' }], local);
    check('a file that only reorders topics is an update, not "nothing"', [p.summary.nothing, p.summary.reordered, p.reorder[0]?.children], [false, 1, ['y', 'x']]);

    // The learner put A under B; the file puts B under A.
    local = [locNode('A', 1, 'B', 0, topicFields('A')), locNode('B', 2, null, 0, topicFields('B'))];
    const loopBase = baseOf([locNode('A', 1, null, 0, topicFields('A')), locNode('B', 2, null, 1, topicFields('B'))], { A: ['parent'] });
    p = planCourseUpdate({
        upstream: { exportedAt: '2026-02-01T00:00:00.000Z', project: { fields: {} },
            entities: [{ ...upNode('A', null, 0, topicFields('A')), uuid: 'A' }, { ...upNode('B', 'A', 0, topicFields('B')), uuid: 'B' }] },
        local: { project: { fields: {} }, entities: local },
        base: { exportedAt: '2026-01-01T00:00:00.000Z', project: { fields: {} }, entities: loopBase },
    });
    check('two moves that would make a loop: the learner’s stands, the file’s is not taken',
        [p.ops.filter(o => 'parent' in (o.fields || {})).map(o => o.uuid), p.newBase.find(b => b.uuid === 'B')?.fields.parent?.edited], [[], 1]);

    // The learner deleted a card that had media; the next file is plain JSON,
    // which names no media, and leaves the card as it was.
    const keepTopic = locNode('n1', 1, null, 0, topicFields('N'));
    const mediaCard = { kind: 'card', uuid: 'k2', id: 10, parentUuid: 'n1',
        fields: { front: 'f', back: 'b', extra: null, extra_front: null, media: { front: [{ name: 'a.png', kind: 'image', alt: null }] } } };
    p = planCourseUpdate({
        upstream: { exportedAt: '2026-02-01T00:00:00.000Z', project: { fields: {} }, entities: [{ ...upNode('n1', null, 0, topicFields('N')), uuid: 'n1' },
            { kind: 'card', uuid: 'k2', ref: 'k2', parentRef: 'n1', fields: { front: 'f', back: 'b', extra: null, extra_front: null } }] },
        local: { project: { fields: {} }, entities: [keepTopic] },
        base: { exportedAt: '2026-01-01T00:00:00.000Z', project: { fields: {} }, entities: baseOf([keepTopic, mediaCard]) },
    });
    check('a deleted card a media-less file did not change stays deleted, no conflict', [p.conflicts.length, opsOf(p, 'insert')], [0, []]);

    // The learner deleted topic P; the file leaves P as it was and adds D under it.
    const otherTopic = locNode('Q', 2, null, 1, topicFields('Q'));
    p = planCourseUpdate({
        upstream: { exportedAt: '2026-02-01T00:00:00.000Z', project: { fields: {} }, entities: [{ ...upNode('P', null, 0, topicFields('P')), uuid: 'P' },
            upNode('d', 'P', 0, topicFields('D')), upNode('d1', 'd', 0, topicFields('D1')), { ...upNode('Q', null, 1, topicFields('Q')), uuid: 'Q' }] },
        local: { project: { fields: {} }, entities: [otherTopic] },
        base: { exportedAt: '2026-01-01T00:00:00.000Z', project: { fields: {} }, entities: baseOf([locNode('P', 1, null, 0, topicFields('P')), otherTopic]) },
    });
    check('nothing new is put under a topic the learner deleted (no orphan at the top)', [opsOf(p, 'insert'), p.conflicts.length], [[], 0]);
}

// ---- the server, on a loopback port, serving the scratch library ---------------
const { serverReady } = await import(B + 'index.js');
const ready = await serverReady;
const { request } = await import(ready.proto === 'https' ? 'node:https' : 'node:http');
const call = (path, { method = 'GET', body = null, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: ready.port, path, method, headers, rejectUnauthorized: false }, (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => {
            let json = null;
            try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { /* not JSON */ }
            resolve({ status: res.statusCode, body: json });
        });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
});
const api = (path, method = 'GET', json = undefined) => call(path, {
    method, body: json === undefined ? null : JSON.stringify(json), headers: { 'Content-Type': 'application/json' },
});
const upload = (path, file, fields = {}) => {
    const boundary = `----gate${Date.now()}${Math.random().toString(16).slice(2)}`;
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="course.json"\r\nContent-Type: application/json\r\n\r\n`));
    // A Buffer is a bundle's bytes; anything else is a course file's JSON.
    parts.push(Buffer.isBuffer(file) ? file : Buffer.from(JSON.stringify(file)));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    return call(path, { method: 'POST', body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) } });
};

const listed = await api('/api/projects');
check('guard: the server is serving the empty scratch library', Array.isArray(listed.body) ? listed.body.length : listed.body, 0);
if (!Array.isArray(listed.body) || listed.body.length) {
    console.log('\nRefusing to write: the server is not serving the fixture.');
    process.exit(1);
}

// ---- the fixture: one course, two editions -------------------------------------
// Every case installs its own copy, so every id is derived from the case.
const u = (tag, name) => {
    const h = createHash('sha256').update(`${tag}:${name}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const q = (stem, answer, extra = {}) => ({
    question: stem, type: 'multiple_choice', options: ['de', 'het'], correct_answer: answer,
    explanation: `Het juiste lidwoord is "${answer}".`, ...extra,
});
const V1_AT = '2026-11-01T09:00:00.000Z';
const V2_AT = '2026-11-10T09:00:00.000Z';
function edition1(tag, { itemIds = true } = {}) {
    const id = (name) => (itemIds ? u(tag, name) : undefined);
    return {
        exported_at: V1_AT,
        project: { name: `Course ${tag}`, uuid: u(tag, 'project'), version: '1', description: 'Dutch articles' },
        nodes: [
            { title: 'Unit 1', uuid: u(tag, 'U1'), children: [
                { title: 'Lidwoorden', uuid: u(tag, 'A'), description: 'Overview A, first edition.',
                    questions: [
                        q('Welk lidwoord hoort bij het woord "krant"?', 'de', { uuid: id('Q1') }),
                        q('Welk lidwoord hoort bij het woord "huis"?', 'het', { uuid: id('Q2') }),
                    ],
                    flashcards: [
                        { front: 'de krant', back: 'newspaper', uuid: id('C1') },
                        { front: 'het huis', back: 'house', uuid: id('C2') },
                    ] },
                { title: 'Meervoud', uuid: u(tag, 'B'), description: 'Overview B.',
                    questions: [q('Welk lidwoord hoort bij het meervoud "kranten"?', 'de', { uuid: id('Q3') })] },
                { title: 'Verkleinwoord', uuid: u(tag, 'D'), description: 'Overview D.' },
            ] },
            { title: 'Unit 2', uuid: u(tag, 'U2'), children: [
                { title: 'Woordvolgorde', uuid: u(tag, 'E'), description: 'Overview E.' },
            ] },
        ],
    };
}
/** The next edition: a copy of edition 1 with `change` applied to it. */
const edition2 = (tag, change, opts) => {
    const file = structuredClone(edition1(tag, opts));
    file.exported_at = V2_AT;
    file.project.version = '2';
    change(file);
    return file;
};
const unit1 = (f) => f.nodes[0].children;
const topic = (f, title) => f.nodes.flatMap(n => [n, ...(n.children || [])]).find(n => n.title === title);

// ---- reading the library --------------------------------------------------------
const nodeOf = (projectId, title) => db.prepare('SELECT * FROM nodes WHERE project_id = ? AND title = ?').get(projectId, title);
const copiesOf = (tag) => db.prepare('SELECT COUNT(*) AS n FROM projects WHERE name = ?').get(`Course ${tag}`).n;
const evidenceOn = (nodeId) => (nodeId ? db.prepare('SELECT COUNT(*) AS n FROM mastery_evidence WHERE node_id = ?').get(nodeId).n : 0);
const masteryOn = (nodeId) => (nodeId ? db.prepare('SELECT mastery_score FROM node_mastery WHERE node_id = ?').get(nodeId)?.mastery_score ?? null : null);
const cardsOf = (nodeId) => (nodeId ? db.prepare('SELECT id, front, back, review_count FROM flashcards WHERE node_id = ? ORDER BY id').all(nodeId) : []);
const bankOf = (nodeId) => (nodeId ? db.prepare('SELECT questions FROM quizzes WHERE node_id = ? ORDER BY id').all(nodeId)
    .flatMap(r => JSON.parse(r.questions)) : []);
const askedRows = (nodeId) => (nodeId ? db.prepare('SELECT question_uuid FROM question_log WHERE node_id = ? ORDER BY id').all(nodeId).map(r => r.question_uuid) : []);
/** Every author-owned value of a project, for "nothing changed". */
const fingerprint = (projectId) => JSON.stringify({
    p: db.prepare('SELECT name, description, version FROM projects WHERE id = ?').get(projectId),
    n: db.prepare('SELECT id, parent_id, title, description, position, status FROM nodes WHERE project_id = ? ORDER BY id').all(projectId),
    q: db.prepare('SELECT q.id, q.questions FROM quizzes q JOIN nodes n ON n.id = q.node_id WHERE n.project_id = ? ORDER BY q.id').all(projectId),
    c: db.prepare('SELECT f.id, f.front, f.back, f.review_count FROM flashcards f JOIN nodes n ON n.id = f.node_id WHERE n.project_id = ? ORDER BY f.id').all(projectId),
    l: db.prepare('SELECT ql.id FROM question_log ql JOIN nodes n ON n.id = ql.node_id WHERE n.project_id = ? ORDER BY ql.id').all(projectId),
});

// ---- installing, studying, updating ----------------------------------------------
async function install(file) {
    const r = await api('/api/import', 'POST', file);
    if (r.status !== 200) throw new Error(`install failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id;
}
/** Study the course the way the app records it: evidence and mastery on two
 *  topics, a reviewed card, an asked question, the learner's own note. */
function study(projectId) {
    const a = nodeOf(projectId, 'Lidwoorden');
    const b = nodeOf(projectId, 'Meervoud');
    for (const n of [a, b]) {
        db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total, created_at) VALUES (?, 'quiz', 1, 1, '2026-11-05T10:00:00.000Z')").run(n.id);
        db.prepare('INSERT INTO node_mastery (node_id, mastery_score, total_attempts, correct_attempts) VALUES (?, 0.8, 1, 1)').run(n.id);
        db.prepare("UPDATE nodes SET status = 'in_progress' WHERE id = ?").run(n.id);
    }
    db.prepare("UPDATE nodes SET notes = 'my own note' WHERE id = ?").run(b.id);
    const card = db.prepare("SELECT id FROM flashcards WHERE node_id = ? AND front = 'de krant'").get(a.id);
    db.prepare("UPDATE flashcards SET review_count = 3, state = 2, last_reviewed = '2026-11-05T10:00:00.000Z' WHERE id = ?").run(card.id);
    db.prepare("INSERT INTO review_log (card_id, rating, reviewed_at) VALUES (?, 3, '2026-11-05T10:00:00.000Z')").run(card.id);
    const quiz = db.prepare('SELECT id, questions FROM quizzes WHERE node_id = ? ORDER BY id').get(a.id);
    const qs = JSON.parse(quiz.questions);
    // Both of A's questions asked once.
    logAsked(qs.map((_, index) => ({ quizId: quiz.id, index, correct: true })), 'quiz');
}
/** Apply a newer file to the installed course. Returns the project the learner
 *  now studies: the same one after an update, a NEW one after today's import. */
async function update(projectId, file, choices = {}) {
    if (OLD) {
        const r = await api('/api/import', 'POST', file);
        return { projectId: r.body?.id, status: r.status, refused: r.status !== 200 };
    }
    const inspected = await upload('/api/course-updates/inspect', file);
    if (inspected.body?.refused) return { projectId, refused: true, inspected: inspected.body };
    const committed = await upload('/api/course-updates/commit', file, { projectId: String(projectId), choices: JSON.stringify(choices) });
    return { projectId: committed.body?.projectId ?? null, status: committed.status, inspected: inspected.body, committed: committed.body };
}

// ---- 1. fast-forward ------------------------------------------------------------
console.log('\n--- case 1, fast-forward: what the author changed arrives, the learner keeps everything ---');
{
    const tag = 'ff';
    const pid = await install(edition1(tag));
    study(pid);
    const aBefore = nodeOf(pid, 'Lidwoorden');
    const q2Before = askedRows(aBefore.id);
    const v2 = edition2(tag, (f) => {
        const a = topic(f, 'Lidwoorden');
        a.description = 'Overview A, second edition.';
        a.questions[0] = { ...a.questions[0], question: 'Welk lidwoord hoort bij "krant" (de krant)?' };
        a.flashcards[1] = { ...a.flashcards[1], back: 'house, home' };
        unit1(f).push({ title: 'Werkwoorden', uuid: u(tag, 'C'), description: 'Overview C.',
            flashcards: [{ front: 'lopen', back: 'to walk', uuid: u(tag, 'C3') }] });
    });
    const r = await update(pid, v2);
    const a = nodeOf(r.projectId, 'Lidwoorden');
    check('1 fast-forward: the library still holds ONE copy of the course', copiesOf(tag), 1);
    check('1 fast-forward: the learner’s course reads the new Overview', a?.description, 'Overview A, second edition.');
    check('1 fast-forward: ...and keeps the mastery the learner earned on it', [evidenceOn(a?.id), masteryOn(a?.id)], [1, 0.8]);
    check('1 fast-forward: the changed card has the new back and keeps its reviews',
        cardsOf(a?.id).map(c => [c.front, c.back, c.review_count]), [['de krant', 'newspaper', 3], ['het huis', 'house, home', 0]]);
    check('1 fast-forward: the new topic arrived', !!nodeOf(r.projectId, 'Werkwoorden'), true);
    check('1 fast-forward: the rewritten question no longer carries the old ask-record; the unchanged one keeps its own',
        askedRows(a?.id), q2Before.slice(1));
    check('1 fast-forward: the rewritten question kept its identity', bankOf(a?.id).map(x => x.uuid), [u(tag, 'Q1'), u(tag, 'Q2')]);
    if (!OLD) {
        const s = r.inspected?.summary || {};
        check('1 fast-forward: the preview counted it before anything was written', [s.changed, s.added, s.conflicts], [3, 2, 0]);
        const overview = (r.inspected?.items?.changed || []).find(it => it.kind === 'node')?.diff?.find(d => d.field === 'description');
        check('1 fast-forward: the preview shows the Overview as it reads now and after', [overview?.from, overview?.to], ['Overview A, first edition.', 'Overview A, second edition.']);
    }
}

// ---- 2. a conflict keeps the learner's version ------------------------------------
console.log('\n--- case 2, conflict: a field both sides changed keeps the learner’s version ---');
{
    const tag = 'conflict';
    const pid = await install(edition1(tag));
    study(pid);
    const aId = nodeOf(pid, 'Lidwoorden').id;
    // The learner renames the topic through the editor's own route.
    await api(`/api/nodes/${aId}`, 'PUT', { title: 'Lidwoorden (mijn titel)' });
    const v2 = edition2(tag, (f) => {
        const a = topic(f, 'Lidwoorden');
        a.title = 'De en het';
        a.description = 'Overview A, second edition.';
    });
    const r = await update(pid, v2);
    const a = db.prepare('SELECT * FROM nodes WHERE project_id = ? AND uuid = ?').get(r.projectId, u(tag, 'A'))
        || nodeOf(r.projectId, 'De en het');
    check('2 conflict: the learner’s title is kept', a?.title, 'Lidwoorden (mijn titel)');
    check('2 conflict: ...while the field only the author changed arrives', a?.description, 'Overview A, second edition.');
    check('2 conflict: ...on the course that carries the learner’s mastery', evidenceOn(a?.id), 1);
    if (!OLD) {
        const c = r.inspected?.conflicts?.[0];
        check('2 conflict: the preview shows both versions side by side', [c?.field, c?.mine, c?.file], ['title', 'Lidwoorden (mijn titel)', 'De en het']);
        // Choosing the file's version in the preview takes it. (Once an update
        // kept the learner's version, the same file asks nothing again: that
        // is case 5. So this is a second course, the choice made up front.)
        const ctag = 'conflict-choose';
        const cpid = await install(edition1(ctag));
        const caId = nodeOf(cpid, 'Lidwoorden').id;
        await api(`/api/nodes/${caId}`, 'PUT', { title: 'Lidwoorden (mijn titel)' });
        const cv2 = edition2(ctag, (f) => { topic(f, 'Lidwoorden').title = 'De en het'; });
        const pre = await upload('/api/course-updates/inspect', cv2);
        const key = pre.body?.conflicts?.[0]?.key;
        await upload('/api/course-updates/commit', cv2, { projectId: String(cpid), choices: JSON.stringify({ [key]: 'file' }) });
        check('2 conflict: choosing the file’s version for that item takes it', db.prepare('SELECT title FROM nodes WHERE id = ?').get(caId).title, 'De en het');
        check('2 conflict: ...and a conflict left as it is asks nothing again for the same file',
            (await upload('/api/course-updates/inspect', v2)).body?.summary?.nothing, true);
    }
}

// ---- 3. a removed topic that has progress is kept ---------------------------------
console.log('\n--- case 3, removed with progress: kept and reported; removed without progress: deleted ---');
{
    const tag = 'removed';
    const pid = await install(edition1(tag));
    study(pid);
    const bId = nodeOf(pid, 'Meervoud').id;
    const v2 = edition2(tag, (f) => {
        f.nodes[0].children = unit1(f).filter(n => n.title !== 'Meervoud' && n.title !== 'Verkleinwoord');
    });
    const r = await update(pid, v2);
    const b = nodeOf(r.projectId, 'Meervoud');
    check('3 removed: the dropped topic that holds progress is still in the learner’s course', b?.id ?? null, bId);
    check('3 removed: ...with its evidence and the learner’s note', [evidenceOn(b?.id), b?.notes], [1, 'my own note']);
    check('3 removed: the dropped topic with no progress is gone', nodeOf(r.projectId, 'Verkleinwoord') ?? null, null);
    if (!OLD) {
        check('3 removed: the preview lists the kept one as kept, the other as removed',
            [r.inspected?.items?.keptRemoved?.map(i => i.label), r.inspected?.items?.removed?.map(i => i.label)],
            [['Meervoud'], ['Verkleinwoord']]);
    }
}

// ---- 4. a moved topic keeps its mastery --------------------------------------------
console.log('\n--- case 4, moved: same topic row, new place, same mastery ---');
{
    const tag = 'moved';
    const pid = await install(edition1(tag));
    study(pid);
    const aId = nodeOf(pid, 'Lidwoorden').id;
    const v2 = edition2(tag, (f) => {
        const a = topic(f, 'Lidwoorden');
        f.nodes[0].children = unit1(f).filter(n => n !== a);
        f.nodes[1].children.unshift(a);
    });
    const r = await update(pid, v2);
    const a = nodeOf(r.projectId, 'Lidwoorden');
    const unit2 = nodeOf(r.projectId, 'Unit 2');
    check('4 moved: the topic is under its new parent, first', [a?.parent_id === unit2?.id, a?.position], [true, 0]);
    check('4 moved: ...as the same row', a?.id, aId);
    check('4 moved: ...with its mastery and evidence', [masteryOn(a?.id), evidenceOn(a?.id)], [0.8, 1]);
    check('4 moved: ...and its reviewed card', cardsOf(a?.id).map(c => c.review_count), [3, 0]);
    if (!OLD) {
        const moved = r.inspected?.items?.moved?.find(it => it.label === 'Lidwoorden');
        check('4 moved: the preview names where it goes', [moved?.where, moved?.to], ['Unit 1', 'Unit 2']);
    }
}

// ---- 5. a second run changes nothing ------------------------------------------------
console.log('\n--- case 5, second run: the same file again changes nothing ---');
{
    const tag = 'twice';
    const pid = await install(edition1(tag));
    study(pid);
    const v2 = edition2(tag, (f) => { topic(f, 'Lidwoorden').description = 'Overview A, second edition.'; });
    const first = await update(pid, v2);
    const after = fingerprint(first.projectId);
    const second = await update(first.projectId, v2);
    check('5 second run: the library still holds ONE copy', copiesOf(tag), 1);
    check('5 second run: nothing in the course changed the second time', fingerprint(second.projectId) === after, true);
    if (!OLD) check('5 second run: the preview says there is nothing to change', second.inspected?.summary?.nothing, true);
}

// ---- 6. an older file is refused -----------------------------------------------------
console.log('\n--- case 6, older file: refused, the installed edition stays ---');
{
    const tag = 'older';
    const pid = await install(edition1(tag));
    const v2 = edition2(tag, (f) => { topic(f, 'Lidwoorden').description = 'Overview A, second edition.'; });
    const first = await update(pid, v2);
    const back = await update(first.projectId, edition1(tag));
    check('6 older: the older file is refused', back.refused, true);
    check('6 older: the course still reads the newer edition', nodeOf(first.projectId, 'Lidwoorden')?.description, 'Overview A, second edition.');
    check('6 older: the library still holds ONE copy', copiesOf(tag), 1);
    if (!OLD) check('6 older: the refusal says why', /older/i.test(back.inspected?.message || ''), true);
}

// ---- 7. files that predate item ids ---------------------------------------------------
console.log('\n--- case 7, pre-id fallback: questions and cards matched by their text ---');
{
    const tag = 'preid';
    const pid = await install(edition1(tag, { itemIds: false }));
    study(pid);
    const a0 = nodeOf(pid, 'Lidwoorden');
    const cardIds = cardsOf(a0.id).map(c => c.id);
    const v2 = edition2(tag, (f) => {
        const a = topic(f, 'Lidwoorden');
        a.flashcards[1] = { ...a.flashcards[1], back: 'house, home' };
        a.questions[1] = { ...a.questions[1], explanation: 'Huis is een het-woord.' };
    }, { itemIds: false });
    const r = await update(pid, v2);
    const a = nodeOf(r.projectId, 'Lidwoorden');
    check('7 pre-id: the cards are the SAME rows, matched by their front', cardsOf(a?.id).map(c => c.id), cardIds);
    check('7 pre-id: ...the reviewed one keeps its reviews, the changed one has its new back',
        cardsOf(a?.id).map(c => [c.review_count, c.back]), [[3, 'newspaper'], [0, 'house, home']]);
    check('7 pre-id: the questions were matched by their stem: two, not four', bankOf(a?.id).length, 2);
    check('7 pre-id: ...and the changed one took the new explanation', bankOf(a?.id)[1]?.explanation, 'Huis is een het-woord.');
    if (!OLD) {
        // Two cards with one front: which is which cannot be told, so it is said, not guessed.
        const twin = 'preid-twin';
        const file = edition1(twin, { itemIds: false });
        topic(file, 'Lidwoorden').flashcards.push({ front: 'de krant', back: 'the paper' }, { front: 'de krant', back: 'a paper' });
        const tpid = await install(file);
        const v2t = edition2(twin, (f) => {
            topic(f, 'Lidwoorden').flashcards.push({ front: 'de krant', back: 'the newspaper' });
        }, { itemIds: false });
        const rt = await update(tpid, v2t);
        check('7 pre-id: a card whose front two local cards share is reported as ambiguous, and nothing is guessed or deleted',
            [rt.inspected?.summary?.ambiguous, cardsOf(nodeOf(tpid, 'Lidwoorden').id).map(c => c.back)],
            [1, ['newspaper', 'house', 'the paper', 'a paper']]);
    }
}

// ---- what the edit routes record, and undo ------------------------------------------
if (!OLD) {
    console.log('\n--- the learner-edit flag is set by the edit routes, never by the app’s own writes ---');
    const tag = 'flag';
    const pid = await install(edition1(tag));
    const a = nodeOf(pid, 'Lidwoorden');
    const flagOf = (kind, uuid, field) => db.prepare('SELECT edited FROM course_base WHERE project_id = ? AND kind = ? AND uuid = ? AND field = ?').get(pid, kind, uuid, field)?.edited ?? null;
    check('installing records the base, nothing flagged', [flagOf('node', a.uuid, 'title'), flagOf('node', a.uuid, 'description')], [0, 0]);
    db.prepare("UPDATE nodes SET description = 'A repaired fence' WHERE id = ?").run(a.id);
    check('an app write straight to the row sets no flag', flagOf('node', a.uuid, 'description'), 0);
    await api(`/api/nodes/${a.id}`, 'PUT', { description: 'My own Overview' });
    check('the editor’s PUT flags the field it wrote, and only that one', [flagOf('node', a.uuid, 'description'), flagOf('node', a.uuid, 'title')], [1, 0]);
    const card = db.prepare("SELECT id, uuid FROM flashcards WHERE node_id = ? AND front = 'het huis'").get(a.id);
    await api(`/api/ai/flashcards/${card.id}`, 'PUT', { back: 'my house' });
    check('a card edit flags that card’s field', [flagOf('card', card.uuid, 'back'), flagOf('card', card.uuid, 'front')], [1, 0]);
    const cardC1 = db.prepare("SELECT id, uuid FROM flashcards WHERE node_id = ? AND front = 'de krant'").get(a.id);
    await api(`/api/ai/flashcards/${cardC1.id}`, 'PUT', { rating: 3, state: 2, review_count: 1 });
    check('a REVIEW of a card is not an edit of its text', [flagOf('card', cardC1.uuid, 'front'), flagOf('card', cardC1.uuid, 'back')], [0, 0]);
    const { applyAssistantEdit } = await import(B + 'assistantEdits.js');
    const b = nodeOf(pid, 'Meervoud');
    applyAssistantEdit({ kind: 'topic', targetId: b.id, changes: { title: 'Meervoud (via de assistent)' }, expect: { title: 'Meervoud' } });
    const projectUuid = db.prepare('SELECT uuid FROM projects WHERE id = ?').get(pid).uuid;
    applyAssistantEdit({ kind: 'project', targetId: pid, changes: { name: `Course ${tag} renamed` }, expect: { name: `Course ${tag}` } });
    check('a rename through the assistant is the learner’s edit too', [flagOf('node', b.uuid, 'title'), flagOf('project', projectUuid, 'name')], [1, 1]);

    console.log('\n--- undo: the last update of a course can be taken back ---');
    const utag = 'undo';
    const upid = await install(edition1(utag));
    study(upid);
    const before = fingerprint(upid);
    const v2 = edition2(utag, (f) => {
        topic(f, 'Lidwoorden').description = 'Overview A, second edition.';
        topic(f, 'Lidwoorden').flashcards[1].back = 'house, home';
        topic(f, 'Lidwoorden').questions[0].question = 'Welk lidwoord hoort bij "krant" (de krant)?';
        f.nodes[0].children = unit1(f).filter(n => n.title !== 'Verkleinwoord');
        unit1(f).push({ title: 'Werkwoorden', uuid: u(utag, 'C'), description: 'Overview C.' });
    });
    await update(upid, v2);
    check('fixture: the update changed the course', fingerprint(upid) !== before, true);
    const offered = await api(`/api/course-updates/${upid}/undo`);
    check('the course offers to undo its last update', offered.body?.available, true);
    const undone = await api(`/api/course-updates/${upid}/undo`, 'POST');
    check('undo answers', undone.status, 200);
    check('undo puts every author-owned value, every asked record and every row back as it was', fingerprint(upid), before);
    check('...the mastery the learner earned is untouched', masteryOn(nodeOf(upid, 'Lidwoorden')?.id), 0.8);
    check('...and the same file can be applied again afterwards', (await upload('/api/course-updates/inspect', v2)).body?.summary?.changed > 0, true);
    check('an undo is offered once', (await api(`/api/course-updates/${upid}/undo`)).body?.available, false);

    console.log('\n--- undo takes back only what the update wrote ---');
    await update(upid, v2);
    const again = await upload('/api/course-updates/commit', v2, { projectId: String(upid), choices: '{}' });
    check('committing the same file again writes nothing', [again.status, again.body?.summary?.nothing], [200, true]);
    await api(`/api/course-updates/${upid}/undo`, 'POST');
    check('...and the undo still goes back to the edition before the real update', fingerprint(upid), before);
    await update(upid, v2);
    // The learner adds a topic of their own after the update.
    db.prepare("INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, ?, 'Mijn eigen onderwerp', 9)").run(upid, nodeOf(upid, 'Unit 1').id);
    check('once the course changed after the update, no undo is offered', (await api(`/api/course-updates/${upid}/undo`)).body?.available, false);
    const late = await api(`/api/course-updates/${upid}/undo`, 'POST');
    check('...an undo asked anyway is refused and says why', [late.status, /changed since the update/.test(late.body?.error || '')], [409, true]);
    check('...and the learner’s own topic is still there', !!nodeOf(upid, 'Mijn eigen onderwerp'), true);

    const ptag = 'undo-progress';
    const ppid = await install(edition1(ptag));
    await update(ppid, edition2(ptag, (f) => { unit1(f).push({ title: 'Werkwoorden', uuid: u(ptag, 'C'), description: 'Overview C.' }); }));
    const added = nodeOf(ppid, 'Werkwoorden');
    db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total, created_at) VALUES (?, 'quiz', 1, 1, '2026-11-12T10:00:00.000Z')").run(added.id);
    const lost = await api(`/api/course-updates/${ppid}/undo`, 'POST');
    check('a topic the update added and the learner has since studied blocks the undo', [lost.status, evidenceOn(nodeOf(ppid, 'Werkwoorden')?.id)], [409, 1]);

    console.log('\n--- a new link lands where the file puts it ---');
    const ltag = 'links';
    const link = (title, name) => ({ title, url: `https://example.org/${name}`, type: 'link', uuid: u(ltag, name) });
    const withLinks = (f) => { topic(f, 'Lidwoorden').resources = [link('Eerste', 'L1'), link('Tweede', 'L2')]; };
    const lv1 = edition1(ltag);
    withLinks(lv1);
    const lpid = await install(lv1);
    await update(lpid, edition2(ltag, (f) => {
        withLinks(f);
        topic(f, 'Lidwoorden').resources.splice(1, 0, link('Nieuw', 'LN'));
    }));
    const order = db.prepare('SELECT title FROM resources WHERE node_id = ? ORDER BY position, id').all(nodeOf(lpid, 'Lidwoorden').id).map(r => r.title);
    check('the new link sits between the two it came between in the file', order, ['Eerste', 'Nieuw', 'Tweede']);

    console.log('\n--- an unknown course is not an update ---');
    const stranger = await upload('/api/course-updates/inspect', edition1('never-installed'));
    check('a file whose course is not in the library: no match, the importer makes a new project',
        [stranger.status, stranger.body && 'match' in stranger.body ? stranger.body.match : 'no match field'], [200, null]);

    console.log('\n--- undo is refused when the learner used something the update added ---');
    // Each case adds a topic with a link and a question, then does ONE thing
    // the fingerprint of author-owned columns does not see.
    const usedAfterUpdate = async (tag, use) => {
        const id = await install(edition1(tag));
        await update(id, edition2(tag, (f) => {
            unit1(f).push({ title: 'Werkwoorden', uuid: u(tag, 'C'), description: 'Overview C.',
                resources: [{ title: 'Uitleg', url: 'https://example.org/uitleg', type: 'link', uuid: u(tag, 'LC') }],
                questions: [q('Welk lidwoord hoort bij "werkwoord"?', 'het', { uuid: u(tag, 'QC') })] });
        }));
        const c = nodeOf(id, 'Werkwoorden');
        use(c);
        const r = await api(`/api/course-updates/${id}/undo`, 'POST');
        return [r.status, !!nodeOf(id, 'Werkwoorden')];
    };
    check('a note written on a topic the update added blocks the undo',
        await usedAfterUpdate('undo-note', (c) => db.prepare("UPDATE nodes SET notes = 'mijn aantekening' WHERE id = ?").run(c.id)), [409, true]);
    check('a link the update added and the learner ticked blocks the undo',
        await usedAfterUpdate('undo-link', (c) => db.prepare('UPDATE resources SET completed = 1 WHERE node_id = ?').run(c.id)), [409, true]);
    check('an attempt at a quiz the update added blocks the undo',
        await usedAfterUpdate('undo-quiz', (c) => db.prepare("INSERT INTO quiz_attempts (quiz_id, score, total, answers) VALUES ((SELECT id FROM quizzes WHERE node_id = ?), 1, 1, '[]')").run(c.id)), [409, true]);

    console.log('\n--- a question whose answer alone changed reads differently in the preview ---');
    const atag = 'answer-only';
    const apid = await install(edition1(atag));
    const answerOnly = await upload('/api/course-updates/inspect', edition2(atag, (f) => {
        const q2 = topic(f, 'Lidwoorden').questions[1];
        q2.correct_answer = 'de';
    }));
    const qDiff = answerOnly.body?.items?.changed?.find(it => it.kind === 'question')?.diff?.[0];
    check('the preview shows the answer it had and the answer it gets', [/✓ het/.test(qDiff?.from || ''), /✓ de/.test(qDiff?.to || '')], [true, true]);
    check('fixture: the answer-only file was inspected against the installed course', answerOnly.body?.match?.projectId, apid);

    console.log('\n--- a bundle with no course tree is refused, not read as "everything removed" ---');
    const { default: JSZip } = await import('jszip');
    const btag = 'bundle-no-tree';
    const bpid = await install(edition1(btag));
    const zip = new JSZip();
    const { nodes: _dropped, ...manifest } = edition2(btag, () => { });
    zip.file('manifest.json', JSON.stringify(manifest));
    const noTree = await upload('/api/course-updates/inspect', await zip.generateAsync({ type: 'nodebuffer' }));
    check('a bundle whose manifest has no "nodes" is refused', [noTree.status, noTree.body?.summary?.removed ?? null], [400, null]);
    check('...and the course is untouched', !!nodeOf(bpid, 'Lidwoorden'), true);

    console.log('\n--- a studied topic moved under a new section ---');
    const mtag = 'move-under-new';
    const mpid = await install(edition1(mtag));
    study(mpid);
    const studied = nodeOf(mpid, 'Lidwoorden');
    await update(mpid, edition2(mtag, (f) => {
        const [moved] = unit1(f).splice(0, 1);
        f.nodes.push({ title: 'Unit 3', uuid: u(mtag, 'U3'), children: [moved] });
    }));
    const unit3 = nodeOf(mpid, 'Unit 3');
    const parentBase = db.prepare("SELECT base_hash FROM course_base WHERE project_id = ? AND kind = 'node' AND uuid = ? AND field = 'parent'").get(mpid, studied.uuid)?.base_hash;
    check('fixture: the topic now sits under the section the update added', nodeOf(mpid, 'Lidwoorden')?.parent_id, unit3?.id);
    check('its base names the new section by the uuid it got, not the plan’s placeholder', parentBase, fieldHash(unit3?.uuid ?? null));
    const movedUndo = await api(`/api/course-updates/${mpid}/undo`, 'POST');
    check('undo puts it back under its old section with its progress, not through the new one’s cascade',
        [movedUndo.status, nodeOf(mpid, 'Lidwoorden')?.parent_id, evidenceOn(nodeOf(mpid, 'Lidwoorden')?.id), cardsOf(nodeOf(mpid, 'Lidwoorden')?.id).find(c => c.front === 'de krant')?.review_count, !!nodeOf(mpid, 'Unit 3')],
        [200, studied.parent_id, 1, 3, false]);

    console.log('\n--- a bundle’s card media reads as file names in the preview ---');
    const mdtag = 'bundle-media';
    await install(edition1(mdtag));
    const mzip = new JSZip();
    mzip.file('manifest.json', JSON.stringify(edition2(mdtag, (f) => { topic(f, 'Lidwoorden').flashcards[0].media = { front: [{ name: 'krant.png', kind: 'image' }] }; })));
    const withMedia = await upload('/api/course-updates/inspect', await mzip.generateAsync({ type: 'nodebuffer' }));
    const mediaDiff = (withMedia.body?.items?.changed || []).flatMap(it => it.diff || []).find(d => d.field === 'media');
    check('the media change reads "krant.png", not "[object Object]"', [withMedia.status, mediaDiff?.to ?? null], [200, 'krant.png']);

    console.log('\n--- the write paths reuse their statements ---');
    const { markLearnerEdit } = await import(B + 'courseUpdate.js');
    const { claimUuid } = await import(B + 'courseFiles.js');
    const realPrepare = db.prepare;
    let prepared = 0;
    db.prepare = function (...args) { prepared++; return realPrepare.apply(this, args); };
    try {
        markLearnerEdit('card', 'warm', ['front', 'back']);
        claimUuid('nodes', 'warm');
        prepared = 0;
        for (let i = 0; i < 5; i++) { markLearnerEdit('card', `u${i}`, ['front', 'back', 'extra']); claimUuid('nodes', `u${i}`); }
    } finally { db.prepare = realPrepare; }
    check('flagging edits and claiming ids in a loop prepare no new statements', prepared, 0);

    console.log('\n--- control: today’s import door ---');
    const ctag = 'control';
    const cpid = await install(edition1(ctag));
    study(cpid);
    const v2c = edition2(ctag, (f) => { topic(f, 'Lidwoorden').description = 'Overview A, second edition.'; });
    const oldDoor = await api('/api/import', 'POST', v2c);
    const newA = nodeOf(oldDoor.body?.id, 'Lidwoorden');
    check('control: POST /api/import made a second copy (the old behaviour is still what that door does)', copiesOf(ctag), 2);
    check('control: ...and the learner’s mastery is on the OLD project, not on the one with the new text',
        [newA?.description, evidenceOn(newA?.id), evidenceOn(nodeOf(cpid, 'Lidwoorden').id)], ['Overview A, second edition.', 0, 1]);
}

console.log(`\n${pass} passed, ${fail} failed${OLD ? ' (--old-import: today’s door; failures expected)' : ''}`);
try { db.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* swept by the OS */ }
process.exit(fail ? 1 : 0);

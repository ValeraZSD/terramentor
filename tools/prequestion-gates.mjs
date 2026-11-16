#!/usr/bin/env node
/**
 * tools/prequestion-gates.mjs — questions before a topic, and an explanation
 * after a part, are never evidence.
 *
 *   node tools/prequestion-gates.mjs [--root DIR]
 *
 * A topic met for the first time opens its first part on two or three of its
 * own questions, asked before anything is taught (server/lessonPrompts.js).
 * An answer given before teaching says nothing about what was learned, so the
 * rule pinned here is that a pre-question answer reaches NOTHING the mastery
 * estimate, the gate or the check reads: no `mastery_evidence`, no
 * `question_log` (the check draws never-asked first from it), no
 * `answer_attempts`, no `node_mastery`, the checkpoint's numbers unchanged,
 * and the feed row it came from still unread, so the same question is asked
 * after its part, where the answer does count. Explain-it-back is held to the
 * same rule, and is hidden (and refused) with no model set up.
 *
 * --root runs the same cases against another checkout's server: on the code
 * before this feature the opening part carries no pre-questions and both
 * endpoints are missing.
 *
 * Deterministic: a scratch library and a stub model on loopback, no network.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, request } from 'node:http';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = resolve(argOf('--root') || repo);

// Set in-process, before any server module is imported.
const scratch = mkdtempSync(join(tmpdir(), 'prequestion-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n--- ${s} ---`);

// ---- stub model ------------------------------------------------------------------
const modelCalls = [];
let markerReply = '{"verdict": "weak", "reason": "You named the title only; the part says why the period halves."}';
const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        if (req.url.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
        }
        const body = JSON.parse(raw || '{}');
        modelCalls.push(body);
        const content = markerReply;
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { completion_tokens: 3 } }));
    });
});
// A port holding 502/503/504 reads as a transient failure in error text.
for (;;) {
    await new Promise(r => stub.listen(0, '127.0.0.1', r));
    if (!/50[234]/.test(String(stub.address().port))) break;
    await new Promise(r => stub.close(r));
}
process.env.AI_PROVIDER = 'openai';
process.env.AI_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_MODEL = 'stub-model';
process.env.AI_API_KEY = 'stub-key';

const S = pathToFileURL(join(ROOT, 'server') + '/').href;
const { default: db } = await import(S + 'database.js');
if (!String(db.name).startsWith(scratch)) throw new Error('refusing: not the scratch library');
const { ROLE_TOPIC } = await import(S + 'nodeRole.js');
const { composeFeed, checkpointFacts } = await import(S + 'feed.js');
const { getGateConfig } = await import(S + 'settingsStore.js');
const { drawFromNode } = await import(S + 'questionLog.js');
const { createApp } = await import(S + 'app.js');
// Absent before this change: the red run must still reach every check.
const lessonPrompts = await import(S + 'lessonPrompts.js').catch(() => ({}));

const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
setSetting.run('ai_enabled', 'false');
setSetting.run('embedding_enabled', 'false');
setSetting.run('ai_web_search', 'off');

const server = createServer(createApp());
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const call = (method, path, body) => new Promise((ok, no) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', c => { text += c; });
        res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } ok({ status: res.statusCode, body: json }); });
    });
    req.on('error', no);
    req.end(body === undefined ? undefined : JSON.stringify(body));
});

// ---- fixture -----------------------------------------------------------------------
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];
const course = Number(db.prepare("INSERT INTO projects (name, position, start_date, deadline) VALUES ('Waves', 0, ?, ?)").run(day(-10), day(300)).lastInsertRowid);
let position = 0;
const mkTopic = (title) => Number(db.prepare(`
    INSERT INTO nodes (project_id, parent_id, title, position, role, scheduled_start, scheduled_end, description)
    VALUES (?, NULL, ?, ?, ?, ?, ?, 'Overview.')
`).run(course, title, position++, ROLE_TOPIC, day(-2), day(5)).lastInsertRowid);
const mc = (n) => ({ type: 'multiple_choice', question: `Which is option ${n}?`, options: [`opt ${n}`, 'other a', 'other b', 'other c'], correct_answer: `opt ${n}`, explanation: 'Because.' });
const shortQ = { type: 'short_answer', question: 'Why does the period halve?', correct_answer: 'Because the length quarters.', explanation: '' };
const addRow = (nodeId, kind, seq, content, meta = null, status = 'ready') => Number(db.prepare(
    'INSERT INTO feed_items (node_id, kind, seq, content, meta, status) VALUES (?, ?, ?, ?, ?, ?)',
).run(nodeId, kind, seq, typeof content === 'string' ? content : JSON.stringify(content), meta && JSON.stringify(meta), status).lastInsertRowid);
const PART_TEXT = 'A pendulum swings with a period set by its LENGTH. Quarter the length and the period halves.';
// A three-part topic, written ahead of the reader: a question after each part.
const writeTopic = (nodeId, questions, { readFirst = false } = {}) => {
    addRow(nodeId, 'plan', 0, { parts: [{ title: 'Length' }, { title: 'Mass' }, { title: 'Swing' }] }, {}, 'internal');
    const ids = {};
    for (let p = 1; p <= 3; p++) {
        ids[`L${p}`] = addRow(nodeId, 'lesson', p * 2 - 1, `## Part ${p}\n\n${PART_TEXT}\n\n\`\`\`animation\n{"frames": []}\n\`\`\``,
            { partIndex: p, partCount: 3, partTitle: ['Length', 'Mass', 'Swing'][p - 1] }, readFirst && p === 1 ? 'consumed' : 'ready');
        if (questions[p - 1]) ids[`Q${p}`] = addRow(nodeId, 'question', p * 2, questions[p - 1]);
    }
    return ids;
};
const addBank = (nodeId, n) => Number(db.prepare(`INSERT INTO quizzes (node_id, title, questions) VALUES (?, 'Bank', ?)`)
    .run(nodeId, JSON.stringify(Array.from({ length: n }, (_, i) => mc(`b${i}`)))).lastInsertRowid);

const gate = getGateConfig();
const lessonCards = (nodeId) => composeFeed({ limit: 30, excludeKeys: new Set(), gate, nodeId }).items
    .filter(c => c.kind === 'lesson' && c.nodeId === nodeId);
const opening = (nodeId) => lessonCards(nodeId)[0] ?? null;
const count = (sql, ...a) => { try { return db.prepare(sql).get(...a).c; } catch { return null; } };
// Everything the estimate, the gate and the check read about a topic.
const evidenceState = (nodeId) => JSON.stringify({
    evidence: count('SELECT COUNT(*) AS c FROM mastery_evidence WHERE node_id = ?', nodeId),
    log: count('SELECT COUNT(*) AS c FROM question_log WHERE node_id = ?', nodeId),
    attempts: count('SELECT COUNT(*) AS c FROM answer_attempts'),
    quizAttempts: count('SELECT COUNT(*) AS c FROM quiz_attempts'),
    // What the estimate holds, not when its row was made: reading a topic
    // creates an all-zero row, and that is no evidence.
    mastery: (({ mastery_score = 0, total_attempts = 0, correct_attempts = 0, transferred_prior = null, placement_prior = null } = {}) =>
        ({ mastery_score, total_attempts, correct_attempts, transferred_prior, placement_prior }))(
        db.prepare('SELECT * FROM node_mastery WHERE node_id = ?').get(nodeId)),
    rows: db.prepare("SELECT id, status, consumed_at FROM feed_items WHERE node_id = ? ORDER BY id").all(nodeId),
    status: db.prepare('SELECT status FROM nodes WHERE id = ?').get(nodeId).status,
    checkpoint: checkpointFacts(nodeId, gate),
});
const preRows = (nodeId) => { try { return db.prepare('SELECT * FROM pre_questions WHERE node_id = ?').all(nodeId); } catch { return null; } };

try {
    section('1. a topic met for the first time opens on its own questions');
    const t1 = mkTopic('Pendulums');
    const ids = writeTopic(t1, [mc(1), shortQ, mc(3)]);
    // Taken before the first compose: a write made while the round is built
    // must not hide inside the baseline.
    const pristine1 = evidenceState(t1);
    const open1 = opening(t1);
    const pq = open1?.preQuestions ?? [];
    check('part 1 carries a pre-question round', open1?.partIndex === 1 && pq.length >= 2, JSON.stringify(open1 && { partIndex: open1.partIndex, preQuestions: open1.preQuestions }));
    check('…of at most three questions', pq.length <= 3, `got ${pq.length}`);
    check('…taken from the topic\'s own per-part questions, in part order', pq[0]?.feedItemId === ids.Q1 && pq[1]?.feedItemId === ids.Q3,
        JSON.stringify(pq.map(p => p.feedItemId)));
    check('…never a model-graded format (it must work with no model)', pq.every(p => p.question?.type !== 'short_answer'));
    check('later parts carry none', lessonCards(t1).slice(1).every(c => !c.preQuestions));
    check('building the round wrote nothing the estimate reads', evidenceState(t1) === pristine1);

    section('2. answering them writes no evidence and consumes no row');
    const before = evidenceState(t1);
    const r = await call('POST', `/api/feed/nodes/${t1}/pre-questions`, {
        outcome: 'answered', items: [{ ref: `fi:${ids.Q1}`, correct: true }, { ref: `fi:${ids.Q3}`, correct: false }],
    });
    check('the round is recorded', r.status === 200 && r.body?.ok === true, JSON.stringify(r));
    const after = evidenceState(t1);
    check('evidence, the log, attempts, the estimate, the rows and the checkpoint are unchanged', before === after && after === pristine1,`${before}\n          ${after}`);
    const rows = preRows(t1) ?? [];
    check('one pre_questions row, refs and counts only', rows.length === 1 && rows[0].asked === 2 && rows[0].answered === 2 && rows[0].correct === 1
        && !/Which is option/.test(rows[0].items), JSON.stringify(rows));
    const again = await call('POST', `/api/feed/nodes/${t1}/pre-questions`, { outcome: 'skipped', items: [] });
    check('a second record is a no-op', again.status === 200 && again.body?.duplicate === true && (preRows(t1) ?? []).length === 1, JSON.stringify(again.body));
    check('a bad outcome or ref is refused', (await call('POST', `/api/feed/nodes/${t1}/pre-questions`, { outcome: 'maybe' })).status === 400
        && (await call('POST', `/api/feed/nodes/${t1}/pre-questions`, { outcome: 'answered', items: [{ ref: 'Which is option 1?' }] })).status === 400);
    check('an unknown topic is a 404', (await call('POST', '/api/feed/nodes/999999/pre-questions', { outcome: 'skipped', items: [] })).status === 404);

    section('3. asked once; the same questions still come after their parts');
    check('the opening part no longer carries a round', opening(t1) && !opening(t1).preQuestions, JSON.stringify(opening(t1)?.preQuestions));
    const served = composeFeed({ limit: 30, excludeKeys: new Set(), gate, nodeId: t1 }).items.filter(c => c.kind === 'question').map(c => c.feedItemId);
    check('the pre-questions are still served after the parts that teach them', served.includes(ids.Q1) && served.includes(ids.Q3), JSON.stringify(served));

    section('4. skipping is one press, and records nothing else');
    const t2 = mkTopic('Springs');
    const ids2 = writeTopic(t2, [mc(1), mc(2), mc(3)]);
    const b2 = evidenceState(t2);
    check('a fresh topic opens on three', (opening(t2)?.preQuestions ?? []).length === 3);
    // A skip that claims a grade, and a ref to ANOTHER topic's question.
    const s = await call('POST', `/api/feed/nodes/${t2}/pre-questions`, {
        outcome: 'skipped', items: [{ ref: `fi:${ids2.Q1}`, correct: true }, { ref: `fi:${ids.Q1}`, correct: true }],
    });
    const r2 = preRows(t2)?.[0];
    const keptRefs = (() => { try { return JSON.parse(r2?.items || '[]').map(i => i.ref); } catch { return []; } })();
    check('skipped is recorded', s.status === 200 && r2?.outcome === 'skipped', JSON.stringify(preRows(t2)));
    check('…grading nothing, whatever the body claims', r2?.answered === 0 && r2?.correct === 0, JSON.stringify(r2));
    check("…keeping only this topic's own refs", r2?.asked === 1 && JSON.stringify(keptRefs) === JSON.stringify([`fi:${ids2.Q1}`]), JSON.stringify(keptRefs));
    check('…and nothing the estimate reads moved', evidenceState(t2) === b2);
    check('…and the round is not offered again', !opening(t2)?.preQuestions);

    section('5. a topic picked up mid-way, or with too little to ask, gets none');
    const t3 = mkTopic('Resonance');
    writeTopic(t3, [mc(1), mc(2), mc(3)], { readFirst: true });
    check('part 1 already read: no round on part 2', opening(t3)?.partIndex === 2 && !opening(t3)?.preQuestions, JSON.stringify(opening(t3) && { p: opening(t3).partIndex, pq: opening(t3).preQuestions }));
    const t4 = mkTopic('Damping');
    writeTopic(t4, [mc(1), shortQ, null]);
    check('one locally graded question is no round', opening(t4) && !opening(t4).preQuestions);

    section('6. a topic asked from its bank: the bank fills the round, the check draws as before');
    const t5 = mkTopic('Waves on a string');
    addBank(t5, 6);
    writeTopic(t5, [null, null, null]);
    const drawBefore = JSON.stringify(drawFromNode(t5, 6).questions.map(q => q.question.uuid).sort());
    const bankPq = opening(t5)?.preQuestions ?? [];
    check('the round comes from the bank, named by uuid', bankPq.length === 3 && bankPq.every(p => p.feedItemId === null && typeof p.question?.uuid === 'string'),
        JSON.stringify(bankPq.map(p => [p.feedItemId, p.question?.uuid])));
    const b5 = evidenceState(t5);
    await call('POST', `/api/feed/nodes/${t5}/pre-questions`, { outcome: 'answered', items: bankPq.map(p => ({ ref: `q:${p.question?.uuid}`, correct: false })) });
    check('three wrong answers move nothing the estimate reads', evidenceState(t5) === b5);
    // The check draws never-asked questions first, in a shuffled order: what
    // must not move is which questions count as never asked.
    const bankQuiz = db.prepare('SELECT id FROM quizzes WHERE node_id = ?').get(t5).id;
    check('the mastery check still sees every bank question as never asked',
        count('SELECT COUNT(*) AS c FROM question_log WHERE quiz_id = ?', bankQuiz) === 0
        && JSON.stringify(drawFromNode(t5, 6).questions.map(q => q.question.uuid).sort()) === drawBefore);

    section('7. explain-it-back: hidden and refused with no model');
    const t6 = mkTopic('Standing waves');
    const ids6 = writeTopic(t6, [mc(1), mc(2), mc(3)]);
    check('no model: the part offers no explain-back', opening(t6) && !opening(t6).explainBack);
    const noModel = await call('POST', `/api/feed/lessons/${ids6.L1}/explain`, { text: 'Shorter string, shorter period.' });
    check('…and the endpoint refuses without calling anything', noModel.status === 409 && modelCalls.length === 0, JSON.stringify({ status: noModel.status, calls: modelCalls.length }));

    section('8. explain-it-back with a model: marked against the stored part, still not evidence');
    setSetting.run('ai_enabled', 'true');
    check('with a model the part offers it', opening(t6)?.explainBack === true);
    const b6 = evidenceState(t6);
    const ex = await call('POST', `/api/feed/lessons/${ids6.L1}/explain`, { text: 'It is about length.' });
    check('the verdict and its reason come back', ex.status === 200 && ex.body?.verdict === 'weak' && /period halves/.test(ex.body?.reason || ''), JSON.stringify(ex));
    const sent = JSON.stringify(modelCalls.at(-1)?.messages ?? []);
    check('the marker read the part\'s stored text, figures left out', sent.includes('Quarter the length and the period halves') && !sent.includes('"frames"'));
    const temp = modelCalls.at(-1)?.temperature;
    check('…at a low temperature, so a second check does not flip', typeof temp === 'number' && temp <= 0.2, String(temp));
    const long = lessonPrompts.partProse?.(`${'Setup. '.repeat(1500)}So the length alone sets the period.`) ?? '';
    check('a long part keeps its conclusion for the marker', long.length <= 6100 && long.endsWith('So the length alone sets the period.'), `${long.length} chars`);
    const exRows = (() => { try { return db.prepare('SELECT * FROM explain_backs WHERE node_id = ?').all(t6); } catch { return []; } })();
    check('one explain_backs row naming its marker', exRows.length === 1 && exRows[0].verdict === 'weak' && exRows[0].part_index === 1 && /stub-model/.test(exRows[0].generated_by || ''), JSON.stringify(exRows));
    check('nothing the estimate reads moved', evidenceState(t6) === b6);
    markerReply = 'I think it is fine.';
    const vague = await call('POST', `/api/feed/lessons/${ids6.L1}/explain`, { text: 'Length sets the period; a quarter of it halves the period.' });
    check('a reply with no verdict is "unsure", never "good"', vague.status === 200 && vague.body?.verdict === 'unsure', JSON.stringify(vague.body));
    check('empty or overlong text is refused', (await call('POST', `/api/feed/lessons/${ids6.L1}/explain`, { text: '  ' })).status === 400
        && (await call('POST', `/api/feed/lessons/${ids6.L1}/explain`, { text: 'x'.repeat(2001) })).status === 400);
    check('a question row is not a lesson', (await call('POST', `/api/feed/lessons/${ids6.Q1}/explain`, { text: 'Length.' })).status === 404);
    setSetting.run('ai_enabled', 'false');

    section('9. only the module that writes them reads them');
    const allowed = new Set(['database.js', 'syncTables.js', 'lessonPrompts.js']);
    const readers = [];
    const walk = (dir, rel = '') => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
            else if (e.name.endsWith('.js') && /\b(pre_questions|explain_backs)\b/.test(readFileSync(join(dir, e.name), 'utf8'))) readers.push(`${rel}${e.name}`);
        }
    };
    walk(join(ROOT, 'server'));
    const strays = readers.filter(f => !allowed.has(f));
    check('no server module but the writer, the schema and the sync list names the tables', readers.includes('lessonPrompts.js') && strays.length === 0, JSON.stringify(readers));
    // The client is the other way in: the pre-question screen may reach only
    // its own record and the marker, never an answer, a log or a consumed card.
    const client = (() => { try { return readFileSync(join(ROOT, 'src', 'components', 'feed', 'LessonPrompts.tsx'), 'utf8'); } catch { return ''; } })();
    const apiCalls = [...new Set([...client.matchAll(/\bapi\.(\w+)/g)].map(m => m[1]))].sort();
    check('the client screen calls only its own two endpoints', JSON.stringify(apiCalls) === JSON.stringify(['explainBack', 'recordPreQuestions']), JSON.stringify(apiCalls));
    check('…and never records an answer or consumes a card', !!client && !/consumeFeedCard|recordOnce|newAttemptId|useStore/.test(client));
} finally {
    server.close(); stub.close();
    try { db.close(); } catch { /* closed */ }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a held WAL on Windows */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

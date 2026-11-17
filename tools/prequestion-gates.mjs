#!/usr/bin/env node
/**
 * tools/prequestion-gates.mjs — questions before a topic, and an explanation
 * after a part, are never evidence.
 *
 *   node tools/prequestion-gates.mjs [--root DIR]
 *
 * A topic the app holds a head start on (a placement or transfer seed that
 * the learner's own answers have not yet spent) opens its first part on ONE
 * quick-tap question of its own, multiple choice or true/false, asked before
 * anything is taught (server/lessonPrompts.js). A plainly new topic gets none.
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
const { composeFeed, checkpointFacts, consumeFeedItem } = await import(S + 'feed.js');
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
// Graded with no model, but typed: never a pre-question, which is one tap.
const fillQ = { type: 'fill_in', question: 'Quarter the length and the period ___.', correct_answer: 'halves', explanation: '' };
const tfQ = { type: 'true_false', question: 'A heavier bob swings slower.', correct_answer: 'False', explanation: '' };
// A head start as placement or transfer leaves it: a seed, and optionally the
// learner's own answers since (which spend it, or overrule it when lower).
const seed = (nodeId, { placement = null, transfer = null, attempts = 0, score = Math.max(placement ?? 0, transfer ?? 0) } = {}) => db.prepare(`
    INSERT INTO node_mastery (node_id, placement_prior, transferred_prior, mastery_score, total_attempts)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET placement_prior = excluded.placement_prior, transferred_prior = excluded.transferred_prior,
        mastery_score = excluded.mastery_score, total_attempts = excluded.total_attempts
`).run(nodeId, placement, transfer, score, attempts);
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
    section('1. a plainly new topic opens on the part, with no question first');
    const t0 = mkTopic('Oscillation');
    writeTopic(t0, [mc(1), mc(2), mc(3)]);
    addBank(t0, 6);
    const pristine0 = evidenceState(t0);
    const open0 = opening(t0);
    check('no head start: part 1 carries no round, though it has tap questions to ask', open0?.partIndex === 1 && !open0.preQuestions,
        JSON.stringify(open0 && { partIndex: open0.partIndex, preQuestions: open0.preQuestions }));
    check('…and the server builds none', lessonPrompts.preQuestionsFor?.(t0, []) === null);
    check('…and looking wrote nothing the estimate reads', evidenceState(t0) === pristine0);

    section('2. a topic with a head start opens on ONE tap question of its own');
    const t1 = mkTopic('Pendulums');
    const ids = writeTopic(t1, [shortQ, fillQ, mc(3)]);
    seed(t1, { placement: 0.41 });
    // Taken before the first compose: a write made while the round is built
    // must not hide inside the baseline.
    const pristine1 = evidenceState(t1);
    const open1 = opening(t1);
    const pq = open1?.preQuestions ?? [];
    check('part 1 carries a round of exactly one question', open1?.partIndex === 1 && pq.length === 1, JSON.stringify(open1 && { partIndex: open1.partIndex, preQuestions: open1.preQuestions }));
    check('…the first TAP question in part order, passing over typed ones', pq[0]?.feedItemId === ids.Q3 && pq[0]?.question?.type === 'multiple_choice',
        JSON.stringify(pq.map(p => [p.feedItemId, p.question?.type])));
    check('later parts carry none', lessonCards(t1).slice(1).every(c => !c.preQuestions));
    check('building the round wrote nothing the estimate reads', evidenceState(t1) === pristine1);
    const tTf = mkTopic('Bobs');
    const idsTf = writeTopic(tTf, [fillQ, tfQ, shortQ]);
    seed(tTf, { transfer: 0.6 });
    const pqTf = opening(tTf)?.preQuestions ?? [];
    const tUnv = mkTopic('Damping');
    const idsUnv = writeTopic(tUnv, [{ ...mc(1), unverified: { reason: 'key disputed' } }, mc(2), mc(3)]);
    seed(tUnv, { placement: 0.41 });
    const pqUnv = opening(tUnv)?.preQuestions ?? [];
    check('a feed question with an unverified key is passed over, as the bank draw does', pqUnv.length === 1 && pqUnv[0].feedItemId === idsUnv.Q2,
        JSON.stringify(pqUnv.map(p => p.feedItemId)));
    check('a transfer seed counts too, and true/false is a tap', pqTf.length === 1 && pqTf[0].feedItemId === idsTf.Q2 && pqTf[0].question?.type === 'true_false',
        JSON.stringify(pqTf.map(p => [p.feedItemId, p.question?.type])));

    section('3. answering it writes no evidence and consumes no row');
    const before = evidenceState(t1);
    const r = await call('POST', `/api/feed/nodes/${t1}/pre-questions`, {
        outcome: 'answered', items: [{ ref: `fi:${ids.Q3}`, correct: true }],
    });
    check('the round is recorded', r.status === 200 && r.body?.ok === true, JSON.stringify(r));
    const after = evidenceState(t1);
    check('evidence, the log, attempts, the estimate, the rows and the checkpoint are unchanged', before === after && after === pristine1,`${before}\n          ${after}`);
    const rows = preRows(t1) ?? [];
    check('one pre_questions row, refs and counts only', rows.length === 1 && rows[0].asked === 1 && rows[0].answered === 1 && rows[0].correct === 1
        && !/Which is option/.test(rows[0].items), JSON.stringify(rows));
    const again = await call('POST', `/api/feed/nodes/${t1}/pre-questions`, { outcome: 'skipped', items: [] });
    check('a second record is a no-op', again.status === 200 && again.body?.duplicate === true && (preRows(t1) ?? []).length === 1, JSON.stringify(again.body));
    check('a bad outcome or ref is refused', (await call('POST', `/api/feed/nodes/${t1}/pre-questions`, { outcome: 'maybe' })).status === 400
        && (await call('POST', `/api/feed/nodes/${t1}/pre-questions`, { outcome: 'answered', items: [{ ref: 'Which is option 1?' }] })).status === 400);
    check('an unknown topic is a 404', (await call('POST', '/api/feed/nodes/999999/pre-questions', { outcome: 'skipped', items: [] })).status === 404);

    section('4. asked once; the same question still comes after its part');
    check('the opening part no longer carries a round', opening(t1) && !opening(t1).preQuestions, JSON.stringify(opening(t1)?.preQuestions));
    const served = composeFeed({ limit: 30, excludeKeys: new Set(), gate, nodeId: t1 }).items.filter(c => c.kind === 'question').map(c => c.feedItemId);
    check('the pre-question is still served after the part that teaches it', served.includes(ids.Q3), JSON.stringify(served));
    // Control for every "nothing moved" check above: the snapshot does move
    // when the same question is answered for real, after its part.
    consumeFeedItem({ key: `fi-${ids.Q3}`, kind: 'question', feedItemId: ids.Q3, nodeId: t1, result: { correct: true } });
    check('control: answering that question for real DOES move what the estimate reads', evidenceState(t1) !== after, evidenceState(t1));

    section('5. skipping is one press, and records nothing else');
    const t2 = mkTopic('Springs');
    const ids2 = writeTopic(t2, [mc(1), mc(2), mc(3)]);
    seed(t2, { placement: 0.29 });
    const b2 = evidenceState(t2);
    check('a seeded topic with three tap questions still asks one', (opening(t2)?.preQuestions ?? []).length === 1);
    // A skip that claims a grade, and a ref to ANOTHER topic's question.
    const s = await call('POST', `/api/feed/nodes/${t2}/pre-questions`, {
        outcome: 'skipped', items: [{ ref: `fi:${ids2.Q1}`, correct: true }, { ref: `fi:${ids.Q1}`, correct: true }],
    });
    const r2 = preRows(t2)?.[0];
    const keptRefs = (() => { try { return JSON.parse(r2?.items || '[]').map(i => i.ref); } catch { return []; } })();
    check('skipped is recorded', s.status === 200 && r2?.outcome === 'skipped', JSON.stringify(preRows(t2)));
    check('…grading nothing, whatever the body claims', r2?.answered === 0 && r2?.correct === 0, JSON.stringify(r2));
    // The row syncs; a feed row's id is this device's cache id, so it is not kept.
    check("…keeping only this topic's own refs, a feed row's without its device-local id", r2?.asked === 1 && JSON.stringify(keptRefs) === '["feed"]', JSON.stringify(keptRefs));
    check('…and nothing the estimate reads moved', evidenceState(t2) === b2);
    check('…and the round is not offered again', !opening(t2)?.preQuestions);

    section('6. a head start spent or overruled, a topic picked up mid-way, or nothing to tap: none');
    const tSpent = mkTopic('Resonance curves');
    writeTopic(tSpent, [mc(1), mc(2), mc(3)]);
    seed(tSpent, { placement: 0.41, attempts: 2, score: 0.5 });
    check('a head start the learner\'s answers have since agreed with (spent): no round', opening(tSpent)?.partIndex === 1 && !opening(tSpent).preQuestions,
        JSON.stringify(opening(tSpent)?.preQuestions));
    const tLow = mkTopic('Beats');
    writeTopic(tLow, [mc(1), mc(2), mc(3)]);
    seed(tLow, { placement: 0.41, attempts: 2, score: 0.1 });
    check('a head start the learner\'s answers overruled: no round', opening(tLow)?.partIndex === 1 && !opening(tLow).preQuestions);
    const t3 = mkTopic('Resonance');
    writeTopic(t3, [mc(1), mc(2), mc(3)], { readFirst: true });
    seed(t3, { placement: 0.41 });
    check('part 1 already read: no round on part 2', opening(t3)?.partIndex === 2 && !opening(t3)?.preQuestions, JSON.stringify(opening(t3) && { p: opening(t3).partIndex, pq: opening(t3).preQuestions }));
    const t4 = mkTopic('Damping');
    writeTopic(t4, [shortQ, fillQ, null]);
    seed(t4, { placement: 0.41 });
    check('only typed questions and no bank: no round', opening(t4)?.partIndex === 1 && !opening(t4).preQuestions,
        JSON.stringify(opening(t4)?.preQuestions));

    section('7. a seeded topic asked from its bank: the bank fills the round, the check draws as before');
    const t5 = mkTopic('Waves on a string');
    addBank(t5, 6);
    writeTopic(t5, [null, null, null]);
    seed(t5, { placement: 0.41 });
    const drawBefore = JSON.stringify(drawFromNode(t5, 6).questions.map(q => q.question.uuid).sort());
    const bankPq = opening(t5)?.preQuestions ?? [];
    check('the round is one bank question, named by uuid', bankPq.length === 1 && bankPq.every(p => p.feedItemId === null && typeof p.question?.uuid === 'string'),
        JSON.stringify(bankPq.map(p => [p.feedItemId, p.question?.uuid])));
    const b5 = evidenceState(t5);
    await call('POST', `/api/feed/nodes/${t5}/pre-questions`, { outcome: 'answered', items: bankPq.map(p => ({ ref: `q:${p.question?.uuid}`, correct: false })) });
    check('a wrong answer moves nothing the estimate reads', evidenceState(t5) === b5);
    // The check draws never-asked questions first, in a shuffled order: what
    // must not move is which questions count as never asked.
    const bankQuiz = db.prepare('SELECT id FROM quizzes WHERE node_id = ?').get(t5).id;
    check('the mastery check still sees every bank question as never asked',
        count('SELECT COUNT(*) AS c FROM question_log WHERE quiz_id = ?', bankQuiz) === 0
        && JSON.stringify(drawFromNode(t5, 6).questions.map(q => q.question.uuid).sort()) === drawBefore);

    section('8. explain-it-back: hidden and refused with no model');
    const t6 = mkTopic('Standing waves');
    const ids6 = writeTopic(t6, [mc(1), mc(2), mc(3)]);
    check('no model: the part offers no explain-back', opening(t6) && !opening(t6).explainBack);
    const noModel = await call('POST', `/api/feed/lessons/${ids6.L1}/explain`, { text: 'Shorter string, shorter period.' });
    check('…and the endpoint refuses without calling anything', noModel.status === 409 && modelCalls.length === 0, JSON.stringify({ status: noModel.status, calls: modelCalls.length }));

    section('9. explain-it-back with a model: marked against the stored part, still not evidence');
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
    const coded = lessonPrompts.partProse?.('Run it:\n\n```python\nprint(len("abc"))\n```\n\n```animation\n{"frames": []}\n```') ?? '';
    check('a code listing reaches the marker; only the visual is left out', coded.includes('print(len("abc"))') && !coded.includes('"frames"'), JSON.stringify(coded));
    const exRows = (() => { try { return db.prepare('SELECT * FROM explain_backs WHERE node_id = ?').all(t6); } catch { return []; } })();
    check('one explain_backs row naming its marker', exRows.length === 1 && exRows[0].verdict === 'weak' && exRows[0].part_index === 1 && /stub-model/.test(exRows[0].generated_by || ''), JSON.stringify(exRows));
    check('nothing the estimate reads moved', evidenceState(t6) === b6);
    markerReply = 'I think it is fine.';
    const vague = await call('POST', `/api/feed/lessons/${ids6.L1}/explain`, { text: 'Length sets the period; a quarter of it halves the period.' });
    check('a reply with no verdict is "unsure", never "good"', vague.status === 200 && vague.body?.verdict === 'unsure', JSON.stringify(vague.body));
    check('…with no server-written English reason (the screen says it in its own language)', vague.body?.reason === '', JSON.stringify(vague.body));
    check('empty or overlong text is refused', (await call('POST', `/api/feed/lessons/${ids6.L1}/explain`, { text: '  ' })).status === 400
        && (await call('POST', `/api/feed/lessons/${ids6.L1}/explain`, { text: 'x'.repeat(2001) })).status === 400);
    check('a question row is not a lesson', (await call('POST', `/api/feed/lessons/${ids6.Q1}/explain`, { text: 'Length.' })).status === 404);
    setSetting.run('ai_enabled', 'false');

    section('10. only the module that writes them reads them');
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

#!/usr/bin/env node
/**
 * tools/mock-draw-gates.mjs — a mock exam drawn from the course's own questions.
 *
 *   node tools/mock-draw-gates.mjs [--root DIR]
 *
 * The second source of a mock exam: a mixed draw of the questions a course
 * already holds, answered on screen, scored at the end. What this suite pins:
 *
 *   1. the draw: only questions that passed the quality gates (a verifier's
 *      stamp holds one back, a written answer the app cannot check alone is
 *      left out), only from the topics studied so far, spread across them,
 *      never the same question twice in one mock, never-asked first, and a
 *      course with fewer questions than asked says so in numbers;
 *   2. nothing of the key leaves while the mock is open, through the report
 *      flag either, and a drawn set is sat once;
 *   3. an answer is never lost: written once per attempt id, kept through a
 *      pause and leaving, accepted after time is up (marked late), and time up
 *      hands nothing in;
 *   4. the score: right answers of N, unanswered counts zero, the in-time
 *      score beside the one with extra time, the range of the learner's
 *      likely level (Wilson 95%), answers read back wrong first;
 *   5. the evidence: practice, both ways, one row per topic answered, nothing
 *      for an unanswered question, never completes or reopens a topic, written
 *      once, and a reported question taken out again;
 *   6. a pass line only when the real exam is taken on screen with this many
 *      questions; otherwise the result says it is not a grade; the clock is on
 *      by default only for an on-screen exam;
 *   7. a draw is a question set kept apart from the attempt, in the mock exam
 *      tables, named for sync and gone with its course;
 *   8. the screen: answers kept through a lapsed sign-in, the exam's focus,
 *      the flag listing its questions as the mock's own;
 *   9. the screen's decisions (courseMockState.ts): where a mock opens, what
 *      the save line says when saves keep failing, which clocks a closing
 *      page pauses;
 *  10. every format the app checks alone leaves no key in the open mock, a
 *      placement answer starts no topic, and reading what a course can draw
 *      costs the same for one topic as for many.
 *
 * --root runs the same cases against another checkout's server and screen
 * code; on the code before the draw existed every case fails.
 *
 * Deterministic in what it asserts: a scratch library, no model, no network,
 * no wall clock. Every case that reads the clock passes its own `now`; the
 * mocks answered over HTTP, where the server reads the time, have no clock.
 * The draw shuffles; the cases assert properties every shuffle must keep.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = resolve(argOf('--root') || repo);

// Set in-process, before any server module is imported.
const scratch = mkdtempSync(join(tmpdir(), 'mock-draw-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
/** A case whose code threw counts as a failure, and the suite goes on. */
const block = async (title, fn) => {
    console.log(`\n--- ${title} ---`);
    try { await fn(); } catch (err) { check(`${title}: ran without throwing`, false, err?.message || String(err)); }
};

const S = pathToFileURL(join(ROOT, 'server') + '/').href;
const { default: db } = await import(S + 'database.js');
if (!process.env.DB_PATH.startsWith(scratch)) throw new Error('refusing: not the scratch library');
const { getNodeMastery, checkMasteryEligibility } = await import(S + 'mastery.js');
const { SYNC_TABLES } = await import(S + 'syncTables.js');
const { createApp } = await import(S + 'app.js');
const mock = await import(S + 'mockExams.js').catch(() => ({}));

const server = createApp().listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const { port } = server.address();
const call = (method, path, body) => new Promise((ok, no) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', c => { text += c; });
        res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } ok({ status: res.statusCode, body: json, text }); });
    });
    req.on('error', no);
    req.end(body === undefined ? undefined : JSON.stringify(body));
});

// ---- a course with a bank per topic ----------------------------------------------

const course = Number(db.prepare("INSERT INTO projects (name) VALUES ('Physics')").run().lastInsertRowid);
const addNode = (title, status, position) => Number(db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position, status) VALUES (?, NULL, ?, ?, ?)',
).run(course, title, position, status).lastInsertRowid);
const waves = addNode('Waves', 'in_progress', 0);
const optics = addNode('Optics', 'completed', 1);
const heat = addNode('Heat', 'in_progress', 2);
const nuclear = addNode('Nuclear', 'not_started', 3);

/** uuid -> { nodeId, key, wrong } for every question the gate seeds. */
const KEY = new Map();
const mc = (nodeId, i, extra = {}) => {
    const uuid = randomUUID();
    const q = { uuid, type: 'multiple_choice', question: `Question ${i} on topic ${nodeId}?`, options: ['Alpha', 'Beta', 'Gamma', 'Delta'], correct_answer: 'Beta', explanation: `Because ${i}.`, ...extra };
    KEY.set(uuid, { nodeId, key: 'Beta', wrong: 'Gamma' });
    return q;
};
const bank = (nodeId, qs) => db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)').run(nodeId, 'Bank', JSON.stringify(qs));
const unverifiedQ = mc(waves, 99, { unverified: { reason: 'no verdict', tries: 1, at: '2026-11-01T10:00:00.000Z', next: '2026-11-01T11:00:00.000Z' } });
const writtenQ = { uuid: randomUUID(), type: 'short_answer', question: 'Explain interference.', correct_answer: 'Two waves add.' };
bank(waves, [mc(waves, 1), mc(waves, 2), mc(waves, 3), mc(waves, 4), mc(waves, 5), mc(waves, 6), writtenQ, unverifiedQ]);
bank(optics, [mc(optics, 1), mc(optics, 2), mc(optics, 3), mc(optics, 4), mc(optics, 5), mc(optics, 6)]);
bank(heat, [mc(heat, 1), mc(heat, 2)]);
bank(nuclear, [mc(nuclear, 1), mc(nuclear, 2), mc(nuclear, 3), mc(nuclear, 4), mc(nuclear, 5)]);
const READY = new Set([...KEY.keys()].filter(u => u !== unverifiedQ.uuid && KEY.get(u).nodeId !== nuclear));

const T0 = Date.parse('2026-11-16T09:00:00.000Z');
const refUuid = (q) => String(q?.ref ?? '').replace(/^q:/, '');
const allRowsOf = (nodeId) => db.prepare("SELECT score, total, metadata FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'mock' ORDER BY id").all(nodeId);
const allMockRows = () => db.prepare("SELECT COUNT(*) n FROM mastery_evidence WHERE evidence_type = 'mock'").get().n;
const statusOf = (id) => db.prepare('SELECT status FROM nodes WHERE id = ?').get(id).status;
const detail = async (sid) => (await call('GET', `/api/mock-sittings/${sid}`)).body;
let attempt = 0;
const answer = (sid, partId, value, extra = {}) => call('PUT', `/api/mock-sittings/${sid}/answers`, { partId, answer: value, attemptId: `a${++attempt}`, ...extra });

try {
    let first = null;      // the 10-question mock everything else reads

    await block('1. the draw: checked questions, studied topics, spread, no repeat', async () => {
        check('module exports courseReadiness, drawCourseMock, saveAnswer and spreadOf',
            ['courseReadiness', 'drawCourseMock', 'saveAnswer', 'spreadOf'].every(f => typeof mock[f] === 'function'));
        const ready = mock.courseReadiness(course);
        check('14 questions are ready: the unchecked one is held back, the written one left out, Nuclear not studied',
            ready?.ready === 14, JSON.stringify(ready));
        check('they come from the 3 topics studied so far', ready?.topics === 3, String(ready?.topics));
        check('1 topic not studied yet is counted as left out', ready?.notStudied === 1, String(ready?.notStudied));
        check('1 written-answer question is counted as left out', ready?.writtenLeftOut === 1, String(ready?.writtenLeftOut));

        const list = await call('GET', `/api/projects/${course}/mock-exams`);
        check('the mock exam list carries the same readiness', list.body?.course?.ready === 14, JSON.stringify(list.body?.course));

        // No clock: answered over HTTP, where the server reads the wall clock.
        const r = await call('POST', `/api/projects/${course}/mock-exams/draw`, { size: 10, minutes: null });
        check('a draw of 10 starts a mock', r.status === 200 && r.body?.sitting?.id > 0, r.text);
        first = r.body?.sitting?.id;
        const d = await detail(first);
        const qs = d?.course?.questions ?? [];
        check('it asks 10 questions', qs.length === 10, String(qs.length));
        const uuids = qs.map(refUuid);
        check('never the same question twice in one mock', new Set(uuids).size === uuids.length);
        check('every one is ready: no unchecked, written-answer or unstudied question', uuids.every(u => READY.has(u)), JSON.stringify(uuids.filter(u => !READY.has(u))));
        const per = new Map();
        for (const u of uuids) { const n = KEY.get(u)?.nodeId; per.set(n, (per.get(n) || 0) + 1); }
        check('spread across topics: Heat gives both its questions, Waves and Optics 4 each',
            per.get(heat) === 2 && per.get(waves) === 4 && per.get(optics) === 4, JSON.stringify([...per]));
        // The topic's id rides along for the study clock (CourseMock.tsx claims
        // the time for the question's topic); its name, which could cue the
        // answer, does not.
        const topicNames = db.prepare('SELECT title FROM nodes WHERE id IN (?, ?, ?)').all(heat, waves, optics).map(r => r.title);
        check('no topic name is shown while it is open', qs.every(q => !Object.values(q).some(v => typeof v === 'string' && topicNames.includes(v))),
            JSON.stringify(topicNames));
        check('…the topic id is there, for the clock', qs.every(q => Number.isInteger(q.nodeId)), JSON.stringify(qs.map(q => q.nodeId)));

        const big = await call('POST', `/api/projects/${course}/mock-exams/draw`, { size: 40, minutes: null });
        check('asking 40 of a course with 14 starts a mock of 14 and says so',
            big.status === 200 && big.body?.drawn === 14 && big.body?.asked === 40 && big.body?.short === true, big.text);
        check('with no clock: no time allowed', big.body?.sitting?.timeAllowed === 0, JSON.stringify(big.body?.sitting));
        await call('DELETE', `/api/mock-sittings/${big.body?.sitting?.id}`);
        check('a discarded draw takes its question set with it',
            db.prepare("SELECT COUNT(*) n FROM exam_papers WHERE source = 'course'").get().n === 1);
        const bad = await call('POST', `/api/projects/${course}/mock-exams/draw`, { size: 0 });
        check('a draw of 0 questions is refused', bad.status === 400, String(bad.status));
    });

    await block('2. nothing of the key leaves while the mock is open', async () => {
        const r = await call('GET', `/api/mock-sittings/${first}`);
        check('no key, accepted answers or explanation in the open mock',
            r.status === 200 && !/correct_answer|"accept"|explanation|"correct"|tolerance/.test(r.text), r.text.slice(0, 200));
        check('each of the 10 questions carries its report ref', (r.body?.course?.questions ?? []).length === 10 && r.body.course.questions.every(q => /^q:/.test(q.ref)));
        check('and no result yet', r.status === 200 && r.body?.sitting?.status === 'writing' && r.body?.result == null);

        // The "this is wrong" flag sits on every question: its preview and the
        // report it files must not hand the key over either.
        const ref0 = r.body?.course?.questions?.[0]?.ref;
        global.__ref0 = ref0;
        const tgt = await call('GET', `/api/item-reports/target?ref=${encodeURIComponent(ref0)}`);
        check('the report preview of an open mock question shows the question without its key or explanation',
            tgt.status === 200 && typeof tgt.body?.item?.question === 'string'
                && tgt.body.item.correct_answer === undefined && tgt.body.item.explanation === undefined, tgt.text.slice(0, 200));
        const filed = await call('POST', '/api/item-reports', { ref: ref0, reason: 'unclear', surface: 'mock' });
        check('a report filed while the mock is open answers without the key',
            filed.status >= 200 && filed.status < 300 && typeof filed.body?.report?.item?.question === 'string'
                && filed.body.report.item.correct_answer === undefined && filed.body.report.item.explanation === undefined, filed.text.slice(0, 200));
        if (filed.body?.report?.id) await call('DELETE', `/api/item-reports/${filed.body.report.id}`);

        // The assistant's page context: the mock's own listing that claims the
        // item was graded (or its key shown) still gets no key for an open mock's question.
        const { buildPageContext } = await import(S + 'pageContext.js');
        const pc = buildPageContext({ view: 'exam', items: [{ ref: ref0, answer: 'Beta', correct: true, keyShown: true, current: true, surface: 'mock' }] }).text;
        check('the assistant is not handed an open mock question\'s key, whatever the mock\'s screen claims',
            pc.includes(`[${ref0}]`) && !/Answer key: (?!not on their screen)|Explanation stored with it/.test(pc), pc.slice(-900));
        // The same question met in a practice quiz while this mock waits with
        // Resume: the quiz showed its verdict, so the assistant gets the key.
        const quiz = buildPageContext({ view: 'quiz', items: [{ ref: ref0, answer: 'Gamma', correct: false, current: true }] }).text;
        check('the same question answered in a quiz keeps its key for the assistant while the mock is open',
            /Answer key: Beta/.test(quiz) && /Explanation stored with it/.test(quiz), quiz.slice(-900));

        const paperId = db.prepare('SELECT paper_id FROM mock_sittings WHERE id = ?').get(first)?.paper_id;
        const before = db.prepare('SELECT COUNT(*) n FROM mock_sittings WHERE paper_id = ?').get(paperId).n;
        const again = await call('POST', `/api/mock-exams/papers/${paperId}/sittings`, {});
        check('a drawn set takes no second sitting: a new mock is drawn anew',
            again.status === 400 && db.prepare('SELECT COUNT(*) n FROM mock_sittings WHERE paper_id = ?').get(paperId).n === before, `${again.status} ${again.text.slice(0, 120)}`);
    });

    await block('3. an answer is never lost', async () => {
        const d = await detail(first);
        const p = d.course.questions[0];
        const a1 = await call('PUT', `/api/mock-sittings/${first}/answers`, { partId: p.partId, answer: 'Beta', attemptId: 'same-id' });
        check('an answer is saved', a1.status === 200, a1.text);
        check('the save says nothing about right or wrong', !/correct|"points"/.test(a1.text), a1.text);
        const a2 = await call('PUT', `/api/mock-sittings/${first}/answers`, { partId: p.partId, answer: 'Gamma', attemptId: 'same-id' });
        check('the same attempt id again is a retry: written once, the first answer stands',
            a2.status === 200 && a2.body?.duplicate === true && (await detail(first)).course.questions[0].answer === 'Beta', a2.text);
        const other = await call('PUT', `/api/mock-sittings/${first}/answers`, { partId: d.course.questions[2].partId, answer: 'Beta', attemptId: 'same-id' });
        check('the same attempt id for ANOTHER question is a 409, not the first save\'s duplicate, and writes nothing',
            other.status === 409 && !(await detail(first)).course.questions[2].answer, `${other.status} ${other.text.slice(0, 160)}`);
        await call('POST', `/api/mock-sittings/${first}/pause`);
        const a3 = await answer(first, d.course.questions[1].partId, 'Beta', { later: true });
        check('an answer sent while paused is kept (a save racing the pause is never dropped)', a3.status === 200, a3.text);
        const back = await detail(first);
        check('it reads back with its "come back to this" mark', back.course.questions[1].answer === 'Beta' && back.course.questions[1].later === true);
        check('the counts: 2 answered, 8 left, 1 to come back to',
            back.course.answered === 2 && back.course.left === 8 && back.course.later === 1, JSON.stringify(back.course));
        const off = await answer(first, 999999, 'Beta');
        check('a question not in this mock is refused', off.status === 400, String(off.status));
        const stop = await call('POST', `/api/mock-sittings/${first}/stop`);
        check('"Finish writing" (a past paper\'s step) is refused: a course mock ends with Finish',
            stop.status === 400 && (await detail(first))?.sitting?.status === 'writing', `${stop.status} ${stop.text.slice(0, 120)}`);
        const badId = await call('POST', `/api/mock-sittings/${first}/finish`, { attemptId: 'not an id!' });
        check('a finish with a malformed attempt id is refused and hands nothing in',
            badId.status === 400 && (await detail(first))?.sitting?.status === 'writing', `${badId.status} ${badId.text.slice(0, 120)}`);

        // The clock: one minute, answered in time, then past it.
        const one = mock.drawCourseMock(course, { size: 3, minutes: 1, now: T0 });
        const sid = one.sitting.id;
        const parts = mock.sittingDetail(sid, { now: T0 }).course.questions.map(q => q.partId);
        mock.saveAnswer(sid, { partId: parts[0], answer: 'Beta', attemptId: 't1', now: T0 + 30_000 });
        mock.pauseSitting(sid, { now: T0 + 40_000 });
        check('leaving banks the clock: 40 s used', mock.getSitting(sid, { now: T0 + 999_000 }).elapsed === 40);
        mock.resumeSitting(sid, { now: T0 + 1_000_000 });
        const late = mock.getSitting(sid, { now: T0 + 1_100_000 });
        check('time up hands nothing in: the mock is still open', late.timeUp === true && late.status === 'writing', JSON.stringify(late));
        mock.saveAnswer(sid, { partId: parts[1], answer: 'Beta', attemptId: 't2', now: T0 + 1_100_000 });
        mock.saveAnswer(sid, { partId: parts[0], answer: 'Gamma', attemptId: 't3', now: T0 + 1_100_000 });
        const done = mock.finishSitting(sid, { now: T0 + 1_200_000, attemptId: 'f-one' });
        const res = done.result;
        check('the result is the in-time one: 1 right in time', res?.right === 1 && res?.total === 3, JSON.stringify(res));
        check('the extra time is told apart: 1 right with it (one more answered, one changed to wrong)',
            res?.late?.right === 1 && res?.late?.answered === 2, JSON.stringify(res?.late));

        // Right in time, then cleared after it. The score is the in-time one;
        // the late line, the topics and the review read the final answers, and
        // the late line is what tells the two apart on the result.
        const two = mock.drawCourseMock(course, { size: 2, minutes: 1, now: T0 });
        const twoParts = mock.sittingDetail(two.sitting.id, { now: T0 }).course.questions.map(q => q.partId);
        mock.saveAnswer(two.sitting.id, { partId: twoParts[0], answer: 'Beta', attemptId: 'c1', now: T0 + 10_000 });
        mock.saveAnswer(two.sitting.id, { partId: twoParts[0], answer: '', attemptId: 'c2', now: T0 + 120_000 });
        const cleared = mock.finishSitting(two.sitting.id, { now: T0 + 130_000, attemptId: 'f-two' }).result;
        const row0 = cleared?.review?.find(x => x.partId === twoParts[0]);
        check('an answer right in time and cleared after: 1 right of 2 in time, 1 not answered in time',
            cleared?.right === 1 && cleared?.total === 2 && cleared?.notAnswered === 1, JSON.stringify({ r: cleared?.right, t: cleared?.total, na: cleared?.notAnswered }));
        check('and the late line says what stood at the end: 0 right of 0 answered; the review files it under not answered',
            cleared?.late?.right === 0 && cleared?.late?.answered === 0 && row0?.group === 'none', JSON.stringify({ late: cleared?.late, group: row0?.group }));
    });

    await block('4. the score, the spread and the answers read back', async () => {
        check('31 of 40: the level on these topics is most likely 25 to 35 of 40 (Wilson 95%)',
            JSON.stringify(mock.spreadOf?.(31, 40)) === JSON.stringify({ low: 25, high: 35 }), JSON.stringify(mock.spreadOf?.(31, 40)));
        check('7 of 10: 4 to 9', JSON.stringify(mock.spreadOf?.(7, 10)) === JSON.stringify({ low: 4, high: 9 }), JSON.stringify(mock.spreadOf?.(7, 10)));
        check('0 of 5 never goes below 0, 5 of 5 never above 5',
            mock.spreadOf?.(0, 5)?.low === 0 && mock.spreadOf?.(5, 5)?.high === 5);

        // Answer the first mock: Heat all right; one wrong; one wrong and
        // marked to come back to; one left open; the rest right.
        const d = await detail(first);
        const qs = d.course.questions;
        // The wrong answer is on Optics, a completed topic, so "a wrong answer
        // reopens nothing" is asked of a topic that got one.
        const wrong = qs.find(q => KEY.get(refUuid(q)).nodeId === optics);
        const nonHeat = qs.filter(q => KEY.get(refUuid(q)).nodeId !== heat && q !== wrong);
        const wrongLater = nonHeat[0], open = nonHeat[1];
        for (const q of qs) {
            if (q === open) { await answer(first, q.partId, '', { later: false }); continue; }
            const k = KEY.get(refUuid(q));
            const value = q === wrong || q === wrongLater ? k.wrong : k.key;
            await answer(first, q.partId, value, { later: q === wrongLater });
        }
        global.__first = { wrong, wrongLater, open, qs };
        const before = { heat: getNodeMastery(heat).mastery_score, optics: getNodeMastery(optics).mastery_score };
        global.__before = before;
        const f = await call('POST', `/api/mock-sittings/${first}/finish`, { attemptId: 'finish-1' });
        const r = f.body?.result;
        check('finishing gives the result', f.status === 200 && r != null, f.text.slice(0, 300));
        check('7 right of 10', r?.right === 7 && r?.total === 10, JSON.stringify({ right: r?.right, total: r?.total }));
        check('1 not answered, counted as zero', r?.notAnswered === 1);
        check('its spread is 4 to 9', r?.spread?.low === 4 && r?.spread?.high === 9, JSON.stringify(r?.spread));
        check('no exam described: no pass line, and it says this is not a grade', r?.passRight == null && r?.notGrade === true);
        const groups = (r?.review ?? []).map(x => x.group);
        check('answers read back wrong first, then wrong and marked, then not answered, then right',
            groups.join(',') === ['wrong', 'wrong_later', 'none', ...Array(7).fill('right')].join(','), groups.join(','));
        check('now the key and the explanation come with them',
            (r?.review ?? []).every(x => x.question?.correct_answer === 'Beta' && /^Because/.test(x.question?.explanation ?? '')));
        const tgt = await call('GET', `/api/item-reports/target?ref=${encodeURIComponent(global.__ref0)}`);
        check('and the report preview shows the key again once the mock is finished',
            tgt.status === 200 && tgt.body?.item?.correct_answer === 'Beta', tgt.text.slice(0, 200));
        check('by topic: Heat 2 of 2 right', (r?.topics ?? []).some(t => t.id === heat && t.right === 2 && t.total === 2), JSON.stringify(r?.topics));
    });

    await block('5. the evidence: practice, both ways, never proof', async () => {
        const { wrong, open, qs } = global.__first;
        // Only this mock's rows: the clock case above wrote its own.
        const firstUuid = db.prepare('SELECT uuid FROM mock_sittings WHERE id = ?').get(first)?.uuid;
        const mockRows = (n) => allRowsOf(n).filter(r => JSON.parse(r.metadata || '{}').sitting === firstUuid);
        const answeredBy = new Map();
        for (const q of qs) {
            if (q === open) continue;
            const n = KEY.get(refUuid(q)).nodeId;
            answeredBy.set(n, (answeredBy.get(n) || 0) + 1);
        }
        for (const [n, total] of answeredBy) {
            const rows = mockRows(n);
            check(`topic ${n}: one mock row of ${total} answered`, rows.length === 1 && rows[0].total === total, JSON.stringify(rows));
        }
        check('the unanswered question writes nothing: 9 answers across the rows',
            [...answeredBy.keys()].reduce((a, n) => a + (mockRows(n)[0]?.total ?? 0), 0) === 9);
        check('Heat\'s estimate went up', getNodeMastery(heat).mastery_score > global.__before.heat);
        check('Heat is still in progress: all right completes nothing', statusOf(heat) === 'in_progress');
        check('Optics is still completed: a wrong answer reopens nothing', statusOf(optics) === 'completed');
        const el = checkMasteryEligibility(heat);
        check('the gate reads none of it: Heat\'s gate score stays 0', el.gate_score === 0, JSON.stringify(el));
        const n = allMockRows();
        const again = await call('POST', `/api/mock-sittings/${first}/finish`, { attemptId: 'finish-2' });
        check('a second finish writes nothing and returns the same result', again.status === 200 && again.body?.result?.right === 7 && allMockRows() === n);
        const logRows = () => db.prepare("SELECT COUNT(*) n FROM question_log WHERE surface = 'mock'").get().n;
        const logN = logRows();
        const replay = await call('POST', `/api/mock-sittings/${first}/finish`, { attemptId: 'finish-1' });
        check('the same finish resent (a retry after a lost response) writes nothing and returns the result',
            replay.status === 200 && replay.body?.result?.right === 7 && allMockRows() === n && logRows() === logN, replay.text.slice(0, 200));
        const after = await answer(first, qs[0].partId, 'Gamma');
        check('a finished mock takes no more answers', after.status === 409, String(after.status));
        // Answered ones only: 2 of the clock case's 3, 9 of this mock's 10. A
        // question left open was not asked of the learner in any useful sense,
        // and logging it would push it behind the never-asked ones.
        const logged = db.prepare("SELECT COUNT(*) n FROM question_log WHERE surface = 'mock'").get().n;
        check('only answered questions are logged, so the next draw asks the rest first: 2 + 9', logged === 11, String(logged));
        // Never asked = not in the question log (the clock case in block 3 asked some too).
        const loggedUuids = new Set(db.prepare('SELECT question_uuid u FROM question_log WHERE question_uuid IS NOT NULL').all().map(r => r.u));
        const fresh = [...READY].filter(u => !loggedUuids.has(u));
        const next = mock.drawCourseMock(course, { size: 4, minutes: null, now: T0 });
        const nextUuids = mock.sittingDetail(next.sitting.id, { now: T0 }).course.questions.map(refUuid);
        check(`the next draw of 4 asks the never-asked ones first (${fresh.length} left)`,
            fresh.length > 0 && nextUuids.filter(u => !loggedUuids.has(u)).length === Math.min(4, fresh.length),
            JSON.stringify({ fresh, nextUuids }));
        mock.discardSitting(next.sitting.id);

        const wrongTopic = KEY.get(refUuid(wrong)).nodeId;
        const beforeRows = mockRows(wrongTopic)[0];
        const rep = await call('POST', '/api/item-reports', { ref: wrong.ref, reason: 'wrong', surface: 'mock' });
        const afterRows = mockRows(wrongTopic)[0];
        check('a reported question leaves the mock row it was in', rep.status >= 200 && rep.status < 300 && afterRows && afterRows.total === beforeRows.total - 1,
            `${rep.status} ${JSON.stringify(beforeRows)} -> ${JSON.stringify(afterRows)}`);
        const reread = (await detail(first))?.result;
        check('and the result leaves it out too: 7 right of 9, 1 reported', reread?.right === 7 && reread?.total === 9 && reread?.reported === 1, JSON.stringify({ r: reread?.right, t: reread?.total, x: reread?.reported }));
    });

    await block('6. a pass line only when the real exam is this', async () => {
        check('nothing described: the clock is off by default', mock.courseReadiness(course)?.clockOn === false);
        const bad = await call('PUT', `/api/projects/${course}/exam`, { onScreen: true, questions: 10, minutes: 15, passRight: 11 });
        check('a pass line above the number of questions is refused', bad.status === 400, String(bad.status));
        const ok = await call('PUT', `/api/projects/${course}/exam`, { onScreen: true, questions: 10, minutes: 15, passRight: 7 });
        check('the real exam is described: on screen, 10 questions, 15 min, pass at 7', ok.status === 200, ok.text);
        const ready = mock.courseReadiness(course);
        check('an on-screen exam turns the clock on by default', ready?.clockOn === true && ready?.exam?.questions === 10, JSON.stringify(ready));

        db.prepare("UPDATE nodes SET status = 'in_progress' WHERE id = ?").run(optics);
        const same = mock.drawCourseMock(course, { size: 10, minutes: 15, now: T0 });
        const sd = mock.sittingDetail(same.sitting.id, { now: T0 });
        for (const q of sd.course.questions) mock.saveAnswer(same.sitting.id, { partId: q.partId, answer: 'Beta', attemptId: `p${q.partId}`, now: T0 + 1000 });
        const r1 = mock.finishSitting(same.sitting.id, { now: T0 + 60_000, attemptId: 'f-same' }).result;
        check('a mock in the real exam\'s format shows its pass line: 10 right, pass at 7, passed',
            r1?.right === 10 && r1?.passRight === 7 && r1?.passed === true && r1?.notGrade === false, JSON.stringify({ r: r1?.right, p: r1?.passRight, ok: r1?.passed, ng: r1?.notGrade }));
        // A full mock row on one topic is what a real check would pass on
        // (MIN_GATE_QUESTIONS right): the gate still must not read it.
        // The draw shuffles, so which of Waves and Optics gets four is chance;
        // with at most 2 from Heat one of them always does (8 of 10 between
        // two). Both are made "in progress" first, so either is the case.
        const sameUuid = db.prepare('SELECT uuid FROM mock_sittings WHERE id = ?').get(same.sitting.id)?.uuid;
        const rowOf = (id) => allRowsOf(id).find(x => JSON.parse(x.metadata || '{}').sitting === sameUuid);
        const full = [waves, optics].find(id => (rowOf(id)?.total ?? 0) >= 4);
        const fullRow = full && rowOf(full);
        check('one topic got a mock row of 4 or more, every one right', fullRow && fullRow.score === fullRow.total,
            JSON.stringify({ waves: rowOf(waves), optics: rowOf(optics) }));
        check('and is still not ready for its check: a mock is practice, never proof', full != null && checkMasteryEligibility(full).eligible === false && statusOf(full) === 'in_progress',
            JSON.stringify(full && checkMasteryEligibility(full)));
        db.prepare("UPDATE nodes SET status = 'completed' WHERE id = ?").run(optics);

        // A question reported after the finish shortens the mock to 9: it is
        // no longer the real exam's length, so its pass line goes.
        const sameRef = sd.course.questions[0].ref;
        const rep = await call('POST', '/api/item-reports', { ref: sameRef, reason: 'wrong', surface: 'mock' });
        const shortened = mock.sittingDetail(same.sitting.id, { now: T0 + 70_000 }).result;
        check('a reported question takes the pass line away: 9 of 9, not a grade',
            rep.status >= 200 && rep.status < 300 && shortened?.total === 9 && shortened?.passRight == null && shortened?.passed == null && shortened?.notGrade === true,
            JSON.stringify({ s: rep.status, t: shortened?.total, p: shortened?.passRight, ok: shortened?.passed, ng: shortened?.notGrade }));
        if (rep.body?.report?.id) await call('DELETE', `/api/item-reports/${rep.body.report.id}`);
        const restored = mock.sittingDetail(same.sitting.id, { now: T0 + 70_000 }).result;
        check('and the report undone brings it back: 10 right, pass at 7', restored?.total === 10 && restored?.passRight === 7 && restored?.passed === true,
            JSON.stringify({ t: restored?.total, p: restored?.passRight }));

        const short =mock.drawCourseMock(course, { size: 4, minutes: 6, now: T0 });
        const rowsBefore = allMockRows();
        const logBefore = db.prepare("SELECT COUNT(*) n FROM question_log WHERE surface = 'mock'").get().n;
        const r2 = mock.finishSitting(short.sitting.id, { now: T0 + 1000, attemptId: 'f-short' }).result;
        check('a shorter mock has no pass line: it is not a grade', r2?.passRight == null && r2?.notGrade === true, JSON.stringify({ p: r2?.passRight, ng: r2?.notGrade }));
        check('a mock nobody answered writes no evidence and logs no question',
            r2?.notAnswered === 4 && allMockRows() === rowsBefore
                && db.prepare("SELECT COUNT(*) n FROM question_log WHERE surface = 'mock'").get().n === logBefore,
            JSON.stringify({ na: r2?.notAnswered, rows: [rowsBefore, allMockRows()] }));

        await call('PUT', `/api/projects/${course}/exam`, { onScreen: false });
        check('a written exam: the clock is off by default again', mock.courseReadiness(course)?.clockOn === false);
    });

    await block('7. a question set kept apart from the attempt, named for sync, gone with the course', async () => {
        const list = await call('GET', `/api/projects/${course}/mock-exams`);
        check('the past-paper list holds no course draw', list.status === 200 && Array.isArray(list.body?.courseSittings) && (list.body?.papers ?? []).every(p => p.source !== 'course'));
        check('the earlier course mocks are listed', (list.body?.courseSittings ?? []).length >= 3, String(list.body?.courseSittings?.length));
        const set = db.prepare("SELECT COUNT(*) n FROM exam_paper_parts p JOIN exam_papers e ON e.id = p.paper_id WHERE e.source = 'course' AND p.item IS NOT NULL").get().n;
        check('a drawn set keeps the questions as they were asked', set > 0);
        for (const t of ['exam_papers', 'exam_paper_parts', 'mock_sittings', 'mock_part_scores']) {
            const blank = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE uuid IS NULL`).get().n;
            check(`${t} is synced and every row has a uuid`, SYNC_TABLES[t]?.uuid === true && blank === 0);
        }
        db.prepare('DELETE FROM projects WHERE id = ?').run(course);
        const left = ['exam_papers', 'exam_paper_parts', 'mock_sittings', 'mock_part_scores']
            .map(t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n).reduce((a, b) => a + b, 0);
        check('deleting the course deletes its drawn sets, mocks and answers', left === 0, String(left));
    });

    await block('8. the screen keeps answers through a lapsed sign-in and hides what the exam hides', async () => {
        const src = (p) => readFileSync(join(ROOT, p), 'utf8');
        const course = src('src/components/mockExam/CourseMock.tsx');
        const permanent = course.match(/const PERMANENT = new Set\(\[([^\]]*)\]\)/)?.[1]?.split(',').map(s => Number(s.trim())) ?? [];
        check('an answer the server refused with 401 or 403 stays queued (a sign-in that lapsed), 409 is let go',
            permanent.includes(409) && !permanent.includes(401) && !permanent.includes(403), JSON.stringify(permanent));
        check('the answer field rests while the mock is handed in: disabled by `finishing`, set before the finish is sent',
            /<AnswerInput[^>]*disabled=\{finishing/.test(course)
                && /setFinishing\(true\);[^]{0,300}?api\.finishMock/.test(course.match(/const finish = async[^]*?\n {4}\};/)?.[0] ?? ''));
        // The flag lists the mock's questions as the mock's own, so the
        // server withholds the key for them and not for the same question
        // in a quiz.
        check('the flag tells the screen list which surface an item is on',
            /useScreenItem\(itemRef, shown, \{[^}]*\bsurface\b[^}]*\}\)/.test(src('src/components/ui/ReportItem.tsx'))
                && /surface: 'mock'/.test(src('src/utils/itemReportStore.ts')));
        check('the docked assistant makes no room while an exam holds the window',
            /assistantDocked = [^;]*&& !examFocus/.test(src('src/components/Layout.tsx')));
        check('the background-task bar stays out of an exam (it comes back after)',
            /\{!examFocus && <TaskDock \/>\}/.test(src('src/components/Layout.tsx')));
        const paperSrc = src('src/components/mockExam/MockSittingScreen.tsx');
        check('a past paper\'s way out says Back, not Save and leave',
            /<ExamFrame [^>]*leaveLabel=\{t\("Back"\)\}/.test(paperSrc));
        check('a paused past paper leads with Resume; Finish writing is then the quiet button',
            /variant=\{paused \? 'primary' : 'neutral'\}[^\n]*\n\s*\{sitting\.running \? t\("Pause"\) : t\("Resume"\)\}/.test(paperSrc)
                && /variant=\{paused \? 'neutral' : 'primary'\}[^\n]*act\('stop'\)\}>\{t\("Finish writing"\)\}/.test(paperSrc));
    });

    await block('9. the screen\'s decisions: where a mock opens, the save line, the clocks a closing page pauses', async () => {
        const esbuild = createRequire(import.meta.url)('esbuild');
        const outfile = join(scratch, 'courseMockState.mjs');
        await esbuild.build({
            entryPoints: [join(ROOT, 'src/components/mockExam/courseMockState.ts')],
            bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
        });
        const ui = await import(pathToFileURL(outfile).href);
        const answered = [true, false, true, false];
        check('nothing kept for this tab (another device, a closed tab): it opens on the first question not answered',
            ui.openingPlace(null, answered) === 1, String(ui.openingPlace(null, answered)));
        check('the question this tab was on wins', ui.openingPlace('2', answered) === 2);
        check('a kept place outside the mock, or not a number, falls back to the first not answered',
            ui.openingPlace('9', answered) === 1 && ui.openingPlace('x', answered) === 1 && ui.openingPlace('', answered) === 1);
        check('everything answered and nothing kept: the first question', ui.openingPlace(null, [true, true]) === 0);

        check('nothing waiting: the save line says nothing', ui.saveState(0, 7) === 'saved');
        check('a save on its way or tried again once or twice: "saving…"', ui.saveState(1, 0) === 'saving' && ui.saveState(2, ui.STUCK_AFTER - 1) === 'saving');
        check(`after ${ui.STUCK_AFTER} failed sends in a row (no connection): it says the answers are not saved`,
            ui.STUCK_AFTER >= 2 && ui.saveState(1, ui.STUCK_AFTER) === 'stuck');
        const course = readFileSync(join(ROOT, 'src/components/mockExam/CourseMock.tsx'), 'utf8');
        check('the mock screen opens where openingPlace says and words its save line by saveState',
            /useState\(\(\) => openingPlace\(readPlace\(placeKey\)/.test(course)
                && /saving === 'stuck' \? t\("not saved yet, check the connection"\)/.test(course)
                && /setFailedInARow\(0\)/.test(course) && /setFailedInARow\(n => n \+ 1\)/.test(course));

        const list = {
            papers: [{ sittings: [{ id: 1, status: 'writing', running: true }, { id: 2, status: 'marking', running: false }] }],
            courseSittings: [{ id: 5, status: 'writing', running: true }, { id: 6, status: 'writing', running: false }, { id: 7, status: 'done', running: false }],
        };
        check('a closing page pauses every running clock in the list, course mocks too, and the open one, once each',
            JSON.stringify(ui.runningSittings(list, 1).sort((a, b) => a - b)) === '[1,5]'
                && JSON.stringify(ui.runningSittings(list, 9).sort((a, b) => a - b)) === '[1,5,9]'
                && JSON.stringify(ui.runningSittings(null, null)) === '[]',
            JSON.stringify(ui.runningSittings(list, 9)));
        check('the mock exam list uses it', /running\.current = runningSittings\(data, open\)/.test(readFileSync(join(ROOT, 'src/components/mockExam/MockExamView.tsx'), 'utf8')));
    });

    await block('10. every format checked alone, a placement answer, one read for the course', async () => {
        const node = (pid, title, status, pos) => Number(db.prepare(
            'INSERT INTO nodes (project_id, parent_id, title, position, status) VALUES (?, NULL, ?, ?, ?)',
        ).run(pid, title, pos, status).lastInsertRowid);
        const chem = Number(db.prepare("INSERT INTO projects (name) VALUES ('Chemistry')").run().lastInsertRowid);
        const states = node(chem, 'States of matter', 'in_progress', 0);
        const probed = node(chem, 'Bonds', 'not_started', 1);
        const seq = { uuid: randomUUID(), type: 'sequence', question: 'Order the steps of heating ice.', items: ['Boil', 'Melt', 'Warm the ice'], correct_answer: JSON.stringify(['Warm the ice', 'Melt', 'Boil']), explanation: 'Heat flows in.' };
        const asm = { uuid: randomUUID(), type: 'assemble', question: 'Build the sentence.', template: 'Water is made of ___ and ___.', correct_answer: JSON.stringify(['hydrogen', 'oxygen']), tokens: ['oxygen', 'carbon', 'hydrogen'], explanation: 'Two kinds of atom.' };
        const num = { uuid: randomUUID(), type: 'numeric', question: 'Free fall acceleration at the surface?', correct_answer: '9.81', unit: 'm/s^2', tolerance: 0.01, explanation: 'Measured.' };
        const fill = { uuid: randomUUID(), type: 'fill_in', question: 'The capital of the Netherlands is ___.', correct_answer: 'Amsterdam', accept: ['Mokum'], explanation: 'By the constitution.' };
        bank(states, [seq, asm, num, fill]);
        bank(probed, [mc(probed, 1), mc(probed, 2)]);
        // The placement probe answered one question on Bonds before any study.
        db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total) VALUES (?, 'placement', 1, 1)").run(probed);

        const ready = mock.courseReadiness(chem);
        check('a topic with only a placement answer is not studied yet: 1 studied, 1 left out, 4 ready',
            ready?.studied === 1 && ready?.notStudied === 1 && ready?.ready === 4, JSON.stringify(ready));

        const r = await call('POST', `/api/projects/${chem}/mock-exams/draw`, { size: 4, minutes: null });
        const sid = r.body?.sitting?.id;
        const open = await call('GET', `/api/mock-sittings/${sid}`);
        const qs = open.body?.course?.questions ?? [];
        check('an ordering, an assembly, a number and a typed word are drawn',
            ['sequence', 'assemble', 'numeric', 'fill_in'].every(t => qs.some(q => q.question?.type === t)), JSON.stringify(qs.map(q => q.question?.type)));
        check('the whole open mock holds nothing of any key: no key field, accepted answer, tolerance, explanation or key value',
            open.status === 200 && !/correct_answer|"accept"|tolerance|explanation|9\.81|Amsterdam|Mokum|Heat flows|Two kinds/.test(open.text), open.text.slice(0, 400));
        check('an ordering comes in its stored, shuffled order, never the key\'s',
            JSON.stringify(qs.find(q => q.question?.type === 'sequence')?.question?.items) === JSON.stringify(seq.items));
        const right = { sequence: seq.correct_answer, assemble: asm.correct_answer, numeric: '9.81', fill_in: 'Amsterdam' };
        for (const q of qs) await answer(sid, q.partId, right[q.question.type]);
        const f = await call('POST', `/api/mock-sittings/${sid}/finish`, { attemptId: 'finish-chem' });
        check('the app checks each of them alone: 4 right of 4',
            f.body?.result?.right === 4 && f.body?.result?.total === 4, JSON.stringify(f.body?.result?.review?.map(x => [x.question?.type, x.correct])));

        // The list reads what a course can draw on every open: its cost must
        // not grow with the number of topics (no statement per topic).
        const bio = Number(db.prepare("INSERT INTO projects (name) VALUES ('Biology')").run().lastInsertRowid);
        for (let i = 0; i < 6; i++) { const id = node(bio, `Cell ${i}`, 'in_progress', i); bank(id, [mc(id, 1)]); }
        const prepares = (fn) => {
            let n = 0;
            const own = db.prepare;
            db.prepare = function (...a) { n++; return own.apply(this, a); };
            try { fn(); } finally { delete db.prepare; }
            return n;
        };
        mock.courseReadiness(chem); mock.courseReadiness(bio);
        const one = prepares(() => mock.courseReadiness(chem));
        const six = prepares(() => mock.courseReadiness(bio));
        check('what a course can draw is read with no statement per topic: as many for 6 topics as for 1',
            one === six, JSON.stringify({ one, six }));
        const drawn = [];
        const dOne = prepares(() => drawn.push(mock.drawCourseMock(chem, { size: 1, now: T0 })));
        const dSix = prepares(() => drawn.push(mock.drawCourseMock(bio, { size: 1, now: T0 })));
        check('and a draw orders the course in one read too: as many statements for 6 topics as for 1',
            dOne === dSix, JSON.stringify({ dOne, dSix }));
        for (const d of drawn) mock.discardSitting(d.sitting.id);
    });
} finally {
    server.close();
    db.close();
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the file a moment */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

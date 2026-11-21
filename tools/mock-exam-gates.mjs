#!/usr/bin/env node
/**
 * tools/mock-exam-gates.mjs — a past paper, sat by hand, marked by the learner.
 *
 *   node tools/mock-exam-gates.mjs [--root DIR]
 *
 * A mock exam is a real old paper written on paper with the app as the clock,
 * then marked part by part against the official worked solution. What this
 * suite pins:
 *
 *   1. the grade comes from the paper's own formula and the pass line is shown
 *      in points (a 79-point paper, grade = points / 79 * 9 + 1, pass
 *      at 5.5 = 39.5 points, in halves like the points themselves);
 *   2. a paper's points table is checked when it is added (no zero-point part,
 *      no topic or document from another course, no document without a stored
 *      file or of a kind the browser cannot show);
 *   3. the clock is the server's and only moves while it runs: pause banks it,
 *      leaving never loses it, time up never hands in by itself;
 *   4. marks are points per part, never more than the part is worth, and only
 *      while marking;
 *   5. a finished mock is PRACTICE evidence: it moves each tagged topic's
 *      estimate up or down, never proves, completes or reopens a topic, is
 *      written once, and an unmarked part writes nothing;
 *   6. one question is a sitting of its own, with a points total and no grade;
 *   7. the result orders questions by points lost;
 *   8. the new tables are named for a later sync (a uuid on every row) and go
 *      with their course;
 *   9. the running clock keeps its hours and minutes on one line;
 *  10. the parts are checked against the total printed on the paper;
 *  11. the result names the topic that lost the most points, and both results
 *      open its study stream;
 *  12. the paper and its solution can be uploaded inside the add dialog;
 *  13. a course mock can hide its clock too, and a hidden clock comes back for
 *      the last five minutes;
 *  14. time away (a call) can be taken off a past paper's running clock, and
 *      only a past paper's;
 *  15. the clock screen fits a phone held either way.
 * (Blocks 10-15 run before 8, which deletes the course.)
 *
 * --root runs the same cases against another checkout's server; on the code
 * before mock exams existed every case fails.
 *
 * Deterministic: a scratch library, no model, no network, no wall clock (the
 * clock cases pass their own `now`).
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from 'node:http';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = resolve(argOf('--root') || repo);

// Set in-process, before any server module is imported.
const scratch = mkdtempSync(join(tmpdir(), 'mock-exam-gates-'));
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
const mastery = await import(S + 'mastery.js');
const { getNodeMastery, checkMasteryEligibility } = mastery;
const { SYNC_TABLES } = await import(S + 'syncTables.js');
const { createApp } = await import(S + 'app.js');
// The module is new; on the code before it, every case below fails instead
// of the suite stopping at the import.
const mockPath = join(ROOT, 'server', 'mockExams.js');
const mock = existsSync(mockPath) ? await import(S + 'mockExams.js') : null;

const server = createApp().listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const { port } = server.address();
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

const course = Number(db.prepare("INSERT INTO projects (name) VALUES ('Mathematics B')").run().lastInsertRowid);
const other = Number(db.prepare("INSERT INTO projects (name) VALUES ('Physics')").run().lastInsertRowid);
const addNode = (pid, title, status = 'not_started') => Number(db.prepare(
    'INSERT INTO nodes (project_id, parent_id, title, position, status) VALUES (?, NULL, ?, 0, ?)',
).run(pid, title, status).lastInsertRowid);
const derivatives = addNode(course, 'Derivatives', 'in_progress');
const integrals = addNode(course, 'Integrals', 'completed');
const vectors = addNode(course, 'Vectors');
const foreign = addNode(other, 'Optics');
const score = (id) => getNodeMastery(id).mastery_score;
const statusOf = (id) => db.prepare('SELECT status FROM nodes WHERE id = ?').get(id).status;
const evidenceOf = (id) => db.prepare("SELECT score, total, evidence_type FROM mastery_evidence WHERE node_id = ? ORDER BY id").all(id);

// A sample paper's cover: 3 hours, five questions worth 20, 18, 14, 14
// and 13 = 79 points, "mark = score / 79 * 9 + 1", pass at 5.5.
const PAPER = {
    title: 'Sample exam 19',
    minutes: 180,
    gradeMin: 1, gradeMax: 10, passGrade: 5.5,
    parts: [
        { question: '1', part: 'a', points: 8, nodeId: derivatives },
        { question: '1', part: 'b', points: 12, nodeId: derivatives },
        { question: '2', part: '', points: 18, nodeId: integrals },
        { question: '3', part: 'a', points: 6, nodeId: vectors },
        { question: '3', part: 'b', points: 8, nodeId: vectors },
        { question: '4', part: '', points: 14, nodeId: null },
        { question: '5', part: '', points: 13, nodeId: derivatives },
    ],
};
const papersPath = `/api/projects/${course}/mock-exams`;

try {
    let paper = null;

    await block('1. the grade is the paper\'s own formula; the pass line is in points', async () => {
        const g = mock?.gradeFor;
        check('module exports gradeFor and passPointsFor', typeof g === 'function' && typeof mock?.passPointsFor === 'function');
        const p = { total: 79, gradeMin: 1, gradeMax: 10, passGrade: 5.5 };
        check('79 of 79 is a 10', g(p, 79) === 10, String(g(p, 79)));
        check('0 of 79 is a 1', g(p, 0) === 1, String(g(p, 0)));
        check('40 of 79 is a 5.6 (one decimal, as printed)', g(p, 40) === 5.6, String(g(p, 40)));
        check('the pass line of 5.5 is 39.5 points (points come in halves, so it is never rounded to a whole point)', mock.passPointsFor(p) === 39.5, String(mock.passPointsFor(p)));
        check('39.5 of 79 is exactly a 5.5', g(p, 39.5) === 5.5, String(g(p, 39.5)));
        check('the line follows the PRINTED grade: pass at 5.6 on 79 is 40 points, because 40 prints 5.6', mock.passPointsFor({ ...p, passGrade: 5.6 }) === 40, String(mock.passPointsFor({ ...p, passGrade: 5.6 })));
        // Every half point on three papers: "passed" (earned >= line) says the
        // same as the grade on screen reaching the pass grade.
        let disagree = [];
        for (const shape of [p, { ...p, passGrade: 5.6 }, { ...p, passGrade: 6 }, { total: 200, gradeMin: 1, gradeMax: 10, passGrade: 5.5 }, { total: 37, gradeMin: 0, gradeMax: 10, passGrade: 5.5 }]) {
            const line = mock.passPointsFor(shape);
            for (let e = 0; e <= shape.total; e += 0.5) {
                if ((e >= line) !== (g(shape, e) >= shape.passGrade)) disagree.push(`${shape.total}/${shape.passGrade}@${e}`);
            }
        }
        check('at every half point, the pass line agrees with the printed grade', disagree.length === 0, disagree.slice(0, 5).join(' '));
        check('no formula: no grade', g({ total: 79, gradeMin: null, gradeMax: null }, 50) === null);
        check('no pass grade: no pass line', mock.passPointsFor({ total: 79, gradeMin: 1, gradeMax: 10, passGrade: null }) === null);
    });

    await block('2. adding a paper checks its points table', async () => {
        const made = await call('POST', papersPath, PAPER);
        check('the paper is added', made.status === 200 && made.body?.paper?.id > 0, JSON.stringify(made.body));
        paper = made.body?.paper;
        check('its total is the sum of its parts: 79', paper?.total === 79, String(paper?.total));
        check('its pass line reads 39.5 points', paper?.passPoints === 39.5, String(paper?.passPoints));
        check('seven parts in five questions, in the order given', paper?.parts?.length === 7 && paper.parts.map(x => x.question).join('') === '1123345');
        const zero = await call('POST', papersPath, { ...PAPER, parts: [{ question: '1', part: '', points: 0 }] });
        check('a zero-point part is refused', zero.status === 400, String(zero.status));
        const none = await call('POST', papersPath, { ...PAPER, parts: [] });
        check('a paper with no parts is refused', none.status === 400, String(none.status));
        const stray = await call('POST', papersPath, { ...PAPER, parts: [{ question: '1', part: '', points: 5, nodeId: foreign }] });
        check('a topic from another course is refused', stray.status === 400, String(stray.status));
        const chapter = addNode(course, 'Calculus chapter');
        db.prepare('INSERT INTO nodes (project_id, parent_id, title, position) VALUES (?, ?, ?, 0)').run(course, chapter, 'Limits');
        const parent = await call('POST', papersPath, { ...PAPER, parts: [{ question: '1', part: '', points: 5, nodeId: chapter }] });
        check('a chapter (not a topic you study) is refused, as the picker never offers it', parent.status === 400, String(parent.status));
        const twice = await call('POST', papersPath, { ...PAPER, parts: [{ question: '1', part: 'a', points: 5 }, { question: '1', part: 'a', points: 3 }] });
        check('the same question and part twice is refused', twice.status === 400, String(twice.status));
        const badFormula = await call('POST', papersPath, { ...PAPER, gradeMin: 10, gradeMax: 1 });
        check('a formula whose top is not above its bottom is refused', badFormula.status === 400, String(badFormula.status));
        const list = await call('GET', papersPath);
        check('the course lists one paper', list.status === 200 && list.body?.papers?.length === 1, JSON.stringify(list.body)?.slice(0, 200));
        const elsewhere = await call('GET', `/api/projects/${other}/mock-exams`);
        check('another course lists none', elsewhere.status === 200 && elsewhere.body?.papers?.length === 0);
        const missing = await call('GET', '/api/projects/999999/mock-exams');
        check('a course that does not exist is a 404, not an empty list', missing.status === 404, String(missing.status));
        const tooHigh = await call('POST', papersPath, { ...PAPER, gradeMin: 1, gradeMax: 1e9, passGrade: 5.5 });
        check('a grade beyond 0 to 1000 is refused', tooHigh.status === 400, String(tooHigh.status));
    });

    await block('2b. the paper and its solution are this course\'s own stored PDF or picture', async () => {
        const addDoc = (pid, title, fileType, hash) => Number(db.prepare(
            'INSERT INTO documents (project_id, title, content, file_type, file_hash) VALUES (?, ?, \'\', ?, ?)',
        ).run(pid, title, fileType, hash).lastInsertRowid);
        const own = addDoc(course, 'Sample exam 19.pdf', 'pdf', 'a'.repeat(64));
        const theirs = addDoc(other, 'Optics exam.pdf', 'pdf', 'b'.repeat(64));
        const noFile = addDoc(course, 'Pasted notes', 'pdf', null);
        const word = addDoc(course, 'Solutions.docx', 'docx', 'c'.repeat(64));
        const photo = addDoc(course, 'Solutions page 1.jpg', 'jpg', 'd'.repeat(64));
        const failed = addDoc(course, 'Broken.pdf', 'pdf', 'e'.repeat(64));
        db.prepare("UPDATE documents SET status = 'failed' WHERE id = ?").run(failed);
        const tryDoc = (id) => call('POST', papersPath, { ...PAPER, title: 'Doc check', paperDocumentId: id });
        const ok = await tryDoc(own);
        check('the course\'s own stored PDF is accepted', ok.status === 200 && ok.body?.paper?.paperDocumentId === own, JSON.stringify(ok.body)?.slice(0, 200));
        const pic = await call('POST', papersPath, { ...PAPER, title: 'Photo check', solutionDocumentId: photo });
        check('a photo of the solution (jpg) is accepted, and says it is not a PDF', pic.status === 200 && pic.body?.paper?.solutionKind === 'jpg', JSON.stringify(pic.body)?.slice(0, 200));
        if (pic.body?.paper?.id) mock.deletePaper(pic.body.paper.id);
        check('a document whose import failed is refused, as the picker never offers it', (await tryDoc(failed)).status === 400);
        check('a document from another course is refused', (await tryDoc(theirs)).status === 400);
        check('a document with no stored file is refused', (await tryDoc(noFile)).status === 400);
        check('a kind the browser cannot show beside the points (docx) is refused', (await tryDoc(word)).status === 400);
        const docs = (await call('GET', papersPath)).body?.documents?.map(d => d.id) ?? [];
        check('the pickers offer only the course\'s own stored PDF', docs.includes(own) && !docs.includes(theirs) && !docs.includes(noFile) && !docs.includes(word), JSON.stringify(docs));
        if (ok.body?.paper?.id) mock.deletePaper(ok.body.paper.id);
    });

    await block('3. the clock is the server\'s and moves only while it runs', async () => {
        const t0 = Date.UTC(2026, 11, 1, 9, 0, 0);
        const s = mock.startSitting(paper.id, { now: t0 });
        check('a whole-paper sitting allows the paper\'s 3 hours', s.timeAllowed === 180 * 60, String(s.timeAllowed));
        check('it starts writing with the clock running', s.status === 'writing' && s.running === true);
        const at = (ms) => mock.getSitting(s.id, { now: t0 + ms });
        check('after 10 minutes the clock reads 600 s', at(600_000).elapsed === 600, String(at(600_000).elapsed));
        mock.pauseSitting(s.id, { now: t0 + 600_000 });
        check('paused: an hour later it still reads 600 s', at(4_200_000).elapsed === 600, String(at(4_200_000).elapsed));
        mock.resumeSitting(s.id, { now: t0 + 4_200_000 });
        check('resumed: 5 minutes on it reads 900 s', at(4_500_000).elapsed === 900, String(at(4_500_000).elapsed));
        const late = at(4_200_000 + 4 * 3600_000);
        check('past the time allowed it is still writing: nothing hands in by itself', late.status === 'writing' && late.elapsed > late.timeAllowed);
        check('…and it says the time is up', late.timeUp === true);
        const done = mock.stopWriting(s.id, { now: t0 + 4_500_000 });
        check('"Finish writing" stops the clock and opens marking', done.status === 'marking' && done.running === false && done.elapsed === 900, JSON.stringify(done));
        check('a second "Finish writing" changes nothing', mock.stopWriting(s.id, { now: t0 + 9_000_000 }).elapsed === 900);
        const pausedLate = mock.pauseSitting(s.id, { now: t0 + 9_000_000 });
        const resumedLate = mock.resumeSitting(s.id, { now: t0 + 9_000_000 });
        check('pause or resume after "Finish writing" does nothing: the clock stays stopped at 900 s',
            pausedLate.status === 'marking' && resumedLate.status === 'marking' && resumedLate.running === false
            && mock.getSitting(s.id, { now: t0 + 20_000_000 }).elapsed === 900, JSON.stringify(resumedLate));
        mock.discardSitting(s.id);
        check('a sitting never marked can be discarded', !mock.getSitting(s.id));
    });

    await block('4. marks are points per part, only while marking', async () => {
        const started = await call('POST', `/api/mock-exams/papers/${paper.id}/sittings`, {});
        check('a sitting starts over HTTP', started.status === 200 && started.body?.sitting?.id > 0, JSON.stringify(started.body));
        const sid = started.body.sitting.id;
        const part = (q, p) => paper.parts.find(x => x.question === q && x.part === p).id;
        const early = await call('PUT', `/api/mock-sittings/${sid}/scores`, { partId: part('1', 'a'), points: 5 });
        check('a mark while still writing is refused', early.status === 409, String(early.status));
        const stop = await call('POST', `/api/mock-sittings/${sid}/stop`, {});
        check('"Finish writing" over HTTP opens marking', stop.status === 200 && stop.body?.sitting?.status === 'marking', JSON.stringify(stop.body));
        const over = await call('PUT', `/api/mock-sittings/${sid}/scores`, { partId: part('1', 'a'), points: 9 });
        check('more points than the part is worth is refused', over.status === 400, String(over.status));
        const neg = await call('PUT', `/api/mock-sittings/${sid}/scores`, { partId: part('1', 'a'), points: -1 });
        check('negative points are refused', neg.status === 400, String(neg.status));
        const third = await call('PUT', `/api/mock-sittings/${sid}/scores`, { partId: part('1', 'a'), points: 2.3 });
        check('points come in halves at most', third.status === 400, String(third.status));
        const otherPaper = await call('POST', papersPath, { ...PAPER, title: 'Sample exam 20' });
        const strayPart = otherPaper.body?.paper?.parts?.[0]?.id;
        const wrongPaper = await call('PUT', `/api/mock-sittings/${sid}/scores`, { partId: strayPart, points: 1 });
        check('a part of another paper is refused', wrongPaper.status === 400 || wrongPaper.status === 404, String(wrongPaper.status));
        const half = await call('PUT', `/api/mock-sittings/${sid}/scores`, { partId: part('1', 'a'), points: 2.5 });
        check('a half point (2.5) is accepted', half.status === 200 && half.body?.result?.earned === 2.5, `${half.status} ${half.body?.result?.earned}`);
        const cleared = await call('PUT', `/api/mock-sittings/${sid}/scores`, { partId: part('1', 'a'), points: null });
        check('null clears a part back to ungraded', cleared.status === 200 && cleared.body?.result?.earned === 0
            && cleared.body?.result?.parts?.find(x => x.id === part('1', 'a'))?.earned === null, JSON.stringify(cleared.body?.result?.parts?.[0]));
        // Derivatives: 1a 8/8, 1b 11/12, 5 13/13 → three right.
        // Integrals (a COMPLETED topic): 2 3/18 → one wrong.
        // Vectors: 3a 1/6 → wrong; 3b left unmarked.
        // Question 4 (no topic): 10/14.
        for (const [q, p, pts] of [['1', 'a', 8], ['1', 'b', 11], ['5', '', 13], ['2', '', 3], ['3', 'a', 1], ['4', '', 10]]) {
            const r = await call('PUT', `/api/mock-sittings/${sid}/scores`, { partId: part(q, p), points: pts });
            if (r.status !== 200) check(`mark ${q}${p} = ${pts}`, false, `${r.status} ${JSON.stringify(r.body)}`);
        }
        const halfway = await call('GET', `/api/mock-sittings/${sid}`);
        check('the running total is the marked points: 46', halfway.body?.result?.earned === 46, String(halfway.body?.result?.earned));
        check('one part is still unmarked', halfway.body?.result?.unmarked === 1, String(halfway.body?.result?.unmarked));
        check('nothing is written to any topic before the mock is finished', evidenceOf(derivatives).length === 0 && evidenceOf(vectors).length === 0);
        globalThis.__sid = sid;
    });

    await block('5. a finished mock is practice: moves estimates, never proves or reopens', async () => {
        const sid = globalThis.__sid;
        const before = { d: score(derivatives), i: score(integrals), v: score(vectors) };
        // Integrals already has a good estimate from earlier answers.
        mastery.updateMasteryFromAttempt(integrals, 5, 5, 'quiz', {});
        const iBefore = score(integrals);
        const eligibleBefore = checkMasteryEligibility(derivatives).eligible;
        const fin = await call('POST', `/api/mock-sittings/${sid}/finish`, {});
        check('the mock finishes', fin.status === 200 && fin.body?.sitting?.status === 'done', JSON.stringify(fin.body)?.slice(0, 300));
        const r = fin.body?.result;
        check('46 of 79 points', r?.earned === 46 && r?.total === 79, `${r?.earned}/${r?.total}`);
        check('grade 46/79*9+1 = 6.2', r?.grade === 6.2, String(r?.grade));
        check('pass line 39.5 points, passed', r?.passPoints === 39.5 && r?.passed === true);
        const d = evidenceOf(derivatives), i = evidenceOf(integrals).filter(e => e.evidence_type === 'mock'), v = evidenceOf(vectors);
        check('Derivatives gets one mock row: 3 of 3 parts', d.length === 1 && d[0].evidence_type === 'mock' && d[0].score === 3 && d[0].total === 3, JSON.stringify(d));
        check('Integrals gets one mock row: 0 of 1', i.length === 1 && i[0].score === 0 && i[0].total === 1, JSON.stringify(i));
        check('Vectors: only its marked part counts (0 of 1); the unmarked one writes nothing', v.length === 1 && v[0].score === 0 && v[0].total === 1, JSON.stringify(v));
        check('a part with no topic writes no evidence anywhere', db.prepare("SELECT COUNT(*) n FROM mastery_evidence WHERE evidence_type = 'mock'").get().n === 3);
        check('Derivatives\' estimate went up', score(derivatives) > before.d, `${before.d} -> ${score(derivatives)}`);
        check('Integrals\' estimate went down', score(integrals) < iBefore, `${iBefore} -> ${score(integrals)}`);
        check('"mock" is a known evidence type and never a proving one',
            mastery.VALID_EVIDENCE_TYPES.includes('mock') && !mastery.PROVING_EVIDENCE_TYPES.includes('mock'));
        check('Derivatives is still in progress (a mock completes nothing)', statusOf(derivatives) === 'in_progress');
        check('Integrals is still completed (a mock reopens nothing)', statusOf(integrals) === 'completed');
        check('Vectors is still not started', statusOf(vectors) === 'not_started');
        const el = checkMasteryEligibility(derivatives);
        check('the gate reads none of it: Derivatives\' gate score stays 0', el.gate_score === 0 && el.eligible === eligibleBefore, JSON.stringify(el));
        const again = await call('POST', `/api/mock-sittings/${sid}/finish`, {});
        check('a second finish returns the same result and writes nothing',
            again.status === 200 && again.body?.result?.earned === 46 && db.prepare("SELECT COUNT(*) n FROM mastery_evidence WHERE evidence_type = 'mock'").get().n === 3);
        const late = await call('PUT', `/api/mock-sittings/${sid}/scores`, { partId: paper.parts[6].id, points: 1 });
        check('a finished mock takes no more marks', late.status === 409, String(late.status));
        const gone = await call('DELETE', `/api/mock-sittings/${sid}`);
        check('a finished mock cannot be discarded (it is history)', gone.status === 409, String(gone.status));
        void before;
    });

    await block('6. one question is a sitting of its own', async () => {
        const one = await call('POST', `/api/mock-exams/papers/${paper.id}/sittings`, { question: '3' });
        const s = one.body?.sitting;
        check('a one-question sitting starts', one.status === 200 && s?.question === '3', JSON.stringify(one.body));
        check('its time is the question\'s share of the paper: 14 of 79 points of 180 min = 32 min', s?.timeAllowed === 32 * 60, String(s?.timeAllowed));
        const bad = await call('POST', `/api/mock-exams/papers/${paper.id}/sittings`, { question: '9' });
        check('a question the paper does not have is refused', bad.status === 400, String(bad.status));
        await call('POST', `/api/mock-sittings/${s.id}/stop`, {});
        const q1 = paper.parts.find(x => x.question === '1').id;
        const outside = await call('PUT', `/api/mock-sittings/${s.id}/scores`, { partId: q1, points: 1 });
        check('a part outside the question is refused', outside.status === 400, String(outside.status));
        const p3a = paper.parts.find(x => x.question === '3' && x.part === 'a').id;
        await call('PUT', `/api/mock-sittings/${s.id}/scores`, { partId: p3a, points: 6 });
        const fin = await call('POST', `/api/mock-sittings/${s.id}/finish`, {});
        const r = fin.body?.result;
        check('its total is the question\'s 14 points', r?.total === 14 && r?.earned === 6, `${r?.earned}/${r?.total}`);
        check('…and it has no grade or pass line (the formula is for the whole paper)', r?.grade === null && r?.passPoints === null && r?.passed === null);
    });

    await block('7. the result orders questions by points lost', async () => {
        const r = (await call('GET', `/api/mock-sittings/${globalThis.__sid}`)).body?.result;
        const order = r?.questions?.map(q => `${q.question}:${q.lost}`).join(' ');
        // Lost: Q2 15, Q3 13 (1 of 14, 3b unmarked counts zero), Q4 4, Q1 1, Q5 0.
        check('2, 3, 4, 1, 5 by points lost', order === '2:15 3:13 4:4 1:1 5:0', order);
        check('each question names its topics', r?.questions?.find(q => q.question === '3')?.topics?.[0]?.title === 'Vectors');
        const list = (await call('GET', papersPath)).body;
        const hist = list?.papers?.find(p => p.id === paper.id)?.sittings;
        check('the paper lists its finished whole-paper mock with its grade', hist?.some(h => h.status === 'done' && h.grade === 6.2), JSON.stringify(hist));
    });

    await block('7b. half a point on the line passes', async () => {
        const s = (await call('POST', `/api/mock-exams/papers/${paper.id}/sittings`, {})).body?.sitting;
        await call('POST', `/api/mock-sittings/${s.id}/stop`, {});
        const part = (q, p) => paper.parts.find(x => x.question === q && x.part === p).id;
        // 8 + 12 + 18 + 1.5 = 39.5 of 79: exactly the 5.5 line.
        for (const [q, p, pts] of [['1', 'a', 8], ['1', 'b', 12], ['2', '', 18], ['3', 'a', 1.5]]) {
            await call('PUT', `/api/mock-sittings/${s.id}/scores`, { partId: part(q, p), points: pts });
        }
        const r = (await call('POST', `/api/mock-sittings/${s.id}/finish`, {})).body?.result;
        check('39.5 of 79 is grade 5.5 and passes', r?.earned === 39.5 && r?.grade === 5.5 && r?.passed === true, JSON.stringify({ e: r?.earned, g: r?.grade, p: r?.passed, line: r?.passPoints }));
    });

    await block('7d. "Give them 0" grades every ungraded part 0 as it finishes', async () => {
        const s = (await call('POST', `/api/mock-exams/papers/${paper.id}/sittings`, {})).body?.sitting;
        await call('POST', `/api/mock-sittings/${s.id}/stop`, {});
        const p1a = paper.parts.find(x => x.question === '1' && x.part === 'a').id;
        await call('PUT', `/api/mock-sittings/${s.id}/scores`, { partId: p1a, points: 5 });
        const before = db.prepare("SELECT COUNT(*) n FROM mastery_evidence WHERE evidence_type = 'mock'").get().n;
        const r = (await call('POST', `/api/mock-sittings/${s.id}/finish`, { fillUnmarked: true })).body?.result;
        check('no part is left ungraded and the graded one kept its 5', r?.unmarked === 0 && r?.earned === 5 && r?.parts?.filter(x => x.earned === 0).length === 6, JSON.stringify({ u: r?.unmarked, e: r?.earned }));
        const wrote = db.prepare("SELECT COUNT(*) n FROM mastery_evidence WHERE evidence_type = 'mock'").get().n - before;
        check('the zeros count as practice too: one row per tagged topic (3)', wrote === 3, String(wrote));
        const plain = (await call('POST', `/api/mock-exams/papers/${paper.id}/sittings`, {})).body?.sitting;
        await call('POST', `/api/mock-sittings/${plain.id}/stop`, {});
        const r2 = (await call('POST', `/api/mock-sittings/${plain.id}/finish`, {})).body?.result;
        check('without it, ungraded parts stay ungraded (7 of 7)', r2?.unmarked === 7, String(r2?.unmarked));
    });

    await block('7c. a topic with four or more parts is still practice', async () => {
        const c = Number(db.prepare("INSERT INTO projects (name) VALUES ('Calculus')").run().lastInsertRowid);
        const limits = addNode(c, 'Limits', 'in_progress');
        const big = mock.createPaper(c, {
            title: 'Limits paper', minutes: 60, gradeMin: 1, gradeMax: 10, passGrade: 5.5,
            parts: ['a', 'b', 'c', 'd', 'e'].map(p => ({ question: '1', part: p, points: 4, nodeId: limits })),
        });
        const s = mock.startSitting(big.id, { now: 0 });
        mock.stopWriting(s.id, { now: 60_000 });
        for (const p of big.parts) mock.setPartScore(s.id, p.id, 4);
        const eligibleBefore = checkMasteryEligibility(limits);
        mock.finishSitting(s.id, { now: 120_000 });
        const ev = evidenceOf(limits);
        check('five full parts on one topic write one mock row of 5 of 5', ev.length === 1 && ev[0].evidence_type === 'mock' && ev[0].score === 5 && ev[0].total === 5, JSON.stringify(ev));
        const el = checkMasteryEligibility(limits);
        check('…which the gate does not read (gate score 0, still not eligible)', el.gate_score === 0 && el.eligible === false && eligibleBefore.eligible === false, JSON.stringify(el));
        check('…and the topic is still in progress, not done', statusOf(limits) === 'in_progress');
        db.prepare('DELETE FROM projects WHERE id = ?').run(c);
    });

    await block('10. the parts are checked against the total printed on the paper', async () => {
        const off = await call('POST', papersPath, { ...PAPER, title: 'Printed 80', printedTotal: 80 });
        check('parts adding up to 79 against a printed 80 are refused', off.status === 400, String(off.status));
        check('…and the refusal names both numbers', /79/.test(off.body?.error ?? '') && /80/.test(off.body?.error ?? ''), off.body?.error);
        const odd = await call('POST', papersPath, { ...PAPER, title: 'Printed half', printedTotal: 79.5 });
        check('a printed total that is not a whole number of points is refused', odd.status === 400, String(odd.status));
        const same = await call('POST', papersPath, { ...PAPER, title: 'Printed 79', printedTotal: 79 });
        check('parts adding up to the printed 79 are added', same.status === 200 && same.body?.paper?.total === 79, JSON.stringify(same.body)?.slice(0, 160));
        // A build that wrongly took the refused ones would leave them behind for later blocks.
        for (const r of [off, odd, same]) if (r.body?.paper?.id) mock.deletePaper(r.body.paper.id);
        const dialog = readFileSync(join(ROOT, 'src', 'components', 'mockExam', 'AddPaperDialog.tsx'), 'utf8');
        check('the dialog sends the printed total and holds Add while the parts disagree with it',
            /printedTotal/.test(dialog) && /disabled=\{[^}]*mismatch/.test(dialog) && /mismatch\s*=\s*printedTotal != null && printedTotal !== total/.test(dialog));
        check('…and holds Add while what was typed is not a whole number',
            /printedBad\s*=\s*printed\.trim\(\) !== '' && printedTotal == null/.test(dialog) && /disabled=\{[^}]*printedBad/.test(dialog));
    });

    await block('11. the result names the topic that lost the most points', async () => {
        const c = Number(db.prepare("INSERT INTO projects (name) VALUES ('Weakest')").run().lastInsertRowid);
        const algebra = addNode(c, 'Algebra', 'in_progress');
        const geometry = addNode(c, 'Geometry', 'in_progress');
        const p = mock.createPaper(c, {
            title: 'Weak paper', minutes: 60, gradeMin: 1, gradeMax: 10, passGrade: 5.5,
            parts: [
                { question: '1', part: 'a', points: 10, nodeId: algebra },
                { question: '1', part: 'b', points: 10, nodeId: geometry },
                { question: '2', part: '', points: 6, nodeId: geometry },
                { question: '3', part: '', points: 5, nodeId: null },
            ],
        });
        const s = mock.startSitting(p.id, { now: 0 });
        mock.stopWriting(s.id, { now: 60_000 });
        const [a, g1, g2, none] = p.parts;
        mock.setPartScore(s.id, a.id, 4);    // algebra loses 6
        mock.setPartScore(s.id, g1.id, 9);   // geometry loses 1 …
        mock.setPartScore(s.id, g2.id, 2);   // … and 4: 5 in all
        mock.setPartScore(s.id, none.id, 0); // no topic loses 5: never offered
        const r = mock.finishSitting(s.id, { now: 120_000 }).result;
        check('the weakest topic is Algebra, 6 of 10 points lost', r?.weakest?.id === algebra && r.weakest.lost === 6 && r.weakest.points === 10 && r.weakest.title === 'Algebra', JSON.stringify(r?.weakest));
        const full = mock.startSitting(p.id, { now: 200_000 });
        mock.stopWriting(full.id, { now: 260_000 });
        for (const part of p.parts) mock.setPartScore(full.id, part.id, part.points);
        check('full marks everywhere: no weakest topic', mock.finishSitting(full.id, { now: 300_000 }).result?.weakest === null);
        // Ties: the same points lost goes to the topic that kept the smaller share.
        const tie = (parts, scores) => {
            const tp = mock.createPaper(c, { title: `Tie ${parts.length}`, minutes: 60, parts });
            const ts = mock.startSitting(tp.id, { now: 400_000 });
            mock.stopWriting(ts.id, { now: 460_000 });
            tp.parts.forEach((part, i) => mock.setPartScore(ts.id, part.id, scores[i]));
            return mock.finishSitting(ts.id, { now: 500_000 }).result?.weakest;
        };
        const share = tie([{ question: '1', part: '', points: 20, nodeId: algebra }, { question: '2', part: '', points: 8, nodeId: geometry }], [16, 4]);
        check('4 lost each: Geometry (4 of 8) before Algebra (4 of 20)', share?.id === geometry, JSON.stringify(share));
        const even = tie([{ question: '1', part: '', points: 10, nodeId: geometry }, { question: '2', part: '', points: 10, nodeId: algebra }], [6, 6]);
        check('…and a full tie goes to the topic first on the paper', even?.id === geometry, JSON.stringify(even));
        db.prepare('DELETE FROM projects WHERE id = ?').run(c);
        const screen = readFileSync(join(ROOT, 'src', 'components', 'mockExam', 'MockSittingScreen.tsx'), 'utf8');
        const course = readFileSync(join(ROOT, 'src', 'components', 'mockExam', 'CourseMock.tsx'), 'utf8');
        const result = screen.slice(screen.indexOf('function ResultScreen'));
        const practisePath = join(ROOT, 'src', 'components', 'mockExam', 'PractiseWeakest.tsx');
        const practise = existsSync(practisePath) ? readFileSync(practisePath, 'utf8') : '';
        check('the past paper result opens the weakest topic\'s study stream', /PractiseWeakest/.test(result) && /studyNode\(projectId, nodeId\)/.test(practise));
        const cResult = course.slice(course.indexOf('export function CourseResultScreen'));
        check('the course mock result offers the same, for the topic with the most answers missed (not whatever is listed first)',
            /PractiseWeakest/.test(cResult) && /const weakest = result\.topics\.reduce/.test(cResult));
    });

    await block('12. the paper and its solution can be uploaded inside the add dialog', async () => {
        const dialog = readFileSync(join(ROOT, 'src', 'components', 'mockExam', 'AddPaperDialog.tsx'), 'utf8');
        check('the dialog uploads into this course', /uploadDocumentFiles\([^)]*projectId/.test(dialog));
        check('…takes only what the paper can be (a PDF or a picture)', /accept="[^"]*\.pdf[^"]*image\//.test(dialog));
        check('…and picks the uploaded file for the field it was uploaded from', /set\(\s*doc\.id\s*\)|onPicked\(doc\.id\)/.test(dialog));
        // The kind is checked on the file's name before anything is sent: an
        // uploaded file stays in the course's files even if the paper never is.
        const pick = dialog.slice(dialog.indexOf('const pick = '));
        check('…refuses another kind before uploading it', /if \(!paperKind\(file\.name\)\)/.test(pick) && pick.indexOf('paperKind(file.name)') < pick.indexOf('uploadDocumentFiles('));
        check('…holds Add while an upload runs', /disabled=\{[^}]*uploading > 0/.test(dialog));
        check('…and names its two Upload buttons apart', /t\("Upload the paper"\)/.test(dialog) && /t\("Upload the worked solution"\)/.test(dialog) && /aria-label=\{label\}/.test(dialog));
    });

    await block('13. a course mock can hide its clock too, and every hidden clock comes back for the last five minutes', async () => {
        const course = readFileSync(join(ROOT, 'src', 'components', 'mockExam', 'CourseMock.tsx'), 'utf8');
        const screen = readFileSync(join(ROOT, 'src', 'components', 'mockExam', 'MockSittingScreen.tsx'), 'utf8');
        check('the course mock has Hide the clock', /useHiddenClock\(/.test(course) && /ClockToggle/.test(course));
        check('the past paper uses the same hidden-clock state', /useHiddenClock\(/.test(screen));
        const hook = readFileSync(join(ROOT, 'src', 'components', 'mockExam', 'mockFormat.ts'), 'utf8');
        check('a hidden clock survives a reload of the tab (kept per mock in this tab)', /sessionStorage/.test(hook) && /mock-clock-hidden:/.test(hook));
        check('…and shows again with five minutes left', /REVEAL_AT\s*=\s*300/.test(hook));
    });

    await block('14. time away from a phone (a call) can be taken off the running clock', async () => {
        const c = Number(db.prepare("INSERT INTO projects (name) VALUES ('Away')").run().lastInsertRowid);
        const p = mock.createPaper(c, { title: 'Away paper', minutes: 60, parts: [{ question: '1', part: '', points: 10 }] });
        const s = mock.startSitting(p.id, { now: 0 });
        const off = mock.takeAwayTimeOff?.(s.id, 300, { now: 900_000 });
        check('15 min in, 5 min away taken off: 10 min used, still running', off?.elapsed === 600 && off.running === true, JSON.stringify(off));
        // On code without it the rest has nothing to call: the course goes now, so block 8 still counts true.
        if (!mock.takeAwayTimeOff) { db.prepare('DELETE FROM projects WHERE id = ?').run(c); check('takeAwayTimeOff exists', false); return; }
        check('…and the clock counts on from there', mock.getSitting(s.id, { now: 960_000 }).elapsed === 660);
        // Restarted at 900 s with 600 banked; a day off at 1000 s goes back to 900 s only.
        const far = mock.takeAwayTimeOff(s.id, 86_400, { now: 1_000_000 });
        check('never further back than the clock\'s last start: banked time stays', far.elapsed === 600, String(far.elapsed));
        mock.pauseSitting(s.id, { now: 1_060_000 });
        const paused = mock.takeAwayTimeOff(s.id, 30, { now: 2_000_000 });
        check('a paused clock is left alone', paused.elapsed === 660 && paused.running === false, JSON.stringify(paused));
        // Over HTTP the server reads its own clock, so only answers that do not
        // depend on it are checked there: the refusals, and a paused clock.
        for (const [what, seconds] of [['negative', -5], ['over a day', 86_401], ['a fraction', 1.5], ['text', '60']]) {
            const bad = await call('POST', `/api/mock-sittings/${s.id}/away`, { seconds });
            check(`a time away that is ${what} is refused over HTTP`, bad.status === 400, String(bad.status));
        }
        const none = await call('POST', '/api/mock-sittings/999999/away', { seconds: 60 });
        check('…a mock that does not exist is a 404', none.status === 404, String(none.status));
        const ok = await call('POST', `/api/mock-sittings/${s.id}/away`, { seconds: 60 });
        check('…and a paused clock is answered with its sitting, unchanged', ok.status === 200 && ok.body?.sitting?.elapsed === 660, JSON.stringify(ok.body)?.slice(0, 120));
        mock.stopWriting(s.id, { now: 2_100_000 });
        check('a mock being marked is left alone', mock.takeAwayTimeOff(s.id, 60, { now: 2_200_000 }).elapsed === 660);
        const cp = mock.createPaper(c, { title: 'Course-made', minutes: 60, parts: [{ question: '1', part: '', points: 1 }] });
        // Started as a paper, then marked as one the course drew (the way a drawn mock is stored).
        const cs = mock.startSitting(cp.id, { now: 0 });
        db.prepare("UPDATE exam_papers SET source = 'course' WHERE id = ?").run(cp.id);
        let refused = false;
        try { mock.takeAwayTimeOff(cs.id, 60, { now: 600_000 }); } catch (e) { refused = e.status === 400; }
        check('a course mock (answered on the screen itself) takes no time off', refused && mock.getSitting(cs.id, { now: 600_000 }).elapsed === 600);
        db.prepare('DELETE FROM projects WHERE id = ?').run(c);
        const screen = readFileSync(join(ROOT, 'src', 'components', 'mockExam', 'MockSittingScreen.tsx'), 'utf8');
        check('the clock screen remembers when the page was hidden, across a reload or a killed tab', /mock-away:/.test(screen) && /localStorage/.test(screen));
        check('…and offers to take that time off when it comes back', /api\.mockAway\(/.test(screen));
        check('…never offering more than whole minutes the clock has used, up to a day',
            /awayOff = away == null \? 0 : Math\.floor\(Math\.min\(away, elapsed, 86_400\) \/ 60\) \* 60/.test(screen) && /takeOff\(awayOff\)/.test(screen));
        check('…and a paused clock drops a pending offer', /if \(!sitting\.running\) \{ store\.drop\(\); setAway\(null\); return; \}/.test(screen));
    });

    await block('15. the clock screen fits a phone held either way', async () => {
        const screen = readFileSync(join(ROOT, 'src', 'components', 'mockExam', 'MockSittingScreen.tsx'), 'utf8');
        const layout = readFileSync(join(ROOT, 'src', 'components', 'Layout.tsx'), 'utf8');
        const clock = screen.slice(screen.indexOf('function ClockScreen'), screen.indexOf('// ---- marking'));
        check('Pause and Finish writing sit in the frame\'s footer, so a short screen never scrolls them away', /footer=\{/.test(screen) && /ClockButtons/.test(clock));
        check('the time sizes to the card and to a short screen (a phone held sideways)', /function ClockLeft[\s\S]*cqi[\s\S]*max-height/.test(screen));
        // Not new: pinned so the frame never has to pad them itself.
        check('the frame sits in <main>, which clears the home indicator and a sideways phone\'s corners', /<main [^>]*className="[^"]*safe-px-0[^"]*safe-pb-0/.test(layout));
    });


    await block('8. named for sync, and gone with the course', async () => {
        for (const t of ['exam_papers', 'exam_paper_parts', 'mock_sittings', 'mock_part_scores']) {
            check(`${t} is in the sync list with a uuid`, SYNC_TABLES[t]?.uuid === true, JSON.stringify(SYNC_TABLES[t]));
            const blank = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE uuid IS NULL`).get().n;
            const rows = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
            check(`every ${t} row has a uuid (${rows} rows)`, rows > 0 && blank === 0);
        }
        db.prepare('DELETE FROM projects WHERE id = ?').run(course);
        const left = ['exam_papers', 'exam_paper_parts', 'mock_sittings', 'mock_part_scores']
            .map(t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n).reduce((a, b) => a + b, 0);
        check('deleting the course deletes its papers, mocks and marks', left === 0, String(left));
    });

    await block('9. the running clock keeps its hours and minutes on one line', async () => {
        const screen = readFileSync(join(ROOT, 'src', 'components', 'mockExam', 'MockSittingScreen.tsx'), 'utf8');
        const clock = screen.slice(screen.indexOf('function ClockLeft'));
        check('"Time left" sits on its own line and the time on the next, unbroken and sized to the card',
            /<p [^>]*>\{t\("Time left"\)\}<\/p>\s*<p className="[^"]*whitespace-nowrap[^"]*cqi[^"]*">\{time\}<\/p>/.test(clock));
    });

    await block('16. results say nothing extra; a held Add says why', async () => {
        const dir = join(ROOT, 'src', 'components', 'mockExam');
        const screen = readFileSync(join(dir, 'MockSittingScreen.tsx'), 'utf8');
        const course = readFileSync(join(dir, 'CourseMock.tsx'), 'utf8');
        const dialog = readFileSync(join(dir, 'AddPaperDialog.tsx'), 'utf8');
        check('neither result adds a line about topics showing it as practice',
            !/now shows (?:this paper|in its topic) as practice/.test(screen + course));
        check('with no name, the dialog footer says a name is needed before Add',
            /\{!title\.trim\(\) && \(\s*<span [^>]*>\{t\("Give the paper a name to add it\."\)\}<\/span>/.test(dialog)
                && /<div className="ml-auto flex gap-2">\s*<Button onClick=\{leave\}>[^\n]*\n\s*<Button variant="primary"[^\n]*\{t\("Add the paper"\)\}<\/Button>\s*<\/div>/.test(dialog));
        const offer = screen.slice(screen.indexOf('takeOff(awayOff)') - 200, screen.indexOf('{t("I kept writing")}') + 30);
        check('the away offer\'s two buttons are full-size tap targets',
            /takeOff\(awayOff\)/.test(offer) && /I kept writing/.test(offer) && !/size="sm"/.test(offer));
        const practise = readFileSync(join(dir, 'PractiseWeakest.tsx'), 'utf8');
        check('"Practise this topic" stays at the right when a narrow result wraps it under its line',
            /<Button variant="primary" className="ml-auto"[^\n]*>\s*\{t\("Practise this topic"\)\}/.test(practise));
    });

    await block('9b. what the review round found', async () => {
        const src = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
        const screen = src('src', 'components', 'mockExam', 'MockSittingScreen.tsx');
        const dialog = src('src', 'components', 'mockExam', 'AddPaperDialog.tsx');
        for (const t of ['mock_sittings', 'mock_part_scores']) {
            check(`${t} is synced as content: it changes after it is written (pause, marks)`, SYNC_TABLES[t]?.class === 'content', JSON.stringify(SYNC_TABLES[t]));
        }
        check('a finished mock reads "Mock exam" in Today\'s activity, not "Question"',
            /\bmock: k\("Mock exam"\)/.test(src('src', 'components', 'feed', 'TodayActivityModal.tsx')));
        check('the printed grade formula keeps a half-point span (4.5 is not rounded to 5)',
            /const span = [^;]*fmt\(paper\.gradeMax - paper\.gradeMin\)/.test(screen));
        check('a score right on the pass line says so, not "0 points above"',
            /result\.earned === result\.passPoints\s*\?\s*t\("That is exactly the pass line\."\)/.test(screen));
        check('the add dialog asks before Escape, the backdrop or Cancel drops a typed paper',
            /onClose=\{leave\}/.test(dialog) && /<Button onClick=\{leave\}>\{t\("Cancel"\)\}/.test(dialog)
                && /if \(changed && !\(await showConfirm\(/.test(dialog));
    });
} finally {
    server.close();
    db.close();
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the file a moment */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

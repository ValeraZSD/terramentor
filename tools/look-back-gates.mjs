#!/usr/bin/env node
/**
 * tools/look-back-gates.mjs — the look back: a short mixed check the study
 * stream offers on its own, and the mock exam it offers before a real exam.
 *
 *   node tools/look-back-gates.mjs [--root DIR]
 *
 * What this suite pins (server/lookBack.js, the feed's opening page, the
 * recall round, the card):
 *
 *   1. nothing to look back on, nothing offered: a course with nothing
 *      studied, or fewer than 4 studied topics with questions the app marks
 *      alone, or under 10 such questions, and never a deck;
 *   2. the cadence: 14 days after the course's first answer, the last look
 *      back, the last full mock or the last "Not now"; sooner when a phase has
 *      closed since then (3 days after the last one at the earliest);
 *   3. the look back: 10 questions with no clock, flagged as a look back,
 *      spread across topics (the ones practised longest ago first), one
 *      sitting at a time (an open one is offered as Continue);
 *   4. what it writes: practice evidence per topic, never completes or reopens
 *      a topic; a topic answered wrong comes back in the recall round from 20
 *      hours later until one of its questions is answered right;
 *   5. the mock window: a real exam (a date that cannot move, or the exam
 *      described) 1 to 21 days away turns the offer into the full mock, at
 *      most once a week, and no look back is offered inside it;
 *   6. the stream: the offer heads the opening page of a course stream and of
 *      Today (one card, for one course), never a topic's stream or a later page;
 *   7. the routes and the card: offer, start and skip over HTTP; the card holds
 *      two buttons and the stream renders it.
 *
 * --root runs the same cases against another checkout; on the code before the
 * look back existed every case fails.
 *
 * A scratch library, no model, no network. Every instant a case reads is
 * pinned relative to one start time; the answers logged by the question log
 * carry the database's own clock, so the recall cases read past it.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = resolve(argOf('--root') || repo);

// Set in-process, before any server module is imported.
const scratch = mkdtempSync(join(tmpdir(), 'look-back-gates-'));
process.env.DB_PATH = join(scratch, 'gate.db');
process.env.VAULT_ROOT = join(scratch, 'vault');
process.env.DATA_DIR = scratch;
process.env.HOST = '127.0.0.1';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const block = async (title, fn) => {
    console.log(`\n--- ${title} ---`);
    try { await fn(); } catch (err) { check(`${title}: ran without throwing`, false, err?.message || String(err)); }
};

const S = pathToFileURL(join(ROOT, 'server') + '/').href;
const { default: db } = await import(S + 'database.js');
if (!process.env.DB_PATH.startsWith(scratch)) throw new Error('refusing: not the scratch library');
const { createApp } = await import(S + 'app.js');
const { composeFeed } = await import(S + 'feed.js');
const { getDecayingNodes } = await import(S + 'mastery.js');
const { studyToday } = await import(S + 'studyDay.js');
const mock = await import(S + 'mockExams.js');
const lb = await import(S + 'lookBack.js').catch(() => ({}));
const has = (f) => typeof lb[f] === 'function';
const offerOf = (pid, now) => (has('lookBackOffer') ? lb.lookBackOffer(pid, { now }) : undefined);

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

// ---- time: everything is a number of days after the courses' first answers --------

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Twenty days ago, so the look back answered "on day 20" lands near the
// database's own clock, which stamps the question log.
const T0 = Math.floor((Date.now() - 20 * DAY) / 1000) * 1000;
const at = (d, h = 0) => new Date(T0 + d * DAY + h * HOUR);
const sqlStamp = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const plusDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---- courses ----------------------------------------------------------------------

const project = (name, extra = {}) => {
    const id = Number(db.prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid);
    for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE projects SET ${k} = ? WHERE id = ?`).run(v, id);
    return id;
};
let pos = 0;
const node = (pid, title, parent = null) => Number(db.prepare(
    "INSERT INTO nodes (project_id, parent_id, title, position, status) VALUES (?, ?, ?, ?, 'not_started')",
).run(pid, parent, title, pos++).lastInsertRowid);
const KEY = new Map();
const mc = (nodeId, i) => {
    const uuid = randomUUID();
    KEY.set(uuid, nodeId);
    return { uuid, type: 'multiple_choice', question: `Question ${i} on ${nodeId}?`, options: ['Alpha', 'Beta', 'Gamma', 'Delta'], correct_answer: 'Beta', explanation: 'Because.' };
};
const bank = (nodeId, n = 3) => Number(db.prepare('INSERT INTO quizzes (node_id, title, questions) VALUES (?, ?, ?)')
    .run(nodeId, 'Bank', JSON.stringify(Array.from({ length: n }, (_, i) => mc(nodeId, i + 1)))).lastInsertRowid);
/** Studied: started, with one quiz answer of its own on `when`. */
const studied = (nodeId, when) => {
    db.prepare("UPDATE nodes SET status = 'in_progress' WHERE id = ?").run(nodeId);
    db.prepare("INSERT INTO mastery_evidence (node_id, evidence_type, score, total, created_at) VALUES (?, 'quiz', 3, 3, ?)").run(nodeId, sqlStamp(when));
};
const complete = (nodeId, when) => db.prepare("UPDATE nodes SET status = 'completed', completed_at = ? WHERE id = ?").run(when.toISOString(), nodeId);
const topics = (pid, titles, parent = null) => titles.map(t => { const id = node(pid, t, parent); bank(id); return id; });
const statusOf = (id) => db.prepare('SELECT status FROM nodes WHERE id = ?').get(id).status;
const refUuid = (q) => String(q?.ref ?? '').replace(/^q:/, '');

// Biology: two phases of three topics, no date.
const bio = project('Biology');
const cells = node(bio, 'Cells');
const [c1, c2, c3] = topics(bio, ['Membranes', 'Organelles', 'Division'], cells);
const genetics = node(bio, 'Genetics');
const [g1, g2, g3] = topics(bio, ['Genes', 'Inheritance', 'Mutation'], genetics);

let attempt = 0;
const aid = () => `lb-${++attempt}`;

try {
    await block('0. the module', async () => {
        check('server/lookBack.js exports lookBackOffer, startLookBack and skipLookBack',
            ['lookBackOffer', 'startLookBack', 'skipLookBack'].every(has));
    });

    await block('1. nothing to look back on, nothing offered', async () => {
        const fresh = project('Fresh');
        topics(fresh, ['One', 'Two', 'Three', 'Four', 'Five']);
        check('a course with banks but nothing studied: no offer, even weeks later', offerOf(fresh, at(30)) === null, JSON.stringify(offerOf(fresh, at(30))));

        for (const id of [c1, c2, c3]) studied(id, at(0));
        check('three studied topics (9 questions): no offer, a mix needs 4 topics', offerOf(bio, at(15)) === null, JSON.stringify(offerOf(bio, at(15))));

        const thin = project('Thin');
        const thinTopics = ['A', 'B', 'C', 'D'].map(t => { const id = node(thin, t); bank(id, 2); studied(id, at(0)); return id; });
        check('four studied topics with 8 questions between them: no offer, it would be short', offerOf(thin, at(15)) === null, String(thinTopics.length));

        const deck = project('Kanji', { kind: 'deck' });
        topics(deck, ['Deck 1', 'Deck 2', 'Deck 3', 'Deck 4']).forEach(id => studied(id, at(0)));
        check('a deck: no offer (its card reviews are the mixed check already)', offerOf(deck, at(15)) === null, JSON.stringify(offerOf(deck, at(15))));

        const shelved = project('Shelved', { status: 'archived' });
        topics(shelved, ['E', 'F', 'G', 'H']).forEach(id => studied(id, at(0)));
        check('an archived course: no offer', offerOf(shelved, at(15)) === null);
    });

    await block('2. the cadence: 14 days, or a phase that closed', async () => {
        studied(g1, at(0, 1));
        check('day 13 after the first answer: not yet', offerOf(bio, at(13)) === null, JSON.stringify(offerOf(bio, at(13))));
        const due = offerOf(bio, at(14, 2));
        check('day 14: a look back of 10 questions is offered', due?.kind === 'look_back' && due?.questions === 10, JSON.stringify(due));
        check('the offer names its course', due?.projectId === bio, JSON.stringify(due));

        has('skipLookBack') && lb.skipLookBack(bio, { now: at(15) });
        check('"Not now" on day 15: nothing on day 16', offerOf(bio, at(16)) === null, JSON.stringify(offerOf(bio, at(16))));
        check('nothing on day 17 either, while no phase has closed', offerOf(bio, at(17, 23)) === null);

        for (const id of [c1, c2, c3]) complete(id, at(18));
        check('the Cells phase closes on day 18 (3 days after "Not now"): offered then', offerOf(bio, at(18, 1))?.kind === 'look_back', JSON.stringify(offerOf(bio, at(18, 1))));
        check('a completion stamped later than the instant asked about does not count', offerOf(bio, at(17, 23)) === null);
    });

    let sitting = null;
    await block('3. the look back: 10 questions, no clock, spread, one at a time', async () => {
        const started = has('startLookBack') ? lb.startLookBack(bio, { now: at(20) }) : null;
        sitting = started?.sitting?.id ?? null;
        check('starting it opens a sitting', sitting > 0, JSON.stringify(started));
        const paper = sitting ? db.prepare('SELECT e.* FROM exam_papers e JOIN mock_sittings s ON s.paper_id = e.id WHERE s.id = ?').get(sitting) : null;
        check('its question set is a course draw flagged as a look back', paper?.source === 'course' && paper?.look_back === 1, JSON.stringify(paper));
        const d = sitting ? mock.sittingDetail(sitting, { now: at(20) }) : null;
        const qs = d?.course?.questions ?? [];
        check('10 questions', qs.length === 10, String(qs.length));
        check('no clock', d?.sitting?.timeAllowed === 0, JSON.stringify(d?.sitting));
        check('the screen knows it is a look back', d?.paper?.lookBack === true, JSON.stringify(d?.paper));
        const per = new Map();
        for (const q of qs) { const n = KEY.get(refUuid(q)); per.set(n, (per.get(n) || 0) + 1); }
        const counts = [...per.values()];
        check('from the 4 studied topics, evenly (2 or 3 each)', per.size === 4 && Math.max(...counts) - Math.min(...counts) <= 1, JSON.stringify([...per]));

        const open = offerOf(bio, at(20, 1));
        check('while it is open the offer is Continue, with how far it got', open?.kind === 'resume' && open?.sittingId === sitting && open?.answered === 0 && open?.questions === 10, JSON.stringify(open));
        const again = has('startLookBack') ? lb.startLookBack(bio, { now: at(20, 1) }) : null;
        check('starting again opens the same sitting, not a second draw', again?.sitting?.id === sitting, JSON.stringify(again?.sitting));
        // "Not now" on the open one clears Continue too, until the next is due; the stamp goes back after.
        const stamp = db.prepare('SELECT look_back_skipped_at AS s FROM projects WHERE id = ?').get(bio).s;
        has('skipLookBack') && lb.skipLookBack(bio, { now: at(20, 1) });
        check('"Not now" on a look back left open: no Continue card', offerOf(bio, at(20, 2)) === null, JSON.stringify(offerOf(bio, at(20, 2))));
        db.prepare('UPDATE projects SET look_back_skipped_at = ? WHERE id = ?').run(stamp, bio);

        // Oldest practised first: 12 topics, 10 questions, the two practised most recently sit out.
        const hist = project('History');
        const many = topics(hist, Array.from({ length: 12 }, (_, i) => `Era ${i + 1}`));
        many.forEach((id, i) => studied(id, at(0, i)));
        const h = has('startLookBack') ? lb.startLookBack(hist, { now: at(15) }) : null;
        const hq = h?.sitting?.id ? mock.sittingDetail(h.sitting.id, { now: at(15) }).course.questions : [];
        const asked = new Set(hq.map(q => KEY.get(refUuid(q))));
        check('12 topics: one question each from the 10 practised longest ago', hq.length === 10 && asked.size === 10 && !asked.has(many[10]) && !asked.has(many[11]),
            JSON.stringify(many.map(id => asked.has(id) ? 1 : 0)));
    });

    await block('4. what it writes, and how a slip comes back', async () => {
        const d = mock.sittingDetail(sitting, { now: at(20) });
        for (const q of d.course.questions) {
            const nodeId = KEY.get(refUuid(q));
            mock.saveAnswer(sitting, { partId: q.partId, answer: nodeId === c2 ? 'Gamma' : 'Beta', attemptId: aid(), now: at(20, 1) });
        }
        const done = mock.finishSitting(sitting, { now: at(20, 2), attemptId: aid() });
        check('finished', done?.sitting?.status === 'done', JSON.stringify(done?.sitting));
        const rows = db.prepare("SELECT node_id, evidence_type FROM mastery_evidence WHERE evidence_type = 'mock'").all();
        check('one practice row per topic asked', rows.length === 4 && rows.every(r => r.evidence_type === 'mock'), JSON.stringify(rows));
        check('a completed topic stays completed, a started one stays started', statusOf(c2) === 'completed' && statusOf(g1) === 'in_progress');
        check('the result has no "likely between" range on a look back', done?.result?.spread == null, JSON.stringify(done?.result?.spread));

        check('just finished: nothing offered', offerOf(bio, at(20, 3)) === null, JSON.stringify(offerOf(bio, at(20, 3))));
        check('14 days later: offered again', offerOf(bio, at(34, 3))?.kind === 'look_back', JSON.stringify(offerOf(bio, at(34, 3))));

        const list = mock.listForProject(bio, { now: at(21) });
        const row = (list.courseSittings ?? []).find(s => s.id === sitting);
        check('the mock exam list names it a look back', row?.lookBack === true, JSON.stringify(row));

        const soon = new Date(Date.now() + HOUR);
        const later = new Date(Date.now() + 21 * HOUR);
        const recallIds = (when) => getDecayingNodes(bio, 14, when, { limit: null }).map(n => n.node_id);
        check('the topic answered wrong is not asked again the same hour', !recallIds(soon).includes(c2), JSON.stringify(recallIds(soon)));
        check('from 20 hours later it is in the recall round, and only it', JSON.stringify(recallIds(later)) === JSON.stringify([c2]), JSON.stringify(recallIds(later)));
        const page = composeFeed({ projectId: bio, now: later, excludeKeys: new Set() });
        check('the stream opens with a recall question on it', page.items.some(i => i.kind === 'recall' && i.nodeId === c2),
            JSON.stringify(page.items.slice(0, 4).map(i => [i.kind, i.nodeId])));

        // A right answer in the same sitting does not clear it (the miss is
        // what the look back found); one asked afterwards does.
        const quizId = db.prepare('SELECT id FROM quizzes WHERE node_id = ?').get(c2).id;
        const answerAt = (ms, correct) => db.prepare(`INSERT INTO question_log (quiz_id, question_index, node_id, surface, correct, asked_at)
            VALUES (?, 1, ?, 'mock', ?, ?)`).run(quizId, c2, correct, new Date(Date.now() + ms).toISOString());
        answerAt(10_000, 1);
        check('a right answer seconds after the miss leaves it in the round', recallIds(later).includes(c2), JSON.stringify(recallIds(later)));
        answerAt(2 * 60_000, 1);
        check('one right answer on it afterwards and it leaves the round', !recallIds(later).includes(c2), JSON.stringify(recallIds(later)));
    });

    await block('5. the mock window before a real exam', async () => {
        const chem = project('Chemistry');
        topics(chem, ['Atoms', 'Bonds', 'Acids', 'Rates']).forEach(id => studied(id, at(0)));
        const exam = plusDays(studyToday({ now: at(20).getTime() }), 10);
        db.prepare('UPDATE projects SET deadline = ?, deadline_fixed = 1 WHERE id = ?').run(exam, chem);
        const m = offerOf(chem, at(20));
        check('an exam date that cannot move, 10 days away: the full mock is offered', m?.kind === 'mock' && m?.daysLeft === 10, JSON.stringify(m));

        db.prepare('UPDATE projects SET deadline_fixed = 0 WHERE id = ?').run(chem);
        check('a plain deadline is not an exam: the look back instead', offerOf(chem, at(20))?.kind === 'look_back', JSON.stringify(offerOf(chem, at(20))));
        db.prepare('UPDATE projects SET exam_on_screen = 1, exam_questions = 20 WHERE id = ?').run(chem);
        check('the exam described: the mock again', offerOf(chem, at(20))?.kind === 'mock', JSON.stringify(offerOf(chem, at(20))));

        has('skipLookBack') && lb.skipLookBack(chem, { now: at(20) });
        check('"Not now": nothing the next day, no look back inside the window either', offerOf(chem, at(21)) === null, JSON.stringify(offerOf(chem, at(21))));
        check('a week later: the mock again', offerOf(chem, at(27, 1))?.kind === 'mock', JSON.stringify(offerOf(chem, at(27, 1))));

        const full = mock.drawCourseMock(chem, { size: 12, now: at(28) });
        mock.finishSitting(full.sitting.id, { now: at(28, 1), attemptId: aid() });
        check('a full mock finished: no offer for a week', offerOf(chem, at(30)) === null, JSON.stringify(offerOf(chem, at(30))));

        db.prepare('UPDATE projects SET deadline = ? WHERE id = ?').run(plusDays(studyToday({ now: at(20).getTime() }), 30), chem);
        check('30 days away is outside the window: the look back rules', offerOf(chem, at(20))?.kind !== 'mock', JSON.stringify(offerOf(chem, at(20))));
    });

    await block('6. the stream: the opening page of a course and of Today', async () => {
        const now = at(34, 3);
        const page = composeFeed({ projectId: bio, now, excludeKeys: new Set() });
        // Notices (no model set up, and the like) sit above everything; the offer leads what follows.
        const first = page.items.find(i => i.kind !== 'notice');
        check('the course stream opens with the offer', first?.kind === 'lookback' && first?.key === `lookback-${bio}` && first?.offer?.kind === 'look_back',
            JSON.stringify(page.items.slice(0, 2).map(i => [i.kind, i.key])));
        check('it carries the course for the card', first?.projectId === bio && first?.projectName === 'Biology', JSON.stringify(first));
        const later = composeFeed({ projectId: bio, now, excludeKeys: new Set(['x-1']) });
        check('a later page carries none', !later.items.some(i => i.kind === 'lookback'));
        const topic = composeFeed({ nodeId: g2, now, excludeKeys: new Set() });
        check("a topic's own stream carries none", !topic.items.some(i => i.kind === 'lookback'));
        const home = composeFeed({ now, excludeKeys: new Set() });
        check('Today carries one offer, for one course', home.items.filter(i => i.kind === 'lookback').length === 1,
            JSON.stringify(home.items.filter(i => i.kind === 'lookback').map(i => i.key)));
    });

    await block('7. the routes and the card', async () => {
        const geo = project('Geography');
        topics(geo, ['Rivers', 'Hills', 'Coasts', 'Climate']).forEach(id => studied(id, new Date(Date.now() - 15 * DAY)));
        const o = await call('GET', `/api/projects/${geo}/look-back`);
        check('GET offer: the look back is due', o.status === 200 && o.body?.offer?.kind === 'look_back', o.text);
        const s = await call('POST', `/api/projects/${geo}/look-back/skip`, {});
        check('POST skip answers ok', s.status === 200, s.text);
        const o2 = await call('GET', `/api/projects/${geo}/look-back`);
        check('and the offer is gone', o2.status === 200 && o2.body?.offer === null, o2.text);
        const st = await call('POST', `/api/projects/${geo}/look-back`, {});
        check('POST start opens a sitting all the same', st.status === 200 && st.body?.sitting?.id > 0, st.text);
        const nope = await call('GET', '/api/projects/999999/look-back');
        check('an unknown course is a 404', nope.status === 404, nope.text);

        const cardPath = join(ROOT, 'src', 'components', 'feed', 'LookBackCard.tsx');
        const card = existsSync(cardPath) ? readFileSync(cardPath, 'utf8') : '';
        check('the card exists', card.length > 0);
        check('it holds two buttons at most', card.length > 0 && (card.match(/<Button\b/g) ?? []).length <= 2, String((card.match(/<Button\b/g) ?? []).length));
        const view = readFileSync(join(ROOT, 'src', 'components', 'feed', 'FeedView.tsx'), 'utf8');
        check('the stream renders it', /case 'lookback'/.test(view) && /LookBackCard/.test(view));
        const api = readFileSync(join(ROOT, 'src', 'api.ts'), 'utf8');
        check('the client can start, skip and read it', ['startLookBack', 'skipLookBack', 'getLookBack'].every(f => api.includes(f)));
    });
} finally {
    server.close();
    try { db.close(); } catch { /* closed */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

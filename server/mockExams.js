// MOCK EXAMS: a real past paper, written by hand with the app as the clock,
// then marked by the learner part by part against the paper's worked solution.
//
// What a mock is for: an honest measurement across the course and a rehearsal
// of the exam as it is really taken. It is not proof. A paper gives a topic a
// few parts, graded by the learner against a solution, so a finished mock is
// written as 'mock' evidence, however many parts a topic has: practice that
// moves each tagged topic's
// estimate up or down and never completes, proves or reopens a topic
// (server/mastery.js). A part left unmarked counts zero in the mock and writes
// nothing against its topic.
//
// The grade is the paper's own: a linear formula printed on its cover
// (for example: grade = points / 79 * 9 + 1) and a pass grade, shown as the points it
// takes. A single question has a points total and no grade: the formula is
// for the whole paper.
//
// The clock lives here, not in the page: `elapsed` is banked seconds and
// `running_since` the moment it last started, so a closed tab, a reload or a
// second device all read the same time. Nothing hands in by itself: past the
// time allowed the sitting is still writing until the learner says done.
//
// Every function that reads the clock takes `now` (ms), so the gates
// (tools/mock-exam-gates.mjs) never read the wall clock.

import db from './database.js';
import { ATTEMPT_ID_ERROR, readAttemptId, recordOnce, updateMasteryFromAttempt } from './mastery.js';
import { WORK_LEAF } from './today.js';
import { banksOfProject, logAsked, orderForAsking } from './questionLog.js';
import { isUnverified } from './questionTrust.js';
import { ANSWER_FORMATS, gradeLocally } from './answerFormats.js';

/** An error whose message is safe to show and whose status the route sends. */
export class MockExamError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
        this.expose = true;
    }
}
const bad = (message) => new MockExamError(400, message);

const cache = new Map();
const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
};

const MAX_PARTS = 200;
const MAX_MINUTES = 24 * 60;
const MAX_POINTS = 1000;
const iso = (ms) => new Date(ms).toISOString();

// ---- grading ---------------------------------------------------------------

/** One decimal, as a grade is printed. */
const oneDecimal = (x) => Math.round(x * 10 + 1e-9) / 10;

/** The grade for `points` by the paper's own linear formula, or null when it has none. */
export function gradeFor({ total, gradeMin, gradeMax }, points) {
    if (gradeMin == null || gradeMax == null || !(total > 0)) return null;
    return oneDecimal(gradeMin + (gradeMax - gradeMin) * points / total);
}

/**
 * The fewest points that reach the pass grade, or null with no pass grade.
 * A paper passes on its printed grade (one decimal), and points come in
 * halves, so the line is the fewest half points whose printed grade reaches
 * the pass grade: 39.5 of 79 prints 5.5 and passes, 39 prints 5.4. The line
 * and `passed` therefore always agree with the grade on screen.
 */
export function passPointsFor(shape) {
    const { total, gradeMin, gradeMax, passGrade } = shape;
    if (passGrade == null || gradeMin == null || gradeMax == null || !(total > 0)) return null;
    const exact = (passGrade - gradeMin) / (gradeMax - gradeMin) * total;
    // Rounding to one decimal moves the line by under a point: start a point
    // below the exact share and step up a half at a time.
    for (let pts = Math.max(0, Math.floor(exact * 2) / 2 - 1); pts <= total; pts += 0.5) {
        if (gradeFor(shape, pts) >= passGrade) return pts;
    }
    return total;
}

// ---- papers ----------------------------------------------------------------

const partsOf = (paperId) => stmt(`
    SELECT p.id, p.question, p.part, p.points, p.node_id AS nodeId, n.title AS topic
    FROM exam_paper_parts p LEFT JOIN nodes n ON n.id = p.node_id
    WHERE p.paper_id = ? ORDER BY p.position
`).all(paperId);

function paperView(row) {
    const parts = partsOf(row.id);
    const total = parts.reduce((a, p) => a + p.points, 0);
    const shape = { total, gradeMin: row.grade_min, gradeMax: row.grade_max, passGrade: row.pass_grade };
    return {
        id: row.id,
        uuid: row.uuid,
        projectId: row.project_id,
        title: row.title,
        minutes: row.minutes,
        gradeMin: row.grade_min,
        gradeMax: row.grade_max,
        passGrade: row.pass_grade,
        paperDocumentId: row.paper_document_id,
        solutionDocumentId: row.solution_document_id,
        // A PDF opens beside the points; a picture opens in its own tab.
        solutionKind: row.solution_document_id == null ? null
            : stmt('SELECT file_type FROM documents WHERE id = ?').get(row.solution_document_id)?.file_type ?? null,
        total,
        passPoints: passPointsFor(shape),
        parts,
    };
}

const paperRow = (id) => stmt('SELECT * FROM exam_papers WHERE id = ?').get(id);

export function getPaper(id) {
    const row = paperRow(id);
    return row ? paperView(row) : null;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const MAX_GRADE = 1000;
const optNumber = (v, name) => {
    if (v === null || v === undefined || v === '') return null;
    if (!finite(v) || v < 0 || v > MAX_GRADE) throw bad(`${name} must be a number from 0 to ${MAX_GRADE}`);
    return v;
};
/** The kinds a browser shows inline, so the paper and its solution open beside the points. */
const SHOWN_KINDS = ['pdf', 'jpg', 'png', 'webp'];
const SHOWN_KINDS_SQL = SHOWN_KINDS.map(k => `'${k}'`).join(', ');

/** Checks a paper's description and points table; returns the rows to write. */
function readPaperInput(projectId, input) {
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > 200) throw bad('A paper needs a title (up to 200 characters)');
    const minutes = input.minutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) throw bad('The time allowed must be a whole number of minutes, at least 1');
    const gradeMin = optNumber(input.gradeMin, 'The lowest grade');
    const gradeMax = optNumber(input.gradeMax, 'The highest grade');
    const passGrade = optNumber(input.passGrade, 'The pass grade');
    if ((gradeMin == null) !== (gradeMax == null)) throw bad('A grade formula needs both its lowest and its highest grade');
    if (gradeMin != null && !(gradeMax > gradeMin)) throw bad('The highest grade must be above the lowest');
    if (passGrade != null && (gradeMin == null || passGrade < gradeMin || passGrade > gradeMax)) {
        throw bad('The pass grade must lie between the lowest and the highest grade');
    }
    const doc = (v, name) => {
        if (v == null) return null;
        if (!Number.isInteger(v) || !stmt(`
            SELECT 1 FROM documents WHERE id = ? AND project_id = ? AND file_hash IS NOT NULL
                AND status IS NOT 'failed' AND file_type IN (${SHOWN_KINDS_SQL})
        `).get(v, projectId)) {
            throw bad(`The ${name} must be a file of this course`);
        }
        return v;
    };
    const paperDocumentId = doc(input.paperDocumentId, 'paper');
    const solutionDocumentId = doc(input.solutionDocumentId, 'worked solution');

    const raw = Array.isArray(input.parts) ? input.parts : [];
    if (raw.length === 0) throw bad('A paper needs at least one question with its points');
    if (raw.length > MAX_PARTS) throw bad(`A paper has at most ${MAX_PARTS} parts`);
    const seen = new Set();
    const parts = raw.map((p, i) => {
        const question = String(p?.question ?? '').trim();
        const part = String(p?.part ?? '').trim();
        if (!question || question.length > 20 || part.length > 20) throw bad(`Part ${i + 1} needs a question number`);
        const key = `${question}\u0000${part}`;
        if (seen.has(key)) throw bad(`Question ${question}${part} is listed twice`);
        seen.add(key);
        if (!Number.isInteger(p.points) || p.points < 1 || p.points > MAX_POINTS) throw bad(`Question ${question}${part} needs its points, a whole number of at least 1`);
        let nodeId = null;
        if (p.nodeId != null) {
            if (!Number.isInteger(p.nodeId) || !stmt(`SELECT 1 FROM nodes n WHERE n.id = ? AND n.project_id = ? AND ${WORK_LEAF}`).get(p.nodeId, projectId)) {
                throw bad(`The topic of question ${question}${part} is not in this course`);
            }
            nodeId = p.nodeId;
        }
        return { question, part, points: p.points, nodeId };
    });
    return { title, minutes, gradeMin, gradeMax, passGrade, paperDocumentId, solutionDocumentId, parts };
}

export function createPaper(projectId, input) {
    if (!stmt('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new MockExamError(404, 'Course not found');
    const p = readPaperInput(projectId, input);
    const id = db.transaction(() => {
        const paperId = Number(stmt(`
            INSERT INTO exam_papers (project_id, title, minutes, grade_min, grade_max, pass_grade, paper_document_id, solution_document_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(projectId, p.title, p.minutes, p.gradeMin, p.gradeMax, p.passGrade, p.paperDocumentId, p.solutionDocumentId).lastInsertRowid);
        p.parts.forEach((part, i) => stmt(`
            INSERT INTO exam_paper_parts (paper_id, position, question, part, points, node_id) VALUES (?, ?, ?, ?, ?, ?)
        `).run(paperId, i, part.question, part.part, part.points, part.nodeId));
        return paperId;
    })();
    return getPaper(id);
}

/** A paper with mocks keeps its points table; only an unused paper is deleted. */
export function deletePaper(id) {
    const row = paperRow(id);
    if (!row) throw new MockExamError(404, 'Paper not found');
    if (stmt("SELECT 1 FROM mock_sittings WHERE paper_id = ? AND status = 'done' LIMIT 1").get(id)) {
        throw new MockExamError(409, 'This paper has finished mocks, so it stays');
    }
    stmt('DELETE FROM exam_papers WHERE id = ?').run(id);
}

/** Everything the course's mock exam screen opens with. */
export function listForProject(projectId, { now = Date.now() } = {}) {
    if (!stmt('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new MockExamError(404, 'Course not found');
    const papers = stmt("SELECT * FROM exam_papers WHERE project_id = ? AND source = 'paper' ORDER BY created_at, id").all(projectId).map(row => {
        const view = paperView(row);
        const sittings = stmt('SELECT * FROM mock_sittings WHERE paper_id = ? ORDER BY started_at, id').all(row.id)
            .map(s => {
                const r = resultOf(s, view);
                return { ...sittingView(s, now), earned: r.earned, total: r.total, grade: r.grade, passed: r.passed };
            });
        return { ...view, sittings };
    });
    const topics = stmt(`
        SELECT n.id, n.title FROM nodes n WHERE n.project_id = ? AND ${WORK_LEAF} ORDER BY n.position, n.id
    `).all(projectId);
    const documents = stmt(`
        SELECT id, title, file_type AS fileType FROM documents
        WHERE project_id = ? AND file_hash IS NOT NULL AND status IS NOT 'failed' AND file_type IN (${SHOWN_KINDS_SQL})
        ORDER BY id DESC
    `).all(projectId);
    return { papers, topics, documents, course: courseReadiness(projectId), courseSittings: courseSittingsOf(projectId, now) };
}

// ---- sittings and the clock --------------------------------------------------

const sittingRow = (id) => stmt('SELECT * FROM mock_sittings WHERE id = ?').get(id);

function elapsedOf(s, now) {
    const running = s.running_since ? Math.max(0, Math.floor((now - Date.parse(s.running_since)) / 1000)) : 0;
    return s.elapsed + running;
}

function sittingView(s, now) {
    const elapsed = elapsedOf(s, now);
    return {
        id: s.id,
        uuid: s.uuid,
        paperId: s.paper_id,
        question: s.question,
        status: s.status,
        timeAllowed: s.time_allowed,
        elapsed,
        running: !!s.running_since,
        // No clock (a course mock may run without one): never time up.
        timeUp: s.time_allowed > 0 && elapsed >= s.time_allowed,
        startedAt: s.started_at,
        finishedAt: s.finished_at,
    };
}

export function getSitting(id, { now = Date.now() } = {}) {
    const s = sittingRow(id);
    return s ? sittingView(s, now) : null;
}

/**
 * Start a mock: the whole paper, or one question with its share of the time
 * (the paper's minutes times the question's share of the points, rounded up
 * to a whole minute). The clock starts at once.
 */
export function startSitting(paperId, { question = null, now = Date.now() } = {}) {
    const paper = getPaper(paperId);
    if (!paper) throw new MockExamError(404, 'Paper not found');
    // A drawn question set belongs to its one attempt (discardSitting removes
    // the set with it), so it never gets a second.
    if (stmt('SELECT source FROM exam_papers WHERE id = ?').get(paperId)?.source === 'course') {
        throw bad('A mock from this course is drawn anew each time');
    }
    let timeAllowed = paper.minutes * 60;
    if (question != null) {
        const q = String(question);
        const pts = paper.parts.filter(p => p.question === q).reduce((a, p) => a + p.points, 0);
        if (!pts) throw bad(`This paper has no question ${q}`);
        timeAllowed = Math.ceil(paper.minutes * pts / paper.total) * 60;
    }
    const id = Number(stmt(`
        INSERT INTO mock_sittings (paper_id, question, time_allowed, elapsed, running_since, status, started_at)
        VALUES (?, ?, ?, 0, ?, 'writing', ?)
    `).run(paperId, question == null ? null : String(question), timeAllowed, iso(now), iso(now)).lastInsertRowid);
    return getSitting(id, { now });
}

function requireSitting(id) {
    const s = sittingRow(id);
    if (!s) throw new MockExamError(404, 'Mock not found');
    return s;
}

/** Bank the running time and stop the clock. Leaving the page pauses too. */
export function pauseSitting(id, { now = Date.now() } = {}) {
    const s = requireSitting(id);
    if (s.status === 'writing' && s.running_since) {
        stmt('UPDATE mock_sittings SET elapsed = ?, running_since = NULL WHERE id = ?').run(elapsedOf(s, now), id);
    }
    return getSitting(id, { now });
}

export function resumeSitting(id, { now = Date.now() } = {}) {
    const s = requireSitting(id);
    if (s.status === 'writing' && !s.running_since) {
        stmt('UPDATE mock_sittings SET running_since = ? WHERE id = ?').run(iso(now), id);
    }
    return getSitting(id, { now });
}

/** "Finish writing" (or the learner hands in after time up): the clock stops and marking opens. */
export function stopWriting(id, { now = Date.now() } = {}) {
    const s = requireSitting(id);
    if (isCourse(s)) throw bad('A mock from this course ends with Finish');
    if (s.status === 'writing') {
        stmt("UPDATE mock_sittings SET elapsed = ?, running_since = NULL, status = 'marking' WHERE id = ?").run(elapsedOf(s, now), id);
    }
    return getSitting(id, { now });
}

/** A mock not yet finished may be thrown away; a finished one is history. */
export function discardSitting(id) {
    const s = requireSitting(id);
    if (s.status === 'done') throw new MockExamError(409, 'A finished mock is kept');
    // A drawn question set belongs to its one attempt: it goes with it.
    if (isCourse(s)) stmt('DELETE FROM exam_papers WHERE id = ?').run(s.paper_id);
    else stmt('DELETE FROM mock_sittings WHERE id = ?').run(id);
}

// ---- marking -----------------------------------------------------------------

/** The parts a sitting covers: the whole paper, or one question's parts. */
const scopeOf = (s, paper) => (s.question == null ? paper.parts : paper.parts.filter(p => p.question === s.question));

/** Points for one part, in halves; `null` clears it back to unmarked. */
export function setPartScore(sittingId, partId, points) {
    const s = requireSitting(sittingId);
    if (s.status !== 'marking') {
        throw new MockExamError(409, s.status === 'done' ? 'This mock is finished' : 'Marking opens when the writing is done');
    }
    const paper = getPaper(s.paper_id);
    const part = scopeOf(s, paper).find(p => p.id === partId);
    if (!part) throw bad('That part is not in this mock');
    if (points === null) {
        stmt('DELETE FROM mock_part_scores WHERE sitting_id = ? AND part_id = ?').run(sittingId, partId);
    } else {
        if (!finite(points) || points < 0 || points > part.points || !Number.isInteger(points * 2)) {
            throw bad(`Points for this part are 0 to ${part.points}, in halves`);
        }
        stmt(`
            INSERT INTO mock_part_scores (sitting_id, part_id, points) VALUES (?, ?, ?)
            ON CONFLICT (sitting_id, part_id) DO UPDATE SET points = excluded.points
        `).run(sittingId, partId, points);
    }
    return sittingDetail(sittingId);
}

// ---- the result ----------------------------------------------------------------

function resultOf(s, paper) {
    const scope = scopeOf(s, paper);
    const marks = new Map(stmt('SELECT part_id, points FROM mock_part_scores WHERE sitting_id = ?').all(s.id).map(r => [r.part_id, r.points]));
    const parts = scope.map(p => ({ ...p, earned: marks.has(p.id) ? marks.get(p.id) : null }));
    const total = scope.reduce((a, p) => a + p.points, 0);
    const earned = parts.reduce((a, p) => a + (p.earned ?? 0), 0);
    const whole = s.question == null;
    const shape = { total, gradeMin: paper.gradeMin, gradeMax: paper.gradeMax, passGrade: paper.passGrade };
    const passPoints = whole ? passPointsFor(shape) : null;

    // Questions by points lost, the largest first; an unmarked part has lost
    // all its points. Ties keep the paper's order.
    const byQ = new Map();
    for (const p of parts) {
        const q = byQ.get(p.question) ?? { question: p.question, points: 0, earned: 0, lost: 0, topics: [] };
        q.points += p.points;
        q.earned += p.earned ?? 0;
        if (p.nodeId != null && !q.topics.some(t => t.id === p.nodeId)) q.topics.push({ id: p.nodeId, title: p.topic });
        byQ.set(p.question, q);
    }
    const questions = [...byQ.values()].map(q => ({ ...q, lost: q.points - q.earned }));
    questions.sort((a, b) => b.lost - a.lost);

    return {
        earned,
        total,
        unmarked: parts.filter(p => p.earned == null).length,
        grade: whole ? gradeFor(shape, earned) : null,
        passPoints,
        passed: passPoints == null ? null : earned >= passPoints,
        parts,
        questions,
    };
}

export function sittingDetail(id, { now = Date.now() } = {}) {
    const s = requireSitting(id);
    if (isCourse(s)) return courseDetail(s, now);
    const paper = getPaper(s.paper_id);
    return { sitting: sittingView(s, now), paper, result: resultOf(s, paper) };
}

/**
 * Finish a marked mock: written once. Each topic with a marked part gets one
 * 'mock' evidence row: its marked parts, a part counting right at half its
 * points or more. Unmarked parts and parts with no topic write nothing. A
 * second finish returns the stored result and writes nothing.
 *
 * `fillUnmarked` ("Give them 0") records 0 for every ungraded part in the
 * same transaction, so a failure half-way leaves no part changed.
 */
export function finishSitting(id, { now = Date.now(), attemptId = null, fillUnmarked = false } = {}) {
    if (isCourse(requireSitting(id))) return finishCourse(id, { now, attemptId });
    db.transaction(() => {
        const s = requireSitting(id);
        if (s.status === 'done') return;
        if (s.status === 'writing') throw new MockExamError(409, 'Say you are done writing first');
        if (fillUnmarked) {
            for (const p of scopeOf(s, getPaper(s.paper_id))) {
                stmt('INSERT OR IGNORE INTO mock_part_scores (sitting_id, part_id, points) VALUES (?, ?, 0)').run(id, p.id);
            }
        }
        const paper = getPaper(s.paper_id);
        const { parts } = resultOf(s, paper);
        const byTopic = new Map();
        for (const p of parts) {
            if (p.nodeId == null || p.earned == null) continue;
            const t = byTopic.get(p.nodeId) ?? { right: 0, total: 0 };
            t.total += 1;
            if (p.earned * 2 >= p.points) t.right += 1;
            byTopic.set(p.nodeId, t);
        }
        for (const [nodeId, t] of byTopic) {
            updateMasteryFromAttempt(nodeId, t.right, t.total, 'mock', { surface: 'mock', sitting: s.uuid, paper: paper.uuid });
        }
        stmt("UPDATE mock_sittings SET status = 'done', finished_at = ? WHERE id = ?").run(iso(now), id);
    })();
    return sittingDetail(id, { now });
}

// ---- a mock from the course's own questions ----------------------------------
//
// The second source: a mixed draw of the questions the course already holds,
// answered on screen and scored at the end. The draw is a question set (an
// `exam_papers` row with source 'course', one part per question, the question
// kept as it was asked) and the attempt is a sitting of it, so the clock, the
// list and "never lose an answer" are the past paper's own, and a set stays
// apart from whoever answers it.
//
// What is drawn: only questions that passed the quality gates and that the
// app can check by itself (a verifier's stamp holds one back; a written answer
// needs the AI and is left out, and said so), only from the topics studied so
// far, never-asked first, spread across topics by turns, never one twice.
//
// While it is open the mock's own routes send nothing of the key (no answer
// key, accepted answers or explanation), and neither do a report's preview
// or the assistant's page context; a save says nothing about right or wrong.
// The quizzes the questions are drawn from keep their keys on the quiz
// routes, as every quiz does: this guards the screen, not a crafted request
// on the learner's own machine. Each
// save is written once per attempt id (`recordOnce`), and accepted whatever
// the clock says: past the time allowed it is kept as extra time, and the
// result is the in-time one.
//
// Finishing writes 'mock' evidence, practice that moves each answered topic's
// estimate either way and never completes, proves or reopens a topic; an
// unanswered question writes nothing. Each row names its questions
// (`items`), so a question reported later is taken out of it again.

/** With no exam described, a mock is 20 questions with no clock. */
export const DEFAULT_DRAW = 20;
const MAX_DRAW = 200;
const ANSWER_MAX = 20_000;
const REVIEW_ORDER = ['wrong', 'wrong_later', 'none', 'right'];

const isCourse = (s) => stmt('SELECT source FROM exam_papers WHERE id = ?').get(s.paper_id)?.source === 'course';
const safeParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const refOf = (q) => (q && typeof q.uuid === 'string' && q.uuid ? `q:${q.uuid}` : null);
/** The app grades it by itself; a written answer goes to the AI and is not drawn. */
const checksAlone = (q) => ANSWER_FORMATS[q?.type]?.grading === 'local';
// A placement answer is given BEFORE a topic is studied, so it starts nothing.
const STUDIED = `(n.status IN ('in_progress', 'completed') OR EXISTS (SELECT 1 FROM mastery_evidence e WHERE e.node_id = n.id AND e.evidence_type <> 'placement'))`;
// A report stands until undone, or until the learner's own edit (server/itemReports.js).
const STANDING_REPORT = `undone_at IS NULL AND (rewrite IS NULL OR json_extract(rewrite, '$.state') IS NOT 'edited')`;

function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

/**
 * How far one draw can be off: the Wilson 95% interval for the learner's rate
 * on these questions, given `right` of `n`, shown as counts of `n` ("your real
 * level is most likely between 25 and 35 of 40"). It is an interval for the
 * rate, not for the score of another draw (that one is wider), and never a
 * forecast of the real exam.
 */
export function spreadOf(right, n) {
    if (!(n > 0)) return null;
    const z2 = 1.96 * 1.96;
    const p = right / n;
    const denom = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / denom;
    const half = Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) * 1.96 / denom;
    return { low: Math.max(0, Math.round((centre - half) * n)) || 0, high: Math.min(n, Math.round((centre + half) * n)) };
}

// ---- the real exam ---------------------------------------------------------------

/** The course's real exam as described, or null when it is not. Its date is the course's deadline. */
export function getExam(projectId) {
    const r = stmt('SELECT exam_on_screen, exam_questions, exam_minutes, exam_pass FROM projects WHERE id = ?').get(projectId);
    if (!r || r.exam_on_screen == null) return null;
    if (!r.exam_on_screen) return { onScreen: false, questions: null, minutes: null, passRight: null };
    return { onScreen: true, questions: r.exam_questions, minutes: r.exam_minutes, passRight: r.exam_pass };
}

/** Describe the real exam: `{ onScreen }`, and for an on-screen one its length, minutes and pass line. `{}` clears it. */
export function setExam(projectId, input) {
    if (!stmt('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new MockExamError(404, 'Course not found');
    const write = stmt('UPDATE projects SET exam_on_screen = ?, exam_questions = ?, exam_minutes = ?, exam_pass = ? WHERE id = ?');
    if (input?.onScreen == null) { write.run(null, null, null, null, projectId); return null; }
    if (typeof input.onScreen !== 'boolean') throw bad('onScreen is true or false');
    if (!input.onScreen) { write.run(0, null, null, null, projectId); return getExam(projectId); }
    const { questions, minutes = null, passRight = null } = input;
    if (!Number.isInteger(questions) || questions < 1 || questions > MAX_DRAW) throw bad(`The real exam has 1 to ${MAX_DRAW} questions`);
    if (minutes != null && (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES)) throw bad('The real exam\'s time is a whole number of minutes, at least 1');
    if (passRight != null && (!Number.isInteger(passRight) || passRight < 0 || passRight > questions)) throw bad('The pass line is a number of right answers, at most the number of questions');
    write.run(1, questions, minutes, passRight, projectId);
    return getExam(projectId);
}

// ---- the draw ----------------------------------------------------------------------

/** The ready questions per studied topic, and what was left out and why. */
function courseBanks(projectId) {
    const topics = stmt(`SELECT n.id, n.title, ${STUDIED} AS studied FROM nodes n WHERE n.project_id = ? AND ${WORK_LEAF} ORDER BY n.position, n.id`).all(projectId);
    const studied = topics.filter(t => t.studied);
    // One read for the whole course: the mock list asks for this on every open.
    const byTopic = banksOfProject(projectId);
    const seen = new Set();
    let written = 0;
    let held = 0;
    const banks = [];
    for (const topic of studied) {
        const ready = [];
        for (const b of byTopic.get(topic.id) ?? []) {
            if (isUnverified(b.question)) { held++; continue; }
            if (!checksAlone(b.question)) { written++; continue; }
            const key = b.question.uuid || `${b.quizId}:${b.index}`;
            if (seen.has(key)) continue;
            seen.add(key);
            ready.push({ ...b, nodeId: topic.id });
        }
        if (ready.length) banks.push({ topic, ready });
    }
    return { banks, studied: studied.length, notStudied: topics.length - studied.length, written, held };
}

/** What a draw from this course could ask, what is left out, and the set-up's defaults. */
export function courseReadiness(projectId) {
    const { banks, studied, notStudied, written, held } = courseBanks(projectId);
    const exam = getExam(projectId);
    return {
        ready: banks.reduce((a, b) => a + b.ready.length, 0),
        topics: banks.length,
        studied,
        notStudied,
        writtenLeftOut: written,
        held,
        exam,
        // The clock is on by default only when the real exam is itself taken on screen.
        clockOn: exam?.onScreen === true,
        defaultSize: exam?.onScreen && exam.questions ? exam.questions : DEFAULT_DRAW,
    };
}

/** The question log's record of which of these were ever asked (uuid, or position for a row without one). */
function askedKeys(entries) {
    const quizIds = [...new Set(entries.map(b => b.quizId))];
    if (!quizIds.length) return new Set();
    return new Set(db.prepare(`
        SELECT DISTINCT COALESCE(question_uuid, quiz_id || ':' || question_index) AS k
        FROM question_log WHERE quiz_id IN (${quizIds.map(() => '?').join(',')})
    `).all(...quizIds).map(r => r.k));
}

/**
 * Start a mock of `size` questions from the course, with a clock of `minutes`
 * or none (null). Never-asked questions come before any asked one, even where
 * that leaves the spread uneven: among the never-asked, topics take turns, so
 * none takes more than one more than another while it still has never-asked
 * questions; the asked ones then fill what is left the same way. So with 10
 * never-asked in one topic and only asked ones in another, a draw of 10 is all
 * from the first. The order on screen is mixed. Fewer ready than asked: the
 * mock is what there is, and says so.
 */
export function drawCourseMock(projectId, { size, minutes = null, now = Date.now() } = {}) {
    if (!stmt('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new MockExamError(404, 'Course not found');
    if (!Number.isInteger(size) || size < 1 || size > MAX_DRAW) throw bad(`A mock asks 1 to ${MAX_DRAW} questions`);
    if (minutes != null && (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES)) throw bad('The clock is a whole number of minutes, at least 1');
    const { banks } = courseBanks(projectId);
    const all = banks.flatMap(b => b.ready);
    const asked = askedKeys(all);
    const keyOf = (b) => b.question.uuid || `${b.quizId}:${b.index}`;
    // One ordering for the whole course, then split by topic: the order
    // within a topic is the same as ordering each topic's bank alone.
    const ordered = new Map(banks.map(b => [b.topic.id, []]));
    for (const x of orderForAsking(all)) ordered.get(x.nodeId).push(x);
    const queues = shuffle([...ordered.values()].map(list => (
        { fresh: list.filter(x => !asked.has(keyOf(x))), seen: list.filter(x => asked.has(keyOf(x))) }
    )));
    const picked = [];
    for (const tier of ['fresh', 'seen']) {
        let more = true;
        while (more && picked.length < size) {
            more = false;
            for (const q of queues) {
                if (picked.length >= size) break;
                const next = q[tier].shift();
                if (next) { picked.push(next); more = true; }
            }
        }
    }
    if (!picked.length) throw new MockExamError(409, 'This course has no questions ready for a mock exam yet');
    shuffle(picked);

    const exam = getExam(projectId);
    // A pass line only when this mock copies an on-screen exam's length.
    const passRight = exam?.onScreen && exam.passRight != null && exam.questions === size && picked.length === size ? exam.passRight : null;
    const id = db.transaction(() => {
        const paperId = Number(stmt(`
            INSERT INTO exam_papers (project_id, title, minutes, source, pass_right) VALUES (?, 'From this course', ?, 'course', ?)
        `).run(projectId, minutes ?? Math.max(1, Math.ceil(picked.length * 1.5)), passRight).lastInsertRowid);
        picked.forEach((b, i) => stmt(`
            INSERT INTO exam_paper_parts (paper_id, position, question, part, points, node_id, item, quiz_id, question_index)
            VALUES (?, ?, ?, '', 1, ?, ?, ?, ?)
        `).run(paperId, i, String(i + 1), b.nodeId, JSON.stringify(b.question), b.quizId, b.index));
        return Number(stmt(`
            INSERT INTO mock_sittings (paper_id, question, time_allowed, elapsed, running_since, status, started_at)
            VALUES (?, NULL, ?, 0, ?, 'writing', ?)
        `).run(paperId, minutes ? minutes * 60 : 0, iso(now), iso(now)).lastInsertRowid);
    })();
    return { sitting: getSitting(id, { now }), asked: size, drawn: picked.length, short: picked.length < size };
}

// ---- answering -----------------------------------------------------------------------

/** A question as the open mock shows it: what an input needs, nothing of the key. */
function publicQuestion(q) {
    const strings = (a) => (Array.isArray(a) ? a.filter(x => typeof x === 'string') : []);
    const out = { type: String(q.type || 'multiple_choice'), question: String(q.question ?? '') };
    if (typeof q.uuid === 'string') out.uuid = q.uuid;
    if (out.type === 'multiple_choice') out.options = strings(q.options);
    if (out.type === 'sequence') out.items = strings(q.items);
    if (out.type === 'assemble') {
        out.template = String(q.template ?? '');
        out.tokens = strings(q.tokens);
        if (q.reuse === true) out.reuse = true;
    }
    if (out.type === 'numeric' && typeof q.unit === 'string') out.unit = q.unit;
    if (q.media) out.media = q.media;
    return out;
}

const courseRows = (s) => stmt(`
    SELECT p.id, p.position, p.node_id AS nodeId, p.item, p.quiz_id AS quizId, p.question_index AS questionIndex,
           n.title AS topic, sc.answer, sc.points, sc.later, sc.in_time_answer AS inTimeAnswer, sc.in_time_points AS inTimePoints
    FROM exam_paper_parts p
    LEFT JOIN nodes n ON n.id = p.node_id
    LEFT JOIN mock_part_scores sc ON sc.part_id = p.id AND sc.sitting_id = ?
    WHERE p.paper_id = ? ORDER BY p.position
`).all(s.id, s.paper_id).map(r => ({ ...r, q: safeParse(r.item) || {}, later: !!r.later, right: r.answer != null && r.points === 1 }));

function progressOf(rows) {
    const answered = rows.filter(r => r.answer != null).length;
    return { answered, left: rows.length - answered, later: rows.filter(r => r.later).length };
}

/**
 * Save one answer, its "come back to this" mark, or both. `answer` '' clears
 * it; absent, it is left as it is. Written once per `attemptId`: the same id
 * again (a retry after a lost response) writes nothing. Accepted while the
 * mock is open, paused or past its time, because a save that races the pause
 * on leaving must not be lost; past the time it counts as extra time.
 */
export function saveAnswer(sittingId, { partId, answer, later, attemptId = null, now = Date.now() } = {}) {
    const s = requireSitting(sittingId);
    if (!isCourse(s)) throw bad('A past paper is marked part by part');
    if (s.status === 'done') throw new MockExamError(409, 'This mock is finished');
    const part = stmt('SELECT id, item FROM exam_paper_parts WHERE id = ? AND paper_id = ?').get(partId, s.paper_id);
    if (!part) throw bad('That question is not in this mock');
    if (answer !== undefined && answer !== null && (typeof answer !== 'string' || answer.length > ANSWER_MAX)) throw bad('An answer is text');
    if (later !== undefined && typeof later !== 'boolean') throw bad('later is true or false');
    const aid = readAttemptId(attemptId);
    if (aid === undefined) throw bad(ATTEMPT_ID_ERROR);
    const { duplicate } = recordOnce('mock', aid, () => {
        const row = stmt('SELECT * FROM mock_part_scores WHERE sitting_id = ? AND part_id = ?').get(sittingId, partId);
        const text = answer === undefined ? (row?.answer ?? null) : (answer && answer.trim() ? answer : null);
        const mark = later === undefined ? !!row?.later : later;
        const points = text != null && gradeLocally(safeParse(part.item) || {}, text) === true ? 1 : 0;
        const inTime = !(s.time_allowed > 0 && elapsedOf(s, now) >= s.time_allowed);
        if (row) {
            stmt(`
                UPDATE mock_part_scores SET answer = ?, points = ?, later = ?,
                    in_time_answer = CASE WHEN ? THEN ? ELSE in_time_answer END,
                    in_time_points = CASE WHEN ? THEN ? ELSE in_time_points END
                WHERE id = ?
            `).run(text, points, mark ? 1 : 0, inTime ? 1 : 0, text, inTime ? 1 : 0, points, row.id);
        } else {
            stmt(`
                INSERT INTO mock_part_scores (sitting_id, part_id, points, answer, later, in_time_answer, in_time_points)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(sittingId, partId, points, text, mark ? 1 : 0, inTime ? text : null, inTime ? points : null);
        }
        return null;
    }, `part:${sittingId}:${partId}`);
    return { duplicate, ...progressOf(courseRows(requireSitting(sittingId))) };
}

// ---- the result --------------------------------------------------------------------

function standingReports(refs) {
    if (!refs.length) return new Set();
    // One statement for any number of refs: the list runs this per finished mock.
    return new Set(stmt(`SELECT item_key FROM item_reports WHERE item_key IN (SELECT value FROM json_each(?)) AND ${STANDING_REPORT}`)
        .all(JSON.stringify(refs)).map(r => r.item_key));
}

/**
 * What a finished mock adds up to. The score is the in-time one: right
 * answers as they stood when the time ran out; answers given or changed after
 * it are told apart (`late`). A question the learner reported is left out of
 * the score and the review. Topics and the review read the final answers.
 */
function courseResult(s, rows, paper) {
    const reported = standingReports(rows.map(r => refOf(r.q)).filter(Boolean));
    const counted = rows.filter(r => !reported.has(refOf(r.q)));
    const right = counted.reduce((a, r) => a + (r.inTimeAnswer != null && r.inTimePoints === 1 ? 1 : 0), 0);
    const notAnswered = counted.filter(r => r.inTimeAnswer == null).length;
    const changedLate = counted.some(r => (r.answer ?? null) !== (r.inTimeAnswer ?? null));
    const total = counted.length;
    // The pass line belongs to the real exam's length: a reported question
    // shortens the mock, and then it is no longer that exam.
    const passRight = total === rows.length ? paper.pass_right ?? null : null;

    const byTopic = new Map();
    for (const r of counted) {
        const t = byTopic.get(r.nodeId) ?? { id: r.nodeId, title: r.topic, right: 0, total: 0, marks: [] };
        t.total += 1;
        if (r.right) t.right += 1;
        t.marks.push(r.answer == null ? 'none' : r.right ? 'right' : 'wrong');
        byTopic.set(r.nodeId, t);
    }
    // Topics with wrong answers first, the most wrong first.
    const topics = [...byTopic.values()].filter(t => t.id != null)
        .sort((a, b) => (b.total - b.right) - (a.total - a.right) || a.right / a.total - b.right / b.total);

    const groupOf = (r) => (r.answer == null ? 'none' : r.right ? 'right' : r.later ? 'wrong_later' : 'wrong');
    const review = counted.map(r => ({
        partId: r.id, n: r.position + 1, ref: refOf(r.q), nodeId: r.nodeId, topic: r.topic,
        question: r.q, answer: r.answer, correct: r.right, later: r.later, group: groupOf(r),
    })).sort((a, b) => REVIEW_ORDER.indexOf(a.group) - REVIEW_ORDER.indexOf(b.group) || a.n - b.n);

    return {
        right, total, notAnswered,
        late: changedLate ? { right: counted.filter(r => r.right).length, answered: counted.filter(r => r.answer != null).length } : null,
        spread: spreadOf(right, total),
        passRight,
        passed: passRight == null ? null : right >= passRight,
        notGrade: passRight == null,
        reported: rows.length - counted.length,
        topics,
        review,
    };
}

function courseDetail(s, now) {
    const paper = paperRow(s.paper_id);
    const rows = courseRows(s);
    const exam = getExam(paper.project_id);
    return {
        sitting: sittingView(s, now),
        paper: {
            id: paper.id, uuid: paper.uuid, projectId: paper.project_id, source: 'course', title: paper.title,
            questions: rows.length, passRight: paper.pass_right ?? null,
        },
        exam,
        course: {
            questions: rows.map((r, i) => ({ partId: r.id, n: i + 1, ref: refOf(r.q), question: publicQuestion(r.q), answer: r.answer, later: r.later })),
            ...progressOf(rows),
        },
        result: s.status === 'done' ? courseResult(s, rows, paper) : null,
    };
}

/** The earlier mocks from the course, for the list: when, how long, and how it went. */
function courseSittingsOf(projectId, now) {
    return stmt(`
        SELECT s.* FROM mock_sittings s JOIN exam_papers e ON e.id = s.paper_id
        WHERE e.project_id = ? AND e.source = 'course' ORDER BY s.started_at, s.id
    `).all(projectId).map(s => {
        const rows = courseRows(s);
        const r = s.status === 'done' ? courseResult(s, rows, paperRow(s.paper_id)) : null;
        return { ...sittingView(s, now), source: 'course', questions: rows.length, answered: progressOf(rows).answered, right: r?.right ?? null, total: r?.total ?? rows.length };
    });
}

/**
 * Finish a mock from the course: written once (`recordOnce`, and a finished
 * mock writes nothing again). One 'mock' evidence row per topic with an
 * answered question: its answered questions, right or wrong, by their final
 * answers. Unanswered questions and reported ones write nothing. The answered
 * questions go to the question log, so the next draw asks the rest first.
 */
function finishCourse(id, { now, attemptId }) {
    const aid = readAttemptId(attemptId);
    if (aid === undefined) throw bad(ATTEMPT_ID_ERROR);
    recordOnce('mock', aid, () => {
        const s = requireSitting(id);
        if (s.status === 'done') return null;
        const rows = courseRows(s);
        const reported = standingReports(rows.map(r => refOf(r.q)).filter(Boolean));
        const byTopic = new Map();
        const asked = [];
        for (const r of rows) {
            if (reported.has(refOf(r.q))) continue;
            // A question left open may never have been reached: it stays
            // fresh for the next draw rather than counting as asked.
            if (r.answer == null) continue;
            asked.push({ quizId: r.quizId, index: r.questionIndex, uuid: r.q.uuid, stem: r.q.question, correct: r.right });
            if (r.nodeId == null) continue;
            const t = byTopic.get(r.nodeId) ?? { right: 0, total: 0, items: [] };
            t.total += 1;
            if (r.right) t.right += 1;
            if (typeof r.q.uuid === 'string') t.items.push({ u: r.q.uuid, c: r.right ? 1 : 0 });
            byTopic.set(r.nodeId, t);
        }
        for (const [nodeId, t] of byTopic) {
            updateMasteryFromAttempt(nodeId, t.right, t.total, 'mock', { surface: 'mock', sitting: s.uuid, items: t.items });
        }
        logAsked(asked, 'mock');
        stmt("UPDATE mock_sittings SET elapsed = ?, running_since = NULL, status = 'done', finished_at = ? WHERE id = ?")
            .run(elapsedOf(s, now), iso(now), id);
        return null;
    }, `finish:${id}`);
    return sittingDetail(id, { now });
}

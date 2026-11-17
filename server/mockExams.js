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
import { updateMasteryFromAttempt } from './mastery.js';
import { WORK_LEAF } from './today.js';

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
    const papers = stmt('SELECT * FROM exam_papers WHERE project_id = ? ORDER BY created_at, id').all(projectId).map(row => {
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
    return { papers, topics, documents };
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
        timeUp: elapsed >= s.time_allowed,
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

/** "I am done" (or the learner hands in after time up): the clock stops and marking opens. */
export function stopWriting(id, { now = Date.now() } = {}) {
    const s = requireSitting(id);
    if (s.status === 'writing') {
        stmt("UPDATE mock_sittings SET elapsed = ?, running_since = NULL, status = 'marking' WHERE id = ?").run(elapsedOf(s, now), id);
    }
    return getSitting(id, { now });
}

/** A mock not yet finished may be thrown away; a finished one is history. */
export function discardSitting(id) {
    const s = requireSitting(id);
    if (s.status === 'done') throw new MockExamError(409, 'A finished mock is kept');
    stmt('DELETE FROM mock_sittings WHERE id = ?').run(id);
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
export function finishSitting(id, { now = Date.now(), fillUnmarked = false } = {}) {
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

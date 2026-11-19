// /api/projects/:id/mock-exams, /api/mock-exams, /api/mock-sittings: past
// papers sat by hand and marked by the learner, and mocks drawn from the
// course's own questions and answered on screen (server/mockExams.js).
import {
    MockExamError, listForProject, createPaper, deletePaper, startSitting, sittingDetail,
    pauseSitting, resumeSitting, stopWriting, discardSitting, setPartScore, finishSitting,
    setExam, drawCourseMock, saveAnswer,
} from '../mockExams.js';
import { AttemptReusedError } from '../mastery.js';
import { routeTable } from './routeTable.js';
import { clientError } from '../clientError.js';

const app = routeTable('mockExams');

const idOf = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new MockExamError(400, 'Bad id');
    return n;
};

/** One shape for every handler: a MockExamError (or a reused attempt id) carries its own status. */
const handle = (fn) => (req, res) => {
    try {
        res.json(fn(req));
    } catch (err) {
        const status = err instanceof MockExamError || err instanceof AttemptReusedError ? err.status : 500;
        res.status(status).json({ error: clientError(err, status) });
    }
};

app.get('/api/projects/:projectId/mock-exams', handle(req => listForProject(idOf(req.params.projectId))));

app.post('/api/projects/:projectId/mock-exams', handle(req => ({ paper: createPaper(idOf(req.params.projectId), req.body || {}) })));

app.delete('/api/mock-exams/papers/:paperId', handle(req => { deletePaper(idOf(req.params.paperId)); return { ok: true }; }));

app.post('/api/mock-exams/papers/:paperId/sittings', handle(req => {
    const q = req.body?.question;
    const question = q == null || q === '' ? null : String(q);
    const sitting = startSitting(idOf(req.params.paperId), { question });
    return { sitting };
}));

app.get('/api/mock-sittings/:id', handle(req => sittingDetail(idOf(req.params.id))));

app.post('/api/mock-sittings/:id/pause', handle(req => ({ sitting: pauseSitting(idOf(req.params.id)) })));
app.post('/api/mock-sittings/:id/resume', handle(req => ({ sitting: resumeSitting(idOf(req.params.id)) })));
app.post('/api/mock-sittings/:id/stop', handle(req => ({ sitting: stopWriting(idOf(req.params.id)) })));

app.put('/api/mock-sittings/:id/scores', handle(req => {
    const { partId, points } = req.body || {};
    return setPartScore(idOf(req.params.id), idOf(partId), points === null ? null : points);
}));

app.post('/api/mock-sittings/:id/finish', handle(req => finishSitting(idOf(req.params.id), {
    attemptId: req.body?.attemptId ?? null, fillUnmarked: req.body?.fillUnmarked === true,
})));

// The course's real exam, described once: on paper, or on screen with its length and pass line.
app.put('/api/projects/:projectId/exam', handle(req => ({ exam: setExam(idOf(req.params.projectId), req.body || {}) })));

app.post('/api/projects/:projectId/mock-exams/draw', handle(req => {
    const { size, minutes = null } = req.body || {};
    return drawCourseMock(idOf(req.params.projectId), { size, minutes });
}));

app.put('/api/mock-sittings/:id/answers', handle(req => {
    const { partId, answer, later, attemptId = null } = req.body || {};
    return saveAnswer(idOf(req.params.id), { partId: idOf(partId), answer, later, attemptId });
}));

app.delete('/api/mock-sittings/:id', handle(req => { discardSitting(idOf(req.params.id)); return { ok: true }; }));

export const routes = app.takeRoutes();

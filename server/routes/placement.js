// /api/placement: the placement probe.
import db from '../database.js';
import * as tasks from '../tasks.js';
import {
    answerProbeQuestion, createProbe, discardProbe, finishProbe, generateProbeQuestions, getProbe,
    getProbeById, isPlacementDismissed, probeAvailability, setPlacementDismissed, summariseProbe,
} from '../placement.js';
import { attachTaskStream } from './taskStream.js';
import { routeTable } from './routeTable.js';

const app = routeTable('placement');

// GLOBAL "TODAY" HUB — cross-project aggregation

// ---- Placement probe --------------------------------------------------------
//
// "What do you already know?", asked once, before the feed starts teaching.
// The engine and its boundary live in server/placement.js; these endpoints only
// decide who may ask and what the client is allowed to see.
//
// The one rule enforced HERE rather than there: a question leaves the server
// without its answer key. Same contract as the paper loop's reference solution
// and `AnswerHelp` — the key and the explanation arrive on the way out, in the
// answer response, never with the question. A probe that shipped its own key in
// the payload would measure nothing at all, and the network tab is not a
// difficult place to look.
function publicProbeQuestion(q, index) {
    return {
        index,
        nodeId: q.node_id,
        nodeTitle: q.node_title,
        phaseTitle: q.phase_title,
        type: q.type,
        question: q.question,
        options: q.type === 'multiple_choice' ? q.options : undefined,
        verified: q.verified !== false,
    };
}

function publicProbe(probe) {
    if (!probe) return null;
    const answered = new Map(probe.answers.map(a => [a.questionIndex, a]));
    return {
        id: probe.id,
        projectId: probe.projectId,
        state: probe.state,
        error: probe.error,
        total: probe.questions.length,
        answeredCount: probe.answers.length,
        questions: probe.questions.map((q, i) => ({
            ...publicProbeQuestion(q, i),
            answered: answered.has(i),
            correct: answered.get(i)?.correct ?? null,
        })),
    };
}

app.get('/api/placement/:projectId', (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Invalid project id' });
    try {
        const availability = probeAvailability(projectId);
        const probe = getProbe(projectId);
        res.json({
            ...availability,
            dismissed: isPlacementDismissed(projectId),
            probe: publicProbe(probe),
            summary: probe && probe.state === 'done' ? summariseProbe(probe) : null,
        });
    } catch (error) {
        console.error('[Placement] status failed:', error);
        res.status(500).json({ error: error.message });
    }
});

// "Not now" on the dashboard's offer, and taking it back.
app.put('/api/placement/:projectId/dismissed', (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Invalid project id' });
    if (typeof req.body?.dismissed !== 'boolean') return res.status(400).json({ error: 'dismissed must be true or false' });
    setPlacementDismissed(projectId, req.body.dismissed);
    res.json({ dismissed: req.body.dismissed });
});

// Authoring runs as a background task for the same reason quiz generation does:
// it is a minute of model calls, and a learner who navigates away or reloads
// must come back to a probe rather than to nothing. Deduped on the project, so
// reopening the modal reattaches to the run in progress instead of starting a
// second one.
app.post('/api/placement/:projectId/start', (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Invalid project id' });
    const project = db.prepare('SELECT id, name, color FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let probe;
    try {
        const existing = getProbe(projectId);
        // A probe already generated is resumed, not rebuilt — regenerating
        // would throw away answers the learner has already given.
        probe = existing && existing.state !== 'failed' && existing.state !== 'done'
            ? existing
            : createProbe(projectId, { limit: Number(req.body?.limit) || undefined });
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    if (probe.state === 'ready') {
        return res.json({ probe: publicProbe(probe), alreadyReady: true });
    }

    const placementOrigin = { surface: 'project', detail: 'placement', projectId };
    const { task } = tasks.createTask({
        kind: 'placement',
        label: `Placement — ${project.name}`,
        labelKey: 'Placement for {{projectName}}',
        labelParams: { projectName: project.name },
        origin: placementOrigin,
        projectId,
        projectName: project.name,
        projectColor: project.color,
        dedupeKey: `placement:${projectId}`,
        run: async ({ emit, signal }) => {
            const finished = await generateProbeQuestions(probe, { emit, signal });
            return publicProbe(finished);
        },
    });
    attachTaskStream(req, res, task.id);
});

app.post('/api/placement/probe/:probeId/answer', async (req, res) => {
    const probeId = Number(req.params.probeId);
    const { questionIndex, answer } = req.body || {};
    if (!Number.isFinite(probeId) || !Number.isFinite(Number(questionIndex))) {
        return res.status(400).json({ error: 'Missing required fields: probeId, questionIndex' });
    }
    try {
        const result = await answerProbeQuestion(probeId, Number(questionIndex), answer);
        const probe = getProbeById(probeId);
        res.json({ ...result, probe: publicProbe(probe) });
    } catch (error) {
        console.error('[Placement] answer failed:', error);
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/placement/probe/:probeId/finish', (req, res) => {
    const probeId = Number(req.params.probeId);
    if (!Number.isFinite(probeId)) return res.status(400).json({ error: 'Invalid probe id' });
    try {
        const { probe, summary } = finishProbe(probeId);
        res.json({ probe: publicProbe(probe), summary });
    } catch (error) {
        console.error('[Placement] finish failed:', error);
        res.status(400).json({ error: error.message });
    }
});

// The escape hatch. A learner who disagrees with what the probe concluded must
// be able to undo all of it — otherwise taking the probe carries a risk that
// skipping it does not, and the honest move becomes the costly one.
app.delete('/api/placement/:projectId', (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Invalid project id' });
    try {
        res.json(discardProbe(projectId));
    } catch (error) {
        console.error('[Placement] discard failed:', error);
        res.status(500).json({ error: error.message });
    }
});

export const routes = app.takeRoutes();

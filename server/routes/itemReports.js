// /api/item-reports: "This is wrong" on one item (server/itemReports.js).
//
// One endpoint, two callers: the flag on the item, and the assistant's
// prepared report, which the learner's press sends here with
// `surface: 'assistant'`. Nothing is limited: a report costs the learner
// nothing and is never counted against them.
import db from '../database.js';
import * as tasks from '../tasks.js';
import {
    ReportError, fileReport, getReport, learnerFaultText, listReports, parseRef, resolveTarget,
    rewriteSource, setRewrite, undoReport,
} from '../itemReports.js';
import { generateMaterial } from '../studyMaterial.js';
import { getAISettings } from '../ai.js';
import { requestNode } from '../feedGen.js';
import { logActivity } from '../activityLog.js';
import { nodeTaskInfo, requestOrigin } from './taskStream.js';
import { routeTable } from './routeTable.js';
import { clientError } from '../clientError.js';

const app = routeTable('itemReports');

// A ReportError is a refusal written for the learner, on a 4xx: clientError
// sends it as written and turns anything else into the fixed sentence.
const fail = (res, err) => {
    const status = err instanceof ReportError ? err.status : 500;
    res.status(status).json({ error: clientError(err, status) });
};

// A new version is written by the model: a question or card now, in a task;
// a lesson or a paper exercise by the feed's generator, once its slot is
// free. With AI off or no model chosen nothing can write it, so it is neither
// offered nor started: the task would only fail, and a freed slot would leave
// a hole in the topic until a model is connected.
const modelCanWrite = () => {
    const s = getAISettings();
    return !!(s.enabled && s.model);
};
const rewriteOffered = (kind, modelWritten) => modelCanWrite()
    && (['question', 'lesson', 'paper'].includes(kind) || (kind === 'card' && modelWritten));

const positiveInt = (v) => {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// Reports standing on a topic, a project or a list of refs — the drill player
// leaves reported items out of its rounds by this, and the assistant reads it
// to know what was already reported.
app.get('/api/item-reports', (req, res) => {
    const nodeId = req.query.nodeId != null ? positiveInt(req.query.nodeId) : null;
    const projectId = req.query.projectId != null ? positiveInt(req.query.projectId) : null;
    if ((req.query.nodeId != null && !nodeId) || (req.query.projectId != null && !projectId)) {
        return res.status(400).json({ error: 'nodeId and projectId must be positive integers' });
    }
    const refs = typeof req.query.refs === 'string' && req.query.refs
        ? req.query.refs.split(',').map(s => s.trim()).filter(r => parseRef(r)).slice(0, 100)
        : null;
    if (!nodeId && !projectId && !refs?.length) return res.status(400).json({ error: 'Name a nodeId, a projectId or refs' });
    try {
        res.json({ reports: listReports({ nodeId, projectId, refs }) });
    } catch (err) {
        fail(res, err);
    }
});

// The item a ref names, as the server holds it: what the assistant's prepared
// report shows before the learner presses it, so the preview is never the
// model's own retelling of the question.
app.get('/api/item-reports/target', (req, res) => {
    const ref = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
    if (!parseRef(ref)) return res.status(400).json({ error: 'ref must name one item' });
    try {
        const target = resolveTarget(ref);
        if (!target) return res.status(404).json({ error: 'That item is not here any more.' });
        const [existing] = listReports({ refs: [target.ref], limit: 1 });
        res.json({
            ref: target.ref, kind: target.kind, nodeId: target.nodeId, projectId: target.projectId,
            item: target.item, report: existing || null,
            // What the dialog may offer before the report is filed: a new
            // version of what a model wrote, the editor for the learner's own card.
            canRewrite: rewriteOffered(target.kind, target.modelWritten),
            editable: target.kind === 'card' && !target.modelWritten,
        });
    } catch (err) {
        fail(res, err);
    }
});

// One report by its number: the assistant's prepared undo shows what it would
// take back before the learner presses it. Registered after /target, which
// is a word, never a number.
app.get('/api/item-reports/:id', (req, res) => {
    const id = positiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid report id' });
    try {
        const report = getReport(id);
        if (!report) return res.status(404).json({ error: 'No such report.' });
        res.json({ report });
    } catch (err) {
        fail(res, err);
    }
});

app.post('/api/item-reports', (req, res) => {
    try {
        const { report, existing } = fileReport(req.body || {});
        res.status(existing ? 200 : 201).json({ report, existing });
    } catch (err) {
        fail(res, err);
    }
});

app.delete('/api/item-reports/:id', (req, res) => {
    const id = positiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid report id' });
    try {
        res.json({ report: undoReport(id) });
    } catch (err) {
        fail(res, err);
    }
});

/**
 * Write a new version, through the generators every other item comes from —
 * and so through the same gates. A question becomes one new question in the
 * topic's bank; a model-written card one new card; a lesson or a paper
 * exercise is taken out of its slot, and the feed's generator writes that
 * slot again (a lesson starting from what the learner said).
 */
app.post('/api/item-reports/:id/rewrite', (req, res) => {
    const id = positiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid report id' });
    const src = rewriteSource(id);
    if (!src) return res.status(404).json({ error: 'No such report.' });
    const { report, undo } = src;
    if (report.undoneAt) return res.status(409).json({ error: 'This report was undone.' });
    if (!report.canRewrite) return res.status(400).json({ error: 'This item is not rewritten: edit it instead.' });
    const info = nodeTaskInfo(report.nodeId);
    if (!info) return res.status(404).json({ error: 'Its topic is not here any more.' });
    // Asked once: a second press while the new one is being written, or after
    // it was, answers with what is there rather than writing another.
    // `running` holds only while its task does: one cancelled from the dock or
    // cut off by a restart never writes `failed`, and must not refuse a press for ever.
    const state = report.rewrite?.state;
    if (state === 'running' && tasks.findByDedupeKey(`item-rewrite:${id}`)) return res.status(202).json({ report, taskId: report.rewrite.taskId ?? null });
    if (state === 'done') return res.json({ report });
    if (!modelCanWrite()) return res.status(409).json({ error: 'AI is off, so a new one cannot be written now.' });

    try {
        if (report.kind === 'lesson' || report.kind === 'paper') {
            if (report.rewrite?.state !== 'requested') {
                const old = undo.feedRow;
                if (old) db.prepare('DELETE FROM feed_items WHERE id = ? AND node_id = ? AND kind = ? AND seq = ?').run(old.id, old.node_id, old.kind, old.seq);
                setRewrite(id, { state: 'requested', at: new Date().toISOString() });
                logActivity({ area: 'feed', event: 'item.rewrite', detail: report.kind, projectId: info.projectId, nodeId: info.id });
            }
            requestNode(info.id);
            return res.json({ report: getReport(id) });
        }

        const card = report.kind === 'card';
        const fault = learnerFaultText(report);
        const origin = requestOrigin(req, {
            surface: 'topic', detail: card ? 'flashcards' : 'question', nodeId: info.id, projectId: info.projectId,
        });
        const { task, existing } = tasks.createTask({
            kind: card ? 'flashcards' : 'mastery_check',
            label: info.title,
            origin,
            nodeId: info.id,
            projectId: info.projectId,
            projectName: info.projectName,
            projectColor: info.projectColor,
            dedupeKey: `item-rewrite:${id}`,
            run: async ({ signal }) => {
                try {
                    const out = await generateMaterial(info.id, card ? 'flashcards' : 'mastery_check', {
                        questionCount: 1, cardCount: 1, priorFault: fault, signal,
                    });
                    setRewrite(id, { state: out.count > 0 ? 'done' : 'failed', at: new Date().toISOString(), count: out.count });
                    return out;
                } catch (err) {
                    if (!signal.aborted) setRewrite(id, { state: 'failed', at: new Date().toISOString() });
                    throw err;
                }
            },
        });
        if (!existing) {
            setRewrite(id, { state: 'running', taskId: task.id, at: new Date().toISOString() });
            logActivity({ area: 'feed', event: 'item.rewrite', detail: report.kind, projectId: info.projectId, nodeId: info.id });
        }
        res.status(202).json({ report: getReport(id), taskId: task.id });
    } catch (err) {
        fail(res, err);
    }
});

export const routes = app.takeRoutes();

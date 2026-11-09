// Mastery: per-topic state, quiz and drill evidence, the mastery check, the daily plan.
import db from '../database.js';
import {
    ATTEMPT_ID_ERROR, getNodeMasteryDetail, getProjectMasteryStats, readAttemptId, updateMasteryFromAttempt,
} from '../mastery.js';
import { recordMasteryCheck } from '../masteryCheck.js';
import { generateDailyPlan, getGhostQuestions } from '../dailyPlan.js';
import { getGateConfig } from '../settingsStore.js';
import { readAttempt } from './request.js';
import { routeTable } from './routeTable.js';
import { clientError } from '../clientError.js';

const app = routeTable('mastery');

// MASTERY ROUTES

app.get('/api/nodes/:nodeId/mastery', (req, res) => {
    // Asked first: reading a node's mastery creates its row, and a row for a
    // node that does not exist fails the foreign key.
    if (!db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(req.params.nodeId)) {
        return res.status(404).json({ error: 'Node not found' });
    }
    try {
        const gate = getGateConfig();
        const detail = getNodeMasteryDetail(req.params.nodeId, { threshold: gate.threshold, checkPass: gate.checkPass });
        res.json(detail);
    } catch (err) {
        res.status(500).json({ error: clientError(err) });
    }
});

app.get('/api/projects/:projectId/mastery', (req, res) => {
    try {
        const stats = getProjectMasteryStats(req.params.projectId);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: clientError(err) });
    }
});

app.post('/api/nodes/:nodeId/mastery/quiz', (req, res) => {
    const attempt = readAttempt(req.body);
    if (!attempt) return res.status(400).json({ error: 'score and total are required' });
    const { score, total } = attempt;
    try {
        const result = updateMasteryFromAttempt(req.params.nodeId, score, total, 'quiz');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: clientError(err) });
    }
});

// Practice-drill round. Recorded under its own `drill` evidence type:
// updateMasteryFromAttempt applies BKT for any type, so a round sharpens the
// retention estimate and refreshes the decay timer — but checkMasteryEligibility
// reads the estimate with drills and cards taken out and its raw-score clause
// honours only `quiz`/`mastery_check`/`paper`, so a drill can never clear the
// completion gate. Practice tunes the estimate; proving needs an assessment.
/**
 * Which drill on a topic a round was played on: `drillKeyOf` in
 * `src/components/drills/parseDrill.ts` (an 8-hex-digit hash of the fence) or
 * the one flashcard drill. Anything else is dropped rather than stored, so the
 * evidence row carries nothing a client made up.
 */
const DRILL_KEY = /^(?:f[0-9a-f]{8}|cards)$/;

/**
 * The round's items, `[{ k, c }]` (`drillItemKey` in parseDrill.ts: a hash of
 * the prompt and its key, or a card's id), so a reported item can be taken out
 * of the rounds it was played in (server/itemReports.js). Kept only when they
 * agree with the round's own score and total; anything else is dropped rather
 * than stored half-true.
 */
const DRILL_ITEM = /^(?:i[0-9a-f]{8}|c\d{1,12})$/;
function readDrillItems(raw, score, total) {
    if (!Array.isArray(raw) || raw.length !== total) return null;
    const items = [];
    for (const e of raw) {
        if (!e || typeof e.k !== 'string' || !DRILL_ITEM.test(e.k) || typeof e.c !== 'boolean') return null;
        items.push({ k: e.k, c: e.c ? 1 : 0 });
    }
    return items.filter(e => e.c).length === score ? items : null;
}

app.post('/api/nodes/:nodeId/mastery/drill', (req, res) => {
    const attempt = readAttempt(req.body);
    if (!attempt) return res.status(400).json({ error: 'score and total (> 0) are required' });
    const { score, total } = attempt;
    const drillKey = typeof req.body?.drillKey === 'string' && DRILL_KEY.test(req.body.drillKey) ? req.body.drillKey : null;
    const items = drillKey ? readDrillItems(req.body?.items, score, total) : null;
    try {
        const result = updateMasteryFromAttempt(req.params.nodeId, score, total, 'drill', {
            source: 'drill', ...(drillKey ? { drillKey } : {}), ...(items ? { items } : {}),
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: clientError(err) });
    }
});

/**
 * The last FULL round of each drill on a topic, keyed by drill. Read off the
 * evidence the rounds already wrote — a drill's score is not a second record
 * that could disagree with the one the topic's estimate was built from.
 */
app.get('/api/nodes/:nodeId/drill-scores', (req, res) => {
    const nodeId = Number(req.params.nodeId);
    if (!Number.isInteger(nodeId)) return res.status(400).json({ error: 'Invalid node id' });
    const rows = db.prepare(`
        SELECT json_extract(metadata, '$.drillKey') AS drill_key, score, total, created_at
        FROM mastery_evidence
        WHERE node_id = ? AND evidence_type = 'drill'
          AND json_valid(metadata) AND json_extract(metadata, '$.drillKey') IS NOT NULL
        ORDER BY id
    `).all(nodeId);
    const out = {};
    for (const r of rows) out[r.drill_key] = { correct: r.score, total: r.total, at: r.created_at };
    res.json(out);
});

// A flashcard's evidence has no endpoint: it is written on the rating path
// itself (server/cardEvidence.js), so every review surface produces it without
// having to remember to. A route taking one card's correct/total from a client
// would count only what the client chose to send, and a surface that forgot to
// call it would silently produce no evidence at all.

app.post('/api/projects/:projectId/mastery/mastery-check', (req, res) => {
    const { nodeId, questions, asked } = req.body || {};
    const attempt = readAttempt(req.body);
    if (!nodeId || !attempt) {
        return res.status(400).json({ error: 'nodeId, score, and total are required' });
    }
    const { score, total } = attempt;
    const attemptId = readAttemptId(req.body.attemptId);
    if (attemptId === undefined) return res.status(400).json({ error: ATTEMPT_ID_ERROR });
    try {
        // The write itself is server/masteryCheck.js, shared with the check an
        // agent host draws in its own window.
        const { duplicate, outcome } = recordMasteryCheck({
            nodeId, score, total, questions, asked, attemptId, review: req.body.review,
        });
        res.json(duplicate ? { ...outcome, duplicate: true } : outcome);
    } catch (err) {
        res.status(500).json({ error: clientError(err) });
    }
});

// DAILY PLAN / INTERVENTION ENGINE

app.get('/api/projects/:projectId/daily-plan', (req, res) => {
    try {
        const plan = generateDailyPlan(req.params.projectId, getGateConfig().decayDays);
        res.json(plan);
    } catch (err) {
        res.status(500).json({ error: clientError(err) });
    }
});

app.get('/api/projects/:projectId/ghost-questions', (req, res) => {
    const max = parseInt(req.query.max) || 2;
    try {
        const ghosts = getGhostQuestions(req.params.projectId, max, getGateConfig().decayDays);
        res.json(ghosts);
    } catch (err) {
        res.status(500).json({ error: clientError(err) });
    }
});

export const routes = app.takeRoutes();

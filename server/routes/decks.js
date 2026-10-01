// Deck projects: the deck view, its queue, teaching and deck settings.
import { buildDeckData, getNewPerDay, setNewPerDay, studyQueue } from '../decks.js';
import { projectTeaches, setProjectTeaches } from '../nodeRole.js';
import { requireProject } from './projectRows.js';
import { routeTable } from './routeTable.js';

const app = routeTable('decks');

// DECK (card-collection projects)
//
// A deck answers different questions from a curriculum — see server/decks.js.
// These endpoints exist only for `projects.kind = 'deck'`; nothing else in the
// API branches on kind.

app.get('/api/projects/:projectId/deck', (req, res) => {
    const { projectId } = req.params;
    try {
        const data = buildDeckData(projectId, {
            forecastDays: Math.min(60, Math.max(7, Number.parseInt(req.query.days, 10) || 14)),
        });
        if (!data) return res.status(404).json({ error: 'Project not found' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: `Failed to load deck: ${err.message}` });
    }
});

// The session queue: reviews that are actually owed, plus new cards up to the
// day's remaining allowance. Deliberately NOT `/flashcards/due`, which treats
// every never-reviewed card as due — right for a topic's handful of AI cards,
// and the reason an imported deck greeted its owner with "1,483 cards due" on
// day one.
// How far a "study ahead" session may reach into the future. Two weeks is
// enough to make an empty day studiable and short enough that the learner is
// still reviewing things they are about to need.
const MAX_AHEAD_DAYS = 14;

app.get('/api/projects/:projectId/deck/queue', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;
    try {
        const limitParam = req.query.newLimit;
        const newLimit = limitParam == null || limitParam === ''
            ? null
            : Math.max(0, Number.parseInt(limitParam, 10) || 0);
        // The stage is passed INTO the queue, never used to filter its result:
        // the day's new cards are taken in deck order, so a finished queue holds
        // only the current stage's cards and filtering it by any other stage
        // yields nothing. See studyQueue.
        const stageRaw = req.query.stage ? Number.parseInt(req.query.stage, 10) : null;
        const stageId = Number.isFinite(stageRaw) ? stageRaw : null;
        // `ahead` is a horizon in DAYS, capped: pulling a month of reviews
        // forward would hand the learner the whole deck and undo the scheduling
        // they have earned. A deliberate session, not a new default.
        const aheadRaw = req.query.ahead ? Number.parseInt(req.query.ahead, 10) : 0;
        const aheadDays = Number.isFinite(aheadRaw) ? Math.max(0, Math.min(MAX_AHEAD_DAYS, aheadRaw)) : 0;
        const { reviews, fresh, counts } = studyQueue(projectId, { newLimit, stageId, aheadDays });
        res.json({ cards: [...reviews, ...fresh], counts, reviews: reviews.length, fresh: fresh.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Turn teaching on or off for one project.
//
// Off by default for an import: somebody who brings in a 5,000-card deck wants
// to study cards tonight, and 32 background lesson plans is a surprise, not a
// feature. On for anything authored here. The switch exists because the answer
// is the learner's, not the importer's — one measured import's 32 named
// subdecks are a curriculum and were permanently untaught while `kind` decided
// this.
app.put('/api/projects/:projectId/teaching', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;
    try {
        const on = req.body?.teaches;
        const teaches = on == null
            ? projectTeaches(projectId)
            : setProjectTeaches(projectId, !(on === false || on === 'false' || on === 0 || on === '0'));
        res.json({ teaches });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/projects/:projectId/deck/settings', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;
    try {
        const newPerDay = req.body?.newPerDay != null
            ? setNewPerDay(projectId, req.body.newPerDay)
            : getNewPerDay(projectId);
        res.json({ newPerDay });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export const routes = app.takeRoutes();

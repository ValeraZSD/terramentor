// Flashcards: generation, editing, and the due lists.
//
// Mounted in 4 blocks (see createApp in server/app.js), because the server
// registers other areas' routes between them and Express matches in registration
// order. A new route goes in the block it belongs with.
import db from '../database.js';
import { generateResponse, streamResponse } from '../ai.js';
import { buildFlashcardPrompt, finalizeFlashcards } from '../studyMaterial.js';
import * as tasks from '../tasks.js';
import { globalStudyQueue, studyQueue } from '../decks.js';
import { hasAppReview, logReview, normalizeRating, undoLastReview, undoReview } from '../reviewLog.js';
import { recordCardEvidence } from '../cardEvidence.js';
import { attachTaskStream, nodeTaskInfo, requestOrigin } from './taskStream.js';
import { requireProject } from './projectRows.js';
import { routeTable } from './routeTable.js';

const app = routeTable('flashcards');

// Top-level category for each card's node, memoised per ancestor so a session
// of thousands of cards does not re-walk (and re-prepare) the same chain per
// card. Same result as the old per-card loop: the root ancestor's title + id.
const nodeParentStmt = db.prepare('SELECT id, title, parent_id FROM nodes WHERE id = ?');
function withTopCategory(cards) {
    const memo = new Map();
    const topOf = (id) => {
        if (id == null) return { categoryTitle: null, categoryId: null };
        if (memo.has(id)) return memo.get(id);
        let cur = nodeParentStmt.get(id);
        let depth = 0;
        let out = { categoryTitle: null, categoryId: null };
        while (cur && depth < 10) {
            if (cur.parent_id === null) { out = { categoryTitle: cur.title, categoryId: cur.id }; break; }
            cur = nodeParentStmt.get(cur.parent_id);
            depth++;
        }
        memo.set(id, out);
        return out;
    };
    return cards.map(card => ({ ...card, ...topOf(card.parent_id) }));
}

// AI FLASHCARDS

// The model's raw output becomes saved flashcard rows in finalizeFlashcards
// (server/studyMaterial.js), shared by the blocking and streaming endpoints.
app.post('/api/ai/flashcards', async (req, res) => {
    const { nodeId, count = 10 } = req.body;
    let aiResponse = null;
    try {
        const { system, user } = buildFlashcardPrompt(nodeId, count);
        aiResponse = await generateResponse(user, system);
        res.json(await finalizeFlashcards(nodeId, aiResponse));
    } catch (error) {
        console.error('Flashcard generation error:', error);
        res.status(500).json({
            error: error.message,
            rawResponse: aiResponse
        });
    }
});

// Streaming variant: same result as /api/ai/flashcards, but runs as a
// background task (survives the client going away; visible/cancellable in
// the global task dock) and emits the model's reasoning + running output
// length so the client can show live "Thinking… / Generating…" counts.
async function runFlashcardGeneration({ nodeId, count, emit, signal }) {
    let aiResponse = '';
    let thinkingChars = 0;
    try {
        const { system, user } = buildFlashcardPrompt(nodeId, count);
        for await (const part of streamResponse(user, system, [], { signal, temperature: 0.5, think: true })) {
            if (part && part.type === 'content' && part.content) {
                aiResponse += part.content;
                emit({ progress: aiResponse.length });
            } else if (part && part.type === 'thinking' && part.content) {
                thinkingChars += part.content.length;
                emit({ thinking: thinkingChars });
            }
        }
        return await finalizeFlashcards(nodeId, aiResponse, { signal });
    } catch (error) {
        if (signal.aborted) return { cancelled: true };
        console.error('Flashcard generation error:', error);
        if (error.rawResponse === undefined) error.rawResponse = aiResponse || null;
        throw error;
    }
}

app.post('/api/ai/flashcards/stream', (req, res) => {
    const { nodeId, count = 10 } = req.body;
    if (!nodeId) return res.status(400).json({ error: 'Missing required field: nodeId' });
    const info = nodeTaskInfo(Number(nodeId));
    if (!info) return res.status(404).json({ error: 'Node not found' });

    const cardsOrigin = requestOrigin(req, { surface: 'topic', detail: 'flashcards', nodeId: Number(nodeId), projectId: info.projectId });
    const { task } = tasks.createTask({
        kind: 'flashcards',
        label: info.title,
        origin: cardsOrigin,
        nodeId: Number(nodeId),
        projectId: info.projectId,
        projectName: info.projectName,
        projectColor: info.projectColor,
        dedupeKey: `flashcards:${nodeId}`,
        run: ({ emit, signal }) => runFlashcardGeneration({ nodeId: Number(nodeId), count, emit, signal }),
    });
    attachTaskStream(req, res, task.id);
});

export const generationRoutes = app.takeRoutes();

app.get('/api/ai/flashcards/:nodeId', (req, res) => {
    const flashcards = db.prepare('SELECT * FROM flashcards WHERE node_id = ? ORDER BY created_at').all(req.params.nodeId);
    res.json(flashcards);
});

app.put('/api/ai/flashcards/:id', (req, res) => {
    const { front, back, extra, extra_front, difficulty, last_reviewed, next_review, ease_factor, last_interval,
        stability, fsrs_difficulty, state, lapses, learning_steps, review_count, rating, undo_review, undo_of } = req.body;
    // The row as it was, for the review log: a review is "this rating, from
    // this state, after this many days" and only the pre-update row knows it.
    const before = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(req.params.id);
    if (!before) return res.status(404).json({ error: 'Flashcard not found' });
    // A rating arriving TWICE — a request retried after its answer was lost, a
    // double press that raced — carries the same `last_reviewed` stamp, and
    // every rating stamps a fresh one. The stamp already being logged for this
    // card means this review was applied: answering with the card as it
    // stands, rather than bumping review_count and writing a second review_log
    // row the FSRS optimiser would fit on as a review that never happened.
    // The LOG is asked, not only the card: after a newer review B, a late retry
    // of A no longer matches the card's stamp, and applying it would put the
    // card back on A's schedule.
    if (normalizeRating(rating) && last_reviewed != null && review_count === undefined
        && ((before.last_reviewed != null && String(before.last_reviewed) === String(last_reviewed))
            || hasAppReview(before.id, last_reviewed))) {
        return res.json(before);
    }
    // An undo names the review it takes back by the stamp that rating wrote.
    // If the card no longer holds that stamp, something rated it since (another
    // tab, another device) and restoring this snapshot would erase that newer
    // review — so nothing is written. The one exception is this same undo
    // arriving twice: the card already holds the snapshot's stamp and the
    // review is gone from the log, so the answer is the card as it stands.
    // An undo WITHOUT `undo_of` (a page cached from before this existed) keeps
    // the old behaviour below: restore, and take back the newest app review.
    if (undo_review === true && undo_of != null && String(before.last_reviewed ?? '') !== String(undo_of)) {
        if (String(before.last_reviewed ?? '') === String(last_reviewed ?? '') && !hasAppReview(before.id, undo_of)) {
            return res.json(before);
        }
        return res.status(409).json({
            error: 'This card was reviewed again after that rating, so the rating can no longer be taken back.',
            conflict: 'reviewed_since',
        });
    }
    const updates = [];
    const values = [];
    if (front !== undefined) { updates.push('front = ?'); values.push(front); }
    if (back !== undefined) { updates.push('back = ?'); values.push(back); }
    // The supporting lines under the answer (reading, example sentence, its
    // translation). Editable for the same reason front/back are: the card is
    // the learner's, and an imported one is somebody else's guess about it.
    if (extra !== undefined) { updates.push('extra = ?'); values.push(extra); }
    if (extra_front !== undefined) { updates.push('extra_front = ?'); values.push(extra_front); }
    if (difficulty !== undefined) { updates.push('difficulty = ?'); values.push(difficulty); }
    if (last_reviewed !== undefined) { updates.push('last_reviewed = ?'); values.push(last_reviewed); }
    if (next_review !== undefined) { updates.push('next_review = ?'); values.push(next_review); }
    if (ease_factor !== undefined) { updates.push('ease_factor = ?'); values.push(ease_factor); }
    if (last_interval !== undefined) { updates.push('last_interval = ?'); values.push(last_interval); }
    // FSRS-6 card state. Whitelisted like every other field — the client sends
    // what src/utils/srs.ts computed, and anything not listed here is ignored.
    if (stability !== undefined) { updates.push('stability = ?'); values.push(stability); }
    if (fsrs_difficulty !== undefined) { updates.push('fsrs_difficulty = ?'); values.push(fsrs_difficulty); }
    if (state !== undefined) { updates.push('state = ?'); values.push(state); }
    if (lapses !== undefined) { updates.push('lapses = ?'); values.push(lapses); }
    // The (re)learning ladder rung. In the whitelist for the same reason
    // `state` is: it is scheduler state the client computed, and leaving it out
    // would silently restart the ladder on the card's next rating.
    if (learning_steps !== undefined) {
        updates.push('learning_steps = ?');
        values.push(Math.max(0, Math.round(Number(learning_steps) || 0)));
    }
    if (updates.length > 0) {
        // Only an actual SRS review (which stamps last_reviewed) counts as a
        // review — editing a card's text must not inflate its review history.
        //
        // An EXPLICIT review_count wins over the implicit bump, and that is what
        // makes a review undoable: taking a rating back restores the card's
        // whole prior state, `last_reviewed` included, and re-stamping it must
        // not leave the tally one higher than before the review it just erased.
        // Both in one UPDATE is not an option — the same column twice.
        if (review_count !== undefined) {
            updates.push('review_count = ?');
            values.push(Math.max(0, Math.round(Number(review_count) || 0)));
        } else if (last_reviewed !== undefined) {
            updates.push('review_count = review_count + 1');
        }
        values.push(req.params.id);
    }
    // History. A review carries a `rating` and stamps `last_reviewed`; an undo
    // carries `undo_review` (src/utils/srs.ts puts it on every snapshot) and
    // takes its review back out of the log, because a rating that was undone
    // must not be fitted on as if it happened. A plain edit carries neither
    // and touches nothing here.
    //
    // The card row and its history are ONE write: with the log insert failing
    // on its own, the card had already moved to the new schedule with no review
    // behind it, and the retry was then answered as a duplicate — the missing
    // history never came back.
    const reviewRating = normalizeRating(rating);
    const isReview = !!reviewRating && last_reviewed !== undefined;
    db.transaction(() => {
        if (updates.length > 0) {
            db.prepare(`UPDATE flashcards SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        }
        if (isReview) {
            const at = last_reviewed ? new Date(last_reviewed) : new Date();
            logReview({
                before, rating: reviewRating,
                after: { stability, fsrs_difficulty },
                now: Number.isNaN(at.getTime()) ? new Date() : at,
            });
        } else if (undo_review === true) {
            if (undo_of != null) undoReview(before.id, undo_of);
            else undoLastReview(before.id);
        }
    })();
    if (isReview) {
        // …and tell the LEARNER MODEL, which for the app's whole life this
        // wrote nothing to: a batch of ratings is one observation about the
        // topic the cards hang off (server/cardEvidence.js). Never fatal — a
        // rating that was taken is a rating that stands, whatever the estimate
        // does with it.
        try {
            recordCardEvidence(before.id);
        } catch (err) {
            console.error('[cards] mastery evidence failed:', err.message);
        }
    }
    const flashcard = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(req.params.id);
    res.json(flashcard);
});

app.delete('/api/ai/flashcards/:id', (req, res) => {
    db.prepare('DELETE FROM flashcards WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

export const cardRoutes = app.takeRoutes();

// PROJECT-LEVEL FLASHCARD ENDPOINTS

app.get('/api/projects/:projectId/flashcards', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;

    try {
        const flashcards = db.prepare(`
            SELECT f.*,
                n.title as node_title,
                n.parent_id
            FROM flashcards f
            JOIN nodes n ON n.id = f.node_id
            WHERE n.project_id = ?
            ORDER BY n.position, f.created_at
        `).all(projectId);

        const enriched = flashcards.map(card => {
            let categoryTitle = null;
            let categoryId = null;
            let currentId = card.parent_id;
            let depth = 0;
            while (currentId && depth < 10) {
                const parent = db.prepare('SELECT id, title, parent_id FROM nodes WHERE id = ?').get(currentId);
                if (!parent) break;
                if (parent.parent_id === null) {
                    categoryTitle = parent.title;
                    categoryId = parent.id;
                    break;
                }
                currentId = parent.parent_id;
                depth++;
            }
            return { ...card, categoryTitle, categoryId };
        });

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/projects/:projectId/flashcards/due', (req, res) => {
    const { projectId } = req.params;
    if (!requireProject(req, res)) return;

    try {
        // The session this serves is the same session the project's own screen
        // opens, so it comes from the same queue: reviews that are OWED, then
        // the day's remaining allowance of new cards. Counting `next_review IS
        // NULL` as due would hand a fresh curriculum project 615 cards — every
        // card it has, never seen — the moment its Review button is pressed.
        // See server/decks.js.
        const { reviews, fresh } = studyQueue(projectId);
        const enriched = withTopCategory([...reviews, ...fresh]);

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export const projectCardRoutes = app.takeRoutes();

// Due flashcards across every active project — feeds the global review session.
// Same shape as the per-project /flashcards/due, enriched with project identity
// so a mixed-project queue can badge each card.
app.get('/api/flashcards/due', (req, res) => {
    try {
        // Every project introduces its new cards through the same rationed
        // queue (server/decks.js). Counting never-seen cards as "due" here
        // handed the cross-project session 11,886 unseen cards in an 11 MB
        // payload on the real library — the "1,483 due" bug at library scale.
        // That was fixed for imports and left standing for everything else,
        // which is how the same card ended up rationed on one screen and dumped
        // in a pile on another.
        const { reviews, fresh } = globalStudyQueue();
        const enriched = withTopCategory([...reviews, ...fresh]);

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export const dueRoutes = app.takeRoutes();

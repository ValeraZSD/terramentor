// /api/paper: paper practice, graded from a photo or by the learner.
import db from '../database.js';
import { consumeFeedItem } from '../feed.js';
import { decidePaperVision, gradePaperAttempt, recordSelfGrade } from '../paper.js';
import multer from 'multer';
import vaultStorage from '../vaultStorage.js';
import { rejectOversizedBody } from '../uploadGuard.js';
import { routeTable } from './routeTable.js';

const app = routeTable('paper');

// PAPER PRACTICE — work it by hand, photograph it, get it marked (server/paper.js).
//
// The photo arrives already perspective-corrected and contrast-boosted by the
// client (src/utils/scan/), which is why the cap here is small: a warped,
// downscaled page is a couple of hundred KB, and anything far above that means
// the client pipeline was bypassed. Keeping the processing client-side also
// keeps the slow leg short — this app is used on a phone over Tailscale, and
// uploading a 4 MB original to warp it server-side would spend the whole
// latency budget on bytes we are about to throw away.
const PAPER_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const paperUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PAPER_IMAGE_MAX_BYTES, files: 1 },
});

/** Load a practice feed_item and its authored exercise, or null. */
function loadPracticeItem(feedItemId) {
    const row = db.prepare(`SELECT * FROM feed_items WHERE id = ? AND kind = 'practice'`).get(feedItemId);
    if (!row) return null;
    let exercise = null;
    try { exercise = JSON.parse(row.content); } catch { return null; }
    if (!exercise || !Array.isArray(exercise.rubric)) return null;
    return { row, exercise };
}

/**
 * What a practice card already marked answers a second submit with: its last
 * attempt, flagged a duplicate. A retry after a lost response (or a double
 * press) gets the grade it already has instead of a second piece of evidence.
 */
function storedPaperResult(feedItemId) {
    const a = db.prepare(`
        SELECT id, image_hash, transcription, grade, score, total, graded_by
        FROM paper_attempts WHERE feed_item_id = ? ORDER BY id DESC LIMIT 1
    `).get(feedItemId);
    if (!a) return { status: 'error', error: 'This exercise was already marked.' };
    let grade = null;
    try { grade = a.grade ? JSON.parse(a.grade) : null; } catch { /* a self-mark has no rubric verdicts */ }
    return {
        status: 'graded', duplicate: true, attemptId: a.id, imageHash: a.image_hash, transcription: a.transcription,
        grade, score: a.score, total: a.total, selfGraded: a.graded_by === 'self', mastery: null,
    };
}

// Is a trustworthy vision model available? The card asks before showing a camera
// button, so the learner is never invited to photograph work that cannot be
// marked — they get the self-marking flow up front instead.
app.get('/api/paper/capability', async (_req, res) => {
    try {
        const { use, model } = await decidePaperVision();
        res.json({ vision: use === 'yes', model: use === 'yes' ? model : null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// The worked solution. Served ONLY on demand — never bundled with the exercise
// card, which would put the answer key in the page payload before the learner
// has picked up a pen.
app.get('/api/paper/:feedItemId/solution', (req, res) => {
    try {
        const item = loadPracticeItem(parseInt(req.params.feedItemId, 10));
        if (!item) return res.status(404).json({ error: 'Practice item not found' });
        res.json({
            referenceSolution: item.exercise.reference_solution || '',
            rubric: item.exercise.rubric,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Submit a photographed attempt for marking.
app.post('/api/paper/:feedItemId/grade', rejectOversizedBody(12 * 1024 * 1024), paperUpload.single('image'), async (req, res) => {
    try {
        const feedItemId = parseInt(req.params.feedItemId, 10);
        const item = loadPracticeItem(feedItemId);
        if (!item) return res.status(404).json({ error: 'Practice item not found' });
        // Already marked: no second model call and no second piece of evidence.
        if (item.row.status !== 'ready') return res.json(storedPaperResult(feedItemId));
        if (!req.file?.buffer?.length) return res.status(400).json({ error: 'No image uploaded' });

        // Only a real grade consumes the card. An unreadable photo or a model
        // failure must leave the exercise standing so the learner can retake it —
        // they did the work, and losing the card over a lighting problem would
        // mean doing it again from scratch. The consume is the grade's CLAIM,
        // written in one transaction with the attempt and its evidence.
        const result = await gradePaperAttempt({
            nodeId: item.row.node_id,
            feedItemId,
            exercise: item.exercise,
            imageBuffer: req.file.buffer,
            claim: (grade) => !consumeFeedItem({
                key: `fi-${feedItemId}`, kind: 'practice', feedItemId,
                nodeId: item.row.node_id,
                result: { score: grade.score, total: grade.total },
            }).duplicate,
        });
        res.json(result.status === 'duplicate' ? storedPaperResult(feedItemId) : result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Self-marked attempt (no vision model, or the learner chose to mark their own).
app.post('/api/paper/:feedItemId/self-grade', (req, res) => {
    try {
        const feedItemId = parseInt(req.params.feedItemId, 10);
        const item = loadPracticeItem(feedItemId);
        if (!item) return res.status(404).json({ error: 'Practice item not found' });

        const { metCount } = req.body || {};
        if (!Number.isInteger(metCount) || metCount < 0 || metCount > item.exercise.rubric.length) {
            return res.status(400).json({ error: `metCount must be an integer between 0 and ${item.exercise.rubric.length}` });
        }

        // One mark per exercise, written as one unit: the card's status is read
        // inside the transaction, so a double press or a retry after a lost
        // response gets the first mark back and records nothing.
        const result = db.transaction(() => {
            const status = db.prepare('SELECT status FROM feed_items WHERE id = ?').get(feedItemId)?.status;
            if (status !== 'ready') return storedPaperResult(feedItemId);
            const graded = recordSelfGrade({
                nodeId: item.row.node_id,
                feedItemId,
                exercise: item.exercise,
                metCount,
            });
            consumeFeedItem({
                key: `fi-${feedItemId}`, kind: 'practice', feedItemId,
                nodeId: item.row.node_id,
                result: { score: graded.score, total: graded.total, selfGraded: true },
            });
            return graded;
        })();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// The stored (processed) image of a past attempt — lets a learner look back at
// what the model actually saw when a grade seems wrong.
app.get('/api/paper/attempts/:id/image', (req, res) => {
    try {
        const row = db.prepare('SELECT image_hash FROM paper_attempts WHERE id = ?').get(parseInt(req.params.id, 10));
        if (!row?.image_hash) return res.status(404).json({ error: 'No image stored for this attempt' });
        res.type('image/jpeg').sendFile(vaultStorage.pathFor(row.image_hash));
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

export const routes = app.takeRoutes();

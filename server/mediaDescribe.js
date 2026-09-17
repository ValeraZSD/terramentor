// server/mediaDescribe.js — what is IN the picture, in words.
//
// An imported deck can carry thousands of images, and until they are described
// they are invisible to two readers who matter:
//
//   * **the tutor**, which is handed a node's context as text. A card whose
//     question is a photograph reads to the model as a card with an empty
//     question, so "explain this card to me" gets an answer about nothing.
//   * **a screen reader**, which gets the deck author's `alt` when there was one
//     and the filename when there was not.
//
// One description serves both, which is the argument for storing it on the FILE
// rather than generating it into a prompt: it is written once, per file (not per
// card — a picture used by forty cards is described once), and it is a fact
// about the library from then on.
//
// ## Three rules this inherits rather than reinvents
//
// 1. **A human's words beat a model's.** A deck author's `alt` text is stored as
//    the description at import time and is never overwritten by a generated one.
//    `described_by` records which it was, so the difference stays visible.
// 2. **Vision must be VERIFIED, not assumed** — `decidePaperVision` is reused
//    verbatim. A text-only model behind an OpenAI-compatible endpoint does not
//    refuse an image, it invents one, and an invented description is worse than
//    none: it would be read out to a blind learner and fed to the tutor as fact.
// 3. **An unreachable model leaves the work pending, never done.** A failure
//    writes nothing at all, so the next run retries it — the same shape as the
//    empty-hash rule in nodeEmbeddings.js and the opposite of the vision probe
//    that once cached its own failure as a definitive answer.
//
// It runs on its own serial chain, like embeddings.js and feedGen — not the
// tasks FIFO. A local vision model is single-slot, and a sweep of 1,400 images
// must never sit in front of the learner's chat turn.

import db from './database.js';
import { mediaStorage } from './vaultStorage.js';
import { transcribeImageToText, aiProvenance } from './ai.js';
import { decidePaperVision } from './paper.js';
import * as tasks from './tasks.js';

/** Kept short on purpose: this is read aloud and pasted into prompts. */
const DESCRIBE_PROMPT = `Describe this image in one or two plain sentences, for someone who cannot see it.

Rules:
- Say what is actually visible. Do not guess at what it is "for" or what lesson it belongs to.
- If it contains text, quote the text exactly — that is usually the most important thing in it.
- No preamble ("This image shows..."), no markdown, no bullet points. Just the description.
- If the image is blank, corrupt, or you cannot make anything out, reply with exactly: UNREADABLE`;

const MAX_DESCRIPTION = 600;

/** Rows still worth describing: images, no description yet. */
export function pendingDescriptions(projectId = null) {
    const where = projectId
        ? `WHERE kind = ? AND (description IS NULL OR description = '') AND project_id = ?`
        : `WHERE kind = ? AND (description IS NULL OR description = '')`;
    const args = projectId ? ['image', projectId] : ['image'];
    return db.prepare(`SELECT hash, filename, mime FROM media_files ${where} ORDER BY id`).all(...args);
}

export function describeStats(projectId = null) {
    const clause = projectId ? 'WHERE project_id = ?' : '';
    const args = projectId ? [projectId] : [];
    const row = db.prepare(`
        SELECT
            SUM(kind = 'image') AS images,
            SUM(kind = 'image' AND description IS NOT NULL AND description != '') AS described,
            SUM(kind = 'image' AND described_by = 'author') AS byAuthor,
            SUM(kind = 'image' AND described_by = 'vision') AS byVision
        FROM media_files ${clause}
    `).get(...args);
    return {
        images: row?.images ?? 0,
        described: row?.described ?? 0,
        byAuthor: row?.byAuthor ?? 0,
        byVision: row?.byVision ?? 0,
        pending: (row?.images ?? 0) - (row?.described ?? 0),
    };
}

/**
 * Describe ONE image. Returns `{ ok, description, reason }`.
 *
 * `force` re-describes something that already has a description — only ever a
 * deliberate act, and it still refuses to overwrite an author's own alt text
 * unless that is what was asked for.
 */
export async function describeMedia(hash, { force = false, model, signal } = {}) {
    const row = db.prepare('SELECT hash, kind, mime, filename, description, described_by FROM media_files WHERE hash = ? LIMIT 1').get(hash);
    if (!row) return { ok: false, reason: 'no such media' };
    if (row.kind !== 'image') return { ok: false, reason: 'only images can be described' };
    if (row.description && !force) return { ok: true, description: row.description, reason: 'already described' };

    let bytes;
    try {
        bytes = mediaStorage.readBuffer(hash);
    } catch {
        return { ok: false, reason: 'the file is missing from the media store' };
    }

    let text;
    try {
        text = await transcribeImageToText(bytes, {
            prompt: DESCRIBE_PROMPT,
            mime: row.mime,
            model,
            timeout: 90_000,
            signal,
        });
    } catch (err) {
        // Nothing is written. An unreachable model must leave this pending so
        // the next run picks it up — recording a failure as a description is
        // how a library ends up permanently "done" and permanently wrong.
        return { ok: false, reason: err.message || 'the vision model did not answer' };
    }

    const clean = String(text || '').trim().replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION);
    if (!clean || /^unreadable$/i.test(clean)) {
        return { ok: false, reason: 'the model could not make out this image' };
    }

    // `described_by` stays the mechanism the stats query counts; `generated_by`
    // names the model, which is the part a blind learner's screen reader and the
    // tutor are both quoting downstream.
    db.prepare('UPDATE media_files SET description = ?, described_by = ?, generated_by = ? WHERE hash = ?')
        .run(clean, 'vision', aiProvenance(), hash);
    return { ok: true, description: clean };
}

// ---- the sweep --------------------------------------------------------------

let chain = Promise.resolve();
let running = null;          // { projectId, total, done, failed, cancel }

export function describeProgress() {
    if (!running) return { running: false };
    const { projectId, total, done, failed } = running;
    return { running: true, projectId, total, done, failed };
}

export function cancelDescribeSweep() {
    if (running) running.cancel = true;
}

/**
 * Describe every undescribed image in a project (or the whole library).
 *
 * Serial, cancellable, and it stops after `MAX_CONSECUTIVE_FAILURES` — the same
 * rule `quiz-audit` learned: an unreachable model produces an unbroken run of
 * failures, and grinding through 1,400 of them to report "0 described" wastes
 * an hour to say something the third failure already knew.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export async function startDescribeSweep(projectId = null) {
    if (running) return { started: false, reason: 'already running' };

    const pending = pendingDescriptions(projectId);
    if (!pending.length) return { started: false, reason: 'nothing to describe' };

    // Checked BEFORE reporting "started", not inside the chain. For anyone
    // running a text-only model this is the ordinary outcome, not an edge case,
    // and a sweep that claims to have started and then dies silently sends them
    // looking for a progress bar that will never move.
    const { use, model } = await decidePaperVision();
    if (use !== 'yes') {
        return {
            started: false,
            reason: 'No verified vision model is available. Set one under Settings → AI & Models → PDF math recovery, which this shares.',
        };
    }

    running = { projectId, total: pending.length, done: 0, failed: 0, cancel: false };
    const handle = tasks.registerExternal({
        kind: 'media_describe',
        label: `Describing ${pending.length} image${pending.length === 1 ? '' : 's'}`,
        projectId,
        cancel: () => cancelDescribeSweep(),
    });

    chain = chain.then(async () => {
        let consecutive = 0;
        for (const item of pending) {
            if (running?.cancel) break;
            const res = await describeMedia(item.hash, { model });
            if (res.ok) { running.done++; consecutive = 0; }
            else { running.failed++; consecutive++; }
            const pct = Math.round(((running.done + running.failed) / running.total) * 100);
            handle.update({ progress: pct, percent: pct, message: `${running.done} described, ${running.failed} failed` });
            if (consecutive >= MAX_CONSECUTIVE_FAILURES) break;
            // Yield: better-sqlite3 is synchronous and this process serves SSE.
            await new Promise(r => setImmediate(r));
        }
        handle.finish();
        running = null;
    }).catch(err => {
        console.warn('[Media] describe sweep failed:', err.message);
        try { handle.fail(err.message); } catch { }
        running = null;
    });

    return { started: true, total: pending.length };
}

// The tutor's view of a card's media lives in `mediaContext.js` — it reads the
// database and nothing else, and keeping it out of this file is what stops
// `ai.js` (which needs it) from importing a module that imports `ai.js` back.
// Its consumers import it from there directly; this file deliberately does not
// re-export it.

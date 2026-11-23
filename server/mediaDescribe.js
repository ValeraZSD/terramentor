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
//    empty-hash rule in nodeEmbeddings.js, and never a cached failure taken for
//    a definitive answer.
//
// It runs on its own serial chain, like embeddings.js and feedGen — not the
// tasks FIFO. A local vision model is single-slot, and a sweep of thousands of images
// must never sit in front of the learner's chat turn.

import db from './database.js';
import { mediaStorage } from './vaultStorage.js';
import { transcribeImageToText, aiProvenance, withAnswerScope } from './ai.js';
import { decidePaperVision } from './paper.js';
import * as tasks from './tasks.js';
import { catalogLanguage } from './creationLanguage.js';
import { checkDescription, descriptionLanguage } from './descriptionCheck.js';
import { k, publicMessage } from './clientError.js';

/** Kept short on purpose: this is read aloud and pasted into prompts. */
const DESCRIBE_PROMPT = `Describe this image in one or two plain sentences, for someone who cannot see it.

Rules:
- Say what is actually visible. Do not guess at what it is "for" or what lesson it belongs to.
- If it contains text, quote the text exactly — that is usually the most important thing in it.
- No preamble ("This image shows..."), no markdown, no bullet points. Just the description.
- If the image is blank, corrupt, or you cannot make anything out, reply with exactly: UNREADABLE`;

/**
 * The prompt, told which language to write in when one is known. A card's text
 * carries its course's `lang`, and a screen reader picks its voice from it, so
 * a description in another language is read out in the wrong voice.
 */
export function describePrompt(language) {
    const name = catalogLanguage(language)?.name;
    return name
        ? `${DESCRIBE_PROMPT}\n- Write the description in ${name}. Text in the image is still quoted exactly as written, in its own language.`
        : DESCRIBE_PROMPT;
}

/**
 * The language a picture's description is written in: the declared language
 * of the course it was imported into. A picture in two courses takes the one
 * being swept (`projectId`), else its first row, as the review list does.
 * '' when that course declares none, which keeps the prompt as it was and
 * skips the language check: a deck that never said its language is not
 * second-guessed from the interface language.
 */
let languageStmt = null;
export function describeLanguageFor(hash, projectId = null) {
    // Prepared once: the sweep asks this for every picture.
    languageStmt ??= db.prepare(`SELECT p.content_language AS lang FROM media_files m
        LEFT JOIN live_projects p ON p.id = m.project_id
        WHERE m.hash = ? ORDER BY (m.project_id = ?) DESC, m.id LIMIT 1`);
    return descriptionLanguage(languageStmt.get(hash, projectId)?.lang);
}

const MAX_DESCRIPTION = 600;

/**
 * Pictures whose last model answer the gate refused, this process: the sweep
 * asks them after the rest. In memory on purpose: a restart (a new model, a
 * fixed language) gives each a fresh first place, and nothing is stored about
 * an answer that was never stored. The value is when it was last refused (a
 * counter, not a clock), so the sweep retries the one refused longest ago first.
 */
const refusedBefore = new Map();
let refusalSeq = 0;

/** Who wrote a description: 'author' (the deck's alt), 'learner' (an edit here), 'vision' (a model). */
const HUMAN_SOURCES = new Set(['author', 'learner']);

/** Strip what a screen reader would read out as noise, and bound the length. */
export function cleanDescription(value) {
    const text = String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        // Zero-width and direction marks: invisible, and read out or reorder text.
        .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u061C]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    // By characters, so the cut never splits an emoji into half a pair.
    return [...text].slice(0, MAX_DESCRIPTION).join('').trim();
}

/**
 * The learner's own description of a picture, written over whatever was there.
 * It is theirs from then on: `described_by = 'learner'`, no model named, and
 * no sweep or forced re-run replaces it. An empty text clears the description,
 * which hands the picture back to the sweep.
 */
export function setLearnerDescription(hash, value) {
    const exists = db.prepare(`SELECT 1 FROM media_files WHERE hash = ? AND kind = 'image' LIMIT 1`).get(hash);
    if (!exists) return { ok: false, reason: k('no such picture') };
    const clean = cleanDescription(value);
    if (!clean) {
        db.prepare('UPDATE media_files SET description = NULL, described_by = NULL, generated_by = NULL WHERE hash = ?').run(hash);
        return { ok: true, description: null, described_by: null };
    }
    db.prepare(`UPDATE media_files SET description = ?, described_by = 'learner', generated_by = NULL WHERE hash = ?`).run(clean, hash);
    return { ok: true, description: clean, described_by: 'learner' };
}

/**
 * Pictures with their descriptions, one row per file, for the review list:
 * model-written ones first, since those are the ones to check.
 *
 * Each row carries `cursor`, its place in that order; the next page asks for
 * the rows `after` the last one shown. Not an offset: a description the
 * learner corrects moves from the model-written rows to the end, and every row
 * behind it would move up one, past an offset, and never be shown.
 */
export function listDescriptions({ projectId = null, offset = 0, limit = 50, after = null } = {}) {
    // One whole ROW per file (its first), never columns mixed from several:
    // a file used by two projects has a row each, and an author's text must
    // not be shown under another row's "written by AI".
    const where = projectId ? `WHERE kind = 'image' AND project_id = ?` : `WHERE kind = 'image'`;
    const args = projectId ? [projectId] : [];
    const at = /^([01])\.([01])\.(\d+)$/.exec(String(after ?? ''));
    const past = at ? 'WHERE v < ? OR (v = ? AND (e < ? OR (e = ? AND id > ?)))' : '';
    const pastArgs = at ? [+at[1], +at[1], +at[2], +at[2], +at[3]] : [];
    return listDescriptionsStmt(where, past).all(
        ...args, ...pastArgs, Math.max(1, Math.min(200, limit | 0)), at ? 0 : Math.max(0, offset | 0),
    ).map(({ v, e, id, ...row }) => ({ ...row, cursor: `${v}.${e}.${id}` }));
}

const listStatements = new Map();
function listDescriptionsStmt(where, past) {
    const key = `${where}|${past}`;
    if (!listStatements.has(key)) {
        listStatements.set(key, db.prepare(`
            SELECT * FROM (
                SELECT id, hash, filename, description, described_by, generated_by,
                       (described_by IS 'vision') AS v, (description IS NULL) AS e
                FROM media_files
                WHERE id IN (SELECT MIN(id) FROM media_files ${where} GROUP BY hash)
            ) ${past}
            ORDER BY v DESC, e DESC, id
            LIMIT ? OFFSET ?
        `));
    }
    return listStatements.get(key);
}

/** Rows still worth describing: images, no description yet. */
export function pendingDescriptions(projectId = null) {
    // One row per FILE (its first, as in `listDescriptions`): a picture imported
    // into two projects has a row each, and a description is written to the file,
    // so the second row would only come back as "already described".
    const where = projectId ? `WHERE kind = ? AND project_id = ?` : `WHERE kind = ?`;
    const args = projectId ? ['image', projectId] : ['image'];
    return db.prepare(`
        SELECT hash, filename, mime FROM media_files
        WHERE id IN (SELECT MIN(id) FROM media_files ${where} GROUP BY hash)
          AND (description IS NULL OR description = '')
        ORDER BY id
    `).all(...args);
}

export function describeStats(projectId = null) {
    // Counted per file, like the review list, not per row.
    const clause = projectId ? 'WHERE project_id = ?' : '';
    const args = projectId ? [projectId] : [];
    const row = db.prepare(`
        SELECT
            SUM(kind = 'image') AS images,
            SUM(kind = 'image' AND description IS NOT NULL AND description != '') AS described,
            SUM(kind = 'image' AND described_by = 'author') AS byAuthor,
            SUM(kind = 'image' AND described_by = 'vision') AS byVision,
            SUM(kind = 'image' AND described_by = 'learner') AS byLearner
        FROM media_files
        WHERE id IN (SELECT MIN(id) FROM media_files ${clause} GROUP BY hash)
    `).get(...args);
    return {
        images: row?.images ?? 0,
        described: row?.described ?? 0,
        byAuthor: row?.byAuthor ?? 0,
        byVision: row?.byVision ?? 0,
        byLearner: row?.byLearner ?? 0,
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
export async function describeMedia(hash, { force = false, model, signal, projectId = null } = {}) {
    const row = db.prepare('SELECT hash, kind, mime, filename, description, described_by FROM media_files WHERE hash = ? LIMIT 1').get(hash);
    if (!row) return { ok: false, reason: k('no such media') };
    if (row.kind !== 'image') return { ok: false, reason: k('only images can be described') };
    // A person's words (the deck author's alt, or the learner's correction)
    // stay, even on a forced re-run: a model never overwrites them.
    if (row.description && (!force || HUMAN_SOURCES.has(row.described_by))) {
        return { ok: true, description: row.description, reason: 'already described' };
    }

    let bytes;
    try {
        bytes = mediaStorage.readBuffer(hash);
    } catch {
        return { ok: false, reason: k('the file is missing from the media store') };
    }

    const language = describeLanguageFor(hash, projectId);
    let text;
    try {
        text = await transcribeImageToText(bytes, {
            prompt: describePrompt(language),
            mime: row.mime,
            model,
            timeout: 90_000,
            signal,
        });
    } catch (err) {
        // Nothing is written. An unreachable model must leave this pending so
        // the next run picks it up — recording a failure as a description is
        // how a library ends up permanently "done" and permanently wrong.
        // The route sends this to the learner: no path, endpoint or provider body.
        return { ok: false, reason: err?.message ? publicMessage(err) : k('the vision model did not answer') };
    }

    // The same cleaning a learner's edit gets: this is read aloud and pasted into
    // prompts, so control and direction marks go, and the cut is by characters.
    const cleaned = cleanDescription(text);
    if (!cleaned || /^unreadable$/i.test(cleaned)) {
        return { ok: false, reason: k('the model could not make out this image') };
    }
    // Then the gate (descriptionCheck.js): a refusal, a description of nothing
    // or one in the wrong language is not stored, and the picture stays pending.
    const verdict = checkDescription(cleaned, { language });
    if (!verdict.ok) {
        refusedBefore.set(hash, ++refusalSeq);
        return { ok: false, reason: verdict.reason, messageKey: verdict.messageKey, refused: verdict.code };
    }
    refusedBefore.delete(hash);
    const clean = verdict.text;

    // `described_by` stays the mechanism the stats query counts; `generated_by`
    // names the model, which is the part a blind learner's screen reader and the
    // tutor are both quoting downstream.
    // The model took up to 90 s; a person may have written a description in
    // that time. Their text wins, so the write only lands where none stands.
    const wrote = db.prepare(`UPDATE media_files SET description = ?, described_by = ?, generated_by = ?
        WHERE hash = ? AND (description IS NULL OR description = '' OR described_by = 'vision')`)
        .run(clean, 'vision', aiProvenance({ job: 'vision' }), hash);
    if (wrote.changes === 0) {
        // The text that won, not the one read before the model was asked.
        const now = db.prepare('SELECT description FROM media_files WHERE hash = ? LIMIT 1').get(hash);
        return { ok: true, description: now?.description ?? null, reason: 'already described' };
    }
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
 * Serial, cancellable, and it stops after `MAX_CONSECUTIVE_FAILURES`: an
 * unreachable model produces an unbroken run of failures, and grinding through
 * thousands of them to report "0 described" wastes an hour to say something
 * the third failure already knew.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * The pictures a sweep asks for, in order. Those whose last answer the gate
 * refused go last, the one refused longest ago first: they stay pending, and
 * in id order the same first three would be asked again on every run and stop
 * it (three failures in a row) before any other picture was tried.
 */
export function sweepOrder(projectId = null) {
    const all = pendingDescriptions(projectId);
    const refused = all.filter(p => refusedBefore.has(p.hash))
        .sort((a, b) => refusedBefore.get(a.hash) - refusedBefore.get(b.hash));
    return [...all.filter(p => !refusedBefore.has(p.hash)), ...refused];
}

export async function startDescribeSweep(projectId = null) {
    if (running) return { started: false, reason: 'already running' };

    const pending = sweepOrder(projectId);
    if (!pending.length) return { started: false, reason: 'nothing to describe' };

    // Checked BEFORE reporting "started", not inside the chain. For anyone
    // running a text-only model this is the ordinary outcome, not an edge case,
    // and a sweep that claims to have started and then dies silently sends them
    // looking for a progress bar that will never move.
    //
    // `running` is taken BEFORE that await: a second press (or a second tab)
    // landing while the first waits would otherwise pass the check above too,
    // register a second task, and replace the first one's progress object, so
    // the first chain to finish left the other running on null.
    running = { projectId, total: pending.length, done: 0, failed: 0, cancel: false };
    let vision;
    try {
        vision = await decidePaperVision();
    } catch (err) {
        running = null;
        throw err;
    }
    const { use, model } = vision;
    if (use !== 'yes') {
        running = null;
        return {
            started: false,
            reason: 'No verified vision model is available. Set one under Settings → AI & Models → PDF math recovery, which this shares.',
        };
    }

    const handle = tasks.registerExternal({
        kind: 'media_describe',
        label: `Describing ${pending.length} image${pending.length === 1 ? '' : 's'}`,
        labelKey: 'Describing {{count}} images',
        labelParams: { count: pending.length },
        // The sweep is started from Settings → AI & Models.
        origin: { surface: 'settings', detail: 'ai' },
        projectId,
        cancel: () => cancelDescribeSweep(),
    });

    chain = chain.then(async () => {
        let consecutive = 0;
        for (const item of pending) {
            if (running?.cancel) break;
            // Its own record of who answered: the row it writes names the
            // model that read THIS picture (ai.js `withAnswerScope`).
            const res = await withAnswerScope(() => describeMedia(item.hash, { model, projectId }));
            if (res.ok) { running.done++; consecutive = 0; }
            else { running.failed++; consecutive++; }
            const pct = Math.round(((running.done + running.failed) / running.total) * 100);
            // Refusals count toward the stop like any failure: a model that keeps
            // answering in English for a Dutch course would otherwise be asked
            // (and paid) for every picture to store nothing. The stop says why.
            const stop = consecutive >= MAX_CONSECUTIVE_FAILURES;
            const message = `${running.done} described, ${running.failed} failed`;
            handle.update({ progress: pct, percent: pct, message: stop && res.reason ? `${message}. Stopped: ${res.reason}` : message });
            if (stop) break;
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

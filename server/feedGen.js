import db from './database.js';
import { generateResponse, getAISettings, AI_PROMPTS, buildNodeContext, aiProvenanceFields } from './ai.js';
import { parseObjectResponse } from './agentic.js';
import { getFocusNodes, normalizeFeedQuestion, getFeedSettings, safeParse } from './feed.js';
import { codeLanguageIn, countsProcedure } from './answerFormats.js';
import { compileWidget, getCachedBuild, specHashOf, extractWidgetSpecs } from './widgets.js';
import { generatePaperExercise } from './paper.js';
import {
    lessonDefects, questionDefects, questionWeaknesses, stripSelfCertifyingCloser,
    vetLessonVisuals, verifyQuestion, auditLessonMath, MAX_ELIMINABLE_OPTIONS,
} from './feedQuality.js';
import { getNodeLanguage } from './language.js';
import { nodeIsTeachable } from './nodeRole.js';
import { isUnavailable } from './embeddings.js';
import * as tasks from './tasks.js';

/**
 * Background generator for the learning feed's teaching cache (feed_items).
 *
 * Architecture mirrors the embeddings indexer (server/embeddings.js), NOT the
 * tasks.js FIFO queue: generation runs on its own serial promise chain so a
 * long pre-generation burst can never block an interactive chat turn in the
 * queue. It still shows up in the TaskDock via tasks.registerExternal, and it
 * YIELDS to interactive work — before every model call it checks whether any
 * non-feed task is running or queued and, if so, ends the burst and re-kicks
 * itself after a pause (the single local model server is the contended
 * resource; a feed lesson must never add seconds to a tutor reply).
 *
 * Failure discipline is vec-style: nothing here ever throws out of the chain;
 * repeated failures back off exponentially (to ~10 min) and the feed simply
 * keeps serving degraded content meanwhile.
 *
 * Sequence layout per node (seq column): plan=0, lesson part i = i*2-1, its
 * question = i*2 — so ORDER BY seq interleaves lesson→question naturally. The
 * node's single paper exercise sits at PRACTICE_SEQ, past every pair, so it is
 * served after the topic has actually been taught.
 */

// Ready LESSONS to keep ahead of the reader. Counted in lessons, not cards,
// because that is the unit the learner (and the progress readout) thinks in —
// each lesson drags its own question along anyway. 30 is roughly "everything the
// current focus window can hold" (FEED_DEFAULTS.focusTotal, the feed_focus_total
// setting, defaults to 6 nodes × MAX_PARTS=5), i.e.
// pre-generate the whole focus set rather than trickling a handful at a time.
const LESSON_BUFFER_TARGET = 30;
// Lessons assumed for a focus node whose outline hasn't been written yet, so the
// progress denominator is stable from the first tick instead of jumping around
// as plans land.
const ASSUMED_PARTS = 3;
const MIN_PARTS = 1;             // a tight topic is a single part; don't pad
const MAX_PARTS = 5;             // a deep topic may earn up to five
// seq for the node's single paper exercise. Any value above MAX_PARTS*2 orders it
// after every lesson/question pair; 100 leaves room for the sequence to grow
// without a migration of existing rows.
const PRACTICE_SEQ = 100;
const LESSON_MAX_CHARS = 12000;  // DB growth cap per lesson card (a lesson with
                                 // a rich ```animation runs 4–6k; 6k used to cut
                                 // the visual in half — see clampLesson)
const LESSON_CONTEXT_CHARS = 4000; // lesson text fed back into question gen
// Char budget for EARLIER parts' text fed into the next part (visuals stripped),
// split EVENLY across however many prior parts there are — so every part stays
// represented instead of the nearest ones eating the whole budget. 1 prior part
// gets ~4000 chars, 2 get ~2000 each, 4 get ~1000 each. Keeps a ~4000-char total
// so a local model isn't buried regardless of topic depth.
const PRIOR_PARTS_TOTAL = 4000;
const YIELD_RETRY_MS = 8000;
// Pause before the single retry of a step that failed in transport — long
// enough for a momentary blip or a queue to clear, short enough that a burst
// doesn't visibly stall.
const RETRY_DELAY_MS = 3000;
const BASE_BACKOFF_MS = 15000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

// How many times a lesson may be rewritten when a gate rejects it. Raised from
// two once rejections started carrying their REASON into the rewrite: a blind
// retry mostly reproduces the same draft, so a third attempt was not worth its
// cost, while a rewrite told exactly which sentence failed usually lands.
const LESSON_ATTEMPTS = 3;
// How many times a question may be re-authored when it fails normalisation or
// the independent answer-key check.
const QUESTION_ATTEMPTS = 3;

/**
 * Pick the question type from what the segment CONTAINS, not from its position.
 *
 * The old rotation was `(partIndex - 1) % 4` over a fixed list, which made part
 * 2 of every single topic a true/false — 29% of all questions, at a 50% guess
 * floor, on a signal that feeds BKT. Now:
 *   - the last part of a topic gets the open question (it is the one place a
 *     synthesis answer makes sense, and it has no guess floor at all);
 *   - a segment carrying real quantities earns a calculation, which is the
 *     question type that actually discriminates;
 *   - true/false is allowed AT MOST ONCE per topic, and only for a segment that
 *     turns on a stated condition or distinction — where a boundary case is a
 *     fair thing to ask;
 *   - everything else is multiple choice.
 */
function pickQuestionType(nodeId, partIndex, partCount, lessonText) {
    const text = String(lessonText || '');
    // A segment that shows code in a language is teaching something the
    // learner WRITES, and writing it is the strongest check there is — no
    // guess floor, no recognition. It outranks the synthesis question on a
    // last part: "explain closures in prose" measures less than "write one".
    const language = codeLanguageIn(text);
    if (language) return { type: 'code', language };
    if (partIndex === partCount && partCount > 1) return { type: 'short_answer' };

    // A segment carrying real quantities earns a CALCULATION the learner types.
    // This line promised that from the day it was written and then returned
    // multiple choice, because there was no numeric format to return: four
    // options under "solve 2^(x+1) = 16" can be substituted back one at a time
    // until one fits, so a correct answer says the learner can check four
    // candidates, and BKT is told they can solve it. A model that cannot author
    // a sound calculation for this segment still falls back to multiple choice
    // (see the plan in `generateFeedItem`), so the weaker question is the floor
    // rather than the default.
    const quantitative = /\$\$[\s\S]*?\$\$/.test(text) || /\d\s*(?:m\/s|Hz|kHz|MHz|nm|cm|km|kg|°|%|\bs\b|\bm\b|\bJ\b|\bN\b|\bW\b)/.test(text);
    if (quantitative) return { type: 'numeric' };

    // A one-part topic gets exactly ONE question, so it must be the strongest
    // format available, never the weakest — a single coin-flip is the entire
    // assessment of that topic and the only signal BKT will ever see for it.
    if (partCount === 1) return { type: 'multiple_choice' };

    const usedFormat = (type) => db.prepare(`
        SELECT 1 FROM feed_items
        WHERE node_id = ? AND kind = 'question'
          AND json_extract(meta, '$.questionType') = ? LIMIT 1
    `).get(nodeId, type);
    // A segment that walks through numbered steps is teaching a procedure, and
    // the honest check of a procedure is to reassemble it. Once per topic, like
    // true/false: a second ordering question on the same topic mostly re-asks
    // the first.
    if (countsProcedure(text) && !usedFormat('sequence')) return { type: 'sequence' };

    const hasDistinction = /\b(only|unless|must|never|always|whereas|whether|cannot|not inherited|difference between)\b/i.test(text);
    if (!usedFormat('true_false') && hasDistinction) return { type: 'true_false' };

    return { type: 'multiple_choice' };
}

/**
 * Titles of the OTHER leaves in this project, so the outline planner knows where
 * its own topic ends. Without it a plan annexes the next topic's material and
 * the learner is taught the same thing twice, days apart.
 */
function siblingTitles(nodeId, limit = 40) {
    try {
        return db.prepare(`
            SELECT n.title FROM nodes n
            WHERE n.project_id = (SELECT project_id FROM nodes WHERE id = ?)
              AND n.id != ? AND n.is_note = 0
              AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id AND c.is_note = 0)
            ORDER BY ABS(n.position - (SELECT position FROM nodes WHERE id = ?))
            LIMIT ?
        `).all(nodeId, nodeId, nodeId, limit).map(r => r.title);
    } catch {
        return [];
    }
}

/**
 * Is this topic a THING TO DO rather than an idea to understand?
 *
 * These exist in every real curriculum ("Test yourself with X's quiz", "Install
 * the toolchain", "Watch lecture 4") and they are the worst thing a lesson
 * writer can be handed: asked to teach a task involving a tool it has never
 * seen, a model writes confident, wholly invented documentation for that tool's
 * interface. Detection is deliberately conservative — a leading imperative verb
 * from a short list — because the cost of a false positive (a concept taught in
 * one part instead of three) is far lower than the cost of a false negative.
 */
const ACTION_VERBS = /^(?:test|try|practi[sc]e|complete|do|watch|read|review|install|set ?up|sign ?up|register|download|create an account|explore|browse|visit|use|play|take)\b/i;

function isActionNode(title) {
    return ACTION_VERBS.test(String(title || '').trim());
}

/**
 * The concrete example already in play in this topic, so a later part continues
 * it instead of casting a fresh one. Extracted from code identifiers, which is
 * where the repetition problem actually bites (a topic that used Robot /
 * CombatRobot in part 1 and re-declared it, differently, in part 2). Subjects
 * without code get an empty string and rely on the prompt rule alone.
 */
function runningExampleFrom(priorParts) {
    const names = new Map();
    for (const p of priorParts) {
        for (const m of String(p.content).matchAll(/\b(?:class|interface|struct|record)\s+([A-Z][A-Za-z0-9_]*)/g)) {
            names.set(m[1], (names.get(m[1]) || 0) + 1);
        }
    }
    return [...names.keys()].slice(0, 4).join(', ');
}

let chain = Promise.resolve();
let kickPending = false;

// Topics the learner opened on purpose ("Study this"), with an expiry. The
// burst serves these BEFORE the focus window and past the buffer target: the
// learner is on the page waiting, and the six topics the schedule chose are
// not the one they chose. Expired or finished entries drop out on their own.
const REQUEST_TTL_MS = 30 * 60 * 1000;
const requested = new Map();

/** Ask the generator to write this topic's lessons next. Never throws, never blocks. */
export function requestNode(nodeId) {
    if (!Number.isInteger(nodeId) || nodeId <= 0) return;
    requested.set(nodeId, Date.now() + REQUEST_TTL_MS);
    ensureBuffer();
}

/** The requested topics still worth generating for, in request order, as focus-shaped targets. */
function requestedTargets() {
    const now = Date.now();
    const out = [];
    for (const [nodeId, until] of requested) {
        if (until < now) { requested.delete(nodeId); continue; }
        const row = db.prepare(`
            SELECT n.id, n.title, n.description, n.notes, n.is_note, n.project_id
            FROM nodes n WHERE n.id = ?
        `).get(nodeId);
        // Not a note, not a slice of card order, and in a project whose topics
        // may be taught at all — `nodeIsTeachable` is both halves (nodeRole.js).
        if (!row || row.is_note || !nodeIsTeachable(row.id)) { requested.delete(nodeId); continue; }
        out.push({ nodeId: row.id, title: row.title, description: row.description, notes: row.notes, teachable: true, requested: true });
    }
    return out;
}
let consecutiveFailures = 0;
let backoffUntil = 0;

function aiEnabled() {
    try {
        const s = getAISettings();
        return !!(s.enabled && s.model);
    } catch {
        return false;
    }
}

/**
 * Is this failure worth trying again? A transport timeout or a dropped socket
 * says nothing about the request — the same prompt may well succeed a second
 * later — whereas a bad prompt, a missing model or disabled AI will fail
 * identically forever. A cancel is never retried: `signal.aborted` is the only
 * trustworthy test, since an abort surfaces as its own reason, not a named type.
 */
function isTransient(err, signal) {
    if (signal?.aborted) return false;
    const msg = String(err?.message || '').toLowerCase();
    return /timeout|timed out|fetch failed|econnreset|econnrefused|epipe|socket|network|502|503|504|overloaded|rate.?limit/
        .test(msg);
}

/**
 * Run one generation step, retrying ONCE on a transient failure.
 *
 * A step is all-or-nothing — nothing is written to feed_items until the whole
 * step succeeds — so a retry re-runs it safely. Without this, a single dropped
 * request discards every call the topic already paid for: a lesson that times
 * out at step 2 of 12 abandons the outline above it and (through feed-regen)
 * the rows that were deleted to make room for it.
 */
async function generateStep(target, missing, signal) {
    try {
        await generateOne(target, missing, signal);
    } catch (err) {
        if (!isTransient(err, signal)) throw err;
        console.warn(`[FeedGen] Transient failure on "${target.title}" (${missing.type}), retrying once: ${err.message}`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        if (signal?.aborted) throw err;
        await generateOne(target, missing, signal);
    }
}

/** Any non-feed task running or queued? Then the model belongs to the user. */
const interactiveWorkActive = () => tasks.interactiveActive(['feed']);

/** Lessons already written and servable for this focus set. */
function readyLessonCount(focusIds) {
    if (!focusIds.length) return 0;
    return db.prepare(`
        SELECT COUNT(*) AS c FROM feed_items
        WHERE status = 'ready' AND kind = 'lesson'
          AND node_id IN (${focusIds.map(() => '?').join(',')})
    `).get(...focusIds).c;
}

/** How many lesson parts this node's outline calls for, or null if unplanned. */
function plannedPartCount(nodeId) {
    const plan = db.prepare(
        `SELECT content FROM feed_items WHERE node_id = ? AND kind = 'plan' LIMIT 1`,
    ).get(nodeId);
    if (!plan) return null;
    const parts = safeParse(plan.content)?.parts;
    return Array.isArray(parts) ? parts.map(normalizePart).filter(Boolean).length : null;
}

/**
 * Where the burst stands: lessons written vs. lessons this focus set actually
 * needs. The denominator is REAL — the sum of the focus nodes' planned parts,
 * capped at the buffer target — which is what makes a progress percentage
 * meaningful. Reporting per-item progress instead produced the "stuck at 0%"
 * readout: each item ran 0→100 and the next one reset it, so the dock only ever
 * caught the start of one.
 */
function bufferStatus(focusIds) {
    if (!focusIds.length) return { ready: 0, total: 0, full: true };
    const ready = readyLessonCount(focusIds);
    let planned = 0;
    for (const id of focusIds) planned += plannedPartCount(id) ?? ASSUMED_PARTS;
    const total = Math.max(1, Math.min(LESSON_BUFFER_TARGET, planned));
    return { ready, total, full: ready >= total };
}

/**
 * Normalise one outline entry to { title, focus }. Accepts the current
 * {title, focus} shape AND the legacy bare-string shape, so plans generated
 * before the outline schema change keep working.
 */
function normalizePart(p) {
    if (typeof p === 'string') {
        const title = p.trim();
        return title ? { title, focus: '' } : null;
    }
    if (p && typeof p === 'object' && typeof p.title === 'string' && p.title.trim()) {
        return { title: p.title.trim(), focus: typeof p.focus === 'string' ? p.focus.trim() : '' };
    }
    return null;
}

// Fence languages that are a SPEC for the renderer rather than taught content.
// Only these are stripped from the prior-part context; a code block in a real
// language IS the material and must survive, or the next part cannot see the
// class it is supposed to keep building on and simply declares its own.
const SPEC_FENCES = /^```(mermaid|vega-lite|vega|plot|animation|p5|widget|drill|smiles|svg)\b[\s\S]*?^```/gm;

/**
 * Text of the parts written BEFORE `curIndex`, so the next part continues the
 * sequence instead of re-teaching. Fenced visual SPECS are stripped (the next
 * part needs to know what was TAUGHT, not carry an SVG); real code blocks are
 * KEPT, because in a programming topic the code is the taught thing and the
 * running example lives in it. Each prior part is
 * capped at an EQUAL share of PRIOR_PARTS_TOTAL (total / number-of-prior-parts),
 * so every part stays represented rather than the nearest ones eating the budget.
 * Returned in reading order [{ title, content }].
 */
function collectPriorParts(nodeId, parts, curIndex) {
    // Gather every earlier part that actually has taught text.
    const collected = [];
    for (let j = 1; j < curIndex; j++) {
        const row = db.prepare(
            `SELECT content FROM feed_items WHERE node_id = ? AND kind = 'lesson' AND seq = ?`
        ).get(nodeId, j * 2 - 1);
        if (!row) continue;
        const content = String(row.content || '').replace(SPEC_FENCES, '[visual]').trim();
        if (!content) continue;
        collected.push({ title: parts[j - 1]?.title || `Part ${j}`, content });
    }
    if (collected.length === 0) return [];
    // Even split: each part gets total / n, truncated (never dropped).
    const perPart = Math.max(1, Math.floor(PRIOR_PARTS_TOTAL / collected.length));
    return collected.map(({ title, content }) => ({
        title,
        content: content.length > perPart ? content.slice(0, perPart).trim() + ' …' : content,
    }));
}

/**
 * A lesson of this node holding a ```widget spec that has never been compiled —
 * the pre-build the feed exists to do.
 *
 * Interactive widgets are the one visual kind whose render costs an LLM call
 * (the two-agent split: the lesson carries a functional SPEC, a second pass
 * compiles it into a sandboxed app). In chat that build happens while the
 * learner waits, which is acceptable there. In a feed it would mean a spinner
 * mid-scroll — so instead we compile it HERE, in the background, before the card
 * is ever served, and the client's cacheOnly probe then renders it instantly
 * with zero LLM calls. That inverts the constraint: the feed, which runs ahead
 * of the reader, becomes the BEST surface for widgets rather than the worst.
 *
 * A build that failed is recorded on the lesson row (meta.widget.failed) so a
 * hopeless spec is attempted once, not forever — but only when the MODEL failed
 * it; an endpoint that was down or busy records nothing, or one outage would
 * permanently strip every widget the burst reached (see generateOne).
 */
function pendingWidget(nodeId) {
    const lessons = db.prepare(`
        SELECT id, content, meta FROM feed_items
        WHERE node_id = ? AND kind = 'lesson' AND status = 'ready'
        ORDER BY seq
    `).all(nodeId);

    for (const lesson of lessons) {
        const meta = safeParse(lesson.meta) || {};
        if (meta.widget?.failed) continue;
        const spec = extractWidgetSpecs(lesson.content)[0]; // one widget per topic
        if (!spec) continue;
        const specHash = specHashOf(spec);
        if (getCachedBuild(specHash)) continue; // already built (possibly by chat)
        return { lessonId: lesson.id, spec, specHash, meta };
    }
    return null;
}

/** Has some part of this topic already spent its single widget? */
function nodeHasWidget(nodeId) {
    const rows = db.prepare(`
        SELECT content FROM feed_items WHERE node_id = ? AND kind = 'lesson'
    `).all(nodeId);
    return rows.some(r => extractWidgetSpecs(r.content).length > 0);
}

/**
 * The next item missing from a node's teaching sequence, or null when the
 * sequence is complete (all planned lessons + questions exist or were skipped).
 */
function nextMissing(nodeId) {
    const plan = db.prepare(`SELECT * FROM feed_items WHERE node_id = ? AND kind = 'plan' LIMIT 1`).get(nodeId);
    if (!plan) return { type: 'plan' };
    const rawParts = safeParse(plan.content)?.parts;
    // Normalise to [{title, focus}] (tolerates legacy bare-string plans).
    const parts = Array.isArray(rawParts) ? rawParts.map(normalizePart).filter(Boolean) : [];
    if (parts.length === 0) return null; // corrupt plan — leave to degraded serving
    const skippedQ = safeParse(plan.meta)?.skippedQ || [];
    const rows = db.prepare(`
        SELECT seq, id, content FROM feed_items WHERE node_id = ? AND kind IN ('lesson', 'question')
    `).all(nodeId);
    const bySeq = new Map(rows.map(r => [r.seq, r]));
    for (let i = 1; i <= parts.length; i++) {
        const lesson = bySeq.get(i * 2 - 1);
        if (!lesson) return { type: 'lesson', i, parts, plan };
        if (!bySeq.has(i * 2) && !skippedQ.includes(i)) return { type: 'question', i, parts, plan, lesson };
    }

    // Once the topic has been taught, author ONE paper exercise for it — the
    // "now do it by hand" step. Deliberately last: an exercise is only worth
    // setting when the material behind it exists, and authoring it early would
    // spend a model call the learner might never reach.
    //
    // seq PRACTICE_SEQ sits past any lesson/question pair (parts are capped well
    // below it), so ordering stays "read, answer, …, then work it on paper".
    //
    // Action nodes are skipped for the same reason they get special handling in
    // lesson generation: "Test yourself with Tofugu's Kana Quiz" is a thing to
    // DO, not a topic to prove on paper, and asking the model to set a written
    // exercise on it produces an exercise about a website it has never seen.
    // (Observed: that node was handed a paper exercise.)
    if (getFeedSettings().practice && !skippedPractice(plan) && !isActionNode(nodeTitle(nodeId)) && !db.prepare(
        `SELECT 1 FROM feed_items WHERE node_id = ? AND kind = 'practice' LIMIT 1`
    ).get(nodeId)) {
        return { type: 'practice', parts, plan };
    }
    return null;
}

function nodeTitle(nodeId) {
    try {
        return db.prepare('SELECT title FROM nodes WHERE id = ?').get(nodeId)?.title || '';
    } catch {
        return '';
    }
}

/** A paper exercise this node's model could not author — attempted once, not forever. */
function skippedPractice(plan) {
    return safeParse(plan.meta)?.skippedPractice === true;
}

/**
 * Clamp a lesson to the DB cap WITHOUT ever cutting a fenced block in half.
 * A sliced ```animation is the worst possible failure: the HTML parse ladder in
 * sanitizeSvgAnim happily auto-closes the missing tags, so it renders as a
 * half-drawn scene, throws no error, and the repair loop never fires — nothing
 * catches it but the learner. If the cut lands inside an open fence, drop that
 * whole block: a lesson missing its visual beats one showing a mutilated visual.
 */
function clampLesson(md) {
    const text = String(md || '');
    if (text.length <= LESSON_MAX_CHARS) return text;

    const cut = text.slice(0, LESSON_MAX_CHARS);
    const fenceLines = cut.match(/^```/gm) || [];
    if (fenceLines.length % 2 === 0) return cut.trimEnd(); // every fence closed

    let lastFence = -1;
    for (const m of cut.matchAll(/^```/gm)) lastFence = m.index;
    return cut.slice(0, lastFence).trimEnd();
}

/** Generate exactly one missing item for a focus node. Throws on hard failure. */
async function generateOne(f, missing, signal) {
    // Compiling an already-written widget spec needs no teaching context.
    if (missing.type === 'widget') {
        const { lessonId, spec, specHash, meta } = missing;
        try {
            await compileWidget({ spec, specHash, signal });
        } catch (err) {
            // An unreachable, crashed, busy or aborted endpoint says nothing
            // about the SPEC: write nothing, and the next burst retries it.
            // Recording it as failed made one outage a permanent verdict on
            // every widget the burst happened to reach.
            if (isUnavailable(err)) {
                console.warn(`[FeedGen] Widget pre-build deferred for "${f.title}" (model unavailable): ${err.message}`);
                return;
            }
            // A spec the builder can't compile is recorded and never retried —
            // the card still renders, with a "Build widget" button the learner
            // can press if they want it. Never fatal to the burst.
            meta.widget = { failed: true, error: String(err.message || err).slice(0, 200) };
            db.prepare('UPDATE feed_items SET meta = ? WHERE id = ?').run(JSON.stringify(meta), lessonId);
            console.warn(`[FeedGen] Widget pre-build failed for "${f.title}": ${err.message}`);
        }
        return;
    }

    // The project's declared study language, resolved once for all three
    // branches below. null = unset, which reproduces the pre-declaration
    // behaviour exactly (the prompt falls back to "follow the material").
    const lang = getNodeLanguage(f.nodeId);

    if (missing.type === 'plan') {
        // Outline stays PINNED to this node (no completedTopics — quiz-gen rule),
        // but it DOES get the neighbouring topic titles, which are scope, not
        // prior knowledge: they tell it where its own topic ends.
        const context = buildNodeContext(f.nodeId);
        const actionNode = isActionNode(f.title);
        const { system, user } = AI_PROMPTS.feed_outline(f.title, context, {
            siblings: siblingTitles(f.nodeId),
            actionNode,
            lang,
        });
        let parts = null;
        for (let attempt = 0; attempt < 2 && !parts; attempt++) {
            const resp = await generateResponse(user, system, [], { temperature: 0.4, signal });
            const parsed = parseObjectResponse(resp);
            const candidate = Array.isArray(parsed?.parts)
                ? parsed.parts.map(normalizePart).filter(Boolean).slice(0, Math.min(MAX_PARTS, getFeedSettings().maxParts))
                : [];
            if (candidate.length >= MIN_PARTS) parts = candidate;
        }
        if (!parts) throw new Error(`Outline generation failed for "${f.title}"`);
        // A task node is one part, enforced rather than requested: the model is
        // asked for one and, left to itself, still returns four segments of
        // invented interface documentation. Truncating is safe — part 1 of such
        // a plan is always "what to do".
        if (actionNode && parts.length > 1) {
            console.warn(`[FeedGen] "${f.title}" is a task node — trimming ${parts.length} planned parts to 1`);
            parts = parts.slice(0, 1);
        }
        db.prepare(`
            INSERT INTO feed_items (node_id, kind, seq, content, meta, status)
            VALUES (?, 'plan', 0, ?, ?, 'internal')
        `).run(f.nodeId, JSON.stringify({ parts }), JSON.stringify(aiProvenanceFields()));
        return;
    }

    if (missing.type === 'practice') {
        const exercise = await generatePaperExercise(f.nodeId, f.title, { signal });
        if (!exercise) {
            // Same contract as an ungradeable question: record the failure on the
            // plan and move on. No paper card is strictly better than one whose
            // rubric can't be marked.
            const meta = safeParse(missing.plan.meta) || {};
            meta.skippedPractice = true;
            db.prepare(`UPDATE feed_items SET meta = ? WHERE id = ?`).run(JSON.stringify(meta), missing.plan.id);
            console.warn(`[FeedGen] Skipped paper exercise for "${f.title}" (no valid exercise authored)`);
            return;
        }
        db.prepare(`
            INSERT INTO feed_items (node_id, kind, seq, content, meta, status)
            VALUES (?, 'practice', ?, ?, ?, 'ready')
        `).run(f.nodeId, PRACTICE_SEQ, JSON.stringify(exercise), JSON.stringify({ mode: exercise.mode, ...aiProvenanceFields() }));
        return;
    }

    const partTitle = missing.parts[missing.i - 1].title;
    // Provenance rides in the meta blob rather than a column, because this table
    // already has one. Read back by tools/feed-audit.mjs and feed-regen.
    const partMeta = JSON.stringify({
        partIndex: missing.i,
        partCount: missing.parts.length,
        partTitle,
        ...aiProvenanceFields(),
    });

    if (missing.type === 'lesson') {
        // Give the part everything it needs to continue the "book": the full plan
        // (so it stays in its lane), the actual text of earlier parts (so it builds
        // on them instead of repeating), and completedTopics (so it can reference
        // what the learner already proved). Question gen below keeps the pinned
        // `context` — assessment must not see the completed-topics list.
        // One widget per TOPIC, not per part: once some part has spent it, later
        // parts get a guide that never mentions widgets, so a topic can't queue
        // multiple expensive builds.
        const lessonContext = buildNodeContext(f.nodeId, { completedTopics: true });
        const priorParts = collectPriorParts(f.nodeId, missing.parts, missing.i);

        // Write, check, rewrite — and CARRY THE REASON into each rewrite. The
        // loop used to re-issue an identical prompt, which at temperature 0.6
        // mostly reproduces the same draft with the same fault; a rewrite that
        // is told which sentence failed usually fixes it on the next pass.
        //
        // Three gates run per draft, cheapest first, and each can send the draft
        // back: mechanical defects (free), then the visual check, then the
        // numeric audit. The last two are model calls, but both are self-gating
        // — no checkable visual means no visual call, and a segment with no
        // arithmetic means no audit call — so an ordinary prose lesson still
        // costs one request.
        let md = null;
        let vetted = null;
        let fault = null;      // what sent the last draft back, fed to the next
        let unresolved = null; // the fault still standing when attempts ran out
        for (let attempt = 0; attempt < LESSON_ATTEMPTS; attempt++) {
            const { system, user } = AI_PROMPTS.feed_lesson(
                f.title, missing.parts, missing.i, lessonContext, priorParts,
                {
                    allowWidget: getFeedSettings().widgets && !nodeHasWidget(f.nodeId),
                    actionNode: isActionNode(f.title),
                    runningExample: runningExampleFrom(priorParts),
                    lang,
                    priorFault: fault,
                },
            );
            const candidate = stripSelfCertifyingCloser(
                clampLesson(await generateResponse(user, system, [], { temperature: 0.6, signal, operation: 'authoring' })),
                lang,
            );

            const defects = lessonDefects(candidate, f.nodeId);
            if (defects.length) {
                md = candidate;
                vetted = null;
                fault = defects.join('; ');
                unresolved = { stage: 'mechanical', reason: fault };
                console.warn(`[FeedGen] Rewriting "${f.title}" part ${missing.i}: ${fault}`);
                continue;
            }

            // A spec that renders perfectly while depicting something else is
            // the one failure no sanitizer can see, so the visual is read
            // against its own prose. A `wrong` verdict drops the visual here; a
            // `text-wrong` verdict means the PICTURE was right and the prose
            // was the mistaken half, so the visual is kept and the prose is
            // rewritten — deleting the accurate half would make the card worse.
            const check = await vetLessonVisuals(candidate, partTitle, { signal });
            md = candidate;
            vetted = check;
            for (const r of check.removed) {
                console.warn(`[FeedGen] Removed ${r.kind} from "${f.title}" part ${missing.i}: ${r.reason}`);
            }
            if (check.disputes.length) {
                fault = `The text contradicts its own ${check.disputes[0].kind} diagram, and the diagram is the correct one: ${check.disputes[0].reason}`;
                unresolved = { stage: 'visual-dispute', reason: check.disputes[0].reason };
                console.warn(`[FeedGen] Rewriting "${f.title}" part ${missing.i} (prose disputed by its own visual): ${check.disputes[0].reason}`);
                continue;
            }

            // Nothing else in this pipeline ever read the teaching's own
            // arithmetic, which is where a model hand-computes and therefore
            // where it is most likely to be wrong.
            const audit = await auditLessonMath(f.title, partTitle, check.markdown, { priorParts, signal });
            if (audit.ok) { unresolved = null; break; }
            fault = audit.quote ? `${audit.reason}\nThe faulty step was: "${audit.quote}"` : audit.reason;
            unresolved = { stage: 'math', reason: audit.reason, quote: audit.quote || undefined };
            console.warn(`[FeedGen] Rewriting "${f.title}" part ${missing.i} (audit): ${audit.reason}`);
        }

        if (unresolved) {
            // Every attempt failed a gate. Serving the last draft still beats
            // stalling the topic — nextMissing would hand back the same part
            // forever — but the fault is recorded on the row rather than only
            // logged, so tools/feed-audit.mjs can count it and the card can be
            // re-authored deliberately instead of silently teaching a bad step.
            console.warn(`[FeedGen] Serving "${f.title}" part ${missing.i} with an unresolved ${unresolved.stage} fault: ${unresolved.reason}`);
        }

        db.prepare(`
            INSERT INTO feed_items (node_id, kind, seq, content, meta, status)
            VALUES (?, 'lesson', ?, ?, ?, 'ready')
        `).run(f.nodeId, missing.i * 2 - 1, vetted ? vetted.markdown : md, JSON.stringify({
            ...JSON.parse(partMeta),
            ...(vetted?.removed.length ? { visualsRemoved: vetted.removed } : {}),
            ...(unresolved ? { unresolvedFault: unresolved } : {}),
            // Cleared every gate. Recorded so tools/feed-audit.mjs can count the
            // rows written BEFORE these gates existed: feed_items is a cache, so
            // those never improve on their own and are the feed-regen backlog.
            ...(unresolved ? {} : { audited: true }),
        }));
        return;
    }

    // Question for part i. A broken question is skipped, never served — a
    // lesson without a question beats a card with a wrong answer key.
    const lessonText = String(missing.lesson.content || '').slice(0, LESSON_CONTEXT_CHARS);
    const { type: qType, language: qLanguage = null } = pickQuestionType(f.nodeId, missing.i, missing.parts.length, lessonText);
    // Assessment context stays PINNED: the node's own curriculum (Overview
    // included — that is where a topic's real expectations live) and the
    // outline, but never the completed-topics list.
    const qContext = buildNodeContext(f.nodeId);

    let question = null;
    let veto = null;
    let fault = null;
    // Best candidate that is CORRECT but measures less than it should. A weak
    // question is retried, but never discarded in favour of nothing: a skipped
    // question gives BKT no signal at all, which is worse than a signal that is
    // easier than advertised. Only a question that would MISLEAD is dropped.
    let fallback = null;
    // A specialised format (code, an ordering) that the model cannot author
    // soundly for this segment falls back to multiple choice rather than to no
    // question at all: a part with no check gives BKT nothing, which is worse
    // than a plainer check. Measured 2026-09-14 with a 9B: three ordering
    // attempts on a procedure segment, three vetoes (it kept writing outcomes
    // to choose between); the code format authored cleanly first time.
    const plan = qType === 'multiple_choice'
        ? [[qType, QUESTION_ATTEMPTS]]
        : [[qType, QUESTION_ATTEMPTS], ['multiple_choice', 2]];
    for (const [type, attempts] of plan) {
        if (question || fallback) break;
        if (type !== qType) {
            // A fault about an ordering or a program says nothing to a
            // multiple-choice rewrite.
            fault = null;
            console.warn(`[FeedGen] "${f.title}" part ${missing.i}: no sound ${qType} question in ${QUESTION_ATTEMPTS} attempts, falling back to multiple choice`);
        }
    for (let attempt = 0; attempt < attempts && !question; attempt++) {
        const { system, user } = AI_PROMPTS.feed_question(f.title, partTitle, lessonText, type, {
            context: qContext,
            outline: missing.parts,
            partIndex: missing.i,
            lang,
            language: type === 'code' ? qLanguage : null,
            priorFault: fault,
        });
        const resp = await generateResponse(user, system, [], { temperature: 0.4, signal });
        const candidate = normalizeFeedQuestion(parseObjectResponse(resp));
        if (!candidate) {
            fault = 'the previous attempt did not produce a valid JSON object in the required shape';
            continue;
        }

        // Cheap, deterministic checks first — a malformed candidate must not
        // cost a verifier call, and the verifier cannot see these anyway: it is
        // asked what the answer is, never whether the other options are distinct
        // or whether a wrong answer will be explained.
        const defects = questionDefects(candidate, f.nodeId);
        if (defects.length) {
            veto = defects[0];
            fault = defects.join('; ');
            console.warn(`[FeedGen] Malformed question for "${f.title}" part ${missing.i}: ${fault}`);
            continue;
        }

        // An independent pass answers it cold. This is the only gate that can
        // catch a confidently wrong answer key — the failure mode that punishes
        // a learner for knowing the right answer, and the one thing no amount of
        // prompting the author reliably prevents. It also reports back how many
        // options it could have discarded WITHOUT knowing the subject.
        const check = await verifyQuestion(f.title, candidate, { signal });
        if (!check.ok) {
            veto = check.reason;
            fault = check.reason;
            console.warn(`[FeedGen] Rejected question for "${f.title}" part ${missing.i}: ${check.reason}`);
            continue;
        }

        // Correct, but is it discriminating? A key that just repeats a number
        // from the stem, or a set with two free eliminations, is scored by BKT
        // at a 0.25 guess floor it does not actually have.
        const weaknesses = questionWeaknesses(candidate);
        if (check.eliminable != null && check.eliminable > MAX_ELIMINABLE_OPTIONS) {
            weaknesses.push(`${check.eliminable} of the options can be ruled out without knowing the subject, so the real guess rate is far above what a four-option question should have`);
        }
        if (!weaknesses.length) { question = candidate; break; }

        if (!fallback) fallback = { candidate, weaknesses };
        fault = weaknesses.join('; ');
        console.warn(`[FeedGen] Weak question for "${f.title}" part ${missing.i}, retrying: ${fault}`);
    }
    }

    // Nothing sound was authored, but something correct-if-weak was: serve it
    // with the weakness recorded rather than leaving the part unchecked.
    let servedWeaknesses = null;
    if (!question && fallback) {
        question = fallback.candidate;
        servedWeaknesses = fallback.weaknesses;
        console.warn(`[FeedGen] Serving a weak question for "${f.title}" part ${missing.i}: ${fallback.weaknesses.join('; ')}`);
    }
    if (!question) {
        const meta = safeParse(missing.plan.meta) || {};
        meta.skippedQ = [...(meta.skippedQ || []), missing.i];
        // Record WHY, so a topic quietly losing its checks is diagnosable
        // instead of just having a hole in its sequence.
        meta.skippedQReason = { ...(meta.skippedQReason || {}), [missing.i]: veto || 'unparseable' };
        db.prepare(`UPDATE feed_items SET meta = ? WHERE id = ?`).run(JSON.stringify(meta), missing.plan.id);
        console.warn(`[FeedGen] Skipped ungradeable question for "${f.title}" part ${missing.i}`);
        return;
    }
    db.prepare(`
        INSERT INTO feed_items (node_id, kind, seq, content, meta, status)
        VALUES (?, 'question', ?, ?, ?, 'ready')
    `).run(f.nodeId, missing.i * 2, JSON.stringify(question), JSON.stringify({
        partIndex: missing.i,
        partCount: missing.parts.length,
        partTitle,
        questionType: question.type,
        verified: true,
        ...aiProvenanceFields(),
        ...(servedWeaknesses ? { weaknesses: servedWeaknesses } : {}),
    }));
}

/**
 * First node in `list` that has work to do, in list order.
 *
 * runBurst tries four candidate passes in a fixed order of preference; they
 * differ only in which list they walk, what counts as work, and what to do with
 * a node that has none. The walk itself is written once here so the order of
 * preference stays the only thing those four lines express.
 *
 * @returns {{target: object, missing: object} | null}
 */
function pickTarget(list, find, onEmpty) {
    for (const f of list) {
        const missing = find(f);
        if (missing) return { target: f, missing };
        if (onEmpty) onEmpty(f);
    }
    return null;
}

async function runBurst() {
    if (!aiEnabled()) return;
    if (Date.now() < backoffUntil) return;

    let handle = null;
    let cancelled = false;
    const controller = new AbortController();

    try {
        while (!cancelled) {
            if (interactiveWorkActive()) {
                // The model belongs to the user right now — come back shortly.
                setTimeout(ensureBuffer, YIELD_RETRY_MS).unref();
                break;
            }
            // Re-derive focus every iteration: nodes may complete / reschedule
            // mid-burst and we must never generate for a closed node.
            // A cut stage has no material to teach FROM — its content is the
            // cards hanging off it — so asking a model to write a lesson about
            // "Stage 7" produces invented documentation, which is the one thing
            // this generator must never do. It is excluded here rather than
            // inside the generators, so it also never occupies a slot in the
            // buffer accounting below and can't stall the queue for a topic that
            // does have something to write about. `teachable` is decided per
            // node now (nodeRole.js), not per project: a deck's NAMED subdecks
            // are real topics and are taught once their project is switched on.
            const { focus } = getFocusNodes();
            const teachable = focus.filter(f => f.teachable);
            const wanted = requestedTargets();

            // Teaching text first — a missing lesson stalls the feed, while a
            // missing widget only costs interactivity on a card that still
            // reads fine. Widget pre-builds then run even once the buffer is
            // full, because they enrich cards ALREADY in the buffer (gating them
            // on buffer depth would mean the card is served before its build).
            const buffer = bufferStatus(teachable.map(x => x.nodeId));
            // A topic the learner is waiting on comes first, whatever the
            // buffer says; one with nothing left to write drops off the list.
            let hit = pickTarget(wanted, f => nextMissing(f.nodeId), f => requested.delete(f.nodeId));
            if (!hit && !buffer.full) {
                hit = pickTarget(teachable, f => nextMissing(f.nodeId));
            }
            // Paper exercises run even when the lesson buffer is full — for the
            // same reason widget pre-builds do, and for a sharper one. A node
            // only becomes eligible for its exercise once every lesson and
            // question it planned exists, and with the focus window's node count
            // (FEED_DEFAULTS.focusTotal, the feed_focus_total setting) × MAX_PARTS
            // equal to LESSON_BUFFER_TARGET that is the exact moment the buffer
            // reports full. Gating practice on `!buffer.full` therefore starved
            // it permanently: the condition that unlocks it is the condition that
            // switches it off.
            if (!hit) {
                hit = pickTarget(teachable, f => {
                    const m = nextMissing(f.nodeId);
                    return m?.type === 'practice' ? m : null;
                });
            }
            if (!hit) {
                hit = pickTarget(teachable, f => {
                    const w = pendingWidget(f.nodeId);
                    return w ? { type: 'widget', ...w } : null;
                });
            }
            if (!hit) break; // every focus sequence is complete
            const { target, missing } = hit;

            if (!handle) {
                handle = tasks.registerExternal({
                    kind: 'feed',
                    label: 'Preparing feed lessons',
                    cancel: () => { cancelled = true; controller.abort(); },
                });
            }
            const detail = missing.type === 'plan' ? 'outline'
                : missing.type === 'widget' ? 'building widget'
                : `${missing.type} ${missing.i}`;
            handle.update({
                // Capped at 99 while work remains: settle() writes the real 100
                // when the burst finishes, and a chip reading 100% next to a
                // breathing "running" dot is worse than one reading 97%.
                percent: Math.min(99, Math.round((buffer.ready / buffer.total) * 100)),
                message: `${buffer.ready}/${buffer.total} lessons ready · ${target.title} — ${detail}`,
            });

            await generateStep(target, missing, controller.signal);
            consecutiveFailures = 0;
        }
        if (handle) {
            if (cancelled) handle.cancelled();
            else handle.finish();
        }
    } catch (err) {
        if (cancelled) {
            if (handle) handle.cancelled();
            return;
        }
        consecutiveFailures++;
        backoffUntil = Date.now() + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1));
        console.error(`[FeedGen] Generation failed (attempt ${consecutiveFailures}, backing off):`, err.message);
        if (handle) handle.fail(err.message);
    }
}

/**
 * Build one node's teaching sequence to completion, ignoring focus selection and
 * the buffer target.
 *
 * runBurst decides WHAT to work on next from what the learner is due; this is
 * the same generation applied to a node you name. It exists for maintenance —
 * re-authoring a topic whose cached lessons predate a prompt or validator change
 * (tools/feed-regen.mjs) — and it is the only way to reach a specific topic,
 * since the focus window only ever holds six.
 *
 * Unlike runBurst it does NOT swallow failures: a caller asking for one specific
 * node wants to know it failed.
 *
 * @param {number} nodeId
 * @param {{signal?: AbortSignal, onStep?: (label: string) => void}} [opts]
 * @returns {Promise<number>} items generated
 */
export async function generateForNode(nodeId, { signal, onStep } = {}) {
    const row = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(nodeId);
    if (!row) throw new Error(`No such node: ${nodeId}`);
    const target = { nodeId: row.id, title: row.title };

    let made = 0;
    // Bounded so a generator that keeps failing to satisfy nextMissing (a plan
    // that never parses, say) cannot spin forever.
    const MAX_STEPS = MAX_PARTS * 2 + 4;
    for (let step = 0; step < MAX_STEPS; step++) {
        const missing = nextMissing(nodeId) || (() => {
            const w = pendingWidget(nodeId);
            return w ? { type: 'widget', ...w } : null;
        })();
        if (!missing) break;
        onStep?.(missing.type === 'plan' ? 'outline'
            : missing.type === 'widget' ? 'widget'
                : missing.type === 'practice' ? 'paper exercise'
                    : `${missing.type} ${missing.i}`);
        await generateStep(target, missing, signal);
        made++;
    }
    return made;
}

/**
 * Kick the generator: appends one burst to the serial chain unless one is
 * already pending. Safe to call from anywhere, any number of times — it never
 * throws and never blocks the caller.
 */
export function ensureBuffer() {
    if (kickPending) return;
    kickPending = true;
    chain = chain
        .then(() => { kickPending = false; return runBurst(); })
        .catch((err) => {
            kickPending = false;
            console.error('[FeedGen] Unexpected chain error:', err?.message);
        });
}

/** Delayed startup kick — lets the server finish booting first. */
export function startupKick(delayMs = 5000) {
    setTimeout(ensureBuffer, delayMs).unref();
}

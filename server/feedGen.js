import db from './database.js';
import { generateResponse, getAISettings, AI_PROMPTS, buildNodeContext, aiProvenanceFields } from './ai.js';
import { parseObjectResponse } from './agentic.js';
import { getFocusNodes, normalizeFeedQuestion, getFeedSettings, safeParse } from './feed.js';
import { codeLanguageIn, countsProcedure } from './answerFormats.js';
import { compileWidget, getCachedBuild, specHashOf, extractWidgetSpecs } from './widgets.js';
import { generatePaperExercise } from './paper.js';
import {
    lessonDefects, questionDefects, citationFaults, questionWeaknesses, stripSelfCertifyingCloser,
    vetLessonVisuals, vetLessonDrills, verifyQuestion, auditLesson, MAX_ELIMINABLE_OPTIONS,
} from './feedQuality.js';
import { getNodeLanguage } from './language.js';
import { generateMaterial } from './studyMaterial.js';
import { MIN_GATE_QUESTIONS } from './mastery.js';
import { nodeIsTeachable } from './nodeRole.js';
import { isUnavailable } from './embeddings.js';
import { recordBuildFailure } from './visualBuilds.js';
import { courseContextForNode, courseLeaves } from './courseContext.js';
import { headStartFor, reviewParts, teachingStarted } from './headStart.js';
import { lessonSourcesFor, resolveLessonCitations, teachingText } from './lessonSources.js';
import { markUnverified, pendingVerifications, applyVerdict, adoptLegacyFeedFlags, reverifyWait } from './questionTrust.js';
import { findDrills } from './drillCheck.js';
import { onUnverifiedHeldBack, bankOf, bankPartLookup } from './questionLog.js';
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
// What the look-ahead writes per topic. The bank matches what the gate asks for
// when it generates one itself (MasteryGateModal requests 10), so a prepared
// check and a waited-for check are the same assessment; the card count matches
// the bulk dialog's default.
const MATERIAL_QUESTIONS = 10;
const MATERIAL_CARDS = 8;
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
export function siblingTitles(nodeId, limit = 40) {
    // The NEAREST topics in course order, both sides, listed in that order.
    // It used to sort every leaf of the project by `ABS(position - mine)` —
    // but `position` is per PARENT, so that ranked the first topics of every
    // section alike and could cut the one neighbour that matters most (the
    // very next topic, which is the one a plan annexes) behind twenty
    // unrelated sections' topics at the same index.
    try {
        const node = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(nodeId);
        if (!node) return [];
        const leaves = courseLeaves(node.project_id);
        const idx = leaves.findIndex(l => l.id === nodeId);
        if (idx === -1) return leaves.filter(l => l.id !== nodeId).slice(0, limit).map(l => l.title);
        const half = Math.floor(limit / 2);
        let from = Math.max(0, idx - half);
        let to = Math.min(leaves.length, idx + 1 + (limit - (idx - from)));
        from = Math.max(0, to - 1 - limit);
        return leaves.slice(from, to).filter(l => l.id !== nodeId).slice(0, limit).map(l => l.title);
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
            SELECT n.id, n.title, n.description, n.notes, n.is_note, n.project_id,
                   p.name AS project_name, p.color AS project_color
            FROM nodes n LEFT JOIN projects p ON p.id = n.project_id WHERE n.id = ?
        `).get(nodeId);
        // Not a note, not a slice of card order, and in a project whose topics
        // may be taught at all — `nodeIsTeachable` is both halves (nodeRole.js).
        if (!row || row.is_note || !nodeIsTeachable(row.id)) { requested.delete(nodeId); continue; }
        // The project travels with the target like it does on a focus target,
        // or the dock's chip loses its course colour (and its record the way
        // back) for exactly the topic the learner is waiting on.
        out.push({
            nodeId: row.id, title: row.title, description: row.description, notes: row.notes,
            projectId: row.project_id, projectName: row.project_name, projectColor: row.project_color,
            teachable: true, requested: true,
        });
    }
    return out;
}
let consecutiveFailures = 0;
let backoffUntil = 0;

// Topics whose questions a DRAW had to hold back because no verifier had
// confirmed them (questionLog.js tells us, after the draw — never on the
// request path itself). The burst's last tier asks the verifier about them
// again, alongside the focus window's; a topic with nothing due drops off.
const heldBack = new Set();
onUnverifiedHeldBack((nodeId) => {
    if (!Number.isInteger(nodeId) || nodeId <= 0) return;
    heldBack.add(nodeId);
    ensureBuffer();
});

/**
 * The next question on this topic waiting for a second verdict, as a step:
 * `{ type: 'verify', entry }`, or null. Due only after its wait
 * (questionTrust.js `reverifyWait`), so a verifier that is still down costs
 * one call per question per wait, never a loop.
 *
 * Exported for `tools/question-trust-gates.mjs`.
 */
export function pendingVerification(nodeId) {
    const [entry] = pendingVerifications(nodeId, { limit: 1 });
    return entry ? { type: 'verify', entry } : null;
}

/** The held-back topics as burst targets (the focus window's shape). */
function heldBackTargets() {
    const out = [];
    for (const nodeId of heldBack) {
        const row = db.prepare(`
            SELECT n.id, n.title, n.project_id, p.name AS project_name, p.color AS project_color
            FROM nodes n LEFT JOIN projects p ON p.id = n.project_id WHERE n.id = ?
        `).get(nodeId);
        if (!row) { heldBack.delete(nodeId); continue; }
        out.push({ nodeId: row.id, title: row.title, projectId: row.project_id, projectName: row.project_name, projectColor: row.project_color });
    }
    return out;
}

/**
 * Ask the verifier about one question again, and write the verdict back where
 * the question lives (questionTrust.js `applyVerdict`): confirmed, it counts
 * from now on; disputed, it is deleted like any vetoed question; no verdict
 * again, the wait before the next try grows.
 */
async function reverifyOne(f, entry, signal) {
    const { unverified: _stamp, ...question } = entry.question || {};
    const verdict = await verifyQuestion(f.title, question, { signal });
    const outcome = applyVerdict(entry, verdict);
    console.log(`[FeedGen] Re-verified a ${entry.where} question on "${f.title}": ${outcome}${verdict.available ? '' : ` (${verdict.reason})`}`);
    return outcome;
}

/**
 * A stored lesson on this topic that has not been through today's checks, as
 * a step: `{ type: 'recheck', row, meta, drills, facts }`, or null.
 *
 * `feed_items` is a cache, so a gate added today reaches nothing already
 * written — and the rows already written are the ones a learner is reading
 * NOW. Two checks arrived on 2026-10-01 that every older row skipped: the
 * cold check of a drill's keys (`drills`, any row whose content carries a
 * drill, read or not, because a drill is replayed from its card) and the
 * fact audit (`facts`, unread rows only — a part already read cannot be
 * un-read, and rewriting it would rewrite history the learner remembers).
 * A row whose last try got no verdict waits (`recheckNext`, the question
 * re-verification's doubling wait) rather than asking again every burst.
 *
 * Exported for `tools/drill-gates.mjs`.
 */
export function pendingLessonCheck(nodeId, { now = Date.now() } = {}) {
    const rows = db.prepare(`
        SELECT id, seq, status, content, meta FROM feed_items
        WHERE node_id = ? AND kind = 'lesson' AND status IN ('ready', 'consumed')
        ORDER BY seq
    `).all(nodeId);
    for (const row of rows) {
        const meta = safeParse(row.meta) || {};
        const due = Date.parse(meta.recheckNext || '');
        if (Number.isFinite(due) && due > now) continue;
        const drills = !meta.drillsChecked && findDrills(row.content).length > 0;
        const facts = row.status === 'ready' && !meta.factChecked;
        if (drills || facts) return { type: 'recheck', row, meta, drills, facts };
    }
    return null;
}

/**
 * Put one stored lesson through the checks it predates.
 *
 * Disputed drill items come out in place, as they would have at write time.
 * A part the fact audit calls broken is DELETED, with its question if that is
 * unread too, and `nextMissing` writes it again through the whole pipeline on
 * a later step — the same thing `tools/feed-regen.mjs` does by hand, and the
 * only fix that does not serve a statement the auditor believes is false. A
 * card already on screen when its row goes is harmless: answering it consumes
 * nothing (`consumeFeedItem` reads a missing row as a duplicate).
 *
 * Every write is compare-and-set on the content read, because a visual repair
 * (`PUT /api/feed/items/:id`) may have rewritten the row in between; a lost
 * race writes nothing and the row is simply checked again next time.
 */
async function recheckLesson(f, { row, meta, drills, facts }, signal) {
    let content = row.content;
    const patch = {};
    let noVerdict = false;
    if (drills) {
        const v = await vetLessonDrills(content, f.title, { signal });
        content = v.markdown;
        for (const r of v.removed) {
            console.warn(`[FeedGen] Re-check of "${f.title}": removed ${r.prompt ? `"${r.prompt}" → "${r.key}"` : 'a drill'} (${r.reason})`);
        }
        if (v.removed.length) patch.drillItemsRemoved = [...(meta.drillItemsRemoved || []), ...v.removed];
        if (v.unchecked.length) noVerdict = true;
        else patch.drillsChecked = true;
    }
    if (facts) {
        const partIndex = Number.isInteger(meta.partIndex) ? meta.partIndex : Math.ceil(row.seq / 2);
        const planRow = db.prepare(`SELECT content FROM feed_items WHERE node_id = ? AND kind = 'plan' LIMIT 1`).get(f.nodeId);
        const parts = (safeParse(planRow?.content)?.parts || []).map(normalizePart).filter(Boolean);
        const priorParts = collectPriorParts(f.nodeId, parts, partIndex);
        const audit = await auditLesson(f.title, meta.partTitle || parts[partIndex - 1]?.title || f.title, teachingText(content), { priorParts, signal });
        if (audit.available === false) {
            noVerdict = true;
        } else if (audit.ok) {
            patch.factChecked = true;
        } else {
            const gone = db.transaction(() => {
                const n = db.prepare(`DELETE FROM feed_items WHERE id = ? AND status = 'ready' AND content = ?`).run(row.id, row.content).changes;
                if (n) db.prepare(`DELETE FROM feed_items WHERE node_id = ? AND kind = 'question' AND seq = ? AND status = 'ready'`).run(f.nodeId, row.seq + 1);
                return n;
            })();
            if (gone) {
                console.warn(`[FeedGen] Re-check of "${f.title}" part ${partIndex}: the audit found "${audit.quote || audit.reason}" (${audit.reason}) — the part will be written again`);
            }
            return;
        }
    }
    if (noVerdict) {
        const tries = (Number(meta.recheckTries) || 0) + 1;
        patch.recheckTries = tries;
        patch.recheckNext = new Date(Date.now() + reverifyWait(tries)).toISOString();
    }
    const next = { ...meta, ...patch };
    if (!noVerdict) { delete next.recheckTries; delete next.recheckNext; }
    db.prepare(`UPDATE feed_items SET content = ?, meta = ? WHERE id = ? AND content = ?`)
        .run(content, JSON.stringify(next), row.id, row.content);
}

/**
 * Put every stored lesson of one topic through the re-check now, rather than
 * when the burst reaches it. For maintenance and `tools/content-check-gates.mjs`;
 * bounded, and a row with no verdict is left waiting rather than retried here.
 */
export async function recheckStoredLessons(nodeId, { signal } = {}) {
    const node = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(nodeId);
    if (!node) throw new Error(`No such node: ${nodeId}`);
    let steps = 0;
    for (let m = pendingLessonCheck(nodeId); m && steps < 50; m = pendingLessonCheck(nodeId), steps++) {
        await recheckLesson({ nodeId: node.id, title: node.title }, m, signal);
    }
    return steps;
}

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
        // Without its sources line: a later part shown a finished source list
        // writes one of its own instead of leaving it to the app.
        const content = teachingText(row.content).replace(SPEC_FENCES, '[visual]').trim();
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
 * The most parts this topic's plan may have right now, and whether it is a
 * review: `{ cap, review }`. A head start (placement or transfer) makes it a
 * review of `reviewParts` parts (headStart.js); otherwise it is the learner's
 * `feed_max_parts`.
 */
function planShape(nodeId) {
    const maxParts = Math.min(MAX_PARTS, getFeedSettings().maxParts);
    const hs = headStartFor(nodeId);
    return hs
        ? { cap: reviewParts(hs.prior, maxParts), review: true, headStart: hs }
        : { cap: maxParts, review: false, headStart: null };
}

/**
 * Was this plan written for a head start the topic no longer has — or without
 * one it now has — and can it still be replaced?
 *
 * A plan is a cache, and a cached plan normally lives until its topic closes.
 * But the head start it was sized for can arrive after it (a placement taken
 * once the feed had already written the first topics out in full), leave after
 * it (Discard, a later wrong probe answer, a transfer twin that faded) or be
 * contradicted by the learner's own answers (a failed "Prove it now"). So a
 * plan whose review cap disagrees with the current one is replaced — but ONLY
 * while nothing of the topic has been consumed: a sequence the learner is
 * partway through is theirs, and swapping its remaining parts for a plan of a
 * different length would renumber what they already read. The cost: a check
 * failed AFTER part 1 was read leaves a review that is already under way at
 * its review length; growing it would need a planner pass that keeps the parts
 * read and adds to them, which does not exist yet.
 */
export function planIsStale(nodeId, plan) {
    const have = safeParse(plan?.meta)?.headStart?.parts ?? null;
    const shape = planShape(nodeId);
    const want = shape.review ? shape.cap : null;
    if (have === want) return false;
    return !teachingStarted(nodeId);
}

/**
 * The next item missing from a node's teaching sequence, or null when the
 * sequence is complete (all planned lessons + questions exist or were skipped).
 *
 * Exported for `tools/head-start-gates.mjs`: it is the whole decision about
 * what a head start does to the ORDER of a topic's writing, and asking it
 * directly is the only way to assert that without a model in the room.
 */
export function nextMissing(nodeId) {
    const plan = db.prepare(`SELECT * FROM feed_items WHERE node_id = ? AND kind = 'plan' LIMIT 1`).get(nodeId);
    if (!plan) return { type: 'plan' };
    if (planIsStale(nodeId, plan)) return { type: 'plan', replace: true };
    const rawParts = safeParse(plan.content)?.parts;
    // Normalise to [{title, focus}] (tolerates legacy bare-string plans).
    const parts = Array.isArray(rawParts) ? rawParts.map(normalizePart).filter(Boolean) : [];
    if (parts.length === 0) return null; // corrupt plan — leave to degraded serving
    const planMeta = safeParse(plan.meta) || {};
    const skippedQ = planMeta.skippedQ || [];
    const rows = db.prepare(`
        SELECT seq, id, content, status FROM feed_items WHERE node_id = ? AND kind IN ('lesson', 'question')
    `).all(nodeId);
    const bySeq = new Map(rows.map(r => [r.seq, r]));
    // A topic that already OWNS a bank — an imported course's questions, or a
    // practice set written earlier — is asked from that bank (feed.js), so a
    // part the bank can ask about gets no authored question: it would be a
    // model call spent writing a question beside sixty vetted ones.
    //
    // But a bank covers the whole topic and says nothing about which part
    // teaches what, and asked at random after part 1 it put "why is the plural
    // of maan manen?" before the part on open syllables (Dutch course,
    // 2026-10-01). So once part 1 exists, one `bank-map` call places every
    // question at the earliest part that makes it answerable (plan meta
    // `bankParts`), and after part i the feed asks only what parts 1..i
    // taught. The last part can ask the whole bank. An earlier part that no
    // bank question belongs to gets its own question, written from the part —
    // as does every earlier part when the map failed, since then the whole
    // bank waits for the end. A part the learner has already READ gets none:
    // a question written now for it would only arrive after the next part.
    //
    // Two counts, on purpose. "Is there a bank" is every question the node
    // owns: a bank the verifier could not judge is still a bank, and writing
    // another one would meet the same verifier (and, counted by what is
    // PROVABLE, would be written again every burst for as long as it was
    // down). "Can the stream ask from it" is only what a draw hands out —
    // never a question no verifier confirmed (questionLog.js) — so until the
    // bank is confirmed the parts get their own questions, as an unbanked
    // topic's do.
    const bankWritten = ownedQuestions(nodeId) >= MIN_GATE_QUESTIONS;
    const banked = ownedQuestions(nodeId, { provable: true }) >= MIN_GATE_QUESTIONS;
    // A REVIEW offers its mastery check first — the chapter's banner says
    // "Prove it now" above part 1 — so its bank is written straight after part
    // 1 rather than at the end of the stream (`pendingMaterial`). After part 1,
    // not before: until a lesson exists the topic has no chapter in the feed,
    // so there is nowhere yet to press the button. Once the bank exists the
    // review is practised from it like any banked topic, and the check later
    // draws the questions the stream has not asked. Same switch and same
    // one-failure record as the look-ahead.
    const checkFirst = !!planMeta.headStart && getFeedSettings().prepareCheck && !planMeta.skippedCheck;
    // How many provable bank questions belong to each part (index = part).
    const perPart = new Array(parts.length + 1).fill(0);
    if (banked) {
        const partOf = bankPartLookup(planMeta, parts.length);
        for (const b of bankOf(nodeId)) if (b.question.unverified == null) perPart[partOf(b)]++;
    }
    for (let i = 1; i <= parts.length; i++) {
        const lesson = bySeq.get(i * 2 - 1);
        if (!lesson) return { type: 'lesson', i, parts, plan };
        if (checkFirst && !bankWritten) return { type: 'material', kind: 'mastery_check', plan };
        const read = lesson.status === 'consumed';
        const unasked = !bySeq.has(i * 2) && !skippedQ.includes(i);
        // The map is made only when it decides something: whether an unread
        // earlier part with no question yet needs one written. A bank that
        // arrives after every part has its question (the look-ahead's) is not
        // placed — it waits for the last part, as an unplaced bank does.
        if (banked && i < parts.length && !read && unasked && !planMeta.bankParts) return { type: 'bank-map', parts, plan };
        const askedFromBank = banked && (i === parts.length || read || perPart[i] > 0);
        if (!askedFromBank && unasked) return { type: 'question', i, parts, plan, lesson };
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
 * Study material the END of this topic needs, written while the learner is
 * still reading the beginning of it.
 *
 * The complaint this answers: a topic's last card is the mastery check, and the
 * gate only generates its questions when the learner opens it — so finishing a
 * topic meant sitting on "Generating questions…" for a model call. Measured on
 * the real library (the app's own rolling average, `bulk_avg_ms_*`): 24.3 s for
 * a bank, 17.1 s for a set of cards. And it is not the exception — 249 of 1,786
 * work leaves in active projects had a gate-ready bank, so 86% of topics ended
 * in that wait.
 *
 * Deliberately the LAST tier of the burst, after lessons, paper and widgets.
 * Everything above it is something the reader is looking at now; this is for
 * a card they have not reached. It runs only once `nextMissing` is null — a
 * topic is not ready for its check until it has actually been taught, and the
 * bank is written from the node's material either way.
 *
 * A failure is recorded on the plan (like `skippedPractice`) rather than
 * retried forever: the on-demand paths still work, so the worst case is exactly
 * the behaviour this replaced.
 *
 * Exported for `tools/material-lookahead-gates.mjs` alone: it is the whole
 * decision — what gets written ahead, and what must not be — and the only way
 * to assert it without a model in the room is to ask it directly.
 */
/**
 * Every non-ghost question the node owns, across every quiz row — the gate
 * reads them all, so "has a bank" is a question count, never a row count. A
 * node holding one 2-question quiz has a gate that can never fire.
 *
 * `provable` counts only what a draw may hand out: not a question a verifier
 * was asked about and could not confirm (server/questionTrust.js).
 */
function ownedQuestions(nodeId, { provable = false } = {}) {
    return db.prepare(`
        SELECT COALESCE(SUM((
            SELECT COUNT(*) FROM json_each(q.questions) je
            WHERE COALESCE(json_extract(je.value, '$.isGhost'), 0) = 0
            ${provable ? `AND json_extract(je.value, '$.unverified') IS NULL` : ''}
        )), 0) AS n
        FROM quizzes q WHERE q.node_id = ? AND json_valid(q.questions)
    `).get(nodeId).n;
}

export function pendingMaterial(nodeId) {
    const fs = getFeedSettings();
    if (!fs.prepareCheck && !fs.prepareCards) return null;
    if (nextMissing(nodeId)) return null; // still being taught
    const plan = db.prepare(`SELECT id, meta FROM feed_items WHERE node_id = ? AND kind = 'plan' LIMIT 1`).get(nodeId);
    if (!plan) return null;
    const meta = safeParse(plan.meta) || {};

    if (fs.prepareCheck && !meta.skippedCheck) {
        if (ownedQuestions(nodeId) < MIN_GATE_QUESTIONS) return { type: 'material', kind: 'mastery_check', plan };
    }

    if (fs.prepareCards && !meta.skippedCards) {
        const has = db.prepare(`SELECT 1 FROM flashcards WHERE node_id = ? LIMIT 1`).get(nodeId);
        if (!has) return { type: 'material', kind: 'flashcards', plan };
    }
    return null;
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

/**
 * Store a topic's lesson plan. With `replace`, the plan it supersedes goes
 * first, with every lesson and question written from it — in one transaction,
 * and only if the topic is STILL unstarted: the new plan took a model call to
 * produce, and a learner who began the old sequence meanwhile keeps it.
 * Practice and the question bank are left alone; neither was written from the
 * plan. Returns whether the plan was written.
 *
 * Exported for `tools/head-start-gates.mjs`, which cannot ask a model for the
 * plan but can assert what writing one does to the rows around it.
 */
export function writePlan(nodeId, parts, meta, { replace = false } = {}) {
    return db.transaction(() => {
        if (replace) {
            if (teachingStarted(nodeId)) return false;
            db.prepare(`DELETE FROM feed_items WHERE node_id = ? AND kind IN ('plan', 'lesson', 'question')`).run(nodeId);
        }
        db.prepare(`
            INSERT INTO feed_items (node_id, kind, seq, content, meta, status)
            VALUES (?, 'plan', 0, ?, ?, 'internal')
        `).run(nodeId, JSON.stringify({ parts }), JSON.stringify(meta));
        return true;
    })();
}

/** Generate exactly one missing item for a focus node. Throws on hard failure. */
async function generateOne(f, missing, signal) {
    // A second verdict on a question already written: no teaching context.
    if (missing.type === 'verify') {
        await reverifyOne(f, missing.entry, signal);
        return;
    }
    // A lesson stored before the fact audit or the drill check existed.
    if (missing.type === 'recheck') {
        await recheckLesson(f, missing, signal);
        return;
    }
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
            // …and in the shared record, which is what the card's offer reads:
            // it can then say the last build failed and why, rather than offer
            // the same model call as if it had never been tried.
            recordBuildFailure({ hash: specHash, kind: 'widget', error: err });
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
        // A topic with a head start is planned as a REVIEW (headStart.js): a
        // lower ceiling, and a planner told why. The cap is enforced as well as
        // requested, as the part count always has been.
        const shape = planShape(f.nodeId);
        const { system, user } = AI_PROMPTS.feed_outline(f.title, context, {
            siblings: siblingTitles(f.nodeId),
            actionNode,
            lang,
            reviewParts: shape.review ? shape.cap : null,
        });
        let parts = null;
        for (let attempt = 0; attempt < 2 && !parts; attempt++) {
            const resp = await generateResponse(user, system, [], { temperature: 0.4, signal });
            const parsed = parseObjectResponse(resp);
            const candidate = Array.isArray(parsed?.parts)
                ? parsed.parts.map(normalizePart).filter(Boolean).slice(0, shape.cap)
                : [];
            if (candidate.length >= MIN_PARTS) parts = candidate;
        }
        // No title in the message: it becomes the task's error, which the
        // activity log records verbatim, and that log promises no topic titles.
        // The failure record names the topic from its origin instead.
        if (!parts) throw new Error('Outline generation failed: two attempts returned no usable lesson plan');
        // A task node is one part, enforced rather than requested: the model is
        // asked for one and, left to itself, still returns four segments of
        // invented interface documentation. Truncating is safe — part 1 of such
        // a plan is always "what to do".
        if (actionNode && parts.length > 1) {
            console.warn(`[FeedGen] "${f.title}" is a task node — trimming ${parts.length} planned parts to 1`);
            parts = parts.slice(0, 1);
        }
        // What the plan was sized for rides on it, so `planIsStale` can tell
        // when the head start it assumed has come, gone or changed strength.
        const meta = {
            ...aiProvenanceFields(),
            ...(shape.review ? {
                headStart: {
                    parts: shape.cap,
                    prior: Math.round(shape.headStart.prior * 1000) / 1000,
                    source: shape.headStart.source,
                },
            } : {}),
        };
        if (writePlan(f.nodeId, parts, meta, { replace: !!missing.replace }) && missing.replace) {
            console.log(`[FeedGen] Re-planned "${f.title}" as ${shape.review ? `a review of ≤${shape.cap} parts` : 'a full sequence'} (its head start changed before it was started)`);
        }
        return;
    }

    if (missing.type === 'bank-map') {
        // Which part each bank question waits for (see nextMissing). Stems
        // and options only: what a question DEPENDS on is in its wording.
        const bank = bankOf(f.nodeId).filter(b => b.question.uuid);
        const stems = bank.map(({ question: q }) => {
            const opts = Array.isArray(q.options) && q.options.length ? ` [${q.options.join(' / ')}]` : '';
            return `${q.question || ''}${opts}`.replace(/\s+/g, ' ').slice(0, 400);
        });
        const n = missing.parts.length;
        let assigned = null;
        let failure = 'no questions with an identity';
        if (stems.length) {
            const { system, user } = AI_PROMPTS.feed_bank_parts(f.title, missing.parts, stems);
            for (let attempt = 0; attempt < 2 && !assigned; attempt++) {
                let resp;
                try {
                    resp = await generateResponse(user, system, [], { temperature: 0.2, signal, operation: 'authoring' });
                } catch (err) {
                    if (signal?.aborted || isTransient(err, signal)) throw err; // retried by generateStep
                    failure = err.message;
                    break;
                }
                const got = parseObjectResponse(resp)?.parts;
                const nums = Array.isArray(got) ? got.map(Number) : [];
                if (nums.length === stems.length && nums.every(p => Number.isInteger(p) && p >= 1 && p <= n)) assigned = nums;
                else failure = `answer did not place ${stems.length} questions in parts 1–${n}`;
            }
        }
        // Re-read the plan's meta: the burst may have written to it since
        // nextMissing looked. A failed map is recorded and not retried — the
        // whole bank then waits for the last part, which is safe.
        const plan = db.prepare(`SELECT id, meta FROM feed_items WHERE id = ?`).get(missing.plan.id);
        if (!plan) return;
        const meta = safeParse(plan.meta) || {};
        meta.bankParts = assigned
            ? { map: Object.fromEntries(bank.map((b, k) => [b.question.uuid, assigned[k]])), ...aiProvenanceFields() }
            : { failed: true };
        db.prepare(`UPDATE feed_items SET meta = ? WHERE id = ?`).run(JSON.stringify(meta), plan.id);
        if (assigned) {
            const counts = Array.from({ length: n }, (_, k) => assigned.filter(p => p === k + 1).length);
            console.log(`[FeedGen] Placed ${assigned.length} bank questions across ${n} parts: ${counts.join(' / ')}`);
        } else {
            console.warn(`[FeedGen] Bank questions not placed by part (${failure}); the bank waits for the last part`);
        }
        return;
    }

    if (missing.type === 'material') {
        try {
            const { count } = await generateMaterial(f.nodeId, missing.kind, {
                questionCount: MATERIAL_QUESTIONS, cardCount: MATERIAL_CARDS, signal,
            });
            console.log(`[FeedGen] Prepared ${count} ${missing.kind === 'flashcards' ? 'cards' : 'questions'} ahead of "${f.title}"`);
        } catch (err) {
            if (signal?.aborted || isTransient(err, signal)) throw err; // retried by generateStep
            // The model could not write usable material for this topic. Record
            // it and move on: the mastery check and the card panel both still
            // generate on demand, so the learner is no worse off than before
            // this tier existed — and a topic that fails every burst would
            // otherwise spend the whole background budget on itself.
            const meta = safeParse(missing.plan.meta) || {};
            meta[missing.kind === 'flashcards' ? 'skippedCards' : 'skippedCheck'] = true;
            db.prepare(`UPDATE feed_items SET meta = ? WHERE id = ?`).run(JSON.stringify(meta), missing.plan.id);
            console.warn(`[FeedGen] Skipped ${missing.kind} for "${f.title}": ${err.message}`);
        }
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
        // Plus where the topic sits in its COURSE: the neighbours either side
        // with how long ago the learner was at each, and the previous topic as
        // it was actually shown to them (courseContext.js). Orientation only —
        // the block carries its own rules (never "as you just learned", never
        // pre-empt a later topic), and it goes to the lesson writer alone: the
        // question writer below keeps the pinned context, because a list of
        // neighbouring titles with dates beside them is exactly the filing a
        // question writer turns into a question about the app.
        //
        // And, when the course keeps documents, the passages of them that match
        // this part (lessonSources.js): numbered, cited as [[src:N]], resolved
        // into a Sources line of document titles before the row is stored. A
        // course without document text appends '' — its prompt is unchanged.
        // Retrieved once per part, not per attempt: a rewrite fixes a fault in
        // the draft, and the passages are not where the fault was.
        const partInfo = missing.parts[missing.i - 1] || {};
        const grounding = await lessonSourcesFor(f.nodeId, {
            topicTitle: f.title, partTitle: partInfo.title, partFocus: partInfo.focus,
        });
        const lessonContext = buildNodeContext(f.nodeId, { completedTopics: true }) + courseContextForNode(f.nodeId) + grounding.text;
        const priorParts = collectPriorParts(f.nodeId, missing.parts, missing.i);
        // A plan sized as a review is written as one, part by part. Read off
        // the PLAN, not the live head start: the parts must agree with the
        // outline they belong to, and a changed head start re-plans instead.
        const review = !!safeParse(missing.plan?.meta)?.headStart;

        // Write, check, rewrite — and CARRY THE REASON into each rewrite. The
        // loop used to re-issue an identical prompt, which at temperature 0.6
        // mostly reproduces the same draft with the same fault; a rewrite that
        // is told which sentence failed usually fixes it on the next pass.
        //
        // Three gates run per draft, cheapest first, and each can send the draft
        // back: mechanical defects (free), then the visual check, then the
        // audit of its facts and arithmetic. The visual check is self-gating (no
        // checkable visual, no call); the audit runs on every draft, because a
        // prose lesson states facts as confidently as a worked example states
        // numbers, and until 2026-10-01 nothing read them. Then, once, on the
        // draft that will be served: the answer keys of its drills.
        let md = null;
        let vetted = null;
        let fault = null;      // what sent the last draft back, fed to the next
        let unresolved = null; // the fault still standing when attempts ran out
        let unaudited = null;  // the audit that could not run on the draft served
        let auditRead = false; // whether an auditor actually READ the draft served
        for (let attempt = 0; attempt < LESSON_ATTEMPTS; attempt++) {
            auditRead = false;
            const { system, user } = AI_PROMPTS.feed_lesson(
                f.title, missing.parts, missing.i, lessonContext, priorParts,
                {
                    allowWidget: getFeedSettings().widgets && !nodeHasWidget(f.nodeId),
                    actionNode: isActionNode(f.title),
                    runningExample: runningExampleFrom(priorParts),
                    lang,
                    priorFault: fault,
                    review,
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

            // Nothing else in this pipeline reads the teaching's own facts and
            // arithmetic, which is where a model states things from memory and
            // hand-computes, and therefore where it is most likely to be wrong.
            const audit = await auditLesson(f.title, partTitle, check.markdown, { priorParts, signal });
            auditRead = audit.available !== false;
            if (audit.ok) {
                unresolved = null;
                unaudited = audit.available === false ? audit.reason : null;
                break;
            }
            fault = audit.quote ? `${audit.reason}\nThe faulty step was: "${audit.quote}"` : audit.reason;
            unresolved = { stage: audit.computes ? 'math' : 'fact', reason: audit.reason, quote: audit.quote || undefined };
            console.warn(`[FeedGen] Rewriting "${f.title}" part ${missing.i} (audit): ${audit.reason}`);
        }

        // A drill's items are prompt → answer pairs the player grades against,
        // and the one model-written key nothing used to check. Disputed items
        // come out; the lesson is not rewritten for them (feedQuality.js).
        const drills = await vetLessonDrills(vetted ? vetted.markdown : md, f.title, { signal });
        for (const r of drills.removed) {
            console.warn(`[FeedGen] Drill on "${f.title}" part ${missing.i}: removed ${r.prompt ? `"${r.prompt}" → "${r.key}"` : 'the drill'} (${r.reason})`);
        }
        if (vetted) vetted = { ...vetted, markdown: drills.markdown };
        else md = drills.markdown;

        if (unresolved) {
            // Every attempt failed a gate. Serving the last draft still beats
            // stalling the topic — nextMissing would hand back the same part
            // forever — but the fault is recorded on the row rather than only
            // logged, so tools/feed-audit.mjs can count it and the card can be
            // re-authored deliberately instead of silently teaching a bad step.
            console.warn(`[FeedGen] Serving "${f.title}" part ${missing.i} with an unresolved ${unresolved.stage} fault: ${unresolved.reason}`);
        }

        // The markers become a Sources line of document titles, exactly as a
        // chat answer's do; one naming a passage that was not offered is
        // dropped. A lesson written without passages is stored as written.
        const { text: stored, cited } = resolveLessonCitations(vetted ? vetted.markdown : md, grounding.sources);
        db.prepare(`
            INSERT INTO feed_items (node_id, kind, seq, content, meta, status)
            VALUES (?, 'lesson', ?, ?, ?, 'ready')
        `).run(f.nodeId, missing.i * 2 - 1, stored, JSON.stringify({
            ...JSON.parse(partMeta),
            // What the writer was offered and what it cited — by document id
            // and passage, so tools/feed-audit.mjs can tell a grounded lesson
            // from one that ignored its passages. Absent without documents.
            ...(grounding.passages.length ? {
                sources: grounding.passages.map((p, i) => ({ n: i + 1, documentId: p.documentId, chunkIndex: p.chunkIndex })),
                cited: cited.length,
            } : {}),
            ...(vetted?.removed.length ? { visualsRemoved: vetted.removed } : {}),
            ...(vetted?.unchecked?.length ? { visualsUnchecked: vetted.unchecked } : {}),
            ...(drills.removed.length ? { drillItemsRemoved: drills.removed } : {}),
            ...(drills.unchecked.length ? { drillsUnchecked: drills.unchecked } : {}),
            ...(unresolved ? { unresolvedFault: unresolved } : {}),
            ...(unaudited ? { unaudited } : {}),
            // Cleared every gate. Recorded so tools/feed-audit.mjs can count the
            // rows written BEFORE these gates existed: feed_items is a cache, so
            // those never improve on their own and are the feed-regen backlog.
            // A gate that could not RUN was not cleared: an unreachable auditor
            // or visual checker leaves the stamp off, so the row is counted
            // with the backlog instead of passing for checked. `factChecked`
            // and `drillsChecked` say which generation of the audit it cleared
            // — rows stamped `audited` before 2026-10-01 had their arithmetic
            // read and nothing else, and the background tier re-reads those.
            ...(unresolved || unaudited || vetted?.unchecked?.length || drills.unchecked.length ? {} : { audited: true }),
            ...(auditRead ? { factChecked: true } : {}),
            ...(drills.unchecked.length ? {} : { drillsChecked: true }),
        }));
        return;
    }

    // Question for part i. A broken question is skipped, never served — a
    // lesson without a question beats a card with a wrong answer key.
    // The lesson as TAUGHT, without a Sources line: a question about which
    // document said what tests the filing, not the subject (citationFaults is
    // the gate behind this, for a writer that echoes one anyway).
    const lessonText = teachingText(missing.lesson.content).slice(0, LESSON_CONTEXT_CHARS);
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
    let questionCheck = null; // the verifier's verdict on whichever question is served
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
        const defects = [...questionDefects(candidate, f.nodeId), ...citationFaults(candidate)];
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
        let check = await verifyQuestion(f.title, candidate, { signal });
        // No verdict is not a pass. One more ask (a reasoning model that spent
        // its reply thinking often answers the second time); after that the
        // question is served, but STAMPED unverified on its stored content
        // (questionTrust.js): practice, never proof, until the re-verification
        // tier below confirms it. Re-authoring would only produce another
        // question the same verifier cannot answer about.
        if (check.available === false) check = await verifyQuestion(f.title, candidate, { signal });
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
        if (!weaknesses.length) { question = candidate; questionCheck = check; break; }

        if (!fallback) fallback = { candidate, weaknesses, check };
        fault = weaknesses.join('; ');
        console.warn(`[FeedGen] Weak question for "${f.title}" part ${missing.i}, retrying: ${fault}`);
    }
    }

    // Nothing sound was authored, but something correct-if-weak was: serve it
    // with the weakness recorded rather than leaving the part unchecked.
    let servedWeaknesses = null;
    if (!question && fallback) {
        question = fallback.candidate;
        questionCheck = fallback.check;
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
    // The stamp rides on the CONTENT, which is what the card, the answer's
    // evidence check and the re-verification tier all read; the meta keeps the
    // record tools/feed-audit.mjs counts.
    const unchecked = questionCheck?.available === false;
    const storedQuestion = unchecked ? markUnverified(question, questionCheck.reason) : question;
    db.prepare(`
        INSERT INTO feed_items (node_id, kind, seq, content, meta, status)
        VALUES (?, 'question', ?, ?, ?, 'ready')
    `).run(f.nodeId, missing.i * 2, JSON.stringify(storedQuestion), JSON.stringify({
        partIndex: missing.i,
        partCount: missing.parts.length,
        partTitle,
        questionType: question.type,
        // What the cold solve SAID, not that it was asked: false when the
        // verifier could not answer, with its reason beside it.
        verified: questionCheck?.available !== false,
        ...(questionCheck?.available === false ? { unverified: questionCheck.reason } : {}),
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
            // Then the lessons already WRITTEN for these topics that predate a
            // check (pendingLessonCheck): they are the cards on screen now, so
            // they go before anything that only adds to the stream, and they
            // run whatever the buffer says.
            if (!hit) {
                hit = pickTarget([...wanted, ...teachable], f => pendingLessonCheck(f.nodeId));
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
            // Last of all: the mastery check bank and the flashcards this topic
            // ends on. Everything above is on screen now; this is for a card the
            // learner has not reached, so it may never delay one they have.
            if (!hit) {
                hit = pickTarget(teachable, f => pendingMaterial(f.nodeId));
            }
            // After even that: a second verdict on a question the verifier
            // could not judge when it was written, for topics a draw had to
            // hold one back from and the focus window's. Nothing on screen
            // waits on it; until it lands the question is practice only.
            if (!hit) {
                hit = pickTarget([...heldBackTargets(), ...teachable], f => pendingVerification(f.nodeId), f => heldBack.delete(f.nodeId));
            }
            if (!hit) break; // every focus sequence is complete
            const { target, missing } = hit;

            if (!handle) {
                handle = tasks.registerExternal({
                    kind: 'feed',
                    label: 'Preparing feed lessons',
                    labelKey: 'Preparing feed lessons',
                    // Nobody pressed anything: the app is writing ahead of the
                    // reader. The topic it is on is added at each step below.
                    origin: { surface: 'app', job: 'feed' },
                    cancel: () => { cancelled = true; controller.abort(); },
                });
            }
            // …and WHICH topic, so the record can say "prepared for your feed:
            // <topic>" and take the reader to that topic's stream.
            handle.setOrigin({ surface: 'app', job: 'feed', nodeId: target.nodeId, projectId: target.projectId });
            // WHICH COURSE this chip is working on, right now. The sweep walks
            // the whole library, so it has no one project for its lifetime —
            // but it always has one for the step it is taking, and the dot on
            // the chip is the only thing that says which. Registered without a
            // project it drew the ambient accent, which meant the colour
            // followed the reader from screen to screen instead of the work.
            handle.setProject(target.projectId, target.projectName, target.projectColor);
            const detail = missing.type === 'plan' ? 'outline'
                : missing.type === 'widget' ? 'building widget'
                : missing.type === 'material' ? (missing.kind === 'flashcards' ? 'flashcards' : 'mastery check')
                : missing.type === 'verify' ? 'checking a question'
                : missing.type === 'recheck' ? 'checking a lesson'
                : missing.type === 'bank-map' ? 'placing questions by part'
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
    const MAX_STEPS = MAX_PARTS * 2 + 5; // + plan, bank-map, practice, slack
    for (let step = 0; step < MAX_STEPS; step++) {
        const missing = nextMissing(nodeId) || (() => {
            const w = pendingWidget(nodeId);
            return w ? { type: 'widget', ...w } : null;
        })();
        if (!missing) break;
        onStep?.(missing.type === 'plan' ? 'outline'
            : missing.type === 'widget' ? 'widget'
                : missing.type === 'practice' ? 'paper exercise'
                    : missing.type === 'bank-map' ? 'question placement'
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
    // Questions written before the unverified stamp lived on the content
    // carry it only in their row's meta (`verified: false`); move it onto the
    // question so the card shows it and the re-verification tier can reach
    // it. Idempotent, one query when there is nothing to move.
    try {
        const moved = adoptLegacyFeedFlags();
        if (moved) console.log(`[FeedGen] Marked ${moved} earlier unchecked feed question(s) as practice until they are verified`);
    } catch (err) {
        console.warn('[FeedGen] could not carry the old unverified flags onto their questions:', err.message);
    }
    setTimeout(ensureBuffer, delayMs).unref();
}

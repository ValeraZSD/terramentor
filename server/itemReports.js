// "This is wrong": the learner's report on one item that tests or teaches them.
//
// One module behind both doors — the flag on the item and the assistant's
// prepared report (server/routes/itemReports.js; the assistant only prepares,
// the learner's press sends the same request). What a report does, per kind:
//
//   - Its answers count neither way. Evidence rows that hold it lose it: a row
//     that was only this item is deleted, a sitting that held it is re-scored
//     without it (and below MIN_GATE_QUESTIONS stops being an assessment), and
//     the topic's estimate is replayed from what is left (`rescoreNode`).
//   - It is not served again: a bank question leaves every bank holding it, a
//     feed row is closed, a model-written card is deleted and the learner's
//     own card is parked until they edit it, a drill item is filtered out on
//     the client by the reports listed here, a probe question stops seeding.
//   - Undo puts back exactly what was taken, from the record the report kept.
//
// The note is the learner's own words: it is kept here and handed to the
// rewrite's prompt, never written to the activity log (metadata only).

import db, { NOW_ISO } from './database.js';
import { getNodeMastery, rescoreNode } from './mastery.js';
import { logActivity } from './activityLog.js';
import { getProbeById, applyProbeSeeds } from './placement.js';
import { findDrills, parseDrillBody } from './drillCheck.js';
import { bankRefOfFeedKey } from './questionTrust.js';
import { cardAnswerIsCorrect } from './cardEvidence.js';
import { askedAs } from './sittingReview.js';

export const REPORT_REASONS = ['wrong', 'unclear', 'off_topic', 'other'];
export const REPORT_NOTE_MAX = 1000;
// Where a report was sent from: a closed vocabulary, so it may reach the
// activity log beside the kind and the reason.
export const REPORT_SURFACES = new Set([
    'feed', 'quiz', 'mastery_check', 'placement', 'drill', 'review', 'lesson', 'paper', 'topic', 'assistant',
]);

// A parked card's next review: past every due query (`next_review <= now`)
// and not NULL, which the queues read as a new card.
export const PARKED_UNTIL = '9999-12-31T00:00:00.000Z';

const UUID = /^[A-Za-z0-9-]{8,64}$/;

// Every statement is prepared once, by its text: a report walks banks,
// evidence rows and review logs in loops, and the page context asks about
// each item on screen.
const prepared = new Map();
function stmt(sql) {
    let s = prepared.get(sql);
    if (!s) { s = db.prepare(sql); prepared.set(sql, s); }
    return s;
}

const safeParse = (text, fallback = null) => {
    if (text == null) return fallback;
    try { return JSON.parse(text) ?? fallback; } catch { return fallback; }
};

/** FNV-1a, 32 bits — `drillItemKey` in src/components/drills/parseDrill.ts. */
function fnv(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}

/** One drill item's identity: a card's id in the card drill, else its prompt and key. */
export function drillItemKey({ prompt, answer, cardId = null }) {
    if (Number.isSafeInteger(cardId) && cardId > 0) return `c${cardId}`;
    return `i${fnv(`${String(prompt ?? '')}\u0000${String(answer ?? '')}`)}`;
}

/**
 * The drill's identity among a topic's drills — `drillKeyOf` on the client,
 * which hashes the fence's text as the markdown renderer hands it over: without
 * its last newline (Markdown.tsx).
 */
function drillKeyOf(body) { return `f${fnv(String(body).replace(/\n$/, ''))}`; }

/**
 * What a ref names, or null. Refs are the client's and the assistant's way to
 * point at an item; the server resolves every one against its own copy.
 *   fi:<feedItemId>                 a feed row (question, lesson, paper exercise)
 *   q:<uuid>                        a bank question, wherever it is asked
 *   card:<id>                       a flashcard
 *   probe:<probeId>:<index>         a placement question
 *   drill:<nodeId>:<drillKey>:<itemKey>   one item of a drill
 */
export function parseRef(ref) {
    const s = String(ref ?? '').trim();
    let m;
    if ((m = /^fi:(\d{1,12})$/.exec(s))) return { type: 'fi', feedItemId: Number(m[1]) };
    if ((m = /^q:(.+)$/.exec(s)) && UUID.test(m[1])) return { type: 'q', uuid: m[1] };
    if ((m = /^card:(\d{1,12})$/.exec(s))) return { type: 'card', cardId: Number(m[1]) };
    if ((m = /^probe:(\d{1,12}):(\d{1,3})$/.exec(s))) return { type: 'probe', probeId: Number(m[1]), index: Number(m[2]) };
    if ((m = /^drill:(\d{1,12}):(f[0-9a-f]{8}|cards):((?:i[0-9a-f]{8})|(?:c\d{1,12}))$/.exec(s))) {
        const itemKey = m[3].startsWith('c') ? `c${Number(m[3].slice(1))}` : m[3];
        return { type: 'drill', nodeId: Number(m[1]), drillKey: m[2], itemKey };
    }
    return null;
}

/**
 * The one spelling of a ref (`card:007` is `card:7`), or null. Reports are
 * found by this text, so every ref is spelled this way before it is looked up
 * or stored: a second spelling would file a second report on one item.
 */
export function canonicalRef(ref) {
    const p = parseRef(ref);
    return p ? refOf(p) : null;
}

const projectOf = (nodeId) => stmt('SELECT project_id FROM nodes WHERE id = ?').get(nodeId)?.project_id ?? null;

// ---- resolving --------------------------------------------------------------

/** Every bank row holding this question: its own copy and review copies elsewhere. */
function banksHolding(uuid) {
    const rows = stmt(`SELECT id, node_id, questions FROM quizzes WHERE instr(questions, ?) > 0`).all(uuid);
    const out = [];
    for (const r of rows) {
        const qs = safeParse(r.questions);
        if (!Array.isArray(qs)) continue;
        qs.forEach((q, index) => { if (q && typeof q === 'object' && q.uuid === uuid) out.push({ quizId: r.id, nodeId: r.node_id, index, question: q }); });
    }
    return out;
}

/** The question's own topic: the bank that holds it as its own, else the topic a review copy names. */
function questionHome(holders) {
    const own = holders.find(h => !h.question.isGhost);
    if (own) return { nodeId: own.nodeId, question: own.question };
    const ghost = holders[0];
    return ghost ? { nodeId: Number(ghost.question.ghostNodeId) || ghost.nodeId, question: ghost.question } : null;
}

/** What a question looks like to the learner and to the assistant: no stamps, no bookkeeping. */
function questionView(q) {
    if (!q || typeof q !== 'object') return null;
    const out = { question: q.question, type: q.type || 'multiple_choice' };
    for (const k of ['options', 'correct_answer', 'explanation', 'tolerance', 'unit', 'items', 'language']) {
        if (q[k] !== undefined) out[k] = q[k];
    }
    return out;
}

/** Text of a drill's home: the topic's Overview, its Material notes and its lesson rows. */
function drillSources(nodeId) {
    const texts = [];
    const node = stmt('SELECT description FROM nodes WHERE id = ?').get(nodeId);
    if (node?.description) texts.push(node.description);
    for (const n of stmt('SELECT description FROM nodes WHERE parent_id = ? AND is_note = 1').all(nodeId)) {
        if (n.description) texts.push(n.description);
    }
    for (const r of stmt(`SELECT content FROM feed_items WHERE node_id = ? AND kind = 'lesson'`).all(nodeId)) {
        if (r.content) texts.push(r.content);
    }
    return texts;
}

function findDrillItem(nodeId, drillKey, itemKey) {
    if (drillKey === 'cards') {
        const m = /^c(\d+)$/.exec(itemKey);
        const card = m ? stmt('SELECT id, node_id, front, back FROM flashcards WHERE id = ?').get(Number(m[1])) : null;
        return card && card.node_id === nodeId ? { prompt: card.front, answer: card.back, cardId: card.id } : null;
    }
    for (const text of drillSources(nodeId)) {
        for (const d of findDrills(text)) {
            if (drillKeyOf(d.body) !== drillKey) continue;
            const parsed = parseDrillBody(d.body);
            const hit = parsed?.items.find(it => drillItemKey(it) === itemKey);
            if (hit) return { prompt: hit.prompt, answer: hit.answer, title: parsed.title || null };
        }
    }
    return null;
}

/**
 * The item a ref names, as the server holds it, or null.
 * `{ ref, kind, nodeId, projectId, item, modelWritten }` — `kind` is what the
 * learner sees: question | lesson | paper | card | drill | probe.
 */
export function resolveTarget(ref) {
    const p = typeof ref === 'string' ? parseRef(ref) : ref;
    if (!p) return null;
    return liveTarget(p) || reportedTarget(p);
}

/**
 * An item a standing report took away (a question out of its bank, a model's
 * card deleted, a lesson out for a rewrite) is still on the learner's screen
 * until they move on: it is named by the copy the report kept, so the
 * assistant can still talk about it and the flag can still show its Undo.
 */
function reportedTarget(p) {
    const ref = refOf(p);
    const row = ref ? activeFor(ref) : null;
    if (!row) return null;
    return {
        ref, kind: row.kind, nodeId: row.node_id, projectId: row.project_id,
        item: safeParse(row.item, {})?.view ?? null, modelWritten: row.kind !== 'card' || !!safeParse(row.undo, {})?.card,
        parsed: p, gone: true,
    };
}

function refOf(p) {
    if (p.type === 'fi') return `fi:${p.feedItemId}`;
    if (p.type === 'q') return `q:${p.uuid}`;
    if (p.type === 'card') return `card:${p.cardId}`;
    if (p.type === 'probe') return `probe:${p.probeId}:${p.index}`;
    if (p.type === 'drill') return `drill:${p.nodeId}:${p.drillKey}:${p.itemKey}`;
    return null;
}

function liveTarget(p) {
    if (p.type === 'fi') {
        const row = stmt('SELECT id, node_id, kind, seq, content, status FROM feed_items WHERE id = ?').get(p.feedItemId);
        if (!row) return null;
        const kind = row.kind === 'question' ? 'question' : row.kind === 'lesson' ? 'lesson' : row.kind === 'practice' ? 'paper' : null;
        if (!kind) return null;
        const content = kind === 'lesson' ? row.content : safeParse(row.content);
        const item = kind === 'question' ? questionView(content)
            // The brief only: the reference solution is the key, kept off every
            // card until the learner has worked it (server/feed.js).
            : kind === 'paper' ? { brief: content?.brief || '' }
            : { text: String(content || '').slice(0, 4000) };
        return { ref: `fi:${row.id}`, kind, nodeId: row.node_id, projectId: projectOf(row.node_id), item, modelWritten: true, parsed: p };
    }
    if (p.type === 'q') {
        const holders = banksHolding(p.uuid);
        const home = questionHome(holders);
        if (!home) return null;
        return { ref: `q:${p.uuid}`, kind: 'question', nodeId: home.nodeId, projectId: projectOf(home.nodeId), item: questionView(home.question), modelWritten: true, parsed: p };
    }
    if (p.type === 'card') {
        const card = stmt('SELECT id, node_id, front, back, generated_by FROM flashcards WHERE id = ?').get(p.cardId);
        if (!card) return null;
        return {
            ref: `card:${card.id}`, kind: 'card', nodeId: card.node_id, projectId: projectOf(card.node_id),
            item: { front: card.front, back: card.back }, modelWritten: card.generated_by != null, parsed: p,
        };
    }
    if (p.type === 'probe') {
        const probe = getProbeById(p.probeId);
        const q = probe?.questions?.[p.index];
        if (!q) return null;
        // A probe question leaves the server without its key until it is
        // answered (routes/placement.js): the report's preview keeps that.
        const item = questionView(q);
        if (!(probe.answers || []).some(a => Number(a?.questionIndex) === p.index)) {
            delete item.correct_answer;
            delete item.explanation;
        }
        return { ref: `probe:${p.probeId}:${p.index}`, kind: 'probe', nodeId: q.node_id ?? null, projectId: probe.projectId, item, modelWritten: true, parsed: p };
    }
    if (p.type === 'drill') {
        const hit = findDrillItem(p.nodeId, p.drillKey, p.itemKey);
        if (!hit) return null;
        return {
            ref: `drill:${p.nodeId}:${p.drillKey}:${p.itemKey}`, kind: 'drill', nodeId: p.nodeId, projectId: projectOf(p.nodeId),
            item: { prompt: hit.prompt, answer: hit.answer }, modelWritten: p.drillKey !== 'cards', parsed: p,
        };
    }
    return null;
}

// ---- evidence ---------------------------------------------------------------

const evidenceRow = (id) => stmt('SELECT * FROM mastery_evidence WHERE id = ?').get(id);

/**
 * Take a share out of one evidence row: `ds` of its score and `dt` of its total,
 * the voided entries moved to `metadata.voided`. A row left with nothing is
 * deleted, its sitting review with it. The before-image goes on `undo`.
 */
function shrinkEvidence(undo, row, { ds, dt, keep = null, voided = [] }) {
    if (dt <= 0) return;
    const sitting = stmt('SELECT * FROM sitting_reviews WHERE evidence_id = ?').get(row.id) || null;
    const total = row.total - dt;
    const score = Math.max(0, Math.min(total, row.score - ds));
    if (total <= 0) {
        stmt('DELETE FROM mastery_evidence WHERE id = ?').run(row.id);
    } else {
        const meta = safeParse(row.metadata, {}) || {};
        if (keep) meta.items = keep;
        meta.voided = [...(Array.isArray(meta.voided) ? meta.voided : []), ...voided];
        stmt('UPDATE mastery_evidence SET score = ?, total = ?, metadata = ? WHERE id = ?')
            .run(score, total, JSON.stringify(meta), row.id);
    }
    // The before-image, and this report's own share of the row: two reports
    // can take items out of one sitting, and undoing the first must give back
    // only what it took (`restoreEvidence`).
    undo.evidence.push({ before: row, sitting, share: { ds: row.score - score, dt, voided }, after: total <= 0 ? null : evidenceRow(row.id) });
    const n = undo.moved[row.node_id] || (undo.moved[row.node_id] = { score: 0, total: 0 });
    // Placement rows never moved the counters (no BKT on a probe answer).
    if (row.evidence_type !== 'placement') { n.score += Math.min(ds, row.score); n.total += dt; }
}

/** Void the entries of `metadata.items` that `match` picks, on every row given. */
function voidItems(undo, rows, match) {
    for (const row of rows) {
        const meta = safeParse(row.metadata, null);
        if (!Array.isArray(meta?.items)) continue;
        const hit = meta.items.filter(match);
        if (!hit.length) continue;
        shrinkEvidence(undo, row, {
            ds: hit.filter(e => e?.c).length,
            dt: hit.length,
            keep: meta.items.filter(e => !match(e)),
            voided: hit,
        });
    }
}

/** Snapshot every touched topic's estimate, then replay each from what is left. */
function rescoreTouched(undo, nodesBefore) {
    for (const [nodeId, before] of nodesBefore) {
        // Nothing was taken from this topic (an item never answered): its
        // estimate is left exactly as it is.
        if (!undo.evidence.some(e => e.before.node_id === nodeId)) continue;
        const moved = undo.moved[nodeId] || { score: 0, total: 0 };
        rescoreNode(nodeId, { score: -moved.score, total: -moved.total });
        undo.mastery.push({ before, after: getNodeMastery(nodeId) });
    }
}

const masteryNow = (nodeId) => ({ ...getNodeMastery(nodeId) });

/** How many answers the reports not undone took out of one evidence row (their before-images say). */
function takenFromRow(row) {
    return stmt('SELECT undo FROM item_reports WHERE node_id IS ? AND undone_at IS NULL').all(row.node_id)
        .flatMap(r => safeParse(r.undo, {})?.evidence || [])
        .filter(e => e?.before?.id === row.id)
        .reduce((n, e) => n + (Number(e.share?.dt) || 0), 0);
}

// ---- per kind ---------------------------------------------------------------

function reportBankQuestion(undo, target) {
    const { uuid } = target.parsed;
    const holders = banksHolding(uuid);
    const home = questionHome(holders);
    const stem = typeof home?.question?.question === 'string' ? home.question.question : null;
    // Review copies made before copies kept their source's uuid: the same stem
    // asked as a review of the same topic. Looked for as it is written inside
    // the stored JSON (quotes and newlines escaped).
    const needle = stem ? JSON.stringify(stem).slice(1, -1) : null;
    const ghostCopies = (needle ? stmt(`SELECT id, questions FROM quizzes WHERE instr(questions, ?) > 0`).all(needle) : [])
        .flatMap(r => {
            const qs = safeParse(r.questions);
            return Array.isArray(qs) ? qs.map((q, index) => ({ quizId: r.id, index, question: q })) : [];
        })
        .filter(h => h.question?.isGhost && h.question.question === stem && Number(h.question.ghostNodeId) === Number(target.nodeId)
            && h.question.uuid !== uuid);
    const all = [...holders, ...ghostCopies];
    const uuids = new Set([uuid, ...ghostCopies.map(h => h.question.uuid).filter(Boolean)]);
    const positions = all.map(h => ({ quizId: h.quizId, index: h.index }));

    // Evidence first, while the legacy feed keys still point at their positions.
    const rows = stmt(`SELECT * FROM mastery_evidence WHERE node_id = ? AND evidence_type IN ('quiz', 'mastery_check') ORDER BY id`).all(target.nodeId);
    voidItems(undo, rows, e => uuids.has(e?.u));
    for (const row of rows) {
        if (undo.evidence.some(x => x.before.id === row.id)) continue;
        const meta = safeParse(row.metadata, null);
        if (meta?.source !== 'feed') continue;
        const byUuid = typeof meta.uuid === 'string' && uuids.has(meta.uuid);
        const ref = !meta.uuid ? bankRefOfFeedKey(meta.key) : null;
        const byPlace = ref && positions.some(p => p.quizId === ref.quizId && p.index === ref.index);
        if (byUuid || byPlace) shrinkEvidence(undo, row, { ds: row.score, dt: row.total });
    }
    // A sitting recorded before evidence named its items (an older version):
    // its kept record (`sitting_reviews`) says which questions it asked and
    // how each went. Only a complete record, one entry per counted answer,
    // is matched, by the stem and the key (`askedAs`: a twin with the same
    // stem keeps its answer). The record is never shortened, so the answers
    // earlier reports already took out of the row are counted back first:
    // after one report the row holds one answer fewer than its record lists.
    if (stem) {
        for (const row of rows) {
            if (undo.evidence.some(x => x.before.id === row.id)) continue;
            const meta = safeParse(row.metadata, null);
            if (Array.isArray(meta?.items) || meta?.source === 'feed') continue;
            const review = safeParse(stmt('SELECT items FROM sitting_reviews WHERE evidence_id = ?').get(row.id)?.items, null);
            if (!Array.isArray(review) || review.length !== row.total + takenFromRow(row)) continue;
            const hit = review.filter(e => askedAs(e, home.question));
            if (hit.length) shrinkEvidence(undo, row, { ds: hit.filter(e => e.correct === true).length, dt: hit.length });
        }
    }

    // Then out of every bank, highest index first so the rest keep theirs.
    const byQuiz = new Map();
    for (const h of all) {
        if (!byQuiz.has(h.quizId)) byQuiz.set(h.quizId, []);
        byQuiz.get(h.quizId).push(h);
    }
    for (const [quizId, hs] of byQuiz) {
        const row = stmt('SELECT * FROM quizzes WHERE id = ?').get(quizId);
        const qs = safeParse(row?.questions);
        if (!Array.isArray(qs)) continue;
        const taken = [];
        for (const h of [...hs].sort((a, b) => b.index - a.index)) {
            const at = qs[h.index]?.uuid === h.question.uuid && qs[h.index]?.question === h.question.question ? h.index : -1;
            if (at < 0) continue;
            taken.push({ index: at, question: qs[at] });
            qs.splice(at, 1);
        }
        if (!taken.length) continue;
        stmt('UPDATE quizzes SET questions = ? WHERE id = ?').run(JSON.stringify(qs), quizId);
        undo.banks.push({ quizId, taken: taken.reverse() });
    }
}

function reportFeedRow(undo, target) {
    const id = target.parsed.feedItemId;
    const row = stmt('SELECT * FROM feed_items WHERE id = ?').get(id);
    undo.feedRow = row;
    const result = safeParse(row.result, null);
    if (row.status === 'ready') {
        stmt(`UPDATE feed_items SET status = 'consumed', consumed_at = ${NOW_ISO}, result = ? WHERE id = ?`)
            .run(JSON.stringify({ reported: true }), id);
    } else {
        stmt('UPDATE feed_items SET result = ? WHERE id = ?').run(JSON.stringify({ ...(result || {}), reported: true }), id);
    }
    if (target.kind === 'question') {
        const rows = stmt(`SELECT * FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'quiz' ORDER BY id`).all(target.nodeId);
        for (const r of rows) {
            const meta = safeParse(r.metadata, null);
            if (meta?.source === 'feed' && meta.key === `fi-${id}`) shrinkEvidence(undo, r, { ds: r.score, dt: r.total });
        }
    }
    if (target.kind === 'paper') {
        const attempts = new Set(stmt('SELECT id FROM paper_attempts WHERE feed_item_id = ?').all(id).map(a => a.id));
        const rows = stmt(`SELECT * FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'paper' ORDER BY id`).all(target.nodeId);
        for (const r of rows) {
            const meta = safeParse(r.metadata, null);
            if (attempts.has(Number(meta?.attemptId))) shrinkEvidence(undo, r, { ds: r.score, dt: r.total });
        }
    }
}

/** A card's ratings inside the card-evidence rows that folded them in, and in the card drill. */
function voidCardEvidence(undo, card) {
    const ratings = stmt(`SELECT id, rating FROM review_log WHERE card_id = ? AND source = 'app' ORDER BY id`).all(card.id);
    undo.reviewsThrough = ratings.at(-1)?.id ?? 0;
    // An earlier report on this card, settled by an edit, already took the
    // ratings up to its `reviewsThrough` out of these rows (the evidence keeps
    // its from/through span), so only the edited version's ratings are left.
    const taken = stmt(`SELECT undo FROM item_reports WHERE item_key = ? AND undone_at IS NULL`).all(`card:${card.id}`)
        .reduce((m, r) => Math.max(m, Number(safeParse(r.undo, {})?.reviewsThrough) || 0), 0);
    const rows = stmt(`SELECT * FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'flashcard' ORDER BY id`).all(card.node_id);
    for (const r of rows) {
        const meta = safeParse(r.metadata, null);
        const from = Number(meta?.from), through = Number(meta?.through);
        if (!Number.isInteger(from) || !Number.isInteger(through)) continue;
        const inside = ratings.filter(x => x.id > taken && x.id >= from && x.id <= through);
        if (inside.length) shrinkEvidence(undo, r, { ds: inside.filter(x => cardAnswerIsCorrect(x.rating)).length, dt: inside.length });
    }
    const drills = stmt(`SELECT * FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'drill' ORDER BY id`).all(card.node_id)
        .filter(r => safeParse(r.metadata, null)?.drillKey === 'cards');
    voidItems(undo, drills, e => e?.k === `c${card.id}`);
}

function reportCard(undo, target) {
    const card = stmt('SELECT * FROM flashcards WHERE id = ?').get(target.parsed.cardId);
    voidCardEvidence(undo, card);
    if (target.modelWritten) {
        // A card the model wrote goes: the learner never asked for it.
        undo.card = card;
        undo.reviews = stmt('SELECT * FROM review_log WHERE card_id = ? ORDER BY id').all(card.id);
        stmt('DELETE FROM flashcards WHERE id = ?').run(card.id);
    } else {
        // The learner's own card (written or imported) is theirs to fix: parked
        // until it is edited, never deleted.
        undo.parked = { cardId: card.id, nextReview: card.next_review };
        stmt('UPDATE flashcards SET next_review = ? WHERE id = ?').run(PARKED_UNTIL, card.id);
    }
}

function reportDrillItem(undo, target) {
    const { nodeId, drillKey, itemKey } = target.parsed;
    const rows = stmt(`SELECT * FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'drill' ORDER BY id`).all(nodeId)
        .filter(r => safeParse(r.metadata, null)?.drillKey === drillKey);
    voidItems(undo, rows, e => e?.k === itemKey);
}

function reportProbeQuestion(undo, target) {
    const { probeId, index } = target.parsed;
    const row = stmt('SELECT questions, created_at FROM placement_probes WHERE id = ?').get(probeId);
    const qs = safeParse(row.questions, []);
    const q = qs[index];
    qs[index] = { ...q, reported: true };
    stmt('UPDATE placement_probes SET questions = ? WHERE id = ?').run(JSON.stringify(qs), probeId);
    undo.probe = { probeId, index };
    const rows = stmt(`SELECT * FROM mastery_evidence WHERE node_id = ? AND evidence_type = 'placement' ORDER BY id`).all(q.node_id);
    for (const r of rows) {
        const meta = safeParse(r.metadata, null);
        const named = meta?.probeId != null;
        const mine = named ? Number(meta.probeId) === probeId && Number(meta.questionIndex) === index
            // Written before probe answers named their question: the probe asks
            // one question per topic, so its row is the topic's placement row
            // written since the probe opened.
            : String(r.created_at) >= String(row.created_at).replace('T', ' ').slice(0, 19);
        if (mine) shrinkEvidence(undo, r, { ds: r.score, dt: r.total });
    }
}

// ---- the record --------------------------------------------------------------

function publicReport(row) {
    if (!row) return null;
    const item = safeParse(row.item, {}) || {};
    const rewrite = safeParse(row.rewrite, null);
    const undo = safeParse(row.undo, {}) || {};
    return {
        id: row.id,
        ref: row.item_key,
        kind: row.kind,
        nodeId: row.node_id,
        projectId: row.project_id,
        reason: row.reason,
        note: row.note || null,
        surface: row.surface || null,
        createdAt: row.created_at,
        undoneAt: row.undone_at || null,
        item: item.view ?? null,
        // A card the learner wrote or imported is theirs to fix: the editor is
        // offered instead of a rewrite.
        editable: row.kind === 'card' && !!undo.parked,
        canRewrite: ['question', 'lesson', 'paper'].includes(row.kind) || (row.kind === 'card' && !!undo.card),
        rewrite,
    };
}

const reportById = (id) => stmt('SELECT * FROM item_reports WHERE id = ?').get(id);

// A report stands until it is undone, or — on the learner's own card — until
// they edited the card: it is theirs again, shows the flag again and can be
// reported again. The edited report still keeps the ratings of the version
// they reported out of the evidence (cardEvidence.js reads it directly).
const STANDING = `undone_at IS NULL AND (rewrite IS NULL OR json_extract(rewrite, '$.state') IS NOT 'edited')`;
const activeFor = (ref) => stmt(`SELECT * FROM item_reports WHERE item_key = ? AND ${STANDING} ORDER BY id DESC LIMIT 1`).get(ref);

export function getReport(id) { return publicReport(reportById(id)); }

export class ReportError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

/** Validate what a client sent; returns the clean fields or throws a ReportError (400). */
export function readReportBody(body) {
    const ref = typeof body?.ref === 'string' ? canonicalRef(body.ref) : null;
    if (!ref) throw new ReportError(400, 'ref must name one item (fi:, q:, card:, probe: or drill:)');
    const reason = body?.reason;
    if (!REPORT_REASONS.includes(reason)) throw new ReportError(400, `reason must be one of: ${REPORT_REASONS.join(', ')}`);
    let note = body?.note;
    if (note != null && typeof note !== 'string') throw new ReportError(400, 'note must be text');
    note = typeof note === 'string' ? note.trim() : '';
    if (note.length > REPORT_NOTE_MAX) throw new ReportError(400, `note must be at most ${REPORT_NOTE_MAX} characters`);
    const surface = typeof body?.surface === 'string' && REPORT_SURFACES.has(body.surface) ? body.surface : null;
    return { ref, reason, note: note || null, surface };
}

const reportTx = db.transaction(({ ref, reason, note, surface }) => {
    const existing = activeFor(ref);
    if (existing) return { report: publicReport(existing), existing: true };
    const target = resolveTarget(ref);
    if (!target) throw new ReportError(404, 'That item is not here any more.');

    const undo = { evidence: [], mastery: [], banks: [], moved: {} };
    const touched = new Set([target.nodeId].filter(n => n != null));
    // Rows on other topics are never touched, but a card's or question's own
    // topic is where every row lives — snapshot it before anything moves.
    const nodesBefore = new Map([...touched].map(n => [n, masteryNow(n)]));

    if (target.parsed.type === 'q') reportBankQuestion(undo, target);
    else if (target.parsed.type === 'fi') reportFeedRow(undo, target);
    else if (target.parsed.type === 'card') reportCard(undo, target);
    else if (target.parsed.type === 'drill') reportDrillItem(undo, target);
    else if (target.parsed.type === 'probe') reportProbeQuestion(undo, target);

    if (target.parsed.type === 'probe') {
        const probe = getProbeById(target.parsed.probeId);
        applyProbeSeeds(probe.projectId, probe);
    } else {
        rescoreTouched(undo, nodesBefore);
    }

    const info = stmt(`
        INSERT INTO item_reports (kind, item_key, node_id, project_id, reason, note, surface, item, undo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO})
    `).run(target.kind, target.ref, target.nodeId, target.projectId, reason, note, surface,
        JSON.stringify({ view: target.item }), JSON.stringify(undo));
    return { report: publicReport(reportById(Number(info.lastInsertRowid))), existing: false };
});

/**
 * File a report, or return the one already standing on that item (a second
 * press, the assistant preparing one the flag already sent). Throws a
 * ReportError for a bad body (400) or an item that is gone (404).
 */
export function fileReport(body) {
    const clean = readReportBody(body);
    const out = reportTx.immediate(clean);
    if (!out.existing) {
        // Three closed vocabularies: the kind, one of REPORT_REASONS (readReportBody
        // refuses any other word) and one of REPORT_SURFACES. The note is the
        // learner's own text and never reaches the log.
        const closedWords = [out.report.kind, clean.reason, clean.surface].filter(Boolean).join(' · ');
        logActivity({
            area: 'feed', event: 'item.reported', detail: closedWords,
            projectId: out.report.projectId ?? undefined, nodeId: out.report.nodeId ?? undefined,
        });
    }
    return out;
}

/** `list` without one occurrence of each entry in `drop`, compared by value. */
function withoutEntries(list, drop) {
    const left = [...(Array.isArray(list) ? list : [])];
    for (const d of drop || []) {
        const at = left.findIndex(e => JSON.stringify(e) === JSON.stringify(d));
        if (at >= 0) left.splice(at, 1);
    }
    return left;
}

/** A row image with a report's share taken out again (a later report still standing). */
function minusShare(img, share) {
    const meta = safeParse(img.metadata, {}) || {};
    if (share.voided?.length) {
        meta.items = withoutEntries(meta.items, share.voided);
        meta.voided = [...(Array.isArray(meta.voided) ? meta.voided : []), ...share.voided];
    }
    const total = img.total - share.dt;
    return { ...img, total, score: Math.max(0, Math.min(total, img.score - share.ds)), metadata: JSON.stringify(meta) };
}

/** A row image with a report's share given back, its items in their first order. */
function plusShare(img, share, original) {
    const meta = safeParse(img.metadata, {}) || {};
    if (share.voided?.length) {
        const first = safeParse(original.metadata, {})?.items;
        const want = [...(Array.isArray(meta.items) ? meta.items : []), ...share.voided];
        // In the order the sitting first held them; anything else at the end.
        const ordered = [];
        const pool = [...want];
        for (const e of Array.isArray(first) ? first : []) {
            const at = pool.findIndex(x => JSON.stringify(x) === JSON.stringify(e));
            if (at >= 0) ordered.push(pool.splice(at, 1)[0]);
        }
        meta.items = [...ordered, ...pool];
        meta.voided = withoutEntries(meta.voided, share.voided);
        if (!meta.voided.length && !Array.isArray(safeParse(original.metadata, {})?.voided)) delete meta.voided;
    }
    return { ...img, total: img.total + share.dt, score: img.score + share.ds, metadata: JSON.stringify(meta) };
}

const EVIDENCE_COLUMNS = (row) => Object.keys(row);
const sameEvidence = (a, b) => !!a && !!b && EVIDENCE_COLUMNS(b).every(c => (a[c] ?? null) === (b[c] ?? null));

/**
 * The other reports that took something out of one evidence row, oldest
 * first, and whether each still holds its share out. An edited card's report
 * does: the ratings of the version it was about stay out.
 */
function othersOnRow(rowId, report) {
    return stmt('SELECT id, undo, undone_at FROM item_reports WHERE node_id IS ? AND id <> ? ORDER BY id').all(report.node_id, report.id)
        .map(r => ({ id: r.id, standing: !r.undone_at, entries: (safeParse(r.undo, {})?.evidence || []).filter(x => x?.before?.id === rowId) }))
        .filter(r => r.entries.length);
}

/**
 * Put back what one report took from one evidence row. With no other report
 * standing on the row (the usual case) that is the row exactly as it was.
 * When another report still holds items of the same sitting out, only this
 * report's share goes back, and the other's stays out.
 */
function restoreEvidence({ before, sitting, share, after }, report) {
    const cols = EVIDENCE_COLUMNS(before);
    const write = (img, exists) => (exists
        ? stmt(`UPDATE mastery_evidence SET ${cols.filter(c => c !== 'id').map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`).run(img)
        : stmt(`INSERT INTO mastery_evidence (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(img));
    const now = evidenceRow(before.id);
    const others = share ? othersOnRow(before.id, report) : [];
    const standing = others.filter(o => o.standing);
    // The row before the FIRST report touched it (evidence rows are written
    // once; only reports change them).
    const first = others[0] && others[0].id < report.id ? others[0].entries[0].before : before;
    if (!standing.length) {
        // Nothing else holds a share of this row out: it goes back to that,
        // so reports undone in any order leave the row exactly as it was.
        if (now) write(first, true);
        else if (first.total > 0) write(first, false);
    } else if (now) {
        // Its items back in the order the sitting first held them.
        write(after && sameEvidence(now, after) ? before : plusShare(now, share, first), true);
    } else {
        // Gone: a later report still standing took the rest of it.
        let img = before;
        for (const o of standing.filter(s => s.id > report.id)) {
            for (const e of o.entries) if (e.share) img = minusShare(img, e.share);
        }
        if (img.total > 0) write(img, false);
    }
    if (sitting && !stmt('SELECT 1 FROM sitting_reviews WHERE evidence_id = ?').get(sitting.evidence_id)) {
        const sc = Object.keys(sitting);
        stmt(`INSERT INTO sitting_reviews (${sc.join(', ')}) VALUES (${sc.map(c => `@${c}`).join(', ')})`).run(sitting);
    }
}

const MASTERY_COLUMNS = ['mastery_score', 'total_attempts', 'correct_attempts', 'last_updated'];

const sameRow = (a, b) => MASTERY_COLUMNS.every(c => (a?.[c] ?? null) === (b?.[c] ?? null));

const undoTx = db.transaction((id) => {
    const row = reportById(id);
    if (!row) throw new ReportError(404, 'No such report.');
    if (row.undone_at) return { report: publicReport(row), undid: false };
    // Settled by an edit: the card is a new version. Putting the report's
    // share back would count the reported version's ratings again (the
    // cut-off in `cardEvidence` holds only while a report has no Undo).
    if (safeParse(row.rewrite, null)?.state === 'edited') {
        throw new ReportError(409, 'This card was edited after it was reported, so there is nothing to undo.');
    }
    const undo = safeParse(row.undo, {}) || {};

    for (const e of [...(undo.evidence || [])].reverse()) restoreEvidence(e, row);

    for (const b of undo.banks || []) {
        const q = stmt('SELECT questions FROM quizzes WHERE id = ?').get(b.quizId);
        const qs = safeParse(q?.questions);
        if (!Array.isArray(qs)) continue;
        for (const t of b.taken) {
            if (qs.some(x => x?.uuid && x.uuid === t.question.uuid && x.question === t.question.question)) continue;
            qs.splice(Math.min(t.index, qs.length), 0, t.question);
        }
        stmt('UPDATE quizzes SET questions = ? WHERE id = ?').run(JSON.stringify(qs), b.quizId);
    }

    if (undo.feedRow) {
        const r = undo.feedRow;
        const now = stmt('SELECT id FROM feed_items WHERE id = ?').get(r.id);
        if (now) {
            stmt('UPDATE feed_items SET status = ?, consumed_at = ?, result = ? WHERE id = ?').run(r.status, r.consumed_at, r.result, r.id);
        } else if (!stmt('SELECT 1 FROM feed_items WHERE node_id = ? AND kind = ? AND seq = ?').get(r.node_id, r.kind, r.seq)) {
            // Rewritten since: the old row comes back only where its slot is free.
            const cols = Object.keys(r);
            stmt(`INSERT INTO feed_items (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(r);
        }
    }

    if (undo.card && !stmt('SELECT 1 FROM flashcards WHERE id = ?').get(undo.card.id)
        && stmt('SELECT 1 FROM nodes WHERE id = ?').get(undo.card.node_id)) {
        const cols = Object.keys(undo.card);
        stmt(`INSERT INTO flashcards (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(undo.card);
        for (const rl of undo.reviews || []) {
            const rc = Object.keys(rl);
            stmt(`INSERT OR IGNORE INTO review_log (${rc.join(', ')}) VALUES (${rc.map(c => `@${c}`).join(', ')})`).run(rl);
        }
    }
    if (undo.parked) {
        stmt('UPDATE flashcards SET next_review = ? WHERE id = ? AND next_review = ?')
            .run(undo.parked.nextReview, undo.parked.cardId, PARKED_UNTIL);
    }

    if (undo.probe) {
        const p = stmt('SELECT questions FROM placement_probes WHERE id = ?').get(undo.probe.probeId);
        const qs = safeParse(p?.questions, null);
        if (Array.isArray(qs) && qs[undo.probe.index]) {
            const { reported: _r, ...rest } = qs[undo.probe.index];
            qs[undo.probe.index] = rest;
            stmt('UPDATE placement_probes SET questions = ? WHERE id = ?').run(JSON.stringify(qs), undo.probe.probeId);
            const probe = getProbeById(undo.probe.probeId);
            applyProbeSeeds(probe.projectId, probe);
        }
    }

    // The estimate: exactly as it was when nothing has moved it since the
    // report; otherwise replayed from the evidence that is back.
    for (const m of undo.mastery || []) {
        const nodeId = m.before.node_id;
        if (!stmt('SELECT 1 FROM nodes WHERE id = ?').get(nodeId)) continue;
        const now = getNodeMastery(nodeId);
        if (sameRow(now, m.after)) {
            stmt(`UPDATE node_mastery SET ${MASTERY_COLUMNS.map(c => `${c} = @${c}`).join(', ')} WHERE node_id = @node_id`).run(m.before);
        } else {
            const moved = undo.moved?.[nodeId] || { score: 0, total: 0 };
            rescoreNode(nodeId, { score: moved.score, total: moved.total });
        }
    }

    stmt(`UPDATE item_reports SET undone_at = ${NOW_ISO} WHERE id = ?`).run(id);
    return { report: publicReport(reportById(id)), undid: true };
});

/** Undo a report: everything it took is put back. Idempotent: a second Undo changes and logs nothing. */
export function undoReport(id) {
    const { report: out, undid } = undoTx.immediate(Number(id));
    if (undid) logActivity({ area: 'feed', event: 'item.report_undone', detail: out.kind, projectId: out.projectId ?? undefined, nodeId: out.nodeId ?? undefined });
    return out;
}

/**
 * Reports standing (not undone, not settled by an edit) on a topic, a
 * project, or a list of refs. Asked by refs, every ref asked can be answered:
 * the limit is never below their number.
 */
export function listReports({ nodeId = null, projectId = null, refs = null, includeSettled = false, limit = 50 } = {}) {
    const where = [];
    const args = [];
    const keys = Array.isArray(refs) ? [...new Set(refs.map(canonicalRef).filter(Boolean))] : [];
    // A list of refs, even an empty one, is a filter: it never lists every report.
    if (Array.isArray(refs) && !keys.length) return [];
    if (nodeId != null) { where.push('node_id = ?'); args.push(nodeId); }
    if (projectId != null) { where.push('project_id = ?'); args.push(projectId); }
    if (keys.length) { where.push(`item_key IN (${keys.map(() => '?').join(',')})`); args.push(...keys); }
    if (!includeSettled) where.push(STANDING);
    const sql = `SELECT * FROM item_reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    // Its text varies with the number of refs: prepared here, not kept.
    return db.prepare(sql).all(...args, Math.max(1, Math.min(200, Math.max(limit, keys.length)))).map(publicReport);
}

/** Record what the rewrite did (`{ state, taskId?, at }`). */
export function setRewrite(id, rewrite) {
    stmt('UPDATE item_reports SET rewrite = ? WHERE id = ?').run(JSON.stringify(rewrite), id);
    return getReport(id);
}

/** The raw record a rewrite needs: the item as reported and the row's snapshot. */
export function rewriteSource(id) {
    const row = reportById(id);
    if (!row) return null;
    return { row, report: publicReport(row), undo: safeParse(row.undo, {}) || {} };
}

const REASON_WORDS = {
    wrong: 'is wrong',
    unclear: 'is unclear',
    off_topic: 'is not about this topic',
    other: 'has a problem',
};

/**
 * The fault a rewrite starts from, in the words the generators' `priorFault`
 * takes: what the learner said, then the version they said it about.
 */
export function learnerFaultText(report) {
    if (!report) return null;
    const what = report.kind === 'lesson' ? 'lesson' : report.kind === 'card' ? 'flashcard' : 'question';
    const note = report.note ? `"${String(report.note).replace(/\s+/g, ' ').slice(0, REPORT_NOTE_MAX)}"` : '';
    // From the assistant the note is its summary of what the learner said,
    // which they confirmed by pressing Report: not their own words.
    const said = !note ? ''
        : report.surface === 'assistant' ? ` The note with the report, from the assistant's talk with them: ${note}.`
        : ` They wrote: ${note}.`;
    const view = report.item ? JSON.stringify(report.item).slice(0, 3000) : '';
    return `A learner reported that the previous ${what} ${REASON_WORDS[report.reason] || REASON_WORDS.other}.${said}`
        + (view ? ` The ${what} they reported was: ${view}. Write a replacement that does not repeat its fault.` : '');
}

/**
 * The learner's fault for a feed slot being rewritten (a reported lesson whose
 * row was taken out for a rewrite), or null. Read by feedGen when it writes
 * that slot again, so the new lesson starts from what the learner said.
 */
export function learnerFaultForSlot(nodeId, kind, seq) {
    const rows = stmt(`
        SELECT * FROM item_reports
        WHERE node_id = ? AND kind = ? AND undone_at IS NULL AND rewrite IS NOT NULL
        ORDER BY id DESC LIMIT 20
    `).all(nodeId, kind);
    for (const r of rows) {
        const undo = safeParse(r.undo, {}) || {};
        if (undo.feedRow?.seq === seq && safeParse(r.rewrite, {})?.state === 'requested') return learnerFaultText(publicReport(r));
    }
    return null;
}

/**
 * Is this card parked by a report that stands? Its schedule is the report's
 * until the report is undone or the card edited: a rating from a page that
 * missed the report (another tab) would put it back in the due queues.
 */
export function parkedByReport(card) {
    if (!card || card.next_review !== PARKED_UNTIL) return false;
    return !!safeParse(activeFor(`card:${card.id}`)?.undo, {})?.parked;
}

/**
 * A learner's own card was edited: the report on it is settled, the card goes
 * back into its queue, and its ratings from now on count again (the ones made
 * of the version they reported stay out).
 */
export function cardEdited(cardId) {
    // An edit already settled it (`activeFor` no longer finds it): a second
    // edit changes nothing here.
    const row = activeFor(`card:${cardId}`);
    if (!row) return null;
    const undo = safeParse(row.undo, {}) || {};
    if (!undo.parked) return null;
    stmt('UPDATE flashcards SET next_review = ? WHERE id = ? AND next_review = ?').run(undo.parked.nextReview, cardId, PARKED_UNTIL);
    // Every rating up to now was of the version they reported, so none of them
    // counts; the card's evidence starts again from its next rating.
    const newest = stmt(`SELECT MAX(id) AS id FROM review_log WHERE card_id = ? AND source = 'app'`).get(cardId)?.id ?? 0;
    stmt('UPDATE item_reports SET undo = ? WHERE id = ?').run(JSON.stringify({ ...undo, reviewsThrough: newest }), row.id);
    return setRewrite(row.id, { state: 'edited', at: new Date().toISOString() });
}

// Telling a course's topics apart by their photos: "Which one is this?" asked
// of a stored photo, with the course's by-sight topics as the options.
//
// ## Why it works this way
//
// Learning to tell look-alike categories apart (styles, species, painters)
// comes from many short trials, each answered and corrected at once
// (Kellman's perceptual learning modules), with the categories MIXED rather
// than one block at a time (Kornell & Bjork 2008; Carvalho & Goldstone 2014:
// mixing helps most when the categories look alike), and from seeing a
// mistaken pick beside the real thing (Kang & Pashler 2012). So a round mixes
// every by-sight topic of the course, never puts two photos of one topic side
// by side when it can avoid it, and a wrong pick answers with both photos.
//
// ## What the learner names
//
// A photo is named by what it IS: its `answer`, the kind the course plan says
// it belongs to (a style, a species, a country's buildings; server/topicPhotos.js
// planPhotos), the same words for every photo of that kind in the course.
// That is not always its topic: a topic can teach two look-alikes ("Tits:
// great tit and blue tit") or be about a way of looking ("Leaf shapes"), and
// "which topic is this?" asked of such a photo has no answer a learner could
// see. A photo with no answer on record (a course from before) is named by
// its topic's title, as before. Two topics holding one kind are one option,
// and a picture kept under two topics is asked once.
//
// ## Where the answer comes from
//
// The photo's KIND is the key: the kind the example was planned as, and the
// archive's photo of it was kept for (server/topicPhotos.js). No model
// looks at the picture here and none is asked anything. A photo a vision
// model confirmed (`checked_by`) is proof; one nobody looked at is a model's
// pick from a search, so its answers count as practice (`drill`), the way a
// question no verifier read never counts as proof (server/questionTrust.js).
//
// ## Why the questions are not stored
//
// A question here is made from the photos each time a round is drawn, never
// kept in a topic's bank. In a topic's own check, chapter or recall card the
// topic's name is on the screen, and "which topic is this?" would answer
// itself; so these questions are asked only in a round that mixes the course.
// Made fresh, a renamed topic or a photo found again is right at once.
//
// The answer is graded here, never trusted from the client, and no words that
// name it go out before the pick: not the example's name, not the credit (an
// author or a file page often names the place). Both come with the verdict, on
// the same screen. The topic's id does go with the photo, because the study
// clock counts the time on that topic; it is a number the screen never shows,
// and a learner reading the network could as well look the photo up.

import db from './database.js';
import { recordOnce, updateMasteryFromAttempt } from './mastery.js';
import { photoView, topicsInOrder } from './topicPhotos.js';
import { standingRefs } from './itemReports.js';
import { statusError } from './clientError.js';

/** A round's length when the screen does not ask for another. */
export const ROUND_SIZE = 12;
export const MAX_ROUND = 60;
/** The photo's own kind and up to three others. */
const MAX_OPTIONS = 4;
/** A kind needs another to be told apart from. */
export const MIN_KINDS = 2;

const statements = new Map();
const stmt = (sql) => {
    let s = statements.get(sql);
    if (!s) { s = db.prepare(sql); statements.set(sql, s); }
    return s;
};

const shuffle = (list) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

/**
 * The course's topics that have a photo to ask about, in course order:
 * `[{ nodeId, title, photos: [node_photos row] }]`. A photo under a standing
 * "This is wrong" report is left out until the report is undone, unless
 * `keepReported` (a topic offered at the round's start stays a valid pick).
 */
export function sightTopics(projectId, { keepReported = false } = {}) {
    const reported = keepReported ? new Set() : standingRefs('photo:');
    const byNode = new Map();
    for (const p of stmt(`
        SELECT p.* FROM node_photos p JOIN live_nodes n ON n.id = p.node_id
        WHERE n.project_id = ? AND p.status = 'found' AND p.hash IS NOT NULL AND p.uuid IS NOT NULL
        ORDER BY p.node_id, p.position, p.id
    `).all(projectId)) {
        if (reported.has(`photo:${p.uuid}`)) continue;
        if (!byNode.has(p.node_id)) byNode.set(p.node_id, []);
        byNode.get(p.node_id).push(p);
    }
    if (!byNode.size) return [];
    // Every topic of the course, not only the first the photo plan asks about.
    const out = [];
    for (const t of topicsInOrder(projectId, { all: true })) {
        const photos = byNode.get(t.id);
        if (photos) out.push({ nodeId: t.id, title: t.title, photos });
    }
    return out;
}

const labelOf = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const keyOf = (s) => labelOf(s).toLowerCase();

/** What a photo is named in practice: its answer, else its topic's title. */
export const kindLabel = (photo, topic) => labelOf(photo.answer) || labelOf(topic.title);

/**
 * The course's photos by what they are named: `Map<key, { key, label,
 * nodeIds: Set, photos: [{ p, t }] }>`, in course order. The label is the
 * first spelling met; a picture (the same file) is counted once, under the
 * first topic that holds it.
 */
export function sightKinds(topics) {
    const kinds = new Map();
    const pictures = new Set();
    for (const t of topics) {
        for (const p of t.photos) {
            if (pictures.has(p.hash)) continue;
            pictures.add(p.hash);
            const label = kindLabel(p, t);
            const key = keyOf(label);
            if (!kinds.has(key)) kinds.set(key, { key, label, nodeIds: new Set(), photos: [] });
            const k = kinds.get(key);
            k.nodeIds.add(t.nodeId);
            k.photos.push({ p, t });
        }
    }
    return kinds;
}

/** What the course page needs to offer practice: `{ topics, photos, kinds, available }`. */
export function practiceState(projectId) {
    const kinds = sightKinds(sightTopics(projectId));
    const nodes = new Set([...kinds.values()].flatMap(k => [...k.nodeIds]));
    return {
        topics: nodes.size,
        photos: [...kinds.values()].reduce((n, k) => n + k.photos.length, 0),
        kinds: kinds.size,
        available: kinds.size >= MIN_KINDS,
    };
}

/**
 * Lay out a round from one list per topic so that no two neighbours share a
 * topic when that can be avoided, and as few do as possible when it cannot.
 * Each list keeps its own order. Greedy: next comes the topic with the most
 * still to place, never the one just placed; that leaves the fewest
 * neighbours possible, max(0, largest - rest - 1).
 */
export function interleave(groups) {
    const left = groups.map(g => [...g]);
    const out = [];
    let last = -1;
    for (;;) {
        let best = -1;
        for (let i = 0; i < left.length; i++) {
            if (!left[i].length || i === last) continue;
            if (best < 0 || left[i].length > left[best].length) best = i;
        }
        if (best < 0) {
            if (last >= 0 && left[last].length) best = last;
            else break;
        }
        out.push(left[best].shift());
        last = best;
    }
    return out;
}

/** When each photo was last answered here: uuid -> ISO time. */
function lastAsked(nodeIds) {
    const out = new Map();
    for (const id of nodeIds) {
        for (const r of stmt(`
            SELECT json_extract(metadata, '$.photo') AS photo, MAX(created_at) AS at FROM mastery_evidence
            WHERE node_id = ? AND json_extract(metadata, '$.source') = 'sight'
            GROUP BY photo
        `).all(id)) {
            if (r.photo) out.set(r.photo, r.at);
        }
    }
    return out;
}

/** Never answered first (in a random order), then the longest ago. */
const byStaleness = (asked) => (a, b) => {
    const x = asked.get(a.uuid) ?? null, y = asked.get(b.uuid) ?? null;
    if (x === y) return 0;
    if (x === null) return -1;
    if (y === null) return 1;
    return x < y ? -1 : 1;
};

/**
 * The kinds offered beside the photo's own. First the others its topic
 * teaches (the look-alikes a topic puts side by side, "great tit and blue
 * tit", are the pair worth telling apart), then the rest drawn at random.
 * Not the nearest in course order: that set sits around the answer, so a
 * learner who knows the order could rule out its ends.
 */
function optionsFor(kinds, own, nodeId) {
    const rest = shuffle([...kinds.values()].filter(k => k !== own));
    const near = rest.filter(k => k.nodeIds.has(nodeId));
    const others = [...shuffle(near), ...rest.filter(k => !k.nodeIds.has(nodeId))].slice(0, MAX_OPTIONS - 1);
    return shuffle([own, ...others]).map(k => ({ key: k.key, title: k.label }));
}

/**
 * A round: `{ items }`, each `{ photo, nodeId, hash, width, height, options }`,
 * `nodeId` the photo's topic (the study clock's) and each option `{ key,
 * title }`. Throws 409 when the course has fewer than two kinds with photos.
 * Every picture once at most; kind by kind, the photos never answered first.
 */
export function drawRound(projectId, { size = ROUND_SIZE } = {}) {
    const topics = sightTopics(projectId);
    const kinds = [...sightKinds(topics).values()];
    if (kinds.length < MIN_KINDS) throw statusError(409, 'This course has no photos to tell apart yet');
    const want = Math.min(MAX_ROUND, Number.isInteger(size) && size > 0 ? size : ROUND_SIZE);
    const asked = lastAsked(topics.map(t => t.nodeId));
    const order = (a, b) => byStaleness(asked)(a.p, b.p);
    // Photos never answered come first, then the longest ago, so a short
    // round still reaches them; among equals, one photo per kind per pass
    // (`pass` = its place in its kind's queue), so the kinds stay even.
    const ranked = [];
    kinds.forEach((k, i) => shuffle(k.photos).sort(order)
        .forEach((x, pass) => ranked.push({ i, x, pass, r: Math.random() })));
    ranked.sort((a, b) => order(a.x, b.x) || a.pass - b.pass || a.r - b.r);
    const picked = kinds.map(() => []);
    for (const c of ranked.slice(0, want)) picked[c.i].push(c.x);
    // The order kinds enter the layout in is shuffled, so a round does not
    // always open on the course's first one.
    const all = new Map(kinds.map(k => [k.key, k]));
    const lanes = shuffle(kinds.map((k, i) => ({ k, photos: picked[i] })).filter(l => l.photos.length));
    const laid = interleave(lanes.map(l => l.photos.map(x => ({ k: l.k, ...x }))));
    return {
        items: laid.map(({ k, p, t }) => ({
            photo: p.uuid,
            nodeId: t.nodeId,
            hash: p.hash,
            width: p.width,
            height: p.height,
            options: optionsFor(all, k, t.nodeId),
        })),
    };
}

/** A photo of the picked kind to set beside the one shown: the same place in its list, wrapped. */
function comparisonPhoto(pickedKind, shownRow, shownKind) {
    const at = Math.max(0, shownKind ? shownKind.photos.findIndex(x => x.p.uuid === shownRow.uuid) : 0);
    return pickedKind.photos[at % pickedKind.photos.length].p;
}

/**
 * Grade a pick (an option's `key`) and write it once per attempt id. Returns
 * `{ correct, answer: { key, title, nodeId }, shown, picked, duplicate }`:
 * `shown` the photo asked about and `picked` (wrong picks only) a photo of the
 * kind picked, each with its example, what to look at, its credit and, as
 * `topic`, the kind it is named by. Evidence goes on the photo's topic.
 */
export function answerPhoto(projectId, { photo, picked, attemptId }) {
    const row = typeof photo === 'string' ? stmt(`
        SELECT p.*, n.project_id, n.title AS topic_title FROM node_photos p JOIN live_nodes n ON n.id = p.node_id
        WHERE p.uuid = ? AND p.status = 'found' AND p.hash IS NOT NULL
    `).get(photo) : null;
    const topics = row && row.project_id === projectId ? sightTopics(projectId) : [];
    const own = topics.find(t => t.nodeId === row?.node_id);
    if (!row || !own || !own.photos.some(p => p.uuid === row.uuid)) throw statusError(404, 'That photo is not in this course');
    const kinds = sightKinds(topics);
    const ownKind = kinds.get(keyOf(kindLabel(row, own)));
    // A kind whose photos were all reported since the round began was still
    // offered: it is a pick like any other, with no photo to set beside.
    let everyKind = null;
    const kindOf = (key) => (typeof key === 'string' && key ? kinds.get(keyOf(key))
        ?? (everyKind ??= sightKinds(sightTopics(projectId, { keepReported: true }))).get(keyOf(key)) : null);
    const pickedKind = kindOf(picked);
    if (!pickedKind) throw statusError(400, 'Pick one of the topics offered');
    // The photo's own picture may sit under an earlier topic too; it is that
    // picture's kind that is asked (sightKinds counts a picture once).
    const shownKind = ownKind ?? [...kinds.values()].find(k => k.photos.some(x => x.p.hash === row.hash));
    const { duplicate, outcome } = recordOnce('sight', attemptId, () => {
        const correct = pickedKind.key === shownKind?.key;
        // Proof once per photo: a course keeps a few photos per kind and
        // rounds come back to them, so an answer to a photo met before is
        // recall of that picture, practice like a drill's replayed items.
        const metBefore = !!stmt(`SELECT 1 FROM mastery_evidence WHERE node_id = ?
            AND json_extract(metadata, '$.source') = 'sight' AND json_extract(metadata, '$.photo') = ? LIMIT 1`).get(own.nodeId, row.uuid);
        // A lucky pick is one in as many kinds as were offered (optionsFor).
        const offered = Math.min(MAX_OPTIONS, kinds.size);
        updateMasteryFromAttempt(own.nodeId, correct ? 1 : 0, 1, row.checked_by && !metBefore ? 'quiz' : 'drill', {
            source: 'sight', photo: row.uuid, picked: pickedKind.key, questionType: 'multiple_choice',
            guess: 1 / Math.max(2, offered),
        });
        return { correct, picked: pickedKind.key };
    }, row.uuid);
    // A retry answers with what was recorded, not with what it sent now.
    const correct = !!outcome?.correct;
    const pickedThen = kindOf(outcome?.picked) ?? pickedKind;
    const other = correct || kinds.get(pickedThen.key) !== pickedThen ? null : comparisonPhoto(pickedThen, row, shownKind);
    const label = shownKind?.label ?? kindLabel(row, own);
    return {
        correct,
        answer: { key: shownKind?.key ?? keyOf(label), title: label, nodeId: own.nodeId },
        shown: { ...photoView(row), topic: label },
        picked: other ? { ...photoView(other), topic: pickedThen.label } : null,
        ...(duplicate ? { duplicate: true } : {}),
    };
}

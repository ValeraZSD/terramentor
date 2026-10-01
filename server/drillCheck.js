// server/drillCheck.js — reading a ```drill fence on the server, and taking the
// items a verifier disputed back out of it.
//
// A drill (D-023) is an item bank the model writes inside a lesson: prompt →
// answer pairs the native player turns into a timed game. Until 2026-10-01 no
// gate read one. The visual checker covers plots, charts, animations and
// diagrams; the drill was left out because it is not a picture, and so its
// answer KEY — the thing the player grades the learner against — was the one
// model-written key in the app that nothing ever second-guessed. It shipped a
// Frisian alphabet drill asking "the letter after P" with R as the key: the
// learner answered Q, was told they were wrong, and was taught the mistake.
//
// The parse mirrors `normaliseItems` in src/components/drills/parseDrill.ts —
// the same field-name variants a small model reaches for — so the server
// checks exactly the items the player will serve, in the same order. The
// model call that judges them lives in feedQuality.js (`vetLessonDrills`);
// this module stays pure so the gate can run it with no model and no database.

import JSON5 from 'json5';

/** The fence languages the client renders as a drill (`DRILL_FENCE_LANGS`). */
export const DRILL_FENCE_RE = /^```(drill|practice|quiz-drill|flashdrill)[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/gm;

/**
 * Fewer items than this left after the disputed ones are taken out, and the
 * drill goes. The authoring guide asks for five or more, and a round of two
 * or three is a guessing game rather than practice.
 */
export const MIN_DRILL_ITEMS = 4;

/**
 * More than this share of a drill disputed and the WHOLE drill goes, not just
 * the items: a bank where a third of the keys are wrong was written by a model
 * that misunderstood the set, and the keys the verifier happened to agree with
 * are no better evidenced than the ones it did not.
 */
export const MAX_DISPUTED_SHARE = 1 / 3;

const ITEM_LIST_KEYS = ['items', 'cards', 'questions', 'pairs'];

const asString = (v) => (typeof v === 'string' ? v.trim()
    : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

function parseLoose(body) {
    try { return JSON.parse(body); } catch { /* fall through */ }
    try { return JSON5.parse(body); } catch { return null; }
}

/** Every drill fence in a lesson: `{ block, lang, body }`, in order. */
export function findDrills(markdown) {
    const out = [];
    const text = String(markdown || '');
    DRILL_FENCE_RE.lastIndex = 0;
    let m;
    while ((m = DRILL_FENCE_RE.exec(text)) !== null) {
        out.push({ block: m[0], lang: m[1], body: m[2] });
    }
    return out;
}

/**
 * The drill as the player will serve it, or null when the client could not
 * read it either (it then shows "could not be read" and serves nothing, so
 * there is no key to check). `items[i].at` is the item's index in the raw
 * list, which is what a rewrite removes by.
 */
export function parseDrillBody(body) {
    const obj = parseLoose(body);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const listKey = ITEM_LIST_KEYS.find(k => Array.isArray(obj[k]));
    if (!listKey) return null;
    const items = [];
    obj[listKey].forEach((e, at) => {
        if (!e || typeof e !== 'object') return;
        const prompt = asString(e.prompt ?? e.front ?? e.question ?? e.term ?? e.q ?? e.left ?? e.cue);
        const answer = asString(e.answer ?? e.back ?? e.correct ?? e.definition ?? e.a ?? e.right ?? e.response);
        if (!prompt || !answer) return;
        const raw = e.distractors ?? e.options ?? e.wrong;
        const distractors = (Array.isArray(raw) ? raw : []).map(asString)
            .filter(d => d && d.toLowerCase() !== answer.toLowerCase());
        items.push({ at, prompt, answer, distractors });
    });
    return {
        obj,
        listKey,
        items,
        title: asString(obj.title),
        promptLabel: asString(obj.prompt_label ?? obj.promptLabel),
        answerLabel: asString(obj.answer_label ?? obj.answerLabel),
    };
}

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Faults visible without a model. Returns the positions (into `items`) of the
 * items that must go, each with its reason.
 *
 *  - The same prompt twice with two different answers: whichever one the
 *    player asks, the other key marks a right answer wrong.
 *  - An answer that IS its prompt: the item asks for what it shows. A real
 *    drill ("the long pair of this word?") carried `maan → maan` beside
 *    `man → maan`, which marks the only sensible answer to it wrong.
 *  - An item listing its own answer among the distractors under another
 *    spelling is already filtered by the parser; a distractor that is ANOTHER
 *    item's answer to the SAME prompt is the first case again.
 */
export function drillDefects(items) {
    const byPrompt = new Map();
    const out = [];
    items.forEach((it, i) => {
        const k = norm(it.prompt);
        if (k === norm(it.answer)) out.push({ i, reason: 'the answer is the prompt itself' });
        if (!byPrompt.has(k)) byPrompt.set(k, []);
        byPrompt.get(k).push(i);
    });
    const selfAnswered = new Set(out.map(d => d.i));
    for (const idx of byPrompt.values()) {
        if (idx.length < 2) continue;
        const answers = new Set(idx.map(i => norm(items[i].answer)));
        if (answers.size < 2) continue;
        for (const i of idx) {
            if (!selfAnswered.has(i)) out.push({ i, reason: `the prompt "${items[i].prompt.slice(0, 60)}" appears with ${answers.size} different answers` });
        }
    }
    return out;
}

/** FNV-1a, for an order that is fixed per value and unrelated to the items'. */
function hashOf(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h;
}

/**
 * Every answer and distractor in the drill, deduplicated, in an order that
 * gives the pairing away nowhere — the verifier is shown the pool, never
 * which value belongs to which prompt.
 *
 * Not SORTED: an alphabet drill asks "after A, after C, …" and its sorted
 * answers B, D, … stand in exactly the prompts' order, so a verifier pairing
 * the two lists by position would agree with every key, the wrong one
 * included. The order is a hash of each value (the same drill always makes
 * the same prompt), then any value that still stands at its own item's
 * position is swapped with a neighbour.
 */
export function answerPool(items) {
    const seen = new Map();
    for (const it of items) {
        for (const v of [it.answer, ...(it.distractors || [])]) {
            const k = norm(v);
            if (k && !seen.has(k)) seen.set(k, v);
        }
    }
    const rank = (v) => hashOf(norm(v));
    const pool = [...seen.values()].sort((a, b) => rank(a) - rank(b) || norm(a).localeCompare(norm(b)));
    if (pool.length < 2) return pool;
    for (let i = 0; i < pool.length; i++) {
        if (i < items.length && norm(pool[i]) === norm(items[i].answer)) {
            const j = i + 1 < pool.length ? i + 1 : i - 1;
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
    }
    return pool;
}

/**
 * The fence with the disputed items taken out, or null when the drill as a
 * whole must go (too few left, or too many wrong to trust the rest).
 * `disputed` holds positions into `parsed.items`.
 */
export function rewriteDrill(drill, parsed, disputed) {
    const gone = new Set(disputed);
    if (!gone.size) return drill.block;
    const kept = parsed.items.length - gone.size;
    if (kept < MIN_DRILL_ITEMS || gone.size / parsed.items.length > MAX_DISPUTED_SHARE) return null;
    const removeAt = new Set([...gone].map(i => parsed.items[i].at));
    const obj = { ...parsed.obj, [parsed.listKey]: parsed.obj[parsed.listKey].filter((_, at) => !removeAt.has(at)) };
    return `\`\`\`${drill.lang}\n${JSON.stringify(obj)}\n\`\`\``;
}

/** Replace one fence in a lesson (null removes it) and tidy the blank lines it leaves. */
export function replaceDrill(markdown, block, replacement) {
    const text = String(markdown || '');
    const at = text.indexOf(block);
    if (at < 0) return text;
    const next = text.slice(0, at) + (replacement ?? '') + text.slice(at + block.length);
    return replacement == null ? next.replace(/\n{3,}/g, '\n\n').trim() : next;
}

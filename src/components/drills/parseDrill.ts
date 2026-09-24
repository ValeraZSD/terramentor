import { parseLooseJson } from '../visuals/registry';
import type { DrillItem, DrillMode, DrillSpec, Flashcard } from '../../types';

/**
 * The ```drill tier (D-023): the delegated-widget idea taken to its limit.
 *
 * A widget (D-022) asks a big model to WRITE a sandboxed HTML app — reliable only
 * at 14B+, which is why that tier is gated. A drill asks the model to write only
 * the app's CONTENT — a JSON item bank + a mode enum — and a hand-written native
 * player renders the loop. There is no code for the model to get wrong, so the
 * drill tier is UNGATED: a 7B produces a flawless kana→sound list, and the exact
 * same player serves elements, verb conjugations, capitals, chords or dates. Same
 * philosophy as D-021 "function, not values": never let the model emit the risky
 * part. A drill's risky part is the code, so the app owns it.
 *
 * This module is the parse/validate/normalise front line (the sibling of the
 * visual sanitizers): it turns a fence's loose JSON into a trusted DrillSpec, and
 * synthesises a drill from a node's flashcards for the AI-off degradation path.
 */

/** Fence languages that render as a native drill launcher instead of code. */
export const DRILL_FENCE_LANGS = new Set(['drill', 'practice', 'quiz-drill', 'flashdrill']);

/** Canonical drill fence language, or null for ordinary code / a visual fence. */
export function getDrillLang(language: string | undefined | null): string | null {
    if (!language) return null;
    return DRILL_FENCE_LANGS.has(language.toLowerCase()) ? 'drill' : null;
}

const VALID_MODES: DrillMode[] = ['choice', 'type'];

const asString = (v: unknown): string =>
    typeof v === 'string' ? v.trim()
    : typeof v === 'number' || typeof v === 'boolean' ? String(v)
    : '';

/** Normalise the model's raw modes list to the supported set, defaulting to choice. */
function normaliseModes(raw: unknown): DrillMode[] {
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    const modes = list
        .map(m => asString(m).toLowerCase())
        .map(m => (m === 'multiple_choice' || m === 'mc' || m === 'select' ? 'choice'
            : m === 'text' || m === 'input' || m === 'recall' || m === 'typed' ? 'type' : m))
        .filter((m): m is DrillMode => (VALID_MODES as string[]).includes(m));
    const deduped = [...new Set(modes)];
    return deduped.length ? deduped : ['choice'];
}

function normaliseItems(raw: unknown): DrillItem[] {
    if (!Array.isArray(raw)) return [];
    const items: DrillItem[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        // Tolerate the shapes a small model reaches for: prompt/answer, front/back,
        // question/answer, term/definition, q/a.
        const prompt = asString(e.prompt ?? e.front ?? e.question ?? e.term ?? e.q ?? e.left ?? e.cue);
        const answer = asString(e.answer ?? e.back ?? e.correct ?? e.definition ?? e.a ?? e.right ?? e.response);
        if (!prompt || !answer) continue;
        const rawDistractors = e.distractors ?? e.options ?? e.wrong;
        const distractors: unknown[] = Array.isArray(rawDistractors) ? rawDistractors : [];
        const item: DrillItem = { prompt, answer };
        const cleanDistractors = distractors
            .map(asString)
            .filter(d => d && d.toLowerCase() !== answer.toLowerCase());
        if (cleanDistractors.length) item.distractors = [...new Set(cleanDistractors)];
        const note = asString(e.note ?? e.explanation ?? e.hint);
        if (note) item.note = note;
        items.push(item);
    }
    return items;
}

export interface DrillParseResult {
    spec?: DrillSpec;
    error?: string;
}

/**
 * Parse + validate a ```drill fence body into a trusted DrillSpec.
 *
 * Uses the same loose-JSON reader as the visual specs (unquoted keys, trailing
 * commas, single quotes all tolerated), then normalises field-name variants and
 * enforces the one hard invariant a drill needs to be playable: at least two
 * items each carrying a prompt and an answer. Returns a human error string
 * otherwise, which the launcher shows in place of the game (never a crash).
 */
export async function parseDrillSpec(fenceBody: string): Promise<DrillParseResult> {
    let raw: unknown;
    try {
        raw = await parseLooseJson(fenceBody);
    } catch {
        return { error: 'This practice drill could not be read (invalid format).' };
    }
    if (!raw || typeof raw !== 'object') {
        return { error: 'This practice drill is empty.' };
    }
    const obj = raw as Record<string, unknown>;
    const items = normaliseItems(obj.items ?? obj.cards ?? obj.questions ?? obj.pairs);
    if (items.length < 2) {
        return { error: 'This practice drill needs at least two items to play.' };
    }

    const target = (obj.target && typeof obj.target === 'object' ? obj.target : {}) as Record<string, unknown>;
    const count = Number(target.count ?? obj.count);
    const secondsRaw = target.seconds_per_item ?? target.secondsPerItem ?? obj.seconds_per_item;
    const seconds = Number(secondsRaw);

    const spec: DrillSpec = {
        kind: asString(obj.kind) || 'recognition',
        title: asString(obj.title) || undefined,
        promptLabel: asString(obj.prompt_label ?? obj.promptLabel) || undefined,
        answerLabel: asString(obj.answer_label ?? obj.answerLabel) || undefined,
        modes: normaliseModes(obj.modes ?? obj.mode),
        items,
        target: {
            count: Number.isFinite(count) && count > 0 ? Math.floor(count) : undefined,
            secondsPerItem: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
        },
        source: 'ai',
    };
    return { spec };
}

/**
 * Degradation path (AI off, or a topic with cards but no authored drill): turn a
 * node's flashcards into a recognition drill. The flashcards table IS a per-node
 * item bank — front→prompt, back→answer — so a scored, timed practice game exists
 * for any node with cards, with zero model calls. Distractors are sampled from
 * sibling answers by the player, so no generation is needed here either.
 */
export function drillFromFlashcards(cards: Flashcard[], nodeTitle: string): DrillSpec | null {
    const items: DrillItem[] = cards
        .map(c => ({ prompt: asString(c.front), answer: asString(c.back) }))
        .filter(it => it.prompt && it.answer);
    if (items.length < 4) return null; // too few to make a worthwhile round
    return {
        kind: 'recognition',
        title: `Practice: ${nodeTitle}`,
        promptLabel: 'What is this?',
        modes: ['choice', 'type'],
        items,
        target: { count: Math.min(items.length, 20), secondsPerItem: null },
        source: 'flashcards',
        key: FLASHCARD_DRILL_KEY,
    };
}

/** The one drill a topic's flashcards make — there is only ever one per topic. */
export const FLASHCARD_DRILL_KEY = 'cards';

/**
 * Which drill this is, among the ones a topic's material carries: a short hash
 * of the fence as written (FNV-1a, 32 bits). A drill that is rewritten becomes
 * a new drill, and its old score is not shown against it — the old one was
 * scored on different items. Mirror: `DRILL_KEY` in `server/index.js` accepts
 * exactly this shape and the flashcard key.
 */
export function drillKeyOf(fenceBody: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < fenceBody.length; i++) {
        h ^= fenceBody.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `f${h.toString(16).padStart(8, '0')}`;
}

/** Fisher–Yates — a fresh shuffled copy (used for round order and option order). */
export function shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * How full the bar under the item counter is, in percent.
 *
 * ONE bar, ONE job per drill: a timed drill's bar is its clock and nothing
 * else; an untimed drill's bar is the round's progress. The clock reads null
 * for the whole feedback beat after every answer, so a bar that fell back to
 * progress on null would snap the countdown to 0% on the first press and
 * lurch to 33% on the second. A stopped clock (`remaining` held where the answer stopped it) shows where it
 * stopped; a clock not yet started (null on a timed drill) is full.
 */
export function drillBarFill(seconds: number | null, remaining: number | null, pos: number, total: number): number {
    if (seconds) return Math.min(100, Math.max(0, ((remaining ?? seconds) / seconds) * 100));
    return total > 0 ? (pos / total) * 100 : 0;
}

/** Loose equality for grading typed/selected answers: case + surrounding punctuation insensitive. */
export function answersMatch(a: string, b: string): boolean {
    const norm = (s: string) => s.toLowerCase().trim().replace(/[.,!?;:'"()]/g, '').replace(/\s+/g, ' ');
    return norm(a) === norm(b);
}

/**
 * Build the multiple-choice options for one item: the correct answer plus up to
 * `wanted` distractors — the item's own near-misses first, then unique answers
 * sampled from the rest of the bank — all shuffled. Never fewer than 2 options.
 */
export function buildOptions(item: DrillItem, bank: DrillItem[], wanted = 3): string[] {
    const chosen: string[] = [];
    const seen = new Set([item.answer.toLowerCase().trim()]);
    const push = (v: string) => {
        const key = v.toLowerCase().trim();
        if (v && !seen.has(key)) { seen.add(key); chosen.push(v); }
    };
    for (const d of item.distractors ?? []) push(d);
    for (const other of shuffle(bank)) {
        if (chosen.length >= wanted) break;
        push(other.answer);
    }
    return shuffle([item.answer, ...chosen.slice(0, wanted)]);
}

/**
 * The shared answer vocabulary, when a drill has one.
 *
 * A CLASSIFICATION drill — "approaching or receding?", "prime or composite?",
 * "der/die/das" — asks the same question of every item and answers it from the
 * same tiny set. `buildOptions` reshuffles per item, which is right when the
 * options are drawn from a large bank (positions carry no information and a
 * fixed order would be learnable), and wrong here: the two buttons swap places
 * between one question and the next, so under a five-second timer the learner
 * is re-reading two words they already know instead of answering. That is a
 * measurement of reading speed, not of the thing being drilled.
 *
 * Returns the set only when it genuinely IS closed and small — every item's
 * answer, plus every distractor any item offers, fits within `max` distinct
 * values. Anything larger is an ordinary bank and keeps the per-item shuffle.
 * The order is shuffled once per ROUND by the player, not fixed here: stability
 * is owed within a round, and a permanently fixed order would be memorised.
 */
export function closedOptionSet(bank: DrillItem[], max = 4): string[] | null {
    const seen = new Map<string, string>();
    const add = (v: string) => {
        const key = v.toLowerCase().trim();
        if (key && !seen.has(key)) seen.set(key, v);
    };
    for (const item of bank) {
        add(item.answer);
        for (const d of item.distractors ?? []) add(d);
        if (seen.size > max) return null;
    }
    // Two is the smallest set worth calling a vocabulary; one means every item
    // has the same answer, which is not a drill.
    return seen.size >= 2 ? [...seen.values()] : null;
}

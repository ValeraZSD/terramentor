// How big an AI-created course is allowed to be, decided once from what the
// learner asked for and held at every level of the outline.
//
// Nothing used to budget a creation. The phase plan named no phase count, a
// phase's sections no section count, and the per-section topic prompt no topic
// count at all, so a course grew with the model's enthusiasm rather than the
// learner's request: "Taylor series" with the goal "I want to understand
// Taylor series" came back on 1 Nov 2026 as 8 phases, 89 sections and 811
// topics. The batched topic prompt did say "3 to 6", and the phases that went
// through it held 4 to 6; phases of 11 or 12 sections are wider than
// BATCH_MAX, fell to the per-section prompt, and wrote 9 to 14 each.
//
// So the phase plan now names a SIZE (the model judges the scope from the name,
// the description and its notes), the size fixes a range for each level, every
// prompt states its range, and the code trims what still comes back over it.
// The ranges keep a phase's sections at or under BATCH_MAX, so a phase's topics
// are written by the batched call, which also sees every sibling.

/** Each size's range per level: [fewest asked for, most kept]. */
export const COURSE_SIZES = Object.freeze({
    short: Object.freeze({ phases: [2, 4], sections: [2, 4], topics: [3, 5] }),
    standard: Object.freeze({ phases: [3, 6], sections: [3, 5], topics: [3, 5] }),
    full: Object.freeze({ phases: [5, 10], sections: [3, 6], topics: [3, 6] }),
});

/** A plan that names no size, or one we do not know, is a standard course. */
export const DEFAULT_COURSE_SIZE = 'standard';

/** The size a reply named, or the default. */
export function readCourseSize(value) {
    const key = String(value ?? '').trim().toLowerCase();
    return Object.hasOwn(COURSE_SIZES, key) ? key : DEFAULT_COURSE_SIZE;
}

/**
 * The size of a course whose phases already exist (a continued creation): the
 * smallest size whose phase range holds them. The size itself is not stored;
 * the phase count it produced is, and it is the only part of the plan a run
 * that stopped early is sure to have written.
 */
export function sizeForPhaseCount(n) {
    for (const key of ['short', 'standard', 'full']) {
        if (n <= COURSE_SIZES[key].phases[1]) return key;
    }
    return 'full';
}

/** "2 to 4": a level's range as a prompt states it. */
export const rangeText = ([lo, hi]) => `${lo} to ${hi}`;

// Sentence punctuation a model adds or drops at the ends of a title. Only
// these, only at the ends: a sign inside or ending a title can be the whole
// difference ("C#" and "C", "Na+" and "Na", "e^x" and "e^-x").
const END_PUNCTUATION = /^[\s.,;:!?…'"«»“”„‘’()[\]]+|[\s.,;:!?…'"«»“”„‘’()[\]]+$/gu;

/**
 * A key for "the same title", for dropping a repeat: case, spacing, the
 * composed form of a character and sentence punctuation at the ends do not
 * count; every letter, mark, digit and symbol does, in any script (a mark is
 * the difference between two Devanagari or Thai words).
 */
export function titleKey(title) {
    return String(title ?? '').normalize('NFKC').toLowerCase()
        .replace(/\s+/gu, ' ').replace(END_PUNCTUATION, '');
}

/**
 * A title specific enough that meeting it again elsewhere in the course is a
 * repeat: three words or more. A short label ("Grammar", "Review",
 * "Vocabulary") may rightly head a part in every unit, and dropping one of
 * those would lose a part the course needs. A script written without spaces
 * reads as one word, so its titles are only compared between siblings.
 */
function specific(key) {
    return (key.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) || []).length >= 3;
}

/**
 * `items` without a repeat, then at most `max` of them. A repeat is a title
 * met earlier in `items` (siblings), or a specific title already in `seen`
 * (the rest of the course). The kept titles are added to `seen`. A list
 * every item of which repeats is kept whole rather than emptied: an empty
 * level is a gap the run reports as a failure, and a repeated part is the
 * smaller harm.
 */
export function keepNew(items, seen, max) {
    const fresh = [];
    const keys = new Set();
    for (const it of items) {
        const k = titleKey(it.title);
        if (k && (keys.has(k) || (seen.has(k) && specific(k)))) continue;
        if (k) keys.add(k);
        fresh.push(it);
    }
    const kept = (fresh.length ? fresh : items).slice(0, max);
    for (const it of kept) {
        const k = titleKey(it.title);
        if (k) seen.add(k);
    }
    return kept;
}

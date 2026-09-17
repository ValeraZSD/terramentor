/**
 * Turning a pile of cards into something this engine can actually teach.
 *
 * ## The problem this exists for
 *
 * An imported deck used to become ONE node. A 1.5k-card deck arrived as a
 * project whose entire curriculum was a single topic named after it, holding 1,501
 * flashcards: the tree drew one empty category card saying "No items yet", the
 * dashboard offered "0% complete" against a denominator of 1, and "Your Journey"
 * was a progress bar that could only ever read 0/1 or 1/1. Every other part of
 * the engine keys on a node — the feed picks FOCUS nodes, mastery is per node,
 * checkpoints are node boundaries — so a deck with one node got none of it, and
 * new cards were introduced with nothing to say which ones came first.
 *
 * ## Order is the structure a flat deck actually carries
 *
 * The instinct is to group by meaning (topic vectors are right there). It is the
 * wrong instinct for the same reason the placement probe propagates by
 * curriculum ORDER and not by similarity: a deck is written to be studied front
 * to back, so its order is a difficulty gradient the author chose, while its
 * topical structure is usually flat by construction — a vocabulary deck is 1,500
 * things of exactly the same kind. A frequency deck is ordered by word rank, so
 * "the first fifty cards" is a genuinely meaningful unit ("the fifty most common
 * words") and "fifty cards that mean similar things" is not a unit at all.
 *
 * So the three structure sources, in the order they are trusted:
 *
 *   1. **Subdecks** (`A::B::C`) — the author said so explicitly. Already the
 *      strongest signal, and untouched by anything here.
 *   2. **Tags**, when a deck uses them consistently — many published decks carry
 *      `level-2`, `chapter-3`, `unit-07`. Measured on one real export:
 *      *zero* tags, which is why this cannot be the only path.
 *   3. **The deck's own order** — `cards.due` on a new card is its position in
 *      the new-card queue, i.e. exactly the sequence the author intends. On the
 *      same export that is a unique run from 3 to 1504 across all 1,458
 *      new cards; note id is the fallback for a deck that has been studied.
 *
 * Nothing here calls a model, reads the database, or is anything but arithmetic
 * over a list — which is what lets `tools/deck-gates.mjs` assert all of it.
 */

/**
 * A group smaller than this is already one or two sittings' work and is left
 * whole: splitting 40 cards into two stages of 20 invents ceremony rather than
 * structure.
 */
export const MIN_SPLIT = 60;

/**
 * Candidate stage sizes, smallest first. Round numbers on purpose — "Stage 3,
 * cards 101–150" is a sentence a learner can hold, "cards 97–144" is not.
 */
export const STAGE_SIZES = [25, 50, 100, 200, 500];

/**
 * The band a deck's stage COUNT should land in. Too few and a stage is not a
 * unit of progress any more (5 stages of 300 cards is the one-node problem with
 * extra steps); too many and the tree is a wall the learner has to scroll past
 * to reach anything. 12–40 keeps a 300-card deck and a 5,000-card deck both
 * legible.
 */
export const TARGET_STAGES = { min: 12, max: 40 };

/**
 * How many cards a stage should hold, given how many there are.
 *
 * The smallest round size whose resulting count is at or under `max` wins; if
 * even the largest size overshoots, the largest is used and the deck simply has
 * a lot of stages (a 20,000-card collection is not a shape this can rescue, and
 * capping the count instead would produce stages of 800).
 */
export function chooseStageSize(total) {
    if (total < MIN_SPLIT) return null;
    for (const size of STAGE_SIZES) {
        const count = Math.ceil(total / size);
        if (count <= TARGET_STAGES.max) {
            // Do not go so coarse that the deck has fewer stages than the floor
            // while a finer size would have fitted — that case is caught by
            // taking the FIRST size that fits, which is the smallest.
            return size;
        }
    }
    return STAGE_SIZES[STAGE_SIZES.length - 1];
}

/**
 * Sort key for one imported card within its deck.
 *
 * `order` is Anki's new-card position when the card has one. A card that has
 * been studied has no position left (Anki reuses `due` as a due DATE once the
 * card graduates), so those fall back to note id — which is creation order, and
 * therefore still the order the author added them in.
 *
 * Studied cards sort BEFORE unstudied ones inside a stage-less comparison,
 * because a card someone has already worked on belongs to the part of the deck
 * they have already reached.
 */
export function compareCards(a, b) {
    const ao = Number.isFinite(a?.order) ? a.order : null;
    const bo = Number.isFinite(b?.order) ? b.order : null;
    if (ao !== null && bo !== null && ao !== bo) return ao - bo;
    if (ao !== null && bo === null) return 1;
    if (ao === null && bo !== null) return -1;
    const an = Number(a?.noteId ?? 0), bn = Number(b?.noteId ?? 0);
    if (an !== bn) return an < bn ? -1 : 1;
    return 0;
}

/** Tags that carry no structure: Anki's own markers and note-type noise. */
const NOISE_TAGS = new Set(['marked', 'leech', 'duplicate', 'anki']);

/**
 * Does this group of cards carry a usable tag structure?
 *
 * A tag scheme is only worth preferring over the deck's order when it actually
 * partitions the deck: it has to cover most of the cards, name a handful of
 * groups rather than one per card, and not be a single tag every card shares
 * (which is a label, not a structure).
 */
export function tagStructure(cards, { minCoverage = 0.8, maxGroups = 60 } = {}) {
    const counts = new Map();
    let covered = 0;
    for (const c of cards) {
        const tags = (c.tags ?? []).filter(t => t && !NOISE_TAGS.has(t.toLowerCase()));
        if (!tags.length) continue;
        covered++;
        // One card, one group: the FIRST tag decides, so a card carrying three
        // tags cannot be taught three times. Sorted so the choice does not
        // depend on the order Anki happened to write them in.
        const key = [...tags].sort()[0];
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (!cards.length) return null;
    if (covered / cards.length < minCoverage) return null;
    if (counts.size < 2 || counts.size > maxGroups) return null;
    return [...counts.keys()].sort();
}

/**
 * Split one deck's cards into the child topics it should become.
 *
 * Returns `[]` when the group should stay whole — the caller then hangs the
 * cards on the deck node itself, which is the pre-existing behaviour and the
 * right one for a small deck.
 *
 * Every card ends up in exactly one group, and the groups are returned in the
 * order they should be studied.
 */
export function planStages(cards, { deckName = '' } = {}) {
    const sorted = [...cards].sort(compareCards);
    if (sorted.length < MIN_SPLIT) return [];

    const tags = tagStructure(sorted);
    if (tags) {
        const byTag = new Map(tags.map(t => [t, []]));
        const untagged = [];
        for (const c of sorted) {
            const usable = (c.tags ?? []).filter(t => t && !NOISE_TAGS.has(t.toLowerCase()));
            const key = usable.length ? [...usable].sort()[0] : null;
            if (key && byTag.has(key)) byTag.get(key).push(c);
            else untagged.push(c);
        }
        const groups = tags.map(t => ({
            title: prettyTag(t),
            kind: 'tag',
            cards: byTag.get(t),
        })).filter(g => g.cards.length);
        // Whatever the tag scheme missed still has to be taught. It goes last
        // and says what it is, rather than being silently absent from the tree.
        if (untagged.length) groups.push({ title: 'Untagged', kind: 'tag', cards: untagged });
        return groups.map((g, i) => ({ ...g, position: i, description: tagDescription(g, deckName) }));
    }

    const size = chooseStageSize(sorted.length);
    if (!size) return [];

    // A trailing runt is folded into the stage before it. 1,501 cards at 50 a
    // stage leaves a "Stage 31" holding ONE card, which reads as a bug in the
    // tree and gives the learner a checkpoint they clear by answering a single
    // question. The threshold is generous on purpose: an over-full last stage is
    // invisible, an almost-empty one is not.
    const boundaries = [];
    for (let start = 0; start < sorted.length; start += size) boundaries.push(start);
    const tail = sorted.length - boundaries[boundaries.length - 1];
    if (boundaries.length > 1 && tail < size * 0.4) boundaries.pop();

    const groups = [];
    for (let b = 0; b < boundaries.length; b++) {
        const start = boundaries[b];
        const end = b + 1 < boundaries.length ? boundaries[b + 1] : sorted.length;
        const slice = sorted.slice(start, end);
        const from = start + 1, to = start + slice.length;
        groups.push({
            title: `Stage ${groups.length + 1}`,
            kind: 'order',
            position: groups.length,
            from, to,
            description: `Cards ${from}–${to}${deckName ? ` of ${deckName}` : ''}, in the order the deck introduces them.`,
            cards: slice,
        });
    }
    return groups;
}

/**
 * A tag as a title. `level-2::core` and `unit_07` were written to be typed, not read.
 */
export function prettyTag(tag) {
    const last = String(tag).split('::').filter(Boolean).pop() ?? String(tag);
    const spaced = last.replace(/[_-]+/g, ' ').trim();
    if (!spaced) return String(tag);
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function tagDescription(group, deckName) {
    const n = group.cards.length;
    return `${n} card${n === 1 ? '' : 's'} the deck tagged “${group.title}”${deckName ? ` in ${deckName}` : ''}.`;
}

/**
 * Anki's four card states, which is the vocabulary somebody arriving with a
 * deck already thinks in — and, unlike "0% complete", each of them is true of a
 * specific card rather than of a topic nobody has defined.
 *
 * `MATURE_DAYS` is Anki's own threshold and is not ours to reinvent: a learner
 * comparing the two screens must not see two different numbers of mature cards.
 */
export const MATURE_DAYS = 21;

export function cardState(card) {
    const reps = Number(card?.review_count ?? 0);
    if (!reps || !card?.last_reviewed) return 'new';
    const interval = Number(card?.last_interval ?? 0);
    if (interval >= MATURE_DAYS) return 'mature';
    if (interval >= 1) return 'young';
    return 'learning';
}

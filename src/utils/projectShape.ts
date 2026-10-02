/**
 * What a project is counted IN — the Projects grid card's rule, written once.
 *
 * A project nothing teaches (its teaching switch is off, or it has no topics at
 * all) and that holds cards is measured in CARDS MET: nobody will ever tick its
 * stages or sections off, so a count of closed topics describes a real
 * 1,501-card import as "0 / 1" and 0%. Every screen that asks "is this a deck"
 * asks this instead — the card's count line and ring, the schedule card, the
 * workspace's tabs, a section's count on the tree, and which surface Study opens.
 *
 * It had been copied into three components by hand; one of them drifting is how
 * one project ends up counted two ways on two screens. The server's mirror is
 * `countsInCards` in server/progress.js, and tools/deck-gates.mjs holds the two
 * to one table.
 */
export function countsInCards({ teaches, topics, cards }: {
    teaches?: boolean | null;
    topics?: number | null;
    cards?: number | null;
}): boolean {
    return (teaches === false || !((topics ?? 0) > 0)) && (cards ?? 0) > 0;
}

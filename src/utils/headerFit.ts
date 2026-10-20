/**
 * How the app's top bar spends its width: the tab rail on the left, the search
 * in the middle, the icons on the right.
 *
 * The header is as wide as the PAGE column, not the window: the assistant docks
 * beside it at a width the learner drags (up to 60% of the screen), so a
 * 1280px window can leave a 760px header, and a 1024px one about 410px. A
 * rail that scrolled with a fade at its edge would, at those widths, cut
 * "Schedule" to "Schedul" and hide Atlas entirely, which reads as a rendering
 * fault. So the bar gives things up in a fixed order, each step only when the
 * one before it is not enough, and never cuts a tab:
 *
 *   1. the search sits at the true centre (each side takes half the row);
 *   2. the icons stop taking half and the rail gets their spare room;
 *   3. the search shrinks to its magnifier;
 *   4. the tabs that still do not fit move into a "More" menu, the tab you
 *      are on always staying in the rail.
 *
 * Pure arithmetic on measured widths (px), so a gate can drive it.
 */
export interface HeaderRoom {
    /** The header's content width, padding removed. */
    inner: number;
    /** The gap between the header's three columns. */
    gap: number;
    /** The search button with its words and shortcut, and as its icon alone. */
    search: number;
    searchIcon: number;
    /** The right-hand group at its natural width. */
    right: number;
    /** Each tab's natural width, in rail order, and the gap between two. */
    tabs: number[];
    tabGap: number;
    /** The "More" button. */
    more: number;
}

export interface HeaderFit {
    /** Both sides take half the row, so the search sits at the centre. */
    centred: boolean;
    /** The search is drawn as its icon alone. */
    searchIcon: boolean;
    /** Indices of the tabs drawn in the rail, in rail order; the rest go in More. */
    shown: number[];
}

/** Sub-pixel widths are measured as fractions; half a pixel is not an overflow. */
const SLACK = 0.5;

export function fitHeader(room: HeaderRoom, active: number): HeaderFit {
    const { inner, gap, search, searchIcon, right, tabs, tabGap, more } = room;
    const all = tabs.map((_, i) => i);
    const width = (shown: number[]) =>
        shown.reduce((sum, i) => sum + tabs[i], 0) + tabGap * Math.max(0, shown.length - 1);
    const rail = width(all);

    const half = (inner - search - 2 * gap) / 2;
    if (rail <= half + SLACK && right <= half + SLACK) return { centred: true, searchIcon: false, shown: all };
    if (rail <= inner - search - right - 2 * gap + SLACK) return { centred: false, searchIcon: false, shown: all };

    const room4 = inner - searchIcon - right - 2 * gap;
    if (rail <= room4 + SLACK) return { centred: false, searchIcon: true, shown: all };

    // The first k tabs, the active one swapped in for the last when it would
    // otherwise be hidden; the More button follows the rail after one gap.
    for (let k = tabs.length - 1; k > 0; k--) {
        let shown = all.slice(0, k);
        if (active >= 0 && !shown.includes(active)) shown = [...all.slice(0, k - 1), active];
        if (width(shown) + tabGap + more <= room4 + SLACK) return { centred: false, searchIcon: true, shown };
    }
    return { centred: false, searchIcon: true, shown: [] };
}

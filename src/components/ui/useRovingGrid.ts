import { useCallback, useRef, KeyboardEvent } from 'react';

/**
 * Arrow-key movement inside a grid of choices (a radiogroup drawn as tiles).
 *
 * A grid of sixteen colours or forty icons is ONE stop on the tab path, not
 * sixteen or forty — otherwise reaching the Save button past the icon grid costs
 * forty presses of Tab, which is what both pickers used to cost. So exactly one
 * tile is tabbable (the chosen one, or the first when nothing is chosen) and the
 * arrows move between them.
 *
 * Moving SELECTS, which is the radiogroup convention and the right one here:
 * both grids commit instantly on click too, and a colour you have arrowed onto
 * is already previewed by the surface behind the dialog.
 *
 * `columns` is the grid's real column count, so Up/Down move a row rather than
 * an item. Both grids are a fixed count of columns at every width (see
 * `ColorField`), so this number is a constant and not a measurement.
 */
export function useRovingGrid({ count, index, columns, onSelect }: {
    count: number;
    /** Index of the chosen item, or -1 when the value is not in the grid. */
    index: number;
    columns: number;
    onSelect: (i: number) => void;
}) {
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    // With nothing chosen the first tile carries the tab stop: a group that is
    // entirely `tabIndex={-1}` cannot be reached from the keyboard at all.
    const active = index >= 0 ? index : 0;

    const move = useCallback((to: number) => {
        if (to < 0 || to >= count) return;
        onSelect(to);
        refs.current[to]?.focus();
    }, [count, onSelect]);

    const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>, i: number) => {
        switch (e.key) {
            case 'ArrowRight': e.preventDefault(); move(i + 1 >= count ? 0 : i + 1); break;
            case 'ArrowLeft': e.preventDefault(); move(i - 1 < 0 ? count - 1 : i - 1); break;
            // Down off the last row and Up off the first do nothing rather than
            // wrapping: a wrap by a whole row lands somewhere unrelated, and the
            // grid is two rows deep in the colour case.
            case 'ArrowDown': e.preventDefault(); move(Math.min(i + columns, count - 1)); break;
            case 'ArrowUp': e.preventDefault(); if (i - columns >= 0) move(i - columns); break;
            case 'Home': e.preventDefault(); move(0); break;
            case 'End': e.preventDefault(); move(count - 1); break;
            default: break;
        }
    }, [count, columns, move]);

    /** Props every tile in the grid needs. Spread onto the `<button>`. */
    const itemProps = useCallback((i: number) => ({
        ref: (el: HTMLButtonElement | null) => { refs.current[i] = el; },
        tabIndex: i === active ? 0 : -1,
        onKeyDown: (e: KeyboardEvent<HTMLElement>) => onKeyDown(e, i),
    }), [active, onKeyDown]);

    return { itemProps };
}

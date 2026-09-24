import { useEffect, useRef, useState, ReactNode } from 'react';
import { cx, FOCUS_RING } from './vocabulary';

export interface Segment<T extends string | number> {
    value: T;
    label: ReactNode;
    /** Tooltip / accessible detail when the label alone is terse. */
    title?: string;
    disabled?: boolean;
}

interface Props<T extends string | number> {
    /** Names the group for a screen reader. Required — a bare row of buttons says nothing. */
    label: string;
    value: T;
    options: Segment<T>[];
    onChange: (value: T) => void;
    /** `md` (40px) by default; `sm` (32px) only inside a dense toolbar. */
    size?: 'sm' | 'md';
    /**
     * Stacked instead of side by side.
     *
     * The same control, turned: when the space it floats in is narrower than it
     * is long — the atlas's surface switch over a phone-width map — a row of
     * segments spends the whole width and pushes everything under it down the
     * screen, while a column of them sits beside what it belongs to. The
     * height then belongs to each segment rather than to the track, so a touch
     * target is still a touch target.
     */
    orientation?: 'horizontal' | 'vertical';
    /**
     * Whether the control paints its own track.
     *
     * Off for a control that is itself a panel — the atlas's surface switch is
     * a box floating on the map, made of the map's own chrome material, and a
     * track inside it is a second, paler surface sitting on the first. The
     * selected segment is still lifted out of whatever it is on, which is what
     * carries the selection either way.
     */
    track?: boolean;
    className?: string;
}

/**
 * One implementation of "pick exactly one of a few", replacing four hand-rolled
 * ones: Monday/Sunday at 30px, the embedding-provider pills at 26px, the theme
 * row, and the sort chips — each with its own track padding, radius and height.
 *
 * It is a real radiogroup, so it behaves like every other one on the platform:
 * ONE tab stop for the whole group, then ←/→ (and ↑/↓) move between segments and
 * select as they go, Home/End jump to the ends. That roving-tabindex behaviour
 * is what a row of `<button>`s never gives you — there, Tab walks every option
 * and nothing selects on arrow.
 */
export function SegmentedControl<T extends string | number>({
    label, value, options, onChange, size = 'md', orientation = 'horizontal',
    track = true, className,
}: Props<T>) {
    const vertical = orientation === 'vertical';
    const ref = useRef<HTMLDivElement>(null);
    const [wrapped, setWrapped] = useState(false);

    // Has the row actually wrapped?
    //
    // A segment has no edge of its own: the track holds them together and the
    // one lifted surface says which is chosen, which is exactly right on one
    // line. On two it stops being a row of buttons — "Venster Gemaximaliseerd"
    // over "Volledig scherm" reads as a paragraph in a grey box, and nothing
    // in it says where one option ends and the next begins. So once, and only
    // once, the segments have wrapped, they stand apart as separate chips and
    // the track stands down.
    //
    // Measured rather than guessed: whether three labels fit is a question
    // about the container's width, this language's words and the reader's
    // `ui_scale`, and the answer changes while the app is open. Wrapped, the
    // control is only ever WIDER (a bigger gap, no other layout change), so a
    // measurement can never argue with the one after it.
    useEffect(() => {
        const el = ref.current;
        if (!el || vertical) { setWrapped(false); return; }
        const measure = () => {
            const kids = Array.from(el.children) as HTMLElement[];
            const top = kids[0]?.offsetTop ?? 0;
            setWrapped(kids.some(k => k.offsetTop !== top));
        };
        measure();
        // Guarded like `useElementWidth`: the jsdom harnesses that render whole
        // screens stub this, and one that forgets should fail on what it is
        // checking, not on a control measuring itself.
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [vertical, options]);

    // Follow the selection with focus, as a native radiogroup does. Every key
    // that changes the value goes through here: the roving tabindex lives on
    // `data-selected`, so a change that moved the value without moving focus left
    // the focused segment holding `tabIndex={-1}` — Home and End did exactly that.
    const select = (next: T) => {
        onChange(next);
        requestAnimationFrame(() => {
            ref.current?.querySelector<HTMLButtonElement>('[data-selected="true"]')?.focus();
        });
    };

    const move = (delta: number) => {
        const usable = options.filter(o => !o.disabled);
        if (!usable.length) return;
        const at = usable.findIndex(o => o.value === value);
        select(usable[(at + delta + usable.length) % usable.length].value);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        switch (e.key) {
            case 'ArrowRight': case 'ArrowDown': e.preventDefault(); move(1); break;
            case 'ArrowLeft': case 'ArrowUp': e.preventDefault(); move(-1); break;
            case 'Home': e.preventDefault(); select(options.find(o => !o.disabled)!.value); break;
            case 'End': e.preventDefault(); select([...options].reverse().find(o => !o.disabled)!.value); break;
        }
    };

    // The track is `raised` on the ladder and the SELECTED segment is a surface
    // lifted out of it — the inverse (tinting the selected one accent) made the
    // control read as a button that was somehow always pressed.
    //
    // With no track under it the segment is a white chip on a white panel and
    // the only thing saying which one is chosen is a soft shadow: legible on
    // the dark theme, where it is `slate-900` on `slate-800`, and nearly
    // nothing on the light one. A hairline in the same border colour the
    // panels use draws it in both, and still tints nothing.
    const chosen = cx(
        'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm',
        (!track || wrapped) && 'ring-1 ring-slate-200 dark:ring-slate-600',
    );
    // Wrapped, the unselected ones are separate buttons in the `subtle` fill —
    // the same chips the endpoint presets draw, chosen one lifted among them
    // (white/dark + hairline ring). The outline-alone version read as a grey
    // box around rows of buttons: the track still painted behind the wrap, so
    // the whole control kept the one look this state is supposed to leave.
    const outlined = wrapped &&
        'bg-slate-100 dark:bg-slate-700 can-hover:hover:bg-slate-200 dark:can-hover:hover:bg-slate-600';
    // Stacked, the height is the segment's own: the track no longer has one to
    // share out. `flex-1` and a MINIMUM rather than a fixed height, so a column
    // told to match something taller beside it shares that height between its
    // segments instead of leaving a gap under them.
    const stacked = size === 'md'
        ? 'flex-1 min-h-10 touch:min-h-11'
        : 'flex-1 min-h-8 touch:min-h-11';
    // In a row the height came from the track, shared out by `items-stretch`.
    // Once the row may WRAP, the track no longer knows it, and a second line
    // would be as tall as its text — 20px of tap target. These are exactly the
    // heights stretch was handing out (32/36 at `md`, 24/36 at `sm`), so a row
    // that still fits is drawn to the pixel as before.
    const inRow = size === 'md'
        ? 'min-h-8 touch:min-h-9'
        : 'min-h-6 touch:min-h-9';
    return (
        <div
            ref={ref}
            role="radiogroup"
            aria-label={label}
            aria-orientation={orientation}
            onKeyDown={onKeyDown}
            className={cx(
                // A row that does not fit WRAPS; it never spills.
                //
                // `shrink-0` with a fixed height is a promise that four
                // segments will always fit on one line, and a translation
                // breaks it: "How much should the model think" became "На
                // усмотрение модели · Кратко · Умеренно · Тщательно" — 371px of
                // control in a 326px panel, so "Тщательно" was cut off 41px
                // past the panel's edge and the first segment's label wrapped
                // to three lines that spilled above and below a 40px track,
                // over the heading and the prose. Measured at 390px in ru.
                // Wrapping costs a second row in the one language that needs
                // it; `h-` becomes `min-h-` because the track no longer knows
                // how tall its own content is.
                // Wrapped, the track stands down entirely — no grey box, no padding:
                // separate chips in the `subtle` fill are the whole look (the
                // endpoint presets, at every width). Only a row that FITS is a
                // track with segments lifted out of it.
                'inline-flex max-w-full flex-wrap items-stretch rounded-lg',
                wrapped ? 'gap-1.5' : 'gap-0.5 p-1',
                track && !wrapped && 'bg-slate-100 dark:bg-slate-700/70',
                vertical ? 'flex-col' : size === 'md' ? 'min-h-10 touch:min-h-11' : 'min-h-8 touch:min-h-11',
                className,
            )}
        >
            {options.map(o => {
                const selected = o.value === value;
                return (
                    <button
                        key={String(o.value)}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        data-selected={selected}
                        tabIndex={selected ? 0 : -1}
                        disabled={o.disabled}
                        title={o.title}
                        onClick={() => onChange(o.value)}
                        className={cx(
                            'inline-flex items-center justify-center rounded-md px-3 font-medium transition-colors',
                            '[touch-action:manipulation] disabled:opacity-45 disabled:cursor-default', FOCUS_RING,
                            size === 'md' ? 'text-sm' : 'text-xs',
                            vertical ? stacked : inRow,
                            selected ? chosen
                                : cx('text-slate-600 dark:text-slate-300 can-hover:hover:text-slate-900 dark:can-hover:hover:text-white', outlined),
                        )}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}

export default SegmentedControl;

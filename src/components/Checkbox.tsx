import { useEffect, useRef } from 'react';
import { Check, Minus } from 'lucide-react';

/**
 * THE checkbox. One box, one tick, everywhere.
 *
 * There were five of them. A native `<input type="checkbox">` carrying
 * `rounded border-slate-300 text-accent focus:ring-accent` — Tailwind classes
 * that do nothing at all without `@tailwindcss/forms`, which this project does
 * not install — so those boxes rendered as the browser's own control: a white
 * square with a black tick, on a slate-800 panel, in the dark theme. A second
 * set used `accent-accent`, which does work, but paints the *browser's* box in
 * the accent and still looks like nothing else in the app. A third pair hid the
 * input with `className="hidden"` and drew a div beside it — `hidden` takes an
 * element out of the tab order, so those two were unreachable by keyboard
 * entirely. Only the Anki import had a proper one, written inline.
 *
 * So: the input is still a real checkbox (`sr-only`, focusable, announced,
 * space toggles it, forms and screen readers see it), and the visible box is a
 * sibling that follows it with `peer-*`. The tick is the same lucide `Check`
 * the rest of the app uses, at a stroke weight that survives an 18px box.
 *
 * `indeterminate` is a THIRD state, not a styling flag: it is set on the DOM
 * node in an effect because the property has no HTML attribute, and it draws a
 * dash — the "some of these" of a select-all row.
 */
export interface CheckboxProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    /** Mixed state for a parent row whose children disagree. */
    indeterminate?: boolean;
    disabled?: boolean;
    id?: string;
    name?: string;
    /** Needed when the box has no adjacent <label> text of its own. */
    'aria-label'?: string;
    'aria-describedby'?: string;
    /** Extra classes on the WRAPPER — alignment (`mt-0.5`) belongs to the caller. */
    className?: string;
    /** `switch` where the control reads as on/off rather than checked/unchecked. */
    role?: 'checkbox' | 'switch';
}

export default function Checkbox({
    checked, onChange, indeterminate = false, disabled = false,
    id, name, className = '', role,
    'aria-label': ariaLabel, 'aria-describedby': ariaDescribedBy,
}: CheckboxProps) {
    const ref = useRef<HTMLInputElement>(null);

    // `indeterminate` is a property, never an attribute — React cannot set it
    // through JSX, so it is reapplied on every render that could change it.
    useEffect(() => {
        if (ref.current) ref.current.indeterminate = indeterminate && !checked;
    }, [indeterminate, checked]);

    const on = checked || indeterminate;

    return (
        <span className={`relative inline-grid shrink-0 place-items-center ${className}`}>
            <input
                ref={ref}
                id={id}
                name={name}
                type="checkbox"
                role={role}
                checked={checked}
                disabled={disabled}
                aria-label={ariaLabel}
                aria-describedby={ariaDescribedBy}
                onChange={e => onChange(e.target.checked)}
                className="peer sr-only"
            />
            <span
                aria-hidden="true"
                className={`grid h-[1.125rem] w-[1.125rem] place-items-center rounded-[0.3rem] border-2 transition-colors
                    peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60 peer-focus-visible:ring-offset-2
                    peer-focus-visible:ring-offset-white dark:peer-focus-visible:ring-offset-slate-800
                    peer-disabled:opacity-40
                    ${on
                        ? 'border-accent bg-accent text-white'
                        : 'border-slate-300 bg-white dark:border-slate-500 dark:bg-slate-700/60'}`}
            >
                {/* Rendered only when it is on — not drawn transparent. An
                    invisible tick still in the DOM is a tick as far as any
                    check that is not a screenshot is concerned, and
                    `anki-harness` asserts exactly that ("...and the drawn tick
                    goes away"). The box is a fixed-size grid, so there is
                    nothing to reflow either way. */}
                {on && (indeterminate && !checked
                    ? <Minus className="h-3 w-3" strokeWidth={3.5} />
                    : <Check className="h-3 w-3" strokeWidth={3.5} />)}</span>
        </span>
    );
}

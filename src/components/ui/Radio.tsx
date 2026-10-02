/**
 * THE radio. One circle, one dot, everywhere — the sibling `Checkbox.tsx`
 * should have had from the start.
 *
 * Settings' PDF-recovery mode was four native `<input type="radio">` carrying
 * `accent-accent`: the browser's own control, measured at **13px** in the
 * running app. That is half the 24px floor the app set for itself, it is the
 * OS's circle rather than the app's, and `accent-accent` is the exact pattern
 * `Checkbox` was written to remove (it paints the browser's box in the accent
 * and still looks like nothing else here).
 *
 * Same construction as `Checkbox`, for the same reasons: the input stays a real
 * radio (`sr-only`, focusable, announced, arrow keys move within the `name`
 * group, forms see it) and the visible circle is a sibling that follows it with
 * `peer-*`. The dot is drawn only when it is on, never drawn transparent — an
 * invisible dot is still a dot to anything that is not a screenshot.
 */
export interface RadioProps {
    checked: boolean;
    onChange: () => void;
    /** Groups the radios so the platform's arrow-key behaviour works. */
    name: string;
    value?: string;
    disabled?: boolean;
    id?: string;
    /** Needed when the circle has no adjacent <label> text of its own. */
    'aria-label'?: string;
    'aria-describedby'?: string;
    /** Extra classes on the WRAPPER — alignment (`mt-0.5`) belongs to the caller. */
    className?: string;
}

export default function Radio({
    checked, onChange, name, value, disabled = false, id, className = '',
    'aria-label': ariaLabel, 'aria-describedby': ariaDescribedBy,
}: RadioProps) {
    return (
        <span className={`relative inline-grid shrink-0 place-items-center ${className}`}>
            <input
                id={id}
                name={name}
                value={value}
                type="radio"
                checked={checked}
                disabled={disabled}
                aria-label={ariaLabel}
                aria-describedby={ariaDescribedBy}
                onChange={() => onChange()}
                className="peer sr-only"
            />
            <span
                aria-hidden="true"
                className={`grid h-[1.125rem] w-[1.125rem] place-items-center rounded-full border-2 transition-colors
                    peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60 peer-focus-visible:ring-offset-2
                    peer-focus-visible:ring-offset-white dark:peer-focus-visible:ring-offset-slate-800
                    peer-disabled:opacity-40
                    ${checked
                        ? 'border-accent bg-accent'
                        : 'border-slate-300 bg-white dark:border-slate-500 dark:bg-slate-700/60'}`}
            >
                {checked && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
            </span>
        </span>
    );
}

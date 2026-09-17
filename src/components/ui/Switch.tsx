import { cx, FOCUS_RING } from './vocabulary';

interface Props {
    checked: boolean;
    onChange: (next: boolean) => void;
    /** Accessible name. Required when no visible `<label>` points at this switch. */
    label: string;
    disabled?: boolean;
    id?: string;
    className?: string;
}

/**
 * The on/off switch. Two hand-rolled copies existed (Enable AI, Enable semantic
 * search) with the same 64×32 track and neither a focus ring nor a keyboard
 * story beyond the browser's default — and one of them announced itself with
 * `aria-pressed`, which a screen reader reads as a toggle BUTTON, not a switch.
 *
 * 44×24 rather than 64×32: the old one was wider than a "Yes/No" segmented
 * control would have been, which made a binary look like the biggest decision
 * on the panel. The hit area is padded back up to 44px on touch.
 */
export default function Switch({ checked, onChange, label, disabled, id, className }: Props) {
    return (
        <button
            id={id}
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={cx(
                'relative shrink-0 w-11 h-6 rounded-full transition-colors [touch-action:manipulation]',
                'disabled:opacity-45 disabled:cursor-default', FOCUS_RING,
                checked ? 'bg-accent' : 'bg-slate-300 dark:bg-slate-600',
                className,
            )}
        >
            {/* The track is 24px tall because a switch should not be the biggest
                thing on the panel; the TARGET is 44 regardless, spilled outside
                the track rather than inflating it. */}
            <span className="absolute -inset-x-1.5 -inset-y-2.5" aria-hidden="true" />
            <span
                aria-hidden="true"
                className={cx(
                    'absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out',
                    checked && 'translate-x-5',
                )}
            />
        </button>
    );
}

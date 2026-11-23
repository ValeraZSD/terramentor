import { useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cx, FOCUS_RING } from './vocabulary';

interface Props {
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (next: number) => void;
    /** Accessible name for the number field and both arrows. */
    label: string;
    /** Rendered after the number (e.g. "%"). Part of the display, not the value. */
    suffix?: string;
    id?: string;
    className?: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * − value + on the app's 40px control scale.
 *
 * Replaces two steppers that agreed about nothing: the feed's (44px, bordered,
 * arrows outside a shared box) and the interface-size one (a 48px pill track of
 * two 40px white buttons). It is one bordered field with two arrow ends, so it
 * reads as a FIELD you can nudge rather than as two buttons that happen to sit
 * beside a number.
 *
 * The native spinner is hidden on purpose: its arrows are 6px, invisible until
 * hover, and drawn by the OS so they ignore the theme. Typing still works, and
 * ↑/↓ in the field step by `step` because it is still a number input.
 *
 * While the field is being typed in it shows what was typed, empty or partial
 * ("4" on the way to 45 under a minimum of 5), and only a number already inside
 * min..max is passed on. Clamping every keystroke rewrote the digit as it was
 * typed. Leaving the field or pressing Enter clamps; an empty field goes back
 * to the last value.
 */
export default function Stepper({ value, min, max, step = 1, onChange, label, suffix, id, className }: Props) {
    const { t } = useTranslation();
    const set = (n: number) => onChange(clamp(n, min, max));
    // What is typed in the field, null while it just shows `value`.
    const [draft, setDraft] = useState<string | null>(null);
    // A value that came from anywhere but the typing (the arrows, the parent)
    // replaces what was typed.
    useEffect(() => { setDraft(d => (d !== null && d.trim() !== '' && Number(d) === value ? d : null)); }, [value]);
    const nudge = (n: number) => { setDraft(null); set(n); };
    const commit = () => {
        const n = draft === null || draft.trim() === '' ? NaN : Number(draft);
        setDraft(null);
        if (!Number.isNaN(n) && clamp(n, min, max) !== value) set(n);
    };
    const arrow = cx(
        'grid w-9 shrink-0 place-items-center text-slate-500 dark:text-slate-400 transition-colors',
        'can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-700 can-hover:hover:text-slate-900 dark:can-hover:hover:text-white',
        'disabled:opacity-30 disabled:cursor-default [touch-action:manipulation]', FOCUS_RING,
    );
    return (
        <div
            className={cx(
                'inline-flex shrink-0 items-stretch h-10 touch:h-11 overflow-hidden rounded-lg',
                'border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
                className,
            )}
        >
            <button type="button" onClick={() => nudge(value - step)} disabled={value <= min}
                aria-label={t("Less: {{setting}}", { setting: label })} className={cx(arrow, 'border-e border-slate-200 dark:border-slate-700')}>
                <Minus className="w-4 h-4" aria-hidden="true" />
            </button>
            <div className="relative flex items-center">
                <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    aria-label={label}
                    min={min} max={max} step={step}
                    value={draft ?? value}
                    onChange={e => {
                        const text = e.target.value;
                        setDraft(text);
                        const n = Number(text);
                        if (text.trim() !== '' && n >= min && n <= max) onChange(n);
                    }}
                    onBlur={commit}
                    onKeyDown={e => { if (e.key === 'Enter') commit(); }}
                    className={cx(
                        'w-14 h-full bg-transparent border-0 text-center text-sm font-medium tabular-nums',
                        'text-slate-900 dark:text-white outline-none',
                        '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
                        suffix && 'pe-3',
                    )}
                />
                {suffix && (
                    <span className="pointer-events-none absolute end-2 text-xs text-slate-500 dark:text-slate-400" aria-hidden="true">
                        {suffix}
                    </span>
                )}
            </div>
            <button type="button" onClick={() => nudge(value + step)} disabled={value >= max}
                aria-label={t("More: {{setting}}", { setting: label })} className={cx(arrow, 'border-s border-slate-200 dark:border-slate-700')}>
                <Plus className="w-4 h-4" aria-hidden="true" />
            </button>
        </div>
    );
}

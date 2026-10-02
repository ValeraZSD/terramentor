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
 */
export default function Stepper({ value, min, max, step = 1, onChange, label, suffix, id, className }: Props) {
    const { t } = useTranslation();
    const set = (n: number) => onChange(clamp(n, min, max));
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
            <button type="button" onClick={() => set(value - step)} disabled={value <= min}
                aria-label={t("Less: {{setting}}", { setting: label })} className={cx(arrow, 'border-r border-slate-200 dark:border-slate-700')}>
                <Minus className="w-4 h-4" aria-hidden="true" />
            </button>
            <div className="relative flex items-center">
                <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    aria-label={label}
                    min={min} max={max} step={step}
                    value={value}
                    onChange={e => { const n = Number(e.target.value); if (!Number.isNaN(n)) set(n); }}
                    className={cx(
                        'w-14 h-full bg-transparent border-0 text-center text-sm font-medium tabular-nums',
                        'text-slate-900 dark:text-white outline-none',
                        '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
                        suffix && 'pr-3',
                    )}
                />
                {suffix && (
                    <span className="pointer-events-none absolute right-2 text-xs text-slate-500 dark:text-slate-400" aria-hidden="true">
                        {suffix}
                    </span>
                )}
            </div>
            <button type="button" onClick={() => set(value + step)} disabled={value >= max}
                aria-label={t("More: {{setting}}", { setting: label })} className={cx(arrow, 'border-l border-slate-200 dark:border-slate-700')}>
                <Plus className="w-4 h-4" aria-hidden="true" />
            </button>
        </div>
    );
}

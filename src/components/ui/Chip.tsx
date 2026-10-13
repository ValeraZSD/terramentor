import { forwardRef, ButtonHTMLAttributes, ReactNode } from 'react';
import { FOCUS_RING, cx } from './vocabulary';

/**
 * A pressable PILL in a strip of pills: the feed header's counts and its
 * deadline, a "cards due" count beside two status pills, a suggested question
 * under the assistant's composer. Not a button on the control scale: its height
 * is one line of 12px text, because a strip of these must stay one line tall on
 * a phone, and the touch target is the row's own padding. `rounded-full`,
 * because a pill is not a box (see `vocabulary.ts`).
 *
 * Each place used to spell the pill by hand — a `CHIP` string in one file,
 * `px-2.5 py-1 rounded-full` in the next, `px-2.5 py-1.5` in a third — so the
 * same kind of thing came in three heights. One component, one height.
 */
export type ChipTone = 'neutral' | 'amber' | 'red' | 'accent';

const TONE: Record<ChipTone, string> = {
    neutral: 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 ' +
        'can-hover:hover:border-slate-300 dark:can-hover:hover:border-slate-500 can-hover:hover:text-slate-900 dark:can-hover:hover:text-white',
    amber: 'bg-amber-50 dark:bg-amber-900/15 border-amber-200 dark:border-amber-800/50 text-amber-700 dark:text-amber-300 ' +
        'can-hover:hover:brightness-95 dark:can-hover:hover:brightness-125',
    red: 'bg-red-50 dark:bg-red-900/15 border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-300 ' +
        'can-hover:hover:brightness-95 dark:can-hover:hover:brightness-125',
    accent: 'bg-accent/10 border-accent/25 text-accent-fg can-hover:hover:bg-accent/15',
};

interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
    tone?: ChipTone;
    icon?: ReactNode;
    /** May shrink and truncate its text (a name of any length) rather than
     *  hold its width. A prop, not a class: `shrink` beside the chip's own
     *  `shrink-0` would be settled by stylesheet order, not by the caller. */
    shrink?: boolean;
    className?: string;
}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
    { tone = 'neutral', icon, shrink = false, className, children, type = 'button', ...rest }, ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            className={cx(
                'inline-flex min-h-6 items-center gap-1 px-2.5 py-0.5 rounded-full border text-xs font-medium',
                shrink ? 'min-w-0 shrink' : 'shrink-0',
                'whitespace-nowrap transition [touch-action:manipulation]',
                TONE[tone], FOCUS_RING, className,
            )}
            {...rest}
        >
            {icon}
            {children}
        </button>
    );
});

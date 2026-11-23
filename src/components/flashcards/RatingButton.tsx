import type { ButtonHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewRating } from '../../utils/srs';
import { RATING_STYLES } from './ratingStyles';
import { FOCUS_RING, cx } from '../ui/vocabulary';
import { usePointerVerb } from '../../utils/platform';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> {
    rating: ReviewRating;
    /** The second line: when the card comes back if this is pressed. */
    when: string;
    /** The key that presses it, shown only where a keyboard exists. */
    keycap?: string;
    /** Selected, waiting for a second press to confirm (`useConfirmPress`).
     *  `false` (not undefined) whenever confirm is on, so the button is a
     *  toggle from the start and arming it reads as a state change. */
    armed?: boolean;
    /** A word in place of the rating's own, for a tile that stands for more
     *  than one rating (a card not due yet in Practise all: "Knew it"). */
    label?: string;
    className?: string;
}

/**
 * One of the four rating tiles — Again, Hard, Good, Easy — on every surface
 * that rates a card: the review session, a topic's cards and a card in the
 * feed. They shared a colour map (`ratingStyles.ts`) and nothing else, so the
 * same four buttons came in three shapes: a 2px border on one surface, none on
 * the next; an icon on two of them; 44, 48 and 56px tall. The tile is one
 * shape now: icon, word, when it comes back, and the keycap where there are keys.
 */
export function RatingButton({ rating, when, keycap, armed, label, className, type = 'button', ...rest }: Props) {
    const { t } = useTranslation();
    const pointerVerb = usePointerVerb();
    const style = RATING_STYLES[rating];
    const Icon = style.icon;
    return (
        <button data-rating
            type={type}
            data-armed={armed || undefined}
            // The state change on the focused button is what a screen reader
            // announces; the changed second line alone is never read out.
            aria-pressed={armed}
            className={cx(
                'flex flex-col items-center justify-center gap-0.5 min-h-11 px-1 py-2 rounded-lg border',
                'transition-colors [touch-action:manipulation] disabled:opacity-50 disabled:cursor-default',
                style.bg, style.border, style.color, FOCUS_RING,
                // Selected and waiting for the second press (Confirm before
                // grading): a ring in the rating's own colour, and the line
                // under the name says what to do.
                armed && 'ring-2 ring-current ring-offset-2 ring-offset-white dark:ring-offset-slate-800',
                className,
            )}
            {...rest}
        >
            {keycap && <span className="text-xs text-slate-500 dark:text-slate-400 font-mono" aria-hidden="true">{keycap}</span>}
            <Icon className="w-4 h-4" aria-hidden="true" />
            <span className="text-sm font-semibold">{label ?? t(style.label)}</span>
            <span className="text-xs">{armed ? t("{{pointerVerb}} again", { pointerVerb }) : when}</span>
        </button>
    );
}

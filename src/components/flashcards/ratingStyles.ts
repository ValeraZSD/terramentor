import { RotateCcw, ThumbsDown, ThumbsUp, Sparkles } from 'lucide-react';
import { k } from '../../i18n';
import type { ReviewRating } from '../../utils/srs';

/**
 * The four rating buttons' look, in ONE place. Three review surfaces
 * (`FlashcardView`, `FlashcardFeedCard`, `GlobalFlashcardReview`) each kept
 * their own colour map and one had drifted: -600 text on a -100 tint, which
 * measured 2.7:1 for "Good". 700-grade text on a 100-grade tint is the pair
 * that clears AA, and a surface that wants the colours reads them from here
 * rather than re-deciding them.
 */
export const RATING_ORDER: ReviewRating[] = ['again', 'hard', 'good', 'easy'];

interface RatingStyle {
    label: string;
    icon: typeof RotateCcw;
    /** Text colour, for the label and icon. */
    color: string;
    /** Fill, with its hover. */
    bg: string;
    border: string;
    /** `bg` + `color` — what a plain button takes. */
    cls: string;
}

// Spelled out in full: Tailwind finds class names by scanning source text, so a
// name assembled from a hue variable would generate no CSS.
export const RATING_STYLES: Record<ReviewRating, RatingStyle> = {
    again: {
        label: k("Again"),
        icon: RotateCcw,
        color: 'text-red-700 dark:text-red-300',
        bg: 'bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/50',
        border: 'border-red-300 dark:border-red-700',
        cls: 'bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/50 text-red-700 dark:text-red-300',
    },
    hard: {
        label: k("Hard"),
        icon: ThumbsDown,
        color: 'text-orange-700 dark:text-orange-300',
        bg: 'bg-orange-100 dark:bg-orange-900/30 hover:bg-orange-200 dark:hover:bg-orange-900/50',
        border: 'border-orange-300 dark:border-orange-700',
        cls: 'bg-orange-100 dark:bg-orange-900/30 hover:bg-orange-200 dark:hover:bg-orange-900/50 text-orange-700 dark:text-orange-300',
    },
    good: {
        label: k("Good"),
        icon: ThumbsUp,
        color: 'text-emerald-700 dark:text-emerald-300',
        bg: 'bg-emerald-100 dark:bg-emerald-900/30 hover:bg-emerald-200 dark:hover:bg-emerald-900/50',
        border: 'border-emerald-300 dark:border-emerald-700',
        cls: 'bg-emerald-100 dark:bg-emerald-900/30 hover:bg-emerald-200 dark:hover:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300',
    },
    easy: {
        label: k("Easy"),
        icon: Sparkles,
        color: 'text-blue-700 dark:text-blue-300',
        bg: 'bg-blue-100 dark:bg-blue-900/30 hover:bg-blue-200 dark:hover:bg-blue-900/50',
        border: 'border-blue-300 dark:border-blue-700',
        cls: 'bg-blue-100 dark:bg-blue-900/30 hover:bg-blue-200 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300',
    },
};

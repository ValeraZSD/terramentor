import { HTMLAttributes, ReactNode } from 'react';
import { cx } from './vocabulary';

/**
 * A thin bar that fills from the left: a quiz's question count, a topic's
 * estimated mastery, an import's progress, a pace against the plan.
 *
 * Every one of these used to pick its own empty part — `bg-slate-100` on one,
 * `200` or `300` on the next, heights of 4, 6, 8 and 12px — and in light theme
 * the slate-100 track on a tinted card measured 1.03:1 against it: a 0% bar was
 * not a short bar, it was nothing at all (Terramentor, 3 Nov 2026, the
 * chapter-end card).
 *
 * **The empty part is OUTLINED.** A track filled dark enough to clear 3:1
 * against its surface (WCAG 1.4.11) would be a mid grey, as dark as the fill
 * itself, and the line between done and not done would disappear instead. So
 * the track keeps a faint wash and draws its full length as a 1px inset ring
 * that clears 3:1 on every surface a bar sits on, in every theme tint; the
 * fill, painted over the ring, clears 3:1 against the same surfaces.
 * `progress-bar-gates.mjs` measures both, composited, against the list of
 * surfaces in that file, and refuses a hand-made track anywhere else.
 */

/** The empty part. Literal class strings, because Tailwind only emits what it
 *  can read, and because the gate parses them back into colours. */
export const PROGRESS_TRACK_WASH = 'bg-slate-500/10 dark:bg-slate-400/10';
export const PROGRESS_TRACK_RING = 'ring-1 ring-inset ring-slate-500/90 dark:ring-slate-400/80';
/** Both halves, for a track. A slot that is selected or hovered (a phase's
 *  topic ticks) takes the wash and swaps the ring for its own. */
export const PROGRESS_TRACK = `${PROGRESS_TRACK_WASH} ${PROGRESS_TRACK_RING}`;

/** What a fill MEANS, not a colour. `accent` is the theme's text accent, which
 *  is already solved per theme and per project colour to be legible on the
 *  page; the status tones are the shade of each hue that clears 3:1 on both
 *  ends of the surface list. */
export type ProgressTone = 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export const PROGRESS_FILL: Record<ProgressTone, string> = {
    accent: 'bg-accent-fg',
    success: 'bg-emerald-700 dark:bg-emerald-400',
    warning: 'bg-amber-800 dark:bg-amber-400',
    danger: 'bg-red-700 dark:bg-red-300',
    info: 'bg-blue-700 dark:bg-blue-400',
    neutral: 'bg-slate-500 dark:bg-slate-400',
};

/** sm: a bar inside a line of small print or a dense list row; md: the
 *  default; lg: a bar that is the subject of its panel (a deck's states, a
 *  phase of a course). In rem, so `ui_scale` reaches it. */
export type ProgressSize = 'sm' | 'md' | 'lg';

const HEIGHT: Record<ProgressSize, string> = { sm: 'h-1.5', md: 'h-2', lg: 'h-3' };

interface TrackProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'> {
    size?: ProgressSize;
    /** Square ends, for a strip that runs edge to edge under a header. */
    flush?: boolean;
    /** Width and margins only; the shape is this file's. Full width unless
     *  this sets one (`w-16`, `flex-1`): `w-full` in the base would beat
     *  `w-16` by Tailwind's stylesheet order, not by who asked. */
    className?: string;
    children?: ReactNode;
}

const sizesItself = (className?: string) => /(?:^|\s)(?:w-|flex-1\b)/.test(className ?? '');

/** The shape alone, for a bar whose fills are not one value from the left
 *  (a deck's card states side by side). Its children are the fills, each an
 *  `h-full` box; a split bar names itself with `role="img"` and a label. */
export function ProgressTrack({ size = 'md', flush = false, className, children, ...rest }: TrackProps) {
    return (
        <div
            className={cx('flex overflow-hidden', !sizesItself(className) && 'w-full', HEIGHT[size], flush ? 'rounded-none' : 'rounded-full', PROGRESS_TRACK, className)}
            {...rest}
        >
            {children}
        </div>
    );
}

type Naming =
    /** Read out as a progress bar, with this name. */
    | { label: string; decorative?: never }
    /** The number is printed beside it, so a reader would hear it twice. */
    | { decorative: true; label?: never };

type ProgressBarProps = Naming & {
    /** 0 … max; clamped. */
    value: number;
    max?: number;
    tone?: ProgressTone;
    size?: ProgressSize;
    flush?: boolean;
    /** The amount is not known yet: `value` is only what is drawn, and no
     *  number is read out. */
    unknown?: boolean;
    /** `linear` for a countdown redrawn every tick, which an eased transition
     *  would trail behind. */
    motion?: 'smooth' | 'linear';
    /** The least fill DRAWN, in percent, so work that has started shows a
     *  sliver; what is read out stays `value`. */
    minVisible?: number;
    className?: string;
};

export default function ProgressBar({
    value, max = 100, tone = 'accent', size = 'md', flush = false, unknown = false, motion = 'smooth', minVisible = 0, className, label, decorative,
}: ProgressBarProps) {
    const safeMax = max > 0 ? max : 1;
    const v = Math.min(safeMax, Math.max(0, Number.isFinite(value) ? value : 0));
    return (
        <ProgressTrack
            size={size}
            flush={flush}
            className={className}
            {...(decorative
                ? { 'aria-hidden': true }
                : {
                    role: 'progressbar',
                    'aria-label': label,
                    'aria-valuemin': 0,
                    'aria-valuemax': safeMax,
                    'aria-valuenow': unknown ? undefined : Math.round(v * 100) / 100,
                })}
        >
            <div
                className={cx('h-full shrink-0 transition-[width]', motion === 'linear' ? 'duration-100 ease-linear' : 'duration-300', PROGRESS_FILL[tone])}
                style={{ width: `${Math.max(minVisible, (v / safeMax) * 100)}%` }}
            />
        </ProgressTrack>
    );
}

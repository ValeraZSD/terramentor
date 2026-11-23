import { useId, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccentVars } from '../../hooks/useAccentVars';
import { ProjectIcon } from '../ProjectIcon';
import { StreamCourse, StreamHeadingShift } from './streamCourse';
import OwnLine from '../ui/OwnLine';

/**
 * One course's run of Today (`courseBlocks.ts`): its name once, in a header
 * that stays at the top of the stream while any of the block is on screen and
 * is pushed off by the next block's, and the course's cards under it, none of
 * which repeats the name (`StreamCourse`).
 *
 * The header is opaque, never translucent: cards scroll under it, and text
 * showing through a pinned header is what got the topic header unpinned
 * (ChapterGroup). It is not a control: the topic header below already opens
 * the topic, and a second way into the course would be a duplicate.
 */
export default function CourseBlock({ name, color, icon, continued, children }: {
    name: string;
    color: string | null | undefined;
    icon: string | null | undefined;
    continued: boolean;
    children: ReactNode;
}) {
    const { t } = useTranslation();
    const headingId = useId();
    const accent = useAccentVars(color);
    return (
        // A named group, not a <section>: a region landmark per course would
        // list every course twice over in a screen reader's landmarks. What
        // scrolls into view stops below the pinned header through the
        // scroller's `scroll-padding-top` (FeedView), not a margin per card.
        // A block after another gets more room above it than the gap between
        // two parts of one course, so the change of course reads as the
        // bigger break. The header is wider than the cards so a card's shadow
        // never shows past it while scrolling under; its rule is only as wide
        // as the cards.
        <div role="group" aria-labelledby={headingId} className="space-y-5 [&:not(:first-child)]:pt-6">
            <h2
                id={headingId}
                style={accent as CSSProperties | undefined}
                className="sticky top-0 z-[5] -mx-3 sm:-mx-4 px-3 sm:px-4 min-h-11 py-2 flex items-center gap-2.5 bg-slate-100 dark:bg-slate-900 after:absolute after:bottom-0 after:inset-x-3 sm:after:inset-x-4 after:h-px after:bg-slate-300 dark:after:bg-slate-700"
            >
                <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-white bg-accent">
                    <ProjectIcon icon={icon} className="h-4 w-4" />
                </span>
                <span className="min-w-0 truncate text-lg font-bold text-slate-900 dark:text-white"><OwnLine>{name}</OwnLine></span>
                {continued && (
                    <span className="shrink-0 text-xs font-normal text-slate-500 dark:text-slate-400">{t("continued")}</span>
                )}
            </h2>
            <StreamCourse.Provider value={name}>
                <StreamHeadingShift.Provider value={1}>
                    {children}
                </StreamHeadingShift.Provider>
            </StreamCourse.Provider>
        </div>
    );
}

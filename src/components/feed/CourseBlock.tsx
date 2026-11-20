import { useId, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccentVars } from '../../hooks/useAccentVars';
import { ProjectIcon } from '../ProjectIcon';
import { StreamCourse, StreamHeadingShift } from './streamCourse';

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
        // `--course-h`: the pinned header's height, so a card the stream scrolls
        // to stops below it (STREAM_SCROLL_MARGIN).
        <section aria-labelledby={headingId} className="space-y-5" style={{ '--course-h': '2.75rem' } as CSSProperties}>
            <h2
                id={headingId}
                style={accent as CSSProperties | undefined}
                className="sticky top-0 z-[5] -mx-3 sm:-mx-4 px-3 sm:px-4 min-h-11 py-2 flex items-center gap-2 bg-slate-100 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700/70"
            >
                <span className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 text-white bg-accent">
                    <ProjectIcon icon={icon} className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 truncate text-sm font-semibold text-slate-900 dark:text-white">{name}</span>
                {continued && (
                    <span className="shrink-0 text-xs font-normal text-slate-500 dark:text-slate-400">{t("continued")}</span>
                )}
            </h2>
            <StreamCourse.Provider value={name}>
                <StreamHeadingShift.Provider value={1}>
                    {children}
                </StreamHeadingShift.Provider>
            </StreamCourse.Provider>
        </section>
    );
}

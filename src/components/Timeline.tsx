import type { ReactNode } from 'react';

/**
 * Renderers for the `<Timeline>` / `<TimelineEvent>` tags the tutor may write in
 * a lesson (see `src/utils/timeline.ts` for the syntax and why it is tags rather
 * than a fenced spec).
 *
 * Everything here is ordinary DOM, so an event body keeps the full markdown
 * pipeline — lists, bold, links, `$…$` formulas, even a nested visual — which is
 * the entire reason this exists instead of a ```mermaid timeline.
 *
 * The rail is drawn with a border on the list and a dot per event rather than an
 * absolutely-positioned line, so it can never drift out of alignment when an
 * event body wraps to a different height on a phone.
 */

export function Timeline({ children }: { children?: ReactNode }) {
    return (
        <ol className="timeline my-5 ml-2 list-none space-y-5 border-l-2 border-slate-200 pl-0 dark:border-slate-700">
            {children}
        </ol>
    );
}

interface TimelineEventProps {
    /** Timestamp, deadline or date range — rendered as the accent badge. */
    time?: string;
    /** Heading for the event. */
    title?: string;
    children?: ReactNode;
}

export function TimelineEvent({ time, title, children }: TimelineEventProps) {
    return (
        <li className="relative list-none pl-5">
            {/* The dot sits ON the rail: half its width to the left of the
                border, vertically aligned with the first line of the badge. */}
            <span
                aria-hidden="true"
                className="absolute -left-[7px] top-1.5 h-3 w-3 rounded-full border-2 border-white bg-accent dark:border-slate-900"
            />
            {time && (
                <div className="mb-1">
                    <span className="inline-block rounded bg-accent/10 px-2 py-0.5 text-xs font-semibold tracking-wide text-accent-fg">
                        {time}
                    </span>
                </div>
            )}
            {title && (
                <div className="mb-1 font-semibold leading-snug text-slate-900 dark:text-slate-100">{title}</div>
            )}
            {/* `last:mb-0` on the Markdown <p> renderer keeps the final
                paragraph flush, so events space evenly regardless of body. */}
            <div className="text-slate-700 dark:text-slate-300">{children}</div>
        </li>
    );
}

import { createContext, createElement, useContext, type ReactNode } from 'react';

/**
 * The course a stream already names in its own header (a course's or a topic's
 * Study page, a course block on Today), or null where none does. A card
 * never repeats the name the page heads with: on a course's page every card
 * would carry the same line.
 */
export const StreamCourse = createContext<string | null>(null);

/** The course line a card shows: none when it only repeats the page's own. */
export function useCourseLine(projectName: string | null | undefined): string | null {
    const shown = useContext(StreamCourse);
    return projectName && projectName !== shown ? projectName : null;
}

/**
 * How many levels the stream's headings sit below their own: 1 inside a course
 * block on Today, whose header is the heading that names the course, so a
 * topic's title is the next level down from it.
 */
export const StreamHeadingShift = createContext(0);

type HeadingTag = 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/**
 * Where a card the stream scrolls to stops: clear of the feed's strip
 * (`--feed-top`, measured by FeedView). A course block's pinned header is
 * cleared by the scroller's own `scroll-padding-top` on Today, which adds to
 * this margin, so it is not counted here as well.
 */
export const STREAM_SCROLL_MARGIN = 'calc(var(--feed-top, 0px) + 1rem)';

/** The tag for a stream heading of `level` (2 for a topic or a round). */
export function useStreamHeading(level: 2 | 3 | 4): HeadingTag {
    return `h${Math.max(2, Math.min(6, level + useContext(StreamHeadingShift)))}` as HeadingTag;
}

/**
 * A card on its own in the stream, not inside a topic or a round: its title
 * heads at the topic's level (3 under a course block's header, 2 on a course's
 * page), not one below a topic heading that is not there.
 */
export function StandaloneHeading({ children }: { children: ReactNode }) {
    const shift = useContext(StreamHeadingShift);
    return createElement(StreamHeadingShift.Provider, { value: shift - 1 }, children);
}

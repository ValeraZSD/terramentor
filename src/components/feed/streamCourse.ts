import { createContext, useContext } from 'react';

/**
 * The course a stream already names in its own header (a course's or a topic's
 * Study page), or null where cards from several courses mix (Today). A card
 * never repeats the name the page heads with: on a course's page every card
 * would carry the same line.
 */
export const StreamCourse = createContext<string | null>(null);

/** The course line a card shows: none when it only repeats the page's own. */
export function useCourseLine(projectName: string | null | undefined): string | null {
    const shown = useContext(StreamCourse);
    return projectName && projectName !== shown ? projectName : null;
}

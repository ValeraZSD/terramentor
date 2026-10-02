import type { TFunction } from 'i18next';
import type { PaceStatus } from '../types';

/**
 * How far off the plan a project is, as one translated sentence.
 *
 * There were three copies of this sentence and none of them could be read in
 * anything but English. `server/scheduling.js` builds it as a template literal
 * whose plural is a letter chosen by a ternary, and the workspace header, the
 * study dashboard and the schedule editor printed that verbatim — so a German
 * reader got "16 days behind schedule" between two translated lines. The
 * schedule editor had its own hardcoded copy on top, the same way.
 *
 * The server still returns `message`; nothing on screen reads it. A count is a
 * `count` key here, so the number and its noun agree in every language.
 */
export function paceHeadline(
    status: PaceStatus | undefined,
    days: number,
    t: TFunction,
    // The schedule editor draws a Recalibrate button beside this sentence, so
    // it asks for the version that does not end by suggesting one.
    { terse = false }: { terse?: boolean } = {},
): string {
    if (terse && status === 'critical') {
        return days === 0 ? t("Slightly behind schedule") : t("{{count}} days behind schedule", { count: days });
    }
    switch (status) {
        case 'ahead':
            return days === 0 ? t("On track") : t("{{count}} days ahead of schedule", { count: days });
        case 'on_track':
            return t("On track");
        case 'falling_behind':
            return days === 0 ? t("Slightly behind schedule") : t("{{count}} days behind schedule", { count: days });
        case 'critical':
            return days === 0
                ? t("Slightly behind schedule")
                : t("{{count}} days behind — consider recalibrating", { count: days });
        case 'no_tasks':
            return t("No tasks to track");
        default:
            return t("No schedule set");
    }
}

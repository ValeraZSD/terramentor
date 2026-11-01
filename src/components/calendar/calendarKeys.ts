import { appMayTakeShortcut, ShortcutLike } from '../../utils/escapeKey';

export type CalendarKeyAction = 'prev' | 'next' | 'today' | 'month' | 'week' | 'day';

/** Elements whose own arrow keys move along them (the Month / Week / Day switch
 *  is a radiogroup): an arrow pressed there is theirs, not the calendar's. */
const OWN_ARROWS = '[role="radiogroup"],[role="tablist"],[role="menu"],[role="listbox"]';

/**
 * Which calendar action a key press asks for, or null when the press is not the
 * calendar's to take.
 *
 * ← and → step the period, `t` goes to today, `m` / `w` / `d` pick the view: on
 * a 2560px screen these save a trip across it for every step. The app's rule
 * decides when a letter is free at all (`appMayTakeShortcut`: not while typing,
 * not under a dialog or a review session, no modifier); on top of it a press
 * made in another part of the app (the course tree beside a course's calendar,
 * the docked assistant) belongs to that part, so only a press with focus inside
 * the calendar or on nothing at all is taken.
 */
export function calendarKey(e: ShortcutLike & { key: string }, root: Element | null, doc: Document = document): CalendarKeyAction | null {
    if (!appMayTakeShortcut(e, doc)) return null;
    const target = e.target as HTMLElement | null;
    const onNothing = !target || target === doc.body || target === doc.documentElement;
    if (!onNothing && !root?.contains(target)) return null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (target?.closest?.(OWN_ARROWS)) return null;
        return e.key === 'ArrowLeft' ? 'prev' : 'next';
    }
    switch (e.key.length === 1 ? e.key.toLowerCase() : '') {
        case 't': return 'today';
        case 'm': return 'month';
        case 'w': return 'week';
        case 'd': return 'day';
        default: return null;
    }
}

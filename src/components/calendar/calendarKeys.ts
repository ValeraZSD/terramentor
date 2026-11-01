import { useEffect, useRef } from 'react';
import { appMayTakeShortcut, isTextEntry, shortcutLetter, ShortcutLike } from '../../utils/escapeKey';
import { CalendarViewMode } from '../../types';

export type CalendarKeyAction = 'prev' | 'next' | 'today' | CalendarViewMode;

/** Each key as a keycap, for the tooltips and Settings → Keyboard shortcuts. */
export const CALENDAR_KEYCAPS: Record<CalendarKeyAction, string> = {
    prev: '←', next: '→', today: 'T', month: 'M', week: 'W', day: 'D',
};

/** The same keys for `aria-keyshortcuts`, which a screen reader announces. */
export const CALENDAR_ARIA_KEYS: Record<CalendarKeyAction, string> = {
    prev: 'ArrowLeft', next: 'ArrowRight', today: 'T', month: 'M', week: 'W', day: 'D',
};

/** Focus on one of these owns ←/→ already: the view switch's radios step
 *  through Month / Week / Day on them, as every radiogroup does. */
const OWN_ARROWS = '[role="radiogroup"],[role="tablist"],[role="menu"],[role="listbox"],[role="slider"]';

/**
 * What a key press does to the calendar, or null when it is not the calendar's.
 *
 * ← and → step the period, T goes to today, M / W / D pick the view. Whether a
 * letter is free at all is `appMayTakeShortcut`'s rule, the one the app-wide
 * C and A keys follow: not while typing, not with a modifier, not under a modal.
 * Beyond that a press is the calendar's only when focus is inside it or on
 * nothing; the outline tree beside a course's calendar walks itself on the same
 * arrows. A held key acts once, so one press is one period.
 */
export function calendarKey(
    e: ShortcutLike & { key: string; code?: string; repeat?: boolean },
    root: Element | null,
    doc: Document = document,
): CalendarKeyAction | null {
    if (e.repeat || !appMayTakeShortcut(e, doc)) return null;
    const target = e.target as HTMLElement | null;
    const onNothing = !target || target === doc.body || target === doc.documentElement;
    if (!onNothing && !root?.contains(target)) return null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (target?.closest?.(OWN_ARROWS)) return null;
        return e.key === 'ArrowLeft' ? 'prev' : 'next';
    }
    switch (shortcutLetter(e)) {
        case 't': return 'today';
        case 'm': return 'month';
        case 'w': return 'week';
        case 'd': return 'day';
        default: return null;
    }
}

export interface CalendarKeyHandlers {
    prev: () => void;
    next: () => void;
    today: () => void;
    view: (mode: CalendarViewMode) => void;
}

/**
 * Listens for `calendarKey` on the window, attached ONCE: the root and the
 * handlers are read from a ref, so each press calls the current render's.
 * Re-attaching on every render (the calendar re-renders on each resize tick)
 * also moved the listener to the back of the window's queue every time.
 */
export function useCalendarKeys(root: Element | null, handlers: CalendarKeyHandlers) {
    const latest = useRef({ root, handlers });
    latest.current = { root, handlers };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const { root: r, handlers: h } = latest.current;
            const action = calendarKey(e, r);
            if (!action) return;
            e.preventDefault();
            if (action === 'prev') h.prev();
            else if (action === 'next') h.next();
            else if (action === 'today') h.today();
            else h.view(action);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
}

/**
 * Should the calendar take focus as it opens?
 *
 * It is opened from a link or a tab OUTSIDE it (the top bar's Calendar, a
 * course's Calendar tab), and a clicked link keeps focus, so without this every
 * key above belonged to that link until the learner clicked into the calendar.
 * Never taken from text being typed or a dropdown, from under a modal, or when
 * focus is already inside.
 */
export function calendarMayTakeFocus(root: Element | null, doc: Document = document): boolean {
    if (!root) return false;
    const active = doc.activeElement as HTMLElement | null;
    if (active && root.contains(active)) return false;
    if (isTextEntry(active) || active?.tagName === 'SELECT' || active?.getAttribute?.('role') === 'combobox') return false;
    return !doc.querySelector('[role="dialog"][aria-modal="true"], [data-owns-keyboard]');
}

/** Moves focus to the calendar once, as it opens, when `calendarMayTakeFocus`. */
export function useCalendarFocusOnOpen(root: HTMLElement | null) {
    useEffect(() => {
        if (root && calendarMayTakeFocus(root)) root.focus({ preventScroll: true });
    }, [root]);
}

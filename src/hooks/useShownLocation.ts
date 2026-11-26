import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, type Location } from 'react-router-dom';
import { endHold, swapScreen } from '../utils/screenSwap';

/**
 * Which screen a pathname is. A course's tab is a screen of its own
 * (`/project/3/tree`), but the topic picked inside it (`/project/3/tree/41`)
 * is not: picking a topic, or stepping through topics with the keyboard,
 * answers at once, as a click inside a page should.
 */
export function screenOf(pathname: string): string {
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] !== 'project') return `/${parts.join('/')}`;
    // `/project/3` is the dashboard, as the store reads it.
    return `/project/${parts[1] ?? ''}/${parts[2] ?? 'dashboard'}`;
}

/**
 * The location the SCREEN shows, which trails the address bar while the next
 * screen is drawn: a move to another screen keeps the current one on view
 * until the new one is whole (`utils/screenSwap.ts`). The routes and the
 * store's route both follow this location, never `useLocation()` directly, so
 * nothing on the old screen is emptied before the swap.
 *
 * A move within the same screen (a hash, a query, another topic) is shown at
 * once.
 */
export function useShownLocation(): Location {
    const location = useLocation();
    const [shown, setShown] = useState(location);
    // The newest address, for a swap whose turn comes after a later move.
    const latest = useRef(location);
    // A swap started and not drawn yet: the screen on view is still the old one.
    const waiting = useRef(false);

    useLayoutEffect(() => {
        latest.current = location;
        // Back on, or within, the screen still on view before a waiting swap
        // drew: that swap would hold the page for nothing. Once it has drawn,
        // the screen on view is the new one, and a move within it (a page that
        // rewrites its own address on arrival) must not cut its hold short.
        if (location.key === shown.key) { if (waiting.current) endHold(); return; }
        if (screenOf(location.pathname) === screenOf(shown.pathname)) {
            if (waiting.current) endHold();
            setShown(location);
            return;
        }
        // `draw` runs either now (no view transitions: a plain state update
        // inside this effect) or later from the browser's transition, where it
        // must render before returning so the new screen is what gets shown.
        let now = true;
        waiting.current = true;
        swapScreen(() => {
            waiting.current = false;
            if (now) setShown(latest.current);
            else flushSync(() => setShown(latest.current));
        });
        now = false;
        // `shown` is deliberately not a dependency: only a new address starts a move.
    }, [location]);

    return shown;
}

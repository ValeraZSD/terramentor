import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, type Location } from 'react-router-dom';
import { swapScreen } from '../utils/screenSwap';

/**
 * The location the SCREEN shows, which trails the address bar while the next
 * screen is drawn: a move to another page keeps the current one on view until
 * the new one is whole (`utils/screenSwap.ts`). The routes and the store's
 * route both follow this location, never `useLocation()` directly, so nothing
 * on the old screen is emptied before the swap.
 *
 * A move within the same page (a hash, a query) is not a new screen and is
 * shown at once.
 */
export function useShownLocation(): Location {
    const location = useLocation();
    const [shown, setShown] = useState(location);
    // The newest address, for a swap whose turn comes after a later move.
    const latest = useRef(location);

    useLayoutEffect(() => {
        latest.current = location;
        if (location.key === shown.key) return;
        if (location.pathname === shown.pathname) { setShown(location); return; }
        // `draw` runs either now (no view transitions: a plain state update
        // inside this effect) or later from the browser's transition, where it
        // must render before returning so the new screen is what gets shown.
        let now = true;
        swapScreen(() => {
            if (now) setShown(latest.current);
            else flushSync(() => setShown(latest.current));
        });
        now = false;
        // `shown` is deliberately not a dependency: only a new address starts a move.
    }, [location]);

    return shown;
}

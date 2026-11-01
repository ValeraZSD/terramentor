import { useEffect, useRef } from 'react';

/**
 * The header's back arrow, offered to the page first.
 *
 * Most screens go back the way the browser does. A page with a level of its
 * own inside one address takes the press as "up" instead: Settings on a phone
 * is a list, then a section, and the arrow on a section returns to the list,
 * even when the section was opened from a link elsewhere in the app (where the
 * browser's back would leave Settings). That is the Up/Back split Material
 * draws: the arrow in the bar goes up the app's own levels, the system back
 * retraces time.
 *
 * The page listens with `useAppBack`; the header calls `offerAppBack()` and
 * does its own step only when no page took it.
 */
const APP_BACK = 'terramentor:app-back';

/** True when a page handled the press. */
export function offerAppBack(): boolean {
    const e = new Event(APP_BACK, { cancelable: true });
    return !window.dispatchEvent(e);
}

/** While `handler` is a function, the header's back arrow is this page's to
 *  answer; return false from it to let the header do its usual step. */
export function useAppBack(handler: (() => boolean) | null): void {
    const ref = useRef(handler);
    ref.current = handler;
    const on = handler != null;
    useEffect(() => {
        if (!on) return;
        const listen = (e: Event) => { if (ref.current?.()) e.preventDefault(); };
        window.addEventListener(APP_BACK, listen);
        return () => window.removeEventListener(APP_BACK, listen);
    }, [on]);
}

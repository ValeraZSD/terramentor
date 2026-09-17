import { CSSProperties, useLayoutEffect, useRef, useState } from 'react';

/**
 * Carry the workspace's accent across a portal.
 *
 * `Layout` themes the whole app with the current project's colour by setting
 * `--accent-rgb` / `--accent-fg-rgb` on a descendant of `<html>`. Anything
 * rendered at the end of the BODY — every dialog, and the review session —
 * leaves that subtree, so `text-accent-fg` there resolves to the default accent
 * instead of the project's. Read the two variables where the overlay was
 * WRITTEN and hand them to the portalled root.
 *
 * Render `anchor` where the overlay sits in the JSX and spread `accent` onto
 * the portalled element's `style`. The anchor is `display: none`, so it costs
 * no layout — it exists only as a place to read inherited custom properties
 * from, which is why it cannot be replaced by reading `document.documentElement`.
 */
export function usePortalAccent(active: boolean) {
    const anchor = useRef<HTMLSpanElement>(null);
    const [accent, setAccent] = useState<CSSProperties>();

    useLayoutEffect(() => {
        if (!active || !anchor.current) { setAccent(undefined); return; }
        const cs = getComputedStyle(anchor.current);
        const rgb = cs.getPropertyValue('--accent-rgb').trim();
        const fg = cs.getPropertyValue('--accent-fg-rgb').trim();
        setAccent(rgb || fg
            ? ({ '--accent-rgb': rgb, '--accent-fg-rgb': fg } as CSSProperties)
            : undefined);
    }, [active]);

    return { anchor, accent };
}

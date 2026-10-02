import { useCallback, useRef } from 'react';

/** How far the pointer may travel between press and release and still be a tap. */
const TAP_SLOP_PX = 10;

/**
 * Things inside a tap surface that own their own click. A tap surface wraps
 * RENDERED CONTENT, and rendered content has working parts in it: a link, a
 * visual block's "Fix with AI" and Source buttons, and now a `<summary>` whose
 * entire job is to toggle on click. Without this the surface's own action fires
 * too — clicking a collapsible in a notes preview opened the collapsible AND
 * replaced the whole preview with a textarea, so the thing just clicked was
 * gone before it finished opening.
 *
 * `contenteditable` is listed because a rendered widget may carry one; `label`
 * because clicking it activates its control.
 */
const OWNS_ITS_CLICK =
    'a[href],button,summary,input,select,textarea,label,[role="button"],[role="link"],[contenteditable="true"]';

/**
 * Did this click land on a working part INSIDE `surface` (rather than on the
 * surface's own content)? The surface itself never counts — it usually carries
 * `role="button"` for the keyboard path, which would otherwise match.
 *
 * Exported for the guard suite: it is the whole rule, and it is pure.
 */
export function ownsItsClick(target: unknown, surface: Element | null): boolean {
    if (!surface || !target || typeof (target as Element).closest !== 'function') return false;
    const hit = (target as Element).closest(OWNS_ITS_CLICK);
    return !!hit && hit !== surface && surface.contains(hit);
}

/**
 * "This click was a TAP, not the end of a drag" — the guard every
 * click-to-do-something surface that also contains selectable text needs.
 *
 * On a touchscreen, selecting a formula out of a rendered answer means
 * long-pressing and dragging a handle, and that gesture ends with a `click` on
 * whatever is under the finger. So a backdrop that closes on click closed while
 * the learner was still selecting, and a notes preview that opens the editor on
 * click swapped the rendered markdown for a textarea and discarded the
 * selection. Both were reproducible enough that people gave up after a few
 * tries rather than reporting it — the gesture simply "didn't work".
 *
 * Four conditions, all cheap:
 *  - the press landed on this element (optionally: on it *exactly*, not a child)
 *  - the click did not land on a working part inside it (see `ownsItsClick`)
 *  - the pointer moved less than a finger's slop between press and release
 *  - nothing is selected right now
 *
 * Keyboard activation is unaffected — it never goes through these handlers.
 *
 * @param onTap what to run when the click really was a tap.
 * @param selfOnly true for backdrops, where a click that started on a CHILD
 *        (the dialog itself) must never count. False for a surface whose own
 *        children are legitimate press targets, like a notes preview.
 */
export function useTapGuard(onTap: () => void, selfOnly = false) {
    const press = useRef<{ x: number; y: number } | null>(null);

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        press.current = selfOnly && e.target !== e.currentTarget
            ? null
            : { x: e.clientX, y: e.clientY };
    }, [selfOnly]);

    const onClick = useCallback((e: React.MouseEvent) => {
        const start = press.current;
        press.current = null;
        if (selfOnly && (!start || e.target !== e.currentTarget)) return;
        if (ownsItsClick(e.target, e.currentTarget as Element)) return;
        if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP_PX) return;
        if (!window.getSelection()?.isCollapsed) return;
        onTap();
    }, [onTap, selfOnly]);

    return { onPointerDown, onClick };
}

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { usePortalAccent } from '../../hooks/usePortalAccent';
import { MENU_PANEL, placePopover, type Placement } from '../ui/Popover';
import { cx } from '../ui/vocabulary';
import { canHover } from '../../utils/platform';

/** Long enough that a pointer crossing the header on its way elsewhere
 *  opens nothing; short enough to feel like an answer. */
const OPEN_DELAY_MS = 400;

/** When Tab was last pressed anywhere, so focus can tell a keyboard arrival
 *  from focus a closing dialog puts back (both are `:focus-visible`). */
let lastTabAt = -Infinity;
if (typeof document !== 'undefined') {
    document.addEventListener('keydown', e => { if (e.key === 'Tab') lastTabAt = performance.now(); }, true);
}

/**
 * A card that answers "what is this update?" while the pointer rests on the
 * header's update button, or keyboard focus reaches it, before anything is
 * pressed: pressing "Update available" starts the download at once, so this
 * is the one place to read what it brings first. Like the update button in
 * T3 Code and the tooltip a browser shows on its own update button.
 *
 * Read-only (`role="tooltip"`, nothing to press inside), so it can close the
 * moment the pointer leaves. Only on a screen with a hovering pointer: a
 * phone has no hover, so there a press opens the dialog, which holds the
 * same notes and the Download button (UpdateControl). While it is open,
 * Escape closes it and is claimed, so the page under it does not also act on
 * that press.
 */
export function useUpdateHoverCard(anchorRef: RefObject<HTMLElement | null>, content: ReactNode) {
    const [open, setOpen] = useState(false);
    const id = useId();
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
    const close = useCallback(() => { clear(); setOpen(false); }, []);
    useEffect(() => clear, []);

    const triggerProps = {
        onPointerEnter: (e: React.PointerEvent) => {
            if (e.pointerType !== 'mouse' || !canHover()) return;
            clear();
            timer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
        },
        onPointerLeave: close,
        // Reached with Tab, not handed back by a dialog closing: focus returning
        // to the button after the update dialog is no question about it.
        onFocus: () => { if (canHover() && performance.now() - lastTabAt < 500) setOpen(true); },
        onBlur: close,
        onPointerDown: close,
        'aria-describedby': open ? id : undefined,
    };
    const card = <HoverCard open={open} id={id} anchorRef={anchorRef} onClose={close}>{content}</HoverCard>;
    return { triggerProps, card };
}

function HoverCard({ open, id, anchorRef, onClose, children }: {
    open: boolean;
    id: string;
    anchorRef: RefObject<HTMLElement | null>;
    onClose: () => void;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [place, setPlace] = useState<Placement | null>(null);
    const { anchor: accentAnchor, accent } = usePortalAccent(open);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    useLayoutEffect(() => {
        if (!open) { setPlace(null); return; }
        const btn = anchorRef.current, card = ref.current;
        if (!btn || !card) return;
        setPlace(placePopover(btn.getBoundingClientRect(), { width: card.offsetWidth, height: card.offsetHeight },
            { width: window.innerWidth, height: window.innerHeight }, { align: 'end', gap: 6 }));
    }, [open, anchorRef, children]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            closeRef.current();
        };
        // Only a scroll that moves the button moves the card off it; a list
        // scrolling elsewhere on the page (the feed loading more) leaves it.
        const onScroll = (e: Event) => {
            if (e.target instanceof Node && anchorRef.current && !e.target.contains(anchorRef.current)) return;
            closeRef.current();
        };
        const onResize = () => closeRef.current();
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onResize);
        };
    }, [open, anchorRef]);

    return (
        <>
            <span ref={accentAnchor} className="hidden" aria-hidden="true" />
            {open && createPortal(
                <div
                    ref={ref}
                    id={id}
                    role="tooltip"
                    style={{ ...accent, left: place?.left ?? 0, top: place?.top ?? 0, maxWidth: place?.maxWidth, visibility: place ? 'visible' : 'hidden' }}
                    // The menu panel's surface (one step up from the header), with
                    // room for sentences.
                    className={cx('fixed z-50 w-[min(22rem,calc(100vw-1rem))] pointer-events-none text-sm text-slate-700 dark:text-slate-200', MENU_PANEL, 'p-3')}
                >
                    {children}
                </div>,
                document.body,
            )}
        </>
    );
}

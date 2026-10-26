import { useCallback, useLayoutEffect, useRef, useState, useEffect } from 'react';
import type { ReactNode, RefObject, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { usePortalAccent } from '../../hooks/usePortalAccent';
import { FOCUS_RING, cx } from './vocabulary';

/**
 * A MENU that opens from a button: portalled to the body, anchored to the
 * button's own edge, and kept on the screen.
 *
 * Hand-written menus each get a different part wrong. Hanging a menu from the
 * button's RIGHT edge with `absolute right-0` runs it off a card's left edge
 * wherever the button sits at the left of the card — the answer help after "Not
 * quite", on every phone — and placing a box assumed to be 144px wide is only
 * right at 100% `ui_scale`. So placement is one pure function over
 * MEASURED boxes (`placePopover`), and the menu is one component.
 *
 * Behaviour is the WAI-ARIA menu-button pattern, kept small: the first item
 * takes focus on open, ↑/↓ (wrapping), Home and End move it, Escape closes and
 * hands focus back to the button, Tab closes, a press outside closes. It follows
 * its button while the page scrolls and closes when the button leaves the
 * screen, because a menu floating over the wrong card is worse than none.
 */

export interface Box { left: number; top: number; right: number; bottom: number }

export interface Placement {
    left: number;
    top: number;
    /** Which side of the button it opened on. */
    side: 'below' | 'above';
    /** Set when the viewport is narrower than the menu: the width it must fit. */
    maxWidth?: number;
}

/**
 * Where a menu of `size` goes against a button at `anchor`, in a viewport of
 * `view`. Pure, so the gate can run the cases a browser would.
 *
 *   - horizontally it lines up with the button's START edge (the reading
 *     direction's edge, where the eye already is); if that runs past the right
 *     of the screen it lines up with the button's END edge instead; and if
 *     neither fits it is clamped `margin` inside the screen. Never off it.
 *   - vertically it opens BELOW the button, and above it only when below does
 *     not fit and above does; otherwise it is clamped to the screen too.
 */
export function placePopover(
    anchor: Box,
    size: { width: number; height: number },
    view: { width: number; height: number },
    { align = 'start', gap = 4, margin = 8 }: { align?: 'start' | 'end'; gap?: number; margin?: number } = {},
): Placement {
    const room = view.width - 2 * margin;
    const width = Math.min(size.width, room);
    const fitsX = (l: number) => l >= margin && l + width <= view.width - margin;
    const start = anchor.left;
    const end = anchor.right - width;
    let left = align === 'start'
        ? (fitsX(start) ? start : fitsX(end) ? end : start)
        : (fitsX(end) ? end : fitsX(start) ? start : end);
    left = Math.max(margin, Math.min(left, view.width - margin - width));

    const below = anchor.bottom + gap;
    const above = anchor.top - gap - size.height;
    let side: Placement['side'] = 'below';
    let top = below;
    if (below + size.height > view.height - margin && above >= margin) {
        side = 'above';
        top = above;
    }
    top = Math.max(margin, Math.min(top, view.height - margin - size.height));

    return { left, top, side, ...(size.width > room ? { maxWidth: room } : {}) };
}

/** Focus the n-th item of a menu, wrapping at both ends. */
function focusItem(menu: HTMLElement | null, which: 'first' | 'last' | 'next' | 'prev') {
    if (!menu) return;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const i = which === 'first' ? 0
        : which === 'last' ? items.length - 1
            : which === 'next' ? (at + 1) % items.length
                : (at - 1 + items.length) % items.length;
    items[i].focus();
}

/** The keys that open a closed menu from its button (Enter/Space are the
 *  button's own click). Spread onto the trigger's `onKeyDown`. */
export function menuTriggerKeys(open: () => void) {
    return (e: ReactKeyboardEvent) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
    };
}

export function MenuPopover({ open, onClose, anchorRef, label, align = 'start', children }: {
    open: boolean;
    onClose: () => void;
    /** The button the menu belongs to: where it is placed, and where focus goes back. */
    anchorRef: RefObject<HTMLElement | null>;
    label: string;
    align?: 'start' | 'end';
    children: ReactNode;
}) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [place, setPlace] = useState<Placement | null>(null);
    const { anchor: accentAnchor, accent } = usePortalAccent(open);
    // Read through a ref: a caller's inline `() => setOpen(false)` is a new
    // function every render, and an effect keyed on it re-ran on each one —
    // pulling focus back to the first row under the reader's arrow keys.
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    const measure = useCallback(() => {
        const btn = anchorRef.current, menu = menuRef.current;
        if (!btn || !menu) return;
        const r = btn.getBoundingClientRect();
        // The button has left the screen (the feed scrolled it away): a menu
        // still floating there would belong to nothing on screen.
        if (r.bottom < 0 || r.top > window.innerHeight) { closeRef.current(); return; }
        setPlace(placePopover(r, { width: menu.offsetWidth, height: menu.offsetHeight },
            { width: window.innerWidth, height: window.innerHeight }, { align }));
    }, [anchorRef, align]);

    // Measured before paint, so the menu never flashes at 0,0; it is rendered
    // hidden until then.
    useLayoutEffect(() => {
        if (!open) { setPlace(null); return; }
        measure();
    }, [open, measure]);

    // The first row takes focus once the menu is PLACED, not when it mounts:
    // until then it is `visibility: hidden`, and a hidden element refuses focus
    // — measured in Edge, focus stayed on the button, so the arrows and Escape
    // (which listened on the menu) did nothing at all.
    const placed = place != null;
    useEffect(() => {
        if (open && placed) focusItem(menuRef.current, 'first');
    }, [open, placed]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            const t = e.target as Node;
            if (menuRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
            closeRef.current();
        };
        const onMove = () => measure();
        // On the DOCUMENT, in the capture phase, while the menu is open: the
        // keys belong to the menu wherever focus is — on a row, or still on the
        // button a mouse pressed — and claiming them first means nothing
        // listening on the window (a page's own Escape, the drawer's) also acts
        // on the press that only meant "close this menu".
        const onKey = (e: KeyboardEvent) => {
            const menu = menuRef.current;
            const inMenu = !!menu && menu.contains(document.activeElement);
            const onButton = document.activeElement === anchorRef.current;
            if (!inMenu && !onButton && e.key !== 'Escape') return;
            const acts: Record<string, () => void> = {
                ArrowDown: () => focusItem(menu, inMenu ? 'next' : 'first'),
                ArrowUp: () => focusItem(menu, inMenu ? 'prev' : 'last'),
                Home: () => focusItem(menu, 'first'),
                End: () => focusItem(menu, 'last'),
                Escape: () => { closeRef.current(); anchorRef.current?.focus(); },
                Tab: () => { closeRef.current(); anchorRef.current?.focus(); },
            };
            const act = acts[e.key];
            if (!act) return;
            // Tab from the button itself just closes and lets focus move on.
            if (e.key === 'Tab' && !inMenu) { closeRef.current(); return; }
            e.preventDefault();
            e.stopPropagation();
            act();
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onMove, true);
        window.addEventListener('resize', onMove);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('scroll', onMove, true);
            window.removeEventListener('resize', onMove);
        };
    }, [open, measure, anchorRef]);

    return (
        <>
            <span ref={accentAnchor} className="hidden" aria-hidden="true" />
            {open && createPortal(
                <div
                    ref={menuRef}
                    role="menu"
                    aria-label={label}
                    style={{
                        ...accent,
                        left: place?.left ?? 0,
                        top: place?.top ?? 0,
                        maxWidth: place?.maxWidth,
                        visibility: place ? 'visible' : 'hidden',
                    }}
                    // Up the surface ladder from the card it opens over, like
                    // every other floating panel here; `p-1` so a highlighted
                    // row is inset from the panel's rounded edge rather than
                    // flush against it.
                    className={cx('fixed z-50 min-w-[13rem] w-max', MENU_PANEL)}
                >
                    {children}
                </div>,
                document.body,
            )}
        </>
    );
}

/** One row of a menu: an icon and a label, padded, with the app's focus ring.
 *  A link when it has `href` (opens in a new tab), else a button.
 *
 *  Every menu in the app draws its rows with this — a `MenuPopover`'s, and the
 *  older hand-placed ones (the project card's, `DropdownMenu`'s), which once had
 *  rows of their own: flush to the panel's edge, 36px, a different hover. Those
 *  have no arrow keys, so `roving={false}` leaves their rows plain buttons with
 *  their own Tab stop and no menu role (a `menuitem` promises the arrow keys a
 *  `MenuPopover` provides and they do not). */
export function MenuItem({ icon, children, href, onSelect, tone = 'default', roving = true, current = false }: {
    icon?: ReactNode;
    children: ReactNode;
    href?: string;
    onSelect?: (e: ReactMouseEvent) => void;
    /** `danger` for a row that deletes: red, like the `danger` button. */
    tone?: 'default' | 'danger';
    roving?: boolean;
    /** The page you are on, in a menu of places: accent text and a tick at the end. */
    current?: boolean;
}) {
    const cls = cx(
        'flex w-full items-center gap-2.5 min-h-10 touch:min-h-11 px-3 py-2 rounded-lg text-left text-sm',
        tone === 'danger'
            ? 'text-red-700 dark:text-red-300 can-hover:hover:bg-red-50 dark:can-hover:hover:bg-red-950/40 focus-visible:bg-red-50 dark:focus-visible:bg-red-950/40'
            : cx(current ? 'text-accent-fg font-medium' : 'text-slate-700 dark:text-slate-100',
                'can-hover:hover:bg-slate-100 dark:can-hover:hover:bg-slate-600 focus-visible:bg-slate-100 dark:focus-visible:bg-slate-600'),
        'transition-colors',
        FOCUS_RING,
    );
    const body = (
        <>
            {icon && <span className={cx('shrink-0', tone === 'danger' ? '' : 'text-slate-500 dark:text-slate-300')} aria-hidden="true">{icon}</span>}
            <span className="min-w-0 truncate">{children}</span>
            {current && <Check className="w-4 h-4 shrink-0 ml-auto" aria-hidden="true" />}
        </>
    );
    const tabIndex = roving ? -1 : undefined;
    const role = roving ? 'menuitem' : undefined;
    const ariaCurrent = current ? 'page' as const : undefined;
    return href
        ? <a role={role} tabIndex={tabIndex} aria-current={ariaCurrent} href={href} target="_blank" rel="noopener noreferrer" onClick={onSelect} className={cls}>{body}</a>
        : <button role={role} tabIndex={tabIndex} aria-current={ariaCurrent} type="button" onClick={onSelect} className={cls}>{body}</button>;
}

/** The panel of a hand-placed menu (`DropdownMenu`, the project card's): the
 *  same material and inset as `MenuPopover`'s, so a menu is one shape wherever
 *  it opens. `MENU_SURFACE` is the material alone, for a panel that scrolls
 *  INSIDE its frame (`Select`'s list). */
export const MENU_SURFACE = 'rounded-xl border border-slate-300 dark:border-slate-500 bg-white dark:bg-slate-700 shadow-lg';
export const MENU_PANEL = `p-1 ${MENU_SURFACE}`;

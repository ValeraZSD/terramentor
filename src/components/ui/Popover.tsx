import { useCallback, useLayoutEffect, useRef, useState, useEffect } from 'react';
import type { ReactNode, RefObject, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { usePortalAccent } from '../../hooks/usePortalAccent';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { BottomSheet, useOpensAsSheet } from './Sheet';
import { FOCUS_RING, cx } from './vocabulary';

/**
 * What opens from a button: a MENU (`MenuPopover`) or a small PANEL of
 * controls (`PanelPopover`). With a hovering pointer it floats, portalled to
 * the body, anchored to the button's own edge and kept on the screen; under a
 * finger it is the bottom sheet (`ui/Sheet.tsx`), the same one `Select` opens.
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
    /** Set when the room is narrower than the menu: the width it must fit. */
    maxWidth?: number;
    /** Set when no room is as tall as the menu: the height it scrolls inside. */
    maxHeight?: number;
}

/** Below this much room on its roomier side, a menu would show two rows and a
 *  scroll bar beside its button: it is laid over the button instead. */
const MIN_SIDE_ROOM = 120;

/**
 * Where a menu of `size` goes against a button at `anchor`, inside `bounds`:
 * the part of the screen a menu may use (`popoverBounds()` in the app — the
 * visual viewport less the phone's covered edges). Pure, so the gate can run
 * the cases a browser would. The box it returns, at `maxWidth`/`maxHeight`
 * where those are set, lies `margin` inside `bounds`, whatever it is given.
 *
 *   - horizontally it lines up with the button's START edge (the reading
 *     direction's edge, where the eye already is); if that runs past the right
 *     edge it lines up with the button's END edge instead; and if neither fits
 *     it is clamped inside. Never off it.
 *   - vertically it opens BELOW the button, and above it only when below does
 *     not fit and above does. When neither holds it (a keyboard took half the
 *     screen), it takes the roomier side and scrolls inside it; when even that
 *     is a sliver, it is laid over the button in the whole of the room.
 */
export function placePopover(
    anchor: Box,
    size: { width: number; height: number },
    bounds: Box,
    { align = 'start', gap = 4, margin = 8 }: { align?: 'start' | 'end'; gap?: number; margin?: number } = {},
): Placement {
    const minX = bounds.left + margin, maxX = bounds.right - margin;
    const minY = bounds.top + margin, maxY = bounds.bottom - margin;
    const roomX = Math.max(0, maxX - minX);
    const roomY = Math.max(0, maxY - minY);

    const width = Math.min(size.width, roomX);
    const fitsX = (l: number) => l >= minX && l + width <= maxX;
    const start = anchor.left;
    const end = anchor.right - width;
    let left = align === 'start'
        ? (fitsX(start) ? start : fitsX(end) ? end : start)
        : (fitsX(end) ? end : fitsX(start) ? start : end);
    left = Math.max(minX, Math.min(left, maxX - width));

    // The room on each side, counted only inside the bounds: a button under
    // the status bar or the keyboard has none on that side.
    const below = anchor.bottom + gap;
    const roomBelow = Math.max(0, maxY - Math.max(below, minY));
    const roomAbove = Math.max(0, Math.min(anchor.top - gap, maxY) - minY);
    let side: Placement['side'] = 'below';
    let height = Math.min(size.height, roomY);
    let top: number;
    if (height <= roomBelow) {
        top = below;
    } else if (height <= roomAbove) {
        side = 'above';
        top = anchor.top - gap - height;
    } else {
        side = roomAbove > roomBelow ? 'above' : 'below';
        const room = Math.max(roomAbove, roomBelow);
        if (room >= MIN_SIDE_ROOM) height = room;
        top = side === 'below' ? below : anchor.top - gap - height;
    }
    top = Math.max(minY, Math.min(top, maxY - height));

    return {
        left, top, side,
        ...(size.width > roomX ? { maxWidth: roomX } : {}),
        ...(height < size.height ? { maxHeight: height } : {}),
    };
}

/**
 * The part of the screen a floating menu may use, in the coordinates of a
 * `position: fixed` box: the VISUAL viewport (what is on the glass after
 * pinch zoom, and above an on-screen keyboard, which shrinks it and leaves the
 * layout viewport alone), less the phone's covered edges — the status bar, the
 * home indicator, the corners held sideways. Those are `--safe-*` in
 * `index.css`, read here from computed style rather than `env()`, which script
 * cannot read; 0px on a screen without them.
 */
export function popoverBounds(): Box {
    const vv = window.visualViewport;
    const x = vv?.offsetLeft ?? 0, y = vv?.offsetTop ?? 0;
    const w = vv?.width ?? window.innerWidth, h = vv?.height ?? window.innerHeight;
    const css = getComputedStyle(document.documentElement);
    const inset = (side: string) => parseFloat(css.getPropertyValue(`--safe-${side}`)) || 0;
    return {
        left: x + inset('left'),
        top: y + inset('top'),
        right: x + w - inset('right'),
        bottom: y + h - inset('bottom'),
    };
}

/** Calls `fn` when the visual viewport moves or resizes (a keyboard opens, a
 *  pinch zooms); the window's own events miss both. Returns the unsubscribe. */
export function followVisualViewport(fn: () => void): () => void {
    const vv = window.visualViewport;
    if (!vv) return () => { };
    vv.addEventListener('resize', fn);
    vv.addEventListener('scroll', fn);
    return () => { vv.removeEventListener('resize', fn); vv.removeEventListener('scroll', fn); };
}

/**
 * A floating surface's place beside its button, kept up to date while `active`:
 * measured before paint, again as the page scrolls or the window or the visual
 * viewport changes, closed when the button leaves the screen or a press lands
 * outside both. The height is measured at its full content, not at the
 * `maxHeight` a cramped moment gave it, so it grows back when room returns.
 */
function useFloatingPlace({ active, anchorRef, surfaceRef, align, gap, onClose }: {
    active: boolean;
    anchorRef: RefObject<HTMLElement | null>;
    surfaceRef: RefObject<HTMLElement | null>;
    align: 'start' | 'end';
    gap?: number;
    onClose: () => void;
}): Placement | null {
    const [place, setPlace] = useState<Placement | null>(null);
    // Read through a ref: a caller's inline `() => setOpen(false)` is a new
    // function every render, and an effect keyed on it re-ran on each one —
    // pulling focus back to the first row under the reader's arrow keys.
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    const measure = useCallback(() => {
        const btn = anchorRef.current, el = surfaceRef.current;
        if (!btn || !el) return;
        const r = btn.getBoundingClientRect();
        // The button has left the screen (the feed scrolled it away): a menu
        // still floating there would belong to nothing on screen.
        if (r.bottom < 0 || r.top > window.innerHeight) { closeRef.current(); return; }
        const borders = el.offsetHeight - el.clientHeight;
        // The surface's own width, not the cap the last placement put on it: a
        // capped box measured as capped would lose its cap on the next scroll,
        // grow back past the edge and be capped again, on every scroll event.
        const { maxWidth, minWidth } = el.style;
        el.style.maxWidth = 'none';
        el.style.minWidth = '';
        const width = el.offsetWidth;
        el.style.maxWidth = maxWidth;
        el.style.minWidth = minWidth;
        setPlace(placePopover(r, { width, height: el.scrollHeight + borders },
            popoverBounds(), { align, gap }));
    }, [anchorRef, surfaceRef, align, gap]);

    // Measured before paint, so the surface never flashes at 0,0; it is
    // rendered hidden until then.
    useLayoutEffect(() => {
        if (!active) { setPlace(null); return; }
        measure();
    }, [active, measure]);

    useEffect(() => {
        if (!active) return;
        const onDown = (e: PointerEvent) => {
            const t = e.target as Node;
            if (surfaceRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
            closeRef.current();
        };
        document.addEventListener('pointerdown', onDown, true);
        window.addEventListener('scroll', measure, true);
        window.addEventListener('resize', measure);
        const unfollow = followVisualViewport(measure);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('scroll', measure, true);
            window.removeEventListener('resize', measure);
            unfollow();
        };
    }, [active, measure, anchorRef, surfaceRef]);

    return active ? place : null;
}

/** A portalled surface is not inside the component that rendered it on screen,
 *  but React still passes its events up to it: a press on a menu opened from a
 *  card would also be a press on the card. They stop at the surface. Keys do
 *  not: stopping one stops the real event before the document, where a
 *  dialog's `useDialogFocus` hears Escape and Tab. */
const stop = (e: SyntheticEvent) => e.stopPropagation();
const KEEP_EVENTS = { onClick: stop, onPointerDown: stop };

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
    /** The menu's name; on a phone, the sheet's title. */
    label: string;
    align?: 'start' | 'end';
    children: ReactNode;
}) {
    const menuRef = useRef<HTMLDivElement>(null);
    const sheet = useOpensAsSheet(open);
    const place = useFloatingPlace({ active: open && !sheet, anchorRef, surfaceRef: menuRef, align, onClose });
    const { anchor: accentAnchor, accent } = usePortalAccent(open && !sheet);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    // The first row takes focus once the menu is PLACED, not when it mounts:
    // until then it is `visibility: hidden`, and a hidden element refuses focus
    // — measured in Edge, focus stayed on the button, so the arrows and Escape
    // (which listened on the menu) did nothing at all. A sheet is placed by CSS.
    const placed = sheet || place != null;
    useEffect(() => {
        if (open && placed) focusItem(menuRef.current, 'first');
    }, [open, placed]);

    useEffect(() => {
        if (!open) return;
        // On the DOCUMENT, in the capture phase, while the menu is open: the
        // keys belong to the menu wherever focus is — on a row, or still on the
        // button a mouse pressed — and claiming them first means nothing
        // listening on the window (a page's own Escape, the drawer's, the
        // sheet's) also acts on the press that only meant "close this menu".
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
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [open, anchorRef]);

    if (open && sheet) {
        return (
            <BottomSheet title={label} onClose={onClose} returnFocus={anchorRef}>
                <div
                    ref={menuRef}
                    role="menu"
                    aria-label={label}
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3"
                >
                    {children}
                </div>
            </BottomSheet>
        );
    }

    return (
        <>
            <span ref={accentAnchor} className="hidden" aria-hidden="true" />
            {open && createPortal(
                <div
                    ref={menuRef}
                    role="menu"
                    aria-label={label}
                    {...KEEP_EVENTS}
                    style={{
                        ...accent,
                        left: place?.left ?? 0,
                        top: place?.top ?? 0,
                        maxWidth: place?.maxWidth,
                        // A capped menu drops its 13rem floor: in CSS a
                        // min-width beats a max-width, and the box would run
                        // past the edge it was placed against.
                        minWidth: place?.maxWidth != null ? 0 : undefined,
                        maxHeight: place?.maxHeight,
                        visibility: place ? 'visible' : 'hidden',
                    }}
                    // Up the surface ladder from the card it opens over, like
                    // every other floating panel here; `p-1` so a highlighted
                    // row is inset from the panel's rounded edge rather than
                    // flush against it.
                    className={cx('fixed z-50 min-w-[13rem] w-max overflow-y-auto overscroll-contain', MENU_PANEL)}
                >
                    {children}
                </div>,
                document.body,
            )}
        </>
    );
}

/**
 * A small panel of controls that opens from a button (the course's icon and
 * colour, the export options): a non-menu `MenuPopover`. A dialog for focus —
 * Tab stays inside, Escape closes, focus goes back to the button — floating
 * beside the button with a hovering pointer and the bottom sheet under a finger.
 */
export function PanelPopover({ open, onClose, anchorRef, label, align = 'start', width, className, initialFocus, children }: {
    open: boolean;
    onClose: () => void;
    anchorRef: RefObject<HTMLElement | null>;
    /** The panel's name; on a phone, the sheet's title. */
    label: string;
    align?: 'start' | 'end';
    /** The floating panel's width class (`w-72`); the sheet is the screen's. */
    width: string;
    /** The content's own layout, the same in both forms (`space-y-4`). */
    className?: string;
    /** A selector inside the panel for where focus starts (the chosen swatch). */
    initialFocus?: string;
    children: ReactNode;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    const startRef = useRef<HTMLElement | null>(null);
    const sheet = useOpensAsSheet(open);
    const place = useFloatingPlace({ active: open && !sheet, anchorRef, surfaceRef: panelRef, align, gap: 4, onClose });
    const { anchor: accentAnchor, accent } = usePortalAccent(open && !sheet);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    // Layout effects run before any passive one, so this is set before either
    // form's `useDialogFocus` reads it.
    useLayoutEffect(() => {
        startRef.current = open && initialFocus ? panelRef.current?.querySelector<HTMLElement>(initialFocus) ?? null : null;
    }, [open, sheet, initialFocus]);
    useDialogFocus(open && !sheet, panelRef, {
        onEscape: e => { e.preventDefault(); closeRef.current(); },
        initialFocus: startRef,
    });
    // As the sheet does: Safari does not focus a clicked button, so
    // `useDialogFocus` may have had no opener to hand focus back to. Declared
    // after it, so this cleanup runs after its own and only fills that gap.
    useEffect(() => {
        if (!open || sheet) return;
        return () => {
            const active = document.activeElement;
            if ((!active || active === document.body) && anchorRef.current?.isConnected) {
                anchorRef.current.focus({ preventScroll: true });
            }
        };
    }, [open, sheet, anchorRef]);

    if (open && sheet) {
        return (
            <BottomSheet title={label} onClose={onClose} initialFocus={startRef} returnFocus={anchorRef}>
                <div ref={panelRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-1 pb-5">
                    <div className={className}>{children}</div>
                </div>
            </BottomSheet>
        );
    }

    return (
        <>
            <span ref={accentAnchor} className="hidden" aria-hidden="true" />
            {open && createPortal(
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-label={label}
                    {...KEEP_EVENTS}
                    style={{
                        ...accent,
                        left: place?.left ?? 0,
                        top: place?.top ?? 0,
                        maxWidth: place?.maxWidth,
                        maxHeight: place?.maxHeight,
                        // Not `visibility`: hidden refuses focus, and the
                        // dialog takes it as it mounts, before it is placed.
                        opacity: place ? 1 : 0,
                    }}
                    className={cx('fixed z-50 overflow-y-auto overscroll-contain p-3', width, MENU_SURFACE)}
                >
                    <div className={className}>{children}</div>
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

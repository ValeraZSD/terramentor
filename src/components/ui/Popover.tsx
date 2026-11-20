import { useCallback, useLayoutEffect, useRef, useState, useEffect } from 'react';
import type { ReactNode, RefObject, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { usePortalAccent } from '../../hooks/usePortalAccent';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { FOCUS_RING, cx } from './vocabulary';

/**
 * What opens from a button: a MENU (`MenuPopover`) or a small PANEL of
 * controls (`PanelPopover`). It floats, portalled to the body, anchored to the
 * button's own edge and kept on the screen, under a finger as with a mouse.
 *
 * On a phone it was a sheet from the bottom of the screen for a while: a menu
 * tapped open from the top bar then appeared at the far end of the screen from
 * the finger that opened it, and read as something else opening. A phone's own
 * menus (Android's, iOS's pull-down menus) open at their button; so do these,
 * with rows a finger can hit (`MenuItem`'s `touch:min-h-11`).
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
/** How far inside its bounds a floating menu keeps, by default. */
const MARGIN = 8;

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
    { align = 'start', gap = 4, margin = MARGIN }: { align?: 'start' | 'end'; gap?: number; margin?: number } = {},
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

/** Is the box (at `r`) wholly out of sight: off the screen, or past the edge
 *  of an element that scrolls or clips it (a dialog's body, a category's list
 *  of rows)? A menu still floating from it would act on something not shown. */
export function scrolledAway(box: HTMLElement, r: DOMRect): boolean {
    if (r.bottom < 0 || r.top > window.innerHeight) return true;
    for (let p = box.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (!/auto|scroll|hidden|clip/.test(`${s.overflowX} ${s.overflowY}`)) continue;
        const b = p.getBoundingClientRect();
        if (r.bottom <= b.top || r.top >= b.bottom) return true;
    }
    return false;
}

/** How long a finger's dismissing tap may take to arrive as a click. */
const TAP_CLICK_MS = 700;

/**
 * The rest of a press that closed a floating surface from outside it.
 *
 * Under a finger the tap is spent on closing, as a native picker spends it:
 * the click it would become is eaten, so a tap beside an open menu does not
 * also press the button it landed on. A mouse press goes on to its target, as
 * it does beside a desktop menu. Only `touch` and `pen` count as a finger.
 *
 * `back` is the button the surface opened from. When focus was inside the
 * surface, it goes back there once the press is over, unless the press put it
 * somewhere itself (a field it landed on): the surface left the page with
 * focus in it, which drops focus to the page's start.
 */
export function endOutsidePress(e: PointerEvent, back?: HTMLElement | null) {
    const restore = back
        ? () => {
            const at = document.activeElement;
            if ((!at || at === document.body) && back.isConnected) back.focus({ preventScroll: true });
        }
        : () => { };
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') {
        // pointerdown and its mousedown come from one input event: by the next
        // task the mousedown has moved focus wherever it was going.
        setTimeout(restore, 0);
        return;
    }
    let timer = 0;
    const done = () => {
        window.clearTimeout(timer);
        document.removeEventListener('click', eat, true);
        document.removeEventListener('pointercancel', done, true);
        restore();
    };
    const eat = (c: MouseEvent) => { c.preventDefault(); c.stopPropagation(); done(); };
    document.addEventListener('click', eat, true);
    // A tap that turned into a scroll sends no click.
    document.addEventListener('pointercancel', done, true);
    timer = window.setTimeout(done, TAP_CLICK_MS);
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
        // The button has left the screen, or the list that scrolls it (the feed
        // scrolled it away): a menu still floating there would belong to
        // nothing on screen.
        if (scrolledAway(btn, r)) { closeRef.current(); return; }
        const bounds = popoverBounds();
        const borders = el.offsetHeight - el.clientHeight;
        // The surface's own width, not the cap the last placement put on it: a
        // capped box measured as capped would lose its cap on the next scroll,
        // grow back past the edge and be capped again, on every scroll event.
        const { maxWidth, minWidth } = el.style;
        el.style.maxWidth = 'none';
        el.style.minWidth = '';
        const width = el.offsetWidth;
        // Its height at the width it will HAVE: capped, its text wraps and it
        // grows taller than it measured uncapped.
        const roomX = Math.max(0, bounds.right - bounds.left - 2 * MARGIN);
        if (width > roomX) { el.style.maxWidth = `${roomX}px`; el.style.minWidth = '0'; }
        const height = el.scrollHeight + borders;
        el.style.maxWidth = maxWidth;
        el.style.minWidth = minWidth;
        setPlace(placePopover(r, { width, height }, bounds, { align, gap }));
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
            const held = !!surfaceRef.current?.contains(document.activeElement);
            closeRef.current();
            endOutsidePress(e, held ? anchorRef.current : null);
        };
        // Scrolling the surface's own rows moves nothing it is placed by.
        const onScroll = (e: Event) => {
            if (surfaceRef.current?.contains(e.target as Node)) return;
            measure();
        };
        document.addEventListener('pointerdown', onDown, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', measure);
        const unfollow = followVisualViewport(measure);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('scroll', onScroll, true);
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

/** When a floating surface closes and focus fell to nothing (the chosen row
 *  unmounted with it; Safari never focused the clicked button), the button it
 *  opened from gets focus back. A surface that moved focus on (a dialog a row
 *  opened) keeps it. */
function useFocusBackOnClose(active: boolean, anchorRef: RefObject<HTMLElement | null>) {
    useEffect(() => {
        if (!active) return;
        return () => {
            const now = document.activeElement;
            if ((!now || now === document.body) && anchorRef.current?.isConnected) {
                anchorRef.current.focus({ preventScroll: true });
            }
        };
    }, [active, anchorRef]);
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
    /** The menu's name, for a screen reader. */
    label: string;
    align?: 'start' | 'end';
    children: ReactNode;
}) {
    const menuRef = useRef<HTMLDivElement>(null);
    const place = useFloatingPlace({ active: open, anchorRef, surfaceRef: menuRef, align, onClose });
    const { anchor: accentAnchor, accent } = usePortalAccent(open);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    // The first row takes focus once the menu is PLACED, not when it mounts:
    // until then it is `visibility: hidden`, and a hidden element refuses focus
    // — measured in Edge, focus stayed on the button, so the arrows and Escape
    // (which listened on the menu) did nothing at all.
    const placed = place != null;
    useEffect(() => {
        if (open && placed) focusItem(menuRef.current, 'first');
    }, [open, placed]);
    useFocusBackOnClose(open, anchorRef);

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
                    className={cx('fixed min-w-[13rem] w-max overflow-y-auto overscroll-contain', FLOAT_LAYER, MENU_PANEL)}
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
 * beside the button, under a finger as with a mouse.
 */
export function PanelPopover({ open, onClose, anchorRef, label, align = 'start', width, className, initialFocus, children }: {
    open: boolean;
    onClose: () => void;
    anchorRef: RefObject<HTMLElement | null>;
    /** The panel's name, for a screen reader. */
    label: string;
    align?: 'start' | 'end';
    /** The panel's width class (`w-72`); capped to the screen when narrower. */
    width: string;
    /** The content's own layout (`space-y-4`). */
    className?: string;
    /** A selector inside the panel for where focus starts (the chosen swatch). */
    initialFocus?: string;
    children: ReactNode;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    const startRef = useRef<HTMLElement | null>(null);
    const place = useFloatingPlace({ active: open, anchorRef, surfaceRef: panelRef, align, gap: 4, onClose });
    const { anchor: accentAnchor, accent } = usePortalAccent(open);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    // Layout effects run before any passive one, so this is set before
    // `useDialogFocus` reads it.
    useLayoutEffect(() => {
        startRef.current = open && initialFocus ? panelRef.current?.querySelector<HTMLElement>(initialFocus) ?? null : null;
    }, [open, initialFocus]);
    useDialogFocus(open, panelRef, {
        onEscape: e => { e.preventDefault(); closeRef.current(); },
        initialFocus: startRef,
    });
    // Declared after `useDialogFocus`, so its own hand-back runs first.
    useFocusBackOnClose(open, anchorRef);

    return (
        <>
            <span ref={accentAnchor} className="hidden" aria-hidden="true" />
            {open && createPortal(
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-label={label}
                    // Where focus lands when nothing inside asks for it.
                    tabIndex={-1}
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
                    className={cx('fixed overflow-y-auto overscroll-contain p-3 outline-none', FLOAT_LAYER, width, MENU_SURFACE)}
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
 *  Every menu in the app draws its rows with this, inside a `MenuPopover` (the
 *  project card's and `DropdownMenu`'s included), whose arrow keys, Home/End and
 *  first-row focus find a row by its `menuitem` role. Leave `roving` on there:
 *  `roving={false}` is only for a row outside a `MenuPopover`, where it stays a
 *  plain button with its own Tab stop and no menu role (a `menuitem` promises
 *  the arrow keys that only a `MenuPopover` provides). */
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

/** The panel of a menu: `MenuPopover` draws it, and anything hand-placed that
 *  must look like one takes the same material and inset, so a menu is one shape
 *  wherever it opens. `MENU_SURFACE` is the material alone, for a panel that scrolls
 *  INSIDE its frame (`Select`'s list). */
export const MENU_SURFACE = 'rounded-xl border border-slate-300 dark:border-slate-500 bg-white dark:bg-slate-700 shadow-lg';
export const MENU_PANEL = `p-1 ${MENU_SURFACE}`;

/** The stacking layer of everything that floats from a button: `MenuPopover`,
 *  `PanelPopover`, `Select`'s list, the model picker. Above every dialog and
 *  sheet that can hold one of them (the mastery check `z-[55]`, the `z-[60]`
 *  dialogs, `ConfirmDialog` `z-[100]`): one opened inside them would otherwise
 *  open underneath, out of reach. Only the desktop quit screen sits higher,
 *  as the last thing the page shows. */
export const FLOAT_LAYER = 'z-[110]';

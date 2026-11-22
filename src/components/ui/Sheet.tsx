import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { usePortalAccent } from '../../hooks/usePortalAccent';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { IconButton } from './Button';
import { cx } from './vocabulary';

/**
 * A SHEET from the bottom of the screen, for a panel that belongs to the
 * bottom of the screen: the mock exam's list of all questions, opened from the
 * number row along the bottom edge.
 *
 * Not for what opens from a button elsewhere: menus, panels and `Select`'s list
 * open at their button on every device (`ui/Popover.tsx`). A menu tapped open
 * from the top bar that slid up from the bottom read as something else opening.
 *
 * It slides up, is titled, has a close button and a handle to pull it down by,
 * dims and closes on a tap outside, owns Escape and Tab while open
 * (`useDialogFocus`), clears the status bar and the screen's sides, and pads
 * the home indicator below its last row.
 */

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function BottomSheet({ title, onClose, onEscape, initialFocus, returnFocus, children }: {
    /** Shown at the top and the dialog's name. Empty: "Choose one". */
    title: string;
    onClose: () => void;
    /** Escape, when it is not simply `onClose` (default). */
    onEscape?: (e: KeyboardEvent) => void;
    /** Where focus starts; absent, the sheet itself. */
    initialFocus?: RefObject<HTMLElement | null>;
    /** The button it opened from. A tapped button is not focused on iOS, so
     *  `useDialogFocus` may have no opener to hand focus back to: this is. */
    returnFocus?: RefObject<HTMLElement | null>;
    /** The body. It scrolls itself (`min-h-0 flex-1 overflow-y-auto`). */
    children: ReactNode;
}) {
    const { t } = useTranslation();
    const dialogRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    const [shown, setShown] = useState(false);
    const { anchor: accentAnchor, accent } = usePortalAccent(true);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    useDialogFocus(true, dialogRef, {
        onEscape: e => { if (onEscape) onEscape(e); else { e.preventDefault(); closeRef.current(); } },
        initialFocus,
    });

    // Declared after `useDialogFocus`, so this cleanup runs after its own:
    // only when it found nothing to give focus back to does the button get it.
    useEffect(() => () => {
        const active = document.activeElement;
        if ((!active || active === document.body) && returnFocus?.current?.isConnected) {
            returnFocus.current.focus({ preventScroll: true });
        }
    }, [returnFocus]);

    // Slide up once mounted (a frame later, so the start position is painted).
    useEffect(() => {
        const f = requestAnimationFrame(() => setShown(true));
        return () => cancelAnimationFrame(f);
    }, []);

    // Pulled down by its header, as a phone's own sheets are: it follows the
    // finger, and let go past a fifth of its height (or 6rem) it closes.
    const drag = useRef<{ id: number; y: number } | null>(null);
    const [pulled, setPulled] = useState(0);
    const onPullStart = (e: ReactPointerEvent<HTMLDivElement>) => {
        // The close button keeps its own tap (a capture would retarget it).
        if (e.pointerType === 'mouse' || (e.target as Element).closest('button')) return;
        drag.current = { id: e.pointerId, y: e.clientY };
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const onPullMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (drag.current?.id === e.pointerId) setPulled(Math.max(0, e.clientY - drag.current.y));
    };
    const onPullEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (drag.current?.id !== e.pointerId) return;
        const d = e.type === 'pointercancel' ? 0 : e.clientY - drag.current.y;
        drag.current = null;
        const h = dialogRef.current?.offsetHeight ?? 0;
        if (d > Math.min(96, h / 5 || 96)) closeRef.current(); else setPulled(0);
    };

    return (
        <>
            <span ref={accentAnchor} className="hidden" aria-hidden="true" />
            {createPortal(
                // React passes events up through a portal to the component that
                // rendered it: a tap on a sheet opened from a card would also
                // be a tap on the card (and open the project). The sheet is not
                // inside the card on screen, so its presses stop here. Keys do
                // not: stopping one stops the real event too, before the
                // document, where `useDialogFocus` hears Escape and Tab.
                <div
                    className="fixed inset-0 z-[110] flex items-end justify-center safe-pt-0 safe-px-0"
                    style={accent}
                    data-bottom-sheet=""
                    onClick={stop}
                    onPointerDown={stop}
                >
                    <div
                        className={cx('absolute inset-0 bg-black/50 transition-opacity duration-200 motion-off:transition-none', shown ? 'opacity-100' : 'opacity-0')}
                        onClick={() => closeRef.current()}
                        aria-hidden="true"
                    />
                    <div
                        ref={dialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={titleId}
                        tabIndex={-1}
                        className={cx(
                            // The home-indicator inset is the sheet's, outside the
                            // body, so a "more below" cue never sits in it.
                            'sheet-shell relative flex w-full max-w-lg flex-col safe-pb-0 outline-none',
                            'rounded-t-2xl border border-b-0 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 shadow-xl',
                            'transition-transform duration-200 ease-out motion-off:transition-none',
                            shown ? 'translate-y-0' : 'translate-y-full',
                        )}
                        style={pulled ? { transform: `translateY(${pulled}px)`, transition: 'none' } : undefined}
                    >
                        <div
                            data-sheet-handle=""
                            className="shrink-0 touch-none select-none"
                            onPointerDown={onPullStart}
                            onPointerMove={onPullMove}
                            onPointerUp={onPullEnd}
                            onPointerCancel={onPullEnd}
                        >
                            <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-600" />
                            <div className="flex items-center justify-between gap-3 ps-5 pe-3 pt-1 pb-2">
                                {/* Two lines at most: a long topic title would otherwise
                                    fill a sheet on a phone held sideways. Its name stays whole. */}
                                <h2 id={titleId} className="min-w-0 line-clamp-2 break-words text-base font-semibold text-slate-900 dark:text-white">
                                    {title || t("Choose one")}
                                </h2>
                                <IconButton
                                    size="md"
                                    onClick={() => closeRef.current()}
                                    label={t("Close dialog")}
                                    tooltip={false}
                                    icon={<X className="w-5 h-5" />}
                                />
                            </div>
                        </div>
                        {children}
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
}

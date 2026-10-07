// src/components/creation/AppearancePicker.tsx — a new course's icon and
// colour, chosen from a tile INSIDE the Name field.
//
// The two choices once filled half the New course dialog (seventy controls
// beside the form) and were cut on outside readers' word; the course then took
// a colour nobody saw until the card appeared (`freeColour`). A tile at the
// start of the Name field costs no row: it SHOWS what the course will wear, and
// pressing it opens the two pickers in a panel over the dialog (2026-10-06,
// the shape Claude Code's own New project dialog uses).
//
// The panel is a small dialog, not a menu: two grids and a value field are
// not a list of commands. `useDialogFocus` makes it the topmost dialog while it
// is open, so Escape and Tab are its own and the course dialog under it keeps
// still; focus goes back to the tile when it closes.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import IconPicker from '../IconPicker';
import { ProjectIcon } from '../ProjectIcon';
import ColorField, { PROJECT_COLORS } from '../ui/ColorField';
import { IconButton } from '../ui/Button';
import { placePopover, type Placement } from '../ui/Popover';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { usePortalAccent } from '../../hooks/usePortalAccent';
import { accentSolidTriplet } from '../../utils/color';

export default function AppearancePicker({ icon, color, onIcon, onColor }: {
    icon: string;
    color: string;
    onIcon: (icon: string) => void;
    onColor: (color: string) => void;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [place, setPlace] = useState<Placement | null>(null);
    const { anchor: accentAnchor, accent } = usePortalAccent(open);
    const close = useCallback(() => setOpen(false), []);

    // The tile shows the colour the card and the course's buttons will wear:
    // the chosen one made safe for a white label (accentSolidTriplet).
    const tile = { backgroundColor: `rgb(${accentSolidTriplet(color)})` };

    const measure = useCallback(() => {
        const btn = buttonRef.current, panel = panelRef.current;
        if (!btn || !panel) return;
        setPlace(placePopover(btn.getBoundingClientRect(), { width: panel.offsetWidth, height: panel.offsetHeight },
            { width: window.innerWidth, height: window.innerHeight }));
    }, []);
    useLayoutEffect(() => {
        if (!open) { setPlace(null); return; }
        measure();
    }, [open, measure]);

    // Focus starts on the icon that is chosen: the roving grid's one tab stop.
    const selectedRef = useRef<HTMLElement | null>(null);
    useLayoutEffect(() => {
        selectedRef.current = open ? panelRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? null : null;
    }, [open]);
    useDialogFocus(open, panelRef, { onEscape: close, initialFocus: selectedRef });

    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            const target = e.target as Node;
            if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
            close();
        };
        document.addEventListener('pointerdown', onDown, true);
        window.addEventListener('scroll', measure, true);
        window.addEventListener('resize', measure);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('scroll', measure, true);
            window.removeEventListener('resize', measure);
        };
    }, [open, close, measure]);

    return (
        <>
            <span ref={accentAnchor} className="hidden" aria-hidden="true" />
            <IconButton
                ref={buttonRef}
                size="sm"
                label={t("Icon and colour")}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen(o => !o)}
                icon={(
                    <span className="flex h-7 w-7 items-center justify-center rounded-md text-white" style={tile}>
                        <ProjectIcon icon={icon} className="h-4 w-4" />
                    </span>
                )}
            />
            {open && createPortal(
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-label={t("Icon and colour")}
                    style={{
                        ...accent,
                        left: place?.left ?? 0,
                        top: place?.top ?? 0,
                        maxWidth: place?.maxWidth,
                        // Not `visibility: hidden` before it is placed: a hidden
                        // element refuses focus, and focus goes in on open.
                        opacity: place ? 1 : 0,
                    }}
                    className="fixed z-50 w-[19rem] max-h-[calc(100dvh-1rem)] overflow-y-auto space-y-4 p-3 rounded-xl border border-slate-300 dark:border-slate-500 bg-white dark:bg-slate-700 shadow-lg"
                >
                    {/* ALL sixty-four icons, no scrolling: at 19rem the eight
                        columns are small enough that eight rows and the
                        palette fit under the tile on a laptop and a phone.
                        A grid cut after five rows read as a rendering bug,
                        and with a fade over the cut it still did, to outside
                        readers two rounds running (2026-10-06); at 22rem the
                        whole set made a panel taller than a laptop screen
                        that covered the tile it was opened from. */}
                    <IconPicker label={t("Icon")} value={icon} onChange={onIcon} color={color} />
                    {/* The palette alone: no "In your library" row (twelve more
                        swatches is a second panel's worth, and matching another
                        course is Edit project's question) and no eyedropper or
                        value field (read as jargon by every outside reviewer;
                        any colour at all is Edit project's too). */}
                    <ColorField label={t("Colour")} value={color} onChange={onColor} colors={PROJECT_COLORS} anyColour={false} />
                </div>,
                document.body,
            )}
        </>
    );
}

// src/components/creation/AppearancePicker.tsx — a new course's icon and
// colour, chosen from a tile INSIDE the Name field.
//
// Showing both choices inline would fill half the New course dialog (seventy
// controls beside the form), and a course that silently took a colour
// (`freeColour`) would show it only once the card appeared. A tile at the
// start of the Name field costs no row: it SHOWS what the course will wear, and
// pressing it opens the two pickers in a panel over the dialog.
//
// The panel is a small dialog, not a menu: two grids and a value field are
// not a list of commands. It is a `PanelPopover`, which makes it the topmost
// dialog while it is open, so Escape and Tab are its own and the course dialog
// under it keeps still; focus goes back to the tile when it closes. On a phone
// it is the bottom sheet.
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import IconPicker from '../IconPicker';
import { ProjectIcon } from '../ProjectIcon';
import ColorField, { PROJECT_COLORS } from '../ui/ColorField';
import { IconButton } from '../ui/Button';
import { PanelPopover } from '../ui/Popover';
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

    // The tile shows the colour the card and the course's buttons will wear:
    // the chosen one made safe for a white label (accentSolidTriplet).
    const tile = { backgroundColor: `rgb(${accentSolidTriplet(color)})` };

    return (
        <>
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
            <PanelPopover
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={buttonRef}
                label={t("Icon and colour")}
                width="w-[19rem]"
                className="space-y-4"
                // Focus starts on the icon that is chosen: the roving grid's one tab stop.
                initialFocus={'[role="radio"][aria-checked="true"]'}
            >
                {/* ALL sixty-four icons, no scrolling: at 19rem the eight
                    columns are small enough that eight rows and the
                    palette fit under the tile on a laptop and a phone.
                    A grid cut after five rows reads as a rendering bug,
                    even with a fade over the cut; at 22rem the whole
                    set makes a panel taller than a laptop screen that
                    covers the tile it was opened from. */}
                <IconPicker label={t("Icon")} value={icon} onChange={onIcon} color={color} />
                {/* The palette alone: no "In your library" row (twelve more
                    swatches is a second panel's worth, and matching another
                    course is Edit project's question) and no eyedropper or
                    value field (it reads as jargon here; any colour at
                    all is Edit project's too). */}
                <ColorField label={t("Colour")} value={color} onChange={onColor} colors={PROJECT_COLORS} anyColour={false} />
            </PanelPopover>
        </>
    );
}

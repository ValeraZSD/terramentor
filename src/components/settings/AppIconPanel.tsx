import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { useStore } from '../../store';
import { k } from '../../i18n';
import ColorField from '../ui/ColorField';
import Slider from '../ui/Slider';
import Stepper from '../ui/Stepper';
import { IconButton } from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import { ExpandableSection } from '../ui/Disclosure';
import {
    AppIcon, DEFAULT_APP_ICON, IconStyle, IconVariant, MAX_RADIUS, MIN_RADIUS,
    iconLegibility, iconSvg, svgDataUrl,
} from '../../utils/appIcon';

/**
 * Settings → General → Appearance → "App icon".
 *
 * Three choices over one picture: which cut of the mark, what colour its tile
 * is, and how round that tile is. There is no fourth control for the INK — the
 * mark's colour is derived from the tile so that it stays legible on it, the
 * same bargain the accent makes (`adjustForContrast`), and the only two
 * sensible answers are the two `inkFor` picks between.
 *
 * ONE preview, beside the heading, and it is the real icon: the same function
 * the tab and the manifest draw from, at the colour and corner currently
 * chosen. It was briefly a card per style — a third of the panel spent drawing
 * the same mark twice, which is what a preview of a preview looks like.
 *
 * What a change reaches, and where it stops, is one sentence under the controls
 * rather than an implied "everywhere". It reaches further than it used to: a
 * packaged Windows install rewrites `Terramentor.ico`, which is what the Start
 * Menu, desktop and Startup shortcuts and the tray icon all draw
 * (`server/desktopIcon.js`). It stops at the icon compiled INTO the executable —
 * a resource inside a running image — and at an installed web app, which keeps
 * its tile until the platform refreshes it. The reasoning is in
 * `src/utils/appIcon.ts` and `server/desktopIcon.js`.
 */

/**
 * Tile colours.
 *
 * Sixteen, because the grid is eight or sixteen across and both divide it flush
 * — an orphan on a second row is the shape that rule exists to avoid. Deep by
 * design: these are read
 * as a 16px square among other apps' icons, and the ink has to clear the tile —
 * every one of them is above 7:1 against the ink it gets (`icon-gates.mjs`
 * asserts it, and the one light option is there to prove the ink flips).
 *
 * The NAMES and their ORDER are `ACCENT_COLORS`', slot for slot, so the three
 * colour rows on the Appearance card are one family read at three rungs
 * (`palette-order-gates.mjs`). Here the achromatic pair can be what it says —
 * a tile has no label text to carry, so Ink is true black and Paper is true
 * white. The shipped default tile (`#0b1220`) is a shade off the black swatch
 * on purpose and is reached by the restore button beside the corner slider,
 * not by a seventeenth chip.
 */
const ICON_BACKGROUNDS = [
    '#0c4a6e', // Sky
    '#1e3a8a', // Blue
    '#312e81', // Indigo
    '#4c1d95', // Violet
    '#581c87', // Purple
    '#701a75', // Fuchsia
    '#831843', // Pink
    '#881337', // Rose
    '#7f1d1d', // Red
    '#7c2d12', // Orange
    '#713f12', // Amber
    '#14532d', // Green
    '#064e3b', // Emerald
    '#134e4a', // Teal
    '#000000', // Ink — a tile with no colour in it at all
    '#ffffff', // Paper — a light tile, where the mark is drawn in dark ink
];

/** Below this the mark stops reading as a drawing on the tile. AA for text is
 *  4.5; a logo is not text, but a 16px one is not far off. */
const FAINT_BELOW = 4.5;

/** `k()` marks these for extraction; they are drawn through `tr()` below. */
const STYLE_LABELS: Record<IconStyle, string> = {
    full: k("Detailed"),
    simple: k("Simple"),
};

/**
 * The icon drawn at a real pixel size — never a `rem`, because a preview whose
 * size follows the interface scale is not a preview of anything.
 *
 * The VARIANT is the caller's, not a function of the size: the tab's cut drops
 * the grid whatever style is chosen, so a preview drawn in it shows "Detailed"
 * and "Simple" as the same picture. This one is the `tile` cut, which is what
 * the choice is actually about.
 */
function IconPreview({ icon, size, variant, title }: {
    icon: AppIcon; size: number; variant: IconVariant; title?: string;
}) {
    return (
        <img
            src={svgDataUrl(iconSvg(icon, variant, 64))}
            width={size}
            height={size}
            style={{ width: size, height: size }}
            alt=""
            title={title}
            className="shrink-0"
        />
    );
}

export default function AppIconPanel() {
    const { t: tr } = useTranslation();
    const icon = useStore(s => s.appIcon);
    const setAppIcon = useStore(s => s.setAppIcon);

    const legibility = iconLegibility(icon.background);
    const isDefault = icon.style === DEFAULT_APP_ICON.style
        && icon.background === DEFAULT_APP_ICON.background
        && icon.radius === DEFAULT_APP_ICON.radius;

    return (
        // A DISCLOSURE, not an open panel. Three controls and a caveat is a
        // screenful, and the icon is the one appearance choice most readers
        // never touch — so the closed row is the whole setting for them: the
        // live mark, its name, and where it shows up. The preview is the real
        // icon at the colour and corner currently chosen, so the row answers
        // "what is it now?" without being opened. A <summary> is not a button,
        // which is why it sits outside the control vocabulary's scope like
        // every other disclosure on this page.
        <ExpandableSection
            variant="row"
            lead={<IconPreview icon={icon} size={40} variant="tile" />}
            title={tr("App icon")}
            desc={tr("The mark on the browser tab, and the one an installed app gets.")}
            flushBody
        >
            <div className="px-4 pb-4 pt-3">
                {/* Both cuts are one picture at tab size (the grid is sub-pixel
                    at 16px), so the choice is only about the big tile — which is
                    exactly the size the preview in the summary is drawn at. */}
                <SegmentedControl
                    label={tr("App icon")}
                    value={icon.style}
                    onChange={style => void setAppIcon({ style })}
                    options={(Object.keys(STYLE_LABELS) as IconStyle[]).map(style => ({
                        value: style,
                        label: tr(STYLE_LABELS[style]),
                    }))}
                />

                <div className="mt-4">
                    <ColorField
                        value={icon.background}
                        onChange={background => void setAppIcon({ background })}
                        colors={ICON_BACKGROUNDS}
                        label={tr("Background")}
                        hint={legibility < FAINT_BELOW
                            ? tr("The mark is faint on this colour ({{ratio}}:1).", { ratio: legibility.toFixed(1) })
                            : undefined}
                    />
                </div>

                {/* ROUNDNESS — the same three-controls-over-one-number row as the
                    interface size below: drag it, nudge it, or put it back. */}
                <div className="mt-4">
                    <p className="text-sm font-medium text-slate-900 dark:text-white mb-2">{tr("Corners")}</p>
                    <div className="flex flex-wrap items-center gap-3">
                    <Slider
                        min={MIN_RADIUS}
                        max={MAX_RADIUS}
                        step={1}
                        value={icon.radius}
                        onChange={radius => void setAppIcon({ radius })}
                        label={tr("Corners")}
                        valueText={`${icon.radius}%`}
                        className="flex-1 min-w-[8rem]"
                    />
                    <Stepper
                        value={icon.radius}
                        min={MIN_RADIUS}
                        max={MAX_RADIUS}
                        step={1}
                        onChange={radius => void setAppIcon({ radius })}
                        label={tr("Corners")}
                        suffix="%"
                    />
                        <IconButton
                            variant="neutral"
                            onClick={() => void setAppIcon(DEFAULT_APP_ICON)}
                            disabled={isDefault}
                            label={tr("Restore the default icon")}
                            icon={<RotateCcw className="w-4 h-4" aria-hidden="true" />}
                        />
                    </div>
                </div>

                <p className="text-sm text-slate-500 dark:text-slate-400 mt-3">
                    {tr("The tab changes now, and on a desktop install so do the Start Menu, desktop and Startup shortcuts — the tray icon follows the next time the app starts. The program file's own icon is built in and keeps what it was packaged with, as does an already-installed web app until the system refreshes it.")}
                </p>
            </div>
        </ExpandableSection>
    );
}

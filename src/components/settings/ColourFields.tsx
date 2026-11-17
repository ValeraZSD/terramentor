import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import ColorField, { ACCENT_COLORS, THEME_TINTS } from '../ui/ColorField';
import SegmentedControl from '../ui/SegmentedControl';
import { tintSwatch } from '../../utils/themeRamp';
import { AppIconColour, AppIconShape, IconPreview } from './AppIconPanel';

type Target = 'page' | 'accent' | 'icon';

/** A colour's chip inside a segment: the same inset edge as a palette chip, so
 *  white on a white track and black on a black one still have an outline. A
 *  SQUARE, like the chips below it: a round white one beside a word read as an
 *  unticked radio button. 16px, the size the icon's own preview is drawn at. */
function Dot({ hex }: { hex: string }) {
    return (
        <span
            aria-hidden="true"
            className="w-4 h-4 rounded shrink-0 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.18)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.25)]"
            style={{ background: hex }}
        />
    );
}

/**
 * Settings → General → Appearance → Colours: the page, the accent and the app
 * icon's tile, chosen in ONE palette.
 *
 * They were three palettes, two open and one inside a disclosure, which spent
 * about 330px of the card on 48 chips and still hid the third. The three are
 * already one family — the same sixteen names in the same slots, each at its
 * own rung (`palette-order-gates.mjs`) — so one palette with a switch above it
 * offers exactly what the three did. The switch carries each target's current
 * colour, so all three values stay visible while only one is being changed.
 *
 * The switch starts on the page every time the screen opens; which target was
 * last edited is not worth a stored setting.
 */
export function ColourChooser() {
    const { t: tr } = useTranslation();
    const [target, setTarget] = useState<Target>('page');
    const theme = useStore(s => s.theme);
    const themeTint = useStore(s => s.themeTint);
    const accentColor = useStore(s => s.accentColor);
    const appIcon = useStore(s => s.appIcon);
    return (
        <div className="w-full">
            <SegmentedControl
                label={tr("Colours")}
                value={target}
                onChange={setTarget}
                options={[
                    { value: 'page', label: <span className="inline-flex items-center gap-2"><Dot hex={tintSwatch(theme, themeTint)} />{tr("Page")}</span> },
                    { value: 'accent', label: <span className="inline-flex items-center gap-2"><Dot hex={accentColor} />{tr("Accent")}</span> },
                    { value: 'icon', label: <span className="inline-flex items-center gap-2"><IconPreview icon={appIcon} size={16} variant="tile" />{tr("App icon")}</span> },
                ]}
            />
            {/* `key`: each target's half-typed value is its own. */}
            <div className="mt-4" key={target}>
                {target === 'page' && <ThemeTintField />}
                {target === 'accent' && <AccentField />}
                {target === 'icon' && <><AppIconColour /><AppIconShape /></>}
            </div>
        </div>
    );
}

/**
 * The tint palette alone; the row it sits in supplies its name and its line.
 *
 * THE CHIPS ARE DRESSED FOR THE MODE YOU ARE IN. The sixteen tints are stored
 * as pastels because a pastel is the LIGHT register — they are generated at one
 * lightness for exactly that reason (`THEME_TINTS`) — so in light mode the chip
 * is the value itself. In dark mode a
 * row of pastels would offer sixteen colours the app will never show you: the
 * same rose is a deep maroon.
 *
 * So a dark chip is that tint's own `700` — the rung the app paints its panels
 * and borders at, which is a surface a dark page really does carry. NOT the
 * page itself, and the reason is measured: the sixteen page colours in dark
 * mode sit 5 RGB units apart at their closest (Rose against Red), so a palette of pages is sixteen near-identical squares —
 * the one thing a picker may not be. What the PAGE looks like is the question
 * the two mode cards directly above answer, in full, for the tint chosen.
 */
export function ThemeTintField() {
    const { t: tr } = useTranslation();
    const theme = useStore(s => s.theme);
    const themeTint = useStore(s => s.themeTint);
    const setThemeTint = useStore(s => s.setThemeTint);
    // `tintSwatch` (themeRamp.ts) — and the hue-less pair, Ink and Paper, are
    // painted at the LIGHT panel rung in light mode: their stored value is the
    // depth end, and a true-black chip for a page that comes out light grey
    // would be wrong.
    const pageOf = useCallback((hex: string) => tintSwatch(theme, hex), [theme]);
    return (
        <ColorField
            value={themeTint}
            onChange={setThemeTint}
            colors={THEME_TINTS}
            swatch={pageOf}
            hint={tr("White is no tint at all.")}
        />
    );
}

/** The accent palette alone; its name comes from the switch above it. */
export function AccentField() {
    const { t: tr } = useTranslation();
    const accentColor = useStore(s => s.accentColor);
    const setAccentColor = useStore(s => s.setAccentColor);
    return (
        <ColorField
            value={accentColor}
            onChange={setAccentColor}
            colors={ACCENT_COLORS}
            hint={tr("Projects keep their own colour.")}
        />
    );
}

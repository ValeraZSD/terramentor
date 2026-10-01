import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store';
import ColorField, { ACCENT_COLORS, THEME_TINTS } from '../ui/ColorField';
import { tintSwatch } from '../../utils/themeRamp';

/**
 * The tint palette alone; the row it sits in supplies its name and its line.
 *
 * THE CHIPS ARE DRESSED FOR THE MODE YOU ARE IN. The sixteen tints are stored
 * as pastels because a pastel is the LIGHT register — they are generated at one
 * lightness for exactly that reason (`THEME_TINTS`) — so in light mode the chip
 * is the value itself and always has been. In dark mode it was too, and there a
 * row of pastels offers sixteen colours the app will never show you: the same
 * rose is a deep maroon.
 *
 * So a dark chip is that tint's own `700` — the rung the app paints its panels
 * and borders at, which is a surface a dark page really does carry. NOT the
 * page itself, and the reason is measured: the sixteen page colours in dark
 * mode sit 5 RGB units apart at their closest (`temp/tint-swatch-probe.mjs`,
 * Rose against Red), so a palette of pages is sixteen near-identical squares —
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
    // was "not that black" (2026-09-23).
    const pageOf = useCallback((hex: string) => tintSwatch(theme, hex), [theme]);
    return (
        <ColorField
            value={themeTint}
            onChange={setThemeTint}
            colors={THEME_TINTS}
            swatch={pageOf}
            hint={tr("White is no tint at all. Hex, rgb() or hsl().")}
        />
    );
}

/** The accent palette alone — its name and its one line come from the
 *  `SettingRow` that holds it, like every other setting on the page. */
export function AccentField() {
    const accentColor = useStore(s => s.accentColor);
    const setAccentColor = useStore(s => s.setAccentColor);
    return <ColorField value={accentColor} onChange={setAccentColor} colors={ACCENT_COLORS} />;
}

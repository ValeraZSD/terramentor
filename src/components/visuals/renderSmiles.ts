import type { VisualRenderer } from './registry';
import type { VisualPalette } from './palette';

/**
 * 2D chemical structures from SMILES strings via smiles-drawer.
 * One molecule per line; lines starting with # or // are ignored.
 */

/**
 * The elements smiles-drawer colours by name. Anything outside this list falls
 * back to `C` inside its own ThemeManager, which is what we want: an unusual
 * element is drawn in ink like the skeleton it hangs off.
 */
export const HETEROATOMS = ['O', 'N', 'F', 'CL', 'BR', 'I', 'P', 'S', 'B', 'SI'];

/**
 * The molecule in the app's own two colours: ink for the carbon skeleton, the
 * accent for everything that is not carbon.
 *
 * smiles-drawer ships CPK-ish themes — oxygen `#e74c3c`, nitrogen `#3498db`,
 * sulphur `#f1c40f` — fixed colours that belong to no theme this app has. On a
 * dark page beside seven accent-drawn samples, aspirin's three oxygens were the
 * brightest red on the screen and read as an error state.
 *
 * Nothing is lost by collapsing them: this is a 2D depiction and every atom
 * smiles-drawer colours it also LABELS, so the letter says which element it is
 * and the colour only says "not carbon". (A bond between two different elements
 * is drawn as a gradient between their two colours, so a C–O bond now fades
 * from ink into the accent — the same reading, in the page's own palette.)
 *
 * The accent is taken in its TEXT strength (`accentFg`, 4.5:1) rather than its
 * graphic one: nearly everywhere it lands here it is an 11px letter — `O`, `N`,
 * the `OH` of a hydroxyl — and the 3:1 a graphic needs draws those thin.
 *
 * `BACKGROUND` is declared because the theme table has the key, but nothing in
 * the SVG path uses it: the drawing goes onto the stage's own paper, which is
 * the rule every sample in the kinds gallery follows.
 */
export function appTheme(palette: VisualPalette): Record<string, string> {
    const theme: Record<string, string> = {
        FOREGROUND: palette.fg,
        BACKGROUND: palette.bg,
        C: palette.fg,
        H: palette.muted,
    };
    for (const el of HETEROATOMS) theme[el] = palette.accentFg;
    return theme;
}

const renderSmiles: VisualRenderer = async (el, code, ctx) => {
    const SmilesDrawer = (await import('smiles-drawer')).default;

    const lines = code
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
    if (lines.length === 0) throw new Error('no SMILES strings found.');

    const perRow = Math.min(lines.length, 2);
    const size = Math.min(Math.max(Math.floor(ctx.width / perRow) - 24, 200), 340);

    el.style.display = 'flex';
    el.style.flexWrap = 'wrap';
    el.style.gap = '8px';
    el.style.justifyContent = 'center';

    const drawer = new SmilesDrawer.SvgDrawer({
        width: size,
        height: Math.round(size * 0.75),
        themes: { app: appTheme(ctx.palette) },
    });

    for (const smiles of lines) {
        const tree = await new Promise((resolve, reject) => {
            SmilesDrawer.parse(
                smiles,
                (parsed: unknown) => resolve(parsed),
                () => reject(new Error(`invalid SMILES string: "${smiles}"`))
            );
        });

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(Math.round(size * 0.75)));
        svg.style.maxWidth = '100%';
        drawer.draw(tree, svg, 'app');
        el.appendChild(svg);
    }
};

export default renderSmiles;

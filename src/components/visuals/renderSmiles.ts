import type { VisualRenderer } from './registry';
import type { VisualPalette } from './palette';
import { MOLECULE_ATTR, type MoleculeGraph } from './arrival';

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
        const graph = moleculeGraph(drawer);
        if (graph) svg.setAttribute(MOLECULE_ATTR, JSON.stringify(graph));
        el.appendChild(svg);
    }
};

/**
 * The molecule as smiles-drawer laid it out: atom positions (null for an atom
 * it did not draw — a hydrogen, or the O of a `COOH` it wrote as one label),
 * the bonds between drawn atoms, and every ring's centre and members. All in
 * the svg's own user units, because the drawer draws at the vertex positions
 * and leaves the scaling to the viewBox.
 *
 * The SVG alone cannot say this reliably: a double bond is two lines offset
 * from the axis, a hashed wedge is a row of short cross-strokes, and neither
 * has an end on the atom it joins. The graph is the drawer's `preprocessor`,
 * a plain field rather than an API, so anything unexpected returns null and
 * the arrival falls back to reading the picture.
 */
export function moleculeGraph(drawer: unknown): MoleculeGraph | null {
    try {
        const pre = (drawer as { preprocessor?: { graph?: unknown; rings?: unknown } }).preprocessor;
        const graph = pre?.graph as {
            vertices?: { position?: { x: number; y: number }; value?: { isDrawn?: boolean } }[];
            edges?: { sourceId: number; targetId: number }[];
        } | undefined;
        if (!graph || !Array.isArray(graph.vertices) || !Array.isArray(graph.edges)) return null;
        const round = (n: number) => Math.round(n * 100) / 100;
        const v = graph.vertices.map(vx => {
            const p = vx.position;
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || vx.value?.isDrawn === false) return null;
            return [round(p.x), round(p.y)] as [number, number];
        });
        const e = graph.edges
            .filter(ed => v[ed.sourceId] && v[ed.targetId])
            .map(ed => [ed.sourceId, ed.targetId] as [number, number]);
        const rings = Array.isArray(pre?.rings) ? pre.rings as { center?: { x: number; y: number }; members?: number[] }[] : [];
        const r = rings
            .filter(ring => ring.center && Number.isFinite(ring.center.x) && Array.isArray(ring.members))
            .map(ring => [round(ring.center!.x), round(ring.center!.y), ring.members!.slice()] as [number, number, number[]]);
        return { v, e, r };
    } catch {
        return null;
    }
}

export default renderSmiles;

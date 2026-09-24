/**
 * The app's mark, drawn as a UI icon.
 *
 * This is the SMALL cut of the logo — the globe's grid dropped, the silhouette,
 * the pages and the spine kept, at a stroke weight that survives 16px. The full
 * mark's grid is sub-pixel below about 32px and turns to mud, which is the whole
 * reason there are two cuts.
 *
 * It strokes with `currentColor` and fills nothing, so it sits beside lucide
 * icons and takes its colour from the same place they do. The viewBox is the
 * stroked bounds, not the artboard: the artwork touches its own edges, so a box
 * copied from Illustrator crops the ear tips flat.
 *
 * The pages are hollow here — there is no tile to fill them with — so the globe
 * is CULLED the way `markArt` culls it behind the filled pages: the circle is
 * clipped to everything outside the two page quads. Unclipped, the rim ran on
 * behind the pages and their interiors showed it as stray background lines (the
 * assistant header's avatar, reported 2026-09-18). The cut is a clipPath, not a
 * mask — @napi-rs/canvas renders masks as nothing, which is the same reason
 * `markArt` clips — and its box and holes come from `server/iconArt.js`, with
 * the pages drawn FROM the holes, so the cut and the drawn edge cannot drift.
 * The id is a constant: every copy of this mark is identical, and a duplicated
 * id resolves to the first — the same shape, byte for byte.
 */
import { ART, CULL_BOX, pageHoles } from '../../server/iconArt.js';

const CULL_ID = 'tm-brand-cull';
const PAGE_D = pageHoles();

/**
 * `grid` draws the globe's grid — the DETAILED cut, for a surface that follows
 * the app icon's Detailed/Simple choice. It takes the lighter line the full
 * cut carries (`appIconSvg` weights the simple cut 1.2x), and like the tab it
 * wants about 20px to read as lines rather than mud (`gridFloor`).
 */
export function BrandMark({ className = 'w-4 h-4', title, grid = false }: { className?: string; title?: string; grid?: boolean }) {
    return (
        <svg
            viewBox="-8 -4.91 389.02 389.02"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth={grid ? 22 : 26}
            strokeLinejoin="round"
            strokeLinecap="round"
            role={title ? 'img' : undefined}
            aria-label={title}
            aria-hidden={title ? undefined : true}
        >
            {title && <title>{title}</title>}
            <clipPath id={CULL_ID}>
                <path clipRule="evenodd" d={`${CULL_BOX} ${PAGE_D}`} />
            </clipPath>
            <g clipPath={`url(#${CULL_ID})`}>
                <circle cx="186.51" cy="189.6" r="181.51" />
                {/* The export's own grid string (a constant, never input), so
                    the drawing lives in one file. */}
                {grid && <g dangerouslySetInnerHTML={{ __html: ART.grid }} />}
            </g>
            <path d={PAGE_D} />
            <line x1="186.51" y1="8.09" x2="186.51" y2="371.11" />
        </svg>
    );
}

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
 */
export function BrandMark({ className = 'w-4 h-4', title }: { className?: string; title?: string }) {
    return (
        <svg
            viewBox="-8 -4.91 389.02 389.02"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth={26}
            strokeLinejoin="round"
            strokeLinecap="round"
            role={title ? 'img' : undefined}
            aria-label={title}
            aria-hidden={title ? undefined : true}
        >
            {title && <title>{title}</title>}
            <circle cx="186.51" cy="189.6" r="181.51" />
            <polygon points="368.02 8.09 186.51 98.85 186.51 280.36 368.02 189.6 368.02 8.09" />
            <polygon points="5 8.09 186.51 98.85 186.51 280.36 5 189.6 5 8.09" />
            <line x1="186.51" y1="8.09" x2="186.51" y2="371.11" />
        </svg>
    );
}

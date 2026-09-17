/**
 * Chart titles, lifted out of the SVG and rendered as HTML above it.
 *
 * Both chart libraries draw their title as an SVG `<text>` centred on the plot.
 * SVG text does not wrap, and an `<svg>` clips to its own viewport — so on a
 * phone a title like "Superposition: adding two waves (blue + green = red)" is
 * silently sliced off at BOTH ends, and the stage's `overflow-x:auto` can't
 * rescue it because the clipping happens inside the SVG, not outside it.
 *
 * An HTML caption wraps, inherits the app's type scale and theme, and stays
 * readable at any width. So the title is removed from the spec and re-emitted
 * here instead.
 */

export interface ChartTitle {
    text: string;
    subtitle: string;
}

/**
 * Coerce the shapes a model writes for a title — `"str"`, `["line", "line"]`,
 * `{text, subtitle}` — into one flat title/subtitle pair. Returns null when
 * there is nothing to show.
 */
export function normalizeTitle(value: unknown): ChartTitle | null {
    if (!value) return null;

    const flatten = (v: unknown): string => {
        if (typeof v === 'string') return v.trim();
        if (Array.isArray(v)) return v.map(flatten).filter(Boolean).join(' ');
        return '';
    };

    if (typeof value === 'string' || Array.isArray(value)) {
        const text = flatten(value);
        return text ? { text, subtitle: '' } : null;
    }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const text = flatten(obj.text);
        const subtitle = flatten(obj.subtitle);
        if (!text && !subtitle) return null;
        return { text: text || subtitle, subtitle: text ? subtitle : '' };
    }
    return null;
}

/**
 * Pull `title` off a spec object (mutating it) and return it normalized, so the
 * library never draws one. Safe to call on a spec that has no title.
 */
export function takeTitle(spec: Record<string, unknown>): ChartTitle | null {
    const title = normalizeTitle(spec.title);
    if ('title' in spec) delete spec.title;
    return title;
}

/**
 * Append an HTML caption to the stage. Sticky-free, wraps naturally, and is
 * centred over whatever the chart's own width turns out to be.
 */
export function appendCaption(el: HTMLElement, title: ChartTitle | null): void {
    if (!title) return;
    const wrap = document.createElement('figcaption');
    wrap.className = 'mb-2 text-center';

    const main = document.createElement('div');
    main.className = 'text-sm font-medium text-slate-700 dark:text-slate-200 leading-snug break-words';
    main.textContent = title.text;
    wrap.appendChild(main);

    if (title.subtitle) {
        const sub = document.createElement('div');
        sub.className = 'text-xs text-slate-500 dark:text-slate-400 leading-snug break-words mt-0.5';
        sub.textContent = title.subtitle;
        wrap.appendChild(sub);
    }
    el.appendChild(wrap);
}

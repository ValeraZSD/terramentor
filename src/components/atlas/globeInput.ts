/**
 * What the atlas surface makes of a wheel, a key and a pointer press, kept
 * apart from `GlobeMap` so each rule can be asserted without a canvas
 * (`tools/atlas-world-gates.mjs`).
 */

/** Roughly one line of text, the size a line-mode wheel step stands for. */
export const WHEEL_LINE_PX = 33;
/** One page-mode wheel step: a big step, but not a whole screen of zoom. */
export const WHEEL_PAGE_PX = 400;

/**
 * A wheel event's vertical travel in pixels, whatever unit it came in.
 *
 * Most wheels report pixels (`deltaMode` 0), but Firefox and some mice report
 * lines (1) or pages (2). Read as pixels, a line-mode notch of 3 zoomed about
 * thirty times slower than the same notch elsewhere.
 */
export function wheelPixels(e: { deltaY: number; deltaMode: number }): number {
    if (e.deltaMode === 1) return e.deltaY * WHEEL_LINE_PX;
    if (e.deltaMode === 2) return e.deltaY * WHEEL_PAGE_PX;
    return e.deltaY;
}

export type GlobeKeyAction =
    | 'left' | 'right' | 'up' | 'down' | 'zoomIn' | 'zoomOut' | 'reset' | 'fullscreen';

const KEYS: Record<string, GlobeKeyAction> = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    '+': 'zoomIn', '=': 'zoomIn', '-': 'zoomOut', '_': 'zoomOut',
    '0': 'reset', f: 'fullscreen',
};

/**
 * What a key press asks of the map, or null when it is not the map's.
 *
 * A press with Ctrl, Cmd or Alt held is the browser's or the system's: Ctrl
 * and minus is the page zoom, and the map taking it left a reader unable to
 * make the page smaller while the map had focus.
 */
export function globeKeyAction(
    e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
): GlobeKeyAction | null {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    return KEYS[e.key] ?? null;
}

/**
 * Whether a pointer press may drag or pick. Only the main mouse button does;
 * a right click opens the context menu and a middle click scrolls, and neither
 * may select the region under it. Touch and pen always press with button 0.
 */
export function pressesMap(e: { pointerType: string; button: number }): boolean {
    return e.pointerType !== 'mouse' || e.button === 0;
}

/** A card held open over the map: which region, and which topic in it. */
export type HeldHit<R, T> =
    | { kind: 'region'; region: R; topic: null }
    | { kind: 'topic'; region: R; topic: T };

/**
 * A held card looked up again in a fresh layout: the same region (and topic)
 * as it is NOW, so a renamed region shows its new name, or null once it is
 * gone. A topic that moved to another region is followed there.
 */
export function resolveHeld<R extends { id: number }, T extends { id: number }>(
    held: HeldHit<R, T> | null,
    placed: readonly { region: R; topics: readonly { topic: T }[] }[],
): HeldHit<R, T> | null {
    if (!held) return null;
    if (held.kind === 'region') {
        const p = placed.find(x => x.region.id === held.region.id);
        return p ? { kind: 'region', region: p.region, topic: null } : null;
    }
    const own = placed.find(x => x.region.id === held.region.id);
    for (const p of own ? [own, ...placed] : placed) {
        const t = p.topics.find(x => x.topic.id === held.topic.id);
        if (t) return { kind: 'topic', region: p.region, topic: t.topic };
    }
    return null;
}

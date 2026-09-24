/**
 * Label placement for the atlas canvas.
 *
 * Split out of `AtlasMap` because this is the part of the map that can be
 * *wrong on purpose*: a name that lands on the wrong bubble, or gets cut to
 * "Ne…", is a rendering decision with no exception to catch it, and the browser
 * tools are not always available to look at one. Nothing here touches React or
 * the camera — it takes a 2D context and screen coordinates — so a script can
 * draw the real placement to a file and a person can check it.
 *
 * The rules, in one place:
 *  • Text is measured, never counted. A fixed "34 characters then …" is a guess
 *    about how wide a character is: it throws away room on a wide screen and
 *    still overflows a narrow bubble.
 *  • A label that would collide with one already painted is dropped, not moved.
 *    The caller controls priority by painting in order — biggest region first,
 *    and region names after the topic names, so they win the ground they need.
 *  • A region's name is ALWAYS centred on its bubble, and may overflow it. It
 *    is a name FOR the circle, the way a place name sits across a country on a
 *    paper map — the middle is the widest path available and the one position
 *    that cannot be read as belonging to the circle next door. Placing it
 *    beside the bubble instead put names on their neighbours; only placing it
 *    inside when it fitted meant the small bubbles — most of the map — never
 *    got a name at all.
 *  • Which means a name may be wrapped and, if it still does not fit the lines
 *    it is given, cut. That is the trade centring buys, and it is the right way
 *    round: a cut name still says which region this is, a missing one says
 *    nothing.
 *  • And that last rule applies to COLLISIONS too, which is where it used to
 *    stop applying. A name that hit something already painted was dropped with
 *    nothing tried — no smaller size, no narrower wrap, no nudge — so on the
 *    real library 52 of 123 regions went unnamed at the default view, one of
 *    them the second-largest bubble on the map. A region now gets a ladder of
 *    attempts, each one asking for less room than the last, and only gives up
 *    when even the smallest legible version has nowhere to go.
 *  • An INVISIBLE label reserves nothing. Alpha is a caller's fade, and a fade
 *    that has reached zero is not a label; painting its box into the collision
 *    list let faded-out region names blank the topic names underneath them,
 *    which is why the zoomed-in map carried five words and 900 nameless dots.
 */

export interface LabelStyle {
    size: number;
    weight: number;
    alpha: number;
}

export interface Labeller {
    /** One line, ellipsized to `maxWidth`. Returns false if it was dropped. */
    label: (
        text: string, cx: number, cy: number, style: LabelStyle, maxWidth: number,
        align?: 'baseline' | 'middle',
    ) => boolean;
    /** Wrapped into up to `maxLines`, centred on the point. Returns false if it was dropped. */
    wrapLabel: (
        text: string, cx: number, cy: number, style: LabelStyle, maxWidth: number,
        maxLines?: number,
    ) => boolean;
    /** A region name, centred on its bubble — overflowing it if it must. */
    placeRegion: (
        text: string, cx: number, cy: number, radius: number, style: LabelStyle,
        opts?: { maxLines?: number; minSize?: number },
    ) => boolean;
    /**
     * Paint everything placed so far, in the order it was placed.
     *
     * Only meaningful with `defer`, where placing a label reserves its ground
     * and returns immediately, and NOTHING is painted until this is called —
     * which is how text ends up over the map rather than inside it. A caller
     * that does not defer has already painted and this does nothing.
     */
    flush: () => void;
}

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * How far past its bubble a name may run, as a share of the diameter. A name
 * is allowed to overflow — a small region is still a region and still needs
 * naming — but not so far that it reads as a caption for the whole area.
 */
const OVERFLOW = 1.9;
/** Nothing narrower than this is worth wrapping into; below it, one line. */
const MIN_WRAP_WIDTH = 96;
/**
 * Below this the label is not faint, it is absent — so it must not reserve the
 * ground a visible label could have used. The caller's fade ramps are the ones
 * that reach zero here, and a box pushed at alpha 0 is a hole in the map with
 * nothing to show for it.
 */
export const VISIBLE_ALPHA = 0.04;
/**
 * The ladder a region name climbs down when the centre it wants is taken:
 * `size` scales the type, `room` the width it wraps into (a narrower wrap is a
 * taller, thinner box, which often fits between two neighbours where a wide one
 * cannot), `lines` allows that extra height. Each rung asks for less than the
 * one above. The last rung is a genuinely small name — still readable, still
 * saying which region this is, which is the whole argument for having one.
 */
const ATTEMPTS: { size: number; room: number; lines: number }[] = [
    { size: 1, room: 1, lines: 0 },
    { size: 1, room: 0.68, lines: 1 },
    { size: 0.84, room: 0.8, lines: 1 },
    { size: 0.7, room: 0.62, lines: 2 },
];
/**
 * The map's type metrics, in ONE place because there are two surfaces drawing
 * them — the plane and the sphere — and a floor that disagrees between the two
 * is a map that is legible depending on which way you look at the library.
 *
 * `MIN_LABEL_PX` is the same floor the rest of the app defends (a floor is a
 * SIZE in px, never a scale): below it a name is not faint, it is unreadable, so
 * a name that cannot be drawn at least this big is DROPPED rather than shrunk.
 * It was 9 here, which reached the reader at 9 px on both surfaces.
 */
export const MIN_LABEL_PX = 12;
/** A region name never grows past this, however big its bubble. */
export const MAX_NAME_PX = 17;
/** A topic's own name is drawn at the floor: it is the densest text on the map. */
export const TOPIC_NAME_PX = 12;
/** A bubble smaller than this radius (screen px) gets no name at all. */
export const MIN_NAMED_RADIUS = 7;
/** Where a name starts fading in as the map resolves into topics. */
export const NAME_FADE_START = 0.55;
/** How fast a topic name's own fade eases, per frame. */
export const NAME_EASE = 0.16;

/**
 * `ui_scale` (80–160%) scales the app's root font size, and a canvas is not laid
 * out by the document — so unless the map ASKS, it is the one surface that
 * ignores the setting entirely (the widget sandbox is handed the same number for
 * the same reason). Read once where the device pixel ratio is read, since both
 * change for the same reasons, and cached because `getComputedStyle` in a draw
 * loop is a style recalculation per frame.
 */
let rootScale = 1;
export function refreshRootFontScale(): number {
    try {
        const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
        if (px > 0) rootScale = Math.min(2.5, Math.max(0.5, px / 16));
    } catch { /* no document (a render script): 1 is right */ }
    return rootScale;
}
/** The reader's own px for a size expressed at 100%. */
export const labelPx = (px: number) => Math.round(px * rootScale);


export function createLabeller(
    ctx: CanvasRenderingContext2D,
    { width, height, ink, halo, defer = false }: {
        width: number; height: number; ink: string; halo: string;
        /**
         * Reserve the ground now, paint on `flush()`.
         *
         * A map paints its bubbles, then its dots, then its text — but the text
         * has to be PLACED while the dots are being worked out, because that is
         * when the caller knows which names matter. Without this, the labels
         * placed early (a region's name, the topic a replay is arriving at) were
         * painted early too, and every dot drawn afterwards went over the top of
         * them.
         */
        defer?: boolean;
    },
): Labeller {
    const boxes: Box[] = [];
    const queued: { lines: string[]; cx: number; box: Box; style: LabelStyle }[] = [];

    const setFont = (size: number, weight: number) => {
        ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    };

    const ellipsize = (text: string, maxWidth: number) => {
        if (ctx.measureText(text).width <= maxWidth) return text;
        let lo = 0, hi = text.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
            else hi = mid - 1;
        }
        return lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : '';
    };

    /** Greedy wrap into at most `maxLines`; whatever is left over is ellipsized. */
    const wrap = (text: string, maxWidth: number, maxLines: number) => {
        const words = text.split(' ').filter(Boolean);
        const lines: string[] = [];
        let line = '';
        for (let i = 0; i < words.length; i++) {
            const next = line ? `${line} ${words[i]}` : words[i];
            if (!line || ctx.measureText(next).width <= maxWidth) { line = next; continue; }
            if (lines.length + 1 === maxLines) {
                line = ellipsize(`${line} ${words.slice(i).join(' ')}`, maxWidth);
                break;
            }
            lines.push(line);
            line = words[i];
        }
        if (line) lines.push(ellipsize(line, maxWidth));
        return lines.filter(Boolean);
    };

    /** Where these lines would land. Assumes the font is already set. */
    const boxOf = (lines: string[], cx: number, cy: number, size: number, align: 'baseline' | 'middle') => {
        const lh = size * 1.16;
        const w = Math.max(...lines.map(l => ctx.measureText(l).width));
        const top = align === 'middle' ? cy - (lh * lines.length) / 2 : cy - size * 0.85;
        return { x0: cx - w / 2 - 3, y0: top, x1: cx + w / 2 + 3, y1: top + lh * lines.length };
    };

    const free = (box: Box) => {
        if (box.x1 < 0 || box.x0 > width || box.y1 < 0 || box.y0 > height) return false;
        for (const b of boxes) {
            if (box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0) return false;
        }
        return true;
    };

    /** Put the ink down. The font is set here, not assumed, because a deferred
     *  label is painted long after the call that measured it. */
    const render = (lines: string[], cx: number, box: Box, style: LabelStyle) => {
        setFont(style.size, style.weight);
        const lh = style.size * 1.16;
        ctx.globalAlpha = style.alpha;
        ctx.textAlign = 'center';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = halo;
        ctx.fillStyle = ink;
        for (let i = 0; i < lines.length; i++) {
            const baseline = box.y0 + i * lh + style.size * 0.85;
            ctx.strokeText(lines[i], cx, baseline);
            ctx.fillText(lines[i], cx, baseline);
        }
        ctx.globalAlpha = 1;
    };

    /**
     * Take the ground and, unless the caller is deferring, paint it now.
     *
     * The ground is taken either way and at the moment of the call, because
     * that is what decides which of two labels wanting the same place gets it —
     * deferring changes WHEN a label is drawn, never WHETHER.
     */
    const draw = (lines: string[], cx: number, box: Box, style: LabelStyle) => {
        boxes.push(box);
        if (defer) queued.push({ lines, cx, box, style: { ...style } });
        else render(lines, cx, box, style);
        return true;
    };

    const paint = (
        lines: string[], cx: number, cy: number, style: LabelStyle,
        align: 'baseline' | 'middle',
    ) => {
        if (!lines.length || style.alpha < VISIBLE_ALPHA) return false;
        const box = boxOf(lines, cx, cy, style.size, align);
        return free(box) && draw(lines, cx, box, style);
    };

    const label: Labeller['label'] = (text, cx, cy, style, maxWidth, align = 'baseline') => {
        setFont(style.size, style.weight);
        return paint([ellipsize(text, maxWidth)], cx, cy, style, align);
    };

    const wrapLabel: Labeller['wrapLabel'] = (text, cx, cy, style, maxWidth, maxLines = 2) => {
        setFont(style.size, style.weight);
        const lines = wrap(text, maxWidth, maxLines);
        if (!lines.length) return false;
        return paint(lines, cx, cy, style, 'middle');
    };

    const placeRegion: Labeller['placeRegion'] = (
        text, cx, cy, radius, style, { maxLines = 3, minSize = labelPx(MIN_LABEL_PX) } = {},
    ) => {
        const name = text.replace(/\s+/g, ' ').trim();
        if (!name || style.alpha < VISIBLE_ALPHA) return false;

        // Wrap to the bubble's own width where there is one to wrap to, and let
        // the result overflow. `radius * OVERFLOW` is wider than the circle on
        // purpose: the alternative — only naming a bubble whose name fits
        // inside it — leaves most of the map unnamed, because most regions are
        // small. A name that spills a little past its circle still points at
        // the circle it is centred on.
        const baseRoom = Math.max(radius * OVERFLOW, MIN_WRAP_WIDTH);
        const floor = Math.min(style.size, Math.max(minSize, 1));
        let lastSize = 0;

        for (const step of ATTEMPTS) {
            const size = Math.max(floor, Math.round(style.size * step.size));
            const room = Math.max(baseRoom * step.room, MIN_WRAP_WIDTH * step.room);
            // Once the ladder has hit the floor size there is nothing left to
            // give on type; a rung that only repeats the previous one is a
            // wasted measure pass over every region, every frame.
            if (size === lastSize && step.room >= 1) continue;
            lastSize = size;
            setFont(size, style.weight);

            let lines = wrap(name, room, maxLines + step.lines);
            // One line is better than two when the whole name fits on one: a
            // wrapped name is harder to read and takes more of the map.
            if (lines.length > 1 && ctx.measureText(name).width <= room) lines = [name];
            if (!lines.length) continue;

            const attempt = { ...style, size };
            const lh = size * 1.16;
            // Where the name may sit vertically. The centre is always tried
            // first and is nearly always where it lands. The alternatives are
            // offered only when the whole block fits INSIDE the circle, so a
            // nudged name is still unambiguously written across its own bubble
            // and can never be read as a caption for the neighbour it moved
            // towards — which is the trap that killed placing names beside
            // bubbles in the first place.
            const slack = radius - (lh * lines.length) / 2 - 2;
            const offsets = slack > 4 ? [0, -slack * 0.72, slack * 0.72] : [0];

            for (const dy of offsets) {
                const box = boxOf(lines, cx, cy + dy, size, 'middle');
                // Slide a name that would run off the edge of the map back into
                // view. This is the one thing allowed to move it off its centre
                // horizontally, and only at the screen edge: half a name is not
                // a name, and on a phone the map is narrower than several of
                // these.
                const dx = box.x0 < 2 ? 2 - box.x0 : box.x1 > width - 2 ? width - 2 - box.x1 : 0;
                const shifted = { ...box, x0: box.x0 + dx, x1: box.x1 + dx };
                if (free(shifted)) return draw(lines, cx + dx, shifted, attempt);
            }
        }
        return false;
    };

    const flush: Labeller['flush'] = () => {
        for (const item of queued) render(item.lines, item.cx, item.box, item.style);
        queued.length = 0;
    };

    return { label, wrapLabel, placeRegion, flush };
}

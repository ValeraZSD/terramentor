/**
 * How a freshly drawn visual ARRIVES.
 *
 * A mermaid diagram used to pop in whole; then it was given a stagger, and the
 * stagger had a bug that was worse than the pop: index.css animated `transform`
 * on every stamped part, and a mermaid node is an SVG <g> POSITIONED by its
 * `transform` attribute — a CSS transform on an SVG element overrides that
 * attribute outright, so for the whole of the animation every box sat at the
 * origin (opacity fading in, all in one corner) and popped to its place the
 * moment the class came off. Edges, which are positioned by their `d`, drew in
 * the right place all along, which is why it looked like the boxes were the
 * broken half.
 *
 * Rules that came out of that:
 *  - a part only ever changes OPACITY (and, for a stroke, how much of it is
 *    drawn). Nothing here may write `transform`, `x` or `y`.
 *  - parts arrive in READING order — the order a person's eye follows the
 *    picture — derived from where each part is drawn, not from document
 *    order: mermaid writes every edge before every node, so document order
 *    drew all the arrows first and the boxes afterwards.
 *  - a stroke DRAWS itself (pathLength="1" so the dash arithmetic is the same
 *    for every path, then dashoffset 1 → 0): an edge from its source to its
 *    target, a curve from left to right, a bond from one atom to the next.
 *    That is what makes a diagram read as connected and a graph read as
 *    plotted, rather than as pieces appearing.
 *  - AN ARROWHEAD IS PART OF ITS LINE AND ARRIVES WITH IT. A marker is painted
 *    at a path's vertices and `stroke-dasharray` does not touch it (SVG 1.1
 *    §11.6.2 — dashes affect the stroke, not the markers), so a line drawing
 *    itself over 560ms shows its arrowhead, in full, at the far end, from the
 *    first frame: a floating ▸ pointing at a box that has not arrived, with no
 *    line behind it. A diagram reads node, line, arrow, node — in that order.
 *    So the markers are switched off inline for
 *    the length of the draw and switched back on when THAT path's own
 *    `vb-edge-draw` ends — per edge, not at the end of the whole arrival,
 *    which would pop every arrowhead on at once.
 *  - the timing lives HERE, written inline on each part, so the shell can be
 *    told exactly how long the whole arrival takes and keep the class on
 *    until it is over. With the numbers in CSS the shell guessed 1400ms, and
 *    on a diagram with more than ~20 parts the class came off first — the
 *    tail of the diagram popped in.
 *
 * Each visual kind has its own reading of "part" (see `plan*` below): a
 * chart's axes come before its marks and its legend after them; a plot's
 * axes come before its curves; a molecule grows outward from one atom, each
 * atom's label arriving with the bond that reaches it. Kinds that animate themselves (animation, p5, widget) get only the
 * stage's own fade — fading their parts over their own clock would be wrong.
 */

/** The stage's own rise-and-fade (index.css `vb-arrive`). */
export const ARRIVAL_STAGE_MS = 420;
/** Before the first part starts, so the stage has begun to show. */
export const ARRIVAL_LEAD_MS = 120;
/** Between one part starting and the next, for a picture with few parts. */
export const ARRIVAL_STEP_MS = 90;
/** The step shrinks so the whole stagger fits in this, however many parts. */
export const ARRIVAL_BUDGET_MS = 1800;
/** …but never below this: past it the eye reads a wave, not a sequence. */
export const ARRIVAL_MIN_STEP_MS = 12;
/** One part's fade. */
export const ARRIVAL_PART_MS = 380;
/** A diagram edge draws itself over this (its fade runs alongside). */
export const ARRIVAL_EDGE_MS = 560;
/** A plotted curve or chart line draws over this. */
export const ARRIVAL_CURVE_MS = 900;
/** A bond in a molecule draws over this. */
export const ARRIVAL_BOND_MS = 300;

/**
 * THE GAP AFTER A DRAWN EDGE IS THE EDGE'S OWN DRAW, NOT A COUNT OF STEPS.
 *
 * The order a diagram has to read in is **node, line, arrow, node** — and both
 * ways of getting it wrong have now shipped. First the arrowhead was painted
 * from the first frame of the draw (markers ignore `stroke-dasharray`), so the
 * arrow arrived before its line. That was fixed by switching the markers off
 * for the length of the draw — and then the arrow arrived after the box it
 * points at, because the gap before that box was counted in STEPS: two steps
 * is 180ms and the line takes 560ms to reach the arrowhead, so the target
 * faded in while the stroke was still a third of the way along and the ▸
 * appeared last of the four.
 *
 * A count of steps can never express "when the line gets there" — the two
 * numbers are unrelated, and the budget rescales one of them and not the
 * other. So a gap is a TIME: a plain one is `ARRIVAL_STEP_MS`, and the one
 * after a part that draws itself is exactly how long that part takes to draw.
 * The next part therefore starts on the frame the stroke reaches its end,
 * which is the same frame `hideMarkersWhileDrawing` puts the arrowhead back.
 *
 * Everything still fits `ARRIVAL_BUDGET_MS`: the gaps are summed first and the
 * whole thing is scaled by one factor — the DRAW DURATIONS INCLUDED, or the
 * scaling would put the arrowhead back out of step with the box.
 */
const gapAfter = (s: Step): number => (s.draw || ARRIVAL_STEP_MS);

type Point = [number, number];
/**
 * One thing that arrives: what it is, where it is (global coordinates), and if
 * it draws itself how long that takes. How long to wait after it follows from
 * `draw` alone (`gapAfter`), so no plan has to state it.
 *
 * A plan whose parts arrive in PARALLEL — a molecule grows along every branch
 * at once — cannot be a queue of gaps, so it states `at` instead: when the
 * part starts, in unscaled ms. A plan gives `at` on every step or on none.
 * `back` draws the stroke from its END: a bond is written left to right
 * whichever atom the growth reached first.
 */
type Step = { el: Element; origin: Point | null; draw: number | false; at?: number; back?: boolean };

const NUM = '([-+]?[\\d.]+(?:e[-+]?\\d+)?)';
const TRANSLATE_RE = new RegExp(`translate\\(\\s*${NUM}[\\s,]+${NUM}`, 'i');
const MOVETO_RE = new RegExp(`^\\s*[Mm]\\s*${NUM}[\\s,]+${NUM}`);
const NUMBERS_RE = /[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi;
const ATTR = 'data-vb-arrive';

function finitePoint(x: string | null, y: string | null): Point | null {
    if (x == null || y == null) return null;
    const px = parseFloat(x), py = parseFloat(y);
    return Number.isFinite(px) && Number.isFinite(py) ? [px, py] : null;
}

/**
 * Where a part is drawn, read from its attributes rather than measured: the
 * stage is `display: none` until the render is accepted, so nothing here has
 * a layout to measure. A positioned group answers with its translate; a path
 * with its first point; a rect/text/line with x/y; a bare group with whichever
 * of its children answers first.
 */
export function partOrigin(el: Element, depth = 0): Point | null {
    const tr = el.getAttribute('transform');
    const m = tr ? TRANSLATE_RE.exec(tr) : null;
    if (m) return finitePoint(m[1], m[2]);
    const d = el.getAttribute('d');
    const dm = d ? MOVETO_RE.exec(d) : null;
    if (dm) return finitePoint(dm[1], dm[2]);
    const xy = finitePoint(el.getAttribute('x'), el.getAttribute('y'));
    if (xy) return xy;
    const x1y1 = finitePoint(el.getAttribute('x1'), el.getAttribute('y1'));
    if (x1y1) return x1y1;
    const cxy = finitePoint(el.getAttribute('cx'), el.getAttribute('cy'));
    if (cxy) return cxy;
    const pts = el.getAttribute('points');
    const pm = pts ? new RegExp(`^\\s*${NUM}[\\s,]+${NUM}`).exec(pts) : null;
    if (pm) return finitePoint(pm[1], pm[2]);
    if (depth >= 3) return null;
    for (const child of Array.from(el.children)) {
        const o = partOrigin(child, depth + 1);
        if (o) return o;
    }
    return null;
}

/**
 * Which way a diagram is laid out, read off its EDGES — not their length
 * but their AGREEMENT. Every edge runs from an earlier rank to a later one,
 * so in a top-down diagram every edge's Δy has the same sign while the Δx go
 * both ways and cancel; in a left-right diagram it is the other way round.
 * Comparing the magnitudes instead does not work: mermaid's nodes are wide
 * and its ranks close, so a top-down diamond's diagonal edges have more run
 * than rise. A diagram with no edges (or whose edges cancel both ways — a
 * chain with a loop back to its start) falls back to counting rank levels:
 * nodes on one rank share a coordinate on the rank axis, so a top-down
 * diagram has few distinct y values and many x values.
 */
export function isLeftToRight(points: Point[], edges: [Point, Point][] = []): boolean {
    if (edges.length) {
        let sumDx = 0, sumDy = 0;
        for (const [a, b] of edges) { sumDx += b[0] - a[0]; sumDy += b[1] - a[1]; }
        const ax = Math.abs(sumDx), ay = Math.abs(sumDy);
        if (Math.abs(ax - ay) > 1e-6) return ax > ay;
    }
    const levels = (axis: 0 | 1) => new Set(points.map(p => Math.round(p[axis] / 8))).size;
    return points.length > 1 && levels(0) < levels(1);
}

/** Both ends of a path, from the first and last coordinate pair in its `d`. */
export function pathEnds(el: Element): [Point, Point] | null {
    const d = el.getAttribute('d');
    if (!d) return null;
    const nums = (d.match(NUMBERS_RE) || []).map(Number).filter(Number.isFinite);
    if (nums.length < 4) return null;
    return [[nums[0], nums[1]], [nums[nums.length - 2], nums[nums.length - 1]]];
}

/** Reading order: rank axis first (rounded, so one rank stays one rank), then along it. */
export function readingOrder<T>(items: { origin: Point | null; item: T }[], lr: boolean): T[] {
    const primary = lr ? 0 : 1;
    const secondary = lr ? 1 : 0;
    const key = (p: Point | null) => (p ? [Math.round(p[primary] / 8), p[secondary]] : [Infinity, Infinity]);
    return items
        .map((entry, index) => ({ entry, index, k: key(entry.origin) }))
        .sort((a, b) => (a.k[0] - b.k[0]) || (a.k[1] - b.k[1]) || (a.index - b.index))
        .map(x => x.entry.item);
}

/** Left to right, then top to bottom: the order for marks on a chart, bonds in a molecule. */
function leftToRight(steps: Step[]): Step[] {
    return steps
        .map((s, index) => ({ s, index, k: s.origin ? [Math.round(s.origin[0] / 4), s.origin[1]] : [Infinity, Infinity] }))
        .sort((a, b) => (a.k[0] - b.k[0]) || (a.k[1] - b.k[1]) || (a.index - b.index))
        .map(x => x.s);
}

const STROKE_TAGS = new Set(['path', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'rect']);

/**
 * Can this stroke draw itself? Only something with a plain solid stroke: a
 * dotted or dashed one has a dash pattern of its own that the draw would
 * lose. Mermaid writes `stroke-dasharray: 0` on its SOLID edges, so "0"
 * counts as none.
 */
function hasSolidStroke(el: Element): boolean {
    if (!STROKE_TAGS.has(el.tagName.toLowerCase())) return false;
    if (el.classList.contains('edge-pattern-dotted') || el.classList.contains('edge-pattern-dashed')) return false;
    const solid = (v: string | null | undefined) => !v || /^(none|0(px)?(\s*,?\s*0(px)?)*)$/.test(v.trim());
    if (!solid(el.getAttribute('stroke-dasharray'))) return false;
    const style = el.getAttribute('style') || '';
    const inline = /stroke-dasharray\s*:\s*([^;]+)/i.exec(style);
    if (inline && !solid(inline[1])) return false;
    try {
        if (!solid(getComputedStyle(el).strokeDasharray)) return false;
    } catch { /* no computed style here (a detached document) — treat as solid */ }
    return true;
}

/* ── mermaid ──────────────────────────────────────────────────────────── */

/**
 * The pieces mermaid draws a diagram from. Nodes, clusters and edge labels
 * are positioned <g>s; flowchart edges are bare <path class="flowchart-link">
 * (there is no `.edgePath` wrapper in mermaid 11 — the old selector matched
 * nothing, which is why only the boxes ever staggered); state and class
 * diagrams keep their edge paths under `.transition` / `.relation`; a mindmap's
 * branches are `path.edge`; a sequence diagram's messages are `.messageLine0/1`.
 */
const MERMAID_PARTS = [
    '.node', '.cluster', '.edgeLabel', '.flowchart-link', '.edgePath', '.transition', '.relation',
    '.mindmap-node', 'path.edge', '.section', '.actor', '.messageText', '.messageLine0', '.messageLine1',
    '.state', '.pieCircle', '.legend',
].join(', ');

/**
 * The translate every ancestor group up to the <svg> contributes. A flowchart
 * SUBGRAPH is a nested `g.root` carrying its own translate, and everything
 * inside it — nodes, edges, the cluster rect — is written in the subgraph's
 * own coordinates. Read raw, the subgraph's "Multi-Head Attention" at
 * translate(164, 72) sorted before the outer chain's "Token Embedding" at
 * translate(300, 267), so the diagram arrived in a scramble: the inside of
 * the box before the box, the end of the chain in the middle. Mermaid only
 * ever positions with translate, so summing them is the whole transform.
 */
export function globalOffset(el: Element): Point {
    let x = 0, y = 0;
    let cur: Element | null = el.parentElement;
    while (cur && cur.tagName.toLowerCase() !== 'svg') {
        const tr = cur.getAttribute('transform');
        const m = tr ? TRANSLATE_RE.exec(tr) : null;
        if (m) { x += parseFloat(m[1]); y += parseFloat(m[2]); }
        cur = cur.parentElement;
    }
    return [x, y];
}

/** `partOrigin` in the svg's own frame — the only frame two parts can be compared in. */
export function globalOrigin(el: Element): Point | null {
    const local = partOrigin(el);
    if (!local) return null;
    const [ox, oy] = globalOffset(el);
    return [local[0] + ox, local[1] + oy];
}

type Box = { x: number; y: number; w: number; h: number };

/**
 * The area a node or cluster occupies, in the svg's frame, read off its own
 * shape: a node is `<g transform="translate(cx,cy)">` around a shape centred
 * on the origin (a rect at -w/2, a circle of radius r, a diamond's points, a
 * cylinder's path), a cluster is a bare `<g>` around a rect in its parent's
 * coordinates. A part with no shape gets a point box at its origin.
 */
export function partBox(el: Element): Box | null {
    const tr = el.getAttribute('transform');
    const m = tr ? TRANSLATE_RE.exec(tr) : null;
    const own: Point = m ? [parseFloat(m[1]) || 0, parseFloat(m[2]) || 0] : [0, 0];
    const [ox, oy] = globalOffset(el);
    const shift = (b: Box): Box => ({ x: b.x + own[0] + ox, y: b.y + own[1] + oy, w: b.w, h: b.h });
    for (const child of Array.from(el.children)) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'rect') {
            const b = { x: parseFloat(child.getAttribute('x') || '0'), y: parseFloat(child.getAttribute('y') || '0'), w: parseFloat(child.getAttribute('width') || '0'), h: parseFloat(child.getAttribute('height') || '0') };
            if (Number.isFinite(b.w) && Number.isFinite(b.h) && b.w > 0 && b.h > 0) return shift(b);
        } else if (tag === 'circle') {
            const r = parseFloat(child.getAttribute('r') || '0');
            const cx = parseFloat(child.getAttribute('cx') || '0'), cy = parseFloat(child.getAttribute('cy') || '0');
            if (r > 0) return shift({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r });
        } else if (tag === 'polygon' || tag === 'path') {
            const src = child.getAttribute(tag === 'polygon' ? 'points' : 'd') || '';
            const nums = (src.match(NUMBERS_RE) || []).map(Number).filter(Number.isFinite);
            if (nums.length >= 4) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (let i = 0; i + 1 < nums.length; i += 2) {
                    minX = Math.min(minX, nums[i]); maxX = Math.max(maxX, nums[i]);
                    minY = Math.min(minY, nums[i + 1]); maxY = Math.max(maxY, nums[i + 1]);
                }
                if (maxX > minX && maxY > minY) return shift({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
            }
        }
    }
    const o = globalOrigin(el);
    return o ? { x: o[0], y: o[1], w: 0, h: 0 } : null;
}

/** Distance from a point to a box's edge, 0 inside it. */
function boxDistance(p: Point, b: Box): number {
    const dx = Math.max(b.x - p[0], 0, p[0] - (b.x + b.w));
    const dy = Math.max(b.y - p[1], 0, p[1] - (b.y + b.h));
    return Math.hypot(dx, dy);
}

/** An edge endpoint lands on the box it touches; a marker leaves it about this far short. */
const EDGE_SNAP = 14;

/**
 * Which box an edge endpoint belongs to: the nearest NODE within reach, and
 * only when no node is, the nearest cluster. An edge's end sits inside the
 * cluster around its node as well as a few units short of the node itself
 * (the arrowhead), so "nearest of all" handed every edge inside a subgraph to
 * the subgraph.
 */
function boxAt(p: Point, boxes: { box: Box; index: number; cluster: boolean }[]): number {
    for (const clusters of [false, true]) {
        let best = -1, bestDist = Infinity, bestArea = Infinity;
        for (const { box, index, cluster } of boxes) {
            if (cluster !== clusters) continue;
            const d = boxDistance(p, box);
            if (d > EDGE_SNAP) continue;
            const area = box.w * box.h;
            if (d < bestDist - 1e-6 || (Math.abs(d - bestDist) <= 1e-6 && area < bestArea)) {
                best = index; bestDist = d; bestArea = area;
            }
        }
        if (best >= 0) return best;
    }
    return -1;
}

/** The "L_A_B_0" tail of a mermaid edge id, which its label carries as data-id. */
function edgeKey(el: Element): string {
    const id = el.id || '';
    const m = /(L_.+|edge\d*(?:_\d+)*)$/.exec(id);
    return m ? m[1] : id;
}

/**
 * A mermaid diagram arrives in the ORDER IT IS READ, which for a diagram with
 * arrows is the order the arrows give: a box, then the arrow out of it, then
 * the box that arrow points at. Positional reading order (rank axis first, then
 * along it) is the fallback for a diagram whose arrows say nothing — and the
 * tie-break among boxes the arrows leave unordered, so siblings still arrive
 * left to right. The order is a topological walk (Kahn) over the boxes, edges
 * matched to boxes by where their ends land; a cycle is broken by taking the
 * earliest-placed box left. A cluster arrives just before its first member
 * (it is the container); an edge arrives just before the box it points at,
 * with its label; edges the walk could not place come last, in reading order.
 *
 * A mindmap says its structure outright — `edge_0_5` joins `node_0` to
 * `node_5` — so its branches grow from the root by id, no geometry needed.
 */
function planMermaid(el: Element): Step[] {
    const all = Array.from(el.querySelectorAll<SVGElement>(MERMAID_PARTS));
    // Only top-level parts: a `.label` inside an edge label, or a node inside
    // a cluster in some diagram kinds, arrives with its parent. An edge label
    // group mermaid writes for an UNLABELLED edge — one per edge, empty — is
    // not a part at all: stamped, it spent a step of the budget on nothing.
    const parts = all.filter(p => !p.parentElement?.closest(MERMAID_PARTS))
        .filter(p => !p.classList.contains('edgeLabel') || (p.textContent || '').trim().length > 0);
    if (parts.length === 0) return [];

    const isEdge = (p: Element) => {
        const tag = p.tagName.toLowerCase();
        return (tag === 'path' || tag === 'line') && !p.classList.contains('node') && !p.classList.contains('cluster');
    };
    const isLabel = (p: Element) => p.classList.contains('edgeLabel');
    const boxesEls = parts.filter(p => !isEdge(p) && !isLabel(p));
    const edgeEls = parts.filter(isEdge);
    const labelEls = parts.filter(isLabel);

    const stepFor = (p: Element): Step => ({
        el: p, origin: globalOrigin(p),
        draw: isEdge(p) && hasSolidStroke(p) ? ARRIVAL_EDGE_MS : false,
    });

    // Match every edge to its two boxes — by id for a mindmap, by geometry
    // for the rest. `from`/`to` are indices into boxesEls, -1 when unmatched.
    const boxes = boxesEls
        .map((b, index) => ({ box: partBox(b), index, cluster: b.classList.contains('cluster') }))
        .filter((x): x is { box: Box; index: number; cluster: boolean } => !!x.box);
    const idIndex = new Map<string, number>();
    boxesEls.forEach((b, i) => { const m = /(node_\d+)$/.exec(b.id || ''); if (m) idIndex.set(m[1], i); });
    const edges = edgeEls.map(e => {
        const mind = /edge_(\d+)_(\d+)$/.exec(e.id || '');
        if (mind && idIndex.has(`node_${mind[1]}`) && idIndex.has(`node_${mind[2]}`)) {
            return { el: e, from: idIndex.get(`node_${mind[1]}`)!, to: idIndex.get(`node_${mind[2]}`)! };
        }
        const [ox, oy] = globalOffset(e);
        const ends = e.tagName.toLowerCase() === 'line'
            ? (() => {
                const a = finitePoint(e.getAttribute('x1'), e.getAttribute('y1'));
                const b = finitePoint(e.getAttribute('x2'), e.getAttribute('y2'));
                return a && b ? [a, b] as [Point, Point] : null;
            })()
            : pathEnds(e);
        if (!ends) return { el: e, from: -1, to: -1 };
        const a: Point = [ends[0][0] + ox, ends[0][1] + oy];
        const b: Point = [ends[1][0] + ox, ends[1][1] + oy];
        return { el: e, from: boxAt(a, boxes), to: boxAt(b, boxes) };
    });
    // A label belongs to the edge whose id its `data-id` names (mermaid 11
    // writes one on the inner `.label`); failing that, to the edge whose
    // midpoint it sits on.
    const labelOf = new Map<Element, Element>();
    const midpoint = (e: Element): Point | null => {
        const ends = pathEnds(e);
        if (!ends) return null;
        const [ox, oy] = globalOffset(e);
        return [(ends[0][0] + ends[1][0]) / 2 + ox, (ends[0][1] + ends[1][1]) / 2 + oy];
    };
    for (const l of labelEls) {
        const key = l.querySelector('[data-id]')?.getAttribute('data-id') || '';
        let edge = key ? edgeEls.find(e => edgeKey(e) === key) : undefined;
        if (!edge) {
            const at = globalOrigin(l);
            let bestDist = 80;
            if (at) for (const e of edgeEls) {
                if (labelOf.has(e)) continue;
                const m = midpoint(e);
                const d = m ? Math.hypot(m[0] - at[0], m[1] - at[1]) : Infinity;
                if (d < bestDist) { bestDist = d; edge = e; }
            }
        }
        if (edge && !labelOf.has(edge)) labelOf.set(edge, l);
    }

    // The positional reading order, the tie-break for everything the arrows
    // leave open (and the whole order when there are no arrows).
    const origins = boxesEls.map(globalOrigin);
    const edgeVectors = edges
        .filter(e => e.from >= 0 && e.to >= 0 && e.from !== e.to)
        .map(e => [origins[e.from], origins[e.to]] as [Point | null, Point | null])
        .filter((v): v is [Point, Point] => !!v[0] && !!v[1]);
    const lr = isLeftToRight(origins.filter((p): p is Point => !!p), edgeVectors);
    const rankOf = readingOrder(boxesEls.map((_b, i) => ({ origin: origins[i], item: i })), lr);
    const rank = new Map<number, number>();
    rankOf.forEach((i, r) => rank.set(i, r));

    // Kahn's walk over the boxes, sources first, ties by reading rank.
    const indeg = new Array(boxesEls.length).fill(0);
    const out: number[][] = boxesEls.map(() => []);
    const inc: { edge: typeof edges[number]; from: number }[][] = boxesEls.map(() => []);
    for (const e of edges) {
        if (e.from < 0 || e.to < 0 || e.from === e.to) continue;
        indeg[e.to]++;
        out[e.from].push(e.to);
        inc[e.to].push({ edge: e, from: e.from });
    }
    const contains = (outer: Box, inner: Box) =>
        outer.w * outer.h > inner.w * inner.h
        && inner.x >= outer.x - 1 && inner.y >= outer.y - 1
        && inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1;
    const boxOf = new Map<number, Box>(boxes.map(b => [b.index, b.box]));
    const clusterOf = (i: number): number => {
        const b = boxOf.get(i);
        if (!b) return -1;
        let best = -1, bestArea = Infinity;
        for (const c of boxes) {
            if (c.index === i || !c.cluster) continue;
            const area = c.box.w * c.box.h;
            if (contains(c.box, b) && area < bestArea) { best = c.index; bestArea = area; }
        }
        return best;
    };
    // A cluster is a dependency of everything inside it: a member is not
    // ready until its container has arrived, and the container is not ready
    // until the arrow pointing at it has — so "the arrow into the box, the
    // box, then what is in the box" falls out of the same walk.
    boxesEls.forEach((_, i) => {
        const c = clusterOf(i);
        if (c >= 0) { indeg[i]++; out[c].push(i); }
    });

    const steps: Step[] = [];
    const placed = new Set<number>();
    const placedEdges = new Set<Element>();
    const place = (i: number) => {
        if (placed.has(i)) return;
        placed.add(i);
        // Its incoming arrows first, from the sources already on screen, in
        // the order those arrived — each with its label, then the box.
        const incoming = inc[i].filter(x => placed.has(x.from)).sort((a, b) => (rank.get(a.from) ?? 0) - (rank.get(b.from) ?? 0));
        for (const { edge } of incoming) {
            placedEdges.add(edge.el);
            const s = stepFor(edge.el);
            const label = labelOf.get(edge.el);
            // The edge, then its label, then the box it points at. The wait
            // after the edge is the edge's own draw (`gapAfter`), so the label
            // and the arrowhead land together and the box follows them.
            steps.push(s);
            if (label) steps.push(stepFor(label));
        }
        steps.push(stepFor(boxesEls[i]));
    };
    const remaining = new Set(boxesEls.map((_, i) => i));
    const ready = () => [...remaining].filter(i => indeg[i] === 0).sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    while (remaining.size) {
        let next = ready();
        // A cycle (or a cluster pointed at from inside itself): break it at the
        // earliest-placed box left.
        if (next.length === 0) next = [[...remaining].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))[0]];
        const i = next[0];
        remaining.delete(i);
        place(i);
        for (const t of out[i]) indeg[t]--;
    }
    // Whatever the walk could not attach — an unmatched edge, a self-loop, a
    // back-edge of a broken cycle — and any label without an edge, in reading
    // order after everything else.
    const rest = [
        ...edgeEls.filter(e => !placedEdges.has(e)),
        ...labelEls.filter(l => ![...labelOf.values()].includes(l)),
    ];
    for (const p of readingOrder(rest.map(r => ({ origin: globalOrigin(r), item: r })), lr)) {
        steps.push(stepFor(p));
        const label = labelOf.get(p);
        if (label) steps.push(stepFor(label));
    }
    return steps;
}

/* ── vega / vega-lite ─────────────────────────────────────────────────── */

/**
 * A chart reads frame first, data second, key last: the title and every axis
 * (each as one piece — ticks, labels and grid together), then the marks left
 * to right (bars, points, rules, labels fade; a line draws itself), then the
 * legend. The hoisted title (chartTitle.ts puts it in a <figcaption> above
 * the svg) is the very first thing.
 */
function planVega(el: Element): Step[] {
    const steps: Step[] = [];
    const fade = (n: Element | null) => { if (n) steps.push({ el: n, origin: partOrigin(n), draw: false }); };
    fade(el.querySelector('figcaption'));
    const svg = el.querySelector('svg.marks');
    if (!svg) return steps;
    // The frame the chart is drawn in (`<path class="background">`, vega's own
    // border round the plotting area). Unstamped it was simply THERE from the
    // first frame while everything inside it arrived — an empty box with a
    // chart appearing in it, which in the settings gallery (where the sample
    // dissolves first) left a bare rectangle sitting alone on the card.
    //
    // The ROOT group's one, explicitly: vega gives every group mark a
    // background path, and `querySelectorAll('path.background')` found
    // seventeen — one per axis and per mark group — which took seventeen steps
    // of the budget at the FRONT of the plan and pushed the axes themselves out
    // to 1.3s, arriving long after the bars they are supposed to measure.
    fade(svg.querySelector('.role-frame.root > g > path.background'));
    svg.querySelectorAll('.role-title').forEach(fade);
    svg.querySelectorAll('.role-axis').forEach(fade);
    const marks: Step[] = [];
    svg.querySelectorAll('.role-mark').forEach(group => {
        // A mark inside an axis or legend belongs to that piece.
        if (group.parentElement?.closest('.role-axis, .role-legend, .role-title')) return;
        // A line series draws itself over the curve's time; a rule (an
        // energy level, a reference line) over a bond's — short and drawn.
        const drawMs = group.classList.contains('mark-line') ? ARRIVAL_CURVE_MS
            : group.classList.contains('mark-rule') ? ARRIVAL_BOND_MS : 0;
        Array.from(group.children).forEach(child => {
            if (child.tagName.toLowerCase() === 'title') return;
            marks.push({
                el: child, origin: partOrigin(child),
                draw: drawMs && hasSolidStroke(child) ? drawMs : false,
            });
        });
    });
    steps.push(...leftToRight(marks));
    svg.querySelectorAll('.role-legend').forEach(legend => {
        if (!legend.parentElement?.closest('.role-legend')) fade(legend);
    });
    return steps;
}

/* ── function-plot ────────────────────────────────────────────────────── */

/** Axes and the origin lines first, then each curve draws itself, the legend last. */
function planPlot(el: Element): Step[] {
    const steps: Step[] = [];
    const fade = (n: Element) => steps.push({ el: n, origin: partOrigin(n), draw: false });
    const cap = el.querySelector('figcaption');
    if (cap) fade(cap);
    const svg = el.querySelector('svg.function-plot');
    if (!svg) return steps;
    svg.querySelectorAll('g.axis, text.axis-label, .origin').forEach(fade);
    svg.querySelectorAll('.content .graph').forEach(graph => {
        Array.from(graph.querySelectorAll('path, polygon, circle')).forEach(shape => {
            const draw = shape.tagName.toLowerCase() === 'path' && hasSolidStroke(shape) ? ARRIVAL_CURVE_MS : false;
            steps.push({ el: shape, origin: partOrigin(shape), draw });
        });
    });
    svg.querySelectorAll('.top-right-legend').forEach(fade);
    return steps;
}

/* ── smiles (a molecule) ──────────────────────────────────────────────── */

/**
 * THE MOLECULE GROWS FROM ONE ATOM, AND EACH ATOM'S LABEL ARRIVES WITH THE
 * BOND THAT REACHES IT.
 *
 * A breadth-first walk from the leftmost atom over the molecule's graph
 * (`renderSmiles.ts` leaves it on the svg as `data-vb-molecule`): a bond starts
 * once its first atom has arrived and draws TOWARD the next (`back` when that
 * runs against the line's x1→x2). A label starts `LABEL_LEAD` before its bond
 * lands, because the drawer masks each bond out of a circle round the label, so
 * the stroke's last stretch is invisible. A ring closes where its halves meet,
 * an aromatic circle draws once its last bond is in, and separate fragments (a
 * salt's ions) follow one another left to right.
 *
 * Whatever the graph cannot place (a shape near no bond, a label over no atom,
 * an svg with no graph) arrives last in reading order. Nothing may be left
 * unstamped: an unstamped part is visible from the first frame.
 */
export const MOLECULE_ATTR = 'data-vb-molecule';

/** The drawn molecule: atom positions (null = not drawn), bonds as atom pairs, rings as centre + members. */
export type MoleculeGraph = {
    v: ([number, number] | null)[];
    e: [number, number][];
    r: [number, number, number[]][];
};

/** How far before its bond lands an atom's label starts to fade in, as a share of the bond's draw. */
const LABEL_LEAD = 0.45;

function readMolecule(svg: Element): MoleculeGraph | null {
    try {
        const g = JSON.parse(svg.getAttribute(MOLECULE_ATTR) || 'null');
        return g && Array.isArray(g.v) && Array.isArray(g.e) && Array.isArray(g.r) ? g as MoleculeGraph : null;
    } catch { return null; }
}

/** An atom label's anchor: smiles-drawer positions its group with an inline CSS translate. */
function labelAt(holder: Element): Point | null {
    const style = holder.getAttribute('style') || '';
    const x = /translateX\(\s*([-+]?[\d.]+(?:e[-+]?\d+)?)px/i.exec(style);
    const y = /translateY\(\s*([-+]?[\d.]+(?:e[-+]?\d+)?)px/i.exec(style);
    if (x && y) return finitePoint(x[1], y[1]);
    return partOrigin(holder);
}

const num = (el: Element, name: string) => parseFloat(el.getAttribute(name) || 'NaN');

/** Distance from p to segment ab, and where along it (0 at a, 1 at b) the nearest point is. */
function toSegment(p: Point, a: Point, b: Point): { d: number; t: number } {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    return { d: Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t };
}

/** The shapes and labels of one molecule svg, outside <defs>/<mask>/<clipPath>. */
function moleculeParts(svg: Element): { shapes: Element[]; labels: Element[] } {
    const shapes = Array.from(svg.querySelectorAll('line, polygon, path, circle, ellipse'))
        .filter(s => !s.closest('defs, mask, clipPath'));
    const labels = Array.from(svg.querySelectorAll('.element')).map(t =>
        t.parentElement && t.parentElement.tagName.toLowerCase() === 'g' ? t.parentElement : t);
    return { shapes, labels };
}

/** A molecule's parts in reading order, one after another — the plan for an svg with no graph. */
function readInOrder(shapes: Element[], labels: Element[], from: number): Step[] {
    const bonds = leftToRight(shapes.map(s => ({
        el: s, origin: partOrigin(s),
        draw: s.tagName.toLowerCase() !== 'polygon' && hasSolidStroke(s) ? ARRIVAL_BOND_MS : false,
    })));
    const atoms = leftToRight(labels.map(l => ({ el: l, origin: labelAt(l), draw: false as const })));
    let t = from;
    return [...bonds, ...atoms].map(s => { const step = { ...s, at: t }; t += gapAfter(s); return step; });
}

/** One molecule grown from its graph, starting at `from`; returns its steps and when the last one lands. */
function growMolecule(svg: Element, g: MoleculeGraph, from: number): { steps: Step[]; end: number } {
    const { shapes, labels } = moleculeParts(svg);
    const pos = (i: number): Point | null => (g.v[i] ? [g.v[i]![0], g.v[i]![1]] : null);
    const edges = g.e.filter(([a, b]) => pos(a) && pos(b) && a !== b);
    const lengths = edges.map(([a, b]) => Math.hypot(pos(a)![0] - pos(b)![0], pos(a)![1] - pos(b)![1])).sort((x, y) => x - y);
    const bond = lengths.length ? lengths[lengths.length >> 1] : 30;
    const B = ARRIVAL_BOND_MS;

    const nearestAtom = (p: Point, reach: number): number => {
        let best = -1, bestD = reach;
        g.v.forEach((v, i) => {
            if (!v) return;
            const d = Math.hypot(v[0] - p[0], v[1] - p[1]);
            if (d < bestD) { bestD = d; best = i; }
        });
        return best;
    };
    const nearestEdge = (p: Point): { i: number; t: number } => {
        let best = -1, bestD = 0.45 * bond, bestT = 0;
        edges.forEach(([a, b], i) => {
            const { d, t } = toSegment(p, pos(a)!, pos(b)!);
            if (d < bestD) { bestD = d; best = i; bestT = t; }
        });
        return { i: best, t: bestT };
    };

    // What each shape belongs to. A bond's axis line (and the offset second
    // line of a double bond) draws along it; a hashed wedge's cross-strokes
    // fade in one after another along it; a solid wedge fades as the bond
    // starts. A stroked circle on a ring's centre is its aromatic ring; a
    // circle on an atom is that atom's dot.
    type Along = { el: Element; forward: boolean | null; t: number; draw: boolean };
    const onEdge: Along[][] = edges.map(() => []);
    const onAtom = new Map<number, Element[]>();
    const onRing = new Map<number, Element[]>();
    const loose: Element[] = [];
    const atAtom = (i: number, el: Element) => { const list = onAtom.get(i) || []; list.push(el); onAtom.set(i, list); };
    for (const s of shapes) {
        const tag = s.tagName.toLowerCase();
        if (tag === 'circle' || tag === 'ellipse') {
            const c: Point = [num(s, 'cx'), num(s, 'cy')];
            if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) { loose.push(s); continue; }
            let ring = -1, ringD = 0.5 * bond;
            g.r.forEach(([x, y], i) => { const d = Math.hypot(x - c[0], y - c[1]); if (d < ringD) { ringD = d; ring = i; } });
            if (ring >= 0) { const list = onRing.get(ring) || []; list.push(s); onRing.set(ring, list); continue; }
            const atom = nearestAtom(c, 0.3 * bond);
            if (atom >= 0) atAtom(atom, s); else loose.push(s);
            continue;
        }
        if (tag === 'line') {
            const p1: Point = [num(s, 'x1'), num(s, 'y1')], p2: Point = [num(s, 'x2'), num(s, 'y2')];
            if (![...p1, ...p2].every(Number.isFinite)) { loose.push(s); continue; }
            const { i, t } = nearestEdge([(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]);
            if (i < 0) { loose.push(s); continue; }
            const [a, b] = edges[i].map(pos) as [Point, Point];
            const ex = b[0] - a[0], ey = b[1] - a[1], lx = p2[0] - p1[0], ly = p2[1] - p1[1];
            const along = Math.abs(ex * lx + ey * ly) / ((Math.hypot(ex, ey) * Math.hypot(lx, ly)) || 1);
            if (along < 0.5) onEdge[i].push({ el: s, forward: null, t, draw: false });
            else onEdge[i].push({ el: s, forward: ex * lx + ey * ly >= 0, t: 0, draw: hasSolidStroke(s) });
            continue;
        }
        const o = tag === 'polygon'
            ? (() => {
                const n = (s.getAttribute('points') || '').match(NUMBERS_RE)?.map(Number).filter(Number.isFinite) || [];
                if (n.length < 2) return null;
                let x = 0, y = 0;
                for (let k = 0; k + 1 < n.length; k += 2) { x += n[k]; y += n[k + 1]; }
                return [x / (n.length >> 1), y / (n.length >> 1)] as Point;
            })()
            : partOrigin(s);
        const hit = o ? nearestEdge(o) : { i: -1, t: 0 };
        if (hit.i >= 0) onEdge[hit.i].push({ el: s, forward: null, t: 0, draw: false });
        else loose.push(s);
    }
    const looseLabels: Element[] = [];
    for (const l of labels) {
        const p = labelAt(l);
        const atom = p ? nearestAtom(p, 0.5 * bond) : -1;
        if (atom >= 0) atAtom(atom, l); else looseLabels.push(l);
    }

    // The walk. Fragments in reading order, each grown breadth-first from its
    // leftmost atom; an atom arrives when the first bond to reach it lands.
    const adj = new Map<number, number[]>();
    edges.forEach(([a, b], i) => {
        adj.set(a, [...(adj.get(a) || []), i]);
        adj.set(b, [...(adj.get(b) || []), i]);
    });
    const atoms = g.v.map((_, i) => i).filter(i => pos(i) && (adj.has(i) || onAtom.has(i)));
    const arrive = new Map<number, number>();
    const edgeStart: number[] = edges.map(() => NaN);
    const edgeFrom: number[] = edges.map(() => -1);
    const roots = new Set<number>();
    let t0 = from;
    const byReading = (x: number, y: number) => (pos(x)![0] - pos(y)![0]) || (pos(x)![1] - pos(y)![1]);
    for (const root of [...atoms].sort(byReading)) {
        if (arrive.has(root)) continue;
        roots.add(root);
        arrive.set(root, t0);
        let end = t0 + (onAtom.has(root) ? ARRIVAL_STEP_MS : 0);
        const queue = [root];
        while (queue.length) {
            const u = queue.shift()!;
            const out = (adj.get(u) || []).filter(i => Number.isNaN(edgeStart[i]));
            // Siblings leave in reading order so a tie in time is still stable.
            out.sort((i, j) => byReading(edges[i][0] === u ? edges[i][1] : edges[i][0], edges[j][0] === u ? edges[j][1] : edges[j][0]));
            for (const i of out) {
                const w = edges[i][0] === u ? edges[i][1] : edges[i][0];
                edgeStart[i] = arrive.get(u)!;
                edgeFrom[i] = u;
                end = Math.max(end, edgeStart[i] + B);
                if (!arrive.has(w)) { arrive.set(w, edgeStart[i] + B); queue.push(w); }
            }
        }
        t0 = end;
    }

    const steps: Step[] = [];
    for (const [atom, parts] of onAtom) {
        const t = arrive.get(atom);
        if (t === undefined) { looseLabels.push(...parts); continue; }
        // A fragment's first atom is where the drawing starts, so its label is
        // there from the start; every other one leads its bond's landing.
        const at = roots.has(atom) ? t : t - LABEL_LEAD * B;
        for (const p of parts) steps.push({ el: p, origin: labelAt(p), draw: false, at });
    }
    edges.forEach(([a], i) => {
        const start = edgeStart[i];
        for (const s of onEdge[i]) {
            if (s.forward === null) {
                // A cross-stroke of a hashed wedge, or a solid wedge: fades in
                // where the growth has reached along the bond.
                const t = edgeFrom[i] === a ? s.t : 1 - s.t;
                steps.push({ el: s.el, origin: partOrigin(s.el), draw: false, at: start + t * B });
            } else {
                steps.push({
                    el: s.el, origin: partOrigin(s.el), at: start,
                    draw: s.draw ? B : false,
                    back: s.draw && (edgeFrom[i] === a) !== s.forward,
                });
            }
        }
    });
    let end = t0;
    for (const [ring, circles] of onRing) {
        const members = new Set(g.r[ring][2]);
        const closes = edges.reduce((m, [a, b], i) => (members.has(a) && members.has(b) ? Math.max(m, edgeStart[i] + B) : m), from);
        for (const c of circles) {
            steps.push({ el: c, origin: partOrigin(c), draw: hasSolidStroke(c) ? B : false, at: closes });
            end = Math.max(end, closes + B);
        }
    }
    const rest = readInOrder(loose, looseLabels, end);
    if (rest.length) end = rest[rest.length - 1].at! + gapAfter(rest[rest.length - 1]);
    return { steps: [...steps, ...rest], end };
}

function planSmiles(el: Element): Step[] {
    const steps: Step[] = [];
    let t = 0;
    el.querySelectorAll('svg').forEach(svg => {
        const graph = readMolecule(svg);
        if (graph) {
            const grown = growMolecule(svg, graph, t);
            steps.push(...grown.steps);
            t = grown.end;
        } else {
            const { shapes, labels } = moleculeParts(svg);
            const read = readInOrder(shapes, labels, t);
            steps.push(...read);
            if (read.length) t = read[read.length - 1].at! + gapAfter(read[read.length - 1]);
        }
    });
    return steps;
}

/* ── the stamp ────────────────────────────────────────────────────────── */

/** The keyframes a drawn stroke runs (index.css) — forward, or from its end.
 *  A part that draws runs two animations and only one of these ending means
 *  the line has reached its end. */
const DRAW_KEYFRAMES = new Set(['vb-edge-draw', 'vb-edge-draw-back']);

/**
 * Switch a path's arrowheads off for the length of its draw, and back on the
 * moment the line reaches them.
 *
 * Inline, because mermaid writes `marker-end` as an ATTRIBUTE and only an
 * inline style out-ranks that. `{ once: true }` so nothing has to be cleaned
 * up: the listener either fires or dies with the node. A path with no marker
 * pays nothing.
 */
function hideMarkersWhileDrawing(p: HTMLElement): void {
    const has = ['marker-start', 'marker-mid', 'marker-end'].filter(
        m => (p.getAttribute(m) || p.style.getPropertyValue(m) || 'none') !== 'none',
    );
    if (has.length === 0) return;
    for (const m of has) p.style.setProperty(m, 'none');
    p.addEventListener('animationend', function show(e) {
        if (!DRAW_KEYFRAMES.has((e as AnimationEvent).animationName)) return;
        p.removeEventListener('animationend', show);
        for (const m of has) p.style.removeProperty(m);
    });
}

/**
 * Take the arrival timing off again once it has played. The inline dash the
 * draw needs (see below) would otherwise stay on every stroke for the life of
 * the render — harmless with pathLength="1", but a render should end in the
 * state its library drew it in.
 */
export function settleArrival(el: HTMLElement): void {
    el.querySelectorAll<SVGElement | HTMLElement>(`[${ATTR}]`).forEach(settleArrivalPart);
}

/**
 * The same, for ONE part: how a caller takes a piece back out of the plan it
 * just stamped. The settings gallery does that to a chart's bars, which it
 * animates itself (settings/sampleReveal.ts) — fading them in and then moving
 * them is two arrivals for the same objects.
 */
export function settleArrivalPart(p: SVGElement | HTMLElement): void {
    p.removeAttribute(ATTR);
    p.removeAttribute('pathLength');
    // The `animationend` above normally does this; a part settled early — the
    // gallery takes a chart's bars back out of the plan — never fires one.
    p.style.removeProperty('marker-start');
    p.style.removeProperty('marker-mid');
    p.style.removeProperty('marker-end');
    p.style.removeProperty('animation-delay');
    p.style.removeProperty('animation-duration');
    p.style.removeProperty('stroke-dasharray');
    p.style.removeProperty(OWN_OPACITY);
}

/**
 * A part FADES TO ITS OWN OPACITY, and this is how the keyframe is told what
 * that is (index.css: `to { opacity: var(--vb-op, 1) }`).
 *
 * A fade to 1 is only right for a part that is opaque to begin with. A
 * function graph's origin lines are `<path class="y origin" opacity="0.2">` —
 * faint on purpose, because they are behind the curve — and animating their
 * opacity to 1 painted them five times brighter for the length of the arrival
 * and then dropped them back: "the middle axis is brighter, and then changes
 * colour", which is what it looks like from the outside. Gridlines (0.1),
 * vega's own faded marks and anything else a library draws pale have the same
 * shape of bug waiting in them.
 *
 * Read from the attribute and the inline style only — the two places the
 * libraries in this app write it — and never from `getComputedStyle`, which
 * would report the ANIMATED value on a replay and bake the fade's own progress
 * into the next one.
 */
const OWN_OPACITY = '--vb-op';
function stampOwnOpacity(p: SVGElement | HTMLElement): void {
    const raw = p.style.opacity || p.getAttribute('opacity');
    const own = raw == null ? NaN : parseFloat(raw);
    if (Number.isFinite(own) && own >= 0 && own < 1) p.style.setProperty(OWN_OPACITY, String(own));
    else p.style.removeProperty(OWN_OPACITY);
}

/** Which kind's reading of "part" applies, from the kind or, failing that, from the DOM. */
function planFor(el: HTMLElement, kind?: string): Step[] {
    switch (kind) {
        case 'mermaid': return planMermaid(el);
        case 'vega': return planVega(el);
        case 'plot': return planPlot(el);
        case 'smiles': return planSmiles(el);
        case 'animation': case 'p5': case 'widget': case 'math': case 'drill': return [];
    }
    if (el.querySelector('svg.marks')) return planVega(el);
    if (el.querySelector('svg.function-plot')) return planPlot(el);
    return planMermaid(el);
}

/** The gap between one part and the next, for this many parts that all fade. */
export function arrivalStep(count: number): number {
    return ARRIVAL_STEP_MS * arrivalScale(Math.max(0, count - 1) * ARRIVAL_STEP_MS);
}

/**
 * ONE FACTOR FOR THE WHOLE ARRIVAL, from what the gaps add up to.
 *
 * Everything the stagger is made of is a duration now — a plain gap, an edge's
 * draw, the gap that draw buys — so keeping inside the budget is one
 * multiplier applied to all of them together. Scaling the gaps alone would
 * leave each line still taking its full 560ms to reach an arrowhead the next
 * box no longer waits for, which is the bug this replaced.
 *
 * The floor is expressed as a floor on the FACTOR (`ARRIVAL_MIN_STEP_MS` over
 * the plain step) for the same reason: past it a fifty-part diagram overruns
 * the budget rather than dissolving into one frame.
 */
export function arrivalScale(totalGapMs: number): number {
    if (totalGapMs <= 0) return 1;
    return Math.max(ARRIVAL_MIN_STEP_MS / ARRIVAL_STEP_MS, Math.min(1, ARRIVAL_BUDGET_MS / totalGapMs));
}

/**
 * Stamp every part of a visual with when it arrives, in reading order, and
 * return how long the whole arrival takes in ms (0 when there is nothing to
 * stagger — an animation with its own clock, a formula). Idempotent: a
 * re-render is a fresh DOM.
 */
export function stampArrivalOrder(el: HTMLElement, kind?: string): number {
    const steps = planFor(el, kind);
    if (steps.length === 0) return 0;
    // Reduced motion: index.css turns the fades off; the draw is set up
    // inline below (it has to out-rank the library's own stylesheet), so it
    // is not set up at all.
    let reducedMotion = false;
    try { reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* no matchMedia */ }

    // Every gap is a TIME: a plain one is the step, and the one after a part
    // that draws itself is that part's whole draw, so the next thing starts on
    // the frame the stroke lands and the arrowhead comes back. Summed first,
    // then one factor puts the lot inside the budget — the draws with them.
    // A plan that times itself (`at` on every step) is scaled the same way:
    // what has to fit the budget is when the last part STARTS.
    const timed = steps.every(s => s.at !== undefined);
    const before: number[] = [];
    let total = 0;
    if (timed) steps.forEach(s => { before.push(s.at!); total = Math.max(total, s.at!); });
    else steps.forEach((s, i) => { before.push(total); if (i < steps.length - 1) total += gapAfter(s); });
    const scale = arrivalScale(total);
    let longest = ARRIVAL_PART_MS;
    let lastDelay = ARRIVAL_LEAD_MS;
    steps.forEach((s, i) => {
        const p = s.el as HTMLElement;
        const delay = ARRIVAL_LEAD_MS + Math.round(before[i] * scale);
        lastDelay = Math.max(lastDelay, delay);
        // The draw is scaled with the gap it buys, or the line would still be
        // travelling when the box it points at turns up.
        const draw = !reducedMotion && s.draw && Math.round(s.draw * scale);
        p.setAttribute(ATTR, draw ? (s.back ? 'draw-back' : 'draw') : 'part');
        p.style.animationDelay = `${delay}ms`;
        stampOwnOpacity(p);
        if (draw) {
            hideMarkersWhileDrawing(p);
            // Normalise the stroke so the dash arithmetic is 1 for every one,
            // and set the dash INLINE: mermaid's stylesheet is scoped by the
            // svg's id (`#id .edge-pattern-solid { stroke-dasharray: 0 }`) and
            // vega/plot write theirs as attributes — both out-rank any class
            // selector index.css could write. The keyframe animating the
            // offset sits above all of them in the cascade.
            p.setAttribute('pathLength', '1');
            p.style.strokeDasharray = '1';
            p.style.animationDuration = `${ARRIVAL_PART_MS}ms, ${draw}ms`;
            longest = Math.max(longest, draw);
        } else {
            p.style.animationDuration = `${ARRIVAL_PART_MS}ms`;
        }
    });
    return lastDelay + longest;
}

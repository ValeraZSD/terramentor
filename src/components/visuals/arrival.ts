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
 *  - the timing lives HERE, written inline on each part, so the shell can be
 *    told exactly how long the whole arrival takes and keep the class on
 *    until it is over. With the numbers in CSS the shell guessed 1400ms, and
 *    on a diagram with more than ~20 parts the class came off first — the
 *    tail of the diagram popped in.
 *
 * Each visual kind has its own reading of "part" (see `plan*` below): a
 * chart's axes come before its marks and its legend after them; a plot's
 * axes come before its curves; a molecule's bonds come before its atom
 * labels. Kinds that animate themselves (animation, p5, widget) get only the
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
 * How many plain steps the beat AFTER a drawn edge is worth. An arrow that
 * draws itself is the diagram saying "and then" — its target arriving one
 * ordinary step later, while the arrow is still a third of the way along,
 * reads as the box turning up before the arrow reaches it. Two steps keeps
 * the arrow visibly ahead of the box it points at; the budget still bounds
 * the whole stagger, so a big diagram shrinks every beat together.
 */
export const ARRIVAL_EDGE_BEAT = 2;

type Point = [number, number];
/**
 * One thing that arrives: what it is, where it is (global coordinates), if it
 * draws itself how long that takes, and how many plain steps to wait after it.
 */
type Step = { el: Element; origin: Point | null; draw: number | false; beat?: number };

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
            if (label) { steps.push({ ...s, beat: 1 }); steps.push(stepFor(label)); steps[steps.length - 1].beat = s.draw ? ARRIVAL_EDGE_BEAT : 1; }
            else steps.push({ ...s, beat: s.draw ? ARRIVAL_EDGE_BEAT : 1 });
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
        steps.push({ ...stepFor(p), beat: 1 });
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
 * Bonds draw themselves left to right across the molecule, then the atom
 * labels appear. smiles-drawer emits no classes on its groups: bonds are the
 * lines/polygons outside <defs> and <mask>, atoms are the `.element` texts.
 *
 * A `<circle>` is a bond too — it is the ring an AROMATIC ring is drawn with
 * (`r≈21`, stroked, unfilled). Left out of this query it was never stamped, so
 * it sat on the dissolved card at full strength from the first frame of the
 * arrival and the twelve lines drew themselves around it: benzene arrived as a
 * bare circle with a hexagon growing round it, which is the "jagged instant
 * glitchy thing". Same fault as vega's unstamped frame. `<ellipse>` for the
 * same reason, though no sample has produced one.
 */
function planSmiles(el: Element): Step[] {
    const bonds: Step[] = [];
    const atoms: Step[] = [];
    el.querySelectorAll('svg').forEach(svg => {
        svg.querySelectorAll('line, polygon, path, circle, ellipse').forEach(shape => {
            if (shape.closest('defs, mask, clipPath')) return;
            const draw = shape.tagName.toLowerCase() !== 'polygon' && hasSolidStroke(shape) ? ARRIVAL_BOND_MS : false;
            bonds.push({ el: shape, origin: partOrigin(shape), draw });
        });
        svg.querySelectorAll('.element').forEach(t => {
            const holder = t.parentElement && t.parentElement.tagName.toLowerCase() === 'g' ? t.parentElement : t;
            atoms.push({ el: holder, origin: partOrigin(holder), draw: false });
        });
    });
    return [...leftToRight(bonds), ...leftToRight(atoms)];
}

/* ── the stamp ────────────────────────────────────────────────────────── */

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

/** The gap between one part and the next, for this many parts. */
export function arrivalStep(count: number): number {
    return arrivalStepForBeats(Math.max(0, count - 1));
}

/**
 * The plain step when the gaps between parts add up to this many beats (a
 * plain gap is one beat, the gap after a drawn edge `ARRIVAL_EDGE_BEAT`): the
 * full step while everything fits the budget, shrinking together past it,
 * never below the floor.
 */
export function arrivalStepForBeats(beats: number): number {
    if (beats <= 0) return ARRIVAL_STEP_MS;
    return Math.max(ARRIVAL_MIN_STEP_MS, Math.min(ARRIVAL_STEP_MS, ARRIVAL_BUDGET_MS / beats));
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

    // Gaps are weighted: the one after a drawn edge is longer, so the arrow
    // is visibly ahead of the box it points at. The weights are summed first
    // so the whole stagger, beats and all, still fits the budget.
    const beatsBefore: number[] = [];
    let beats = 0;
    steps.forEach((s, i) => { beatsBefore.push(beats); if (i < steps.length - 1) beats += s.beat ?? 1; });
    const step = arrivalStepForBeats(beats);
    let longest = ARRIVAL_PART_MS;
    let lastDelay = ARRIVAL_LEAD_MS;
    steps.forEach((s, i) => {
        const p = s.el as HTMLElement;
        const delay = ARRIVAL_LEAD_MS + Math.round(beatsBefore[i] * step);
        lastDelay = delay;
        const draw = !reducedMotion && s.draw;
        p.setAttribute(ATTR, draw ? 'draw' : 'part');
        p.style.animationDelay = `${delay}ms`;
        stampOwnOpacity(p);
        if (draw) {
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

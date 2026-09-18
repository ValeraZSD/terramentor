// tools/arrival-gates.mjs — how a diagram's parts are told when to arrive.
//
// Run:  node tools/arrival-gates.mjs
//
// Why this exists: the arrival stagger shipped with a bug worse than the pop it
// replaced. index.css animated `transform` on every stamped part, and a mermaid
// node is an SVG <g> positioned by its `transform` ATTRIBUTE — a CSS transform
// on an SVG element overrides that attribute, so every box sat at the origin
// for the whole animation and popped to its place when the class came off.
// Nothing threw. The selector list also named `.edgePath`, which mermaid 11
// no longer emits (flowchart edges are bare <path class="flowchart-link">), so
// the arrows never staggered at all.
//
// What is asserted here is the stamping (src/components/visuals/arrival.ts):
// that parts are ordered by where they are DRAWN rather than by document
// order, that an edge is marked to draw itself, that a dotted edge is not, that
// nothing but opacity/stroke timing is ever written, and that the duration the
// shell is told matches the last part's timing. The CSS half is asserted by
// reading index.css: no `transform` inside the part keyframe, ever again.
//
// jsdom + the shipped TypeScript bundled with esbuild — the same trick as the
// review-queue gates. No model, no server.

import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const cache = join(fileURLToPath(new URL('../node_modules/.cache', import.meta.url)));
mkdirSync(cache, { recursive: true });
const scratch = mkdtempSync(join(cache, 'arrival-gates-'));
const out = join(scratch, 'arrival.mjs');

await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/components/visuals/arrival.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

const {
    stampArrivalOrder, settleArrival, partOrigin, readingOrder, isLeftToRight, pathEnds, arrivalStep,
    ARRIVAL_LEAD_MS, ARRIVAL_STEP_MS, ARRIVAL_PART_MS, ARRIVAL_EDGE_MS, ARRIVAL_CURVE_MS, ARRIVAL_BOND_MS,
    ARRIVAL_BUDGET_MS, ARRIVAL_MIN_STEP_MS, ARRIVAL_EDGE_BEAT, globalOrigin, partBox,
} = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

/** A flowchart the way mermaid 11 writes one: edges first, then nodes, each node positioned by translate(). */
function flowchart(nodes, edges, { dotted = [] } = {}) {
    const edgeSvg = edges.map(([a, b], i) => {
        const from = nodes[a], to = nodes[b];
        const cls = dotted.includes(i) ? 'edge-pattern-dotted' : 'edge-pattern-solid';
        return `<path id="L_${a}_${b}" class="edge-thickness-normal ${cls} flowchart-link" d="M${from[1]},${from[2] + 20}L${to[1]},${to[2] - 20}"/>`;
    }).join('');
    const labelSvg = edges.map(([a, b]) => {
        const from = nodes[a], to = nodes[b];
        return `<g class="edgeLabel" transform="translate(${(from[1] + to[1]) / 2}, ${(from[2] + to[2]) / 2})"><g class="label"><foreignObject><div>yes</div></foreignObject></g></g>`;
    }).join('');
    const nodeSvg = nodes.map(([id, x, y]) =>
        `<g class="node default" id="flowchart-${id}-0" transform="translate(${x}, ${y})"><rect x="-40" y="-20" width="80" height="40"/><g class="label"><foreignObject><div>${id}</div></foreignObject></g></g>`,
    ).join('');
    const host = dom.window.document.createElement('div');
    host.innerHTML = `<svg viewBox="0 0 400 400"><g class="root"><g class="clusters"></g><g class="edgePaths">${edgeSvg}</g><g class="edgeLabels">${labelSvg}</g><g class="nodes">${nodeSvg}</g></g></svg>`;
    return host;
}

const stampedIn = (host) => Array.from(host.querySelectorAll('[data-vb-arrive]'));
const delayOf = (el) => parseFloat(el.style.animationDelay);

console.log('\n--- reading order beats document order ---');
{
    // A top-down chain with a sibling row: A over B and C, both to D.
    const nodes = [['A', 200, 40], ['B', 100, 140], ['C', 300, 140], ['D', 200, 240]];
    const edges = [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']].map(([a, b]) => [nodes.findIndex(n => n[0] === a), nodes.findIndex(n => n[0] === b)]);
    const host = flowchart(nodes, edges);
    const total = stampArrivalOrder(host);
    const parts = stampedIn(host).sort((p, q) => delayOf(p) - delayOf(q));
    const ids = parts.map(p => p.id || p.className.baseVal || p.getAttribute('class'));
    check('every node, edge and edge label is stamped', parts.length === 4 + 4 + 4, `${parts.length}`);
    check('the top node arrives first', ids[0] === 'flowchart-A-0', ids[0]);
    const idx = (id) => parts.findIndex(p => p.id === id);
    check('an edge arrives after its source and before its target',
        idx('flowchart-A-0') < idx('L_0_1') && idx('L_0_1') < idx('flowchart-B-0'));
    check('siblings on one rank arrive left to right', idx('flowchart-B-0') < idx('flowchart-C-0'));
    check('the bottom node arrives last', ids[ids.length - 1] === 'flowchart-D-0', ids[ids.length - 1]);
    check('the label inside an edge label is not stamped on its own', host.querySelectorAll('.edgeLabel .label[data-vb-arrive]').length === 0);
    check('delays are strictly increasing in that order',
        parts.every((p, i) => i === 0 || delayOf(p) > delayOf(parts[i - 1])));
    check('the first delay is the lead and the step is the step',
        delayOf(parts[0]) === ARRIVAL_LEAD_MS && delayOf(parts[1]) - delayOf(parts[0]) === ARRIVAL_STEP_MS);
    check('the shell is told when the LAST part has landed',
        total === Math.max(...parts.map(delayOf)) + Math.max(ARRIVAL_PART_MS, ARRIVAL_EDGE_MS), `${total}`);
    // The beat after a drawn edge is longer than a plain step, so the arrow is
    // visibly ahead of the box it points at.
    const gapAfterEdge = delayOf(parts[idx('L_0_1') + 1]) - delayOf(parts[idx('L_0_1')]);
    const gapAfterLabel = delayOf(parts[idx('L_0_1') + 2]) - delayOf(parts[idx('L_0_1') + 1]);
    check('an edge, then its label, then a longer beat before the target',
        gapAfterEdge === ARRIVAL_STEP_MS && gapAfterLabel === ARRIVAL_EDGE_BEAT * ARRIVAL_STEP_MS, `${gapAfterEdge} / ${gapAfterLabel}`);
}

console.log('\n--- a subgraph is written in its own coordinates ---');
{
    // mermaid 11: `flowchart LR` with a `direction TB` subgraph. The outer
    // chain sits at y=267; the subgraph is a nested g.root translated to
    // (990, 104) whose nodes are at x=164 in THEIR frame. Read raw, the inner
    // nodes sort before the outer chain; read globally — and along the
    // arrows — the chain comes first, then the arrow into the cluster, the
    // cluster, and its column top to bottom.
    const host = dom.window.document.createElement('div');
    host.innerHTML = `<svg viewBox="0 0 1318 894"><g><g class="root"><g class="clusters"></g><g class="edgePaths">
        <path id="L_A_B_0" class="edge-pattern-solid flowchart-link" d="M157,267L203,267"/>
        <path id="L_B_D_0" class="edge-pattern-solid flowchart-link" d="M393,267L692,267"/>
        <path id="L_D_E_0" class="edge-pattern-solid flowchart-link" d="M838,240L1048,35"/>
        <path id="L_D_L_0" class="edge-pattern-solid flowchart-link" d="M838,294L994,499"/>
      </g><g class="edgeLabels">
        <g class="edgeLabel"><g class="label" data-id="L_A_B_0" transform="translate(0, 0)"><foreignObject width="0" height="0"><div><span class="edgeLabel"></span></div></foreignObject></g></g>
        <g class="edgeLabel" transform="translate(180, 250)"><g class="label" data-id="L_B_D_0"><foreignObject><div><span class="edgeLabel">then</span></div></foreignObject></g></g>
      </g><g class="nodes">
        <g class="root" transform="translate(990.484375, 104)"><g class="clusters">
            <g class="cluster" id="L"><rect x="8" y="8" width="312" height="774"/><g class="cluster-label"><foreignObject><div>Inside</div></foreignObject></g></g>
          </g><g class="edgePaths">
            <path id="L_M_R1_0" class="edge-pattern-solid flowchart-link" d="M164,99.5L164,170.5"/>
            <path id="L_R1_N1_0" class="edge-pattern-solid flowchart-link" d="M164,228.5L164,299.5"/>
          </g><g class="edgeLabels"></g><g class="nodes">
            <g class="node default" id="flowchart-M-7" transform="translate(164, 72.5)"><rect class="basic label-container" x="-121" y="-27" width="242" height="54"/><g class="label"><foreignObject><div>M</div></foreignObject></g></g>
            <g class="node default" id="flowchart-R1-8" transform="translate(164, 201.5)"><rect class="basic label-container" x="-76" y="-27" width="152" height="54"/></g>
            <g class="node default" id="flowchart-N1-9" transform="translate(164, 330.5)"><rect class="basic label-container" x="-69" y="-27" width="138" height="54"/></g>
          </g></g>
        <g class="node default" id="flowchart-A-0" transform="translate(82.76, 267)"><rect class="basic label-container" x="-74.7" y="-27" width="149.5" height="54"/></g>
        <g class="node default" id="flowchart-B-1" transform="translate(300.7, 267)"><rect class="basic label-container" x="-93.2" y="-27" width="186.4" height="54"/></g>
        <g class="node default" id="flowchart-D-3" transform="translate(820.3, 267)"><rect class="basic label-container" x="-128.2" y="-27" width="256.3" height="54"/></g>
        <g class="node default" id="flowchart-E-4" transform="translate(1154.5, 35)"><rect class="basic label-container" x="-102" y="-27" width="204" height="54"/></g>
      </g></g></g></svg>`;
    check('a subgraph node is placed in the svg frame', JSON.stringify(globalOrigin(host.querySelector('#flowchart-M-7'))) === JSON.stringify([164 + 990.484375, 72.5 + 104]));
    const mb = partBox(host.querySelector('#flowchart-M-7'));
    check('…and so is its box', Math.round(mb.x) === Math.round(164 - 121 + 990.484375) && mb.w === 242 && mb.h === 54, JSON.stringify(mb));
    const cb = partBox(host.querySelector('#L'));
    check('a cluster box is its rect, shifted by the subgraph translate', Math.round(cb.x) === Math.round(8 + 990.484375) && cb.y === 8 + 104 && cb.w === 312, JSON.stringify(cb));
    stampArrivalOrder(host, 'mermaid');
    const parts = stampedIn(host).sort((p, q) => delayOf(p) - delayOf(q));
    const ids = parts.map(p => p.id || p.getAttribute('class').split(/\s+/)[0]);
    const at = (id) => ids.indexOf(id);
    check('the empty edge-label group of an unlabelled edge is not a part', parts.filter(p => p.classList.contains('edgeLabel')).length === 1, ids.join(' '));
    check('the outer chain arrives first, in arrow order', at('flowchart-A-0') < at('L_A_B_0') && at('L_A_B_0') < at('flowchart-B-1') && at('flowchart-B-1') < at('L_B_D_0') && at('L_B_D_0') < at('flowchart-D-3'), ids.join(' '));
    check('a labelled edge brings its label with it', at('L_B_D_0') + 1 === at('edgeLabel') && at('edgeLabel') < at('flowchart-D-3'), ids.join(' '));
    check('the chain end and the arrow into the cluster come after the stack', at('flowchart-D-3') < at('L_D_E_0') && at('flowchart-D-3') < at('L_D_L_0'), ids.join(' '));
    check('the cluster arrives before anything inside it', at('L') < at('flowchart-M-7') && at('L_D_L_0') < at('L'), ids.join(' '));
    check('the column inside the cluster arrives top to bottom along its arrows', at('flowchart-M-7') < at('L_M_R1_0') && at('L_M_R1_0') < at('flowchart-R1-8') && at('flowchart-R1-8') < at('L_R1_N1_0') && at('L_R1_N1_0') < at('flowchart-N1-9'), ids.join(' '));
    check('every part is stamped exactly once', parts.length === 4 + 1 + 1 + 2 + 3 + 4, `${parts.length}`);
}

console.log('\n--- a mindmap grows from its root, by id ---');
{
    const host = dom.window.document.createElement('div');
    host.innerHTML = `<svg><g class="edgePaths">
        <path id="edge_1_2" class="edge-pattern-solid edge section-edge-0" d="M214,352L349,366"/>
        <path id="edge_0_1" class="edge-pattern-solid edge section-edge-0" d="M194,242L199,351"/>
        <path id="edge_0_5" class="edge-pattern-solid edge section-edge-1" d="M193,212L194,104"/>
      </g><g class="nodes">
        <g class="node mindmap-node section-0" id="node_2" transform="translate(349, 366)"><path class="node-bkg" d="M-41 12v-24h83v24z"/></g>
        <g class="node mindmap-node section-0" id="node_1" transform="translate(199, 351)"><path class="node-bkg" d="M-52 12v-24h105v24z"/></g>
        <g class="node mindmap-node section-root" id="node_0" transform="translate(193, 227)"><circle class="basic" r="42"/></g>
        <g class="node mindmap-node section-1" id="node_5" transform="translate(194, 104)"><path class="node-bkg" d="M-33 12v-24h67v24z"/></g>
      </g></svg>`;
    stampArrivalOrder(host, 'mermaid');
    const ids = stampedIn(host).sort((p, q) => delayOf(p) - delayOf(q)).map(p => p.id);
    check('the root is first', ids[0] === 'node_0', ids.join(' '));
    check('a branch: its edge, then its node, before the next depth', ids.indexOf('edge_0_5') < ids.indexOf('node_5') && ids.indexOf('node_1') < ids.indexOf('edge_1_2') && ids.indexOf('edge_1_2') < ids.indexOf('node_2'), ids.join(' '));
    check('every edge and node is stamped', ids.length === 7, `${ids.length}`);
}

console.log('\n--- an edge draws itself; a dotted one only fades ---');
{
    const nodes = [['A', 200, 40], ['B', 200, 140], ['C', 200, 240]];
    const host = flowchart(nodes, [[0, 1], [1, 2]], { dotted: [1] });
    stampArrivalOrder(host);
    const solid = host.querySelector('#L_0_1');
    const dotted = host.querySelector('#L_1_2');
    check('a solid edge is marked to draw', solid.getAttribute('data-vb-arrive') === 'draw');
    check('…with pathLength="1" so the dash arithmetic is one', solid.getAttribute('pathLength') === '1');
    check('…and two durations, one per animation', solid.style.animationDuration === `${ARRIVAL_PART_MS}ms, ${ARRIVAL_EDGE_MS}ms`);
    check('a dotted edge keeps its own dash pattern (fade only)', dotted.getAttribute('data-vb-arrive') === 'part' && !dotted.hasAttribute('pathLength'));
    const node = host.querySelector('.node');
    check('a node is a plain part', node.getAttribute('data-vb-arrive') === 'part' && node.style.animationDuration === `${ARRIVAL_PART_MS}ms`);
}

console.log('\n--- nothing but timing is ever written ---');
{
    const nodes = [['A', 200, 40], ['B', 200, 140]];
    const host = flowchart(nodes, [[0, 1]]);
    const before = Array.from(host.querySelectorAll('*')).map(el => [el.getAttribute('transform'), el.getAttribute('d'), el.getAttribute('x'), el.getAttribute('y')].join('|'));
    stampArrivalOrder(host);
    const after = Array.from(host.querySelectorAll('*')).map(el => [el.getAttribute('transform'), el.getAttribute('d'), el.getAttribute('x'), el.getAttribute('y')].join('|'));
    check('no transform, d, x or y changed on any element', before.join('\n') === after.join('\n'));
    const styles = stampedIn(host).map(el => el.getAttribute('style'));
    check('the inline style carries only animation timing (and, on an edge, the dash the draw needs)',
        styles.every(s => s.split(';').map(x => x.trim()).filter(Boolean).every(decl => /^(animation-(delay|duration)|stroke-dasharray):/.test(decl))), styles.join(' / '));
    check('a node carries no dash', !/stroke-dasharray/.test(host.querySelector('.node').getAttribute('style')));
    check('an edge carries stroke-dasharray: 1 inline (mermaid scopes its own 0 by svg id)', /stroke-dasharray:\s*1/.test(host.querySelector('.flowchart-link').getAttribute('style')));
    settleArrival(host);
    check('settling takes every stamp, pathLength and inline timing off again',
        stampedIn(host).length === 0 && !host.querySelector('[pathLength]')
        && Array.from(host.querySelectorAll('*')).every(el => !(el.getAttribute('style') || '').trim()));
    const after2 = Array.from(host.querySelectorAll('*')).map(el => [el.getAttribute('transform'), el.getAttribute('d'), el.getAttribute('x'), el.getAttribute('y')].join('|'));
    check('…and still moved nothing', before.join('\n') === after2.join('\n'));
}

console.log('\n--- mermaid writes stroke-dasharray: 0 on a SOLID edge ---');
{
    const nodes = [['A', 200, 40], ['B', 200, 140]];
    const host = flowchart(nodes, [[0, 1]]);
    host.querySelector('.flowchart-link').setAttribute('stroke-dasharray', '0');
    stampArrivalOrder(host);
    check('"0" is solid — the edge still draws', host.querySelector('.flowchart-link').getAttribute('data-vb-arrive') === 'draw');
    const host2 = flowchart(nodes, [[0, 1]]);
    host2.querySelector('.flowchart-link').setAttribute('style', 'stroke-dasharray: 4 2');
    stampArrivalOrder(host2);
    check('an inline pattern of its own is kept — fade only', host2.querySelector('.flowchart-link').getAttribute('data-vb-arrive') === 'part');
}

console.log('\n--- the CSS half: parts never move ---');
{
    const css = readFileSync(fileURLToPath(new URL('../src/index.css', import.meta.url)), 'utf8');
    const part = /@keyframes vb-part-arrive\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    check('vb-part-arrive keyframe exists', part.length > 0);
    check('vb-part-arrive animates opacity only — no transform', !/transform/.test(part) && /opacity/.test(part));
    check('the stamp attribute is what the stylesheet keys on', /\[data-vb-arrive\]/.test(css) && /\[data-vb-arrive="draw"\]/.test(css));
    check('the old --vb-i hook is gone', !/--vb-i\b/.test(css));
    // A part the library drew PALE must fade to ITS OWN opacity. A function
    // graph's origin lines are `opacity="0.2"` — faint because they sit behind
    // the curve — and a fade to 1 painted them five times brighter for the
    // length of the arrival and then dropped them back, which from the outside
    // is an axis that gets bright and then changes colour.
    check('a part fades to its own opacity, not to 1', /opacity:\s*var\(--vb-op,\s*1\)/.test(part), part.trim().replace(/\s+/g, ' '));
    const pale = dom.window.document.createElement('div');
    pale.innerHTML = '<svg class="function-plot"><g class="canvas"><g class="x axis"/><g class="content"><path class="y origin" opacity="0.2" d="M5,0L5,9"/><g class="graph"><path d="M0,0L1,1L2,2"/></g></g></g></svg>';
    stampArrivalOrder(pale, 'plot');
    check('…and the stamp carries that opacity across', pale.querySelector('.origin').style.getPropertyValue('--vb-op') === '0.2', pale.querySelector('.origin').getAttribute('style'));
    check('an opaque part carries no such override', !pale.querySelector('.graph path').style.getPropertyValue('--vb-op'));
    settleArrival(pale);
    check('settling takes the override off again', !pale.querySelector('.origin').style.getPropertyValue('--vb-op'));
    const draw = /@keyframes vb-edge-draw\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    check('an edge draws by stroke-dashoffset 1 → 0', /stroke-dashoffset:\s*1/.test(draw) && /stroke-dashoffset:\s*0/.test(draw));
}

console.log('\n--- the gallery dissolve: one motion, not three ---');
{
    const css = readFileSync(fileURLToPath(new URL('../src/index.css', import.meta.url)), 'utf8');
    const panel = readFileSync(fileURLToPath(new URL('../src/components/settings/VisualKindsPanel.tsx', import.meta.url)), 'utf8');
    const p5 = readFileSync(fileURLToPath(new URL('../src/components/visuals/renderP5.ts', import.meta.url)), 'utf8');
    // A switched-off card is grey and dim; React drops that class on the same
    // commit that starts the dissolve. The dissolve must therefore start from
    // the MUTED look: `from { opacity: 1 }` would put the stage at FULL
    // brightness on the first frame with the un-mute transition running
    // grayscale 1 → 0 underneath the fade, so the sample pops, colours in and
    // disappears at once (measured over a real press:
    // 16ms op=1.000 grayscale(1), 148ms op=0.729 grayscale(0.41)).
    const dis = /@keyframes vk-dissolve\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    check('vk-dissolve starts from the MUTED look, not from opacity 1',
        /from\s*\{[^}]*opacity:\s*var\(--vk-mute-opacity/.test(dis), dis.trim().replace(/\s+/g, ' '));
    check('…and holds the grey all the way down, so nothing colours in while it fades',
        (dis.match(/filter:\s*var\(--vk-mute-filter/g) || []).length === 2, dis.trim().replace(/\s+/g, ' '));
    // The transition is started by the class change whatever the animation
    // does, and a running transition outranks an animation in the cascade.
    const rule = (sel) => new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css)?.[1] ?? '';
    check('the dissolve cancels the un-mute transition it starts alongside',
        /transition:\s*none/.test(rule('.visual-block-stage.vk-dissolve > *')), rule('.visual-block-stage.vk-dissolve > *').trim().replace(/\s+/g, ' '));
    check('…and so does the arrival, or the colour fades in behind the parts',
        /transition:\s*none/.test(rule('.visual-block-stage.vb-arrive.vk-flat > *')), rule('.visual-block-stage.vb-arrive.vk-flat > *').trim().replace(/\s+/g, ' '));
    // One declaration of the muted look, because the keyframe reads it.
    check('the muted look is declared once, as the two properties the keyframe reads',
        /--vk-mute-opacity:\s*[\d.]+/.test(css) && /--vk-mute-filter:\s*grayscale/.test(css));
    // THE STAGE PAINTS THE PAPER. Greying or fading the stage greys and fades
    // the paper, and the card behind it is a LIGHTER slate-800: measured on a
    // dark theme, the paper went #0f172a → #1a1f28 muted → #1b2432 mid-dissolve
    // → snap back. On white paper the same fault is invisible, which is how it
    // shipped. Only what is DRAWN may move.
    check('the muted look is applied to the content, never to the paper',
        /\.vk-sample\.vk-muted\s*>\s*\*/.test(css) && !/\.vk-sample\.vk-muted\s*\{/.test(css),
        (css.match(/\.vk-sample\.vk-muted[^{]*\{/g) || []).join(' '));
    check('…and so is the dissolve',
        /\.vk-dissolve\s*>\s*\*\s*\{[^}]*animation:\s*vk-dissolve/.test(css) && !/\.vk-dissolve\s*\{[^}]*animation:\s*vk-dissolve/.test(css),
        (css.match(/\.visual-block-stage\.vk-dissolve[^{]*\{/g) || []).join(' '));
    // NO SAMPLE PAINTS PAPER. A backdrop is remapped to the stage's colour, so
    // it hides in plain sight until the card is muted and `grayscale()` turns
    // it into a #121620 box on #0f172a paper — "anim bg is grey when off".
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(panel);
    check('the animation sample declares no backdrop of its own',
        !!viewBox && !new RegExp(`<rect[^>]*width="(${viewBox[1]}|100%)"`).test(panel),
        (panel.match(/<rect[^>]*>/) || ['no rect'])[0]);
    // NOR A COLOUR OF ITS OWN. A model's scene keeps the hue it chose — that is
    // `palette.ts`'s second rule, the red vector is not the blue one — but this
    // scene is the app describing itself in a grid where every other card draws
    // in the accent, and its projectile was `#dc2626`: the brightest thing in
    // Settings, reading as a warning rather than as the one thing that moves.
    // So the only colour it may NAME is the accent, and every literal left in
    // it has to be one `palette.ts` would treat as ink.
    const scene = /`<svg viewBox[\s\S]*?<\/svg>`/.exec(panel)?.[0] ?? '';
    const chroma = (hex) => {
        const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
        return Math.max(...c) - Math.min(...c);
    };
    const chromatic = (scene.match(/#[0-9a-f]{6}/gi) || []).filter(h => chroma(h) >= 0.16);
    check('the animation sample names one colour, the learner\'s accent', /\$\{accent\}/.test(scene));
    check('…and every literal left in it is ink, not a hue of its own',
        scene.length > 0 && chromatic.length === 0, chromatic.join(' '));
    // The sandbox is the one that cannot: an iframe never composites over its
    // parent (measured — a plain transparent one over #0f172a paints #ffffff),
    // so the sketch must paint a backdrop and a filter on the frame would take
    // it along. Both halves of that exception, or a switched-off simulation is
    // either a grey box (no exemption) or still in full colour (no setMuted).
    check('the frame is exempt from the grey',
        /\.vk-sample\.vk-muted\s*>\s*iframe\s*\{[^}]*filter:\s*none/.test(css));
    check('…because the sketch greys ITSELF instead',
        /function setMuted\(on\)/.test(panel) && /mutedMix/.test(panel));
    check('…and the sandbox has a doorbell for it that calls setMuted',
        /type === 'mute'[^\n]*window\.setMuted/.test(p5));
    // Comments out first: the line explaining why the Tailwind pair is gone
    // says both its names, and a scan that matches its own explanation is noise.
    const code = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('no sample hardcodes it in Tailwind instead',
        !/grayscale|opacity-50/.test(code), (code.match(/.*(grayscale|opacity-50).*/) || [''])[0].trim().slice(0, 120));

    // A simulation is not restarted and not redrawn — it is disturbed. The
    // first attempt disturbed it by WRITING POSITIONS (`b.p.add(…)`, 10–26px in
    // one frame) and velocities, which is a cut however smoothly the flock
    // recovers: "insta teleports the arrows to side now, wrong". A force is the
    // only disturbance that still looks like a flock, so the nudge may set a
    // counter and nothing else, and `draw` turns that into a steering force.
    // The widget's pointer is drawn INTO the card (absolute, in the stage's
    // coordinates) and aimed at the slider, so the two have to be measured in
    // one space. `offsetLeft`/`offsetTop` are not that space: they are relative
    // to the offset PARENT, and for the ~300ms the un-mute filter transition
    // above runs, the slider's own row IS one — a non-`none` filter makes an
    // element the containing block for its absolutely positioned descendants.
    // Measured over a real press: the hand spent the first third of a second
    // 110px too high and 20px too far right — a pointer in the top-right corner
    // of the card, on the frame the learner pressed the switch — and then
    // jumped 103px down to the slider when the filter finished.
    check('the pointer and the slider are measured in ONE space, by rect',
        !/track\.offset(Left|Top|Width|Height)/.test(code)
        && /trackBox\s*=\s*track\.getBoundingClientRect\(\)/.test(code)
        && /rootBox\s*=\s*root\.getBoundingClientRect\(\)/.test(code),
        (code.match(/.*track\.offset\w+.*/) || [''])[0].trim().slice(0, 120));

    const nudge = /function nudge\(\)\s*\{([^}]*)\}/.exec(code)?.[1] ?? 'no nudge() in the sample';
    check('nudge() moves nothing — it starts a force', !/\bp\.(add|set|x|y)\b|\bv\.(add|set)\b/.test(nudge), nudge.trim());
    check('…and the force is a steering rule like the other three, not a shove',
        /gather\s*>\s*0/.test(code) && /\.sub\(b\.v\)\.limit\(pull\)/.test(code));
}

console.log('\n--- geometry from attributes, no layout needed ---');
{
    const el = (html) => { const h = dom.window.document.createElement('div'); h.innerHTML = html; return h.firstElementChild; };
    check('a translated group', JSON.stringify(partOrigin(el('<g transform="translate(12.5, -7)"/>'))) === '[12.5,-7]');
    check('a path by its first point', JSON.stringify(partOrigin(el('<path d="M116,62L116,80C1,2 3,4 5,6"/>'))) === '[116,62]');
    check('a rect by x/y', JSON.stringify(partOrigin(el('<rect x="3" y="4" width="1" height="1"/>'))) === '[3,4]');
    check('a bare group by its first positioned child', JSON.stringify(partOrigin(el('<g><g><rect x="9" y="8"/></g></g>'))) === '[9,8]');
    check('nothing positioned answers null', partOrigin(el('<g><title>x</title></g>')) === null);
    check('a top-down diagram: one rank shares a y', isLeftToRight([[0, 0], [100, 0], [200, 0], [100, 100]]) === false);
    check('a left-right diagram: one rank shares an x', isLeftToRight([[0, 0], [0, 100], [0, 200], [100, 100]]) === true);
    check('a wide top-down diagram is still top-down (levels, not spread)', isLeftToRight([[0, 0], [300, 0], [600, 0], [300, 90]]) === false);
    // A diamond's nodes sit the same either way; only its edges say which way it reads.
    const diamond = [[200, 40], [100, 140], [300, 140], [200, 240]];
    check('a diamond read by its edges: vertical edges → top-down',
        isLeftToRight(diamond, [[[200, 60], [100, 120]], [[200, 60], [300, 120]], [[100, 160], [200, 220]], [[300, 160], [200, 220]]]) === false);
    check('…horizontal edges → left-right',
        isLeftToRight(diamond, [[[60, 200], [120, 100]], [[60, 200], [120, 300]], [[160, 100], [220, 200]], [[160, 300], [220, 200]]]) === true);
    check('both ends of a path come from its first and last pair', JSON.stringify(pathEnds(el('<path d="M116,62L116,80C120,90 130,95 140,100"/>'))) === '[[116,62],[140,100]]');
    check('a path with one point has no ends', pathEnds(el('<path d="M1,2"/>')) === null);
    const lr = readingOrder([{ origin: [200, 50], item: 'c' }, { origin: [0, 50], item: 'a' }, { origin: [100, 50], item: 'b' }, { origin: null, item: 'z' }], true);
    check('left-right reads along x, unplaced parts last', lr.join('') === 'abcz', lr.join(''));
    const td = readingOrder([{ origin: [50, 200], item: 'c' }, { origin: [50, 0], item: 'a' }, { origin: [50, 100], item: 'b' }], false);
    check('top-down reads along y', td.join('') === 'abc', td.join(''));
    const tie = readingOrder([{ origin: [0, 100], item: 'b' }, { origin: [0, 103], item: 'c' }, { origin: [-50, 101], item: 'a' }], false);
    check('a rank is 8 units wide — near-equal y is one rank, ordered by x', tie.join('') === 'abc', tie.join(''));
}

console.log('\n--- bounds: the step shrinks so the whole stagger fits the budget ---');
{
    check('a few parts take the full step', arrivalStep(5) === ARRIVAL_STEP_MS);
    check('many parts share the budget', Math.abs(arrivalStep(61) - ARRIVAL_BUDGET_MS / 60) < 1e-9);
    check('…down to the floor, never below', arrivalStep(1000) === ARRIVAL_MIN_STEP_MS);
    const nodes = Array.from({ length: 50 }, (_, i) => [`N${i}`, 100, 40 + i * 60]);
    const host = flowchart(nodes, []);
    const total = stampArrivalOrder(host);
    const delays = stampedIn(host).map(delayOf);
    check('fifty parts still start within the budget', Math.max(...delays) <= ARRIVAL_LEAD_MS + ARRIVAL_BUDGET_MS + 1, `${Math.max(...delays)}`);
    check('…and are spread, not clumped at the end', new Set(delays).size === delays.length);
    check('the total is the last start plus the longest animation', total === Math.max(...delays) + ARRIVAL_PART_MS, `${total}`);
    check('a whole arrival stays under four seconds', total < 4000, `${total}`);
    const empty = dom.window.document.createElement('div');
    empty.innerHTML = '<svg><g class="mark"><path d="M0,0L1,1"/></g></svg>';
    check('an svg with no known parts stamps nothing and reports 0', stampArrivalOrder(empty) === 0 && stampedIn(empty).length === 0);
    const anim = dom.window.document.createElement('div');
    anim.innerHTML = '<svg><g class="node"><circle cx="1" cy="1" r="1"><animate attributeName="r" values="1;2;1" dur="2s"/></circle></g></svg>';
    check('an animation with its own clock is never staggered by the kind', stampArrivalOrder(anim, 'animation') === 0 && stampedIn(anim).length === 0);
}

// The shapes below are the DOM the real libraries emit, dumped from headless
// Edge on 2026-09-07 (vega-embed svg renderer, function-plot, smiles-drawer).
function make(html) { const h = dom.window.document.createElement('div'); h.innerHTML = html; return h; }
const order = (host) => stampedIn(host).sort((p, q) => delayOf(p) - delayOf(q));
const tag = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : el.getAttribute('class') ? '.' + el.getAttribute('class').split(/\s+/)[0] : ''}`;

console.log('\n--- a vega chart: title, axes, marks left to right, legend ---');
{
    const host = make(`<figcaption id="cap">Title</figcaption><div class="vega-embed"><svg class="marks"><g transform="translate(38,5)"><g class="mark-group role-frame root"><g transform="translate(0,0)"><path class="background" d="M0,0h546v300Z"/><g>
        <g class="mark-group role-axis" id="ax1"><g transform="translate(0.5,300.5)"><path class="background" d="M0,0h546v20Z"/><g><g class="mark-rule role-axis-grid"><line transform="translate(0,-300)"/></g><g class="mark-text role-axis-label"><text>0</text></g></g></g></g>
        <g class="mark-group role-axis" id="ax2"><g transform="translate(0.5,0.5)"><g><g class="mark-text role-axis-label"><text>y</text></g></g></g></g>
        <g class="mark-rect role-mark marks" id="bars"><path id="b3" d="M300,100h20v200h-20Z"/><path id="b1" d="M100,50h20v250h-20Z"/><path id="b2" d="M200,80h20v220h-20Z"/></g>
        <g class="mark-group role-scope pathgroup"><g transform="translate(0,0)"><g><g class="mark-line role-mark marks"><path id="line" d="M4.55,271L6.8,271L500,20"/></g></g></g></g>
        <g class="mark-group role-legend" id="leg"><g transform="translate(565,0)"><g><g class="mark-text role-legend-title"><text>damping</text></g></g></g></g>
    </g></g></g></g></svg></div>`);
    const total = stampArrivalOrder(host, 'vega');
    const ids = order(host).map(tag);
    check('the hoisted title is first', ids[0] === 'figcaption#cap', ids.join(' '));
    // The frame vega draws round the plotting area. Before it was stamped it
    // was simply THERE from the first frame, an empty box with a chart
    // appearing inside it — which the settings gallery made obvious by
    // dissolving the sample first and leaving the rectangle alone on the card.
    check('the chart frame arrives before what is drawn in it', ids[1] === 'path.background', ids.join(' '));
    // And only the ROOT one. Vega gives every group mark a background path:
    // stamping `path.background` across the svg found seventeen on the real
    // chart, which spent seventeen steps of the budget at the FRONT of the plan
    // and pushed the axes out to 1.3s — arriving after the bars they measure.
    check('…and it is the root frame only, not every group', host.querySelectorAll('path.background[data-vb-arrive]').length === 1, `${host.querySelectorAll('path.background[data-vb-arrive]').length} stamped`);
    check('the axes come next, each as one piece', ids[2] === 'g#ax1' && ids[3] === 'g#ax2', ids.join(' '));
    check('no part INSIDE an axis is stamped on its own', host.querySelectorAll('.role-axis [data-vb-arrive]').length === 0);
    check('bars arrive left to right by their drawn x, not by document order', ids.indexOf('path#b1') < ids.indexOf('path#b2') && ids.indexOf('path#b2') < ids.indexOf('path#b3'), ids.join(' '));
    const line = host.querySelector('#line');
    check('a line mark draws itself', line.getAttribute('data-vb-arrive') === 'draw' && line.getAttribute('pathLength') === '1' && line.style.animationDuration === `${ARRIVAL_PART_MS}ms, ${ARRIVAL_CURVE_MS}ms`);
    check('a bar only fades', host.querySelector('#b1').getAttribute('data-vb-arrive') === 'part');
    check('the legend is last', ids[ids.length - 1] === 'g#leg', ids.join(' '));
    check('the total accounts for the curve, the longest animation', total === Math.max(...order(host).map(delayOf)) + ARRIVAL_CURVE_MS, `${total}`);
}

console.log('\n--- a function plot: axes, then each curve draws, the legend last ---');
{
    const host = make(`<figcaption id="cap">f</figcaption><div><svg class="function-plot"><text class="top-right-legend" id="leg" x="640" y="10">x</text><g class="canvas" transform="translate(40,20)"><defs><clipPath><rect class="clip"/></clipPath></defs>
        <g class="x axis" id="xax" transform="translate(0,369)"><path class="domain" d="M0.5,-369V0.5H600.5"/><g class="tick" transform="translate(12,0)"><line/><text y="3">1</text></g></g>
        <g class="y axis" id="yax"><path class="domain" d="M600,369.5H0.5V0.5"/></g>
        <text class="x axis-label" id="xl" x="600" y="363">x</text>
        <g class="tip"><g class="inner-tip"><path class="tip-x-line" d="M0,-389L0,389" stroke-dasharray="5,5"/></g></g>
        <g class="content"><path class="y origin" id="oy" d="M300,369L300,0"/><path class="x origin" id="ox" d="M0,184L600,184"/>
            <g class="graph"><path class="line line-0" id="c0" d="M0,545L0.5,542L600,10"/></g>
            <g class="graph"><path class="line line-1" id="c1" d="M0,300L600,300"/></g>
        </g><rect class="zoom-and-drag"/></g></svg></div>`);
    stampArrivalOrder(host, 'plot');
    const ids = order(host).map(tag);
    check('title, axes, axis label and origin lines come before any curve',
        ['figcaption#cap', 'g#xax', 'g#yax', 'text#xl', 'path#oy', 'path#ox'].every(a => ids.indexOf(a) < ids.indexOf('path#c0')), ids.join(' '));
    check('each curve draws itself', ['c0', 'c1'].every(id => host.querySelector('#' + id).getAttribute('data-vb-arrive') === 'draw'));
    check('the hover tip and the drag rect are left alone', !host.querySelector('.tip [data-vb-arrive]') && !host.querySelector('.zoom-and-drag[data-vb-arrive]'));
    check('the legend is last', ids[ids.length - 1] === 'text#leg', ids.join(' '));
}

console.log('\n--- a molecule: bonds draw left to right, then the atom labels ---');
{
    const host = make(`<svg><style></style><defs><radialGradient id="g"/></defs><mask><rect x="1" y="1"/><circle cx="5" cy="5"/></mask><g></g><g></g>
        <g><line id="bA" x1="200" y1="10" x2="220" y2="20"/><line id="bB" x1="100" y1="10" x2="120" y2="20"/><polygon id="wedge" points="150,10 160,20 140,20"/><line id="bC" x1="150" y1="10" x2="170" y2="20"/><circle id="ring" cx="130" cy="15" r="21" stroke="#fff" fill="none"/></g>
        <g><g id="atomZ"><text class="element" y="0.36em"><tspan x="210" y="12">O</tspan></text></g><g id="atomA"><text class="element" y="0.36em"><tspan x="90" y="12">N</tspan></text></g></g></svg>`);
    stampArrivalOrder(host, 'smiles');
    const ids = order(host).map(tag);
    check('bonds come before atoms', ids.indexOf('line#bA') < ids.indexOf('g#atomA') && ids.indexOf('line#bB') < ids.indexOf('g#atomA'), ids.join(' '));
    check('bonds arrive left to right', ids.indexOf('line#bB') < ids.indexOf('polygon#wedge') && ids.indexOf('polygon#wedge') < ids.indexOf('line#bA'), ids.join(' '));
    check('a bond line draws itself, a wedge only fades',
        host.querySelector('#bA').getAttribute('data-vb-arrive') === 'draw' && host.querySelector('#bA').style.animationDuration === `${ARRIVAL_PART_MS}ms, ${ARRIVAL_BOND_MS}ms`
        && host.querySelector('#wedge').getAttribute('data-vb-arrive') === 'part');
    check('nothing inside <defs> or <mask> is stamped', !host.querySelector('defs [data-vb-arrive], mask [data-vb-arrive]'));
    check('an atom label is stamped on its group, once', host.querySelectorAll('[data-vb-arrive]').length === 7, `${host.querySelectorAll('[data-vb-arrive]').length}`);
    // An aromatic ring is a stroked <circle>, and it was not in the query that
    // finds bonds: unstamped, it stood at full strength on the dissolved card
    // from the first frame and the lines drew themselves around it — benzene
    // arriving as a bare circle with a hexagon growing round it.
    check('a ring circle is a bond too, and draws itself',
        host.querySelector('#ring').getAttribute('data-vb-arrive') === 'draw', host.querySelector('#ring').getAttribute('data-vb-arrive'));
    check('…and takes its place among them by where it sits',
        ids.indexOf('line#bB') < ids.indexOf('circle#ring') && ids.indexOf('circle#ring') < ids.indexOf('line#bA'), ids.join(' '));
    check('a circle inside a <mask> is still left alone', !host.querySelector('mask circle[data-vb-arrive]'));
}

console.log(`\narrival gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

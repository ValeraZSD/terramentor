/**
 * The drawing passes: authorVisual (a scene brief -> an animated <svg> or a p5
 * sketch) and compileWidget (a functional spec -> one self-contained HTML
 * document). Each case calls the app's real function, so the app's own
 * validator (finalizeAuthoredSpec / finalizeWidgetHtml) must accept the reply
 * first; the scorer then checks what the prompt's hard rules make checkable:
 *
 *  - animation: the viewBox, an animation that really moves things (a
 *    transform animated with animateTransform, never <animate attributeName=
 *    "transform">), a rotation about the right point, gear ratios and
 *    directions, named labels present, in order, readable and still.
 *  - p5: the sketch is RUN in a node vm against a stub of the p5 API (no
 *    browser, no network, no host objects inside the context) and judged on
 *    what it draws.
 *  - widget: the document is loaded in jsdom with scripts on, the controls are
 *    driven and the displayed numbers read back.
 *
 * Proxies, stated where they are used: font sizes read from attributes (no
 * layout engine), label width estimated as 0.55 em per character, the colour
 * rule checked by hex/rgb() literals in CSS only.
 */
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);

// ---- a small SVG reader (no DOM needed: the specs are flat, well-formed XML) ----

function parseSvg(src) {
    const root = { name: '#root', attrs: {}, children: [], parent: null, text: '' };
    let cur = root;
    const tok = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
    const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = tok.exec(src))) {
        if (m[5] !== undefined) { cur.text += m[5]; continue; }
        if (!m[2]) continue;
        if (m[1]) { if (cur.parent) cur = cur.parent; continue; }
        const attrs = {};
        let a;
        attr.lastIndex = 0;
        while ((a = attr.exec(m[3]))) attrs[a[1]] = a[2] ?? a[3];
        const node = { name: m[2], attrs, children: [], parent: cur, text: '' };
        cur.children.push(node);
        if (!m[4]) cur = node;
    }
    return root;
}
const flat = (n) => [n, ...n.children.flatMap(flat)];
const textOf = (n) => (n.text + n.children.map(textOf).join('')).replace(/\s+/g, ' ').trim();
const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : NaN; };
const secs = (s) => { const m = /^\s*([\d.]+)\s*(ms|s)?\s*$/.exec(s ?? ''); return m ? parseFloat(m[1]) * (m[2] === 'ms' ? 0.001 : 1) : NaN; };
const ANIMS = new Set(['animate', 'animateTransform', 'animateMotion']);

function translateOf(node) {
    const m = /translate\(\s*(-?[\d.]+)[\s,]*(-?[\d.]+)?\s*\)/.exec(node.attrs.transform || '');
    return m ? [parseFloat(m[1]), parseFloat(m[2] ?? 0)] : [0, 0];
}
/** Offset a child's coordinates sit under: the static translates of its ancestors. */
function offsetAbove(node) {
    let x = 0, y = 0;
    for (let n = node.parent; n && n.name !== '#root'; n = n.parent) { const [a, b] = translateOf(n); x += a; y += b; }
    return [x, y];
}
function fontSize(node) {
    for (let n = node; n && n.name !== '#root'; n = n.parent) {
        const s = n.attrs['font-size'] ?? /font-size\s*:\s*([\d.]+)/.exec(n.attrs.style || '')?.[1];
        if (s !== undefined) return num(s);
    }
    return 16; // the SVG default
}
const rotators = (svg) => flat(svg).filter(n => n.name === 'animateTransform' && n.attrs.type === 'rotate');
const isAnimated = (g) => g.children.some(c => c.name === 'animateTransform' || c.name === 'animateMotion');
const inRotating = (n) => { for (let p = n.parent; p; p = p.parent) if (p.children.some(c => c.name === 'animateTransform' && c.attrs.type === 'rotate')) return true; return false; };
const inMoving = (n) => { for (let p = n.parent; p; p = p.parent) if (isAnimated(p)) return true; return false; };

/** [{ang, cx, cy}] of a rotate animation, from values= or from/to. */
function rotateKeys(a) {
    const raw = a.attrs.values != null ? a.attrs.values.split(';') : [a.attrs.from, a.attrs.to].filter(x => x != null);
    return raw.map(s => s.trim().split(/[\s,]+/).map(Number)).filter(v => v.length && v.every(Number.isFinite))
        .map(([ang, cx = 0, cy = 0]) => ({ ang, cx, cy }));
}
/**
 * Where a rotation really turns, in frame coordinates. A static transform on
 * the animated element itself is REPLACED by the animation (additive defaults
 * to replace), so it only counts with additive="sum".
 */
function pivotOf(a) {
    const target = a.parent;
    const [ox, oy] = offsetAbove(target);
    const [sx, sy] = a.attrs.additive === 'sum' ? translateOf(target) : [0, 0];
    return rotateKeys(a).map(k => ({ ...k, x: k.cx + ox + sx, y: k.cy + oy + sy }));
}
/** Degrees per second a rotate animation turns at (signed). */
function omega(a) {
    const k = rotateKeys(a);
    const d = secs(a.attrs.dur);
    return k.length >= 2 && d > 0 ? (k[k.length - 1].ang - k[0].ang) / d : NaN;
}

/** The x coordinates a path visits (absolute and relative commands, end points only). */
function pathXs(d) {
    const xs = []; let x = 0, y = 0;
    const size = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };
    for (const [, c, args] of String(d).matchAll(/([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g)) {
        const n = (args.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
        const rel = c === c.toLowerCase();
        const k = size[c.toUpperCase()];
        if (!k) continue;
        for (let i = 0; i + k <= n.length; i += k) {
            const e = n.slice(i, i + k);
            if (c.toUpperCase() === 'H') x = rel ? x + e[0] : e[0];
            else if (c.toUpperCase() === 'V') y = rel ? y + e[0] : y;
            else { x = rel ? x + e[k - 2] : e[k - 2]; y = rel ? y + e[k - 1] : e[k - 1]; }
            xs.push(x);
        }
    }
    return xs;
}
/** The x offsets an object moves through, in time order: translate values or an animateMotion path. */
function motionXs(svg, a) {
    if (a.name === 'animateTransform' && a.attrs.type === 'translate') {
        const raw = a.attrs.values != null ? a.attrs.values.split(';') : [a.attrs.from, a.attrs.to].filter(x => x != null);
        return raw.map(s => num(s.trim().split(/[\s,]+/)[0])).filter(Number.isFinite);
    }
    if (a.name === 'animateMotion') {
        let d = a.attrs.path;
        if (!d) {
            const href = flat(a).find(n => n.name === 'mpath')?.attrs.href ?? flat(a).find(n => n.name === 'mpath')?.attrs['xlink:href'];
            d = flat(svg).find(n => href && n.attrs.id === href.replace('#', ''))?.attrs.d;
        }
        return d ? pathXs(d) : [];
    }
    return [];
}
/** How far along x an object moves. */
function travelX(svg, a) {
    const xs = motionXs(svg, a);
    return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
}

/** Position of a <text> in frame coordinates (its x/y plus static translates above it). */
function textPos(t) {
    const [ox, oy] = offsetAbove(t);
    return { x: num(String(t.attrs.x ?? 0).split(/[\s,]+/)[0]) + ox, y: num(String(t.attrs.y ?? 0).split(/[\s,]+/)[0]) + oy };
}
/** Horizontal extent of a label: 0.55 em per character (a proxy; there is no layout engine here). */
function textSpan(t) {
    const w = 0.55 * fontSize(t) * textOf(t).length;
    const { x } = textPos(t);
    const anchor = t.attrs['text-anchor'] || /text-anchor\s*:\s*(\w+)/.exec(t.attrs.style || '')?.[1] || 'start';
    const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    return [left, left + w];
}

const fail = (why) => ({ pass: false, why });
const ok = (why) => ({ pass: true, why });

/** The prompt's hard rules that hold for every animation. Returns a failure or null. */
function animationBasics(spec) {
    const svg = parseSvg(spec);
    const root = flat(svg).find(n => n.name === 'svg');
    if (!root) return fail('no <svg> element');
    const vb = /^\s*0\s+0\s+360\s+(\d+)\s*$/.exec(root.attrs.viewBox || '');
    if (!vb || +vb[1] < 240 || +vb[1] > 320) return fail(`viewBox "${root.attrs.viewBox}" is not 0 0 360 (240..320)`);
    if (root.attrs.width || root.attrs.height) return fail('the <svg> carries width/height attributes');
    const all = flat(svg);
    const anims = all.filter(n => ANIMS.has(n.name));
    if (!anims.length) return fail('no animate/animateTransform/animateMotion: the scene is still');
    for (const a of anims) {
        if (a.attrs.attributeName === 'transform' && a.name === 'animate') return fail('<animate attributeName="transform"> renders still: it must be animateTransform');
        if (a.name === 'animateTransform' && !['translate', 'rotate', 'scale', 'skewX', 'skewY'].includes(a.attrs.type)) return fail('animateTransform without a valid type');
        const d = secs(a.attrs.dur);
        if (!(d >= 2 && d <= 12)) return fail(`dur "${a.attrs.dur}" is outside 2s-12s`);
        if (a.attrs.repeatCount !== 'indefinite') return fail('an animation does not loop (repeatCount="indefinite")');
        if (a.attrs.keyTimes != null && a.attrs.values != null) {
            // Number(), not parseFloat: "0.5x" is not a time the browser accepts.
            const kt = a.attrs.keyTimes.split(';').map(s => (s.trim() === '' ? NaN : Number(s.trim())));
            const vs = a.attrs.values.split(';');
            if (kt.length !== vs.length) return fail('keyTimes and values differ in length: the browser ignores the whole animation');
            if (kt.some(v => !Number.isFinite(v) || v < 0 || v > 1)) return fail(`keyTimes "${a.attrs.keyTimes}" holds a value that is not a number from 0 to 1`);
            if (kt[0] !== 0 || kt[kt.length - 1] !== 1 || kt.some((v, i) => i && v < kt[i - 1])) return fail('keyTimes must run 0..1 without decreasing');
        }
    }
    if (all.some(n => n.name === 'script' || Object.keys(n.attrs).some(k => /^on/i.test(k)))) return fail('script or on* handler in the SVG');
    for (const t of all.filter(n => n.name === 'text')) {
        if (fontSize(t) < 16) return fail(`text "${textOf(t)}" is ${fontSize(t)} units: nothing under 16`);
        if (inRotating(t)) return fail(`label "${textOf(t)}" sits inside a rotating group`);
    }
    return null;
}

const labelNode = (svg, re) => flat(svg).find(n => n.name === 'text' && re.test(textOf(n)));

// ---- the three animation scenes -------------------------------------------------

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240">';
const title = (s) => `<text x="12" y="28" font-family="sans-serif" font-size="20" font-weight="bold" fill="#111111">${s}</text>`;
const lab = (x, y, s, extra = '') => `<text x="${x}" y="${y}" font-family="sans-serif" font-size="16" fill="#111111" ${extra}>${s}</text>`;

const PENDULUM_BRIEF = `Title: Simple pendulum
Show a pendulum hanging from a fixed pivot at (180, 40): a thin rod 140 units long ending in a round bob. The bob swings 30 degrees to each side of vertical and back, about 4 seconds per full swing, looping forever. Label the fixed point "Pivot" beside it and the weight "Bob" in a caption at the bottom. The pivot itself never moves.`;

function pendulum({ values = '-30 180 40;0 180 40;30 180 40;0 180 40;-30 180 40', tag = 'animateTransform', dur = '4s', pivotLabelInside = false, viewBox = '0 0 360 240', twoSvgs = false } = {}) {
    const anim = tag === 'animateTransform'
        ? `<animateTransform attributeName="transform" type="rotate" values="${values}" keyTimes="0;0.25;0.5;0.75;1" dur="${dur}" repeatCount="indefinite"/>`
        : `<animate attributeName="transform" type="rotate" values="${values}" dur="${dur}" repeatCount="indefinite"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
${title('Pendulum')}
<line x1="130" y1="40" x2="230" y2="40" stroke="#555555" stroke-width="3"/>
<path d="M180 40 L180 190" fill="none" stroke="#888888" stroke-width="1" stroke-dasharray="4 4"/>
<g>
<line x1="180" y1="40" x2="180" y2="180" stroke="#111111" stroke-width="2"/>
<circle cx="180" cy="196" r="16" fill="#2563eb" stroke="#111111" stroke-width="2"/>
${pivotLabelInside ? lab(196, 34, 'Pivot') : ''}${anim}
</g>
<circle cx="180" cy="40" r="5" fill="#111111"/>
${pivotLabelInside ? '' : lab(240, 46, 'Pivot')}
${lab(12, 228, 'Bob: the swinging weight')}
</svg>`;
    return twoSvgs ? `${svg}\n\nHere is an alternative version:\n${svg}` : svg;
}

function scorePendulum(out) {
    const spec = out.spec;
    const basic = animationBasics(spec);
    if (basic) return basic;
    const svg = parseSvg(spec);
    const rot = rotators(svg);
    if (!rot.length) return fail('nothing rotates: a pendulum swings with animateTransform type="rotate"');
    const keys = rot.flatMap(pivotOf);
    const off = keys.find(k => Math.hypot(k.x - 180, k.y - 40) > 2);
    if (off) return fail(`it turns about (${off.x}, ${off.y}), not the pivot (180, 40)`);
    const angles = keys.map(k => k.ang);
    if (Math.min(...angles) > -20 || Math.max(...angles) < 20) return fail(`the swing ${Math.min(...angles)}..${Math.max(...angles)} degrees does not reach 20 to both sides`);
    if (Math.max(...angles.map(Math.abs)) > 45) return fail('the swing is far larger than the 30 degrees asked');
    const period = secs(rot[0].attrs.dur);
    if (period < 3 || period > 5) return fail(`period ${period}s, about 4s asked`);
    const g = rot[0].parent;
    const members = flat(g);
    const bob = members.find(n => n.name === 'circle' && Math.hypot(num(n.attrs.cx) - keys[0].cx, num(n.attrs.cy) - keys[0].cy) >= 100 && Math.hypot(num(n.attrs.cx) - keys[0].cx, num(n.attrs.cy) - keys[0].cy) <= 170);
    if (!bob) return fail('no bob (circle) 100-170 units from the pivot inside the swinging group');
    if (!members.some(n => n.name === 'line' || n.name === 'path' || n.name === 'rect')) return fail('no rod inside the swinging group');
    const pl = labelNode(svg, /^pivot$/i), bl = labelNode(svg, /\bbob\b/i);
    if (!pl) return fail('label "Pivot" missing');
    if (!bl) return fail('label "Bob" missing');
    const p = textPos(pl);
    if (Math.abs(p.x - 180) > 120 || Math.abs(p.y - 40) > 40) return fail(`"Pivot" sits at (${p.x}, ${p.y}), nowhere near the pivot`);
    return ok('pivot fixed, swings both sides, labels placed');
}

const GEARS_BRIEF = `Title: Meshing gears
Two gears side by side that mesh: a large gear A of radius 60 centred at (120, 140) and a small gear B of radius 30 centred at (210, 140), so their rims touch. Gear A turns clockwise once every 8 seconds, and B, locked to it, turns the opposite way and twice as fast. Mark one spoke on each gear so the turning is visible, and label them "Gear A" and "Gear B" in a caption below the drawing.`;

function gears({ bTo = '-720', bDur = '8s', aTo = '360', bAnimated = true, labelsInside = false } = {}) {
    const bAnim = bAnimated ? `<animateTransform attributeName="transform" type="rotate" from="0 210 140" to="${bTo} 210 140" dur="${bDur}" repeatCount="indefinite"/>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240">
${title('Gears')}
<g>
<circle cx="120" cy="140" r="60" fill="#94a3b8" stroke="#111111" stroke-width="3"/>
<line x1="120" y1="140" x2="120" y2="88" stroke="#111111" stroke-width="3"/>
<circle cx="120" cy="140" r="6" fill="#111111"/>
${labelsInside ? lab(96, 148, 'Gear A') : ''}<animateTransform attributeName="transform" type="rotate" from="0 120 140" to="${aTo} 120 140" dur="8s" repeatCount="indefinite"/>
</g>
<g>
<circle cx="210" cy="140" r="30" fill="#94a3b8" stroke="#111111" stroke-width="3"/>
<line x1="210" y1="140" x2="210" y2="116" stroke="#111111" stroke-width="3"/>
<circle cx="210" cy="140" r="4" fill="#111111"/>
${labelsInside ? lab(190, 148, 'Gear B') : ''}${bAnim}
</g>
${labelsInside ? '' : `${lab(60, 222, 'Gear A')}${lab(200, 222, 'Gear B')}`}
</svg>`;
}

function scoreGears(out) {
    const basic = animationBasics(out.spec);
    if (basic) return basic;
    const svg = parseSvg(out.spec);
    const rot = rotators(svg);
    const turning = (cx, cy) => rot.find(a => pivotOf(a).every(k => Math.hypot(k.x - cx, k.y - cy) <= 2));
    const A = turning(120, 140), B = turning(210, 140);
    if (!A) return fail('gear A (centre 120,140) has no rotation about its centre');
    if (!B) return fail('gear B (centre 210,140) has no rotation about its centre');
    const wa = omega(A), wb = omega(B);
    if (!(wa > 0)) return fail(`gear A should turn clockwise (positive angle), turns ${wa} deg/s`);
    if (!(wb < 0)) return fail(`gear B must turn the opposite way to A, turns ${wb} deg/s`);
    if (Math.abs(wa - 45) > 5) return fail(`gear A turns ${wa} deg/s, one turn per 8s is 45`);
    const ratio = Math.abs(wb / wa);
    if (Math.abs(ratio - 2) > 0.2) return fail(`gear B turns ${ratio.toFixed(2)}x as fast as A, 2x asked`);
    for (const g of [A.parent, B.parent]) {
        if (flat(g).filter(n => ['circle', 'line', 'path', 'rect', 'polygon'].includes(n.name)).length < 2) return fail('a turning gear has no spoke or mark to show the turning');
    }
    if (!labelNode(svg, /gear\s*a/i) || !labelNode(svg, /gear\s*b/i)) return fail('labels "Gear A" / "Gear B" missing');
    return ok('both gears turn about their centres, opposite ways, 2:1');
}

const WATER_BRIEF = `Title: Water cycle
Three stations arranged left to right across the frame, in this order: "Evaporation", "Condensation", "Rain". A single blue droplet travels from the first station to the last along a straight line and loops back, about 6 seconds per trip. The station labels stay still.`;

function water({ labels = ['Evaporation', 'Condensation', 'Rain'], fs = 16, move = '<animateTransform attributeName="transform" type="translate" values="0 0;120 0;240 0" keyTimes="0;0.5;1" dur="6s" repeatCount="indefinite"/>', xs = [60, 180, 300], labelsMove = false } = {}) {
    const stations = labels.map((s, i) => `<circle cx="${xs[i]}" cy="170" r="10" fill="#94a3b8" stroke="#111111" stroke-width="2"/>${labelsMove && i === 0 ? '' : `<text x="${xs[i]}" y="210" text-anchor="middle" font-family="sans-serif" font-size="${fs}" fill="#111111">${s}</text>`}`).join('\n');
    const rideLabel = labelsMove ? `<text x="${xs[0]}" y="210" text-anchor="middle" font-family="sans-serif" font-size="${fs}" fill="#111111">${labels[0]}</text>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240">
${title('Water cycle')}
<line x1="60" y1="120" x2="300" y2="120" stroke="#888888" stroke-width="1" stroke-dasharray="4 4"/>
${stations}
<g>
<circle cx="60" cy="120" r="9" fill="#2563eb" stroke="#1e3a8a" stroke-width="2"/>
${rideLabel}${move}
</g>
</svg>`;
}

function scoreWater(out) {
    const basic = animationBasics(out.spec);
    if (basic) return basic;
    const svg = parseSvg(out.spec);
    const names = ['Evaporation', 'Condensation', 'Rain'];
    const nodes = names.map(n => labelNode(svg, new RegExp(`^${n}$`, 'i')));
    const missing = names.filter((n, i) => !nodes[i]);
    if (missing.length) return fail(`label(s) missing: ${missing.join(', ')}`);
    const xs = nodes.map(n => textPos(n).x);
    if (!(xs[0] < xs[1] && xs[1] < xs[2])) return fail(`labels are not left to right in the order asked (x = ${xs.join(', ')})`);
    for (const n of nodes) {
        const [l, r] = textSpan(n);
        if (l < 0 || r > 360) return fail(`"${textOf(n)}" runs past the frame (${Math.round(l)}..${Math.round(r)})`);
        if (inMoving(n)) return fail(`"${textOf(n)}" rides inside a moving group; the labels stay still`);
    }
    const moves = flat(svg).filter(n => ANIMS.has(n.name) && n.name !== 'animate');
    const move = moves.reduce((best, a) => (travelX(svg, a) > (best ? travelX(svg, best) : -1) ? a : best), null);
    const span = move ? travelX(svg, move) : 0;
    const stations = xs[2] - xs[0];
    if (span < 0.6 * stations) return fail(`the droplet travels ${Math.round(span)} units along x, the stations span ${Math.round(stations)}`);
    // The trip runs from the first station to the last: its first step goes their way.
    const path = motionXs(svg, move);
    const step = path.slice(1).map((x, i) => x - path[i]).find(d => Math.abs(d) > 1e-6) ?? 0;
    if (!(step > 0)) return fail('the droplet sets off away from the last station: the trip runs first to last');
    // Where the droplet is drawn is known for a circle or ellipse: it starts at the first station and reaches the last.
    const drop = flat(move.parent).find(n => n.name === 'circle' || n.name === 'ellipse');
    if (drop) {
        // Inside the moving element, the droplet's own translate and any group between count too.
        // When the droplet IS the moving element, the animation replaces its static transform.
        let inner = 0;
        if (drop !== move.parent) {
            inner = translateOf(drop)[0];
            for (let n = drop.parent; n && n !== move.parent; n = n.parent) inner += translateOf(n)[0];
        } else if (move.attrs.additive === 'sum') inner = translateOf(drop)[0];
        const base = num(drop.attrs.cx ?? 0) + inner + offsetAbove(move.parent)[0];
        const near = 0.25 * stations;
        if (Math.abs(base + path[0] - xs[0]) > near) return fail(`the droplet starts at x = ${Math.round(base + path[0])}, not at the first station (${Math.round(xs[0])})`);
        if (base + Math.max(...path) < xs[2] - near) return fail(`the droplet gets no further than x = ${Math.round(base + Math.max(...path))}, short of the last station (${Math.round(xs[2])})`);
    }
    return ok('labels in order, still and inside the frame; the droplet runs first station to last');
}

// ---- the p5 sketch, run against a stub -------------------------------------------

/** Evaluated INSIDE the vm context, so nothing from the host realm is reachable by the sketch. */
function sketchPrelude(seed) {
    const g = globalThis;
    let s = seed >>> 0;
    const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    Math.random = rnd;
    const log = { canvas: [], frames: [], setup: null, complex: false };
    let cur = { names: [], dots: [], legends: [], texts: 0 };
    log.setup = cur;
    let ox = 0, oy = 0;
    const stack = [];
    const rec = (n) => { cur.names.push(n); };
    g.__begin = (i) => { cur = { names: [], dots: [], legends: [], texts: 0 }; log.frames.push(cur); g.frameCount = i + 1; ox = 0; oy = 0; stack.length = 0; };
    g.__log = () => JSON.stringify(log);
    for (const n of ['background', 'clear', 'fill', 'stroke', 'noFill', 'noStroke', 'strokeWeight', 'line', 'rect', 'triangle', 'quad', 'arc',
        'beginShape', 'vertex', 'endShape', 'curveVertex', 'textSize', 'textAlign', 'colorMode', 'frameRate', 'noLoop', 'loop', 'bezier', 'curve',
        'strokeCap', 'strokeJoin', 'rectMode', 'ellipseMode', 'angleMode', 'blendMode', 'smooth', 'noSmooth', 'arrow', 'vec']) g[n] = () => { rec(n); };
    g.text = () => { cur.texts++; rec('text'); };
    g.legend = (e) => { cur.legends.push(JSON.stringify(e)); rec('legend'); };
    g.createCanvas = (w, h) => { log.canvas.push([w, h]); g.width = w; g.height = h; return {}; };
    g.ellipse = (x, y, w, h) => { cur.dots.push([x + ox, y + oy, w, h === undefined ? w : h]); rec('ellipse'); };
    g.circle = (x, y, d) => { cur.dots.push([x + ox, y + oy, d, d]); rec('circle'); };
    g.point = (x, y) => { cur.dots.push([x + ox, y + oy, 0, 0]); rec('point'); };
    g.push = () => { stack.push([ox, oy]); rec('push'); };
    g.pop = () => { [ox, oy] = stack.pop() || [0, 0]; rec('pop'); };
    g.translate = (x, y = 0) => { ox += x; oy += y; rec('translate'); };
    for (const n of ['rotate', 'scale', 'applyMatrix', 'shearX', 'shearY']) g[n] = () => { log.complex = true; rec(n); };
    g.width = 100; g.height = 100; g.frameCount = 0; g.mouseX = 0; g.mouseY = 0; g.mouseIsPressed = false; g.deltaTime = 16.7;
    g.windowWidth = 600; g.windowHeight = 340;
    g.millis = () => g.frameCount * 16.7;
    for (const n of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'pow', 'exp', 'log']) g[n] = Math[n];
    g.PI = Math.PI; g.TWO_PI = 2 * Math.PI; g.TAU = 2 * Math.PI; g.HALF_PI = Math.PI / 2; g.QUARTER_PI = Math.PI / 4;
    g.sq = (v) => v * v; g.radians = (d) => d * Math.PI / 180; g.degrees = (r) => r * 180 / Math.PI;
    g.constrain = (v, a, b) => Math.min(Math.max(v, a), b);
    g.map = (v, a, b, c, d) => c + (d - c) * (v - a) / (b - a);
    g.lerp = (a, b, t) => a + (b - a) * t;
    g.dist = (a, b, c, d) => Math.hypot(c - a, d - b);
    g.mag = (a, b) => Math.hypot(a, b);
    g.norm = (v, a, b) => (v - a) / (b - a);
    g.int = (v) => Math.trunc(v); g.float = (v) => parseFloat(v); g.str = (v) => String(v);
    g.nf = (v, l, r) => (r === undefined ? String(v) : Number(v).toFixed(r));
    g.random = (a, b) => (Array.isArray(a) ? a[Math.floor(rnd() * a.length)] : a === undefined ? rnd() : b === undefined ? rnd() * a : a + rnd() * (b - a));
    g.randomSeed = () => { };
    g.randomGaussian = (m = 0, sd = 1) => m + sd * Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    g.noise = (x = 0, y = 0, z = 0) => { const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453; return v - Math.floor(v); };
    g.noiseSeed = () => { }; g.noiseDetail = () => { };
    g.color = (...a) => a;
    class Vec {
        constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
        add(a, b = 0) { if (typeof a === 'object') { this.x += a.x; this.y += a.y; } else { this.x += a; this.y += b; } return this; }
        sub(a, b = 0) { if (typeof a === 'object') { this.x -= a.x; this.y -= a.y; } else { this.x -= a; this.y -= b; } return this; }
        mult(k) { this.x *= k; this.y *= k; return this; }
        div(k) { this.x /= k; this.y /= k; return this; }
        mag() { return Math.hypot(this.x, this.y); }
        copy() { return new Vec(this.x, this.y, this.z); }
        set(x, y) { this.x = x; this.y = y; return this; }
        normalize() { const m = this.mag(); if (m) { this.x /= m; this.y /= m; } return this; }
        limit(m) { if (this.mag() > m) this.normalize().mult(m); return this; }
        dist(o) { return Math.hypot(this.x - o.x, this.y - o.y); }
    }
    g.createVector = (x, y, z) => new Vec(x, y, z);
}

const UNSAFE = /\.\s*constructor\b|\[\s*['"`]constructor|__proto__|\b(?:process|require|import|eval|Function|globalThis|window|document|fetch|XMLHttpRequest|WebSocket|Reflect|Proxy)\b/;

/** Run a sketch: setup() once, then draw() `frames` times. Returns the call log or { error }. */
function runSketch(code, seed, frames) {
    const bad = UNSAFE.exec(code);
    if (bad) return { error: `uses ${bad[0]}, which a sketch never needs` };
    const ctx = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
    try {
        vm.runInContext(`(${sketchPrelude.toString()})(${seed >>> 0})`, ctx, { timeout: 1000 });
        vm.runInContext(code, ctx, { timeout: 1000 });
        vm.runInContext('if (typeof setup !== "function" || typeof draw !== "function") throw new Error("setup/draw are not functions"); setup();', ctx, { timeout: 1000 });
        vm.runInContext(`for (var __i = 0; __i < ${frames}; __i++) { __begin(__i); draw(); }`, ctx, { timeout: 4000 });
        return JSON.parse(vm.runInContext('__log()', ctx));
    } catch (e) {
        return { error: String(e?.message || e).slice(0, 160) };
    }
}

const WALKERS_BRIEF = `Title: Random walkers
Show 40 walkers that all start at the centre of the canvas (300, 170). Every frame each walker takes one small random step (up to 3 pixels in x and in y) and is drawn as a 6-pixel dot. Stop a walker at the edge of the canvas so none leaves it. Add a one-entry legend "walker". The point: the cloud of walkers spreads out slowly over time.`;

const walkers = ({ setupExtra = '', step = 'random(-3, 3)', clamp = true, bgFirst = true, count = 40, legendCall = 'legend([["walker", 37, 99, 235]]);', textCall = '', drift = '', start = '300, 170', drawExtra = '', frameExtra = '' } = {}) => `let walkers = [];
function setup() {
  createCanvas(600, 340);${setupExtra}
  for (let i = 0; i < ${count}; i++) walkers.push({ x: ${start.split(',')[0]}, y: ${start.split(',')[1]} });
}
function draw() {
  ${bgFirst ? 'background(255);' : ''}${frameExtra}
  fill(37, 99, 235);
  noStroke();
  for (const w of walkers) {
    w.x += ${step}${drift};
    w.y += ${step};
    ${clamp ? 'w.x = constrain(w.x, 3, 597);\n    w.y = constrain(w.y, 3, 337);' : ''}
    ellipse(w.x, w.y, 6, 6);${drawExtra}
  }
  ${legendCall}${textCall}
  ${bgFirst ? '' : 'background(255);'}
}`;

const meanDist = (dots, cx, cy) => dots.reduce((s, d) => s + Math.hypot(d[0] - cx, d[1] - cy), 0) / (dots.length || 1);

function scoreWalkers(out) {
    const code = out.spec;
    const A = runSketch(code, 1, 400);
    if (A.error) return fail(`the sketch fails when run: ${A.error}`);
    const B = runSketch(code, 2, 400);
    if (B.error) return fail(`the sketch fails when run: ${B.error}`);
    if (A.canvas.length !== 1 || A.canvas[0][0] !== 600 || A.canvas[0][1] !== 340) return fail(`createCanvas called ${JSON.stringify(A.canvas)}, once with (600, 340) asked`);
    for (const [i, f] of A.frames.entries()) {
        if (!['background', 'clear'].includes(f.names[0])) return fail(`draw() does not start with background() (frame ${i + 1} starts with ${f.names[0]})`);
        if (f.names.filter(n => n === 'push').length !== f.names.filter(n => n === 'pop').length) return fail('push() and pop() are not paired');
        if (f.texts) return fail('text() used: labels go through legend() only');
    }
    const dotsOf = (f) => f.dots.filter(d => d[2] >= 4 && d[2] <= 8 && d[2] === d[3]);
    const first = dotsOf(A.frames[0]), last = dotsOf(A.frames[399]);
    if (first.length !== 40) return fail(`${first.length} six-pixel dots in the first frame, 40 walkers asked`);
    for (const [i, f] of A.frames.entries()) {
        const n = dotsOf(f).length;
        if (n !== 40) return fail(`${n} six-pixel dots in frame ${i + 1}: 40 walkers in every frame`);
        if (!f.legends.some(l => /walker/i.test(l))) return fail(`no legend naming "walker" in frame ${i + 1}: one on every frame`);
    }
    if (first.some(d => Math.hypot(d[0] - 300, d[1] - 170) > 12)) return fail('walkers do not start at the centre (300, 170)');
    if (!A.complex) {
        for (const f of A.frames) {
            if (f.dots.some(d => d[0] - d[2] / 2 < -0.01 || d[0] + d[2] / 2 > 600.01 || d[1] - d[3] / 2 < -0.01 || d[1] + d[3] / 2 > 340.01)) return fail('a walker leaves the 600 x 340 canvas');
        }
    }
    const m0 = meanDist(first, 300, 170), m1 = meanDist(last, 300, 170);
    if (!(m1 > 15 && m1 > 3 * m0)) return fail(`the cloud does not spread: mean distance ${m0.toFixed(1)} -> ${m1.toFixed(1)} px`);
    const lastB = dotsOf(B.frames[399]);
    const same = last.length === lastB.length && last.every((d, i) => Math.abs(d[0] - lastB[i][0]) < 1e-6 && Math.abs(d[1] - lastB[i][1]) < 1e-6);
    if (same) return fail('the walk is not random: two different random streams drew identical frames');
    const mx = last.reduce((s, d) => s + d[0], 0) / last.length;
    const sd = Math.sqrt(last.reduce((s, d) => s + (d[0] - mx) ** 2, 0) / last.length);
    if (sd < 10) return fail('the walkers move in lockstep (no spread between them)');
    return ok('40 walkers start at the centre, spread randomly, stay inside, legend every frame');
}

// ---- the widgets, run in jsdom -----------------------------------------------------

const DENY_IN_WIDGET = /\.\s*constructor\b|\[\s*['"`]constructor|__proto__|\b(?:process|require|eval)\s*[(.\[]|\bFunction\s*\(|\bglobalThis\b|\bReflect\b/;

/** Load a widget with its scripts running; returns { doc, errors } or { error }. */
function loadWidget(html) {
    const hit = DENY_IN_WIDGET.exec(html);
    if (hit) return { error: `contains ${hit[0].trim()}, which a widget never needs` };
    const { JSDOM, VirtualConsole } = require('jsdom');
    const errors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(String(e?.detail?.message || e?.message || e).slice(0, 160)));
    let dom;
    try {
        dom = new JSDOM(html, {
            runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
            beforeParse(window) {
                // A widget is self-contained: nothing in it may reach the network.
                for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) {
                    try { delete window[k]; } catch { /* not configurable */ }
                    if (window[k]) window[k] = undefined;
                }
                // jsdom has no canvas: hand scripts a context that swallows every call.
                const ctx2d = new Proxy(function () { }, { get: (t, k) => (k === 'canvas' ? undefined : (k === 'measureText' ? () => ({ width: 10 }) : () => ctx2d)), set: () => true, apply: () => ctx2d });
                window.HTMLCanvasElement.prototype.getContext = () => ctx2d;
            },
        });
    } catch (e) { return { error: `the document did not load: ${String(e?.message || e).slice(0, 160)}` }; }
    return { doc: dom.window.document, win: dom.window, errors, close: () => dom.window.close() };
}

const styleOf = (el) => el.ownerDocument.defaultView.getComputedStyle(el);
/** Laid out at all: no `hidden`, no display:none on it or above it (display does not inherit). */
function rendered(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        if (n.hidden || (n.tagName === 'INPUT' && n.type === 'hidden') || styleOf(n).display === 'none') return false;
    }
    return true;
}
/** Seen by a learner: rendered, and not visibility:hidden (which jsdom inherits). */
const shown = (el) => rendered(el) && !['hidden', 'collapse'].includes(styleOf(el).visibility);

/** What a learner sees: shown body text without script/style, plus every shown field's value. */
function visibleText(doc) {
    const words = [];
    const walk = (n) => {
        if (n.nodeType === 3) { if (!['hidden', 'collapse'].includes(styleOf(n.parentElement).visibility)) words.push(n.data); }
        else if (n.nodeType === 1 && !/^(?:SCRIPT|STYLE|TEMPLATE)$/.test(n.tagName) && rendered(n)) n.childNodes.forEach(walk);
    };
    walk(doc.body);
    const values = [...doc.querySelectorAll('input, output, textarea, select')].filter(shown).map(n => n.value ?? '');
    return [...words, ...values].join(' ').replace(/\s+/g, ' ');
}

function controlByLabel(doc, re) {
    for (const l of doc.querySelectorAll('label')) {
        if (!re.test(l.textContent) || !shown(l)) continue;
        const c = l.control || (l.htmlFor && doc.getElementById(l.htmlFor)) || l.querySelector('input, select, textarea');
        if (c && shown(c)) return c;
    }
    return [...doc.querySelectorAll('input, select, textarea')].find(i => shown(i) && re.test(`${i.getAttribute('aria-label') || ''} ${i.id} ${i.name}`)) || null;
}
const buttonByText = (doc, re) => [...doc.querySelectorAll('button, [role="button"], input[type="button"]')].find(b => shown(b) && re.test((b.textContent || b.value || '').trim())) || null;
/** Typing: browsers fire `input` per keystroke; `change` waits for the field to lose focus. */
function setValue(win, el, v) {
    el.value = String(v);
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
}
/** Colours must come from the host's variables: hex/rgb() literals in CSS values and nothing defining --w-*. */
function themeProblem(html) {
    const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).concat([...html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map(m => m[1])).join('\n');
    if (/--w-[\w-]+\s*:/.test(css)) return 'defines its own --w-* variables (the host defines them)';
    if (/:[^;{}]*(?:#[0-9a-f]{3,8}\b|rgba?\()/i.test(css)) return 'hardcoded colour literal in CSS (only var(--w-*) allowed)';
    if (!/var\(--w-/.test(css)) return 'never uses the host theme variables var(--w-*)';
    return null;
}

const KM_SPEC = `Title: Kilometres to miles
Objective: Let the learner see how a distance in kilometres converts to miles.
Data: 1 mile = 1.609344 km. The starting distance is 10 km.
Inputs: one number input labelled "Kilometres" (starts at 10). Show the result next to a label "Miles".
Behavior: Miles = Kilometres / 1.609344, shown rounded to 2 decimal places, and it updates live as the number is typed. No canvas, plain DOM only.`;

const kmDoc = ({ expr = 'v / 1.609344', listen = 'km.addEventListener("input", update);', initial = 'update();', extraHead = '', css = null, extraCss = '', script = null } = {}) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Kilometres to miles</title>
<style>
${css ?? `body { margin: 0; padding: 12px; background: var(--w-bg); color: var(--w-fg); font-family: sans-serif; }
.row { display: grid; grid-template-columns: max-content 1fr; gap: 8px; align-items: center; margin-bottom: 12px; }
input { accent-color: var(--w-accent); border: 1px solid var(--w-border); }
output { color: var(--w-accent); font-size: 1.4rem; font-variant-numeric: tabular-nums; }
@media (pointer: coarse) { input, button { min-height: 44px; } }`}${extraCss}
</style>${extraHead}</head>
<body>
<div class="row"><label for="km">Kilometres</label><input id="km" type="number" min="0" step="any" value="10"></div>
<div class="row"><label for="mi">Miles</label><output id="mi">6.21</output></div>
<button id="go">Convert</button>
<script>
${script ?? `const km = document.getElementById("km");
const mi = document.getElementById("mi");
const go = document.getElementById("go");
function update() {
  const v = parseFloat(km.value);
  mi.textContent = Number.isFinite(v) ? (${expr}).toFixed(2) : "";
}
${listen}
go.addEventListener("click", update);
${initial}`}
</script>
</body></html>`;

/** A converter whose live result goes to an element the learner cannot see; the output keeps its starting 6.21. */
const ghostScript = (hide) => `const km = document.getElementById("km");
const ghost = document.createElement("span");
${hide}
document.body.appendChild(ghost);
function update() { const v = parseFloat(km.value); ghost.textContent = Number.isFinite(v) ? (v / 1.609344).toFixed(2) : ""; }
km.addEventListener("input", update);
update();`;

function scoreKm(out) {
    const html = out.html;
    const theme = themeProblem(html);
    if (theme) return fail(theme);
    const w = loadWidget(html);
    if (w.error) return fail(w.error);
    try {
        if (w.errors.length) return fail(`script error on load: ${w.errors[0]}`);
        const km = controlByLabel(w.doc, /kilomet/i);
        if (!km || km.tagName !== 'INPUT') return fail('no input labelled "Kilometres"');
        if (!/\bmiles\b/i.test(visibleText(w.doc))) return fail('no "Miles" label shown');
        const has = (s) => new RegExp(`(?<![\\d.])${s.replace('.', '\\.')}(?!\\d)`).test(visibleText(w.doc));
        if (!has('6.21')) return fail('10 km does not read 6.21 miles at the start');
        for (const [v, want] of [['42.195', '26.22'], ['100', '62.14'], ['5', '3.11']]) {
            setValue(w.win, km, v);
            if (w.errors.length) return fail(`script error after typing: ${w.errors[0]}`);
            if (!has(want)) return fail(`${v} km does not show ${want} miles after typing (live update)`);
        }
        return ok('numbers convert live and correctly');
    } finally { w.close(); }
}

const QUIZ_SPEC = `Title: Multiplication check
Objective: Let the learner test the fact 7 x 8.
Data: The question text is "What is 7 × 8?". Three answer buttons labelled 54, 56 and 63 (56 is the right one). The score starts at 0.
Inputs: the three answer buttons, and a button labelled "Reset".
Behavior: Show the score as the text "Score: N". Clicking 56 shows the message "Correct!" and adds 1 to the score. Clicking 54 or 63 shows the message "Not quite" and leaves the score unchanged. "Reset" sets the score back to 0 and clears the message.`;

const quizDoc = ({ right = '56', anyCorrect = false, stuck = false, resetKeeps = false, css = null, extraCss = '', head = '' } = {}) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Multiplication check</title>
<style>
${css ?? `body { margin: 0; padding: 12px; background: var(--w-bg); color: var(--w-fg); font-family: sans-serif; }
button { background: var(--w-accent); color: var(--w-bg); border: 1px solid var(--w-border); border-radius: 8px; padding: 8px 16px; margin: 0 8px 8px 0; }
#msg { color: var(--w-accent-2); min-height: 1.5em; }
@media (pointer: coarse) { button { min-height: 44px; } }`}${extraCss}
</style>${head}</head>
<body>
<p>What is 7 × 8?</p>
<div id="options"><button data-v="54">54</button><button data-v="56">56</button><button data-v="63">63</button></div>
<p id="msg"></p>
<p id="score">Score: 0</p>
<button id="reset">Reset</button>
<script>
let score = 0;
const msg = document.getElementById("msg");
const scoreEl = document.getElementById("score");
document.querySelectorAll("#options button").forEach(function (b) {
  b.addEventListener("click", function () {
    if (${anyCorrect ? 'true' : `b.dataset.v === "${right}"`}) {
      msg.textContent = "Correct!";
      ${stuck ? '' : 'score += 1;'}
    } else {
      msg.textContent = "Not quite";
    }
    scoreEl.textContent = "Score: " + score;
  });
});
document.getElementById("reset").addEventListener("click", function () {
  score = 0;
  ${resetKeeps ? '' : 'msg.textContent = "";'}
  scoreEl.textContent = "Score: " + score;
});
</script>
</body></html>`;

function scoreQuiz(out) {
    const html = out.html;
    const theme = themeProblem(html);
    if (theme) return fail(theme);
    const w = loadWidget(html);
    if (w.error) return fail(w.error);
    try {
        if (w.errors.length) return fail(`script error on load: ${w.errors[0]}`);
        const text = () => visibleText(w.doc);
        const score = (n) => new RegExp(`score\\s*:\\s*${n}(?!\\d)`, 'i').test(text());
        const btn = {};
        for (const k of ['54', '56', '63']) { btn[k] = buttonByText(w.doc, new RegExp(`^${k}$`)); if (!btn[k]) return fail(`no button labelled ${k}`); }
        const reset = buttonByText(w.doc, /^reset$/i);
        if (!reset) return fail('no button labelled "Reset"');
        if (!/7\s*[×x*]\s*8/.test(text())) return fail('the question "7 × 8" is not shown');
        if (!score(0)) return fail('the score does not start as "Score: 0"');
        if (/correct!|not quite/i.test(text())) return fail('a message is showing before any answer');
        btn['54'].click();
        if (!/not quite/i.test(text()) || /correct!/i.test(text())) return fail('a wrong answer (54) does not show "Not quite"');
        if (!score(0)) return fail('a wrong answer changed the score');
        btn['56'].click();
        if (!/correct!/i.test(text()) || /not quite/i.test(text())) return fail('the right answer (56) does not show "Correct!"');
        if (!score(1)) return fail('the right answer did not add 1 to the score');
        btn['63'].click();
        if (!/not quite/i.test(text())) return fail('a second wrong answer (63) does not show "Not quite"');
        if (!score(1)) return fail('a wrong answer changed the score');
        reset.click();
        if (!score(0)) return fail('Reset does not set the score to 0');
        if (/correct!|not quite/i.test(text())) return fail('Reset does not clear the message');
        if (w.errors.length) return fail(`script error while clicking: ${w.errors[0]}`);
        return ok('answers, messages, score and reset all behave');
    } finally { w.close(); }
}

// ---- model-written code runs in a child process ------------------------------------
//
// A sketch or widget is code the model wrote. Neither jsdom nor a node vm is a
// sandbox (a script can climb to the host's `process`, for one through
// `getContext["con" + "structor"]`), and neither stops every runaway loop. So
// the scorers that RUN the code do it in a child process under Node's
// permission model: it may read only this file and node_modules (for jsdom),
// and may not write files, start processes or workers, load addons or open the
// inspector; node:sqlite, which the permission model does not check, is off.
// Its environment holds no API key, and it is killed after 30 s
// (BENCH_CODE_TIMEOUT_MS; the scorer check sets it lower). Outbound network is
// not fenced by Node 24's permission model. The verdict comes back on a line
// tagged with a one-off nonce, so text the code prints cannot pose as one.

const SELF = fileURLToPath(import.meta.url);
const RUNS_CODE = { walkers: scoreWalkers, km: scoreKm, quiz: scoreQuiz };

/** The flags the code-running child starts under; mutate.mjs probes the same fence. */
export function codeChildFlags() {
    const modules = realpathSync(path.join(path.dirname(require.resolve('jsdom/package.json')), '..'));
    // node:sqlite opens and writes files outside the permission model's fs checks: switch it off.
    return ['--permission', `--allow-fs-read=${SELF}`, `--allow-fs-read=${modules}`, '--no-experimental-sqlite'];
}

function isolated(name) {
    return (out) => {
        const nonce = randomUUID();
        const limit = Number(process.env.BENCH_CODE_TIMEOUT_MS) || 30_000;
        const env = {};
        for (const k of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'HOME']) if (process.env[k]) env[k] = process.env[k];
        const r = spawnSync(process.execPath, [...codeChildFlags(), SELF, name], {
            input: JSON.stringify({ nonce, out }), encoding: 'utf8', env, timeout: limit, windowsHide: true, maxBuffer: 4 << 20,
        });
        if (r.error?.code === 'ETIMEDOUT' || r.signal) return fail(`the code was still running after ${limit / 1000} s (a runaway loop)`);
        const line = String(r.stdout || '').split('\n').find(l => l.startsWith(nonce));
        if (!line) return fail(`the code ended its process: ${String(r.stderr || '').trim().slice(0, 160) || `exit ${r.status}`}`);
        return JSON.parse(line.slice(nonce.length));
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF && RUNS_CODE[process.argv[2]]) {
    const { nonce, out } = JSON.parse(readFileSync(0, 'utf8'));
    let verdict;
    try { verdict = RUNS_CODE[process.argv[2]](out); } catch (e) { verdict = fail(`scorer threw: ${String(e?.message || e).slice(0, 160)}`); }
    process.stdout.write(`\n${nonce}${JSON.stringify(verdict)}\n`, () => process.exit(0));
}

// ---- the cases -------------------------------------------------------------------------

const animation = (brief) => (fx, app) => app.server('visualAuthor.js').then(m => m.authorVisual({ kind: 'animation', brief }));
const widget = (spec) => (fx, app) => app.server('widgets.js').then(m => m.compileWidget({ spec }));

export default {
    category: 'visuals',
    label: 'Drawing animations and widgets',
    cases: [
        {
            id: 'visuals-animation-pendulum',
            run: animation(PENDULUM_BRIEF),
            score: scorePendulum,
            golden: pendulum(),
            mutants: [
                { name: 'swings about the bob, not the pivot', reply: pendulum({ values: '-30 180 196;0 180 196;30 180 196;0 180 196;-30 180 196' }) },
                { name: 'animate attributeName=transform (renders still)', reply: pendulum({ tag: 'animate' }) },
                { name: 'swings to one side only', reply: pendulum({ values: '0 180 40;15 180 40;30 180 40;15 180 40;0 180 40' }) },
                { name: 'pivot label inside the swinging group', reply: pendulum({ pivotLabelInside: true }) },
                { name: 'frame 600 wide', reply: pendulum({ viewBox: '0 0 600 340' }) },
                { name: 'two alternative svgs', reply: pendulum({ twoSvgs: true }) },
                { name: 'a 0.5s jitter, not a swing', reply: pendulum({ dur: '0.5s' }) },
            ],
        },
        {
            id: 'visuals-animation-gears',
            run: animation(GEARS_BRIEF),
            score: scoreGears,
            golden: gears(),
            mutants: [
                { name: 'both gears turn the same way', reply: gears({ bTo: '720' }) },
                { name: 'small gear turns as slowly as the big one', reply: gears({ bTo: '-360' }) },
                { name: 'small gear slower (ratio applied upside down)', reply: gears({ bTo: '-180' }) },
                { name: 'the small gear never turns', reply: gears({ bAnimated: false }) },
                { name: 'labels spin inside the gears', reply: gears({ labelsInside: true }) },
            ],
        },
        {
            id: 'visuals-animation-water-cycle',
            run: animation(WATER_BRIEF),
            score: scoreWater,
            golden: water(),
            variants: [
                { name: 'there and back in one loop', reply: water({ move: '<animateTransform attributeName="transform" type="translate" values="0 0;240 0;0 0" keyTimes="0;0.5;1" dur="6s" repeatCount="indefinite"/>' }) },
                { name: 'moved along a motion path', reply: water({ move: '<animateMotion path="M0 0 L240 0" dur="6s" repeatCount="indefinite"/>' }) },
                {
                    name: 'droplet placed by its own translate',
                    reply: water({ move: '<animateTransform attributeName="transform" type="translate" values="0 0;100 0;200 0" keyTimes="0;0.5;1" dur="6s" repeatCount="indefinite"/>' })
                        .replace('<circle cx="60" cy="120" r="9"', '<circle transform="translate(100,120)" r="9"'),
                },
                {
                    name: 'the droplet itself animated, inside a translated group',
                    reply: water({ move: '' }).replace('<g>\n<circle cx="60" cy="120" r="9" fill="#2563eb" stroke="#1e3a8a" stroke-width="2"/>',
                        '<g transform="translate(100,0)">\n<circle cx="-40" cy="120" r="9" fill="#2563eb" stroke="#1e3a8a" stroke-width="2"><animateTransform attributeName="transform" type="translate" values="0 0;120 0;240 0" keyTimes="0;0.5;1" dur="6s" repeatCount="indefinite"/></circle>'),
                },
            ],
            mutants: [
                { name: 'only a colour pulse, nothing moves', reply: water({ move: '<animate attributeName="opacity" values="1;0.3;1" dur="3s" repeatCount="indefinite"/>' }) },
                { name: 'stations in the wrong order', reply: water({ labels: ['Rain', 'Condensation', 'Evaporation'] }) },
                { name: 'type 11 units', reply: water({ fs: 11 }) },
                { name: 'a label rides along with the droplet', reply: water({ labelsMove: true }) },
                { name: 'droplet barely moves', reply: water({ move: '<animateTransform attributeName="transform" type="translate" values="0 0;15 0;30 0" keyTimes="0;0.5;1" dur="6s" repeatCount="indefinite"/>' }) },
                { name: 'keyTimes shorter than values', reply: water({ move: '<animateTransform attributeName="transform" type="translate" values="0 0;120 0;240 0" keyTimes="0;1" dur="6s" repeatCount="indefinite"/>' }) },
                { name: 'a label runs off the right edge', reply: water({ xs: [60, 180, 350] }) },
                { name: 'keyTimes holds a non-number', reply: water({ move: '<animateTransform attributeName="transform" type="translate" values="0 0;120 0;240 0" keyTimes="0;half;1" dur="6s" repeatCount="indefinite"/>' }) },
                { name: 'keyTimes with an empty slot', reply: water({ move: '<animateTransform attributeName="transform" type="translate" values="0 0;120 0;240 0" keyTimes="0;;1" dur="6s" repeatCount="indefinite"/>' }) },
                { name: 'keyTimes with a unit glued on', reply: water({ move: '<animateTransform attributeName="transform" type="translate" values="0 0;120 0;240 0" keyTimes="0;0.5s;1" dur="6s" repeatCount="indefinite"/>' }) },
                { name: 'the droplet runs the wrong way', reply: water({ move: '<animateTransform attributeName="transform" type="translate" values="0 0;-120 0;-240 0" keyTimes="0;0.5;1" dur="6s" repeatCount="indefinite"/>' }) },
                { name: 'the droplet starts past the last station', reply: water({ move: '<animateTransform attributeName="transform" type="translate" values="300 0;420 0;540 0" keyTimes="0;0.5;1" dur="6s" repeatCount="indefinite"/>' }) },
            ],
        },
        {
            id: 'visuals-p5-random-walkers',
            run: (fx, app) => app.server('visualAuthor.js').then(m => m.authorVisual({ kind: 'p5', brief: WALKERS_BRIEF })),
            score: isolated('walkers'),
            golden: walkers(),
            mutants: [
                { name: 'background() is the last call, not the first', reply: walkers({ bgFirst: false }) },
                { name: 'drifts right and runs off the canvas', reply: walkers({ clamp: false, drift: ' + 1.2' }) },
                { name: 'deterministic wobble, no randomness', reply: walkers({ step: 'sin(frameCount * 0.3 + w.x) * 1.5' }) },
                { name: 'labels with text()', reply: walkers({ legendCall: '', textCall: 'text("walker", 20, 20);' }) },
                { name: 'only 4 walkers', reply: walkers({ count: 4 }) },
                { name: 'walkers start in a corner', reply: walkers({ start: '20, 20' }) },
                { name: 'each walker drawn twice after the first frame', reply: walkers({ drawExtra: '\n    if (frameCount > 1) ellipse(w.x + 1, w.y, 6, 6);' }) },
                { name: 'walkers vanish over time', reply: walkers({ frameExtra: '\n  if (frameCount % 50 === 0) walkers.pop();' }) },
                { name: 'the legend drops after the first frame', reply: walkers({ legendCall: 'if (frameCount === 1) legend([["walker", 37, 99, 235]]);' }) },
                { name: 'a promise chain that never ends', reply: walkers({ setupExtra: '\n  Promise.resolve().then(function f() { Promise.resolve().then(f); });' }) },
                { name: 'Java-style declarations', reply: 'float x = 300;\nfloat y = 170;\nvoid setup() {\n  createCanvas(600, 340);\n}\nvoid draw() {\n  background(255);\n  ellipse(x, y, 6, 6);\n}' },
            ],
        },
        {
            id: 'visuals-widget-unit-converter',
            run: widget(KM_SPEC),
            score: isolated('km'),
            golden: kmDoc(),
            mutants: [
                { name: 'multiplies instead of dividing', reply: kmDoc({ expr: 'v * 1.609344' }) },
                { name: 'updates only on the Convert button', reply: kmDoc({ listen: '' }) },
                { name: 'updates on change only (after the field loses focus)', reply: kmDoc({ listen: 'km.addEventListener("change", update);' }) },
                { name: 'live result in a hidden element', reply: kmDoc({ script: ghostScript('ghost.hidden = true;') }) },
                { name: 'live result under display:none', reply: kmDoc({ script: ghostScript('ghost.className = "ghost";'), extraCss: '\n.ghost { display: none; }' }) },
                { name: 'live result under visibility:hidden', reply: kmDoc({ script: ghostScript('ghost.style.visibility = "hidden";') }) },
                { name: 'the Kilometres label is hidden', reply: kmDoc({ extraCss: '\nlabel[for="km"] { display: none; }' }) },
                { name: 'a rounded factor 0.62', reply: kmDoc({ expr: 'v * 0.62' }) },
                { name: 'shows a fixed number', reply: kmDoc({ script: 'document.getElementById("mi").textContent = "6.21";' }) },
                { name: 'hardcoded colours, defines the host variables', reply: kmDoc({ css: ':root { --w-bg: #ffffff; --w-fg: #111111; }\nbody { background: #ffffff; color: #111111; }' }) },
                { name: 'loads a library from the network', reply: kmDoc({ extraHead: '<script src="https://cdn.example.com/lib.js"></script>' }) },
                { name: 'a loop that never ends', reply: kmDoc({ initial: 'update();\nwhile (true) {}' }) },
            ],
        },
        {
            id: 'visuals-widget-quiz-score',
            run: widget(QUIZ_SPEC),
            score: isolated('quiz'),
            golden: quizDoc(),
            mutants: [
                { name: 'every answer counts as correct', reply: quizDoc({ anyCorrect: true }) },
                { name: 'the score never changes', reply: quizDoc({ stuck: true }) },
                { name: 'wrong key: 54 is marked right', reply: quizDoc({ right: '54' }) },
                { name: 'Reset leaves the message up', reply: quizDoc({ resetKeeps: true }) },
                { name: 'the score is visibility:hidden', reply: quizDoc({ extraCss: '\n#score { visibility: hidden; }' }) },
                { name: 'the message is display:none', reply: quizDoc({ extraCss: '\n#msg { display: none; }' }) },
                { name: 'hardcoded colours', reply: quizDoc({ css: 'body { background: #fff; color: #000; }\nbutton { background: rgb(37, 99, 235); }' }) },
            ],
        },
    ],
};

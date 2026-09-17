import {
    stampArrivalOrder, settleArrival, settleArrivalPart,
    ARRIVAL_LEAD_MS, ARRIVAL_CURVE_MS, ARRIVAL_STAGE_MS,
} from '../visuals/arrival';
import { getVisualKind } from '../visuals/registry';

/**
 * Switching a visual kind ON clears its sample and draws it back.
 *
 * The drawing part is not invented here: it is the same `arrival.ts` plan the
 * visual gets the first time it is drawn into a lesson, so what the switch
 * shows you is literally what you have just turned on — a flowchart connecting
 * itself edge by edge in reading order, a curve drawing left to right, a
 * molecule's bonds growing between its atoms. Turning a kind off is not an
 * event and animates nothing; the card just greys out.
 *
 * What the gallery adds is the DISSOLVE in front of it. Replaying an arrival
 * over a picture that never went away asks the eye to watch something reappear
 * on top of itself, and the two halves fight: the card ends where it started
 * with a shimmer in between. Fading the sample out first gives the arrival an
 * empty stage, and the switch a beginning, a middle and an end. The stage
 * itself does not fade or rise on the way back (`vk-flat`) — the parts are what
 * arrives, and a box that moves while its contents arrive is a card jiggling.
 *
 * The dissolve also OWNS the un-muting, which is why its keyframe starts from
 * the muted look rather than from opacity 1 (index.css). A switched-off card is
 * grey and dim; React drops that class on the same commit that starts this, so
 * the card used to pop to full brightness on the first frame and then colour in
 * over 300ms while the dissolve faded it out — three motions at once, in
 * different directions. Now the grey is held for the length of the dissolve and
 * the colour is cut in on the empty stage.
 *
 * TWO KINDS GET MORE THAN THE PLAN, because for them the plan says nothing
 * about what the kind IS. A chart's marks fading in says "a picture appeared";
 * what a chart does is hold NUMBERS, so its bars GROW out of the axis, each at
 * its own speed, and you watch the drawing arrive at the data. A curve drawing
 * itself left to right says "a line appeared"; what a graph does is follow a
 * FORMULA, so a wave runs along it WHILE it draws and settles as the line
 * completes — one motion, not a drawing followed by a wobble. Both are played
 * here and nowhere else: in a lesson a visual arrives once and then holds
 * still, and a chart that pumped its bars every time it was scrolled past
 * would be a toy.
 *
 * `arrival.ts` is written for a first paint (`VisualBlock` stamps, waits, then
 * settles), so replaying it means taking the last stamp off, forcing a reflow
 * — without which re-adding the class restarts nothing, the browser sees no
 * change — and stamping again.
 */

/** The sample fades out over this before anything is drawn back. */
const DISSOLVE_MS = 260;
/** A bar grows out of the axis over this (the slowest one; see `spread`). */
const CHART_GROW_MS = 900;
/** Between one bar starting to grow and the next. */
const CHART_GROW_STEP_MS = 70;
/** The wave outlives the curve's own draw by this, so it settles just after it. */
const RIPPLE_TAIL_MS = 400;
/** How far the wave carries a point off the curve, in px of the drawing. */
const RIPPLE_AMPLITUDE_PX = 9;
/** Waves across the visible x range, and how far they travel while it runs. */
const RIPPLE_WAVES = 2.5;
const RIPPLE_TRAVEL = 1.25;

const NOTHING = () => { /* this kind's reveal is the dissolve and the plan */ };

/**
 * The marks of a chart — its bars, points or line, never its axes or legend.
 * The same reading of "mark" `planVega` uses, so the two agree about which
 * pieces this file takes over.
 */
function chartMarks(el: HTMLElement): SVGElement[] {
    const svg = el.querySelector('svg.marks');
    if (!svg) return [];
    const marks: SVGElement[] = [];
    svg.querySelectorAll('.role-mark').forEach(group => {
        if (group.parentElement?.closest('.role-axis, .role-legend, .role-title')) return;
        Array.from(group.children).forEach(child => {
            if (child.tagName.toLowerCase() === 'title') return;
            marks.push(child as SVGElement);
        });
    });
    return marks;
}

/**
 * Every bar grows out of the axis to the height its number gives, each at its
 * own speed so the row arrives as a wave rather than as one block.
 *
 * `scaleY` about the bar's own bottom edge, which needs `transform-box:
 * fill-box` — without it the origin is the svg's viewport and the bars fly off
 * sideways. That is safe HERE and is exactly what `arrival.ts` forbids for a
 * part: a vega mark is positioned by its `d`, while a mermaid node is
 * positioned by a `transform` ATTRIBUTE that any CSS transform would replace.
 *
 * `fill: 'backwards'` is load-bearing: the bars are out of the fade plan, so
 * without it they would stand at full height through the delay and then start
 * moving — the pop the dissolve exists to prevent.
 */
function playChartGrow(el: HTMLElement): () => void {
    const marks = chartMarks(el);
    if (marks.length === 0) return NOTHING;

    const running = marks.map((mark, i) => {
        // Golden-ratio spacing: a spread of speeds that is deterministic and
        // does not repeat, where `i % 3` would beat in threes and read as a
        // pattern rather than as bars each taking their own time.
        const spread = (i * 0.6180339887) % 1;
        mark.style.setProperty('transform-box', 'fill-box');
        mark.style.setProperty('transform-origin', '50% 100%');
        return mark.animate(
            [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }],
            {
                duration: CHART_GROW_MS * (0.7 + 0.6 * spread),
                delay: ARRIVAL_LEAD_MS + i * CHART_GROW_STEP_MS,
                fill: 'backwards',
                easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
            },
        );
    });

    // The transform is on a keyframe, not on the element, so the bar is back at
    // its own height the moment the animation ends — these two properties are
    // the only thing left to put back.
    const settle = () => marks.forEach(mark => {
        mark.style.removeProperty('transform-box');
        mark.style.removeProperty('transform-origin');
    });
    let finished = 0;
    running.forEach(a => { a.onfinish = () => { if (++finished === running.length) settle(); }; });
    return () => { running.forEach(a => a.cancel()); settle(); };
}

/** `M`/`L` and the point that follows it, the two commands function-plot draws a curve with. */
const MOVE_RE = /([ML])\s*(-?[\d.]+(?:e[-+]?\d+)?)[\s,]+(-?[\d.]+(?:e[-+]?\d+)?)/gi;

/**
 * One curve, taken apart once so the wave below can put it back together
 * sixty times a second: `pieces` is [text, command, x, y, text, command, …],
 * which is what `String.split` with a three-capture pattern hands back.
 */
interface Rippling {
    el: SVGPathElement;
    original: string;
    pieces: string[];
    minX: number;
    spanX: number;
    /** When the curve's own draw starts — `arrival.ts` wrote it on the element. */
    delay: number;
}

function curvesToRipple(el: HTMLElement): Rippling[] {
    const out: Rippling[] = [];
    el.querySelectorAll<SVGPathElement>('svg.function-plot .content .graph path').forEach(path => {
        const original = path.getAttribute('d') || '';
        const pieces = original.split(MOVE_RE);
        // 4 entries per point plus the leading text: two points is the least
        // that can be a curve rather than an axis tick or a marker.
        if (pieces.length < 9) return;
        let minX = Infinity, maxX = -Infinity;
        for (let i = 2; i < pieces.length; i += 4) {
            const x = parseFloat(pieces[i]);
            if (!Number.isFinite(x)) return;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
        }
        if (!(maxX > minX)) return;
        const delay = parseFloat(path.style.animationDelay);
        out.push({ el: path, original, pieces, minX, spanX: maxX - minX, delay: Number.isFinite(delay) ? delay : ARRIVAL_LEAD_MS });
    });
    return out;
}

/** The curve's own `d`, with every point lifted by the wave passing through it. */
function rippled(curve: Rippling, phase: number, amplitude: number): string {
    const p = curve.pieces;
    let d = p[0];
    for (let i = 1; i < p.length; i += 4) {
        const x = parseFloat(p[i + 1]);
        const y = parseFloat(p[i + 2]);
        const u = (x - curve.minX) / curve.spanX;
        const dy = amplitude * Math.sin(2 * Math.PI * (u * RIPPLE_WAVES - phase));
        // The command needs no separator before its first number, and the
        // whitespace the split ate between x and y is one space again.
        d += `${p[i]}${p[i + 1]} ${(y + dy).toFixed(2)}${p[i + 3]}`;
    }
    return d;
}

/**
 * A wave travelling along the curve WHILE the curve draws itself, opening from
 * nothing and closing back to nothing — so the shape the reader is left with is
 * the shape the formula gives, to the digit. It starts on the same beat as the
 * draw (`arrival.ts` stamped that delay on the path, so it is read rather than
 * guessed) and outlives it by `RIPPLE_TAIL_MS`, which is what makes the two one
 * motion instead of a drawing followed by a wobble. The original `d` is put
 * back at the end anyway: a curve that stopped one frame early would keep a
 * kink for ever.
 */
function playCurveRipple(el: HTMLElement): () => void {
    const curves = curvesToRipple(el);
    if (curves.length === 0) return NOTHING;

    const startAt = Math.min(...curves.map(c => c.delay));
    const runFor = ARRIVAL_CURVE_MS + RIPPLE_TAIL_MS;
    let frame = 0;
    let begun = 0;
    const restore = () => curves.forEach(c => c.el.setAttribute('d', c.original));
    const step = (now: number) => {
        if (!begun) begun = now;
        const t = (now - begun) / runFor;
        if (t >= 1) { restore(); return; }
        const amplitude = RIPPLE_AMPLITUDE_PX * Math.sin(Math.PI * t);
        curves.forEach(c => c.el.setAttribute('d', rippled(c, t * RIPPLE_TRAVEL, amplitude)));
        frame = requestAnimationFrame(step);
    };
    const timer = window.setTimeout(() => { frame = requestAnimationFrame(step); }, startAt);
    return () => { window.clearTimeout(timer); cancelAnimationFrame(frame); restore(); };
}

/** The half after the dissolve: stamp the plan, let it play, add the kind's own motion. */
function drawBack(el: HTMLElement, renderKind: string): () => void {
    // An animation has its own clock rather than parts, so `stampArrivalOrder`
    // plans nothing for it: rewind the SMIL instead. Its scene is written to
    // BUILD before it plays (see the sample), and at time zero it is an empty
    // card — so the dissolve runs straight into the ground drawing itself.
    if (renderKind === 'animation') {
        el.querySelectorAll('svg').forEach(svg => {
            try { (svg as SVGSVGElement).setCurrentTime(0); } catch { /* not an SMIL document */ }
        });
    }

    const parts = stampArrivalOrder(el, renderKind);
    // The bars are this file's to move, so they are not the plan's to fade.
    if (renderKind === 'vega') chartMarks(el).forEach(settleArrivalPart);
    el.classList.add('vb-arrive', 'vk-flat');
    el.classList.remove('vk-dissolve');

    const extra = renderKind === 'vega' ? playChartGrow(el)
        : renderKind === 'plot' ? playCurveRipple(el)
            : NOTHING;

    const timer = window.setTimeout(() => {
        el.classList.remove('vb-arrive', 'vk-flat');
        settleArrival(el);
    }, Math.max(parts, ARRIVAL_STAGE_MS) + 80);

    return () => {
        window.clearTimeout(timer);
        el.classList.remove('vb-arrive', 'vk-flat');
        settleArrival(el);
        extra();
    };
}

export function playSampleArrival(el: HTMLElement, kind: string): () => void {
    // The setting names the fence language ("vega-lite"); the arrival plans and
    // everything below are keyed by renderer kind ("vega"), exactly as the
    // render call in VisualKindsPanel is.
    const renderKind = getVisualKind(kind) ?? kind;

    settleArrival(el);
    el.classList.remove('vb-arrive', 'vk-flat', 'vk-dissolve');
    void el.offsetWidth;
    el.classList.add('vk-dissolve');

    let stopDrawing: (() => void) | null = null;
    let cancelled = false;
    const timer = window.setTimeout(() => {
        if (!cancelled) stopDrawing = drawBack(el, renderKind);
    }, DISSOLVE_MS);

    return () => {
        cancelled = true;
        window.clearTimeout(timer);
        el.classList.remove('vk-dissolve');
        if (stopDrawing) stopDrawing();
        else {
            el.classList.remove('vb-arrive', 'vk-flat');
            settleArrival(el);
        }
    };
}

/**
 * A p5 sketch is not redrawn and not restarted: it has been running since the
 * page opened, and restarting it is a second of a blank sandbox booting before
 * anything happens. Instead the host asks the sketch itself to react —
 * `renderP5` gives every sandbox a `nudge` message and puts the token it
 * answers to on the iframe — and the flocking sample pushes its birds a little
 * way apart, which the three rules then undo while you watch.
 *
 * Nothing else about the card moves: no dissolve, no stage fade. A simulation
 * that is already alive does not need to be reintroduced.
 */
export function nudgeSketch(el: HTMLElement): void {
    tellSketch(el, { type: 'nudge' });
}

/**
 * A switched-off sketch greys ITSELF, because it cannot be greyed from outside:
 * a CSS filter on the frame would take the sketch's own backdrop with it, and
 * the frame must paint one — an iframe never composites over its parent
 * (measured in the same Edge these screenshots come from: a plain transparent
 * iframe over a #0f172a page paints #ffffff). Greying a backdrop that is the
 * stage's own colour puts a grey RECTANGLE on the card, which reads as the
 * card's paper changing colour, which is the one thing the mute must not do.
 *
 * So the host says "you are off" and the sample picks a grey ink. A sketch that
 * does not define `setMuted` ignores it, like every other sandbox message.
 */
export function muteSketch(el: HTMLElement, on: boolean): void {
    tellSketch(el, { type: 'mute', on });
}

/** The doorbell `renderP5` leaves for the host, and the token it answers to. */
function tellSketch(el: HTMLElement, message: { type: string; on?: boolean }): void {
    el.querySelectorAll('iframe').forEach(frame => {
        const token = frame.dataset.p5Token;
        if (!token || !frame.contentWindow) return;
        try { frame.contentWindow.postMessage({ __p5: token, ...message }, '*'); } catch { /* the sandbox is gone */ }
    });
}

/** Whether the reader has asked for less movement. Checked at the moment of
 *  playing, never cached: the setting can change while the page is open. */
export function reducedMotion(): boolean {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/**
 * Plays a CSS class once and takes it off again — the tilt on a card whose
 * sample is not a drawing (a drill is a button, so it has no parts to arrive).
 */
export function playClass(el: HTMLElement, className: string, ms: number): () => void {
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
    const timer = window.setTimeout(() => el.classList.remove(className), ms);
    return () => {
        window.clearTimeout(timer);
        el.classList.remove(className);
    };
}

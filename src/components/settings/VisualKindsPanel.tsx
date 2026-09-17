import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { dayHeaders } from '../../utils/locale';
import { MousePointer2, Sparkles } from 'lucide-react';
import { api } from '../../api';
import { useStore } from '../../store';
import Checkbox from '../Checkbox';
import { getVisualKind, loadRenderer } from '../visuals/registry';
import { readVisualPalette } from '../visuals/palette';
import { DrillLauncher } from '../drills/DrillLauncher';
import { playSampleArrival, nudgeSketch, muteSketch, playClass, reducedMotion } from './sampleReveal';

/**
 * Settings → AI & Models → "Visuals": what the tutor may draw, shown as the
 * things themselves.
 *
 * This replaced a three-way radio ("Auto / Always on / Off") that governed two
 * of eight kinds and named none of them. A learner deciding whether to allow
 * simulations wants to SEE a simulation; and the other six kinds — the ones a
 * small model gets right — were not switchable at all. So every kind is a card
 * with a live sample drawn by the real renderer, and a switch. A kind that is
 * off is greyed out and dropped from what the model is told; nothing already
 * generated stops rendering, because the gate decides what the model is
 * offered, never what the page can draw.
 *
 * The two expensive kinds keep their model-size gate: `visual_tier` is still
 * read on the server (`p5Allowed`), and the one switch under the grid is the
 * "offer them to any model" override the old "Always on" was.
 */

type Kind = 'mermaid' | 'vega-lite' | 'plot' | 'smiles' | 'drill' | 'animation' | 'p5' | 'widget';

interface KindSpec {
    id: Kind;
    /** The sample the real renderer draws (null = a static mock, see WidgetMock). */
    sample: string | null;
    /** The two hard kinds a small model gets wrong. */
    heavy?: boolean;
}

/**
 * The samples, in the reader's language.
 *
 * A thumbnail is the only place in Settings where the app writes WORDS INTO A
 * PICTURE — mermaid node labels, a caption inside an SVG, a drill's prompts —
 * and they went out untranslated because a spec is a string, not a `t()` call.
 * A Russian reader met "Observe → Ask → Test → Conclude" and "a projectile
 * follows a parabola" among otherwise Russian cards.
 *
 * Built from `t` rather than declared at module level, so switching the
 * language redraws them. The weekday names come from `Intl` through
 * `dayHeaders()` — a weekday is exactly what that rule is for — and everything
 * non-verbal (the chemistry SMILES, the sine plot, the flocking sketch) is left
 * alone: it carries no language to get wrong.
 *
 * `accent` is the learner's own colour (`palette.accent`), for the one sample
 * that NAMES a colour rather than letting its renderer pick one — the
 * animation, below. It moves with the accent for the same reason the mermaid
 * sample does: the panel redraws every card when the accent changes.
 */
function buildSamples(t: TFunction, accent: string): KindSpec[] {
    const days = dayHeaders(1);
    const q = (s: string) => JSON.stringify(s);
    return [
        {
            id: 'mermaid',
            // "Experiment", not "Test": `t("Test")` is already the label on the
            // endpoint button two panels up, and Russian renders both as "Тест"
            // — a noun there and a verb here. A separate key is the cheaper fix.
            sample: `flowchart LR\n  A[${q(t("Observe"))}] --> B[${q(t("Ask"))}]\n  B --> C[${q(t("Experiment"))}]\n  C --> D[${q(t("Conclude"))}]`,
        },
        {
            id: 'vega-lite',
            sample: JSON.stringify({
                mark: 'bar',
                data: {
                    values: [4, 7, 5, 9, 6].map((y, i) => ({ x: days[i], y })),
                },
                encoding: { x: { field: 'x', type: 'nominal', title: null, sort: null }, y: { field: 'y', type: 'quantitative', title: null } },
            }),
        },
        { id: 'plot', sample: '{"data":[{"fn":"sin(x)"}],"xAxis":{"domain":[-6.5,6.5]},"yAxis":{"domain":[-1.5,1.5]}}' },
        { id: 'smiles', sample: 'CC(=O)Oc1ccccc1C(=O)O' },
        {
            id: 'drill',
            sample: JSON.stringify({
                prompt_label: t("Capital of…"),
                modes: ['choice'],
                items: [
                    { prompt: t("France"), answer: t("Paris") }, { prompt: t("Japan"), answer: t("Tokyo") },
                    { prompt: t("Kenya"), answer: t("Nairobi") }, { prompt: t("Chile"), answer: t("Santiago") },
                    { prompt: t("Norway"), answer: t("Oslo") }, { prompt: t("Egypt"), answer: t("Cairo") },
                ],
            }),
        },
        {
            id: 'animation',
            // The scene BUILDS, and then it plays for as long as you watch: the
            // ground draws, the planned trajectory appears as a dashed guide,
            // the caption names what you are looking at — each of those ONCE
            // and frozen — and then the projectile flies the arc over and over,
            // painting the flight it actually took under itself.
            //
            // It used to be a ball going round and round a static picture, and
            // switching the kind on rewound that — a restart, which is not an
            // arrival: the one kind whose subject is TIME was the one whose card
            // said nothing about what turning it on gets you. The build is
            // `fill="freeze"` and does not repeat, so the rewind the switch does
            // (`setCurrentTime(0)`, sampleReveal.ts) replays it in full while the
            // idle card never dismantles itself — a loop that cleared the whole
            // scene left the card half-erased for a quarter of a second in every
            // cycle, which is what a photograph of it caught.
            //
            // It paints NO BACKDROP (a sample never declares one — see
            // index.css): a full-viewBox rect is remapped to the stage's
            // colour, and greying that when the card is switched off greys a
            // RECTANGLE of the card. Measured off the screenshots: the box read
            // #121620 inside a #0f172a card.
            //
            // The flight is the APP'S ACCENT, not the red it used to be. A
            // model's scene keeps the hue it chose — that is the whole of
            // `palette.ts`'s second rule, because the red vector is not the
            // blue one — but this scene is the app's own, describing itself in
            // a grid where every other card draws in the accent, and a red
            // ball among them reads as a warning rather than as the one thing
            // that moves.
            sample: `<svg viewBox="0 0 320 140" xmlns="http://www.w3.org/2000/svg">
<line x1="20" y1="110" x2="300" y2="110" stroke="#111111" stroke-width="2">
  <animate attributeName="x2" values="20;300" dur="0.6s" fill="freeze"/>
</line>
<path id="arc" d="M 40 110 Q 160 -10 280 110" fill="none" stroke="#64748b" stroke-width="1.5" stroke-dasharray="4 4" opacity="0">
  <animate attributeName="opacity" values="0;1" begin="0.5s" dur="0.55s" fill="freeze"/>
</path>
<path d="M 40 110 Q 160 -10 280 110" fill="none" stroke="${accent}" stroke-width="2" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" opacity="0">
  <animate attributeName="stroke-dashoffset" values="1;0;0;0" keyTimes="0;0.7;0.8;1" begin="1.2s" dur="3.2s" repeatCount="indefinite"/>
  <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.04;0.7;0.8;1" begin="1.2s" dur="3.2s" repeatCount="indefinite"/>
</path>
<circle r="9" fill="${accent}" opacity="0">
  <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.04;0.7;0.8;1" begin="1.2s" dur="3.2s" repeatCount="indefinite"/>
  <animateMotion begin="1.2s" dur="3.2s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;0.7;1" calcMode="linear"><mpath href="#arc"/></animateMotion>
</circle>
<text x="160" y="132" font-size="12" text-anchor="middle" fill="#111111" opacity="0">${t("a projectile follows a parabola")}
  <animate attributeName="opacity" values="0;1" begin="0.95s" dur="0.5s" fill="freeze"/>
</text>
</svg>`,
        },
    {
        id: 'p5',
        heavy: true,
        // Flocking, not a cloud of jittering dots. The blurb promises "live,
        // random or emergent behaviour" and a random walk shows the random half
        // and none of the emergent one: forty birds each obeying three local
        // rules, with no leader and no script, is the thing worth switching on.
        //
        // Switching the kind on does not restart it and does not redraw the
        // card: the sketch has been running since the page opened, and a
        // restart is a second of blank sandbox booting p5 before anything
        // happens. It is NUDGED instead (`nudge()` below, reached through the
        // one message `renderP5` lets a host send) — and a nudge adds a FORCE
        // for about a second, it never moves anything. Moving the birds was
        // the first attempt and it read as "insta teleports the arrows to the
        // side": a position written straight into is a cut, whatever it does
        // next. A force is the only thing a flock can be disturbed by from
        // outside and still look like a flock.
        sample: `let flock = [];
const SPEED = 1.5, VIEW = 38, PERSONAL = 15;
// The gathering pull a nudge starts: about a second at 60fps, and weaker than
// the separation rule (0.11) so the flock crowds instead of collapsing.
const GATHER_FRAMES = 60, GATHER_PULL = 0.09;
let gather = 0;
let muted = false, mutedMix = 0;
function setup() {
  createCanvas(320, 160);
  for (let i = 0; i < 40; i++) {
    flock.push({ p: createVector(random(width), random(height)), v: p5.Vector.random2D().mult(SPEED) });
  }
}
function nudge() { gather = GATHER_FRAMES; }
function setMuted(on) { muted = on; }
function draw() {
  background(255);
  noStroke();
  // Switched off, the birds go grey and the PAPER does not move — the card
  // cannot be greyed from outside, because a filter on the frame would take
  // the backdrop with it (index.css). Eased over about the 300ms the card's
  // own dimming takes, so the colour and the dimming arrive together instead
  // of the colour snapping under a fade. The theme layer wraps fill() at run
  // time, so an interpolated colour is themed like a literal one.
  mutedMix += ((muted ? 1 : 0) - mutedMix) * 0.12;
  fill(lerp(37, 140, mutedMix), lerp(99, 140, mutedMix), lerp(235, 140, mutedMix));
  for (const b of flock) {
    const align = createVector(), centre = createVector(), apart = createVector();
    let seen = 0, close = 0;
    for (const o of flock) {
      if (o === b) continue;
      const d = dist(b.p.x, b.p.y, o.p.x, o.p.y);
      if (d > VIEW) continue;
      align.add(o.v); centre.add(o.p); seen++;
      if (d < PERSONAL) { apart.add(p5.Vector.sub(b.p, o.p).div(max(d, 0.5))); close++; }
    }
    if (seen > 0) {
      b.v.add(align.div(seen).setMag(SPEED).sub(b.v).limit(0.07));
      b.v.add(centre.div(seen).sub(b.p).setMag(SPEED).sub(b.v).limit(0.04));
    }
    if (close > 0) b.v.add(apart.setMag(SPEED).sub(b.v).limit(0.11));
    if (gather > 0) {
      // A fourth rule while it lasts: steer toward the middle of the card, the
      // same shape as the other three (desired minus current, limited). The
      // strength is a sine bump over the second, so the pull arrives and
      // leaves without a jolt at either end, and since the speed below is
      // fixed what it changes is the DIRECTION — every bird curves.
      const pull = GATHER_PULL * sin(PI * (1 - gather / GATHER_FRAMES));
      b.v.add(createVector(width / 2 - b.p.x, height / 2 - b.p.y).setMag(SPEED).sub(b.v).limit(pull));
    }
    b.v.setMag(SPEED);
    b.p.add(b.v);
    if (b.p.x < -6) b.p.x = width + 6; else if (b.p.x > width + 6) b.p.x = -6;
    if (b.p.y < -6) b.p.y = height + 6; else if (b.p.y > height + 6) b.p.y = -6;
    push();
    translate(b.p.x, b.p.y);
    rotate(b.v.heading());
    triangle(6, 0, -4, 3.2, -4, -3.2);
    pop();
  }
  if (gather > 0) gather--;
}`,
        },
        { id: 'widget', heavy: true, sample: null },
    ];
}

function readOff(raw: string | undefined): Set<Kind> {
    return new Set(String(raw || '').split(',').map(s => s.trim()).filter(Boolean) as Kind[]);
}

/**
 * A kind's sample, drawn by its real renderer into a fixed-height stage. No
 * toolbar, no repair loop — it is a thumbnail. `inert` keeps the sample from
 * taking the pointer (a p5 sketch in an iframe would otherwise swallow taps
 * meant for the card's switch).
 */
function Sample({ kind, code, muted, reveal }: { kind: Kind; code: string; muted: boolean; reveal: number }) {
    const ref = useRef<HTMLDivElement>(null);
    const theme = useStore(s => s.theme);
    const accentColor = useStore(s => s.accentColor);
    const [failed, setFailed] = useState(false);
    // Read by the sandbox's `load` handler, which outlives the render that
    // attached it: a captured `muted` would be the value at render time.
    const mutedNow = useRef(muted);
    mutedNow.current = muted;

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        let cancelled = false;
        let cleanup: void | (() => void);
        const abort = new AbortController();
        setFailed(false);
        // The setting names the FENCE language ("vega-lite"); the registry
        // keys renderers by kind ("vega"), and the two differ for one of them.
        loadRenderer(getVisualKind(kind) ?? kind)
            .then(async render => {
                if (cancelled) return;
                const palette = readVisualPalette(theme);
                const scratch = document.createElement('div');
                cleanup = await render(scratch, code, {
                    isDark: palette.dark,
                    palette,
                    width: Math.max(240, (el.clientWidth || 320) - 16),
                    // What the stage can actually show: `h-40` less its `p-2`,
                    // measured rather than assumed because `ui_scale` moves the
                    // root rem under both. A renderer that picks its own height
                    // from its width is not shrunk by this box, it is clipped by
                    // it — see VisualContext.maxHeight.
                    maxHeight: Math.max(96, (el.clientHeight || 160) - 16),
                    signal: abort.signal,
                    autoBuild: false,
                });
                if (cancelled) { if (cleanup) cleanup(); return; }
                el.replaceChildren(...Array.from(scratch.childNodes));
                // A thumbnail has no controls. The animation renderer brings its
                // own pause/replay strip, which in a card that is itself one big
                // switch reads as two dead buttons under the picture.
                el.querySelectorAll('button').forEach(b => b.remove());
                // A sketch that is switched off greys ITSELF (`muteSketch`), so
                // it has to be told once it is running. Moving an iframe into
                // the live DOM reloads it, so this listener is added before
                // that load, not after it — and the sketch defines `setMuted`
                // while its document parses, so by `load` it is there.
                el.querySelectorAll('iframe').forEach(f => {
                    f.addEventListener('load', () => muteSketch(el, mutedNow.current));
                });
            })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => {
            cancelled = true;
            abort.abort();
            if (cleanup) cleanup();
        };
        // The accent is part of the palette (a mermaid node border, say), so a
        // change to it redraws the sample like it redraws every real visual.
        // Switching a kind on is NOT in here: a reveal plays over the sample
        // that is already drawn, and re-rendering to reveal it made the p5 card
        // a second of blank sandbox instead of a simulation reacting.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind, code, theme, accentColor]);

    // Switched off greys the sketch from the inside, both ways and at once —
    // the load handler above covers a sandbox that was not running yet.
    useEffect(() => {
        const el = ref.current;
        if (el && kind === 'p5') muteSketch(el, muted);
    }, [kind, muted]);

    // Switched ON: dissolve the sample and draw it back. Only forwards —
    // turning a kind off is not an event worth animating.
    const played = useRef(0);
    useEffect(() => {
        const el = ref.current;
        if (!el || reveal === 0 || reveal === played.current || muted || failed) return;
        played.current = reveal;
        if (reducedMotion()) return;
        // A simulation is already alive: it is asked to react, not redrawn, and
        // the card around it does not move at all.
        if (kind === 'p5') { nudgeSketch(el); return; }
        return playSampleArrival(el, kind);
    }, [reveal, kind, muted, failed]);

    return (
        <div
            ref={ref}
            aria-hidden="true"
            // `vk-sample`/`vk-muted` rather than Tailwind's own `grayscale
            // opacity-50` + transition: the dissolve has to START from the
            // muted look, so it is declared once in index.css where the
            // keyframe can read it.
            className={`visual-block-stage vk-sample h-40 overflow-hidden flex items-center justify-center p-2 bg-white dark:bg-slate-900 [&>*]:max-h-full [&_svg]:max-h-36 ${muted ? 'vk-muted' : ''} ${failed ? 'text-xs text-slate-400' : ''}`}
            // `inert` is a real attribute React 18 types as unknown; the string form is what the DOM wants.
            {...({ inert: '' } as Record<string, string>)}
        >
            {failed ? '—' : null}
        </div>
    );
}

/**
 * The drill sample is a launcher button, not a drawing, so it has no parts to
 * arrive: switching it on gives the card itself a short tilt — the same "yes,
 * this one" the other kinds get from their arrival.
 */
function DrillMock({ code, muted, reveal }: { code: string; muted: boolean; reveal: number }) {
    const ref = useRef<HTMLSpanElement>(null);
    const played = useRef(0);
    useEffect(() => {
        const el = ref.current;
        if (!el || reveal === 0 || reveal === played.current || muted) return;
        played.current = reveal;
        if (reducedMotion()) return;
        return playClass(el, 'vk-tilt', 760);
    }, [reveal, muted]);

    return (
        <span
            className={`vk-sample h-40 p-3 flex items-center bg-white dark:bg-slate-900 ${muted ? 'vk-muted' : ''}`}
            {...({ inert: '' } as Record<string, string>)}
        >
            <span ref={ref} className="block w-full"><DrillLauncher code={code} /></span>
        </span>
    );
}

/* ── the widget thumbnail ──────────────────────────────────────────────── */

const WIDGET_BARS = 7;
const ANGLE_MIN = 15, ANGLE_MAX = 75, ANGLE_REST = 45;
/** The demo drag, as (fraction of the drag, angle) — it ENDS where it starts,
 *  so the rest between runs holds a pose rather than snapping back to one. */
const DRAG_KEYS: [number, number][] = [[0, ANGLE_REST], [0.32, 68], [0.68, 22], [1, ANGLE_REST]];
/** The one demo, in ms from its start: reach, press, drag, let go, leave, rest. */
const DEMO = { press: 900, dragFrom: 1120, dragTo: 4620, release: 4820, gone: 5620, cycle: 7400 };

const smooth = (p: number) => p * p * (3 - 2 * p);
const mix = (a: number, b: number, p: number) => a + (b - a) * p;

/** The angle the hand is holding at `p` through the drag. */
function dragAngle(p: number): number {
    for (let i = 1; i < DRAG_KEYS.length; i++) {
        const [p0, a0] = DRAG_KEYS[i - 1];
        const [p1, a1] = DRAG_KEYS[i];
        if (p <= p1) return mix(a0, a1, smooth((p - p0) / (p1 - p0)));
    }
    return ANGLE_REST;
}

/**
 * A projectile's flight, sampled into the seven bars: peak height goes with
 * sin²θ, so dragging the slider pumps the whole arc up and flattens it again.
 * The physics is the point — a widget is a model you can push, not a picture
 * with a slider glued under it.
 */
function barHeights(angle: number): number[] {
    const rad = (angle * Math.PI) / 180;
    const peak = 0.1 + 0.9 * Math.sin(rad) ** 2;
    return Array.from({ length: WIDGET_BARS }, (_, i) => {
        const t = (i + 0.5) / WIDGET_BARS;
        return Math.max(6, peak * 4 * t * (1 - t) * 100);
    });
}

/**
 * The one kind with no free sample: a widget is compiled by a model, so this is
 * a hand-built still — which then sat there being still, and a still picture of
 * a slider is the one thing that cannot say what an interactive widget is. So
 * it demonstrates itself: a pointer reaches in, takes the handle, sweeps the
 * angle, and the bars follow the arithmetic while it moves.
 *
 * Driven by one rAF writing straight to the DOM rather than by React state —
 * sixty renders a second of a settings panel to move a slider 3px would be
 * absurd — and it runs only while the tab is on screen, the kind is switched
 * on, and the reader has not asked for less movement.
 */
function WidgetMock({ muted, play, reveal }: { muted: boolean; play: boolean; reveal: number }) {
    const { t } = useTranslation();
    const rootRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const fillRef = useRef<HTMLDivElement>(null);
    const knobRef = useRef<HTMLDivElement>(null);
    const cursorRef = useRef<HTMLDivElement>(null);
    const labelRef = useRef<HTMLSpanElement>(null);
    const barsRef = useRef<(HTMLDivElement | null)[]>([]);
    const startedAt = useRef(0);

    // A new run starts the moment the kind is switched on, so the demo IS the
    // feedback for the switch as well as the idle loop.
    useEffect(() => { startedAt.current = 0; }, [reveal]);

    useEffect(() => {
        const paint = (angle: number, hand: { x: number; y: number; on: number; press: number } | null) => {
            const frac = (angle - ANGLE_MIN) / (ANGLE_MAX - ANGLE_MIN);
            if (fillRef.current) fillRef.current.style.width = `${frac * 100}%`;
            if (knobRef.current) {
                knobRef.current.style.left = `${frac * 100}%`;
                knobRef.current.style.transform = `translate(-50%, -50%) scale(${1 + 0.25 * (hand?.press ?? 0)})`;
            }
            if (labelRef.current) labelRef.current.textContent = t("Angle {{deg}}°", { deg: Math.round(angle) });
            barsRef.current.forEach((bar, i) => {
                if (bar) bar.style.height = `${barHeights(angle)[i]}%`;
            });
            if (cursorRef.current) {
                cursorRef.current.style.opacity = String(hand?.on ?? 0);
                if (hand) cursorRef.current.style.transform = `translate(${hand.x}px, ${hand.y}px)`;
            }
        };

        if (!play || muted) {
            paint(ANGLE_REST, null);
            return;
        }

        let frame = 0;
        const step = (now: number) => {
            frame = requestAnimationFrame(step);
            if (!startedAt.current) startedAt.current = now;
            const u = (now - startedAt.current) % DEMO.cycle;
            const track = trackRef.current, root = rootRef.current;
            if (!track || !root) return;

            const angle = u < DEMO.dragFrom ? ANGLE_REST
                : u < DEMO.dragTo ? dragAngle((u - DEMO.dragFrom) / (DEMO.dragTo - DEMO.dragFrom))
                    : ANGLE_REST === dragAngle(1) ? ANGLE_REST : dragAngle(1);
            const frac = (angle - ANGLE_MIN) / (ANGLE_MAX - ANGLE_MIN);

            // The slider's place in the CARD's own coordinates — which is the
            // space the pointer's `translate` is read in, since it is absolute
            // inside this stage.
            //
            // Measured as two rects, NEVER as `offsetLeft`/`offsetTop`: those
            // are relative to the offset PARENT, and for the ~300ms the
            // un-mute filter transition runs (`.vk-sample > *`, index.css) the
            // slider's own row is one — a non-`none` filter makes an element
            // the containing block for its absolutely positioned descendants,
            // and Chrome reports it as `offsetParent` accordingly. So for the
            // first third of a second after the kind was switched on, the hand
            // was placed in the ROW's coordinates: measured 110px too high and
            // 20px too far right, which drew a pointer in the top-right corner
            // of the card that then jumped down to the slider.
            const rootBox = root.getBoundingClientRect();
            const trackBox = track.getBoundingClientRect();
            const left = trackBox.left - rootBox.left, top = trackBox.top - rootBox.top;

            // Where the handle is, in the card's own coordinates.
            const onKnob = { x: left + frac * trackBox.width, y: top + trackBox.height / 2 };
            // Where a hand comes from: below and to the right, off the picture.
            const from = { x: left + trackBox.width + 18, y: top + 46 };

            let hand: { x: number; y: number; on: number; press: number };
            if (u < DEMO.press) {
                const p = smooth(u / DEMO.press);
                hand = { x: mix(from.x, onKnob.x, p), y: mix(from.y, onKnob.y, p), on: Math.min(1, p * 2), press: 0 };
            } else if (u < DEMO.dragFrom) {
                hand = { ...onKnob, on: 1, press: smooth((u - DEMO.press) / (DEMO.dragFrom - DEMO.press)) };
            } else if (u < DEMO.release) {
                hand = { ...onKnob, on: 1, press: 1 };
            } else if (u < DEMO.gone) {
                const p = smooth((u - DEMO.release) / (DEMO.gone - DEMO.release));
                hand = { x: mix(onKnob.x, from.x, p), y: mix(onKnob.y, from.y, p), on: 1 - p, press: 1 - Math.min(1, p * 4) };
            } else {
                hand = { ...from, on: 0, press: 0 };
            }
            paint(angle, hand);
        };

        frame = requestAnimationFrame(step);
        return () => cancelAnimationFrame(frame);
        // `t` is stable for a given language; re-running on it would only
        // restart the loop when the interface language changes, which is fine.
    }, [play, muted, reveal, t]);

    return (
        <div
            ref={rootRef}
            aria-hidden="true"
            className={`vk-sample relative h-40 p-4 flex flex-col justify-center gap-3 overflow-hidden bg-white dark:bg-slate-900 ${muted ? 'vk-muted' : ''}`}
        >
            <div className="flex items-end gap-1.5 h-16 px-1">
                {barHeights(ANGLE_REST).map((h, i) => (
                    <div
                        key={i}
                        ref={el => { barsRef.current[i] = el; }}
                        className="flex-1 rounded-t bg-accent/70 transition-[height] duration-100 ease-linear"
                        style={{ height: `${h}%` }}
                    />
                ))}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                <span ref={labelRef} className="w-16 shrink-0 tabular-nums">
                    {t("Angle {{deg}}°", { deg: ANGLE_REST })}
                </span>
                <div ref={trackRef} className="relative flex-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700">
                    <div ref={fillRef} className="absolute left-0 top-0 h-full w-1/2 rounded-full bg-accent" />
                    <div
                        ref={knobRef}
                        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white border-2 border-accent shadow"
                    />
                </div>
            </div>
            {/* The hand. Drawn last so it passes over the slider, and given a
                shadow so it stays readable on a bar and on the paper alike. */}
            <div
                ref={cursorRef}
                className="absolute left-0 top-0 opacity-0 pointer-events-none will-change-transform"
                style={{ transform: 'translate(-100px, -100px)' }}
            >
                <MousePointer2 className="w-4 h-4 -mt-0.5 -ml-0.5 fill-white stroke-slate-700 dark:fill-slate-800 dark:stroke-slate-100 drop-shadow" />
            </div>
        </div>
    );
}

export default function VisualKindsPanel({ active }: { active: boolean }) {
    const { t: tr } = useTranslation();
    const theme = useStore(s => s.theme);
    const accentColor = useStore(s => s.accentColor);
    // Rebuilt when the language changes — the words are INSIDE the pictures, so
    // a stale spec would leave four English labels in a Russian panel — and when
    // the accent moves, because one sample NAMES a colour (see `buildSamples`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const samples = useMemo(() => buildSamples(tr, readVisualPalette(theme).accent), [tr, theme, accentColor]);
    const addToast = useStore(s => s.addToast);
    const [off, setOff] = useState<Set<Kind>>(new Set());
    const [anyModel, setAnyModel] = useState(false);
    const [loaded, setLoaded] = useState(false);
    // Bumped when a kind is switched ON, which is what tells its sample to play
    // its arrival again. Off is not an event: the card greys out and that is all.
    const [reveal, setReveal] = useState<Partial<Record<Kind, number>>>({});

    const NAMES: Record<Kind, { title: string; blurb: string }> = {
        mermaid: { title: tr("Diagrams"), blurb: tr("Flowcharts, mind maps, timelines, state machines — how ideas connect.") },
        'vega-lite': { title: tr("Charts"), blurb: tr("Bar, line and scatter charts of given data.") },
        plot: { title: tr("Function graphs"), blurb: tr("A formula drawn over a range; the app computes the curve.") },
        smiles: { title: tr("Molecules"), blurb: tr("Chemical structures from a SMILES string.") },
        drill: { title: tr("Practice drills"), blurb: tr("A quick game of short prompt→answer pairs, for facts learned by repetition.") },
        animation: { title: tr("Animations"), blurb: tr("Something that moves or changes over time, drawn by a second AI pass.") },
        p5: { title: tr("Simulations"), blurb: tr("Live, random or emergent behaviour: diffusion, flocking, random walks.") },
        widget: { title: tr("Interactive widgets"), blurb: tr("Sliders and buttons driving a live model — built by a second AI pass, cached once built.") },
    };

    const load = useCallback(async () => {
        try {
            const s = await api.getSettings();
            const set = readOff(s.visual_kinds_off);
            // The retired "Off" tier meant exactly "no simulations, no widgets";
            // read it as those two switches so an old choice survives verbatim.
            if (s.visual_tier === 'basic') { set.add('p5'); set.add('widget'); }
            setOff(set);
            setAnyModel(s.visual_tier === 'full');
            setLoaded(true);
        } catch { /* the panel keeps its defaults */ }
    }, []);
    useEffect(() => { if (active && !loaded) void load(); }, [active, loaded, load]);

    const toggle = async (kind: Kind) => {
        const next = new Set(off);
        if (next.has(kind)) {
            next.delete(kind);
            setReveal(r => ({ ...r, [kind]: (r[kind] ?? 0) + 1 }));
        } else {
            next.add(kind);
        }
        setOff(next);
        try {
            await api.setSetting('visual_kinds_off', [...next].join(','));
            // A switched-off "basic" tier would keep p5/widget off whatever the
            // switches say; the kinds list is the truth now.
            if (!anyModel) await api.setSetting('visual_tier', 'auto');
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    const toggleAnyModel = async (on: boolean) => {
        setAnyModel(on);
        try {
            await api.setSetting('visual_tier', on ? 'full' : 'auto');
        } catch (e: any) {
            addToast('error', tr("Failed to save"), e.message);
        }
    };

    return (
        <>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-accent-fg" /> {tr("Visuals")}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                {tr("What the tutor may draw into a lesson or a reply. Switch a kind off and the model is no longer told about it; anything already drawn still shows.")}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {samples.map(spec => {
                    const enabled = !off.has(spec.id);
                    const name = NAMES[spec.id];
                    return (
                        // The whole card is the switch — sample included. The label wraps
                        // everything and the stage is `pointer-events-none`, so a click on
                        // the picture (or on a p5 sketch's iframe) hit-tests through to the
                        // label instead of being swallowed. `htmlFor` is not optional with
                        // it: a label with no `for` takes the FIRST labelable descendant,
                        // and the drill sample is itself a button element sitting before
                        // the checkbox — clicking that card opened the drill.
                        //
                        // `select-none` because the card is a SWITCH: two clicks on it
                        // are a normal thing to do (off, then on again to watch the
                        // sample play), and a double click on a label selects the word
                        // under it — which on Edge pops the browser's own selection
                        // mini-menu ("Hide menu / More actions") over the card. Nothing
                        // here is text anyone wants to copy.
                        <label
                            key={spec.id}
                            htmlFor={`visual-kind-${spec.id}`}
                            className={`group block select-none rounded-xl border overflow-hidden bg-white dark:bg-slate-800 shadow-sm cursor-pointer transition-[box-shadow,border-color] can-hover:group-hover:shadow-md can-hover:hover:ring-2 can-hover:hover:ring-accent/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${enabled ? 'border-slate-200 dark:border-slate-700' : 'border-dashed border-slate-300 dark:border-slate-600'}`}
                        >
                            <span className="block pointer-events-none">
                                {spec.sample == null
                                    ? <WidgetMock muted={!enabled} play={active && enabled} reveal={reveal.widget ?? 0} />
                                    : spec.id === 'drill'
                                        ? <DrillMock code={spec.sample} muted={!enabled} reveal={reveal.drill ?? 0} />
                                        : <Sample kind={spec.id} code={spec.sample} muted={!enabled} reveal={reveal[spec.id] ?? 0} />}
                            </span>
                            <span className="flex items-start gap-3 px-4 py-3 border-t border-slate-100 dark:border-slate-700/70 transition-colors can-hover:group-hover:bg-accent/5">
                                <Checkbox
                                    id={`visual-kind-${spec.id}`}
                                    role="switch"
                                    checked={enabled}
                                    onChange={() => void toggle(spec.id)}
                                    className="mt-1"
                                />
                                <span className="min-w-0">
                                    <span className={`block text-sm font-medium ${enabled ? 'text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400'}`}>
                                        {name.title}
                                        {spec.heavy && (
                                            <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                                                {tr("needs a capable model")}
                                            </span>
                                        )}
                                    </span>
                                    <span className="block text-sm text-slate-500 dark:text-slate-400">{name.blurb}</span>
                                </span>
                            </span>
                        </label>
                    );
                })}
            </div>
            {/* Unlike the cards above, this one has no picture: it is a switch
                and four lines explaining it. So the LABEL is the tick and the
                sentence that names it, and the explanation is ordinary prose
                beside them — not part of the control.

                As one label the card was a 326×180px tap target of which 148px
                was the explanation, and a press anywhere in those words turned
                the override on. Measured on a new library: tapping the middle
                of the paragraph wrote `visual_tier=full`, which reads
                afterwards exactly like a default nobody chose. A card whose
                whole surface is the switch is right when the surface is a
                sample you are being shown; it is wrong when the surface is the
                reason you are being asked. */}
            <div className="mt-3 bg-white dark:bg-slate-800 rounded-xl p-4 shadow-sm">
                <label htmlFor="visual-any-model" className="flex items-start gap-3 cursor-pointer select-none">
                    <Checkbox
                        id="visual-any-model"
                        checked={anyModel}
                        onChange={v => void toggleAnyModel(v)}
                        aria-describedby="visual-any-model-why"
                        className="mt-0.5"
                    />
                    <span className="min-w-0 text-sm font-medium text-slate-900 dark:text-white">
                        {tr("Offer simulations and widgets to any model")}
                    </span>
                </label>
                <p id="visual-any-model-why" className="mt-1.5 pl-[1.875rem] text-sm text-slate-500 dark:text-slate-400">
                    {tr("By default the two hardest kinds are offered only to a model of about 14B or more, or a hosted one — the size is read from the model's name. Turn this on if your model is capable but its name carries no size (a llama-swap alias, an API endpoint).")}
                </p>
            </div>
        </>
    );
}

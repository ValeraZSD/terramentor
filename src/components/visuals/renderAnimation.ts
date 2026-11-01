import type { VisualRenderer } from './registry';
import { sanitizeAnimatedSvg, smallestLabelUnits } from './sanitizeSvgAnim';
import { legibleStageWidth } from './animationStage';
import { themeSvgColors } from './palette';
import { resolveVisualSpec } from './resolveBrief';
import { animationLoopSeconds, fitSvgLabels } from './svgLabelFit';
import { probeMotion } from './svgFrames';
import i18n from '../../i18n';

// Tier A of the animation system: the model emits one
// animated SVG (SMIL and/or CSS keyframes) in an ```animation fence and it
// renders inline — browser-native motion, no script execution, works offline.
// Sanitization in sanitizeSvgAnim.ts guarantees the markup is inert.

/** Class + injected rule that freezes CSS keyframe animations alongside SMIL. */
const PAUSED_CLASS = 'vb-anim-paused';
const PAUSE_STYLE = `svg.${PAUSED_CLASS} * { animation-play-state: paused !important; }`;

/**
 * Inline icons for the two controls — the same lucide outlines the rest of
 * the app uses. The characters ⏸ ▶ ↺ are not used because a phone renders them
 * as COLOUR EMOJI (a yellow pause tile on Android), which makes a control look
 * like a sticker.
 */
const ICONS = {
    pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    replay: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
};
function icon(name: keyof typeof ICONS): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function makeButton(label: string, title: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title;
    // Sized as a target, not as text: `text-xs` alone makes these 16px tall, and
    // pause/replay are the two controls a learner reaches for on a phone while
    // watching the thing move. 24px is the floor; `-my-1` keeps the strip's own
    // height where it was.
    // Slate-500 on the light stage: slate-400 there was 2.6:1, under the 4.5:1
    // floor, and read as a disabled control.
    btn.className = 'inline-flex min-h-6 items-center rounded px-1.5 -my-1 text-xs font-mono text-slate-500 dark:text-slate-400 hover:text-accent-fg transition-colors';
    return btn;
}

const renderAnimation: VisualRenderer = async (el, code, ctx) => {
    // The fence may hold a finished <svg> or a plain-words SCENE BRIEF the
    // specialist pass draws (resolveBrief.ts). Which one it is, is decided by
    // looking at it, so nothing already generated changes behaviour.
    const spec = await resolveVisualSpec('animation', code, ctx);
    if (spec.trim() !== code.trim()) ctx.onResolved?.(spec);

    // Keep a pristine copy: Replay swaps in a fresh clone, which restarts both
    // SMIL clocks and CSS animations from zero.
    const pristine = sanitizeAnimatedSvg(spec);
    // The model coloured this scene for a page it could not see — almost always
    // white paper, because that is what an SVG defaults to in its training data.
    // On a dark theme a `stroke="#1e293b"` arrow is not faint, it is absent, and
    // nothing downstream can tell that from a scene that drew nothing. Remap the
    // ink onto this theme's ladder and hold every real colour's hue while
    // lifting it over the contrast floor (see palette.ts). VisualBlock re-runs
    // this render when the theme changes, so a scene generated months ago
    // follows the theme it is being read in rather than the one it was born in.
    themeSvgColors(pristine, ctx.palette);

    // DOES ANYTHING MOVE? A generated animation can be dead-still or barely
    // move and still render as a perfectly good picture with pause and replay
    // under it — the sanitizer above repairs the timing lists that cause most
    // of that, and this probe catches the rest by LOOKING: a few frames of the
    // loop, rasterized at thumbnail size and compared. Identical frames are
    // not a subtle animation, they are a broken one, and the message names
    // the ways SMIL fails silently so the repair loop has something to fix.
    const loopSeconds = animationLoopSeconds(pristine);
    const moves = await probeMotion(pristine, loopSeconds);
    if (moves === false) {
        throw new Error('nothing moves — the browser is ignoring every animation in this scene. For each <animate>/<animateTransform>: keyTimes and values must be semicolon-separated lists of the SAME length, keyTimes running from 0 to 1; every animation needs dur; an <animateTransform> must be a CHILD of the <g> it moves; an object driven by <animateMotion> is drawn at the origin (the path supplies its position); and at least one element must change position, angle or size, not only opacity.');
    }

    const pauseStyle = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    pauseStyle.textContent = PAUSE_STYLE;
    pristine.appendChild(pauseStyle);

    const stage = document.createElement('div');
    stage.style.margin = '0 auto';
    // The legibility floor (animationStage.ts): the stage is the card's width
    // unless this scene's smallest label would paint under 12px there, and then
    // it buys the label that width and scrolls.

    // Re-appliable, because the viewBox is not final when this first runs.
    // `fitSvgLabels` below GROWS the frame to rescue labels that overflow it,
    // so a stage width computed once, from the width before the grow, would
    // quietly stop holding the floor exactly when a scene needs it most.
    const applyLegibleWidth = () => {
        const viewBox = pristine.getAttribute('viewBox');
        const intrinsicWidth = viewBox ? parseFloat(viewBox.trim().split(/[\s,]+/)[2]) : NaN;
        const labelled = Array.from(pristine.querySelectorAll('text')).some(t => t.textContent?.trim());
        stage.style.width = `${legibleStageWidth(intrinsicWidth, labelled ? smallestLabelUnits(pristine) : null, ctx.width)}px`;
    };
    applyLegibleWidth();

    let current: SVGSVGElement | null = null;
    // WCAG 2.3.3: motion-sensitive users get the first frame + an explicit Play.
    let paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const controls = document.createElement('div');
    controls.className = 'flex items-center justify-end gap-3 pt-2';
    const playBtn = makeButton('', '');
    const replayBtn = makeButton('', i18n.t("Restart the animation"));
    replayBtn.innerHTML = `${icon('replay')}<span>${i18n.t("replay")}</span>`;
    replayBtn.classList.add('gap-1');
    playBtn.classList.add('gap-1');
    controls.append(playBtn, replayBtn);

    const applyPauseState = () => {
        if (!current) return;
        if (paused) {
            current.pauseAnimations();
            current.classList.add(PAUSED_CLASS);
        } else {
            current.unpauseAnimations();
            current.classList.remove(PAUSED_CLASS);
        }
        playBtn.innerHTML = paused
            ? `${icon('play')}<span>${i18n.t("play")}</span>`
            : `${icon('pause')}<span>${i18n.t("pause")}</span>`;
        playBtn.title = paused ? i18n.t("Play the animation") : i18n.t("Pause the animation");
        playBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    };

    const mount = () => {
        const fresh = document.importNode(pristine, true);
        fresh.style.width = '100%';
        fresh.style.height = 'auto';
        fresh.style.display = 'block';
        if (current) current.replaceWith(fresh);
        else stage.appendChild(fresh);
        current = fresh;
        applyPauseState();
    };

    playBtn.addEventListener('click', () => {
        paused = !paused;
        applyPauseState();
    });
    replayBtn.addEventListener('click', () => {
        paused = false;
        mount();
    });

    mount();
    el.append(stage, controls);

    // Labels that run off the frame. The scene is measured where it is
    // actually laid out, which is after VisualBlock swaps this stage into the
    // document and un-hides it — so wait for a real width before measuring,
    // and give up quietly after a second rather than hold a reference to a
    // stage that was never attached. A grown viewBox is carried onto the
    // pristine copy so Replay does not shrink the frame back.
    // A timer, not requestAnimationFrame: rAF does not fire in a hidden tab,
    // and a feed card is routinely rendered while the tab is in the background.
    let tries = 0;
    const fitWhenLaidOut = () => {
        if (!current || !current.isConnected || current.getBoundingClientRect().width === 0) {
            if (++tries < 40) setTimeout(fitWhenLaidOut, 50);
            return;
        }
        const grown = fitSvgLabels(current);
        if (grown) {
            pristine.setAttribute('viewBox', current.getAttribute('viewBox') || '');
            // A wider frame at the same stage width is a smaller scene: give the
            // stage back the width the new frame needs to stay above the floor.
            applyLegibleWidth();
        }
    };
    setTimeout(fitWhenLaidOut, 0);
};

export default renderAnimation;

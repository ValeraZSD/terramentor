import type { VisualRenderer } from './registry';
import { p5ThemePrelude } from './sandboxTheme';
import { resolveVisualSpec } from './resolveBrief';
// Bundled locally by Vite (?url asset) — local-first, never a CDN fetch.
import p5Url from 'p5/lib/p5.min.js?url';
import i18n from '../../i18n';

// Tier B of the animation system (see decision D-020): the model emits a p5.js
// sketch (global-mode setup()/draw()) in a ```p5 fence and it runs live in a
// sandboxed iframe (allow-scripts only, opaque origin — no app cookies, no DOM,
// no storage). Renderer-in-the-loop: before showing anything we execute the
// sketch in a hidden probe iframe and wait for a first frame; a syntax error or
// a sketch that never creates a canvas throws, which feeds the shell's
// AI-repair loop with the real runtime error instead of silently showing a
// broken sandbox.

/**
 * The sketch runs in an opaque-origin sandbox (`allow-scripts`, no
 * `allow-same-origin`), so it cannot reach this page — but until this existed it
 * could still reach the NETWORK, and the widget path next door already injected
 * a CSP for exactly that reason. A model-authored sketch that beacons out breaks
 * the one claim SECURITY.md invites you to verify with a packet capture, and
 * would do it from inside the feature that renders "educational animations".
 *
 * `script-src` is deliberately the LOOSE part of this policy, and that is not a
 * compromise: the sketch is inline JavaScript this document exists to execute,
 * so tightening where scripts may come from protects nothing, while getting it
 * wrong silently blocks p5 itself and breaks every animation in the app. p5 is
 * bundled locally (`?url`, never a CDN) and a srcdoc document resolves relative
 * URLs against the PARENT's base, so it can arrive as this app's origin, as
 * `'self'`, or as a blob depending on how the bundle was built — all three are
 * allowed rather than guessed between. What actually closes the hole is
 * `default-src 'none'`, which covers connect-src: no fetch, XHR or WebSocket,
 * no remote images, no frames, whatever the sketch asks for.
 */
const sketchCsp = () =>
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
    `script-src 'unsafe-inline' 'self' blob: ${location.origin}; style-src 'unsafe-inline'; ` +
    `img-src data: blob:; media-src data: blob:; font-src data:;">`;

const PROBE_TIMEOUT_MS = 6000;
const MAX_HEIGHT = 560;

// Helper library injected ahead of every sketch (documented for the model in
// VISUALS_GUIDE, server/ai.js). Arrowhead trig and label layout are exactly
// what a small local model hallucinates (rotated-90° heads, labels positioned
// from moving quantities), so the model composes these instead of writing its
// own. Plain function declarations: a sketch that redefines one simply wins
// (its script tag runs later), and a top-level let/const of the same name in
// the sketch legally shadows the global, so existing sketches keep working.
// vec() is the "direction, not magnitude" primitive — it normalizes internally
// so a physical magnitude can never leak into pixel space.
const HELPER_PRELUDE = `
function arrow(x1, y1, x2, y2) { line(x1, y1, x2, y2); var a = atan2(y2 - y1, x2 - x1); push(); translate(x2, y2); rotate(a); line(0, 0, -10, -4); line(0, 0, -10, 4); pop(); }
function vec(x, y, dx, dy, len) { var m = Math.sqrt(dx * dx + dy * dy); if (m > 1e-9) arrow(x, y, x + (dx / m) * len, y + (dy / m) * len); }
function legend(entries) {
    push();
    textAlign(LEFT, CENTER); textSize(12);
    for (var i = 0; i < entries.length; i++) {
        var ly = 20 + i * 18;
        stroke(entries[i][1], entries[i][2], entries[i][3]); strokeWeight(3); line(14, ly, 34, ly);
        noStroke(); fill(226, 232, 240); text(entries[i][0], 40, ly);
    }
    pop();
}`;

/**
 * Self-contained sandbox document: p5 + bootstrap + sketch. The bootstrap
 * reports 'ok' (with canvas size) or 'error' to the parent, tagged with a
 * per-render token; on later per-frame errors it stops the loop and shows the
 * message inside the iframe. Honors prefers-reduced-motion by starting stopped
 * behind an explicit Play overlay.
 */
function buildSketchDoc(sketch: string, token: string, validate: boolean, themeJs: string): string {
    // Blank-canvas guard (probe only): a draw() with off-screen coordinates or
    // no real drawing runs fine but renders nothing. After the manual first
    // frame, sample the pixels — if every pixel is identical the sketch painted
    // nothing on-canvas, which is a silent logic bug (bad coords / origin
    // translated off-screen / draw() that never renders), not a thrown error.
    // Feed it to the repair loop instead of showing an empty box. Runs only in
    // the hidden probe, never the visible iframe, so a rAF-driven sketch whose
    // very first frame is legitimately sparse is never falsely failed on replay.
    const blankCheck = validate ? `
                try {
                    var g2d = c.getContext && c.getContext('2d');
                    if (g2d) {
                        var px = g2d.getImageData(0, 0, c.width, c.height).data;
                        var r0 = px[0], g0 = px[1], b0 = px[2], a0 = px[3], varied = false;
                        for (var i = 16; i < px.length; i += 16) {
                            if (px[i] !== r0 || px[i + 1] !== g0 || px[i + 2] !== b0 || px[i + 3] !== a0) { varied = true; break; }
                        }
                        if (!varied) { fail('the sketch drew nothing visible on-canvas — check that shapes are inside (0,0)-(width,height), that draw() actually renders each frame, and that translate() has not pushed the origin off-screen.'); return; }
                    }
                } catch (e) {}` : '';
    // Geometry guard (probe only): the semantic sibling of validateVega — a
    // sketch that scales a vector by a physical magnitude (v²/r → 400 px)
    // "runs fine" and even paints pixels, so neither the error hook nor the
    // blank check sees it. Wrap the coordinate-taking p5 primitives just
    // before the manual first frame, map each point through the live canvas
    // transform (so translate()/scale() are honored), and fail with a
    // repair-loop-ready message on NaN or far-out-of-bounds geometry. The
    // margin is deliberately generous (50% of the canvas per side): shapes
    // easing in from just off-screen are legitimate; a 400 px vector is not.
    // No unwrap needed — the probe iframe is discarded after the verdict.
    const geomGuard = validate ? `
                try {
                    var GW = c.width, GH = c.height, gmx = GW * 0.5, gmy = GH * 0.5;
                    window.__geomBad = null;
                    // Map each primitive to the EXTREME points of its footprint —
                    // not just its centre. A size-bearing shape (ellipse/circle/
                    // rect/arc) is checked at the corners of its bounding box, so
                    // an on-screen centre with a giant width/height (the 970px
                    // ellipse that used to slip through) is now caught.
                    var geomPts = function (name, a) {
                        switch (name) {
                            case 'line': return [a[0], a[1], a[2], a[3]];
                            case 'point': return [a[0], a[1]];
                            case 'text': return [a[1], a[2]];
                            case 'triangle': return [a[0], a[1], a[2], a[3], a[4], a[5]];
                            case 'quad': return [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]];
                            case 'rect': { var rw = +a[2] || 0, rh = (a[3] != null ? +a[3] : rw); return [+a[0], +a[1], +a[0] + rw, +a[1] + rh]; }
                            case 'circle': { var d = +a[2] || 0; return [+a[0] - d / 2, +a[1] - d / 2, +a[0] + d / 2, +a[1] + d / 2]; }
                            case 'ellipse': case 'arc': { var ew = +a[2] || 0, eh = (a[3] != null ? +a[3] : ew); return [+a[0] - ew / 2, +a[1] - eh / 2, +a[0] + ew / 2, +a[1] + eh / 2]; }
                            default: return [];
                        }
                    };
                    var geomChk = function (name, a) {
                        if (window.__geomBad) return;
                        var pts = geomPts(name, a), t;
                        if (!pts.length) return;
                        try { t = window.drawingContext.getTransform(); } catch (e) { return; }
                        for (var i = 0; i + 1 < pts.length; i += 2) {
                            var gx = Number(pts[i]), gy = Number(pts[i + 1]);
                            if (!isFinite(gx) || !isFinite(gy)) continue; // missing optional arg, not a bug
                            var dx = t.a * gx + t.c * gy + t.e, dy = t.b * gx + t.d * gy + t.f;
                            if (!isFinite(dx) || !isFinite(dy)) {
                                window.__geomBad = name + '() was called with a non-finite coordinate (NaN/Infinity) — check for division by zero and un-initialised variables.';
                                return;
                            }
                            if (dx < -gmx || dx > GW + gmx || dy < -gmy || dy > GH + gmy) {
                                window.__geomBad = name + '() reached (' + Math.round(gx) + ', ' + Math.round(gy) + '), far outside the ' + window.width + 'x' + window.height + ' canvas — keep the WHOLE shape on-canvas (its width/height too, not just its centre); size shapes in fixed pixels, and draw vectors as a unit direction times a fixed length like vec(x, y, dx, dy, 50), NEVER scaled by a physical magnitude.';
                                return;
                            }
                        }
                    };
                    ['line', 'ellipse', 'circle', 'rect', 'point', 'triangle', 'quad', 'arc', 'text'].forEach(function (name) {
                        var orig = window[name];
                        if (typeof orig !== 'function') return;
                        window[name] = function () {
                            geomChk(name, arguments);
                            return orig.apply(this, arguments);
                        };
                    });
                } catch (e) {}` : '';
    const geomVerdict = validate ? `
                if (window.__geomBad) { fail(window.__geomBad); return; }` : '';
    const bootstrap = `
(function () {
    var TOKEN = ${JSON.stringify(token)};
    var reported = false;
    function send(type, extra) {
        try { parent.postMessage(Object.assign({ __p5: TOKEN, type: type }, extra || {}), '*'); } catch (e) {}
    }
    function overlay(text, isError) {
        var d = document.createElement('div');
        d.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:16px;font:12px monospace;background:rgba(15,23,42,.82);color:' + (isError ? '#fca5a5' : '#e2e8f0') + ';cursor:' + (isError ? 'default' : 'pointer') + ';';
        d.textContent = text;
        document.body.appendChild(d);
        return d;
    }
    function fail(msg) {
        if (window.noLoop) try { window.noLoop(); } catch (e) {}
        if (!reported) { reported = true; send('error', { message: String(msg) }); }
        if (!document.querySelector('[data-p5-err]')) overlay('Sketch error: ' + String(msg), true).setAttribute('data-p5-err', '1');
    }
    window.onerror = function (msg) { fail(msg); return true; };
    window.__p5fail = fail;
    // The TWO things the host may ask a running sketch to do, both of them a
    // doorbell: react (nudge), and draw itself as switched off (mute). A sketch
    // that defines the function gets it called; every other sketch ignores the
    // message, nothing comes back, and nothing else is accepted.
    //
    // (No backticks in here: this whole bootstrap is a template literal, and
    // one in a comment ends the string — it cost a round.)
    //
    // The settings gallery uses nudge to disturb a flock without restarting the
    // sandbox: a restart is a second of blank card while p5 boots, which is not
    // feedback for pressing a switch. It uses mute because a sketch cannot be
    // greyed from outside: a CSS filter on the frame takes the BACKDROP with
    // it, and the frame must paint one (an iframe never composites over its
    // parent — measured: even a plain transparent one paints white), so the
    // grey rectangle that produces reads as the card's paper changing colour.
    window.addEventListener('message', function (e) {
        if (!e.data || e.data.__p5 !== TOKEN) return;
        try {
            if (e.data.type === 'nudge' && typeof window.nudge === 'function') window.nudge();
            else if (e.data.type === 'mute' && typeof window.setMuted === 'function') window.setMuted(!!e.data.on);
        } catch (err) { fail(err && err.message ? err.message : err); }
    });
    // p5 1.x runs setup() through a promise (async-setup support), so a throw
    // inside setup surfaces as a rejection, not window.onerror.
    window.addEventListener('unhandledrejection', function (e) {
        fail(e.reason && e.reason.message ? e.reason.message : e.reason);
        e.preventDefault();
    });
    window.addEventListener('load', function () {
        if (typeof window.setup !== 'function' && typeof window.draw !== 'function') {
            if (!reported) { reported = true; send('error', { message: 'the sketch must define setup() and draw() in p5 global mode.' }); }
            return;
        }
        var waited = 0;
        var poll = setInterval(function () {
            var c = document.querySelector('canvas');
            if (c) {
                clearInterval(poll);
                // The hidden probe iframe never gets a requestAnimationFrame
                // tick, so p5 will not run draw() there — call it once manually
                // to validate the first frame (the wrapper below reports the
                // error; an extra frame is harmless in the visible iframe).
${geomGuard}
                try { if (typeof window.draw === 'function') window.draw(); } catch (e) {}${geomVerdict}${blankCheck}
                // Grace window: a setup() that throws right after createCanvas()
                // must report the error, not a premature ok.
                setTimeout(function () {
                    if (reported) return;
                    reported = true;
                    var r = c.getBoundingClientRect();
                    send('ok', { w: Math.round(r.width), h: Math.round(r.height) });
                    if (matchMedia('(prefers-reduced-motion: reduce)').matches && window.noLoop) {
                        window.noLoop();
                        var p = overlay('▶ tap to play', false);
                        p.addEventListener('click', function () { p.remove(); window.loop(); });
                    }
                }, 250);
            } else if ((waited += 50) >= 3000) {
                clearInterval(poll);
                if (!reported) { reported = true; send('error', { message: 'the sketch never created a canvas — setup() must call createCanvas(width, height).' }); }
            }
        }, 50);
    });
})();`;
    // A literal </script> inside the sketch would terminate its script tag early.
    const safeSketch = sketch.replace(/<\/script/gi, '<\\/script');
    return `<!doctype html><html><head><meta charset="utf-8">
${sketchCsp()}
<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;display:flex;justify-content:center}canvas{display:block;max-width:100%;height:auto!important}</style>
<script src="${p5Url}"><\/script>
<script>${bootstrap}<\/script>
</head><body>
<script>${themeJs}<\/script>
<script>${HELPER_PRELUDE}<\/script>
<script>
${safeSketch}
// p5's loop catches user-code errors for its friendly-error system, which the
// min build strips — so draw() errors vanish silently. Wrap setup/draw before
// p5 captures them at init (on window load) to surface errors ourselves.
;(function () {
    ['setup', 'draw'].forEach(function (name) {
        var fn = window[name];
        if (typeof fn !== 'function') return;
        window[name] = function () {
            try { return fn.apply(this, arguments); }
            catch (e) { window.__p5fail(e && e.message ? e.message : e); throw e; }
        };
    });
})();
<\/script>
</body></html>`;
}

type SandboxMessage = { __p5?: string; type?: string; message?: string; w?: number; h?: number };

/** Run the doc in a hidden probe iframe until it reports ok/error or times out. */
function probeSketch(doc: string, token: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve, reject) => {
        const probe = document.createElement('iframe');
        probe.setAttribute('sandbox', 'allow-scripts');
        probe.style.cssText = 'position:fixed;left:-10000px;top:0;width:640px;height:480px;visibility:hidden;';
        const finish = (fn: () => void) => {
            window.removeEventListener('message', onMessage);
            clearTimeout(timer);
            probe.remove();
            fn();
        };
        const onMessage = (e: MessageEvent<SandboxMessage>) => {
            if (!e.data || e.data.__p5 !== token || e.source !== probe.contentWindow) return;
            if (e.data.type === 'ok') finish(() => resolve({ w: e.data.w || 600, h: e.data.h || 340 }));
            else finish(() => reject(new Error(e.data.message || 'the sketch failed to run.')));
        };
        const timer = setTimeout(
            () => finish(() => reject(new Error('the sketch did not start within 6s — keep setup()/draw() small and loop-free outside draw().'))),
            PROBE_TIMEOUT_MS,
        );
        window.addEventListener('message', onMessage);
        probe.srcdoc = doc;
        document.body.appendChild(probe);
    });
}

const renderP5: VisualRenderer = async (el, code, ctx) => {
    // The fence may hold a finished sketch or a plain-words SCENE BRIEF the
    // specialist pass writes (resolveBrief.ts). Decided by looking at it, so
    // every sketch already in the library still runs directly and for free.
    const sketch = (await resolveVisualSpec('p5', code, ctx)).trim();
    if (!sketch) throw new Error('empty sketch.');
    if (sketch !== code.trim()) ctx.onResolved?.(sketch);

    // Cheap syntax gate first: a SyntaxError here is a better repair prompt
    // than a sandbox timeout. The function is never invoked.
    try {
        new Function(sketch);
    } catch (e) {
        throw new Error(`JavaScript ${e instanceof Error ? e.message : String(e)}`);
    }

    // Missing-clear gate: a draw() that never calls background()/clear() paints
    // each frame on top of the last, smearing the animation to a solid block
    // within a second — a silent bug the execution probe can't see. The guide
    // requires background() as draw()'s first line; educational sketches are
    // never intentional-accumulation, so flag its total absence for the repair
    // loop (a false positive just gets a harmless per-frame clear added).
    if (!/\b(background|clear)\s*\(/.test(sketch)) {
        throw new Error('draw() never clears the canvas — call background(r, g, b) as the FIRST line of draw() so frames do not smear on top of each other.');
    }

    const token = Math.random().toString(36).slice(2);
    const themeJs = p5ThemePrelude(ctx.palette);
    const probeDoc = buildSketchDoc(sketch, token, true, themeJs);

    // Renderer-in-the-loop: validate by execution before anything is shown.
    const size = await probeSketch(probeDoc, token);

    // The display iframe only loads once the shell swaps it into the live DOM;
    // it re-reports its real canvas size then, and we keep listening to fit it.
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.title = i18n.t("Interactive p5.js animation");
    // Painted with the paper the sketch is about to paint itself with: an
    // iframe whose document has not parsed yet is a WHITE rectangle, whatever
    // its srcdoc's `background: transparent` will say a moment later. On a dark
    // theme that is a white flash for as long as the sandbox takes to boot p5,
    // which is most of a second — and re-rendering is not rare (a theme change,
    // and the settings gallery restarts the sketch every time the kind is
    // switched on, where the flash was the loudest thing in the card).
    frame.style.cssText = `display:block;border:0;margin:0 auto;width:100%;background:${ctx.palette.bg};`;
    // The token the sandbox answers to, where a host can find it: the only way
    // to reach a running sketch from outside this closure (see the `nudge`
    // listener above, and settings/sampleReveal.ts `nudgeSketch`).
    frame.dataset.p5Token = token;
    // ctx.width is already the stage's *content* width (the shell subtracts its
    // padding and borders), so no extra inset here — that only re-shrank an
    // already-small sketch on a phone.
    frame.style.maxWidth = `${Math.min(Math.max(size.w, 280), Math.max(ctx.width, 280))}px`;
    frame.style.height = `${Math.min(size.h, MAX_HEIGHT)}px`;
    // Display doc skips the blank-canvas probe: rAF drives it live, and probing
    // already proved the first frame renders — no need to re-judge on replay.
    frame.srcdoc = buildSketchDoc(sketch, token, false, themeJs);

    const onMessage = (e: MessageEvent<SandboxMessage>) => {
        if (!e.data || e.data.__p5 !== token || e.source !== frame.contentWindow) return;
        if (e.data.type === 'ok' && e.data.h) frame.style.height = `${Math.min(e.data.h, MAX_HEIGHT)}px`;
    };
    window.addEventListener('message', onMessage);

    el.appendChild(frame);
    return () => window.removeEventListener('message', onMessage);
};

export default renderP5;

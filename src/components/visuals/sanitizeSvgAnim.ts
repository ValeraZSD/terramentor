// Mechanical front line for ```animation blocks (animated SVG), per the D-018
// rule: deterministic sanitizers run before parse, LLM repair is the fallback.
//
// Local models wrap SVG in prose, forget xmlns, leave tags unclosed, or emit
// near-XML the strict parser rejects. The ladder here recovers everything
// mechanically recoverable, then scrubs the result (scripts, event handlers,
// external refs) — the output is inert markup that can only draw and animate.

/**
 * Grab the <svg>…</svg> span out of any surrounding prose/fence debris.
 * A model that restarts emits several <svg> roots in one fence; take the LAST
 * complete one (its final attempt), and reject the multi-root case loudly so
 * the repair loop collapses it back to a single clean block.
 *
 * A MISSING </svg> means the source was cut off mid-drawing (the model ran out
 * of budget, or a length cap sliced the message). That must throw: the HTML
 * parse ladder below would otherwise auto-close every dangling tag and render
 * the fragment as a perfectly valid HALF-DRAWN scene — no error, no repair, a
 * wave with five particles instead of fifteen. Silence is the bug.
 */
function extractSvg(code: string): string {
    const opens = (code.match(/<svg[\s>]/gi) || []).length;
    if (opens === 0) throw new Error('no <svg> element found — output one complete <svg viewBox="…" xmlns="http://www.w3.org/2000/svg"> element.');
    if (opens > 1) {
        throw new Error('the block contains more than one <svg> — you restarted or second-guessed. Emit exactly ONE finished <svg>, no alternatives, no planning notes.');
    }
    const start = code.search(/<svg[\s>]/i);
    const end = code.lastIndexOf('</svg>');
    if (end === -1) {
        throw new Error('the <svg> is never closed — the drawing was cut off partway through. Emit ONE complete <svg>…</svg>; keep the scene compact enough to finish it (fewer repeated elements, shorter attribute lists).');
    }
    return code.slice(start, end + '</svg>'.length);
}

/**
 * A reasoning-leak dump (the model narrating "let's try… no… okay…" inside
 * <!-- --> comments) renders as an empty scene but pollutes Source/Copy and
 * bloats the repair prompt. Comments never draw, so strip them unconditionally;
 * but when the comment text dwarfs the real markup it is a chain-of-thought
 * spill, not a stray note — throw so the repair loop re-emits a clean spec.
 */
function stripComments(svg: SVGSVGElement): void {
    const doc = svg.ownerDocument;
    const walker = doc.createTreeWalker(svg, NodeFilter.SHOW_COMMENT);
    const comments: Comment[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) comments.push(n as Comment);

    const commentChars = comments.reduce((sum, c) => sum + (c.textContent?.length ?? 0), 0);
    const markupChars = svg.innerHTML.length - commentChars;
    comments.forEach(c => c.remove());

    if (commentChars > markupChars && commentChars > 200) {
        throw new Error('the SVG is mostly comments — planning/reasoning prose leaked into the block. Output ONLY the finished markup: no comments, no notes, no "let\'s try…".');
    }
}

/**
 * Parse ladder: strict XML first; on failure re-parse as HTML (the HTML parser
 * auto-closes tags and knows SVG's camelCase names — animateMotion,
 * attributeName, repeatCount — via its adjustment tables) and serialize back.
 */
function parseSvg(src: string): SVGSVGElement {
    const parser = new DOMParser();

    const xml = parser.parseFromString(src, 'image/svg+xml');
    if (!xml.querySelector('parsererror') && xml.documentElement.tagName.toLowerCase() === 'svg') {
        return xml.documentElement as unknown as SVGSVGElement;
    }

    const html = parser.parseFromString(src, 'text/html');
    const recovered = html.querySelector('svg');
    if (!recovered) {
        const detail = xml.querySelector('parsererror')?.textContent?.split('\n')[0]?.trim();
        throw new Error(`the SVG is not well-formed${detail ? ` (${detail})` : ''} — close every tag and quote every attribute.`);
    }
    const reparsed = parser.parseFromString(new XMLSerializer().serializeToString(recovered), 'image/svg+xml');
    if (reparsed.querySelector('parsererror')) {
        throw new Error('the SVG is not well-formed — close every tag and quote every attribute.');
    }
    return reparsed.documentElement as unknown as SVGSVGElement;
}

/**
 * `<animate attributeName="transform" type="translate" values="0,0; 0,-20">` is
 * the single most common animation failure: `transform` is not animatable by
 * <animate> (and `type` only exists on <animateTransform>), so the browser
 * silently ignores it — the scene renders perfectly and sits perfectly still.
 * A still "animation" throws no error, so the repair loop never fires; nothing
 * catches it but the learner. Rewrite the element to <animateTransform>, which
 * is what the model meant, keeping every other attribute.
 *
 * The transform type comes from `type` if present, else from function syntax in
 * the values (`translate(…)`, `rotate(…)`) — those wrappers are then stripped,
 * since animateTransform takes bare arguments. If neither says what kind of
 * transform it is, we can't guess: throw and let the repair loop rewrite it.
 */
const TRANSFORM_TYPES = ['translate', 'rotate', 'scale', 'skewX', 'skewY'];

function fixTransformAnimations(svg: SVGSVGElement): void {
    const broken = Array.from(svg.querySelectorAll('animate[attributeName="transform"]'));
    for (const el of broken) {
        const valueAttrs = ['values', 'from', 'to', 'by'] as const;
        const declared = el.getAttribute('type');
        const inferred = TRANSFORM_TYPES.find(t =>
            valueAttrs.some(a => new RegExp(`\\b${t}\\s*\\(`).test(el.getAttribute(a) || '')),
        );
        const type = TRANSFORM_TYPES.find(t => t === declared) ?? inferred;
        if (!type) {
            throw new Error(
                '<animate attributeName="transform"> cannot animate a transform — use <animateTransform attributeName="transform" type="translate|rotate|scale" values="0 0; 10 0; 0 0"> instead (bare arguments, no translate(...) wrapper).',
            );
        }

        const fixed = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'animateTransform');
        for (const attr of Array.from(el.attributes)) fixed.setAttribute(attr.name, attr.value);
        fixed.setAttribute('type', type);
        // animateTransform values are bare arguments: "0 0; 10 0" — unwrap any
        // translate(0,0)/rotate(45) function syntax the model used.
        for (const a of valueAttrs) {
            const raw = el.getAttribute(a);
            if (raw) fixed.setAttribute(a, raw.replace(new RegExp(`\\b${type}\\s*\\(([^)]*)\\)`, 'g'), '$1'));
        }
        el.replaceWith(fixed);
    }
}

/**
 * SMIL timing lists the browser refuses SILENTLY.
 *
 * Measured over the 37 animations cached in the real library on 2026-09-05:
 * three did not move at all and six barely did, and every one of them was a
 * list problem rather than a drawing problem — `keyTimes="0 0.5 1"` written
 * with spaces, a `keyTimes` that ends at 0.82 (the model meant "hold there
 * until the loop restarts"), one entry fewer than `values`. SMIL's rule is that
 * an invalid timing list disables THAT animation entirely, with no error, so
 * the cars sit at their start positions for six seconds and the pebble is
 * "stuck in the top-left corner". A person then reports "nothing moves", the
 * drawer is asked to fix a fault it cannot see, and the next attempt carries
 * the same slip.
 *
 * Repaired where the intent is unambiguous (separators, a missing leading 0,
 * a hold at the end), thrown where it is not, so the repair loop is handed the
 * exact list. Runs at render time, so it reaches every drawing already cached.
 */
function fixTimingLists(svg: SVGSVGElement): void {
    for (const a of Array.from(svg.querySelectorAll('animate, animateTransform, animateMotion'))) {
        const tag = a.tagName;
        const name = a.getAttribute('attributeName') || (tag === 'animateMotion' ? 'motion' : '?');
        if (!a.getAttribute('dur')) {
            throw new Error(`<${tag} attributeName="${name}"> has no dur — an animation without a duration never runs; give it dur="4s" (the same dur as the rest of the scene).`);
        }
        const rawTimes = a.getAttribute('keyTimes');
        if (rawTimes == null) continue;
        const times = rawTimes.split(/[;\s]+/).filter(Boolean).map(Number);
        if (!times.length || times.some(n => !Number.isFinite(n) || n < 0 || n > 1)) {
            throw new Error(`<${tag} attributeName="${name}"> keyTimes="${rawTimes}" is not a semicolon-separated list of numbers from 0 to 1.`);
        }
        const rawValues = a.getAttribute('values');
        const values = rawValues != null ? rawValues.split(';').map(s => s.trim()).filter(Boolean) : null;
        const discrete = (a.getAttribute('calcMode') || '').toLowerCase() === 'discrete';

        if (times[0] !== 0) {
            times.unshift(0);
            values?.unshift(values[0]);
        }
        // "…;0.82" means hold there until the loop restarts — the one reading
        // that keeps every other keyframe where the author put it.
        if (!discrete && times[times.length - 1] < 1) {
            times.push(1);
            if (values && values.length === times.length - 1) values.push(values[values.length - 1]);
        }
        // A count mismatch is cut to the shorter list. Guessing which entry
        // the author dropped is impossible, but every keyframe that survives is
        // one they wrote, and an animation running on n−1 of its keyframes
        // beats one the browser switches off — which is what two of the real
        // library's cached drawings had been doing, one frozen part each.
        if (values && values.length !== times.length) {
            const n = Math.min(values.length, times.length);
            values.length = n;
            times.length = n;
            if (!discrete) times[n - 1] = 1;
        }
        for (let i = 1; i < times.length; i++) {
            if (times[i] < times[i - 1]) {
                throw new Error(`<${tag} attributeName="${name}"> keyTimes must never decrease (${times[i - 1]} is followed by ${times[i]}).`);
            }
        }
        a.setAttribute('keyTimes', times.join(';'));
        if (values) a.setAttribute('values', values.join(';'));

        // keySplines pairs with the INTERVALS, one fewer than the keyTimes; a
        // wrong count disables the animation too. Falling back to linear keeps
        // the motion and loses only the easing.
        const splines = a.getAttribute('keySplines');
        if (splines != null) {
            const count = splines.split(';').map(s => s.trim()).filter(Boolean).length;
            if (count !== times.length - 1) {
                a.removeAttribute('keySplines');
                if ((a.getAttribute('calcMode') || '').toLowerCase() === 'spline') a.removeAttribute('calcMode');
            }
        }
    }
}

/** Defense-in-depth scrub: the result may draw and animate, nothing else. */
function scrub(svg: SVGSVGElement): void {
    // Executable / embedding elements have no place in a drawing.
    svg.querySelectorAll('script, foreignObject, iframe, embed, object').forEach(n => n.remove());

    const all = [svg, ...Array.from(svg.querySelectorAll('*'))];
    for (const el of all) {
        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            const value = attr.value.trim().toLowerCase();
            // Event handlers and javascript: / data: URLs.
            if (name.startsWith('on') || value.startsWith('javascript:') || value.startsWith('data:text')) {
                el.removeAttribute(attr.name);
                continue;
            }
            // hrefs may only point inside the document (#gradient, #path-id).
            if ((name === 'href' || name === 'xlink:href') && !attr.value.trim().startsWith('#')) {
                el.removeAttribute(attr.name);
            }
        }
    }

    // <style> is allowed (CSS keyframe animations) but must not reach the network.
    svg.querySelectorAll('style').forEach(style => {
        style.textContent = (style.textContent || '')
            .replace(/@import[^;]*;/gi, '')
            .replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, 'none');
    });
}

/**
 * Sanitize an ```animation block into an inert, sized SVG element.
 * Throws a descriptive error (feeds the repair loop) on unrecoverable input.
 */
/**
 * Label text the author drew too small, raised to the floor the brief already
 * asked for.
 *
 * The brief says "nothing important is drawn smaller than 12 units" against the
 * ~600-unit viewBox it also asks for. Measured across the 42 stored animations
 * (279 text elements), 41% are authored under it — 8, 9, 10 and 11 units — and
 * the scene is then SHRUNK again to fit a card, so through the real renderer
 * 80% of all label text reached a desktop reader under 12px and 98% reached a
 * phone reader under 12px, bottoming out at 4.3px.
 *
 * Enforced here rather than prompted for a third time: this is a rule the
 * author was given and did not follow, and a deterministic fix beats a repair
 * round-trip (the D-018 doctrine the rest of this file is built on).
 *
 * The floor is PROPORTIONAL to the viewBox, not an absolute unit count — units
 * mean nothing on their own, only against the width they are drawn in. A scene
 * that chose a 1200-unit frame gets a 24-unit floor, and comes out the same
 * size on the page.
 *
 * Deliberately only raises, never lowers: a big title is a legitimate choice
 * and shrinking it is not this function's business. And deliberately modest —
 * the floor is the brief's own number, so the largest bump any stored scene
 * takes is 8→12 units. Text that grows collides with text that did not, and
 * `fitSvgLabels` only rescues labels that leave the FRAME.
 */
const REFERENCE_VIEWBOX_WIDTH = 600;
const MIN_LABEL_UNITS = 12;

/**
 * `font-size` declarations living in the scene's own `<style>` element.
 *
 * The third place a size can be written, and the one that hid from the first
 * version of this: a `<text>` with no attribute and no styled ancestor was
 * still painting at 9 units, because the author had written
 * `.label{font-size:9px}` in a stylesheet. Measured through the real renderer,
 * every remaining sub-floor label after the attribute pass came from here.
 *
 * Deliberately a value scan and not a CSS parse: which elements a selector
 * reaches cannot be answered without a layout engine, but "no declaration
 * anywhere in this document is below the floor" can be enforced without ever
 * knowing, and that is the property the floor actually needs.
 *
 * BOTH spellings, because the one that mattered was the shorthand. The last
 * sub-floor labels to survive every other pass were `.labB { font: 11px
 * sans-serif }` — a size a `font-size:` scan cannot see, on a rule reaching
 * every label in the scene. `font-family` and `font-weight` do not match: the
 * character after `font` must be a colon.
 */
const CSS_FONT_SIZE =
    /(font-size\s*:\s*|font\s*:\s*(?:(?:normal|italic|oblique|small-caps|bold(?:er)?|lighter|[1-9]00)\s+)*)([\d.]+)(px)?/gi;

function styleSheets(svg: SVGSVGElement): Element[] {
    return Array.from(svg.querySelectorAll('style'));
}

export function floorLabelSizes(svg: SVGSVGElement): number {
    const viewBox = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/);
    const width = parseFloat(viewBox[2]);
    if (!Number.isFinite(width) || width <= 0) return 0;
    const floor = MIN_LABEL_UNITS * (width / REFERENCE_VIEWBOX_WIDTH);

    let raised = 0;
    // `g` and the root `svg` too, not just the text itself: 295 of the 550
    // <text> elements in the stored library declare no size at all and take
    // one from an ancestor, so a floor that only reads the leaf misses the
    // author who set `<g font-size="9">` once and drew ten labels inside it.
    for (const node of [svg, ...Array.from(svg.querySelectorAll('text, tspan, g'))]) {
        // The attribute and the inline style are two different authors; both
        // are read, and whichever one carries the size is the one rewritten so
        // the other cannot win on the cascade afterwards.
        // `.style`, not `instanceof SVGElement`: a node parsed by a different
        // DOM realm (a gate's jsdom, a worker) fails the instance check while
        // being a perfectly ordinary element with a style declaration.
        const inline = (node as SVGElement).style?.fontSize || '';
        const attr = node.getAttribute('font-size');
        const raw = inline || attr;
        if (!raw) continue;
        // Only a bare number or an explicit `px` is in user units here; `em`,
        // `%` and the keywords are relative to something this cannot see, so
        // they are left exactly as written rather than guessed at.
        const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(raw);
        if (!m) continue;
        const size = parseFloat(m[1]);
        if (!Number.isFinite(size) || size <= 0 || size >= floor) continue;
        const next = String(Math.round(floor * 10) / 10);
        // The attribute takes a bare number (SVG user units); the CSS property
        // does NOT — a unitless value is invalid and silently dropped, which
        // would leave the label at its authored size with nothing to show for
        // the pass. `px` inside a viewBox IS a user unit, so the two agree.
        if (inline) (node as SVGElement).style.fontSize = `${next}px`;
        else node.setAttribute('font-size', next);
        raised += 1;
    }

    for (const sheet of styleSheets(svg)) {
        const css = sheet.textContent || '';
        if (!css) continue;
        const next = css.replace(CSS_FONT_SIZE, (whole, prefix: string, value: string, unit?: string) => {
            const size = parseFloat(value);
            if (!Number.isFinite(size) || size <= 0 || size >= floor) return whole;
            raised += 1;
            return `${prefix}${Math.round(floor * 10) / 10}${unit ?? 'px'}`;
        });
        if (next !== css) sheet.textContent = next;
    }

    return raised;
}

/**
 * The size of the smallest label in the scene, in viewBox units.
 *
 * `floorLabelSizes` can raise what an author DECLARED; it cannot make a 12-unit
 * label readable, because units are not pixels — a 600-unit scene fitted into a
 * 568px card paints 12 units at 11.4px, and into a phone at well under that. So
 * the renderer needs to know how small this particular scene's type is, in
 * order to decide how much of the card to give it (`renderAnimation`).
 *
 * Reads inherited sizes the way the browser does: the nearest ancestor that
 * declares one wins, and an SVG with no declaration anywhere is 16 user units
 * (the CSS initial `medium`, which is what every unsized `<text>` in the stored
 * library is actually drawn at). Empty and whitespace-only text is skipped —
 * a spacer is not a label.
 */
export function smallestLabelUnits(svg: SVGSVGElement, fallback = 16): number {
    const declared = (node: Element | null): number | null => {
        for (let el: Element | null = node; el; el = el.parentElement) {
            const raw = (el as SVGElement).style?.fontSize || el.getAttribute('font-size') || '';
            const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(raw);
            if (m) {
                const n = parseFloat(m[1]);
                if (Number.isFinite(n) && n > 0) return n;
            }
            if (el === svg) break;
        }
        return null;
    };

    let min = Infinity;
    // A stylesheet's declarations count even though which elements they reach is
    // unknowable here — a size written anywhere in the document is a size
    // something in the document is drawn at.
    for (const sheet of styleSheets(svg)) {
        for (const m of (sheet.textContent || '').matchAll(CSS_FONT_SIZE)) {
            const n = parseFloat(m[2]);
            if (Number.isFinite(n) && n > 0) min = Math.min(min, n);
        }
    }
    for (const node of Array.from(svg.querySelectorAll('text'))) {
        if (!node.textContent || !node.textContent.trim()) continue;
        // A <tspan> may re-declare a size for part of a line; take the smallest
        // thing actually drawn, not the <text>'s own value.
        const parts = Array.from(node.querySelectorAll('tspan'))
            .filter(t => t.textContent && t.textContent.trim());
        const sizes = (parts.length ? parts : [node]).map(el => declared(el) ?? fallback);
        min = Math.min(min, ...sizes);
    }
    return Number.isFinite(min) ? min : fallback;
}

export function sanitizeAnimatedSvg(code: string): SVGSVGElement {
    const svg = parseSvg(extractSvg(code.trim()));
    stripComments(svg);
    fixTransformAnimations(svg);
    fixTimingLists(svg);
    scrub(svg);

    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    // Normalize sizing: viewBox drives the aspect ratio, CSS drives the width.
    if (!svg.getAttribute('viewBox')) {
        const w = parseFloat(svg.getAttribute('width') || '');
        const h = parseFloat(svg.getAttribute('height') || '');
        if (w > 0 && h > 0) {
            svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        } else {
            throw new Error('the <svg> needs a viewBox attribute (e.g. viewBox="0 0 600 340").');
        }
    }
    svg.removeAttribute('width');
    svg.removeAttribute('height');

    floorLabelSizes(svg);

    const hasSmil = !!svg.querySelector('animate, animateTransform, animateMotion, set');
    const hasCss = /@keyframes|animation\s*:/.test(
        Array.from(svg.querySelectorAll('style')).map(s => s.textContent).join('') +
        Array.from(svg.querySelectorAll('[style]')).map(s => s.getAttribute('style')).join(''),
    );
    if (!hasSmil && !hasCss) {
        throw new Error('nothing is animated — add SMIL tags (<animate>, <animateTransform>, <animateMotion>) with dur and repeatCount="indefinite".');
    }

    // A transform/motion animation targets its PARENT element; when that parent
    // is the root <svg> the browser ignores it (transform on the outermost svg
    // has no effect) so the scene sits perfectly still. This is the "my rotation
    // doesn't move anything" bug: the model made <animateTransform> a sibling of
    // the <g> instead of its child. Detect the dead animation (no href retarget)
    // and feed the repair loop, since a still "animation" reads as broken.
    const rootMotion = Array.from(
        svg.querySelectorAll('animateTransform, animateMotion, animate[attributeName="transform"]'),
    ).find(a => a.parentNode === svg && !a.getAttribute('href') && !a.getAttribute('xlink:href'));
    if (rootMotion) {
        throw new Error(
            `<${rootMotion.tagName}> is a direct child of the root <svg>, so it animates the whole canvas and nothing moves — move it INSIDE the <g> or shape it should transform, and rotate about the orbit's center (type="rotate" from="0 cx cy" to="360 cx cy").`,
        );
    }

    // Text riding inside a rotating group spins and flips upside-down. A rotate
    // animateTransform transforms its parent, so any <text> under that parent is
    // dragged along. Catch it and feed the repair loop → labels move to a static
    // legend/caption outside the animated group.
    const spinningText = Array.from(svg.querySelectorAll('text')).find(t => {
        for (let p: Element | null = t.parentElement; p && p !== (svg as unknown as Element); p = p.parentElement) {
            if (p.querySelector(':scope > animateTransform[type="rotate"]')) return true;
        }
        return false;
    });
    if (spinningText) {
        throw new Error(
            'a <text> label sits inside the rotating <g>, so it spins and flips upside-down — move every <text> OUT of the animated group into a static legend or caption.',
        );
    }

    return svg;
}

import type { VisualContext, VisualRenderer } from './registry';
import { readVisualPalette, type VisualPalette } from './palette';
import {
    widgetThemeCss, widgetThemePrelude, widgetPalette, widgetRootFontCss, WIDGET_THEME_TAIL,
} from './widgetTheme';
import { useStore } from '../../store';
import { api } from '../../api';
import i18n from '../../i18n';
import { num } from '../../utils/numberFormat';
import { VisualUndrawnError, isUndrawnError, declinedReason } from './resolveBrief';

// Interactive widgets (D-022) — the Gemini "generative UI" two-agent split,
// local-first. The ```widget fence holds a small functional SPEC (Title /
// Objective / Data / Inputs / Behavior) the tutor wrote inline; compiling it
// into a runnable app is a SEPARATE, queued LLM pass on the server (the
// "construction crew"), which on a single-threaded local model starts only
// after the chat reply finishes streaming. The build is ONE self-contained
// HTML document that runs here in a sandboxed iframe (allow-scripts only,
// opaque origin, plus an injected CSP meta that forbids fetches, sockets and
// loads — though no CSP governs a frame navigating ITSELF, so a build could
// still leave by `location`; the opaque origin is why it has nothing to take).
//
// Renderer-in-the-loop, like p5: before anything is shown the build executes
// in a hidden probe iframe — with requestAnimationFrame shimmed to timeouts so
// its animation loop really runs — and a runtime error triggers ONE recompile
// that feeds the error (and the broken build) back to the builder. A second
// failure throws to the shell, whose "Fix with AI" rewrites the SPEC (the
// right lever at that point: simplify what was asked for).
//
// Verified builds are cached server-side by spec hash, so history blocks
// re-render instantly and never silently start an expensive build: on a cache
// miss with no consent the renderer throws VisualUndrawnError and the shell
// offers "Build widget" — the same offer, and the same rules for when a build
// may start unasked, as an animation's scene brief (server/visualBuilds.js).

/**
 * The interface-size setting, carried into the sandbox. Read from the live
 * document rather than the store, because that is where `applyUiScale` writes
 * it and the two cannot then disagree; falls back to the browser default when
 * the root carries no explicit size (a probe iframe, a test harness).
 */
function hostRootFontCss(): string {
    const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return widgetRootFontCss(px);
}

const MAX_HEIGHT = 640;
const MIN_HEIGHT = 160;
const PROBE_TIMEOUT_MS = 8000;
const PROBE_GRACE_MS = 700;

/** The spec is plain labeled prose — reject empty/code-shaped blocks with a repairable message. */
function validateSpec(spec: string): void {
    if (!spec) throw new Error('empty widget spec.');
    if (!/^\s*objective\s*:/im.test(spec)) {
        throw new Error('a widget spec needs an "Objective:" line — one sentence stating what the widget teaches.');
    }
    if (!/^\s*behaviou?r\s*:/im.test(spec)) {
        throw new Error('a widget spec needs a "Behavior:" line describing the mechanics chronologically (with formulas) and what each input changes.');
    }
    if (/<\/?[a-z]+>|function\s*\(|=>|document\.|createCanvas/i.test(spec)) {
        throw new Error('the spec must be plain functional text — no code or HTML; describe WHAT the widget does and the builder writes the code.');
    }
}

function specTitle(spec: string): string {
    const m = spec.match(/^\s*title\s*:\s*(.+)$/im);
    return (m ? m[1].trim() : '') || 'Interactive widget';
}

/**
 * Wrap the compiled document with the runtime harness: a CSP meta that blocks
 * every network request (belt to the server validator's braces), the theme
 * variables, and a head script that reports errors + content height to the
 * parent via postMessage. In probe mode it additionally shims
 * requestAnimationFrame (hidden iframes get no rAF ticks — the p5 lesson) and
 * delivers an ok/error verdict after a grace window.
 */
export function buildWidgetDoc(html: string, token: string, opts: { probe: boolean; palette: VisualPalette }): string {
    const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:;">';
    const raf = opts.probe
        ? 'window.requestAnimationFrame=function(cb){return window.setTimeout(function(){cb(performance.now());},33);};window.cancelAnimationFrame=window.clearTimeout;'
        : '';
    const onLoad = opts.probe
        ? `setTimeout(function(){
            if(reported)return;
            var b=document.body,h=b?b.scrollHeight:0;
            if(!b||b.children.length===0||h<40){fail('the widget rendered nothing visible - the document body is empty or has no sized content.');return;}
            reported=true;send('ok',{h:h});
        },${PROBE_GRACE_MS});`
        : `var report=function(){send('size',{h:document.body?document.body.scrollHeight:0});};
        report();
        if(window.ResizeObserver&&document.body){new ResizeObserver(report).observe(document.body);}`;
    // Live re-theming. A widget is the one visual a learner is *doing* something
    // with — sliders set, a simulation part-way through — so re-rendering it to
    // follow a theme change would throw that state away and pay another
    // verification probe for the privilege. The colours are the only thing that
    // has to change, so the parent posts the new stylesheet and palette and the
    // document swaps them in place. Nothing else about the build is touched,
    // and a widget built months ago follows the theme it is read in.
    //
    // Both halves are needed and neither is enough alone: the CSS carries the
    // card, and `__wtRetheme` carries everything the build stated as a literal
    // — including the plot, whose colours never touch CSS at all.
    const retheme = opts.probe ? '' : `
    window.addEventListener('message',function(e){
        if(!e.data||e.data.__widget!==TOKEN||e.data.type!=='theme'||typeof e.data.css!=='string')return;
        var el=document.getElementById('__w-theme');
        if(el)el.textContent=e.data.css;
        if(window.__wtRetheme)window.__wtRetheme(e.data.palette);
    });`;
    // The study clock counts time while the learner is USING the page, and a
    // widget is its own document: its slider drags never reach the app's
    // listeners. So the frame says it is being used, at most once a second.
    const activity = opts.probe ? '' : `
    var lastActive=0;
    function active(){var n=Date.now();if(n-lastActive<1000)return;lastActive=n;send('active');}
    ['pointerdown','pointermove','keydown','wheel','input','touchstart'].forEach(function(t){window.addEventListener(t,active,{capture:true,passive:true});});`;
    const harness = `(function(){
    var TOKEN=${JSON.stringify(token)};
    var reported=false;
    function send(type,extra){try{parent.postMessage(Object.assign({__widget:TOKEN,type:type},extra||{}),'*');}catch(e){}}
    function fail(msg){if(!reported){reported=true;send('error',{message:String(msg)});}}
    window.onerror=function(msg){fail(msg);return ${opts.probe ? 'true' : 'false'};};
    window.addEventListener('unhandledrejection',function(e){fail(e.reason&&e.reason.message?e.reason.message:String(e.reason));});
    ${raf}${retheme}${activity}
    window.addEventListener('load',function(){${onLoad}});
})();`;
    const inject = `${csp}<style id="__w-theme">${widgetThemeCss(opts.palette)}${hostRootFontCss()}</style>`
        + `<script>${widgetThemePrelude(opts.palette)}</scr` + 'ipt>'
        + `<script>${harness}</scr` + 'ipt>';
    // The markup pass has to run AFTER the build's own <style> elements exist,
    // and the harness is at the top of <head>, where they do not yet. So it
    // goes at the very end of the document — the same reason the compiler
    // contract puts the build's own <script> last.
    const tail = `<script>${WIDGET_THEME_TAIL}</scr` + 'ipt>';

    // Our head is written BEFORE a byte of the build, never spliced into it: a
    // regex cannot tell a real `<head>` from one in a comment, an attribute or
    // a `<header>`, and a CSP meta that lands anywhere but <head> is ignored.
    // The parser then merges the build's <html> into ours, drops its <head>
    // tag and files its head-only elements after ours. A leading BOM is text
    // to the parser, which would start the body before the build's own head.
    return `<!doctype html><html><head>${inject}</head>${html.replace(/^﻿/, '')}${tail}`;
}

type SandboxMessage = { __widget?: string; type?: string; message?: string; h?: number };

/** Execute the build in a hidden probe iframe until it reports ok/error or times out. */
function probeWidget(doc: string, token: string): Promise<{ h: number }> {
    return new Promise((resolve, reject) => {
        const probe = document.createElement('iframe');
        probe.setAttribute('sandbox', 'allow-scripts');
        probe.style.cssText = 'position:fixed;left:-10000px;top:0;width:640px;height:640px;visibility:hidden;';
        const finish = (fn: () => void) => {
            window.removeEventListener('message', onMessage);
            clearTimeout(timer);
            probe.remove();
            fn();
        };
        const onMessage = (e: MessageEvent<SandboxMessage>) => {
            if (!e.data || e.data.__widget !== token || e.source !== probe.contentWindow) return;
            if (e.data.type === 'ok') finish(() => resolve({ h: e.data.h || 380 }));
            else if (e.data.type === 'error') finish(() => reject(new Error(e.data.message || 'the widget failed to run.')));
        };
        const timer = setTimeout(
            () => finish(() => reject(new Error('the widget did not finish initialising within 8s — avoid long or infinite loops outside requestAnimationFrame.'))),
            PROBE_TIMEOUT_MS,
        );
        window.addEventListener('message', onMessage);
        probe.srcdoc = doc;
        document.body.appendChild(probe);
    });
}

/** Map compile-task lifecycle events onto the shell's one-line status footer. */
function progressReporter(onProgress?: (message: string) => void) {
    return (evt: { status?: string; queuePosition?: number | null; thinking?: number; progress?: number }) => {
        if (!onProgress) return;
        if (evt.status === 'queued') {
            onProgress(evt.queuePosition
                ? i18n.t("Build queued (#{{position}}) — starts when the current AI task finishes…", { position: evt.queuePosition + 1 })
                : i18n.t("Build queued — starts when the current AI task finishes…"));
        } else if (evt.status === 'running') {
            onProgress(i18n.t("Building widget…"));
        }
        if (typeof evt.thinking === 'number') onProgress(i18n.t("Designing the widget… {{chars}} chars of reasoning", { count: evt.thinking, chars: num(evt.thinking) }));
        if (typeof evt.progress === 'number') onProgress(i18n.t("Building widget… {{chars}} chars", { count: evt.progress, chars: num(evt.progress) }));
    };
}

function isAbort(e: unknown): boolean {
    return e instanceof DOMException && e.name === 'AbortError';
}

/**
 * Compile with exactly one error-feedback retry (so a render pass costs at
 * most two LLM builds). Each attempt is a queued server-side build followed by
 * verification-by-execution in the hidden probe; the retry feeds the failure —
 * and, when the probe caught it at runtime, the broken build itself — back to
 * the builder. `seed` starts from a known failure (a broken cached build).
 */
async function compileVerified(
    spec: string,
    ctx: VisualContext,
    seed?: { error: string; previousHtml?: string },
): Promise<string> {
    // The first request carries `auto` unless the learner pressed Build: the
    // server may then decline (kind switched off, model gate, a failure this
    // model already had). A fix pass carries `error` and is never declined —
    // it is the second half of a build that was already allowed to start.
    // A seed (a broken cached build) is also the FIRST request of this pass,
    // so it carries `auto` too: a heal the model already failed must not be
    // re-run on every render either.
    let opts: { error?: string; previousHtml?: string; auto?: boolean } = { ...(seed ?? {}), auto: !ctx.requested };
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        let html: string;
        try {
            const built = await api.compileWidget(spec, { ...opts, origin: ctx.origin }, progressReporter(ctx.onProgress), ctx.signal);
            if (!built.html && built.declined) {
                throw new VisualUndrawnError('widget', declinedReason(built.declined), built.lastError || '');
            }
            ({ html } = built);
        } catch (e) {
            if (isUndrawnError(e)) throw e;
            // Aborts and user-cancelled builds are final — never burn a retry on them.
            if (isAbort(e) || (e as { cancelled?: boolean })?.cancelled || attempt === 1) throw e;
            lastError = e instanceof Error ? e.message : String(e);
            opts = { error: lastError };
            ctx.onProgress?.(i18n.t("Build failed — asking the builder to fix it…"));
            continue;
        }
        try {
            ctx.onProgress?.(i18n.t("Verifying the widget…"));
            const token = Math.random().toString(36).slice(2);
            await probeWidget(buildWidgetDoc(html, token, { probe: true, palette: ctx.palette }), token);
            return html;
        } catch (e) {
            if (isAbort(e)) throw e;
            lastError = e instanceof Error ? e.message : String(e);
            if (attempt === 1) {
                // Built twice and would not run either time. The server cannot
                // see a runtime failure, so it is told: the next UNASKED render
                // of this spec then offers a button instead of building again.
                api.reportVisualBuildFailure('widget', spec, lastError).catch(() => { });
                throw e;
            }
            opts = { error: lastError, previousHtml: html };
            ctx.onProgress?.(i18n.t("Build failed at runtime — asking the builder to fix it…"));
        }
    }
    throw new Error(lastError || 'the widget build failed.');
}

/**
 * Mount the verified build as the visible sandboxed iframe. Registers its
 * resize listener into `live` so the renderer's cleanup can detach it no
 * matter which flow (auto, cached, button) created the frame.
 */
function mountWidget(
    container: HTMLElement,
    html: string,
    ctx: VisualContext,
    live: { off: (() => void) | null },
    title: string,
    initialH: number,
    spec: string,
): void {
    const token = Math.random().toString(36).slice(2);
    // The spec is what the model wrote; this is what it was built into.
    ctx.onResolved?.(html);
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.title = title;
    frame.style.cssText = 'display:block;border:0;width:100%;';
    frame.style.height = `${Math.max(MIN_HEIGHT, Math.min(initialH, MAX_HEIGHT))}px`;
    // The display doc skips the probe verdict machinery; it just self-reports
    // its content height (initially and on every resize) so the frame fits.
    frame.srcdoc = buildWidgetDoc(html, token, { probe: false, palette: ctx.palette });

    const onMessage = (e: MessageEvent<SandboxMessage>) => {
        if (!e.data || e.data.__widget !== token || e.source !== frame.contentWindow) return;
        if (e.data.type === 'size' && e.data.h) {
            frame.style.height = `${Math.max(MIN_HEIGHT, Math.min(e.data.h, MAX_HEIGHT))}px`;
        }
    };
    window.addEventListener('message', onMessage);

    // The widget follows theme AND accent changes without being rebuilt. Every
    // other visual re-renders (VisualBlock makes the palette a dependency), but
    // this one is interactive: a re-render discards the learner's slider
    // positions and the state of a running simulation, and pays a second
    // verification probe to do it. `widget` is in `SELF_THEMING_KINDS`, which
    // is what makes VisualBlock drop the theme from its render dependency and
    // leave the block alone, so this subscription is the only path.
    let lastKey = `${useStore.getState().theme}|${useStore.getState().accentColor}`;
    const unsubscribe = useStore.subscribe((state) => {
        const key = `${state.theme}|${state.accentColor}`;
        if (key === lastKey) return;
        lastKey = key;
        // The accent variables are written to the document root by the store's
        // own setter, so read the palette on the next frame — otherwise this
        // races the write and re-themes to the colour being replaced.
        requestAnimationFrame(() => {
            const next = readVisualPalette(state.theme);
            frame.contentWindow?.postMessage(
                {
                    __widget: token,
                    type: 'theme',
                    css: widgetThemeCss(next) + hostRootFontCss(),
                    palette: widgetPalette(next),
                },
                '*',
            );
        });
    });

    live.off = () => {
        window.removeEventListener('message', onMessage);
        unsubscribe();
    };

    // Rebuild, on demand. A widget that renders and runs is not necessarily a
    // widget that WORKS — the failure that motivated the fixed-axis rule was a
    // plot that redrew itself identically at every slider setting, which throws
    // nothing, probes clean and can only be judged by a person looking at it.
    // The build is cached by spec, so without this the only way to get a second
    // opinion was to make the tutor write a different spec.
    const footer = document.createElement('div');
    footer.className = 'flex items-center justify-end gap-3 pt-1';
    const rebuild = document.createElement('button');
    rebuild.type = 'button';
    rebuild.className = 'text-xs font-mono text-slate-400 hover:text-accent-fg transition-colors';
    rebuild.textContent = `↻ ${i18n.t("rebuild")}`;
    rebuild.title = i18n.t("Build this widget again from its spec");
    const status = document.createElement('div');
    status.className = 'text-xs text-slate-400 tabular-nums';
    rebuild.addEventListener('click', async () => {
        rebuild.disabled = true;
        rebuild.classList.add('opacity-50');
        try {
            const { html: fresh } = await api.compileWidget(
                spec, { force: true, origin: ctx.origin }, progressReporter(m => { status.textContent = m; }), ctx.signal,
            );
            status.textContent = '';
            live.off?.();
            live.off = null;
            mountWidget(container, fresh, ctx, live, title, initialH, spec);
        } catch (e) {
            if (isAbort(e)) return;
            status.textContent = `Rebuild failed: ${e instanceof Error ? e.message : String(e)}`;
            rebuild.disabled = false;
            rebuild.classList.remove('opacity-50');
        }
    });
    footer.append(status, rebuild);

    container.replaceChildren(frame, footer);
}

/**
 * The build is not started here without consent. Where none was given — a
 * message re-read from history, a feed card, a second device — the renderer
 * throws `VisualUndrawnError` and the SHELL draws the offer (VisualBlock's
 * undrawn card), exactly as it does for an animation's scene brief. It used to
 * mount its own button card into the stage, which then stayed on screen,
 * disabled, above the progress line of the very build it had started ("This
 * interactive widget hasn't been built yet. [Build widget] Designing the
 * widget… 294 chars of reasoning"), and which the shell could not tell apart
 * from a rendered widget — so a reply that FINISHED never got to build it.
 */
const renderWidget: VisualRenderer = async (el, code, ctx) => {
    const spec = code.trim();
    validateSpec(spec);
    const title = specTitle(spec);
    const live: { off: (() => void) | null } = { off: null };
    const cleanup = () => { live.off?.(); };
    const mayBuild = !!(ctx.autoBuild || ctx.requested);

    // 1) Cache lookup — never STARTS a build, so history renders are free; it
    // JOINS one already running (a reload, a second device), which is why it
    // reports progress too.
    const cached = await api.compileWidget(spec, { cacheOnly: true }, progressReporter(ctx.onProgress), ctx.signal);
    if (cached.html) {
        const token = Math.random().toString(36).slice(2);
        try {
            const { h } = await probeWidget(buildWidgetDoc(cached.html, token, { probe: true, palette: ctx.palette }), token);
            mountWidget(el, cached.html, ctx, live, title, h, spec);
            return cleanup;
        } catch (e) {
            // The cache is written when the build finishes, BEFORE client-side
            // verification — a session that closed between the two can leave a
            // broken build behind. Heal it (with consent for history blocks).
            const message = e instanceof Error ? e.message : String(e);
            if (!mayBuild) throw new VisualUndrawnError('widget', 'broken', message);
            const html = await compileVerified(spec, ctx, { error: message, previousHtml: cached.html });
            mountWidget(el, html, ctx, live, title, 380, spec);
            return cleanup;
        }
    }

    // 2) Cache miss: build now (a reply that just finished, or a press) or
    // offer to. The offer names a failed last build of this spec.
    if (!mayBuild) throw new VisualUndrawnError('widget', cached.lastError ? 'failed' : 'consent', cached.lastError || '');
    const html = await compileVerified(spec, ctx);
    mountWidget(el, html, ctx, live, title, 380, spec);
    return cleanup;
};

export default renderWidget;

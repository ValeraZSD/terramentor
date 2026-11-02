/**
 * The document every sketch and widget frame starts as.
 *
 * The page's policy is `script-src 'self'`. A frame built from `srcdoc` (or a
 * blob) INHERITS the policy of the page that made it, and a policy the frame
 * then declares itself can only narrow it, so under that page policy a sketch
 * or widget document could not run a single inline script — which is all it
 * is. A frame loaded from an address gets the policy of ITS OWN response
 * instead, so the frames load this shell, served with the policy below, and
 * the page posts the real document in (src/components/visuals/sandboxFrame.ts).
 * The shell writes it over itself; the document keeps the shell's policy and
 * adds its own `<meta>` policy on top, which is the one each renderer has always
 * written (renderP5.ts, renderWidget.ts).
 *
 * The policy is the widest the two renderers' documents ask for and no wider:
 * inline script and style, pictures and sound from `data:`/`blob:` only, no
 * address of any kind (`default-src 'none'` covers fetch, sockets, workers and
 * frames), no `<base>`, no form, framed only by this app, and a sandbox of its
 * own, so the shell opened directly in a tab is as cut off as it is in a frame.
 *
 * No imports: the client reads the path from this file too.
 */

export const SANDBOX_FRAME_PATH = '/sandbox.html';

export const SANDBOX_FRAME_CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    'sandbox allow-scripts',
].join('; ');

// Takes ONE document, from its parent only, then stops listening: the page
// re-posts when the frame reloads (an iframe moved in the page reloads), and
// nothing a written document does can make the shell write a second one.
// `document.open()` keeps this window and erases its listeners; the written
// document then parses and runs as if it had been loaded.
//
// It asks only once it has LOADED, and writes nothing before: opening a
// document that is still being parsed aborts that load, and the written
// document then never gets a load event of its own, so a sketch (p5 starts on
// load) would never start. On a busy machine the answer can arrive that early.
export const SANDBOX_FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title></title></head><body><script>
(function () {
    if (window.parent === window) return;
    function take(e) {
        if (document.readyState !== 'complete') return;
        if (e.source !== window.parent || !e.data || typeof e.data.__sandboxDoc !== 'string') return;
        window.removeEventListener('message', take);
        var doc = e.data.__sandboxDoc;
        document.open();
        document.write(doc);
        document.close();
    }
    window.addEventListener('message', take);
    window.addEventListener('load', function () {
        window.parent.postMessage({ __sandboxReady: 1 }, '*');
    });
})();
</script></body></html>`;

/** Express handler: the shell, under its own policy instead of the page's. */
export function sendSandboxFrame(req, res) {
    res.setHeader('Content-Security-Policy', SANDBOX_FRAME_CSP);
    res.removeHeader('Content-Security-Policy-Report-Only');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(SANDBOX_FRAME_HTML);
}

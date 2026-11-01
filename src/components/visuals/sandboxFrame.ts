import { SANDBOX_FRAME_PATH } from '../../../server/sandboxFrame.js';

/**
 * Show a document in a sandboxed frame without making it a `srcdoc`.
 *
 * A srcdoc frame inherits the page's policy, `script-src 'self'`, under which a
 * sketch or widget document cannot run its own inline script. The frame loads
 * the shell instead (server/sandboxFrame.js), which arrives under a policy of
 * its own and asks for its document; this hands it over. It hands it over again
 * whenever the shell asks again: moving an iframe in the page reloads it, and
 * the shell it reloads is empty.
 *
 * Call before the frame is in the page, so the first request is never missed.
 * Returns the listener's removal; the caller owns the frame itself.
 */
export function showInSandbox(frame: HTMLIFrameElement, html: string): () => void {
    frame.setAttribute('sandbox', 'allow-scripts');
    const onMessage = (e: MessageEvent<{ __sandboxReady?: number }>) => {
        if (e.source !== frame.contentWindow || !e.data || e.data.__sandboxReady !== 1) return;
        // The frame's origin is opaque, so `*` is the only target it answers to;
        // `source` above is what makes this the shell of THIS frame.
        frame.contentWindow?.postMessage({ __sandboxDoc: html }, '*');
    };
    window.addEventListener('message', onMessage);
    frame.src = SANDBOX_FRAME_PATH;
    return () => window.removeEventListener('message', onMessage);
}

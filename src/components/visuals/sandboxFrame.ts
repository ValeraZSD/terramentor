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
 *
 * The document the frame runs can send the same request (it IS the frame's
 * window once written), and each answer copies the whole document, p5 and all,
 * across. So the first request is answered at once and later ones at most once
 * per `SANDBOX_ANSWER_GAP_MS`: the last of a burst is answered when the gap
 * ends, never dropped, so a frame moved in quick succession still gets its
 * document, and a frame asking in a loop costs the page one copy a second.
 */
export const SANDBOX_ANSWER_GAP_MS = 1000;

export function showInSandbox(frame: HTMLIFrameElement, html: string): () => void {
    frame.setAttribute('sandbox', 'allow-scripts');
    let lastAnswer = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = () => {
        timer = undefined;
        lastAnswer = Date.now();
        // The frame's origin is opaque, so `*` is the only target it answers to;
        // `source` below is what makes this the shell of THIS frame.
        frame.contentWindow?.postMessage({ __sandboxDoc: html }, '*');
    };
    const onMessage = (e: MessageEvent<{ __sandboxReady?: number }>) => {
        if (e.source !== frame.contentWindow || !e.data || e.data.__sandboxReady !== 1) return;
        if (timer !== undefined) return;
        const wait = lastAnswer + SANDBOX_ANSWER_GAP_MS - Date.now();
        if (wait <= 0) answer();
        else timer = setTimeout(answer, wait);
    };
    window.addEventListener('message', onMessage);
    frame.src = SANDBOX_FRAME_PATH;
    return () => {
        window.removeEventListener('message', onMessage);
        if (timer !== undefined) clearTimeout(timer);
    };
}

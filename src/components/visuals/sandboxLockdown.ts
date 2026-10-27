/**
 * The first script of every sandboxed visual (p5 sketches and widgets), run
 * before a byte of model-written code: it takes WebRTC away.
 *
 * Each frame's own CSP (`default-src 'none'`) already refuses fetch, XHR,
 * WebSocket, EventSource and every remote load, and the app's enforced
 * `frame-src` (server/app.js) keeps the frame from navigating off this app. No
 * CSP a browser ships covers WebRTC: a peer connection given a STUN or TURN
 * server of the code's choosing sends packets to it while gathering
 * candidates, before anything is connected, and the code can write what it
 * holds into the address or the credentials. No visual has a use for a peer
 * connection, so the constructors are replaced with `undefined` and pinned
 * there (non-writable, non-configurable): a later script cannot put them back,
 * and a nested frame, which would hold fresh copies, is a different opaque
 * origin the code cannot reach into (both measured in Edge,
 * temp/frame-leak/walk.py).
 *
 * The static vetoes on the code itself (`leavesTheFrame` in renderP5.ts,
 * `finalizeWidgetHtml` in server/ai.js) send an obvious attempt to the repair
 * loop instead; this is what holds when the code spells it some other way.
 */
export const SANDBOX_LOCKDOWN_JS = `(function(){
    ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCIceTransport','RTCSctpTransport','RTCIceCandidate','RTCSessionDescription'].forEach(function(n){
        try{Object.defineProperty(window,n,{value:undefined,writable:false,configurable:false,enumerable:false});}catch(e){}
    });
})();`;

/**
 * Code that tries to leave the frame in a way a reader would recognise: a
 * navigation through `location`, a peer connection, a beacon, a new window.
 * Returns what it found (for the repair loop) or null. The server keeps the
 * same list for widget builds (`finalizeWidgetHtml`); `widget-csp-gates.mjs`
 * runs one set of samples through both.
 */
export function leavesTheFrame(code: string): string | null {
    for (const [re, why] of LEAVING) if (re.test(code)) return why;
    return null;
}

const LEAVING: [RegExp, string][] = [
    [/(?<![\w$.])(?:window|self|top|parent|document|globalThis|frames)\s*\.\s*location\b|(?<![\w$.])location\s*\.\s*(?:href|assign|replace)\b/, 'a navigation (location) — a visual never leaves its frame'],
    [/\b(?:webkit)?RTC(?:PeerConnection|DataChannel)\b/, 'a WebRTC connection — a visual never opens a connection'],
    [/\bsendBeacon\b/, 'navigator.sendBeacon — a visual never sends anything out'],
    [/(?<![\w$.])(?:window|self|top|parent|globalThis)\s*\.\s*open\s*\(/, 'window.open — a visual never opens another window'],
];

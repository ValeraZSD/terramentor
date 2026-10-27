/**
 * Code that tries to leave its frame in a way a reader would recognise: a
 * navigation through `location`, a peer connection, a beacon, a new window, a
 * nested document of its own. One list for both sides: `finalizeWidgetHtml`
 * (server/ai.js) refuses a widget build that names one, `leavesTheFrame` in
 * renderP5.ts a sketch, so either goes to the repair loop instead of running.
 *
 * Not the boundary: the app's `frame-src` and the frame's first script
 * (src/components/visuals/sandboxLockdown.ts) stop each of these in the browser
 * however the code spells it. This only catches the plain spellings early.
 */
export const LEAVING_FRAME = [
    [/(?<![\w$.])(?:window|self|top|parent|document|globalThis|frames)\s*\.\s*location\b|(?<![\w$.-])location\s*\.\s*(?:href|assign|replace)\b|(?<![\w$.-]|(?:var|let|const)\s+)location\s*=(?!=)/,
        'a navigation (location) — a visual never leaves its frame'],
    [/\b(?:webkit)?RTC(?:PeerConnection|DataChannel)\b/, 'a WebRTC connection — a visual never opens a connection'],
    [/\bsendBeacon\b/, 'navigator.sendBeacon — a visual never sends anything out'],
    [/(?<![\w$.])(?:window|self|top|parent|globalThis)\s*\.\s*open\s*\(/, 'window.open — a visual never opens another window'],
    [/\bsrcdoc\b|\bcreateElement\s*\(\s*['"`](?:i?frame|object|embed)['"`]|\battachShadow\b/i,
        'a nested frame — a visual draws in the frame it was given'],
];

/** What `code` does to leave its frame (for the repair loop), or null. */
export function leavesTheFrame(code) {
    for (const [re, why] of LEAVING_FRAME) if (re.test(String(code ?? ''))) return why;
    return null;
}

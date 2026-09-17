/**
 * Copy text, including where `navigator.clipboard` does not exist.
 *
 * This is not defensive padding: the async Clipboard API is gated on a SECURE
 * context, and this app is routinely opened at `http://<host>:3001` from a
 * phone on the LAN or over Tailscale. On exactly those devices — the ones where
 * re-typing an answer is most painful — `navigator.clipboard` is `undefined`,
 * and the old code caught the error and silently did nothing. A copy button
 * that does nothing is worse than no copy button, because the learner walks
 * away believing they have the text.
 *
 * So: the modern API when it is there, and the old `execCommand` textarea trick
 * when it is not. Returns whether the text actually made it, so the caller can
 * say so rather than flashing a tick it can't stand behind.
 */
export async function copyText(text: string): Promise<boolean> {
    if (!text) return false;

    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Permission denied, or a non-secure context that still exposes the
            // object — fall through to the legacy path rather than giving up.
        }
    }

    try {
        const area = document.createElement('textarea');
        area.value = text;
        // Off-screen but focusable, and readOnly so a phone doesn't raise the
        // keyboard for the split second it is in the document.
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        // The field must be selectable ON ITS OWN, not by inheritance: this
        // element is appended to <body>, and the app puts `user-select: none` on
        // <body> while the assistant is an overlay. Inheriting that makes
        // `.select()` produce nothing to copy and `execCommand` return a
        // truthful `false` — silently, on exactly the plain-http phone case this
        // whole fallback exists for.
        area.style.setProperty('-webkit-user-select', 'text');
        area.style.userSelect = 'text';
        document.body.appendChild(area);

        // iOS ignores .select() on a readOnly field unless the range is set
        // explicitly, which is the whole reason this path is fiddly.
        area.contentEditable = 'true';
        area.select();
        area.setSelectionRange(0, text.length);

        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
    } catch {
        return false;
    }
}

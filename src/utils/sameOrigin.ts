/**
 * Does this address, resolved the way the browser will resolve it, stay on the
 * page's own origin? A test on the text cannot tell: "/\host", "/<tab>/host"
 * and "//host" all start with a slash and all leave the origin.
 */
export function isSameOrigin(url: string, here: string = window.location.href): boolean {
    try {
        return new URL(url, here).origin === new URL(here).origin;
    } catch {
        return false;
    }
}

/**
 * A same-origin address that only READS: the media store, the app's icons, a
 * built file. Every other `/api` path may do work when it is requested (start
 * writing a lesson, draw a mastery check), and content the app did not write,
 * an imported course or a model's answer, must not be able to request it by
 * naming it as a picture. The path is compared lowercased because the server
 * matches routes without regard to case, and after `URL` has resolved `..`
 * and `%2e` segments.
 */
export function isInertOwnAddress(url: string, here: string = window.location.href): boolean {
    try {
        const u = new URL(url, here);
        if (u.origin !== new URL(here).origin) return false;
        const path = u.pathname.toLowerCase();
        return !path.startsWith('/api/') || /^\/api\/(media|icon)\//.test(path);
    } catch {
        return false;
    }
}

/**
 * What a link in content the app did not write (a model's answer, an imported
 * lesson) becomes when it is drawn.
 *
 * - `text`: no link at all. A route of this app's own API is a top-level GET
 *   when pressed, and some of those do work (`/api/feed?nodeId=` starts writing
 *   a lesson), so it is shown as the words it was written with, exactly as
 *   `MarkdownImage` shows such an address as a picture's alt text.
 * - `here`: a page of this app, opened in this tab.
 * - `away`: anything else, opened in a new tab so the app's own tab is never
 *   replaced by what the link points at. The decision is the browser's own
 *   resolution, not the text: `//host`, `HTTP://host` and `/\host` all leave.
 *   `shows` is where it goes, printed beside the words when the words do not
 *   say it themselves: a model can be steered into writing
 *   `[Your notes](https://elsewhere/?q=…)`, and the words alone would claim it
 *   is something of the learner's.
 */
export type LinkPlan =
    | { kind: 'text' }
    | { kind: 'here'; href: string }
    | { kind: 'away'; href: string; shows: string };

export function planLink(href: string | undefined, label: string, here: string = window.location.href): LinkPlan {
    if (!href) return { kind: 'text' };
    let u: URL;
    try { u = new URL(href, here); } catch { return { kind: 'text' }; }
    if (u.origin === new URL(here).origin) {
        const path = u.pathname.toLowerCase();
        return path === '/api' || path.startsWith('/api/') ? { kind: 'text' } : { kind: 'here', href };
    }
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* a stray % is shown as written */ }
    const where = u.protocol === 'http:' || u.protocol === 'https:' ? u.host : path || u.protocol;
    const said = label.toLowerCase().includes(where.toLowerCase());
    return { kind: 'away', href: u.href, shows: said ? '' : where };
}

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

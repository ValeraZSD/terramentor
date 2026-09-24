/**
 * Header values that survive a learner's own language.
 *
 * An HTTP header value is Latin-1. Node does not coerce — `res.setHeader`
 * THROWS `Invalid character in header content` the moment a Cyrillic project
 * name or a Japanese clip's filename reaches it, before a byte of the body is
 * sent. So a route that builds a header out of anything a learner typed has to
 * encode it, and the failure it prevents does not look like an encoding
 * problem: the export builds perfectly and the screen says the export failed
 * because of a header.
 *
 * Both functions live here, in a leaf with no imports, so the gate can assert
 * them against Node's own `validateHeaderValue` without booting the server.
 */

/**
 * A `Content-Disposition` value that survives a filename in any script.
 *
 * A Japanese deck's clip is called `早い_ハヤ＼イ_2_NHK-2016.mp3`, and putting
 * that straight into the header threw — so the first Japanese card served
 * returned a 500 where an English one worked, which is the shape this whole
 * module is about: the code path was never wrong for ASCII, so nothing but a
 * non-Latin deck could find it.
 *
 * RFC 5987 is the fix and it needs BOTH halves: an ASCII `filename` any client
 * can read, and `filename*` carrying the real name percent-encoded as UTF-8.
 */
export function contentDisposition(name, { inline = true } = {}) {
    const raw = String(name || 'file');
    const ascii = raw.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
    return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

/**
 * JSON for a header value, with every non-ASCII character as a `\uXXXX`
 * escape.
 *
 * The same Latin-1 rule one step further down the same route: `/api/export/
 * :id/anki` sent its stats — which carry the PROJECT'S NAME and any missing
 * media FILENAMES — as `JSON.stringify(stats)`, so a Russian course failed with
 * `Invalid character in header content ["X-Export-Stats"]` while an English one
 * exported fine. The `Content-Disposition` beside it had already been fixed for
 * exactly this; the advisory header had not.
 *
 * Escapes rather than percent-encoding because `\uXXXX` is valid JSON: the
 * client's `JSON.parse` reads it unchanged, with no decode step to forget.
 */
export function headerJson(value) {
    return JSON.stringify(value).replace(
        /[^\x20-\x7e]/g,
        (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

// The one shape every file in `src/locales/` is written in.
//
// 2-space indent, keys sorted by `localeCompare(…, 'en')`, a trailing newline.
// Every tool that writes a locale file writes through `serialiseLocale`
// (`i18n-put`, `i18n-extract`, `i18n-sync-en`, `i18n-translate`, the merge
// driver `locale-merge`), and `locale-format-gates` holds every file to it.
// Sorted order is what keeps two branches that each add a key from touching
// the same lines: each new key lands where it sorts, not at the top.

/** The locale object as the file's text, LF endings. */
export function serialiseLocale(obj) {
    const sorted = Object.fromEntries(
        Object.keys(obj).sort((a, b) => a.localeCompare(b, 'en')).map((k) => [k, obj[k]]),
    );
    return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * The line ENDING is not a formatting difference to settle.
 *
 * The working tree is CRLF on Windows (git converts on checkout; the repository
 * holds LF), so a check that compared a CRLF file against an LF rewrite would
 * fail every file there. Endings are compared with, and written back in,
 * whatever the file already uses.
 */
export const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
export const withEol = (text, eol) => (eol === '\n' ? text : text.replace(/\n/g, eol));
export const sameShape = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

/** Does this file's text come back unchanged through `serialiseLocale`?
 *  False for text that is not JSON. */
export function roundTrips(text) {
    let data;
    try { data = JSON.parse(text); } catch { return false; }
    return sameShape(serialiseLocale(data), text);
}

/**
 * Does every entry line of this flat file survive JSON.parse? A key written
 * twice parses to ONE key holding the last value, so a rewrite would drop the
 * other without a word. Counts `"key":` at the start of a line, any indent;
 * a file not written one entry per line counts as not.
 */
export function oneLinePerKey(text, data) {
    return (text.match(/^\s*"(?:[^"\\]|\\.)*"\s*:/gm) || []).length === Object.keys(data).length;
}

/** `serialiseLocale`, in the line ending `like` already uses. */
export function serialiseLike(obj, like) {
    return withEol(serialiseLocale(obj), eolOf(like));
}

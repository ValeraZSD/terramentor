/**
 * Blank out a JS/TS/JSX file's comments, keeping every byte where it was.
 *
 * Shared by the two static linters that scan JSX by hand (`a11y-lint.mjs`,
 * `style-lint.mjs`), because both of them believed comment prose on
 * 2026-09-22 and all four of their findings that day were their own bugs:
 *
 * - `<img src>` inside a JSDoc block was scanned as an element and reported as
 *   an image with no alt.
 * - An apostrophe in a `//` comment inside a `className={cx(…)}` — "the tile's
 *   full height" — opened a quote that closed on the next string literal. In
 *   `a11y-lint` that inverted quote parity for the rest of the element and
 *   reported a button full of text as icon-only; in `style-lint` it made the
 *   prose BETWEEN two apostrophes read as a class string, so an ordinary
 *   English "a" was reported as a duplicate class.
 * - `text.matchAll(/```([\w-]+)/g)` on line 10 of a file reads, to a scanner
 *   with no regex handling, as a division followed by a template literal that
 *   never closes — so every comment in the remaining 300 lines was code.
 *
 * Replacing with spaces rather than deleting keeps every offset and line number
 * valid, so a caller can still slice the ORIGINAL text by indices taken from
 * the blanked copy.
 */

/**
 * A regex literal can only follow an operator or an opening bracket, never a
 * value — the standard heuristic for telling `/` apart from division.
 */
const REGEX_MAY_FOLLOW = new Set([
    '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^',
    'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await',
]);

export function blankComments(text) {
    const out = text.split('');
    let i = 0, q = null, prev = '';
    while (i < text.length) {
        const ch = text[i];
        if (q) {
            if (ch === '\\') { i += 2; continue; }
            // A `'` or `"` string cannot hold a raw newline, so an unclosed one
            // was never a string — an apostrophe in prose, most often. Closing
            // it at the line end stops one stray character inverting the parity
            // of everything after it.
            if (ch === '\n' && q !== '`') q = null;
            else if (ch === q) q = null;
            i++; continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { q = ch; prev = ch; i++; continue; }
        if (ch === '/' && text[i + 1] !== '/' && text[i + 1] !== '*' && REGEX_MAY_FOLLOW.has(prev)) {
            // Skip the literal, character class and all: a `/` inside `[...]`
            // does not end it.
            let j = i + 1, inClass = false;
            for (; j < text.length && text[j] !== '\n'; j++) {
                if (text[j] === '\\') { j++; continue; }
                if (text[j] === '[') inClass = true;
                else if (text[j] === ']') inClass = false;
                else if (text[j] === '/' && !inClass) break;
            }
            prev = '/';
            i = text[j] === '/' ? j + 1 : i + 1;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end === -1 ? text.length : end + 2;
            for (let j = i; j < stop; j++) if (out[j] !== '\n') out[j] = ' ';
            i = stop; continue;
        }
        // `//` after a `:` is a URL in JSX text, not a comment.
        if (ch === '/' && text[i + 1] === '/' && text[i - 1] !== ':') {
            let end = text.indexOf('\n', i);
            if (end === -1) end = text.length;
            for (let j = i; j < end; j++) out[j] = ' ';
            i = end; continue;
        }
        // The last meaningful character, for the regex test above. Whitespace
        // and blanked comments do not count; a word is tracked whole, since
        // `return` and `returned` answer that test differently.
        if (/\s/.test(ch)) { i++; continue; }
        if (/[A-Za-z_$]/.test(ch)) {
            let j = i;
            while (j < text.length && /[\w$]/.test(text[j])) j++;
            prev = text.slice(i, j);
            i = j; continue;
        }
        prev = ch;
        i++;
    }
    return out.join('');
}

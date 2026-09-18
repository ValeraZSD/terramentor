/**
 * The one field of an imported course that ends up in an `href`.
 *
 * `server/searchProviders.js` checks its `urlTemplate` hard for this reason, and
 * the comment there is worth repeating: a `javascript:` URL in an href is script
 * execution in the app's own origin. That guard was written for the *inert
 * bookmark* path while the import path — the one whose own code comment calls a
 * bundle "untrusted input (the marketplace's whole point is sharing them)" —
 * stored whatever it was handed and rendered it as a link. A shared course is
 * the more likely carrier of the two.
 *
 * Where this deliberately differs from `validateUrlTemplate`: **http is allowed
 * here.** An add-on template is a stored capability the host fills with the
 * learner's current topic and sends outbound, so plaintext is a real leak. A
 * resource is a bookmark someone wrote down, and real course material lives on
 * plain-http university pages to this day (the worked example in
 * the authoring brief is one) — rejecting those would silently strip
 * legitimate resources out of every imported course, which is a bigger loss than
 * the one it prevents.
 *
 * No-import module on purpose: `tools/import-gates.mjs` applies the identical
 * rule without opening a database. Mirrored on the client in `src/utils/url.ts`,
 * which guards rows that were already in the database before this existed.
 */

export const MAX_URL_LENGTH = 2000;

/** The only two schemes a resource link may use. */
export const SAFE_URL_PROTOCOLS = ['http:', 'https:'];

/**
 * @param {unknown} value
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 *   `ok` with an empty string means "no URL", which is a valid resource.
 */
export function sanitizeUrl(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return { ok: true, url: '' };
    if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: `longer than ${MAX_URL_LENGTH} characters` };

    let url = parse(raw);

    // Someone typing "example.com/page" into the resource form means https. This
    // fallback can never rescue a dangerous scheme: "javascript:alert(1)" parses
    // on the first attempt (protocol `javascript:`) and is rejected below, so it
    // never reaches here to be prefixed into something harmless-looking.
    let normalized = raw;
    if (!url) {
        const prefixed = parse(`https://${raw}`);
        if (!prefixed) return { ok: false, reason: 'not a valid URL' };
        url = prefixed;
        normalized = `https://${raw}`;
    }

    if (!SAFE_URL_PROTOCOLS.includes(url.protocol)) {
        return { ok: false, reason: `scheme "${url.protocol}" is not allowed (http or https only)` };
    }
    // Browsers still honour https://user:pass@host/, which makes a hostile URL
    // read as a familiar one at a glance.
    if (url.username || url.password) return { ok: false, reason: 'must not contain credentials' };
    if (!url.hostname) return { ok: false, reason: 'has no hostname' };

    return { ok: true, url: normalized };
}

function parse(value) {
    try { return new URL(value); } catch { return null; }
}

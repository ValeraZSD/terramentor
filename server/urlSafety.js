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
 * which guards rows that were already in the database.
 */

export const MAX_URL_LENGTH = 2000;

/** The only two schemes a resource link may use. */
export const SAFE_URL_PROTOCOLS = ['http:', 'https:'];

/** A name, a colon, a port, then the end or the start of a path, query or fragment. */
const HOST_WITH_PORT = /^[^/\s:?#]+:\d+(?:[/?#]|$)/;

/**
 * Schemes that can be followed by digits only ("tel:112", "sms:555", "javascript:1"),
 * which HOST_WITH_PORT would take for a host and a port. They keep their own refusal.
 */
const NON_WEB_SCHEMES = ['javascript:', 'data:', 'mailto:', 'tel:', 'sms:', 'file:', 'ftp:', 'blob:', 'vbscript:', 'about:', 'urn:'];

// A refusal is said two ways. `reason` is a fragment for a line of English
// that frames it ("Invalid URL in …: <reason>": an import's warnings, the
// assistant's checks the model reads). `messageKey` + `params` are the whole
// sentence a learner reads, translated from src/locales (server/clientError.js
// `keyed` fills the English); one sentence per reason, since a fragment
// cannot be translated into another language's frame. `k` marks the keys for
// tools/lib/i18nKeys.mjs, here and not imported, to keep this module bare.
const k = (key) => key;
const refused = (reason, messageKey, params) => ({ ok: false, reason, messageKey, ...(params ? { params } : {}) });

/**
 * @param {unknown} value
 * @returns {{ok: true, url: string} | {ok: false, reason: string, messageKey: string, params?: object}}
 *   `ok` with an empty string means "no URL", which is a valid resource.
 */
export function sanitizeUrl(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return { ok: true, url: '' };
    if (raw.length > MAX_URL_LENGTH) {
        return refused(`longer than ${MAX_URL_LENGTH} characters`, k('The link is longer than {{max}} characters.'), { max: MAX_URL_LENGTH });
    }

    let url = parse(raw);

    // Someone typing "example.com/page" into the resource form means https. This
    // fallback can never rescue a dangerous scheme: "javascript:alert(1)" parses
    // on the first attempt (protocol `javascript:`) and is rejected below, so it
    // never reaches here to be prefixed into something harmless-looking.
    // "example.com:8080/page" is the one scheme-less shape that DOES parse the
    // first time, with the host standing in as the scheme (`example.com:`). A
    // digits-only tail after the colon is what marks it a port, unless the name
    // is one of the schemes that take a number ("tel:112"), which stay refused.
    let normalized = raw;
    const hostWithPort = url && !SAFE_URL_PROTOCOLS.includes(url.protocol)
        && !NON_WEB_SCHEMES.includes(url.protocol) && HOST_WITH_PORT.test(raw);
    if (!url || hostWithPort) {
        const prefixed = parse(`https://${raw}`);
        if (!prefixed) return refused('not a valid URL', k('The link is not a valid web address.'));
        url = prefixed;
        normalized = `https://${raw}`;
    }

    if (!SAFE_URL_PROTOCOLS.includes(url.protocol)) {
        return refused(`scheme "${url.protocol}" is not allowed (http or https only)`,
            k('This link starts with {{scheme}}; only http and https links can be saved.'), { scheme: url.protocol });
    }
    // Browsers still honour https://user:pass@host/, which makes a hostile URL
    // read as a familiar one at a glance.
    if (url.username || url.password) {
        return refused('must not contain credentials', k('A link must not contain a user name or password.'));
    }
    if (!url.hostname) return refused('has no hostname', k('The link has no website name in it.'));

    return { ok: true, url: normalized };
}

function parse(value) {
    try { return new URL(value); } catch { return null; }
}

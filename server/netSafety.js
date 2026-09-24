/**
 * Where the server is allowed to point an outbound fetch.
 *
 * `fetchPageContent` took a URL and fetched it with no validation at all, and
 * two of its callers hand it a URL this machine's owner never typed:
 * `POST /api/capture` (`capture.js` — "save this link", enriched in the
 * background) and the resource curator, which fetches pages the *model* chose
 * out of search results. `isValidResourceUrl` looked like a guard but is a
 * quality filter: its only host rule is "contains a dot", which rejects
 * `localhost` and admits `127.0.0.1`, `192.168.1.1` and `169.254.169.254`.
 *
 * On a local-first app that is not an abstract SSRF: this box runs llama-swap on
 * :8888/:8889 and the learner's router is one hop away, so a shared course or a
 * captured link could make the study app read a LAN service and paste the answer
 * back into a topic as "material". The threat model in SECURITY.md promises the
 * app does not reach out on its own; a target it was tricked into is the same
 * promise broken, just with an extra step.
 *
 * What this does NOT cover, deliberately: the SearXNG endpoint. That one is
 * typed into Settings by the owner and is *supposed* to be a local instance —
 * local-first is the feature there, not the bug. With cross-origin writes now
 * refused (server/originGuard.js) that setting can only be written by the owner.
 *
 * `ALLOW_PRIVATE_FETCH=1` reopens private targets for someone whose course
 * material genuinely lives on a LAN wiki.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_FETCH === '1';
const MAX_REDIRECTS = 3;

/** Is this literal address one an outbound fetch must never be aimed at? */
export function isBlockedAddress(ip) {
    const raw = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
    // ::ffff:127.0.0.1 is loopback wearing an IPv6 hat.
    const v4 = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
    if (net.isIPv4(v4)) {
        const [a, b] = v4.split('.').map(Number);
        if (a === 0 || a === 127) return true;                 // this host / loopback
        if (a === 10) return true;                             // private
        if (a === 172 && b >= 16 && b <= 31) return true;      // private
        if (a === 192 && b === 168) return true;               // private
        if (a === 169 && b === 254) return true;               // link-local (cloud metadata)
        if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT (Tailscale lives here)
        if (a >= 224) return true;                             // multicast + reserved
        return false;
    }
    if (net.isIPv6(raw)) {
        const v6 = raw.toLowerCase();
        if (v6 === '::' || v6 === '::1') return true;          // unspecified / loopback
        // Ranges are prefixes of BITS, not of text: fe80::/10 runs to febf::,
        // so a string test for "fe80:" let fe81::1 through. Read the first
        // 16-bit group and mask it.
        const h0 = v6.startsWith(':') ? 0 : parseInt(v6.split(':')[0], 16);
        if (!Number.isFinite(h0)) return true;                 // unparseable, refuse
        if ((h0 & 0xffc0) === 0xfe80) return true;             // link-local fe80::/10
        if ((h0 & 0xffc0) === 0xfec0) return true;             // site-local fec0::/10 (deprecated, still routed on some networks)
        if ((h0 & 0xfe00) === 0xfc00) return true;             // unique-local fc00::/7
        if ((h0 & 0xff00) === 0xff00) return true;             // multicast ff00::/8
        return false;
    }
    return true; // unparseable — refuse rather than guess
}

/**
 * Resolve a hostname (or pass an IP literal through) and vet every address.
 * Returns the resolved set; every address a name resolves to must pass, since
 * a hostname with one public and one loopback A record is a bypass, not a
 * coincidence.
 */
async function resolveAndVet(host) {
    let addresses;
    if (net.isIP(host)) {
        addresses = [{ address: host }];
    } else {
        try {
            addresses = await dns.lookup(host, { all: true });
        } catch {
            throw new Error(`could not resolve "${host}"`);
        }
    }
    for (const { address } of addresses) {
        if (isBlockedAddress(address)) {
            throw new Error(`"${host}" resolves to a private or loopback address (${address}) — refusing to fetch it`);
        }
    }
    return addresses;
}

/**
 * Resolve and vet a URL. Returns the parsed URL, or throws with a reason the
 * caller can surface.
 */
export async function assertFetchable(rawUrl) {
    let url;
    try { url = new URL(String(rawUrl)); } catch { throw new Error('not a valid URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`scheme "${url.protocol}" is not fetchable (http or https only)`);
    }
    if (url.username || url.password) throw new Error('URL must not contain credentials');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host) throw new Error('URL has no hostname');
    if (ALLOW_PRIVATE) return url;

    // A bare integer host ("http://2130706433/") is a loopback literal in
    // disguise on most resolvers; there is no legitimate reason to fetch one.
    if (/^\d+$/.test(host)) throw new Error('numeric host addresses are not fetchable');

    await resolveAndVet(host);
    return url;
}

/**
 * Header names that are a credential, and must not survive a hop to another
 * origin. `Authorization` and `Cookie` are the standard pair a browser drops on
 * a cross-origin redirect for exactly this reason; the other two are the shapes
 * the hosted search backends use (`searchBackends.js`: Brave takes
 * `X-Subscription-Token`, and an engine added later may well take `X-Api-Key`).
 *
 * The keys here are lower-case and matched case-insensitively, because a header
 * name is case-insensitive and a caller writing `'Authorization'` must not be
 * able to slip past a lookup for `'authorization'`.
 */
const CREDENTIAL_HEADERS = new Set([
    'authorization', 'cookie', 'proxy-authorization',
    'x-subscription-token', 'x-api-key',
]);

/**
 * The same request init with every credential header removed.
 *
 * `headers` may be a plain object, an array of pairs or a `Headers`, since the
 * callers are free to use any of them; all three are normalised to a plain
 * object so the result is still a value `fetch` accepts.
 */
function withoutCredentials(init) {
    const raw = init?.headers;
    if (!raw) return init;
    const entries = typeof raw.entries === 'function'
        ? [...raw.entries()]
        : Array.isArray(raw) ? raw : Object.entries(raw);
    const kept = Object.fromEntries(
        entries.filter(([name]) => !CREDENTIAL_HEADERS.has(String(name).toLowerCase())),
    );
    return { ...init, headers: kept };
}

/**
 * `fetch` that re-vets every redirect hop. Following redirects automatically
 * would let a vetted public URL hand the connection to 127.0.0.1 on the second
 * hop, which is the standard way this check is defeated.
 *
 * The DNS check itself has a residual gap: `fetch` resolves the name a second
 * time and connects to ITS answer, so a name with near-zero-TTL records could
 * give this vet a public address and the connection a private one (the classic
 * time-of-check/time-of-use gap; third-party audit, 2026-09-17). Pinning the
 * connection to the vetted address is the complete fix and needs undici's
 * dispatcher — measured on 2026-09-17: an Agent from the npm package handed to
 * Node's own `fetch` dies with "invalid onRequestStart method", because the
 * handler protocol must match the Node build's INTERNAL undici, and no single
 * pinned version matches every runtime this app ships for. So the window is
 * narrowed instead: resolve back-to-back a second time and demand the SAME
 * answer set, which the OS resolver's cache makes near-free when the name is
 * honest, and which a rebinding attack now has to defeat twice in the
 * milliseconds between the second lookup and fetch's own.
 *
 * A hop to ANOTHER ORIGIN also drops the credential headers. The hosted search
 * backends call this with the learner's own API key attached, so forwarding the
 * init verbatim meant one 302 from `api.tavily.com`, `s.jina.ai` or
 * `api.search.brave.com` would hand that key to whatever host the redirect
 * named. Re-vetting the address says nothing about whether the new host should
 * be trusted with the key; the key is what is being protected, not the socket.
 */
export async function safeFetch(rawUrl, init = {}) {
    let target = String(rawUrl);
    let hopInit = init;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const url = await assertFetchable(target);
        const host = url.hostname.replace(/^\[|\]$/g, '');
        if (!ALLOW_PRIVATE && !net.isIP(host)) {
            const vetted = await resolveAndVet(host);
            const again = await resolveAndVet(host);
            const key = (list) => list.map(a => a.address).sort().join(',');
            if (key(vetted) !== key(again)) {
                throw new Error(`"${host}" changed its addresses between resolutions (${key(vetted)} → ${key(again)}) — refusing to fetch it`);
            }
        }
        const res = await fetch(url, { ...hopInit, redirect: 'manual' });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            const next = new URL(res.headers.get('location'), url);
            if (next.origin !== url.origin) hopInit = withoutCredentials(hopInit);
            target = next.toString();
            continue;
        }
        return res;
    }
    throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

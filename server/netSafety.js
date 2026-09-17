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
        if (raw === '::' || raw === '::1') return true;        // unspecified / loopback
        if (raw.startsWith('fe80:')) return true;              // link-local
        if (/^f[cd]/.test(raw)) return true;                   // unique-local
        if (raw.startsWith('ff')) return true;                 // multicast
        return false;
    }
    return true; // unparseable — refuse rather than guess
}

/**
 * Resolve and vet a URL. Returns the parsed URL, or throws with a reason the
 * caller can surface. Every address a name resolves to must pass: a hostname
 * with one public and one loopback A record is a bypass, not a coincidence.
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
    return url;
}

/**
 * `fetch` that re-vets every redirect hop. Following redirects automatically
 * would let a vetted public URL hand the connection to 127.0.0.1 on the second
 * hop, which is the standard way this check is defeated.
 */
export async function safeFetch(rawUrl, init = {}) {
    let target = String(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const url = await assertFetchable(target);
        const res = await fetch(url, { ...init, redirect: 'manual' });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            target = new URL(res.headers.get('location'), url).toString();
            continue;
        }
        return res;
    }
    throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

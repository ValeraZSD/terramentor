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
 * On a local-first app that is not an abstract SSRF: the same machine often runs
 * a model server on a loopback port, and the learner's router is one hop away,
 * so a shared course or a captured link could make the study app read a LAN
 * service or a local port and paste the answer
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
// The npm package, not Node's built-in `fetch`: the pinned Agent below and the
// fetch that uses it must come from the SAME undici (see safeFetch).
import { Agent, fetch as undiciFetch } from 'undici';

const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_FETCH === '1';
const MAX_REDIRECTS = 3;

function isBlockedIPv4(v4) {
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

/** An IPv6 literal as its eight 16-bit groups, or null. A trailing dotted quad
 *  (`::ffff:127.0.0.1`) is two groups. */
function ipv6Groups(v6) {
    const text = v6.replace(/%.*$/, '');                   // a zone id names an interface, not an address
    const halves = text.split('::');
    if (halves.length > 2) return null;
    const part = (s) => {
        if (!s) return [];
        const out = [];
        for (const piece of s.split(':')) {
            if (net.isIPv4(piece)) {
                const [a, b, c, d] = piece.split('.').map(Number);
                out.push((a << 8) | b, (c << 8) | d);
            } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
                out.push(parseInt(piece, 16));
            } else {
                return null;
            }
        }
        return out;
    };
    const head = part(halves[0]);
    const tail = halves.length === 2 ? part(halves[1]) : [];
    if (!head || !tail) return null;
    if (halves.length === 1) return head.length === 8 ? head : null;
    const fill = 8 - head.length - tail.length;
    return fill < 1 ? null : [...head, ...new Array(fill).fill(0), ...tail];
}

const groupsToV4 = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/** Is this literal address one an outbound fetch must never be aimed at? */
export function isBlockedAddress(ip) {
    const raw = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (net.isIPv4(raw)) return isBlockedIPv4(raw);
    if (!net.isIPv6(raw)) return true;                     // unparseable — refuse rather than guess
    const g = ipv6Groups(raw);
    if (!g) return true;
    // An IPv4 address carried inside an IPv6 one is judged as the IPv4 address.
    // The URL parser writes [::ffff:127.0.0.1] as [::ffff:7f00:1], so the
    // embedded address has to be read out of the groups, never off the text.
    const zero = (from, to) => g.slice(from, to).every(x => x === 0);
    if (zero(0, 5) && g[5] === 0xffff) return isBlockedIPv4(groupsToV4(g[6], g[7]));   // mapped ::ffff:0:0/96
    if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return isBlockedIPv4(groupsToV4(g[6], g[7])); // translated ::ffff:0:0:0/96 (SIIT)
    if (zero(0, 6)) return g[6] === 0 && g[7] <= 1 ? true                              // :: and ::1
        : isBlockedIPv4(groupsToV4(g[6], g[7]));                                         // compatible ::/96
    if (g[0] === 0x64 && g[1] === 0xff9b) return zero(2, 6)
        ? isBlockedIPv4(groupsToV4(g[6], g[7]))                                          // NAT64 64:ff9b::/96
        : true;                                                                          // local-use NAT64 64:ff9b:1::/48
    if (g[0] === 0x2002) return isBlockedIPv4(groupsToV4(g[1], g[2]));                  // 6to4 2002::/16
    if (g[0] === 0x2001 && g[1] === 0) return true;                                      // Teredo 2001::/32
    // Ranges are prefixes of BITS, not of text: fe80::/10 runs to febf::,
    // so a string test for "fe80:" let fe81::1 through. Mask the first group.
    const h0 = g[0];
    if ((h0 & 0xffc0) === 0xfe80) return true;             // link-local fe80::/10
    if ((h0 & 0xffc0) === 0xfec0) return true;             // site-local fec0::/10 (deprecated, still routed on some networks)
    if ((h0 & 0xfe00) === 0xfc00) return true;             // unique-local fc00::/7
    if ((h0 & 0xff00) === 0xff00) return true;             // multicast ff00::/8
    return false;
}

/**
 * Resolve a hostname (or pass an IP literal through) and vet every address.
 * Returns the resolved set; every address a name resolves to must pass, since
 * a hostname with one public and one loopback A record is a bypass, not a
 * coincidence.
 */
async function resolveHost(host) {
    if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
    try {
        return await dns.lookup(host, { all: true });
    } catch {
        throw new Error(`could not resolve "${host}"`);
    }
}

async function resolveAndVet(host) {
    const addresses = await resolveHost(host);
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
    return (await vetUrl(rawUrl)).url;
}

/** assertFetchable's work, plus the addresses it vetted (null when
 *  `ALLOW_PRIVATE_FETCH` skipped the lookup). */
async function vetUrl(rawUrl) {
    let url;
    try { url = new URL(String(rawUrl)); } catch { throw new Error('not a valid URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`scheme "${url.protocol}" is not fetchable (http or https only)`);
    }
    if (url.username || url.password) throw new Error('URL must not contain credentials');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host) throw new Error('URL has no hostname');
    if (ALLOW_PRIVATE) return { url, host, addresses: null };

    // A bare integer host ("http://2130706433/") is a loopback literal in
    // disguise on most resolvers; there is no legitimate reason to fetch one.
    if (/^\d+$/.test(host)) throw new Error('numeric host addresses are not fetchable');

    return { url, host, addresses: await resolveAndVet(host) };
}

/**
 * A connect-time `lookup` that can only answer with `addresses` — the set that
 * was just vetted — so the socket never asks the resolver a second time. Node's
 * `net.connect` calls it with `all: true` when it races address families, and
 * without it otherwise; `family` narrows the set the way the OS resolver would.
 */
function pinnedLookup(host, addresses) {
    const pinned = addresses.map(a => ({ address: a.address, family: a.family || net.isIP(a.address) }));
    return (hostname, options, callback) => {
        if (typeof options === 'function') { callback = options; options = {}; }
        const family = typeof options === 'number' ? options : Number(options?.family) || 0;
        const list = pinned.filter(a => !family || a.family === family);
        if (hostname !== host || list.length === 0) {
            const err = Object.assign(new Error(`no vetted address for "${hostname}"`), { code: 'ENOTFOUND' });
            return process.nextTick(callback, err);
        }
        if (options?.all) process.nextTick(callback, null, list);
        else process.nextTick(callback, null, list[0].address, list[0].family);
    };
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
 * The connection is PINNED to the addresses the vet approved. A plain `fetch`
 * resolves the name again and connects to ITS answer, so a name with
 * near-zero-TTL records could give the vet a public address and the socket a
 * private one (DNS rebinding; reproduced by two outside audits, 2026-09-17 and
 * 2026-09-29 — comparing two back-to-back lookups, the earlier narrowing, only
 * made the attacker win twice). Each hop gets its own undici Agent whose
 * connect-time `lookup` can only answer the vetted set, while the URL still
 * carries the NAME, so the Host header and the TLS server name (and so the
 * certificate check) are the hostname's, never the address's. An IP literal
 * needs no lookup and is vetted as itself. Under `ALLOW_PRIVATE_FETCH` the
 * name is resolved once and pinned without the vet.
 *
 * The Agent and the `fetch` both come from the npm `undici` package: an Agent
 * handed to Node's BUILT-IN `fetch` dies with "invalid onRequestStart method"
 * (measured 2026-09-17), because the handler protocol must match the Node
 * build's internal undici, which differs by runtime. One package for both
 * halves makes the pair match on every Node this app runs on.
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
        // Every hop is resolved, vetted and pinned afresh: a redirect names a
        // new host, and the previous hop's addresses say nothing about it.
        const vetted = await vetUrl(target);
        const { url, host } = vetted;
        const addresses = vetted.addresses ?? await resolveHost(host);
        // `pipelining: 0` turns keep-alive off: this Agent carries one response
        // and is never reused, so an idle socket kept for a server's
        // `Keep-Alive: timeout=600` would only be a handle held ten minutes
        // per fetch (100 fetches left 99 open, measured).
        const dispatcher = new Agent({ pipelining: 0, connect: { lookup: pinnedLookup(host, addresses) } });
        let res;
        try {
            res = await undiciFetch(url, { ...hopInit, redirect: 'manual', dispatcher });
        } catch (err) {
            // destroy, not close: the request failed, so nothing on this
            // Agent is worth waiting for.
            dispatcher.destroy().catch(() => {});
            throw err;
        }
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            const next = new URL(res.headers.get('location'), url);
            if (next.origin !== url.origin) hopInit = withoutCredentials(hopInit);
            target = next.toString();
            await res.body?.cancel().catch(() => {});
            dispatcher.close().catch(() => {});
            continue;
        }
        // The Agent serves this one response; with keep-alive off, its socket
        // closes once the caller has read (or cancelled) the body.
        return res;
    }
    throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

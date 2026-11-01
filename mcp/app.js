// The MCP server's one way into the library: the running app's own HTTP API.
//
// Nothing here opens the database. Terramentor is one process over one SQLite
// file (WAL, a background task queue, a write-capable startup sweep), and a
// second process opening the same file would race the first; so the MCP server
// is a thin client of the app that is already running, and every read and
// write is the app's own route behind its own password check
// (server/routes/agent.js, POST /api/capture). tools/mcp-gates.mjs fails if
// anything under mcp/ imports server/.

/** Where the app listens by default (`npm run standalone`, the desktop app). */
export const DEFAULT_URL = 'http://127.0.0.1:3001';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const REQUEST_TIMEOUT_MS = 30_000;
const ERROR_CHARS = 300;
/** Where the learner finds the key (src/components/settings/sections.ts, SecuritySettings). */
const KEY_PLACE = 'Terramentor → Settings → Devices & security → API key';

/** A failure the agent's model can read and pass on: what went wrong and what to do. */
export class AppError extends Error {}

export const isLoopbackHost = (hostname) => LOOPBACK_HOSTS.has(String(hostname).toLowerCase());

/**
 * The app's origin from TERRAMENTOR_URL. Plain http only to this computer: the
 * API key rides on every request, and over http to another machine anyone on
 * the path could read it. Throws AppError with the reason.
 */
export function appOrigin(raw = DEFAULT_URL) {
    const value = String(raw || DEFAULT_URL).trim();
    let url;
    try { url = new URL(value); } catch { throw new AppError(`TERRAMENTOR_URL is not an address: "${value.slice(0, 120)}"`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new AppError(`TERRAMENTOR_URL must start with http:// or https://, not ${url.protocol}`);
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
        throw new AppError(`TERRAMENTOR_URL ${url.origin} is another computer over plain http, which would send the API key unencrypted. Use https:// for it, or run the MCP server on the computer the app runs on.`);
    }
    return url.origin;
}

/**
 * A client of one app for one caller.
 *
 * `authorization` is the whole Authorization header the app is sent, or null.
 * On stdio it is built from TERRAMENTOR_API_KEY; on the HTTP listener it is
 * the caller's own header, passed through, never the environment's
 * (mcp/index.js says why). `keyHint` words the "where to put the key" half of
 * the 401 message for that transport.
 */
export function appClient({ origin, authorization = null, keyHint, clientName = () => null, timeZone = null }) {
    async function request(method, path, { query = null, body = null } = {}) {
        const url = new URL(path, origin);
        for (const [k, v] of Object.entries(query || {})) {
            if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
        }
        const headers = { Accept: 'application/json' };
        if (authorization) headers.Authorization = authorization;
        if (timeZone) headers['X-Time-Zone'] = timeZone;
        const name = clientName();
        if (name) headers['X-Agent-Client'] = String(name).replace(/[^\x20-\x7e]/g, '').slice(0, 80);
        if (body) headers['Content-Type'] = 'application/json';

        let res;
        try {
            res = await fetch(url, {
                method, headers,
                body: body ? JSON.stringify(body) : undefined,
                redirect: 'error',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (err) {
            // `redirect: 'error'`: the key rides on the request, so a redirect is
            // not followed, and is named rather than read as "not running".
            if (/redirect/i.test(String(err?.cause?.message || ''))) {
                throw new AppError(`Terramentor at ${origin} answered with a redirect, which this MCP server does not follow (the API key would go with it). Set TERRAMENTOR_URL to the address the app itself answers on.`);
            }
            const code = err?.cause?.code || (err?.name === 'TimeoutError' ? 'timed out' : '');
            throw new AppError(`Terramentor is not running, or this MCP server could not reach it at ${origin}${code ? ` (${code})` : ''}. Start the app, or set TERRAMENTOR_URL to the address it runs on, then try again.`);
        }

        const raw = await res.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
        if (res.ok && data && typeof data === 'object') return data;

        const said = data && typeof data.error === 'string' ? data.error.slice(0, ERROR_CHARS) : '';
        if (res.status === 401 && data?.setupRequired) {
            // A library with no password answers this computer only; this one
            // reached it as another device (TERRAMENTOR_URL to another machine).
            throw new AppError(`Terramentor at ${origin} has no password yet, and it answers another device only once one is set. Set a password there, press Generate key in ${KEY_PLACE}, then ${keyHint}`);
        }
        if (res.status === 401) {
            throw new AppError(authorization
                ? `Terramentor at ${origin} refused the API key: it is wrong, or was regenerated or deleted. Copy the current key from ${KEY_PLACE}; ${keyHint}`
                : `This Terramentor library has a password, so the MCP server needs its API key. Copy it from ${KEY_PLACE} (press Generate key there if it shows none); ${keyHint}`);
        }
        if (!data) {
            throw new AppError(`Terramentor at ${origin} answered ${res.status} without data: it may be an older version without the MCP routes (update the app), or TERRAMENTOR_URL points at something else.`);
        }
        throw new AppError(said || `Terramentor at ${origin} answered ${res.status}.`);
    }

    return {
        origin,
        get: (path, query) => request('GET', path, { query }),
        post: (path, body) => request('POST', path, { body }),
    };
}

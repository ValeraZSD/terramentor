/**
 * Who is allowed to talk to `/api` — the browser-side half of the local-first
 * promise.
 *
 * `app.use(cors())` sent `Access-Control-Allow-Origin: *` on every endpoint.
 * Binding to 127.0.0.1 does not help against that: the learner's OWN browser
 * can always reach loopback, so any page they had open could read and write the
 * whole local API — every project, every private note, the vault, the settings
 * dump (which carries `ai_openai_api_key` for anyone using a cloud provider) —
 * and could `POST /api/auth/setup` to lock the owner out of their own app,
 * because the gate ships off by default and first-run setup is necessarily
 * unauthenticated. That is a drive-by against a single-user app that never
 * needed cross-origin access in the first place: in dev, Vite proxies `/api`,
 * and in standalone the SPA is served from this very origin, so BOTH supported
 * deployments are same-origin. The wildcard bought nothing and gave away
 * everything.
 *
 * Two headers are checked, because they answer two different questions:
 *
 *   - `Origin` — "which page is asking?". Present on every cross-site request a
 *     browser makes, and on same-site writes. An unrecognised one is refused
 *     outright rather than merely denied the response body: without CORS headers
 *     a browser hides the ANSWER, but the request has already run, so a simple
 *     `POST` would still have deleted the project.
 *   - `Host` — "what name did they use to get here?". This is the DNS-rebinding
 *     guard. An attacker can point `evil.example` at 127.0.0.1, at which point
 *     their page IS same-origin with this server and the Origin check passes by
 *     construction. Names that cannot be rebound (loopback, private LAN, the
 *     Tailscale tailnet, mDNS) are the ones this app is actually reached by.
 *
 * No header means no browser — `curl`, the repo's own `tools/*.mjs` and a
 * Telegram bot send neither an `Origin` nor a foreign `Host`, and are unaffected.
 * Anything else is one env var away: `ALLOWED_ORIGINS` / `ALLOWED_HOSTS`,
 * comma-separated.
 */

import net from 'node:net';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Comma-separated env list → lowercased Set, empty when unset. */
function envSet(name) {
    return new Set(
        String(process.env[name] || '')
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean),
    );
}

const EXTRA_ORIGINS = envSet('ALLOWED_ORIGINS');
const EXTRA_HOSTS = envSet('ALLOWED_HOSTS');

/** Strip a `:port` and IPv6 brackets so a hostname can be classified. */
export function hostnameOf(hostHeader) {
    const raw = String(hostHeader || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1); // [::1]:3001 → [::1]
    const cut = raw.lastIndexOf(':');
    // A bare IPv6 literal has several colons and no port; only strip a real one.
    return cut > 0 && !raw.slice(0, cut).includes(':') ? raw.slice(0, cut) : raw;
}

/**
 * A name this machine can be legitimately reached by. Deliberately NOT a
 * general "is this a private address" test — the point is that the name cannot
 * be pointed somewhere else by whoever controls a public DNS zone.
 */
export function isLocalHostname(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (!h) return false;
    if (LOOPBACK.has(h)) return true;
    if (EXTRA_HOSTS.has(h)) return true;
    if (h.endsWith('.local')) return true;          // mDNS / Bonjour
    if (h.endsWith('.ts.net')) return true;         // Tailscale tailnet (`tailscale serve`)
    // The private-range checks below match IP LITERALS only, never DNS names.
    // `10.evil.com` starts with "10." but is not in 10/8: whoever controls
    // evil.com decides where it resolves, which is exactly the rebinding the
    // Host check exists to refuse — a name the attacker chose must not pass
    // because of the characters it happens to begin with. net.isIP() is the
    // gate: "10.1.2.3" → 4, "10.evil.com" → 0.
    if (net.isIP(h) === 4) {
        // 100.64.0.0/10 — the addresses Tailscale gives machines on a tailnet,
        // and what a phone reaches this server by when the person skipped
        // MagicDNS and typed the address. The `.ts.net` name above only covers
        // the half who did not. Same class as the private ranges below: not
        // un-rebindable in theory, but no more rebindable than 10/8, and it is
        // how the app is actually reached from another device. Outbound is the
        // opposite question and stays refused (server/netSafety.js).
        return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)
            || /^127\./.test(h)                        // 127.0.0.0/8
            || /^10\./.test(h)                         // 10.0.0.0/8
            || /^192\.168\./.test(h)                   // 192.168.0.0/16
            || /^172\.(1[6-9]|2\d|3[01])\./.test(h)    // 172.16.0.0/12
            || /^169\.254\./.test(h);                  // link-local
    }
    if (net.isIP(h) === 6) {
        return h === '::1'
            || /^f[cd]/.test(h)                        // fc00::/7 — unique local
            || /^fe[89ab]/.test(h);                    // fe80::/10 — link-local
    }
    // Bracketed IPv6 literals keep their brackets through hostnameOf and
    // URL.hostname, so isIP() sees 0; classify them by prefix.
    return h.startsWith('[fe80:') || h.startsWith('[fc') || h.startsWith('[fd');
}

/** May a page from this origin call the API? */
export function isAllowedOrigin(origin, req) {
    if (!origin) return true;                       // non-browser caller
    const o = String(origin).trim().toLowerCase();
    if (o === 'null') return false;                 // sandboxed iframe / file://
    if (EXTRA_ORIGINS.has(o)) return true;
    let parsed;
    try { parsed = new URL(o); } catch { return false; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // Same host as the one this request arrived on — the standalone app calling
    // its own origin, the Vite dev proxy (localhost:5173 → localhost:3001), and
    // a device that typed this server's address directly all land here.
    if (req && hostnameOf(req.headers.host) === parsed.hostname) return true;
    // A page on ANOTHER device of the local network is the drive-by this guard
    // exists for: the victim's own browser can always reach loopback, so a page
    // served at http://192.168.1.50:8080 can fetch http://127.0.0.1:3001 and, if
    // "local, therefore fine" were the answer, have the response reflected with
    // credentials. What stays allowed
    // is the reverse-proxy case: `tailscale serve` terminates the origin the
    // browser sees and hands the upstream a rewritten Host, and such a request
    // arrives carrying X-Forwarded-Proto, which a BROWSER cannot set (it is a
    // forbidden header name), so a direct page fetch cannot forge its way in.
    // Any other cross-host origin is one entry in ALLOWED_ORIGINS away.
    if (req && req.headers['x-forwarded-proto'] && isLocalHostname(parsed.hostname)) return true;
    return false;
}

/**
 * Express middleware. Mount on `/api` BEFORE the auth gate: a request that
 * should not have been made at all is refused before it can spend a login
 * attempt or run a handler.
 */
export function originGuard(req, res, next) {
    const host = hostnameOf(req.headers.host);
    // An empty Host is an HTTP/1.0 client, not a browser; browsers always send one.
    if (host && !isLocalHostname(host)) {
        return res.status(403).json({
            error: `Requests to "${host}" are refused. This app answers on loopback, your LAN or your tailnet; if you front it with another name, list it in ALLOWED_HOSTS.`,
        });
    }
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, req)) {
        return res.status(403).json({
            error: 'Cross-origin request refused. Only this app may call its own API; set ALLOWED_ORIGINS if you are embedding it deliberately.',
        });
    }
    next();
}

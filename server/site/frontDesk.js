// The front desk: one process at one address serving many people, each from
// their own library (server/site/libraries.js), each library being the app as
// it is.
//
// For every request: read the session cookie, find the person's library, wake
// it, and forward the request over the library's socket with a short-lived
// signed note saying who this is (server/siteLibrary.js). The front desk's own
// pages live under /site/: signing in, an invite link, the list of signed-in
// devices, signing out.
//
// What it guarantees about one browser shared by two people at one address:
// - the session cookie is `__Host-` (host-only, Secure, Path=/), HttpOnly,
//   SameSite=Lax, and never forwarded to a library;
// - no answer from a library is stored by the browser (`Cache-Control:
//   no-store` on everything but the build's hashed assets, which hold no one's
//   data), and a library cannot set a cookie;
// - signing out answers with `Clear-Site-Data: "cache", "storage"`, which
//   empties the address's caches, local and session storage, IndexedDB and the
//   service worker before anyone else signs in.
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { createAccounts, WRONG } from './accounts.js';
import { createLibraryPool, failureWord } from './libraries.js';
import { MIN_LENGTH } from './passwords.js';
import { inviteSpentPage, invitePage, openingPage, problemPage, signInPage } from './pages.js';
import { makeNote, NOTE_HEADER } from '../siteLibrary.js';
import { apiError, keyed } from '../clientError.js';

export const COOKIE = '__Host-tm_session';
const SESSION_COOKIE_MAX_AGE_S = 90 * 24 * 3600;
const FORM_LIMIT = 8 * 1024;

/** Is this peer a proxy we put there (loopback, or the container network)? */
function isNearProxy(addr) {
    const a = String(addr || '').replace(/^::ffff:/, '');
    if (a === '::1' || /^127\./.test(a)) return true;
    if (/^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
    return /^f[cd][0-9a-f]{2}:/i.test(a);
}

/** The client's address: the nearest proxy's word for it when the peer is one, else the peer. */
export function clientIp(req) {
    const peer = req.socket?.remoteAddress || '';
    if (!isNearProxy(peer)) return peer;
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const last = fwd[fwd.length - 1];
    return last && net.isIP(last) ? last : peer;
}

function requestProto(req) {
    if (req.socket?.encrypted) return 'https';
    if (isNearProxy(req.socket?.remoteAddress)) {
        const p = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
        if (p === 'https' || p === 'http') return p;
    }
    return 'http';
}

// The front desk's own log lines. They outlive every library and its erasure,
// so they name no person's text, no token and no request's query: a route by
// its shape, a failure by its kind, the code by file and line.
const SITE_ROUTES = new Set(['/site', '/site/health', '/site/sign-in', '/site/sign-out', '/site/sign-out-others', '/site/sessions', '/site/sessions.json']);

/** A request's address as a log line may name it: an invite link without its token, an app request as `app`. */
export function routeLabel(url) {
    const p = String(url || '').split('?')[0];
    if (SITE_ROUTES.has(p)) return p;
    if (p.startsWith('/site/invite/')) return '/site/invite/…';
    if (/^\/site\/sessions\/\d+\/sign-out$/.test(p)) return '/site/sessions/N/sign-out';
    if (p === '/site' || p.startsWith('/site/')) return '/site/…';
    return 'app';
}

/** Where a failure happened: up to four `at` lines of its stack, never its message. */
export function codeFrames(err) {
    // The stack opens with the message, which may itself hold lines shaped like frames.
    let stack = String(err?.stack || '');
    const message = String(err?.message ?? '');
    const at = message ? stack.indexOf(message) : -1;
    if (at >= 0) stack = stack.slice(at + message.length);
    else if (message) return ''; // the stack does not show where its message ends: no frames rather than its text
    const frames = stack.split('\n')
        .filter((l) => /^\s+at (?:.*\()?(?:file|node):[^\s()]+\)?$/.test(l))
        .slice(0, 4).map((l) => l.trim());
    return frames.length ? ` ${frames.join(' < ')}` : '';
}

function readCookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
}

/** The Cookie header without the front desk's own cookie, or null when nothing is left. */
function cookiesForLibrary(req) {
    const kept = String(req.headers.cookie || '').split(';').map((s) => s.trim())
        .filter((s) => s && !s.startsWith(`${COOKIE}=`));
    return kept.length ? kept.join('; ') : null;
}

function sessionCookie(token) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_S}`;
}
const CLEAR_COOKIE = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
export const CLEAR_SITE_DATA = '"cache", "storage"';

function readForm(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > FORM_LIMIT) { reject(Object.assign(new Error('form too large'), { status: 413 })); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            const type = String(req.headers['content-type'] || '');
            const text = Buffer.concat(chunks).toString('utf8');
            if (type.startsWith('application/json')) {
                try { resolve(JSON.parse(text || '{}')); } catch { resolve({}); }
            } else {
                resolve(Object.fromEntries(new URLSearchParams(text)));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Create the front desk. Returns `{ server, accounts, pool, close }`; the
 * caller listens. Options are read from the environment by server/site/index.js.
 */
export function createFrontDesk({
    db, siteDir, appRoot, separate, hosts = [], env = process.env, log = console,
    maxAwake, heapMb, memoryMb, idleMs, uidBase, breachCheck, sweepEveryMs = 30_000, libraryLogBytes,
}) {
    const pool = createLibraryPool({
        db, siteDir, appRoot, separate, maxAwake, heapMb, memoryMb, idleMs, uidBase, env, log,
        allowedHosts: hosts.join(','), ...(libraryLogBytes ? { logBytes: libraryLogBytes } : {}),
    });
    const accounts = createAccounts(db, {
        env, createLibrary: () => pool.create(), ...(breachCheck ? { breachCheck } : {}),
    });

    const hostAllowed = (req) => {
        if (!hosts.length) return true;
        const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
        return hosts.includes(h);
    };

    /** A form post from a page of this site, not from another site's page. */
    // The pages send no referrer, so a browser posts their forms with `Origin: null`;
    // an opaque origin then counts only when the browser itself says same-origin.
    function sameOrigin(req) {
        const origin = req.headers.origin;
        const site = String(req.headers['sec-fetch-site'] || '');
        if (origin === 'null') return site === 'same-origin';
        if (origin) return origin.toLowerCase() === `${requestProto(req)}://${String(req.headers.host || '').toLowerCase()}`;
        return !site || site === 'same-origin' || site === 'none';
    }

    function send(res, status, html, headers = {}) {
        res.writeHead(status, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            ...headers,
        });
        res.end(html);
    }
    const nonceHeaders = () => {
        const nonce = crypto.randomBytes(16).toString('base64');
        return {
            nonce,
            headers: {
                'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
            },
        };
    };
    const redirect = (res, to, headers = {}) => { res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...headers }); res.end(); };
    const json = (res, status, body, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
        res.end(JSON.stringify(body));
    };

    const currentSession = (req) => accounts.sessionOf(readCookie(req, COOKIE));

    async function siteRoute(req, res, url) {
        const { pathname } = url;
        const method = req.method;
        if (pathname === '/site/health') return json(res, 200, { ok: true });
        if (method === 'POST' && !sameOrigin(req)) return json(res, 403, apiError('Cross-origin form refused.'));

        if (pathname === '/site/sign-in') {
            if (method === 'GET') {
                if (currentSession(req)) return redirect(res, '/');
                const { nonce, headers } = nonceHeaders();
                const info = url.searchParams.has('signed-out') ? 'You have been signed out.' : '';
                return send(res, 200, signInPage({ nonce, info }), headers);
            }
            if (method === 'POST') {
                const form = await readForm(req);
                const result = await accounts.signIn(form.email, form.password, { ip: clientIp(req), ua: req.headers['user-agent'] });
                // Whatever an earlier person left in this browser (a session that ran
                // out, or was ended from another device) goes before this one's opens.
                if (result.ok) return redirect(res, '/', { 'Set-Cookie': sessionCookie(result.token), 'Clear-Site-Data': CLEAR_SITE_DATA });
                const { nonce, headers } = nonceHeaders();
                const error = result.wait ? `Too many tries. Wait ${result.wait} seconds and try again.`
                    : result.passwordOff ? 'This account is locked after too many wrong passwords. Ask your administrator to unlock it.'
                        : result.busy ? 'The site is busy. Try again in a moment.'
                            : WRONG;
                const status = result.wait || result.busy ? 429 : 401;
                return send(res, status, signInPage({ nonce, email: String(form.email || '').slice(0, 254), error }),
                    result.wait ? { ...headers, 'Retry-After': String(result.wait) } : headers);
            }
        }

        // Any invite address answers as one: a link an email program cut short
        // says it no longer works, never a bare sign-in page.
        const invite = /^\/site\/invite\/([^/]*)$/.exec(pathname);
        if (invite) {
            const token = invite[1];
            const found = /^[A-Za-z0-9_-]{20,100}$/.test(token) ? accounts.inviteOf(token) : null;
            const { nonce, headers } = nonceHeaders();
            if (!found) return send(res, 410, inviteSpentPage({ nonce }), headers);
            if (method === 'GET') return send(res, 200, invitePage({ nonce, token, email: found.email, minLength: MIN_LENGTH }), headers);
            if (method === 'POST') {
                const form = await readForm(req);
                if (String(form.password ?? '') !== String(form.again ?? '')) {
                    return send(res, 400, invitePage({ nonce, token, email: found.email, minLength: MIN_LENGTH, ...keyed('The two passwords are not the same.') }), headers);
                }
                let result;
                try {
                    result = await accounts.acceptInvite(token, form.password, req.headers['user-agent']);
                } catch (e) {
                    if (e?.code !== 'AUTH_BUSY') throw e;
                    result = keyed('The site is busy. Try again in a moment.');
                }
                if (result.spent) return send(res, 410, inviteSpentPage({ nonce }), headers);
                if (result.error) return send(res, 400, invitePage({ nonce, token, email: found.email, minLength: MIN_LENGTH, error: result.error }), headers);
                // The new library's first start makes its database; done here so
                // the first page does not wait for it.
                await pool.wake(result.libraryId).catch((e) => log.error(`[site] First start of library ${result.libraryId.slice(0, 8)} failed: ${failureWord(e)}`));
                return redirect(res, '/', { 'Set-Cookie': sessionCookie(result.token), 'Clear-Site-Data': CLEAR_SITE_DATA });
            }
        }

        const session = currentSession(req);
        if (pathname === '/site/sign-out' && method === 'POST') {
            if (session && accounts.endSession(session.sessionId, session.accountId)) closeStreams(session.sessionId);
            return redirect(res, '/site/sign-in?signed-out', { 'Set-Cookie': CLEAR_COOKIE, 'Clear-Site-Data': CLEAR_SITE_DATA });
        }
        // The app asks for JSON (the devices list in its Settings); a page asks for a page.
        const wantsJson = pathname.endsWith('.json') || /application\/json/.test(String(req.headers.accept || ''));
        if (!session) return wantsJson ? json(res, 401, { ...keyed('Sign in again'), authRequired: true, site: true }) : redirect(res, '/site/sign-in');
        // The signed-in devices live in the app: Settings, Devices & security.
        const DEVICES = '/settings#devices';
        if (pathname === '/site/sign-out-others' && method === 'POST') {
            const ended = accounts.endOtherSessions(session.accountId, session.sessionId);
            closeEndedStreams();
            return wantsJson ? json(res, 200, { ended }) : redirect(res, DEVICES);
        }
        const endOne = /^\/site\/sessions\/(\d+)\/sign-out$/.exec(pathname);
        if (endOne && method === 'POST') {
            const id = Number(endOne[1]);
            if (accounts.endSession(id, session.accountId)) closeStreams(id);
            if (id === session.sessionId) {
                return redirect(res, '/site/sign-in?signed-out', { 'Set-Cookie': CLEAR_COOKIE, 'Clear-Site-Data': CLEAR_SITE_DATA });
            }
            return wantsJson ? json(res, 200, { ok: true }) : redirect(res, DEVICES);
        }
        if (pathname === '/site/sessions' && method === 'GET') return redirect(res, DEVICES);
        if (pathname === '/site/sessions.json' && method === 'GET') {
            return json(res, 200, {
                email: session.email,
                sessions: accounts.listSessions(session.accountId).map((s) => ({ ...s, current: s.id === session.sessionId })),
            });
        }
        const { nonce, headers } = nonceHeaders();
        return send(res, 404, problemPage({ nonce, title: 'Not found', text: 'There is no page at this address.' }), headers);
    }

    // Answers being sent, by session, so ending a session also ends its open
    // streams (a session signed out from another device must stop receiving).
    const openAnswers = new Map(); // sessionId -> Set<res>
    function closeStreams(sessionId) {
        for (const r of openAnswers.get(sessionId) ?? []) r.destroy();
        openAnswers.delete(sessionId);
    }
    /** Close the streams of every session that has ended, here or by the operator's cli.js. */
    function closeEndedStreams() {
        for (const id of [...openAnswers.keys()]) if (!accounts.sessionAlive(id)) closeStreams(id);
    }

    async function forward(req, res, session) {
        let entry;
        try {
            entry = await pool.wake(session.libraryId);
        } catch (e) {
            if (e.code === 'FULL') {
                if (req.url.startsWith('/api/')) return json(res, 503, keyed('The site is busy. Try again in a moment.'), { 'Retry-After': '5' });
                const { nonce, headers } = nonceHeaders();
                return send(res, 503, openingPage({ nonce }), { ...headers, 'Retry-After': '5' });
            }
            log.error(`[site] Could not open library ${session.libraryId.slice(0, 8)}: ${failureWord(e)}`);
            if (req.url.startsWith('/api/')) return json(res, 502, keyed('Your library could not be opened. Try again in a moment.'));
            const { nonce, headers } = nonceHeaders();
            return send(res, 502, problemPage({ nonce, title: 'Your library could not be opened', text: 'Try again in a moment.' }), headers);
        }
        void entry;
        // The browser may have gone while the library woke; its close has already fired.
        if (res.destroyed || req.destroyed) return;
        // Another device may have ended this session while the library woke, when
        // there was no stream yet for closeStreams to close: nothing is forwarded.
        if (!accounts.sessionAlive(session.sessionId)) {
            if (req.url.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')) return json(res, 401, { ...keyed('Sign in again'), authRequired: true, site: true });
            return redirect(res, '/site/sign-in');
        }
        const headers = { ...req.headers };
        delete headers.cookie;
        delete headers[NOTE_HEADER];
        delete headers['x-forwarded-for'];
        delete headers['x-real-ip'];
        delete headers.forwarded;
        const cookies = cookiesForLibrary(req);
        if (cookies) headers.cookie = cookies;
        headers['x-forwarded-proto'] = requestProto(req);
        headers[NOTE_HEADER] = makeNote({
            key: pool.noteKey(session.libraryId), libraryId: session.libraryId,
            accountId: session.accountId, sessionId: session.sessionId,
        });
        pool.streamOpened(session.libraryId);
        const open = openAnswers.get(session.sessionId) ?? new Set();
        openAnswers.set(session.sessionId, open);
        open.add(res);
        let closed = false;
        let upstream = null;
        const done = () => {
            if (closed) return;
            closed = true;
            pool.streamClosed(session.libraryId);
            open.delete(res);
            if (!open.size && openAnswers.get(session.sessionId) === open) openAnswers.delete(session.sessionId);
            // A closed tab ends the library's side too, or a stream would run on unread.
            if (upstream && !res.writableFinished) upstream.destroy();
        };
        res.on('close', done);
        upstream = http.request({
            socketPath: pool.socketPath(session.libraryId), method: req.method, path: req.url, headers,
        }, (lib) => {
            const out = { ...lib.headers };
            delete out['set-cookie'];
            const path = req.url.split('?')[0];
            if (!path.startsWith('/assets/')) {
                out['cache-control'] = 'no-store';
                delete out.etag;
                delete out['last-modified'];
            }
            res.writeHead(lib.statusCode || 502, out);
            lib.pipe(res);
            lib.on('error', () => res.destroy());
        });
        upstream.on('error', (e) => {
            done();
            if (!res.headersSent) json(res, 502, keyed('Your library did not answer. Try again in a moment.'));
            else res.destroy();
            log.error(`[site] Library ${session.libraryId.slice(0, 8)} did not answer: ${failureWord(e)}`);
        });
        req.pipe(upstream);
    }

    const server = http.createServer(async (req, res) => {
        try {
            if (!hostAllowed(req)) return json(res, 421, keyed('This site does not answer to that name.'));
            const url = new URL(req.url, 'http://site');
            if (url.pathname === '/site' || url.pathname.startsWith('/site/')) return await siteRoute(req, res, url);
            const session = currentSession(req);
            if (!session) {
                if (url.pathname.startsWith('/api/')) return json(res, 401, { ...keyed('Sign in again'), authRequired: true, site: true });
                if (req.method === 'GET' || req.method === 'HEAD') return redirect(res, '/site/sign-in');
                return json(res, 401, { ...keyed('Sign in again'), authRequired: true, site: true });
            }
            return await forward(req, res, session);
        } catch (e) {
            log.error(`[site] ${req.method} ${routeLabel(req.url)} failed: ${failureWord(e)}${codeFrames(e)}`);
            if (!res.headersSent) json(res, e.status || 500, keyed('Something went wrong at the front desk.'));
            else res.destroy();
        }
    });
    server.headersTimeout = 60_000;
    server.requestTimeout = 900_000;
    server.keepAliveTimeout = 5_000;

    const sweeper = setInterval(() => {
        pool.sweep().catch((e) => log.error(`[site] Sweep failed: ${failureWord(e)}${codeFrames(e)}`));
        try { accounts.sweepSessions(); closeEndedStreams(); } catch (e) { log.error(`[site] Session sweep failed: ${failureWord(e)}${codeFrames(e)}`); }
    }, sweepEveryMs);
    sweeper.unref();

    async function close() {
        clearInterval(sweeper);
        await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
        await pool.stopAll();
    }

    return { server, accounts, pool, close, closeEndedStreams, openStreams: () => [...openAnswers.values()].reduce((n, s) => n + s.size, 0) };
}

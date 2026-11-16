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
import { createLibraryPool } from './libraries.js';
import { MIN_LENGTH } from './passwords.js';
import { inviteSpentPage, invitePage, openingPage, problemPage, sessionsPage, signInPage } from './pages.js';
import { makeNote, NOTE_HEADER } from '../siteLibrary.js';

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
    maxAwake, heapMb, memoryMb, idleMs, uidBase, breachCheck, sweepEveryMs = 30_000,
}) {
    const pool = createLibraryPool({
        db, siteDir, appRoot, separate, maxAwake, heapMb, memoryMb, idleMs, uidBase, env, log,
        allowedHosts: hosts.join(','),
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
        if (method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'Cross-origin form refused.' });

        if (pathname === '/site/sign-in') {
            if (method === 'GET') {
                if (currentSession(req)) return redirect(res, '/');
                const { nonce, headers } = nonceHeaders();
                const info = url.searchParams.has('signed-out') ? 'You are signed out. Nothing of your library is left in this browser.' : '';
                return send(res, 200, signInPage({ nonce, info }), headers);
            }
            if (method === 'POST') {
                const form = await readForm(req);
                const result = await accounts.signIn(form.email, form.password, { ip: clientIp(req), ua: req.headers['user-agent'] });
                if (result.ok) return redirect(res, '/', { 'Set-Cookie': sessionCookie(result.token) });
                const { nonce, headers } = nonceHeaders();
                const error = result.wait ? `Too many tries. Wait ${result.wait} seconds and try again.`
                    : result.passwordOff ? 'Signing in with this password is switched off after too many wrong tries. Ask whoever runs this site to switch it back on.'
                        : result.busy ? 'The site is busy. Try again in a moment.'
                            : WRONG;
                const status = result.wait || result.busy ? 429 : 401;
                return send(res, status, signInPage({ nonce, email: String(form.email || '').slice(0, 254), error }),
                    result.wait ? { ...headers, 'Retry-After': String(result.wait) } : headers);
            }
        }

        const invite = /^\/site\/invite\/([A-Za-z0-9_-]{20,100})$/.exec(pathname);
        if (invite) {
            const token = invite[1];
            const found = accounts.inviteOf(token);
            const { nonce, headers } = nonceHeaders();
            if (!found) return send(res, 410, inviteSpentPage({ nonce }), headers);
            if (method === 'GET') return send(res, 200, invitePage({ nonce, token, email: found.email, minLength: MIN_LENGTH }), headers);
            if (method === 'POST') {
                const form = await readForm(req);
                if (String(form.password ?? '') !== String(form.again ?? '')) {
                    return send(res, 400, invitePage({ nonce, token, email: found.email, minLength: MIN_LENGTH, error: 'The two passwords are not the same.' }), headers);
                }
                const result = await accounts.acceptInvite(token, form.password, req.headers['user-agent']);
                if (result.spent) return send(res, 410, inviteSpentPage({ nonce }), headers);
                if (result.error) return send(res, 400, invitePage({ nonce, token, email: found.email, minLength: MIN_LENGTH, error: result.error }), headers);
                // The new library's first start makes its database; done here so
                // the first page does not wait for it.
                await pool.wake(result.libraryId).catch((e) => log.error(`[site] First start of a new library failed: ${e.message}`));
                return redirect(res, '/', { 'Set-Cookie': sessionCookie(result.token) });
            }
        }

        const session = currentSession(req);
        if (pathname === '/site/sign-out' && method === 'POST') {
            if (session) accounts.endSession(session.sessionId, session.accountId);
            return redirect(res, '/site/sign-in?signed-out', { 'Set-Cookie': CLEAR_COOKIE, 'Clear-Site-Data': CLEAR_SITE_DATA });
        }
        if (!session) return redirect(res, '/site/sign-in');
        if (pathname === '/site/sign-out-everywhere' && method === 'POST') {
            accounts.endAllSessions(session.accountId);
            return redirect(res, '/site/sign-in?signed-out', { 'Set-Cookie': CLEAR_COOKIE, 'Clear-Site-Data': CLEAR_SITE_DATA });
        }
        const endOne = /^\/site\/sessions\/(\d+)\/sign-out$/.exec(pathname);
        if (endOne && method === 'POST') {
            const id = Number(endOne[1]);
            if (id === session.sessionId) {
                accounts.endSession(id, session.accountId);
                return redirect(res, '/site/sign-in?signed-out', { 'Set-Cookie': CLEAR_COOKIE, 'Clear-Site-Data': CLEAR_SITE_DATA });
            }
            accounts.endSession(id, session.accountId);
            return redirect(res, '/site/sessions?ended');
        }
        if (pathname === '/site/sessions' && method === 'GET') {
            const { nonce, headers } = nonceHeaders();
            return send(res, 200, sessionsPage({
                nonce, email: session.email, sessions: accounts.listSessions(session.accountId), currentId: session.sessionId,
                info: url.searchParams.has('ended') ? 'That device is signed out.' : '',
            }), headers);
        }
        if (pathname === '/site/sessions.json' && method === 'GET') {
            return json(res, 200, { sessions: accounts.listSessions(session.accountId).map((s) => ({ ...s, current: s.id === session.sessionId })) });
        }
        const { nonce, headers } = nonceHeaders();
        return send(res, 404, problemPage({ nonce, title: 'Not found', text: 'There is no page at this address.' }), headers);
    }

    async function forward(req, res, session) {
        let entry;
        try {
            entry = await pool.wake(session.libraryId);
        } catch (e) {
            if (e.code === 'FULL') {
                if (req.url.startsWith('/api/')) return json(res, 503, { error: 'The site is busy. Try again in a moment.' }, { 'Retry-After': '5' });
                const { nonce, headers } = nonceHeaders();
                return send(res, 503, openingPage({ nonce }), { ...headers, 'Retry-After': '5' });
            }
            log.error(`[site] Could not open library ${session.libraryId.slice(0, 8)}: ${e.message}`);
            if (req.url.startsWith('/api/')) return json(res, 502, { error: 'Your library could not be opened. Try again in a moment.' });
            const { nonce, headers } = nonceHeaders();
            return send(res, 502, problemPage({ nonce, title: 'Your library could not be opened', text: 'Try again in a moment.' }), headers);
        }
        void entry;
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
        let closed = false;
        const done = () => { if (!closed) { closed = true; pool.streamClosed(session.libraryId); } };
        res.on('close', done);
        const upstream = http.request({
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
            if (!res.headersSent) json(res, 502, { error: 'Your library did not answer. Try again in a moment.' });
            else res.destroy();
            log.error(`[site] Library ${session.libraryId.slice(0, 8)} did not answer: ${e.message}`);
        });
        req.pipe(upstream);
    }

    const server = http.createServer(async (req, res) => {
        try {
            if (!hostAllowed(req)) return json(res, 421, { error: 'This site does not answer to that name.' });
            const url = new URL(req.url, 'http://site');
            if (url.pathname === '/site' || url.pathname.startsWith('/site/')) return await siteRoute(req, res, url);
            const session = currentSession(req);
            if (!session) {
                if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'Sign in again', authRequired: true, site: true });
                if (req.method === 'GET' || req.method === 'HEAD') return redirect(res, '/site/sign-in');
                return json(res, 401, { error: 'Sign in again', authRequired: true, site: true });
            }
            return await forward(req, res, session);
        } catch (e) {
            log.error(`[site] ${req.method} ${String(req.url).split('?')[0]}: ${e.stack || e.message}`);
            if (!res.headersSent) json(res, e.status || 500, { error: 'Something went wrong at the front desk.' });
            else res.destroy();
        }
    });
    server.headersTimeout = 60_000;
    server.requestTimeout = 900_000;
    server.keepAliveTimeout = 5_000;

    const sweeper = setInterval(() => {
        pool.sweep().catch((e) => log.error(`[site] Sweep failed: ${e.message}`));
        try { accounts.sweepSessions(); } catch (e) { log.error(`[site] Session sweep failed: ${e.message}`); }
    }, sweepEveryMs);
    sweeper.unref();

    async function close() {
        clearInterval(sweeper);
        await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
        await pool.stopAll();
    }

    return { server, accounts, pool, close };
}

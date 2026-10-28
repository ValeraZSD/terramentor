// Single-user authentication gate.
//
// This app has exactly one owner, so we don't want multi-user accounts, roles or
// sign-up — just ONE lock on the front door. When a password is configured the
// server refuses to serve any `/api` data until the caller proves it knows the
// secret; once proven, a browser stays logged in via a signed session cookie and
// programmatic clients (e.g. a chat bot) use a bearer API key.
//
// Design constraints:
//   - Zero new dependencies: hashing, signing and cookies are all built on
//     Node's `crypto`, so we add no supply-chain surface.
//   - Backwards compatible: with NO password set the gate is OFF and the app
//     behaves exactly as before (pure-local users on localhost are unaffected).
//     Binding to 127.0.0.1 (see index.js) is the always-on first layer; the
//     password is the second layer that makes remote access (Tailscale) safe.
//   - Sessions the server can end: the cookie is an HMAC-signed token naming a
//     row in `auth_sessions` (server/authSessions.js). Signing out deletes the
//     row; a session lasts 14 days from its last use; rotating the signing
//     secret and deleting every row (a password change, Sign out everywhere)
//     ends them all. A session token is a cookie only, never a Bearer.
//   - The three secrets live in the credentials file beside the library, not in
//     it (server/secrets.js): a copy of the library carries no password hash to
//     guess at offline and no secret to sign a session with. A library opened
//     without that file has no password, which is the safe way to be wrong:
//     with none set the app answers only its own machine (below).

import crypto from 'crypto';
import net from 'net';
import { COMPACT_PENDING, MOVED_MARK, deleteSecrets, getSecret, setSecrets } from './secrets.js';
// The hosted search backends' keys are credentials in the same sense as the
// provider key: they belong to their own write-only routes
// (/api/search/keys/:provider) and must never ride the settings dump.
import { SECRET_SEARCH_KEYS } from './searchBackends.js';
import { DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE_S, DEVICE_SETTING_KEYS, deviceName, remoteAccessOf } from './devices.js';
import { SESSION_TTL_MS, createSession, endAllSessions, endSession, useSession } from './authSessions.js';
import { hostnameOf, isOwnMachineName } from './originGuard.js';

// Settings keys owned by this module. They must NEVER be exposed by the generic
// `GET /api/settings` dump nor be writable through `PUT /api/settings/:key` —
// server/routes/settings.js guards both through `isSecretSettingKey`, which
// includes these.
const AUTH_KEYS = new Set(['auth_password_hash', 'auth_session_secret', 'auth_api_key']);
export function isAuthSettingKey(key) {
    return AUTH_KEYS.has(key);
}

// Rows the generic settings dump must never carry. The dump is readable by
// anything that can reach the app's origin, and its shape is "every preference
// at once" — so credentials do not belong in it. Two families sit behind their
// own endpoints instead: the gate's secrets via /api/auth/*, and the cloud
// provider key via /api/ai/key. The provider key is not an auth secret, but it
// IS a credential, so it is write-only over there and security-gates.mjs keeps
// it out of this dump. The key's ORIGIN row (which address the key may be sent
// to, `API_KEY_ORIGIN_SETTING` in ai.js) is not secret, but it is written only
// beside the key: a generic write to it would re-aim the key at another host.
export function isSecretSettingKey(key) {
    return isAuthSettingKey(key) || key === 'ai_openai_api_key' || key === 'ai_openai_api_key_origin'
        || CONNECTION_OWNED_KEYS.includes(key) || SECRET_SEARCH_KEYS.includes(key)
        || DEVICE_SETTING_KEYS.includes(key)
        || MOVE_OWNED_KEYS.includes(key);
}

// Written only by the move of credentials out of the library (secrets.js):
// whether this build has opened the library decides which copy of a
// credential wins, so a generic write must not be able to flip it.
const MOVE_OWNED_KEYS = [MOVED_MARK, COMPACT_PENDING];

// Written only by a saved connection being put in use (server/aiConnections.js):
// the protocol a connection forces (a ChatGPT plan's route would spend the
// plan for whatever address the rows name), which saved connection is in use,
// and this installation's ChatGPT host id.
const CONNECTION_OWNED_KEYS = ['ai_api_format', 'ai_active_connection', 'chatgpt_host_id'];

const COOKIE_NAME = 'sp_sid';

// scrypt parameters. memory ≈ 128 * N * r ≈ 16 MB, within Node's default maxmem.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/**
 * The shortest NEW password (first password and changes). A password set by an
 * older version under the old minimum of 6 still signs in: the rule is checked
 * where a password is chosen, never where one is given.
 */
export const MIN_PASSWORD_LENGTH = 10;

// --- the auth secrets, in the credentials file (auth namespace only) ---
function getRaw(key) {
    return getSecret(key) || null;
}
function setRaw(key, value) {
    setSecrets({ [key]: value });
}
function delRaw(key) {
    deleteSecrets(key);
}

// --- password hashing (scrypt, salted, versioned) ---
//
// scrypt runs on libuv's thread pool (`crypto.scrypt`), never on the main
// thread: each check is ~16 MB and tens of milliseconds of work, and the sync
// call stalled every other request — every page, every SSE stream — for as
// long as it ran, so a burst of guesses was also a way to freeze the app.
// At most PASSWORD_CHECKS_AT_ONCE run together, with a short queue behind them;
// past that a check is refused as busy (code AUTH_BUSY, a 429 to the caller)
// rather than queued without end. The thread pool is shared with file reads
// and DNS, so two leaves it room for the rest of the app.
const PASSWORD_CHECKS_AT_ONCE = 2;
const PASSWORD_CHECKS_WAITING = 16;
const passwordChecks = { running: 0, waiting: [], peak: 0 };

function scryptAsync(password, salt, keylen, opts) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
    });
}

/** Run one scrypt under the limit above. */
async function limitedScrypt(...args) {
    if (passwordChecks.running >= PASSWORD_CHECKS_AT_ONCE) {
        if (passwordChecks.waiting.length >= PASSWORD_CHECKS_WAITING) {
            throw Object.assign(new Error('Too many password checks at once'), { code: 'AUTH_BUSY' });
        }
        await new Promise(resolve => passwordChecks.waiting.push(resolve));
    } else {
        passwordChecks.running += 1;
    }
    passwordChecks.peak = Math.max(passwordChecks.peak, passwordChecks.running);
    try {
        return await scryptAsync(...args);
    } finally {
        // Hand the slot straight to the next in line, so `running` never drops
        // and rises again between them.
        const next = passwordChecks.waiting.shift();
        if (next) next();
        else passwordChecks.running -= 1;
    }
}

/** How busy the password check is (the gates read it). */
export function passwordCheckLoad() {
    return { running: passwordChecks.running, waiting: passwordChecks.waiting.length, peak: passwordChecks.peak };
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await limitedScrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return `scrypt$${SCRYPT.N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function verifyPassword(password, stored) {
    let salt, expected, N;
    try {
        const [scheme, n, saltHex, hashHex] = String(stored).split('$');
        if (scheme !== 'scrypt') return false;
        N = Number(n);
        salt = Buffer.from(saltHex, 'hex');
        expected = Buffer.from(hashHex, 'hex');
    } catch {
        return false;
    }
    let actual;
    try {
        actual = await limitedScrypt(password, salt, expected.length, { N, r: SCRYPT.r, p: SCRYPT.p });
    } catch (e) {
        if (e?.code === 'AUTH_BUSY') throw e; // busy is not "wrong": the caller says so
        return false;
    }
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// --- session signing secret (persisted, lazily created) ---
function sessionSecret() {
    let s = getRaw('auth_session_secret');
    if (!s) {
        s = crypto.randomBytes(32).toString('hex');
        setRaw('auth_session_secret', s);
    }
    return s;
}

// --- session tokens: `v2.<random id>.<hmac>`, each naming a row in auth_sessions ---
//
// The HMAC under the secret in the credentials file means a row alone (a copy
// of the library) is no session; the row means the server can end one. A
// `v1.` token from an older version had no row and is refused, so updating
// signs every browser out once.
const sign = (payload) => crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');

/** Start a session and return the token its cookie carries (never stored). */
export function issueToken(req) {
    const sid = crypto.randomBytes(18).toString('base64url');
    createSession(sid, deviceName(req?.headers?.['user-agent']));
    const payload = `v2.${sid}`;
    return `${payload}.${sign(payload)}`;
}

/** The session id inside a well-signed token, or null. Says nothing about whether it is live. */
function sidOf(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v2' || !parts[1]) return null;
    const payload = `v2.${parts[1]}`;
    return timingEqualHex(parts[2], sign(payload)) ? parts[1] : null;
}

/**
 * The live session behind this request's cookie, or null. Read once per
 * request (kept on `req`), so the renewal it may do is done once.
 * `{ token, renewed }`: `renewed` when this use moved the expiry, which is when
 * the cookie is sent again (renewSessionCookie).
 */
export function sessionOf(req) {
    if (req && Object.prototype.hasOwnProperty.call(req, 'authSession')) return req.authSession;
    const token = parseCookies(req)[COOKIE_NAME];
    const sid = sidOf(token);
    let live = null;
    if (sid) {
        try {
            const s = useSession(sid);
            if (s) live = { token, renewed: s.renewed };
        } catch (e) {
            console.error('[auth] session lookup failed:', e.message);
        }
    }
    if (req) req.authSession = live;
    return live;
}

/** A session renewed by this request goes back with a fresh Max-Age. */
export function renewSessionCookie(req, res) {
    const s = sessionOf(req);
    if (s?.renewed && !res.headersSent) setSessionCookie(res, s.token, isSecureRequest(req));
}

/** End the session behind this request's cookie (signing out). */
export function endRequestSession(req) {
    const sid = sidOf(parseCookies(req)[COOKIE_NAME]);
    if (sid) endSession(sid);
    if (req) req.authSession = null;
}

// --- API key for programmatic clients (bot, curl, scripts) ---
export function getApiKey() {
    return getRaw('auth_api_key');
}
export function regenerateApiKey() {
    const fresh = 'sk_' + crypto.randomBytes(24).toString('hex');
    setRaw('auth_api_key', fresh);
    return fresh;
}
/**
 * Withdraw the key entirely.
 *
 * Rotating is the answer to "this key leaked"; it is not the answer to "I no
 * longer run anything that needs one". Without a delete the only way to stop a
 * standing bearer credential existing was to remove the password gate, which
 * takes the lock off the whole app — the opposite of what someone tidying up
 * their credentials is trying to do. Deleting is immediate and complete: the
 * bearer check reads this row, so a request carrying the old key stops being
 * accepted the moment it is gone.
 */
export function deleteApiKey() {
    delRaw('auth_api_key');
    return true;
}

// --- password lifecycle ---
export function isAuthEnabled() {
    return !!getRaw('auth_password_hash');
}
/** Is this the password? A promise; rejects with code AUTH_BUSY when too many checks are running. */
export async function checkPassword(password) {
    const stored = getRaw('auth_password_hash');
    return stored ? verifyPassword(password, stored) : false;
}
/** Set (or replace) the password and end every session — a password change
 *  logs out all other devices (the caller signs the one that changed it back in). */
export async function setPassword(password) {
    const hash = await hashPassword(password);
    // One write: a new password never stands beside the old sessions' secret.
    setSecrets({
        auth_password_hash: hash,
        auth_session_secret: crypto.randomBytes(32).toString('hex'),
    });
    endAllSessions();
}
/**
 * End every password session without touching the password: a new signing
 * secret, and every session row gone. The caller ends the connected devices
 * (Sign out everywhere in routes/auth.js).
 */
export function endEverySession() {
    setRaw('auth_session_secret', crypto.randomBytes(32).toString('hex'));
    endAllSessions();
}
export function clearAuth() {
    deleteSecrets('auth_password_hash', 'auth_session_secret', 'auth_api_key');
    endAllSessions();
}

// --- constant-time helpers ---
function timingEqualHex(a, b) {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}
function timingEqual(a, b) {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

// --- cookies (manual, no dependency) ---
export function parseCookies(req) {
    const out = {};
    const header = req.headers && req.headers.cookie;
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        if (!k) continue;
        // A cookie some other app set with a bare '%' would otherwise throw
        // here and turn every request into a 500 instead of a plain "not
        // logged in".
        try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = ''; }
    }
    return out;
}
function appendSetCookie(res, cookie) {
    const prev = res.getHeader('Set-Cookie');
    if (!prev) res.setHeader('Set-Cookie', cookie);
    else res.setHeader('Set-Cookie', Array.isArray(prev) ? [...prev, cookie] : [prev, cookie]);
}
export function setSessionCookie(res, token, secure) {
    const attrs = [
        `${COOKIE_NAME}=${encodeURIComponent(token)}`,
        'HttpOnly',
        'Path=/',
        'SameSite=Lax',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (secure) attrs.push('Secure');
    appendSetCookie(res, attrs.join('; '));
}
/** The key a connected device carries (devices.js). Long-lived: the list in Settings is how it ends. */
export function setDeviceCookie(res, token, secure) {
    const attrs = [
        `${DEVICE_COOKIE}=${encodeURIComponent(token)}`,
        'HttpOnly',
        'Path=/',
        'SameSite=Lax',
        `Max-Age=${DEVICE_COOKIE_MAX_AGE_S}`,
    ];
    if (secure) attrs.push('Secure');
    appendSetCookie(res, attrs.join('; '));
}
export function clearSessionCookie(res, secure) {
    const attrs = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
    if (secure) attrs.push('Secure');
    appendSetCookie(res, attrs.join('; '));
}

/** True when the request arrived over a secure connection (directly or via a
 *  trusted loopback proxy such as `tailscale serve`, which sets X-Forwarded-Proto).
 *  Requires `app.set('trust proxy', 'loopback')` for the forwarded header. */
export function isSecureRequest(req) {
    return !!(req.secure || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}

/** Does this request already carry valid credentials (a connected device or the
 *  computer's Tailscale account — see devices.js — a session cookie, or a bearer)? */
export function isRequestAuthenticated(req) {
    return !!req.remoteAccess || hasPasswordCredential(req);
}

/**
 * Credentials that came from the PASSWORD: a session cookie or the API key as
 * a bearer. The API key is guarded by this rather than by any way in: a
 * connected phone or a Tailscale session must not be able to turn itself into
 * a standing bearer credential that works from anywhere.
 *
 * A session token is accepted as a cookie only. As a Bearer it would be a
 * credential script code could read and send, which the HttpOnly cookie is
 * there to prevent; scripts and bots use the API key.
 */
export function hasPasswordCredential(req) {
    const authz = req.headers.authorization || '';
    if (authz.startsWith('Bearer ')) {
        const token = authz.slice(7).trim();
        const apiKey = getApiKey();
        if (apiKey && timingEqual(token, apiKey)) return true;
    }
    return !!sessionOf(req);
}

// --- login brute-force throttle (in-memory) ---
//
// Every check of the password, a pairing code or the setup code goes through
// it: login, setup, pairing, and changing or removing the password.
//
// Counted per `req.ip`, and that address can be a claim: `trust proxy:
// loopback` takes X-Forwarded-For from anything on a loopback socket, which is
// `tailscale serve` but also any program on this computer and anyone behind a
// raw TCP forward to it (`ssh -L`, socat), none of whom add the header
// honestly. Such a caller made up a new address per guess and never met the
// limit. So everything that arrived relayed also shares ONE budget: a proxy
// that does fill in the header keeps its clients apart, and a made-up address
// buys at most the shared budget. A relayed request's claimed address is kept
// in its own namespace, so claiming `127.0.0.1` through a relay does not count
// against this machine's own unrelayed requests: guessing through a relay that
// sends the header cannot lock the owner out. A raw forward that sends NO
// header arrives as this machine itself and shares its eight (SECURITY.md).
const attempts = new Map(); // key -> { count, first, lockUntil }
const MAX_ATTEMPTS = 8;
const MAX_RELAYED = 32;
const RELAYED = 'relayed'; // address keys carry a prefix, so none can be this
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

function isLoopbackSocket(req) {
    const a = String(req?.socket?.remoteAddress || '');
    return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}
const isRelayed = (req) => isLoopbackSocket(req) && !!req.headers?.['x-forwarded-for'];

/**
 * The address a record is kept for. An IPv6 address is counted by its /64:
 * one connection is usually handed a whole /64, so counting each address
 * separately gave one caller billions of fresh budgets. An IPv4 address
 * written as IPv6 (`::ffff:203.0.113.5`) is the IPv4 address it names.
 */
export function throttleAddress(ip) {
    let a = String(ip || 'unknown').trim().toLowerCase();
    const zone = a.indexOf('%');
    if (zone >= 0) a = a.slice(0, zone);
    const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return mapped[1];
    if (!net.isIPv6(a)) return a;
    // Expand `::` into zero groups; a trailing dotted quad is two groups.
    const dotted = a.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) {
        const [p, q2, r, s] = dotted[1].split('.').map(Number);
        a = a.slice(0, -dotted[1].length) + `${((p << 8) | q2).toString(16)}:${((r << 8) | s).toString(16)}`;
    }
    const [head, tail] = a.includes('::') ? a.split('::') : [a, null];
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    return `${groups.slice(0, 4).map(g => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}

/** The request's own record: `ip:` for an address seen on the socket, `via:`
 *  for one a relay claims. */
const addressKey = (req) => `${isRelayed(req) ? 'via' : 'ip'}:${throttleAddress(req?.ip)}`;
function throttleKeys(req) {
    return isRelayed(req) ? [addressKey(req), RELAYED] : [addressKey(req)];
}

// The record is capped: past MAX_RECORDS addresses the oldest are dropped
// (never the shared relayed budget). Before, a spent record was dropped only
// after its window, so addresses made up one per guess grew the map for as
// long as the window lasted. Spent records are swept at most once a minute,
// so a burst of failures does not walk the whole map on every one.
const MAX_RECORDS = 10_000;
const SWEEP_EVERY_MS = 60 * 1000;
let lastSweep = 0;
function sweepAttempts(now) {
    if (now - lastSweep >= SWEEP_EVERY_MS) {
        lastSweep = now;
        for (const [key, rec] of attempts) {
            if (now - rec.first > WINDOW_MS && rec.lockUntil <= now) attempts.delete(key);
        }
    }
    // A Map iterates in insertion order, so the first keys are the oldest records.
    for (const key of attempts.keys()) {
        if (attempts.size < MAX_RECORDS) break;
        if (key !== RELAYED) attempts.delete(key);
    }
}
export function loginBlocked(req) {
    const now = Date.now();
    let wait = 0;
    for (const key of throttleKeys(req)) {
        const rec = attempts.get(key);
        if (rec && rec.lockUntil > now) wait = Math.max(wait, Math.ceil((rec.lockUntil - now) / 1000));
    }
    return wait;
}
export function recordLoginFailure(req) {
    const now = Date.now();
    sweepAttempts(now);
    for (const key of throttleKeys(req)) {
        let rec = attempts.get(key);
        if (!rec || now - rec.first > WINDOW_MS) rec = { count: 0, first: now, lockUntil: 0 };
        rec.count += 1;
        if (rec.count >= (key === RELAYED ? MAX_RELAYED : MAX_ATTEMPTS)) rec.lockUntil = now + LOCK_MS;
        attempts.set(key, rec);
    }
}
/** Take back one attempt counted up front (passwordThroughThrottle) for a check that never ran or was right. */
function refundAttempt(key) {
    const rec = attempts.get(key);
    if (!rec) return;
    rec.count = Math.max(0, rec.count - 1);
    if (rec.count < (key === RELAYED ? MAX_RELAYED : MAX_ATTEMPTS)) rec.lockUntil = 0;
}
/** The address's own record only: one right answer does not refill the shared budget. */
export function recordLoginSuccess(req) {
    attempts.delete(addressKey(req));
}

/**
 * Check a password the way every route that asks for one does: refused while
 * the address is locked; counted BEFORE the check, because the check is now
 * asynchronous and guesses sent together would otherwise all start before the
 * first wrong one was counted; given back when it was right, or when the check
 * never ran because too many were running.
 *
 * `{ ok: true }`, `{ wrong: true }`, or `{ refused: { status, body } }` to send as is.
 */
export async function passwordThroughThrottle(req, given) {
    const wait = loginBlocked(req);
    if (wait > 0) return { refused: { status: 429, body: { error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait } } };
    recordLoginFailure(req);
    let right;
    try {
        right = await checkPassword(typeof given === 'string' ? given : '');
    } catch (e) {
        if (e?.code !== 'AUTH_BUSY') throw e;
        for (const key of throttleKeys(req)) refundAttempt(key);
        return { refused: { status: 429, body: { error: 'The server is busy checking passwords. Try again in a moment.', retryAfter: 1 } } };
    }
    if (!right) return { wrong: true };
    recordLoginSuccess(req);
    // The shared relayed budget gets back only the attempt this answer was
    // counted as up front.
    if (isRelayed(req)) refundAttempt(RELAYED);
    return { ok: true };
}
/** How many records the throttle holds (the gates check it stays bounded). */
export function loginThrottleSize() {
    return attempts.size;
}

// --- the unlocked app, reached from another machine ---
//
// With no password the gate is off, which is right on this machine and wrong
// for anyone else: an app started with HOST=0.0.0.0, or a Docker image run
// with a bare `-p 3001:3001`, served every project and note to the whole
// network, and the first stranger to POST /api/auth/setup chose the password
// and locked the owner out. So "no password" means "open to THIS machine":
// a request from anywhere else is refused until a password exists, and setting
// the first one from elsewhere takes a one-time code printed in the server's
// own log — which only whoever runs the server can read.

const isLoopbackIp = (ip) => ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.');

// Headers only a proxy or a tunnel adds. A browser on this machine talking to
// the app directly sends none of them.
const RELAY_HEADERS = ['forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
    'x-forwarded-server', 'x-real-ip'];

/** A Host header naming this machine's loopback, or none at all (HTTP/1.0). */
function isLoopbackHost(hostHeader) {
    const h = hostnameOf(hostHeader);
    return !h || h === 'localhost' || h === '[::1]' || h === '::1' || h === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * Is the owner the one asking: this computer itself, or anyone holding the
 * password? A device let in WITHOUT the password (a paired phone, the owner's
 * Tailscale account, see devices.js) is not, for the things that act on the
 * computer or decide where the app sends what it knows: the desktop's own
 * controls, updating, and the addresses in the settings (settingsSchema.js,
 * sensitivity 'network').
 */
export function ownerPresent(req) {
    return !req.remoteAccess || hasPasswordCredential(req);
}

/**
 * Did this request come from this machine? Three things must agree, and any
 * one of them failing means "somewhere else", which is the safe way to be
 * wrong with no password set:
 *
 *   - `req.ip` is loopback. Not the socket: with `trust proxy: loopback`, a
 *     request relayed by a local proxy (`tailscale serve`) carries its real
 *     client in X-Forwarded-For and is judged by THAT.
 *   - No proxy header at all (Forwarded, Via, X-Forwarded-*, X-Real-IP). A
 *     local proxy or tunnel that relays someone else's request arrives on a
 *     loopback socket too, and the ones that leave X-Forwarded-For out often
 *     still say they are a proxy in one of the others.
 *   - The Host names loopback, or is this computer's own bare name (on Debian
 *     and Ubuntu it resolves to 127.0.1.1). A browser here asks for localhost or 127.0.0.1;
 *     a request for a LAN address, a tunnel's public name or a name in
 *     ALLOWED_HOSTS was addressed to this app from elsewhere, whatever socket
 *     it arrived on (the Vite dev server opened to the LAN, for one, forwards
 *     a phone's request over loopback with the phone's Host).
 *
 * A raw TCP forward (`ssh -L`, socat) that sends `Host: localhost` and no proxy
 * header cannot be told apart from this machine; SECURITY.md says so.
 */
export function isLocalRequest(req) {
    const ip = String(req?.ip || req?.socket?.remoteAddress || '');
    if (!isLoopbackIp(ip)) return false;
    const headers = req?.headers || {};
    if (RELAY_HEADERS.some(h => headers[h] !== undefined)) return false;
    // This computer's own single-label name counts too (isOwnMachineName):
    // only this machine's hosts file answers it, and the socket is loopback.
    return isLoopbackHost(headers.host) || isOwnMachineName(hostnameOf(headers.host));
}

/** An operator who wants the old behaviour on a trusted network says so. */
function openRemoteAllowed() {
    return process.env.AUTH_ALLOW_OPEN_REMOTE === '1';
}

const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Is this app SET UP to be reached from elsewhere while no password is set?
 * Bound beyond loopback (HOST=0.0.0.0, a LAN address), opened on purpose
 * (AUTH_ALLOW_OPEN_REMOTE=1), or fronted by a name or origin the operator
 * listed (ALLOWED_HOSTS / ALLOWED_ORIGINS). The status route says so and the
 * app shows a banner until a password is set. Read on every call: the
 * environment is the operator's and the gates change it.
 *
 * Not a refusal to start: the Docker image's first run is exactly this
 * (HOST=0.0.0.0, no password), and a request from elsewhere is already refused
 * until a password exists (remoteSetupRequired), the first one set with the
 * code from the server log.
 */
export function exposedWithoutPassword() {
    if (isAuthEnabled()) return false;
    if (openRemoteAllowed()) return true;
    const host = String(process.env.HOST || '127.0.0.1').trim().toLowerCase();
    if (!LOOPBACK_BIND.has(host) && !/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
    const listed = `${process.env.ALLOWED_HOSTS || ''},${process.env.ALLOWED_ORIGINS || ''}`
        .split(',').map(s => s.trim()).filter(Boolean);
    return listed.some(entry => !isLoopbackHost(entry.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')));
}

/** No password, not this machine, not a device it knows, and nobody opted in: refuse, offer setup. */
export function remoteSetupRequired(req) {
    return !isAuthEnabled() && !isLocalRequest(req) && !openRemoteAllowed() && !req?.remoteAccess;
}

/**
 * Before every /api route, the public auth routes included: may this request
 * come in without the password (devices.js)? The answer is kept on
 * `req.remoteAccess`, so every check after it stays synchronous. This
 * machine's own requests skip it; they are already in.
 */
export function identifyRemoteAccess(req, res, next) {
    if (isLocalRequest(req)) return next();
    remoteAccessOf(req, parseCookies(req), { passwordSet: isAuthEnabled() })
        .then((how) => { req.remoteAccess = how; }, () => { req.remoteAccess = null; })
        .finally(() => next());
}

let setupCode = null;
/**
 * The one-time code for setting the first password from another machine.
 * Made on first need, kept in memory (a restart makes a new one), and printed
 * to the log each time it is made or asked for, because the log is the channel
 * only the person running the server can read (`docker compose logs`).
 */
export function announceSetupCode() {
    if (!setupCode) {
        const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
        setupCode = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
    }
    console.log(`[security] No password is set, so this app answers only its own machine. To set one from another device, open the app there and enter this setup code: ${setupCode}`);
    return setupCode;
}
export function checkSetupCode(code) {
    if (!setupCode || typeof code !== 'string') return false;
    return timingEqual(code.trim().toUpperCase(), setupCode);
}
/** The code is spent once a password exists. */
export function clearSetupCode() {
    setupCode = null;
}

/**
 * Express middleware that protects everything mounted after it. With no
 * password set it lets this machine and the devices it knows through and
 * refuses everyone else (see above). Public auth endpoints are mounted BEFORE this in createApp
 * (server/app.js) so they stay reachable while locked.
 */
export function requireAuth(req, res, next) {
    if (!isAuthEnabled()) {
        if (!remoteSetupRequired(req)) return next();
        return res.status(401).json({ error: 'Set a password to use this app from another device', authRequired: true, setupRequired: true });
    }
    if (isRequestAuthenticated(req)) {
        // A session in use stays signed in: its cookie goes back with a fresh
        // 14 days once a day (authSessions.js).
        renewSessionCookie(req, res);
        return next();
    }
    return res.status(401).json({ error: 'Authentication required', authRequired: true });
}

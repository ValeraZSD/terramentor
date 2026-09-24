// Single-user authentication gate.
//
// This app has exactly one owner, so we don't want multi-user accounts, roles or
// sign-up — just ONE lock on the front door. When a password is configured the
// server refuses to serve any `/api` data until the caller proves it knows the
// secret; once proven, a browser stays logged in via a signed session cookie and
// programmatic clients (e.g. a Telegram bot) use a bearer API key.
//
// Design constraints:
//   - Zero new dependencies: hashing, signing and cookies are all built on
//     Node's `crypto`, so we add no supply-chain surface.
//   - Backwards compatible: with NO password set the gate is OFF and the app
//     behaves exactly as before (pure-local users on localhost are unaffected).
//     Binding to 127.0.0.1 (see index.js) is the always-on first layer; the
//     password is the second layer that makes remote access (Tailscale) safe.
//   - Stateless sessions: the cookie is an HMAC-signed token, so sessions survive
//     a server restart without a session store. Rotating the signing secret
//     (done on every password change) invalidates every outstanding session.

import crypto from 'crypto';
import db from './database.js';
// The hosted search backends' keys are credentials in the same sense as the
// provider key: they belong to their own write-only routes
// (/api/search/keys/:provider) and must never ride the settings dump.
import { SECRET_SEARCH_KEYS } from './searchBackends.js';

// Settings keys owned by this module. They must NEVER be exposed by the generic
// `GET /api/settings` dump nor be writable through `PUT /api/settings/:key` —
// index.js guards both using `isAuthSettingKey`.
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
// it out of this dump.
export function isSecretSettingKey(key) {
    return isAuthSettingKey(key) || key === 'ai_openai_api_key' || SECRET_SEARCH_KEYS.includes(key);
}

const COOKIE_NAME = 'sp_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — keep the phone logged in

// scrypt parameters. memory ≈ 128 * N * r ≈ 16 MB, within Node's default maxmem.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// --- low-level settings access (auth namespace only) ---
function getRaw(key) {
    try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row && row.value != null ? row.value : null;
    } catch {
        return null;
    }
}
function setRaw(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
function delRaw(key) {
    try { db.prepare('DELETE FROM settings WHERE key = ?').run(key); } catch { /* ignore */ }
}

// --- password hashing (scrypt, salted, versioned) ---
function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return `scrypt$${SCRYPT.N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
    try {
        const [scheme, N, saltHex, hashHex] = String(stored).split('$');
        if (scheme !== 'scrypt') return false;
        const salt = Buffer.from(saltHex, 'hex');
        const expected = Buffer.from(hashHex, 'hex');
        const actual = crypto.scryptSync(password, salt, expected.length, { N: Number(N), r: SCRYPT.r, p: SCRYPT.p });
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
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

// --- stateless signed session tokens ---
export function issueToken() {
    const exp = Date.now() + SESSION_TTL_MS;
    const payload = `v1.${exp}.${crypto.randomBytes(9).toString('hex')}`;
    const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
    return `${payload}.${sig}`;
}
export function verifyToken(token) {
    if (!token || typeof token !== 'string') return false;
    const cut = token.lastIndexOf('.');
    if (cut < 0) return false;
    const payload = token.slice(0, cut);
    const sig = token.slice(cut + 1);
    const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
    if (!timingEqualHex(sig, expected)) return false;
    const exp = Number(payload.split('.')[1]);
    return Number.isFinite(exp) && Date.now() <= exp;
}

// --- API key for programmatic clients (bot, curl, scripts) ---
export function getApiKey() {
    return getRaw('auth_api_key');
}
export function regenerateApiKey() {
    const key = 'sk_' + crypto.randomBytes(24).toString('hex');
    setRaw('auth_api_key', key);
    return key;
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
export function checkPassword(password) {
    const stored = getRaw('auth_password_hash');
    return stored ? verifyPassword(password, stored) : false;
}
/** Set (or replace) the password and rotate the session secret so every existing
 *  session is invalidated — a password change logs out all other devices. */
export function setPassword(password) {
    setRaw('auth_password_hash', hashPassword(password));
    setRaw('auth_session_secret', crypto.randomBytes(32).toString('hex'));
}
export function clearAuth() {
    delRaw('auth_password_hash');
    delRaw('auth_session_secret');
    delRaw('auth_api_key');
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

/** Does this request already carry valid credentials (session cookie OR bearer)? */
export function isRequestAuthenticated(req) {
    const authz = req.headers.authorization || '';
    if (authz.startsWith('Bearer ')) {
        const token = authz.slice(7).trim();
        const apiKey = getApiKey();
        if (apiKey && timingEqual(token, apiKey)) return true;
        if (verifyToken(token)) return true;
    }
    const cookies = parseCookies(req);
    return verifyToken(cookies[COOKIE_NAME]);
}

// --- login brute-force throttle (in-memory) ---
const attempts = new Map(); // ip -> { count, first, lockUntil }
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
export function loginBlocked(ip) {
    const rec = attempts.get(ip);
    if (!rec) return 0;
    const remaining = rec.lockUntil - Date.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}
export function recordLoginFailure(ip) {
    const now = Date.now();
    let rec = attempts.get(ip);
    if (!rec || now - rec.first > WINDOW_MS) rec = { count: 0, first: now, lockUntil: 0 };
    rec.count += 1;
    if (rec.count >= MAX_ATTEMPTS) rec.lockUntil = now + LOCK_MS;
    attempts.set(ip, rec);
}
export function recordLoginSuccess(ip) {
    attempts.delete(ip);
}

/**
 * Express middleware that protects everything mounted after it. No-op when the
 * gate is disabled (no password set). Public auth endpoints are mounted BEFORE
 * this in index.js so they stay reachable while locked.
 */
export function requireAuth(req, res, next) {
    if (!isAuthEnabled()) return next();
    if (isRequestAuthenticated(req)) return next();
    return res.status(401).json({ error: 'Authentication required', authRequired: true });
}

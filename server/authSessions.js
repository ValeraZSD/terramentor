// Password sessions as records the server can end (server/auth.js signs them).
//
// A signed token alone cannot be ended before its date: the server would
// have no list to strike it from, so signing out could only clear the
// browser's cookie and a copy of it would go on working. Each sign-in is
// therefore a row here:
//
//   - Signing out deletes the row, so the cookie stops working everywhere.
//   - "Sign out everywhere" deletes every row (and rotates the signing secret).
//   - A session lasts SESSION_TTL_MS from its LAST use, renewed at most once a
//     day as it is used, so a browser in daily use stays signed in and one left
//     alone for two weeks does not. Whatever the use, it ends SESSION_MAX_AGE_MS
//     (90 days) after the sign-in, and the password is asked again.
//
// The library keeps `sid_hash`, a SHA-256 of the session's random id, never the
// id or the token: the id is 18 random bytes, so the hash cannot be turned
// back into it, and a copy of the library opens nothing (the same rule as the
// device keys in devices.js). The token also carries an HMAC under the secret
// in the credentials file, so a row alone is not a session either.
//
// Timestamps are ISO strings written from Date.now(), the shape NOW_ISO
// writes, so expiry follows the same clock the checks read.

import crypto from 'node:crypto';
import db from './database.js';

/** A session ends this long after it was last used. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * …and this long after it was made, however often it is used: renewal alone
 * would keep a copied cookie working for as long as anybody kept using it.
 */
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** A session in use is renewed at most this often (one write a day, not one a request). */
export const RENEW_EVERY_MS = 24 * 60 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

let stmts = null;
function q() {
    if (!stmts) {
        stmts = {
            insert: db.prepare('INSERT INTO auth_sessions (sid_hash, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'),
            byHash: db.prepare('SELECT id, created_at, last_seen_at, expires_at FROM auth_sessions WHERE sid_hash = ?'),
            renew: db.prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?'),
            remove: db.prepare('DELETE FROM auth_sessions WHERE id = ?'),
            removeByHash: db.prepare('DELETE FROM auth_sessions WHERE sid_hash = ?'),
            removeAll: db.prepare('DELETE FROM auth_sessions'),
            removeExpired: db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?'),
        };
    }
    return stmts;
}

/** Record a new session for this random id. Expired rows are swept on the way. */
export function createSession(sid, userAgent = '') {
    const now = Date.now();
    try { q().removeExpired.run(iso(now)); } catch { /* housekeeping */ }
    q().insert.run(sha256(sid), iso(now), iso(now), iso(now + SESSION_TTL_MS), String(userAgent || '').slice(0, 80) || null);
}

/**
 * The live session for this id, or null (unknown, ended, or expired — an
 * expired row is removed). `renewed` is true when this use moved its expiry,
 * which is when the caller re-sends the cookie with a fresh Max-Age.
 */
export function useSession(sid) {
    const row = q().byHash.get(sha256(sid));
    if (!row) return null;
    const now = Date.now();
    const expires = Date.parse(row.expires_at);
    const created = Date.parse(row.created_at);
    const lastDay = created + SESSION_MAX_AGE_MS;
    if (!Number.isFinite(expires) || expires <= now || !Number.isFinite(created) || lastDay <= now) {
        try { q().remove.run(row.id); } catch { /* refused either way */ }
        return null;
    }
    const seen = Date.parse(row.last_seen_at || row.created_at);
    if (!Number.isFinite(seen) || now - seen >= RENEW_EVERY_MS) {
        try {
            q().renew.run(iso(now), iso(Math.min(now + SESSION_TTL_MS, lastDay)), row.id);
            return { id: row.id, renewed: true };
        } catch { /* a failed renewal leaves the session as it was */ }
    }
    return { id: row.id, renewed: false };
}

/** End one session (signing out). */
export function endSession(sid) {
    return q().removeByHash.run(sha256(sid)).changes > 0;
}

/** End every session (a new password, Sign out everywhere, the password removed). */
export function endAllSessions() {
    return q().removeAll.run().changes;
}

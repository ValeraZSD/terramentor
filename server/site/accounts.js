// Accounts at the front desk: made from an operator's invite link, signed into
// with a password, held by sessions kept in site.db.
//
// - An invite link is 256 random bits, stored hashed, good for 7 days and
//   once. A new invite for the same address cancels the older ones.
// - A session is a random token in a host-only cookie; only its SHA-256 is
//   stored. Idle limit 30 days, hard limit 90. Signing out ends the row.
// - Sign-in failures are counted in the database, per address typed (known or
//   not) and per network (an IPv6 address counts by its /64). Past five wrong
//   tries for an address the waits grow, and never lock anyone out for longer
//   than fifteen minutes at a time; after 100 wrong tries in a row the
//   password is switched off for that address until a new invite. A wrong
//   password and an unknown address get the same answer after the same work.
import crypto from 'node:crypto';
import net from 'node:net';
import { nowIso } from './siteDb.js';
import {
    hashPassword, isBreached, needsRehash, passwordShapeProblem, spendLikeAPasswordCheck, verifyPassword,
} from './passwords.js';

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
export const SESSION_IDLE_MS = 30 * 24 * 3600 * 1000;
export const SESSION_MAX_MS = 90 * 24 * 3600 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

const ACCOUNT_FREE_TRIES = 5;
const NETWORK_FREE_TRIES = 20;
const LONGEST_WAIT_S = 15 * 60;
export const PASSWORD_OFF_AFTER = 100;
const NETWORK_FORGET_MS = 24 * 3600 * 1000;

export const WRONG = 'That email and password do not match.';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
export const normalEmail = (email) => String(email ?? '').trim().toLowerCase();
const looksLikeEmail = (email) => /^[^\s@]{1,64}@[^\s@]{1,253}$/.test(email);

/** The network a sign-in came from: the address, or an IPv6 address's /64. */
export function networkOf(ip) {
    let a = String(ip || '').replace(/^::ffff:(?=\d+\.)/, '');
    if (net.isIPv6(a)) {
        // Expand "::" so the first four groups are the /64.
        const [head, tail = ''] = a.split('::');
        const h = head ? head.split(':') : [];
        const t = tail ? tail.split(':') : [];
        const groups = a.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
        a = `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
    }
    return a || 'unknown';
}

/** A short name for the device, from its User-Agent. Only the name is kept. */
export function deviceLabel(ua = '') {
    const s = String(ua);
    const browser = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome'
        : /Safari\//.test(s) ? 'Safari' : 'Browser';
    const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS'
        : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
    return os ? `${browser} on ${os}` : browser;
}

export function createAccounts(db, { createLibrary, env = process.env, breachCheck = isBreached } = {}) {
    const q = {
        accountByEmail: db.prepare('SELECT * FROM accounts WHERE email = ?'),
        accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
        setHash: db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?'),
        inviteByHash: db.prepare('SELECT * FROM invites WHERE token_hash = ?'),
        cancelInvites: db.prepare('UPDATE invites SET used_at = ? WHERE email = ? AND used_at IS NULL'),
        addInvite: db.prepare('INSERT INTO invites (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)'),
        useInvite: db.prepare('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL'),
        addAccount: db.prepare(`INSERT INTO accounts (email, password_hash, library_id, created_at, password_changed_at)
                                VALUES (?, ?, ?, ?, ?)`),
        addSession: db.prepare(`INSERT INTO sessions (account_id, token_hash, device, created_at, last_seen_at, expires_at)
                                VALUES (?, ?, ?, ?, ?, ?)`),
        sessionByHash: db.prepare(`SELECT s.*, a.email, a.library_id FROM sessions s JOIN accounts a ON a.id = s.account_id
                                   WHERE s.token_hash = ?`),
        touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?'),
        endSession: db.prepare('DELETE FROM sessions WHERE id = ? AND account_id = ?'),
        endAll: db.prepare('DELETE FROM sessions WHERE account_id = ?'),
        listSessions: db.prepare(`SELECT id, device, created_at, last_seen_at FROM sessions WHERE account_id = ?
                                  ORDER BY last_seen_at DESC`),
        sweepSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?'),
        sessionAlive: db.prepare('SELECT 1 FROM sessions WHERE id = ? AND expires_at >= ? AND last_seen_at >= ?'),
        unuseInvite: db.prepare('UPDATE invites SET used_at = NULL WHERE id = ?'),
        sweepNetworks: db.prepare("DELETE FROM throttle WHERE key LIKE 'net:%' AND last_fail_at < ?"),
        throttleGet: db.prepare('SELECT * FROM throttle WHERE key = ?'),
        throttlePut: db.prepare(`INSERT INTO throttle (key, fails, last_fail_at) VALUES (?, ?, ?)
                                 ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, last_fail_at = excluded.last_fail_at`),
        throttleClear: db.prepare('DELETE FROM throttle WHERE key = ?'),
        accounts: db.prepare('SELECT id, email, library_id, created_at FROM accounts ORDER BY id'),
    };

    // --- throttle --------------------------------------------------------------
    const waitFor = (row, free, now) => {
        if (!row || row.fails < free) return 0;
        const wait = Math.min(2 ** (row.fails - free), LONGEST_WAIT_S);
        return Math.max(0, Math.ceil((row.last_fail_at + wait * 1000 - now) / 1000));
    };
    function throttleState(email, ip, now = Date.now()) {
        const acct = q.throttleGet.get(`acct:${email}`);
        let netRow = q.throttleGet.get(`net:${networkOf(ip)}`);
        if (netRow && now - netRow.last_fail_at > NETWORK_FORGET_MS) { q.throttleClear.run(netRow.key); netRow = null; }
        return {
            passwordOff: !!acct && acct.fails >= PASSWORD_OFF_AFTER,
            wait: Math.max(waitFor(acct, ACCOUNT_FREE_TRIES, now), waitFor(netRow, NETWORK_FREE_TRIES, now)),
        };
    }
    const bump = (key, now) => {
        const row = q.throttleGet.get(key);
        q.throttlePut.run(key, (row?.fails ?? 0) + 1, now);
    };
    const unbump = (key) => {
        const row = q.throttleGet.get(key);
        if (!row) return;
        if (row.fails <= 1) q.throttleClear.run(key); else q.throttlePut.run(key, row.fails - 1, row.last_fail_at);
    };

    // --- sessions --------------------------------------------------------------
    function startSession(accountId, ua, now = Date.now()) {
        const token = newToken();
        const info = q.addSession.run(accountId, sha256(token), deviceLabel(ua), nowIso(now), nowIso(now), nowIso(now + SESSION_MAX_MS));
        return { token, sessionId: Number(info.lastInsertRowid) };
    }

    /** The session and its account for a cookie's token, or null. Renews last seen. */
    function sessionOf(token, now = Date.now()) {
        if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
        const row = q.sessionByHash.get(sha256(token));
        if (!row) return null;
        const lastSeen = Date.parse(row.last_seen_at);
        if (Date.parse(row.expires_at) < now || lastSeen + SESSION_IDLE_MS < now) {
            q.endSession.run(row.id, row.account_id);
            return null;
        }
        if (now - lastSeen > TOUCH_EVERY_MS) q.touchSession.run(nowIso(now), row.id);
        return { sessionId: row.id, accountId: row.account_id, email: row.email, libraryId: row.library_id };
    }

    // --- invites ---------------------------------------------------------------
    function createInvite(rawEmail, now = Date.now()) {
        const email = normalEmail(rawEmail);
        if (!looksLikeEmail(email)) throw new Error(`"${rawEmail}" is not an email address`);
        if (q.accountByEmail.get(email)) throw new Error(`${email} already has an account`);
        const token = newToken();
        db.transaction(() => {
            q.cancelInvites.run(nowIso(now), email);
            q.addInvite.run(sha256(token), email, nowIso(now), nowIso(now + INVITE_TTL_MS));
        })();
        return { token, email };
    }

    function inviteOf(token, now = Date.now()) {
        if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
        const row = q.inviteByHash.get(sha256(token));
        if (!row || row.used_at || Date.parse(row.expires_at) < now) return null;
        return { id: row.id, email: row.email };
    }

    /**
     * Turn an invite into an account with its own library, and sign it in.
     * `{ error }` when the password is not acceptable or the link is spent.
     */
    async function acceptInvite(token, password, ua) {
        const invite = inviteOf(token);
        if (!invite) return { error: 'This invite link has expired or was already used. Ask for a new one.', spent: true };
        const shape = passwordShapeProblem(password);
        if (shape) return { error: shape };
        if (await breachCheck(password, { env }) === true) {
            return { error: 'This password has appeared in a known data breach, so it is among the first ones guessed. Choose another.' };
        }
        const hash = await hashPassword(password);
        // Spend the link first: a second tab submitting the same link at once
        // must not make two libraries.
        if (q.useInvite.run(nowIso(), invite.id).changes !== 1) {
            return { error: 'This invite link has expired or was already used. Ask for a new one.', spent: true };
        }
        let libraryId;
        try {
            libraryId = await createLibrary();
        } catch (e) {
            // No library, no account: the link stays good for another try.
            q.unuseInvite.run(invite.id);
            throw e;
        }
        const accountId = Number(q.addAccount.run(invite.email, hash, libraryId, nowIso(), nowIso()).lastInsertRowid);
        q.throttleClear.run(`acct:${invite.email}`);
        return { accountId, libraryId, ...startSession(accountId, ua) };
    }

    // --- sign in -----------------------------------------------------------------
    /**
     * `{ ok, token, sessionId, accountId, libraryId }`, `{ wrong }`, `{ wait }`,
     * `{ passwordOff }` or `{ busy }`. Every path that checks a password spends
     * one argon2 run, so an unknown address takes as long as a known one.
     */
    async function signIn(rawEmail, password, { ip, ua, now = Date.now() } = {}) {
        const email = normalEmail(rawEmail);
        const state = throttleState(email, ip, now);
        if (state.passwordOff) return { passwordOff: true };
        if (state.wait > 0) return { wait: state.wait };
        const acctKey = `acct:${email}`;
        const netKey = `net:${networkOf(ip)}`;
        // Counted before the check, so parallel guesses cannot all slip in
        // under one count.
        bump(acctKey, now);
        bump(netKey, now);
        const account = q.accountByEmail.get(email);
        let right = false;
        try {
            if (account) right = await verifyPassword(String(password ?? ''), account.password_hash);
            else await spendLikeAPasswordCheck(String(password ?? ''));
        } catch (e) {
            if (e?.code !== 'AUTH_BUSY') throw e;
            unbump(acctKey); unbump(netKey);
            return { busy: true };
        }
        if (!right) return { wrong: true };
        q.throttleClear.run(acctKey);
        unbump(netKey);
        if (needsRehash(account.password_hash)) q.setHash.run(await hashPassword(password), account.id);
        return { ok: true, accountId: account.id, libraryId: account.library_id, ...startSession(account.id, ua, now) };
    }

    return {
        createInvite, inviteOf, acceptInvite, signIn, sessionOf, throttleState,
        listSessions: (accountId) => q.listSessions.all(accountId),
        endSession: (sessionId, accountId) => q.endSession.run(sessionId, accountId).changes === 1,
        endAllSessions: (accountId) => q.endAll.run(accountId).changes,
        /** Drop ended sessions, and networks whose last wrong guess is over a day old. */
        sweepSessions: (now = Date.now()) => {
            q.sweepNetworks.run(now - NETWORK_FORGET_MS); // last_fail_at is epoch ms
            return q.sweepSessions.run(nowIso(now), nowIso(now - SESSION_IDLE_MS)).changes;
        },
        /** Is this session still signed in? False once it was ended, swept or ran out. */
        sessionAlive: (sessionId, now = Date.now()) => !!q.sessionAlive.get(sessionId, nowIso(now), nowIso(now - SESSION_IDLE_MS)),
        accountById: (id) => q.accountById.get(id),
        listAccounts: () => q.accounts.all(),
        /** Forget an account's wrong guesses (the operator's `unlock`); false when there is no such account. */
        unlock: (rawEmail) => {
            const email = normalEmail(rawEmail);
            if (!q.accountByEmail.get(email)) return false;
            q.throttleClear.run(`acct:${email}`);
            return true;
        },
    };
}

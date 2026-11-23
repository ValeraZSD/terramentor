// A library run by a site's front desk (server/site/frontDesk.js): one
// person's copy of the app, started on demand, reached only through a socket
// inside its own folder.
//
// The front desk has already checked who is asking. It forwards each request
// with a short signed note naming the account, the session and this library,
// and the library takes that note in place of its own password gate. A request
// without a valid note is refused: nothing reaches this process except through
// the socket, and the socket sits in a folder only this library's system user
// (and the front desk) may open, so the note is a second lock, not the only one.
//
// Everything else about a hosted copy holds too (server/hosted.js): the front
// desk starts each library with TERRAMENTOR_HOSTED=1 as well.
import crypto from 'node:crypto';
import { k } from './clientError.js';

/** Is this process a library started by a site's front desk? */
export function isSiteLibrary(env = process.env) {
    return env.TERRAMENTOR_SITE_LIBRARY === '1';
}

/** The socket (a named pipe on Windows) this library listens on, or ''. */
export function siteSocketPath(env = process.env) {
    return isSiteLibrary(env) ? String(env.SITE_SOCKET || '') : '';
}

/** The request header the note travels in. Lower case: Node reads it so. */
export const NOTE_HEADER = 'x-terramentor-note';

/** How long a note stays good. One request's worth, with room for a slow clock. */
export const NOTE_TTL_MS = 30_000;

const sign = (key, payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

/**
 * A note saying which account and session a request is for. `key` is the
 * library's own (one per library, kept by the front desk), so a note made for
 * one library is worthless at another.
 */
export function makeNote({ key, libraryId, accountId, sessionId, now = Date.now(), ttlMs = NOTE_TTL_MS }) {
    const payload = ['v1', libraryId, String(accountId), String(sessionId), String(now + ttlMs)].join('.');
    return `${payload}.${sign(key, payload)}`;
}

/** `{ accountId, sessionId }` when the note is good for this library now, else null. */
export function readNote(note, { key, libraryId, now = Date.now() }) {
    if (typeof note !== 'string' || !key || !libraryId) return null;
    const parts = note.split('.');
    if (parts.length !== 6 || parts[0] !== 'v1') return null;
    const [, lib, accountId, sessionId, exp, sig] = parts;
    const want = Buffer.from(sign(key, parts.slice(0, 5).join('.')));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    if (lib !== libraryId) return null;
    const expires = Number(exp);
    if (!Number.isFinite(expires) || expires < now || expires > now + NOTE_TTL_MS * 2) return null;
    if (!/^\d+$/.test(accountId) || !/^\d+$/.test(sessionId)) return null;
    return { accountId: Number(accountId), sessionId: Number(sessionId) };
}

// Read once and taken out of the environment, so nothing this process starts
// or prints later carries it.
let noteKey = null;
let libraryId = null;
if (isSiteLibrary()) {
    noteKey = process.env.SITE_NOTE_KEY ? Buffer.from(process.env.SITE_NOTE_KEY, 'hex') : null;
    libraryId = process.env.SITE_LIBRARY_ID || null;
    delete process.env.SITE_NOTE_KEY;
}

/** Why this site library must not start, or null. */
export function siteLibraryStartProblem(env = process.env) {
    if (!isSiteLibrary(env)) return null;
    if (!siteSocketPath(env)) return 'TERRAMENTOR_SITE_LIBRARY=1 needs SITE_SOCKET: a site library listens on its socket only.';
    if (!noteKey || noteKey.length < 32) return 'TERRAMENTOR_SITE_LIBRARY=1 needs SITE_NOTE_KEY (32 bytes, hex).';
    if (!libraryId) return 'TERRAMENTOR_SITE_LIBRARY=1 needs SITE_LIBRARY_ID.';
    if (env.TERRAMENTOR_HOSTED !== '1') return 'a site library is also a hosted copy: TERRAMENTOR_HOSTED=1.';
    return null;
}

/**
 * Express middleware, first on every request: read the note and keep who it
 * names on `req.sitePerson` (null when there is none or it is not good). The
 * header is removed either way, so nothing after this sees it.
 */
export function siteNoteReader(req, res, next) {
    if (!isSiteLibrary()) return next();
    const note = req.headers[NOTE_HEADER];
    delete req.headers[NOTE_HEADER];
    req.sitePerson = readNote(note, { key: noteKey, libraryId });
    next();
}

/**
 * Signing in, out, and changing the password all happen at the front desk.
 * Here those routes would act on a password this library does not use, so
 * they are refused; the status probe still answers.
 */
export function siteAuthRefusal(method, path) {
    if (!isSiteLibrary()) return null;
    if (!/^\/api\/auth(?:\/|$)/.test(path)) return null;
    if (path === '/api/auth/status') return null;
    return k('Signing in and out of this library happens at the site, not in the app.');
}

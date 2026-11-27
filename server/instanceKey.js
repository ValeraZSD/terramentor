// server/instanceKey.js — how the desktop launcher and updater tell THIS
// library's server from anything else listening on a loopback port.
//
// The launcher asks ports 3001–3010 whether a Terramentor on its library is
// already running (desktop/lib.js `findRunningInstance`), and the updater asks
// the same question to decide whether a freshly installed version came up
// (desktop/updater.js `waitHealthy`). The public status answer alone cannot
// settle that: it is served before any session exists, so everything in it —
// the app name, the library id, which is a hash of a path anyone on the
// machine can compute — is something any local program can repeat. On a
// computer shared by several accounts, a port is first come, first served, and
// the answer "yes, that's your library" has to be one only the owner of the
// library can give.
//
// So each library has a KEY: 32 random bytes in a file beside the database,
// readable only by the account that owns the folder (mode 0600 where the
// platform has modes; on Windows the per-user data folder's access list does
// the same job). The asker sends a fresh random nonce with its status request,
// and the server answers with an HMAC of that nonce under the key. Nobody who
// cannot read the file can produce it, and nobody can replay one: the nonce is
// new every time.
//
// The proof also names the PORT the request arrived on, as the server's own
// socket reports it. Without that, a program squatting an earlier port could
// relay the asker's nonce to the real server on a later port and pass its
// answer back, and the launcher would open its window on the relay.
//
// Node built-ins only, on purpose: the updater imports this file from a copy
// under `.update/runner/` that has no node_modules beside it (launcher.js
// `startUpdater` copies it there).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** The key's file name inside the data directory. */
export const INSTANCE_KEY_FILE = 'instance.key';

/** What `link` answers on a file system that has no hard links. */
const NO_HARD_LINKS = ['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'EMLINK', 'EXDEV'];

const KEY_TEXT = /^[0-9a-f]{64}$/;

/** A key file's text as the key, or null when it is not one. */
function parseKey(text) {
    const t = String(text ?? '').trim();
    return KEY_TEXT.test(t) ? Buffer.from(t, 'hex') : null;
}

/**
 * Read the key from an exact file path, never creating one. What the updater
 * uses: it runs after the server has made the key, and a program whose job is
 * to check something has no business making up the thing it checks against.
 */
export function readInstanceKeyFile(path, { readFile = readFileSync } = {}) {
    try { return parseKey(readFile(path, 'utf8')); } catch { return null; }
}

/**
 * The key of the library in `dir`, made on first use.
 *
 * Published with `link`, which refuses a name that is taken, so two launchers
 * starting at the same moment cannot each write a different key and leave one
 * of them proving against the wrong one: the second `link` fails with EEXIST
 * and that process reads what the first published. A file that exists but holds
 * no key (a write cut off by a power loss) is replaced. Returns null when the
 * folder cannot be written at all; the callers then trust nothing, which
 * costs a second server, never a wrong one.
 */
export function loadInstanceKey(dir, { platform = process.platform } = {}) {
    if (!dir) return null;
    const path = join(dir, INSTANCE_KEY_FILE);
    const existing = readInstanceKeyFile(path);
    if (existing) {
        // An older copy, or a hand-made file, may have left it readable by
        // others. Narrowing it is a courtesy; a failure leaves the key usable.
        if (platform !== 'win32') { try { chmodSync(path, 0o600); } catch { /* not ours to change */ } }
        return existing;
    }
    // The folder itself may not exist yet. On a first launch the launcher asks
    // for the key BEFORE the server has started, and the server is what makes
    // the data folder (server/paths.js `dataPaths`), so without this the
    // launcher held no key on every new library and could not check the
    // server it had just started. Making it here is what the server would do a
    // moment later anyway; a folder that cannot be made falls through to the
    // open below, which then fails and returns null as before.
    try { mkdirSync(dir, { recursive: true }); } catch { /* the open below reports it */ }
    const fresh = randomBytes(32);
    // The key is written to a file of its own first and only then given its
    // real name, so the real name is never visible empty. Creating it with `wx`
    // and writing after left a gap in which a second process saw a file with no
    // key, took it for a leftover and wrote its own over it: each process then
    // proved itself with a different key.
    const tmp = join(dir, `${INSTANCE_KEY_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
        const fd = openSync(tmp, 'wx', 0o600);
        try { writeSync(fd, `${fresh.toString('hex')}\n`); } finally { closeSync(fd); }
        let mine = fresh;
        try {
            // Fails with EEXIST when another process published first.
            linkSync(tmp, path);
        } catch (e) {
            // EEXIST: taken. The others: a file system without hard links
            // (exFAT, some network shares), where the file can only be moved in.
            if (e?.code !== 'EEXIST' && !NO_HARD_LINKS.includes(e?.code)) return null;
            const theirs = readInstanceKeyFile(path);
            if (theirs) return theirs;
            // Nothing there holds a key (a write cut off by an old crash, or no
            // file at all): put ours in whole, then answer with what the file says.
            // `rename` replaces whatever is there, so on these two paths only (a
            // leftover empty file, a disk without hard links) two processes
            // starting at the very same moment can still end with different
            // keys. That fails safe: the later proof fails and a second server
            // is started, never a wrong one trusted.
            renameSync(tmp, path);
            mine = readInstanceKeyFile(path);
        }
        if (mine && platform !== 'win32') { try { chmodSync(path, 0o600); } catch { /* created 0600 already */ } }
        return mine;
    } catch {
        return null;
    } finally {
        try { unlinkSync(tmp); } catch { /* already moved into place, or never made */ }
    }
}

/** A fresh challenge. 128 bits, so no two are ever the same. */
export function newNonce() {
    return randomBytes(16).toString('hex');
}

/** Whether a request's nonce is one the server will answer: short, plain text,
 *  long enough that it cannot have been guessed in advance. */
export function validNonce(nonce) {
    return typeof nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(nonce);
}

/** The answer to a challenge: HMAC-SHA256 under the key, over a fixed label,
 *  the nonce and the port the request arrived on. */
export function instanceProof(key, nonce, port) {
    return createHmac('sha256', key).update(`terramentor-instance\n${nonce}\n${Number(port)}`).digest('hex');
}

/**
 * Whether a status answer proves it came from the server holding `key`, asked
 * with `nonce` on `port`. False whenever anything is missing: no key here, no
 * proof there, a proof of the wrong length.
 */
export function provesInstance(status, { key, nonce, port }) {
    if (!key || !validNonce(nonce) || !status || typeof status.proof !== 'string') return false;
    return sameText(status.proof, instanceProof(key, nonce, port));
}

function sameText(a, b) {
    const got = Buffer.from(String(a), 'utf8');
    const want = Buffer.from(String(b), 'utf8');
    return got.length === want.length && timingSafeEqual(got, want);
}

// --- the other direction: a caller proving it is the library's owner --------
//
// The challenge above lets the launcher check the SERVER. The proofs below let
// the server check a CALLER: on a computer shared by several accounts, every
// account reaches 127.0.0.1, so arriving over loopback says "this computer",
// not "the person whose library this is". Only the account that owns the
// library can read the key, so only it can make these.
//
// An owner proof is `v1.<seconds>.<nonce>.<hmac>`: the time it was made, a
// fresh nonce, and an HMAC of both and the port it is meant for. The server
// takes one at most once and only within OWNER_PROOF_TTL_S of its time
// (server/auth.js keeps the spent nonces). The desktop window carries one to
// GET /api/auth/launch and gets a cookie for it; a program on the computer
// (the MCP server) sends a fresh one with every request.

/** How long an owner proof may wait before it is used. The app window is the
 *  slow user: a cold browser start on a busy computer can take most of a minute. */
export const OWNER_PROOF_TTL_S = 5 * 60;
/** The header a program sends its owner proof in. */
export const OWNER_PROOF_HEADER = 'x-terramentor-proof';
/** How long a window's cookie lasts without being renewed (auth.js renews one a day old). */
export const OWNER_COOKIE_TTL_S = 30 * 24 * 60 * 60;

/** An owner proof and a window cookie alike: version, seconds, nonce, HMAC. */
const TOKEN_TEXT = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{16,128})\.([0-9a-f]{64})$/;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A one-time proof that the caller holds `key`, for the server on `port`. */
export function ownerProof(key, port, { now = nowSeconds(), nonce = newNonce() } = {}) {
    const mac = createHmac('sha256', key).update(`terramentor-owner\n${now}\n${nonce}\n${Number(port)}`).digest('hex');
    return `v1.${now}.${nonce}.${mac}`;
}

/**
 * Read an owner proof for the server on `port`: `{ nonce, expires }` (seconds)
 * when it is well made, made with `key`, for this port and within its time;
 * else null. Whether its nonce was already spent is the caller's to check.
 */
export function readOwnerProof(key, proof, port, { now = nowSeconds() } = {}) {
    if (!key || typeof proof !== 'string') return null;
    const m = TOKEN_TEXT.exec(proof);
    if (!m) return null;
    const made = Number(m[1]);
    // A little slack for a clock read a moment apart in two processes.
    if (made > now + 30 || now - made > OWNER_PROOF_TTL_S) return null;
    const want = ownerProof(key, port, { now: made, nonce: m[2] });
    return sameText(proof, want) ? { nonce: m[2], expires: made + OWNER_PROOF_TTL_S } : null;
}

/** The value of the cookie a proven window carries: when it was issued and an HMAC under the key. */
export function ownerCookie(key, { now = nowSeconds(), nonce = newNonce() } = {}) {
    const mac = createHmac('sha256', key).update(`terramentor-owner-cookie\n${now}\n${nonce}`).digest('hex');
    return `v1.${now}.${nonce}.${mac}`;
}

/** Its age in seconds when the cookie is good, else null. Stateless, so a
 *  window stays signed in while the server restarts under it (an update). */
export function ownerCookieAge(key, value, { now = nowSeconds() } = {}) {
    if (!key || typeof value !== 'string') return null;
    const m = TOKEN_TEXT.exec(value);
    if (!m) return null;
    const made = Number(m[1]);
    if (made > now + 30 || now - made > OWNER_COOKIE_TTL_S) return null;
    return sameText(value, ownerCookie(key, { now: made, nonce: m[2] })) ? Math.max(0, now - made) : null;
}

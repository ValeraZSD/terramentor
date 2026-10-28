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
import { chmodSync, closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** The key's file name inside the data directory. */
export const INSTANCE_KEY_FILE = 'instance.key';

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
 * Created with `wx`, so two launchers starting at the same moment cannot each
 * write a different key and leave one of them proving against the wrong one:
 * the second `open` fails with EEXIST and that process reads what the first
 * wrote. A file that exists but holds no key (a write cut off by a power loss)
 * is replaced. Returns null when the folder cannot be written at all; the
 * callers then trust nothing, which costs a second server, never a wrong one.
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
    const fresh = randomBytes(32);
    for (const flag of ['wx', 'w']) {
        try {
            const fd = openSync(path, flag, 0o600);
            try { writeSync(fd, `${fresh.toString('hex')}\n`); } finally { closeSync(fd); }
            if (platform !== 'win32') { try { chmodSync(path, 0o600); } catch { /* created 0600 already */ } }
            return fresh;
        } catch (e) {
            if (e?.code !== 'EEXIST') return null;
            // Another process made it between our read and our open.
            const theirs = readInstanceKeyFile(path);
            if (theirs) return theirs;
            // It exists and holds no key: overwrite it on the second pass.
        }
    }
    return null;
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
    const want = Buffer.from(instanceProof(key, nonce, port), 'utf8');
    const got = Buffer.from(status.proof, 'utf8');
    return got.length === want.length && timingSafeEqual(got, want);
}

// Account passwords at the front desk: argon2id (Node's own `crypto.argon2`,
// Node 24.7 and later), a length rule and a check against known-breached
// passwords.
//
// The parameters are OWASP's first argon2id row: 19 MiB, two passes, one lane.
// The hash is stored in the PHC string form every argon2 library reads, so the
// parameters travel with it and can be raised later without a migration: a
// hash made with weaker ones is re-made at the next sign-in (`needsRehash`).
import crypto from 'node:crypto';
import { safeFetch } from '../netSafety.js';
import { failureFacts } from '../failureFacts.js';

export const ARGON2 = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };
/** NIST SP 800-63B-4: 15 when a password is the only factor. No composition rules. */
export const MIN_LENGTH = 15;
export const MAX_LENGTH = 128;

// Each check holds 19 MiB for ~50 ms on the thread pool. Two at once, sixteen
// waiting, and past that a sign-in is told the server is busy: a burst of
// guesses must not be a way to exhaust memory or starve file reads.
const AT_ONCE = 2;
const WAITING = 16;
const slots = { running: 0, waiting: [] };

async function limited(fn) {
    if (slots.running >= AT_ONCE) {
        if (slots.waiting.length >= WAITING) throw Object.assign(new Error('Too many password checks at once'), { code: 'AUTH_BUSY' });
        await new Promise((resolve) => slots.waiting.push(resolve));
    } else {
        slots.running += 1;
    }
    try {
        return await fn();
    } finally {
        const next = slots.waiting.shift();
        if (next) next(); else slots.running -= 1;
    }
}

// Runs started, so a check can count the work each path does instead of timing it.
let runs = 0;
export const argonRuns = () => runs;

function argon2id(password, salt, p = ARGON2) {
    runs += 1;
    return limited(() => new Promise((resolve, reject) => {
        crypto.argon2('argon2id', {
            message: Buffer.from(password, 'utf8'), nonce: salt,
            memory: p.memory, passes: p.passes, parallelism: p.parallelism, tagLength: p.tagLength,
        }, (err, key) => (err ? reject(err) : resolve(key)));
    }));
}

const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');
const unb64 = (s) => Buffer.from(s, 'base64');

/** A PHC string: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>. */
export async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await argon2id(password, salt);
    return `$argon2id$v=19$m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}$${b64(salt)}$${b64(key)}`;
}

function parse(stored) {
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(String(stored || ''));
    if (!m) return null;
    const hash = unb64(m[5]);
    return { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]), salt: unb64(m[4]), hash, tagLength: hash.length };
}

/** Is this the password? Rejects with code AUTH_BUSY when too many checks run. */
export async function verifyPassword(password, stored) {
    const p = parse(stored);
    if (!p) return false;
    const key = await argon2id(String(password ?? ''), p.salt, p);
    return key.length === p.hash.length && crypto.timingSafeEqual(key, p.hash);
}

/** Was this hash made with weaker parameters than today's? */
export function needsRehash(stored) {
    const p = parse(stored);
    return !p || p.memory < ARGON2.memory || p.passes < ARGON2.passes || p.tagLength < ARGON2.tagLength;
}

// Checked against when no account has the address, so an unknown address costs
// the same time as a known one with a wrong password.
let dummyHash = null;
export async function spendLikeAPasswordCheck(password) {
    dummyHash ??= await hashPassword(crypto.randomBytes(24).toString('hex'));
    await verifyPassword(password, dummyHash);
}

/** Why this password is not acceptable as a new one, or null. Length only. */
export function passwordShapeProblem(password) {
    if (typeof password !== 'string') return 'Enter a password.';
    const length = [...password].length;
    if (length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters. A few ordinary words in a row is enough.`;
    if (length > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters.`;
    return null;
}

/**
 * Has this password appeared in a known breach? Uses the Pwned Passwords range
 * API: only the first five characters of the password's SHA-1 leave the
 * server, with padding on, and the match is made here. `SITE_BREACH_CHECK=0`
 * turns it off (a server with no way out, or an operator who will not send
 * even that). An unreachable service lets the password through and says so in
 * the log: a sign-up must not depend on a third party being up.
 *
 * Resolves true, false, or null when it could not tell.
 */
export async function isBreached(password, { env = process.env, fetchImpl = safeFetch } = {}) {
    if (env.SITE_BREACH_CHECK === '0') return null;
    const sha1 = crypto.createHash('sha1').update(String(password), 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const rest = sha1.slice(5);
    try {
        const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
            headers: { 'Add-Padding': 'true', 'User-Agent': 'terramentor-site' },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw Object.assign(new Error(`status ${res.status}`), { httpStatus: res.status });
        const body = await res.text();
        for (const line of body.split('\n')) {
            const [suffix, count] = line.trim().split(':');
            if (suffix === rest && Number(count) > 0) return true;
        }
        return false;
    } catch (e) {
        // Its kind, not its message: a refused fetch names the address, and the
        // address holds the start of the password's hash.
        console.warn(`[site] The breached-password check could not be reached (${failureFacts(e)}); the password was let through.`);
        return null;
    }
}

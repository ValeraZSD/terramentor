// What a failed request tells the caller about why it failed.
//
// A route that caught an error used to answer with the error's own message.
// That text is written for whoever reads the server's log, not for whoever made the
// request: a file system error names a path under the account's home folder, a
// SQLite error names tables and columns, a TypeError names the code that broke,
// and a provider's failure carries up to 300 characters of whatever the
// provider answered. Anything that can call the API read all of it — a phone
// connected by its QR code included — and the desktop app also ran without
// NODE_ENV=production, so the global handler added the same text as `detail`.
//
// Two answers, by who the message was written for:
//
//   - A refusal the code wrote for the learner ("A capture needs some text, a
//     URL, or a title") is sent as written. Those are the 4xx answers, and any
//     error a module marks `expose: true`. A file path inside one is still
//     replaced, because a message that quotes the file it could not read was
//     written by somebody thinking of the learner and not of the path.
//   - Everything else — any error behind a 5xx, and a system, SQLite or
//     programming error at any status — is one fixed sentence with a short
//     reference. The whole error goes to the server log under that reference,
//     so the person who can read the log can still find it from a screenshot.
//
// `publicMessage` is the first answer on its own, for the places that report a
// failure inside a successful response (a creation run's error line, a list of
// documents that could not be read): their text is shown on purpose, so it
// keeps its words and loses only what was never meant for the screen.

import crypto from 'node:crypto';

const GENERIC = 'Something went wrong on the server.';

/** Errors whose message is about this server's insides, whatever status they ride on. */
function isInternal(err) {
    if (!err || typeof err !== 'object') return false;
    const code = String(err.code || '');
    // Node's system errors (ENOENT, EACCES, ECONNREFUSED…) carry a syscall or
    // an errno beside a code of that shape; their message names the path.
    if (/^E[A-Z0-9_]+$/.test(code) && (err.syscall || typeof err.errno === 'number')) return true;
    if (code.startsWith('SQLITE_') || err.name === 'SqliteError') return true;
    // An error somebody marked `expose` was written for the caller, whatever
    // its class: the body parser's refusals (bad JSON, too large) are
    // SyntaxErrors and http-errors marked so, and a module may throw a
    // RangeError with words meant for the screen.
    if (err.expose === true) return false;
    // A built-in error type thrown by the runtime is a bug, and its message
    // reads the code back (`Cannot read properties of undefined (reading 'id')`).
    // By name as well: an error rebuilt from a child process's reply keeps
    // the name and not the class.
    return err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError || err instanceof SyntaxError
        || ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError'].includes(err.name);
}

// An absolute path: a drive letter or a UNC share on Windows, or a POSIX path
// of at least two segments (so "and/or" and a lone "/" are left alone).
const WINDOWS_PATH = /(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]*/g;
const POSIX_PATH = /(^|[\s'"`(=:])\/(?:[^\s'"`<>/]+\/)+[^\s'"`<>]*/g;

function redactPaths(text) {
    return String(text).replace(WINDOWS_PATH, '<path>').replace(POSIX_PATH, (_m, lead) => `${lead}<path>`);
}

/** Log the whole error under a fresh reference and return the sentence that names it. */
function referenced(err) {
    const ref = crypto.randomBytes(4).toString('hex');
    console.error(`[error ref ${ref}]`, err);
    return `${GENERIC} The server log has the details (ref ${ref}).`;
}

/**
 * An error whose message was written for the learner ("No model selected —
 * choose one in Settings"), so it keeps its words on a 5xx too. Thrown where
 * the code knows what the person should do next.
 */
export function learnerError(message) {
    return Object.assign(new Error(message), { expose: true });
}

// What a learner needs from a model endpoint's refusal is its status and what
// to change; the endpoint's address and the body it answered with stay in the
// log (and in the task dock's failure record, which is built for bug reports).
const AI_STATUS_HINT = {
    401: 'Check the API key in Settings → AI & Models.',
    403: 'Check the API key in Settings → AI & Models.',
    404: 'Check the model name in Settings → AI & Models.',
    429: 'It is limiting requests; try again in a moment.',
};

/** A model endpoint's refusal (tagged by ai.js), said without its address or body. */
function aiSentence(err) {
    if (err.emptyReply === true) return redactPaths(err.message);
    const status = Number(err.httpStatus);
    if (!Number.isInteger(status)) return null;
    const ref = referenced(err).match(/ref ([0-9a-f]+)/)[1];
    const hint = AI_STATUS_HINT[status] || (status >= 500 ? 'The endpoint itself failed; try again, or pick another model.' : '');
    return `The AI model's endpoint answered ${status}.${hint ? ` ${hint}` : ''} (ref ${ref})`;
}

const REACH_STATUS_HINT = { 401: 'check the key', 403: 'check the key', 429: 'it is limiting requests; try again in a moment' };

/**
 * Why an address the owner typed in (a model endpoint, a search backend) did
 * not answer, in a few words they can act on: the timeout, the network code
 * (ECONNREFUSED, ENOTFOUND), or the HTTP status. Built from those fields only,
 * never from the message, which can carry a local path or the reply's body.
 */
export function reachReason(err) {
    if (!err || typeof err !== 'object') return 'could not be reached';
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timed out';
    const status = Number(err.httpStatus ?? err.status);
    if (Number.isInteger(status) && status >= 400 && status < 600) {
        const hint = REACH_STATUS_HINT[status];
        return `answered HTTP ${status}${hint ? ` (${hint})` : ''}`;
    }
    // fetch() wraps the socket's failure: TypeError('fetch failed') with the
    // system error as its cause.
    const code = String(err.code || err.cause?.code || '');
    if (/^E[A-Z0-9_]+$/.test(code)) return `could not connect (${code})`;
    if (/^UND_ERR_[A-Z_]+$/.test(code)) return code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' ? 'timed out' : `could not connect (${code})`;
    return 'could not be reached';
}

/**
 * The answer when a call to the owner's own endpoint failed: a refusal this
 * server wrote (a 4xx it threw, or an error marked `expose`) keeps its words,
 * anything from the network is "<who> <reachReason>" ("SearXNG timed out",
 * "OpenRouter answered HTTP 429 (…)").
 */
export function endpointError(who, err) {
    const status = Number(err?.status);
    if (err?.expose === true || (status >= 400 && status < 500 && err?.httpStatus == null)) return publicMessage(err);
    return `${who} ${reachReason(err)}`;
}

/** The message as the learner may read it: internal errors become the fixed sentence, paths are removed. */
export function publicMessage(err) {
    // The parser's own text quotes a position in the body; what the caller
    // needs is the kind of mistake.
    if (err?.type === 'entity.parse.failed') return 'Invalid JSON in the request body';
    if (isInternal(err)) return referenced(err);
    if (err && typeof err === 'object' && err.expose !== true) {
        const ai = aiSentence(err);
        if (ai) return ai;
    }
    const message = err && typeof err === 'object' ? err.message : err;
    if (!message) return referenced(err);
    return redactPaths(message);
}

/**
 * The `error` text for a response with this status. 4xx answers and errors
 * marked `expose` keep their (path-free) words; any other 5xx is the fixed
 * sentence with a reference into the server log.
 */
export function clientError(err, status = 500) {
    if (Number(status) < 500 || err?.expose === true) return publicMessage(err);
    if (err && typeof err === 'object') {
        const ai = aiSentence(err);
        if (ai) return ai;
    }
    return referenced(err);
}

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
//   - A refusal the code wrote for the learner ("A card needs a front and a
//     back.") is sent as written. Those are the 4xx answers, and any
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
//
// Every answer is also said in the learner's interface language. The app
// cannot translate the English `error` itself ("Node 12 not found" is no key),
// so a body carries the English template it was filled from (`messageKey`,
// the key in src/locales/en.json, with `{{name}}` slots) and the values
// (`params`), and the app renders t(messageKey, params). `error` stays the
// filled English for every other reader: the MCP agent, scripts, the log.
//
//   - `keyed(key, params)` is the body for a refusal a route writes.
//   - `KeyedError` / `statusError` / `learnerError` are refusals a module
//     throws; `errorBody(err, status)` sends their key.
//   - `apiError(text)` is the one exception: a request only a program can get
//     wrong (a field named by its code name, a code another program compares).
//     A learner never sees it, so it stays English.
//   - `k(sentence)` marks a key kept in a table, so tools/lib/i18nKeys.mjs
//     collects it into en.json like the app's own k().

import crypto from 'node:crypto';

/** Marks an English sentence as a translation key. Identity; the server twin of the app's `k()`. */
export const k = (key) => key;

const SLOT = /\{\{\s*(\w+)\s*\}\}/g;

/** The key with its `{{name}}` slots filled from `params`, as i18next fills them: the English text. */
export function fillKey(key, params) {
    if (!params) return key;
    return String(key).replace(SLOT, (slot, name) => (params[name] == null ? slot : String(params[name])));
}

/** The body for a refusal written here: the English sentence, and the key and values the app translates it from. */
export function keyed(key, params) {
    return params ? { error: fillKey(key, params), messageKey: key, params } : { error: key, messageKey: key };
}

/** The fields of a refusal a module returned (`{ ok: false, ...keyed(…) }`), to send on with its key. */
export function errorFields(refusal) {
    const { error, messageKey, params } = refusal || {};
    return { error, ...(messageKey ? { messageKey } : {}), ...(params ? { params } : {}) };
}

/** The body for a request only a program can get wrong. English on purpose: no learner reads it. */
export function apiError(text) {
    return { error: text };
}

/** An error whose message is a key: `errorBody` sends it as `messageKey`, with `params`. */
export class KeyedError extends Error {
    constructor(key, params) {
        super(fillKey(key, params));
        this.messageKey = key;
        if (params) this.params = params;
    }
}

/** A refusal thrown with its HTTP status: `throw statusError(404, 'No such connection')`. */
export function statusError(status, key, params) {
    return Object.assign(new KeyedError(key, params), { status });
}

const GENERIC = k('Something went wrong on the server. The server log has the details (ref {{ref}}).');

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

/** Log the whole error under a fresh reference and return the body that names it. */
function referenced(err) {
    const ref = crypto.randomBytes(4).toString('hex');
    console.error(`[error ref ${ref}]`, err);
    return keyed(GENERIC, { ref });
}

/** The error's own words with paths removed, keyed when it was thrown with a key. */
export function ownWords(err) {
    const message = err && typeof err === 'object' ? err.message : err;
    if (!message) return referenced(err);
    // A key built from a template literal is filled text, not a key; if it
    // quotes a path, it is sent as English with the path replaced, and no key.
    if (typeof err?.messageKey === 'string' && err.messageKey && redactPaths(err.messageKey) === err.messageKey) {
        const params = err.params && typeof err.params === 'object'
            ? Object.fromEntries(Object.entries(err.params).map(([name, v]) => [name, typeof v === 'string' ? redactPaths(v) : v]))
            : undefined;
        return keyed(err.messageKey, params);
    }
    return { error: redactPaths(message) };
}

/**
 * An error whose message was written for the learner ("No model selected —
 * choose one in Settings"), so it keeps its words on a 5xx too. Thrown where
 * the code knows what the person should do next.
 */
export function learnerError(key, params) {
    return Object.assign(new KeyedError(key, params), { expose: true });
}

// What a learner needs from a model endpoint's refusal is its status and what
// to change; the endpoint's address and the body it answered with stay in the
// log (and in the task dock's failure record, which is built for bug reports).
const AI_ANSWERED = {
    401: k("The AI model's endpoint answered {{status}}. Check the API key in Settings → AI & Models. (ref {{ref}})"),
    403: k("The AI model's endpoint answered {{status}}. Check the API key in Settings → AI & Models. (ref {{ref}})"),
    404: k("The AI model's endpoint answered {{status}}. Check the model name in Settings → AI & Models. (ref {{ref}})"),
    429: k("The AI model's endpoint answered {{status}}. It is limiting requests; try again in a moment. (ref {{ref}})"),
};
const AI_FAILED = k("The AI model's endpoint answered {{status}}. The endpoint itself failed; try again, or pick another model. (ref {{ref}})");
const AI_OTHER = k("The AI model's endpoint answered {{status}}. (ref {{ref}})");

/** A model endpoint's refusal (tagged by ai.js), said without its address or body. */
function aiSentence(err) {
    if (err.emptyReply === true) return ownWords(err);
    const status = Number(err.httpStatus);
    if (!Number.isInteger(status)) return null;
    const { ref } = referenced(err).params;
    return keyed(AI_ANSWERED[status] || (status >= 500 ? AI_FAILED : AI_OTHER), { status, ref });
}

/**
 * Why an address did not answer, from the timeout, the network code
 * (ECONNREFUSED, ENOTFOUND) or the HTTP status only — never from the message,
 * which can carry a local path or the reply's body.
 */
function reachOf(err) {
    if (!err || typeof err !== 'object') return { kind: 'unreached' };
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return { kind: 'timeout' };
    const status = Number(err.httpStatus ?? err.status);
    if (Number.isInteger(status) && status >= 400 && status < 600) {
        return { kind: status === 401 || status === 403 ? 'key' : status === 429 ? 'busy' : 'status', status };
    }
    // fetch() wraps the socket's failure: TypeError('fetch failed') with the
    // system error as its cause.
    const code = String(err.code || err.cause?.code || '');
    if (/^E[A-Z0-9_]+$/.test(code)) return { kind: 'connect', code };
    if (/^UND_ERR_[A-Z_]+$/.test(code)) return code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' ? { kind: 'timeout' } : { kind: 'connect', code };
    return { kind: 'unreached' };
}

const REACH_REASON = {
    timeout: 'timed out',
    key: 'answered HTTP {{status}} (check the key)',
    busy: 'answered HTTP {{status}} (it is limiting requests; try again in a moment)',
    status: 'answered HTTP {{status}}',
    connect: 'could not connect ({{code}})',
    unreached: 'could not be reached',
};

/**
 * Why an address the owner typed in (a model endpoint, a search backend) did
 * not answer, in a few English words for a sentence the caller builds (the
 * assistant's check reasons, which a model reads).
 */
export function reachReason(err) {
    const reach = reachOf(err);
    return fillKey(REACH_REASON[reach.kind], reach);
}

// One sentence per reason, whole, so each language words it its own way: a
// service by its own name ("SearXNG timed out"), or the endpoint the owner
// typed in, which has no name to give.
const REACH_NAMED = {
    timeout: k('{{who}} timed out'),
    key: k('{{who}} answered HTTP {{status}} (check the key)'),
    busy: k('{{who}} answered HTTP {{status}} (it is limiting requests; try again in a moment)'),
    status: k('{{who}} answered HTTP {{status}}'),
    connect: k('{{who}} could not connect ({{code}})'),
    unreached: k('{{who}} could not be reached'),
};
const REACH_ENDPOINT = {
    timeout: k('The endpoint timed out'),
    key: k('The endpoint answered HTTP {{status}} (check the key)'),
    busy: k('The endpoint answered HTTP {{status}} (it is limiting requests; try again in a moment)'),
    status: k('The endpoint answered HTTP {{status}}'),
    connect: k('The endpoint could not connect ({{code}})'),
    unreached: k('The endpoint could not be reached'),
};

/**
 * The body when a call to the owner's own endpoint failed: a refusal this
 * server wrote (a 4xx it threw, or an error marked `expose`) keeps its words,
 * anything from the network is "<who> <reason>" ("SearXNG timed out",
 * "OpenRouter answered HTTP 429 (…)"). `who` is a service's own name, or
 * null for the endpoint the owner typed in ("The endpoint timed out").
 */
export function endpointBody(who, err) {
    const status = Number(err?.status);
    if (err?.expose === true || (status >= 400 && status < 500 && err?.httpStatus == null)) return publicBody(err);
    const { kind, ...params } = reachOf(err);
    return who ? keyed(REACH_NAMED[kind], { who, ...params }) : keyed(REACH_ENDPOINT[kind], Object.keys(params).length ? params : undefined);
}

/** `endpointBody`'s English text. */
export function endpointError(who, err) {
    return endpointBody(who, err).error;
}

/** The body for a failure reported on purpose: internal errors become the fixed sentence, paths are removed. */
export function publicBody(err) {
    // The parser's own text quotes a position in the body; what the caller
    // needs is the kind of mistake.
    if (err?.type === 'entity.parse.failed') return apiError('Invalid JSON in the request body');
    if (isInternal(err)) return referenced(err);
    if (err && typeof err === 'object' && err.expose !== true) {
        const ai = aiSentence(err);
        if (ai) return ai;
    }
    return ownWords(err);
}

/** `publicBody`'s English text, for a line inside a successful response. */
export function publicMessage(err) {
    return publicBody(err).error;
}

/**
 * The body for a response with this status. 4xx answers and errors marked
 * `expose` keep their (path-free) words; any other 5xx is the fixed sentence
 * with a reference into the server log. Keyed whenever the words are.
 */
export function errorBody(err, status = 500) {
    if (Number(status) < 500 || err?.expose === true) return publicBody(err);
    if (err && typeof err === 'object') {
        const ai = aiSentence(err);
        if (ai) return ai;
    }
    return referenced(err);
}

/** `errorBody`'s English text, for a place that keeps only the words (a task's record). */
export function clientError(err, status = 500) {
    return errorBody(err, status).error;
}

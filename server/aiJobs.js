/* Which model does each kind of AI work, and what answers when it fails.
 *
 * SIX JOBS, NAMED BY WHAT THE LEARNER SEES. Planning a course and writing its
 * lessons are one job: both are making the course, and a list per half would
 * be one more choice for almost nobody. An operation (`structure`,
 * `verify`, ...) says how hard to think and how long to wait; a JOB says which
 * model. They stay separate so routing a job never changes the wire a call
 * sends: the effort and the timeout still follow the operation.
 *
 * A JOB'S LIST is its own models, tried in order: the next one only when the
 * one before it failed in a way another model could fix (`fallsOver`). A job
 * with no list uses the main model (the connection in use, `getAISettings()`)
 * and then the `backups` list. A job with a list uses ONLY that list: a
 * learner who sent their questions to the model on this computer has said
 * where that text may go, and the backups must not carry it elsewhere. For
 * the same reason a list whose connections were all removed stops the job
 * with a message instead of handing it to the main model.
 *
 * NOTHING CHANGES UNTIL A CHOICE IS MADE. With no rows the chain is exactly
 * `[getAISettings()]`, the same object every call read before this file
 * existed, so a library that never opened the per-job screen sends the same
 * bytes to the same place.
 *
 * A batch tool's env override (AI_PROVIDER / AI_BASE_URL / AI_MODEL) wins over
 * every list: a sweep pointed at a local engine must never reach the learner's
 * cloud keys through a job's route.
 */
import db from './database.js';
import { getAISettings, REASONING_EFFORTS } from './ai.js';
import { settingsForConnection } from './aiConnections.js';

/** Every job, in the order the settings screen lists them. */
export const AI_JOBS = ['conversation', 'courses', 'questions', 'checks', 'vision', 'small'];

/** Not a job: the list behind the main model, for every job without its own. */
export const BACKUPS = 'backups';

/** A list is a first choice and at most four backups. */
export const MAX_ROUTE = 5;

/** The job an operation belongs to when its caller names none. */
const JOB_OF_OPERATION = {
    chat: 'conversation',
    explain: 'conversation',
    structure: 'courses',
    project_identity: 'courses',
    search_words: 'courses',
    authoring: 'courses',
    insights: 'courses',
    questions: 'questions',
    capture: 'questions',
    verify: 'checks',
    assistant_check: 'checks',
    vision: 'vision',
    summary: 'small',
};

/** The job a call runs as: the one it names, else its operation's, else `small`. */
export function jobOf({ job, operation } = {}) {
    if (AI_JOBS.includes(job)) return job;
    return JOB_OF_OPERATION[operation] || 'small';
}

const envOverride = () => !!(process.env.AI_PROVIDER || process.env.AI_BASE_URL
    || process.env.AI_OLLAMA_URL || process.env.AI_MODEL);

const bad = (message) => Object.assign(new Error(message), { status: 400 });

// Read on every model call: prepared once.
let stmts = null;
const q = () => stmts ||= {
    all: db.prepare('SELECT job, connection_id, model, effort FROM ai_job_routes ORDER BY job, position'),
    conn: db.prepare('SELECT model FROM ai_connections WHERE id = ?'),
    clearJob: db.prepare('DELETE FROM ai_job_routes WHERE job = ?'),
    put: db.prepare('INSERT INTO ai_job_routes (job, position, connection_id, model, effort) VALUES (?, ?, ?, ?, ?)'),
    clearAll: db.prepare('DELETE FROM ai_job_routes'),
};

/** Every job's list (and the backups), `{ connectionId, model, effort }` in
 *  order. A place whose connection was removed has `connectionId: null`. */
export function getJobRoutes() {
    const out = Object.fromEntries([...AI_JOBS, BACKUPS].map(j => [j, []]));
    for (const r of q().all.all()) out[r.job]?.push({ connectionId: r.connection_id, model: r.model, effort: r.effort });
    return out;
}

/** Replace one job's list. An empty list gives the job back to the main model. */
export function setJobRoute(job, route) {
    if (![...AI_JOBS, BACKUPS].includes(job)) throw bad('Unknown job');
    if (!Array.isArray(route)) throw bad('A route is a list');
    if (route.length > MAX_ROUTE) throw bad(`A job takes at most ${MAX_ROUTE} models`);
    const seen = new Set();
    const entries = route.map((e) => {
        const connectionId = e?.connectionId;
        const conn = Number.isInteger(connectionId) ? q().conn.get(connectionId) : undefined;
        if (!conn) throw bad('No such connection');
        if (e.model !== undefined && typeof e.model !== 'string') throw bad('A model is a name');
        const model = (e.model ?? '').trim();
        // The name reaches the activity log's one-line detail and a request
        // body: no line breaks or other control characters, and no essays.
        if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) throw bad('Not a model name');
        const effort = typeof e.effort === 'string' ? e.effort : '';
        if (effort && !REASONING_EFFORTS.includes(effort)) throw bad('Unknown reasoning level');
        // The same model twice would only try a failed endpoint again.
        // '' runs the connection's saved model, so it and that name typed out are one model.
        const key = `${connectionId}\u0000${model || conn.model}`;
        if (seen.has(key)) throw bad('That model is already in the list');
        seen.add(key);
        return { connectionId, model, effort };
    });
    db.transaction(() => {
        q().clearJob.run(job);
        entries.forEach((e, i) => q().put.run(job, i, e.connectionId, e.model, e.effort));
    })();
}

/** Every job back on the main model, and no backups. */
export function clearJobRoutes() {
    q().clearAll.run();
}

/** One list entry as the settings object a model call reads, or null when its
 *  connection is gone. An entry's own reasoning level replaces the stored one;
 *  '' is automatic (by operation, `effortFor`). */
function entrySettings(entry) {
    if (entry.connectionId == null) return null;
    const s = settingsForConnection(entry.connectionId, { model: entry.model || undefined });
    if (!s) return null;
    return { ...s, reasoningEffort: entry.effort || '' };
}

/**
 * The settings objects a call tries, in order. `model` is the caller's own
 * override for this one call (an atlas naming model, a vision model), which
 * applies to the main model the way it always has; a job's own list wins
 * over it, since that is the newer and more specific choice.
 *
 * Throws when the job has a list and every connection on it was removed:
 * the learner kept that work off the main model, and only they can say
 * where it goes now.
 */
export function chainFor(job, { model = null } = {}) {
    const main = getAISettings();
    const first = model ? { ...main, model } : main;
    if (envOverride()) return [first];
    const routes = getJobRoutes();
    const listed = routes[job] || [];
    const own = listed.map(entrySettings).filter(Boolean);
    if (own.length) return own;
    if (listed.length) {
        throw Object.assign(
            new Error('The connection chosen for this job was removed. Choose another under Settings → AI & Models → Models per job.'),
            { jobRouteGone: true, job },
        );
    }
    return [first, ...routes[BACKUPS].map(entrySettings).filter(Boolean)];
}

/** The settings a job's first choice runs on: what a check made BEFORE the
 *  call (can it see pictures, does it take native tools) must ask about. */
export function firstChoice(job, { model = null } = {}) {
    try {
        return chainFor(job, { model })[0];
    } catch (err) {
        // A list of removed connections: the call itself refuses with the
        // message; a capability check before it has nothing better to ask.
        if (err?.jobRouteGone) return getAISettings();
        throw err;
    }
}

// Could not reach the endpoint, or it hung up. Not undici's header and body
// timeouts: a timeout is the call's own answer and never falls over.
const TRANSPORT = /^(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_CLOSED)$/;

/**
 * Whether the next model in the list may take this call over. Yes for what
 * another model could fix: a status the endpoint answered with (busy after the
 * retries, down, out of credit, a refused key, an unknown model), an endpoint
 * that could not be reached, a non-streamed empty reply. Never for a cancel or
 * a timeout (the caller's own deadline, already spent), a reasoning loop, or
 * an error nobody recognises — those are answers about the call, and sending
 * it again elsewhere would spend twice for the same result.
 */
export function fallsOver(err, signal) {
    if (!err || typeof err !== 'object') return false;
    if (signal?.aborted) return false;
    if (err.name === 'AbortError' || err.name === 'TimeoutError' || err.looped) return false;
    if (err.emptyReply) return true;
    const status = Number(err.httpStatus ?? err.status_code);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return true;
    const code = [err.code, err.cause?.code].find(c => typeof c === 'string');
    if (code && TRANSPORT.test(code)) return true;
    return err instanceof TypeError && /fetch failed/i.test(err.message || '');
}
